import { createHash, createPrivateKey, randomUUID, sign } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, unknown>()); // user (global) values

// The bridge reads answer markers under the home folder: point it at an empty one.
vi.mock("os", async (orig) => {
  const real = await orig<typeof import("os")>();
  return { ...real, homedir: () => "/tmp/csm-forward-test-home" };
});

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => (settings.has(key) ? { globalValue: settings.get(key) } : undefined),
    }),
  },
  window: { showWarningMessage: () => Promise.resolve(undefined) },
}));

import { HEALTH_VERSION, healthFile, type WindowHealth } from "../src/health";
import { LIVE_MS } from "../src/overseerBeat";
import { defaultCapabilities, type SessionView } from "../src/providers/types";
import { COMMAND_MAX_AGE_MS, COMMAND_TIMEOUT_MS, REMOTE_COMMAND_TYPES } from "../src/remote";
import { RemoteBridge, type CommandOutcome, type FleetCommand } from "../src/remoteBridge";
import { NOT_CONFIRMED, type DeviceCheck } from "../src/remoteDevices";
import { ALREADY_RUN, TAB_BOUND_TYPES, TIMED_OUT, nodeForwardFs, parseRequest, type ForwardDeps } from "../src/remoteForward";
import { SeenIds, nodeSeenFs } from "../src/seenIds";

const WIN_A = "aaaaaaaaaaaaaaaa";
const WIN_B = "bbbbbbbbbbbbbbbb";
const WIN_C = "cccccccccccccccc";
const SID = "11111111-2222-3333-4444-555555555555";
const S2 = "66666666-7777-8888-9999-000000000000";
const HOLDER_PID = 424242; // the pid in a window's health file; it "ends" once a test adds it to Machine.ended
const WAIT = { timeout: 3000 };

const dirs: string[] = [];
const bridges: RemoteBridge[] = [];
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  settings.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** What the windows of one Mac share: a temp folder with the health files, the inboxes and the seen-id store, and the nonces taken. */
interface Machine {
  dir: string;
  ended: Set<number>; // pids whose process ended
  nonces: { claim(id: string): boolean }; // the signed commands' nonces (remoteSigned.ts), in memory here
}

function machine(): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-forward-"));
  dirs.push(dir);
  const taken = new Set<string>();
  return { dir, ended: new Set(), nonces: { claim: (id) => !taken.has(id) && !!taken.add(id) } };
}

/** Window `win`'s health file, written now (live) unless `over` says otherwise. */
function beat(m: Machine, win: string, holds: string[] | undefined, over: Partial<WindowHealth> = {}): void {
  const health: WindowHealth = {
    v: HEALTH_VERSION,
    win,
    pid: HOLDER_PID,
    version: "0.0.0-test",
    ts: Date.now() / 1000,
    features: {},
    refreshP95Ms: null,
    refreshSamples: 0,
    guardArmed: false,
    ...(holds ? { holds } : {}),
    ...over,
  };
  fs.mkdirSync(path.join(m.dir, "health"), { recursive: true });
  fs.writeFileSync(healthFile(path.join(m.dir, "health"), win), JSON.stringify(health));
}

interface Win {
  bridge: RemoteBridge;
  ran: FleetCommand[]; // what its executor ran
  logs: string[];
  held: Set<string>; // the sessions it holds
  changed: number; // holdsChanged calls
}

type Exec = (cmd: FleetCommand, signal: AbortSignal) => Promise<CommandOutcome>;

// The phone's key in these tests (the RFC 8032 test 1 key) and the arguments its signature covers (remoteSigned.ts).
const KEY = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const phoneKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex")]),
  format: "der",
  type: "pkcs8",
});
const ARG_NAMES = ["sessionId", "text", "account", "cwd", "enabled", "toolUseId", "answers"];

/** `cmd` as the relay serves it: from device phone-1 unless it names one, signed by the phone for host "mac" now, with a fresh nonce. */
function signedByPhone(cmd: FleetCommand): FleetCommand {
  const deviceId = cmd.deviceId ?? "phone-1";
  const args = Object.fromEntries(Object.entries(cmd).filter(([name]) => ARG_NAMES.includes(name)));
  const text = JSON.stringify({ v: 1, nonce: randomUUID(), deviceId, host: "mac", type: cmd.type, args, ts: Date.now() });
  return { ...cmd, deviceId, signed: text, sig: sign(null, Buffer.from(text, "utf8"), phoneKey).toString("base64") };
}

/** Every paired device confirmed on this Mac with the phone's key pinned (remoteDevices.ts): the tests that are not about the device check. */
const everyDevice: DeviceCheck = { migrate: async () => undefined, refusal: async () => null, pinnedKey: () => KEY, askToPin: () => undefined };

/** A window's bridge on the machine; its executor answers "ran in <win>" unless the test passes one. */
function windowOn(m: Machine, win: string, exec?: Exec, over: Partial<ForwardDeps> = {}, devices: DeviceCheck = everyDevice): Win {
  const w = { ran: [], logs: [], held: new Set(), changed: 0 } as unknown as Win;
  const forward: ForwardDeps = {
    win,
    dir: path.join(m.dir, "inbox"),
    healthDir: path.join(m.dir, "health"),
    shared: () => true,
    holds: (v) => w.held.has(v.sessionId),
    seen: new SeenIds({ dir: path.join(m.dir, "seen"), now: () => Date.now(), fs: nodeSeenFs }),
    fs: nodeForwardFs,
    now: () => Date.now(),
    alive: (pid) => !m.ended.has(pid),
    log: (msg) => void w.logs.push(msg),
    pollMs: 20,
    ...over,
  };
  const ctx = {
    extension: { packageJSON: { version: "0.0.0-test" } },
    secrets: { get: async () => JSON.stringify({ origin: "https://relay.test", token: "test-token" }) },
  };
  w.bridge = new RemoteBridge(ctx as never, {
    log: (msg) => void w.logs.push(msg),
    accounts: () => ({ accounts: [], bestId: null }),
    execute: async (cmd, signal) => {
      w.ran.push(cmd);
      return exec ? exec(cmd, signal) : { ok: true, message: `ran in ${win}` };
    },
    forward,
    holdsChanged: () => void w.changed++,
    devices,
    nonces: m.nonces,
  });
  bridges.push(w.bridge);
  return w;
}

/** Commands on, every type allowed (user settings). */
function commandsOn(): void {
  settings.set("remote.url", "https://relay.test");
  settings.set("remote.host", "mac");
  settings.set("remote.acceptCommands", true);
  settings.set("remote.allowedCommands", [...REMOTE_COMMAND_TYPES]);
}

function response(body: unknown) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? String(text.length) : null) }, text: async () => text };
}

/**
 * A relay every window polls: poll n (from any window) gets batches[n], each command signed by the phone, once `gate`
 * opens; later polls hang until their bridge stops.
 */
function relay(batches: FleetCommand[][], gate: Promise<void> = Promise.resolve()) {
  const results: Array<{ id: string; body: CommandOutcome }> = [];
  let polls = 0;
  const fetchMock = vi.fn(async (url: string, init: { method: string; body?: string; signal: AbortSignal }) => {
    if (init.method === "GET") {
      const batch = batches[polls++];
      if (!batch) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      await gate;
      return response({ success: true, data: { commands: batch.map(signedByPhone) } });
    }
    const hit = /\/fleet\/commands\/([^/]+)\/result$/.exec(url);
    if (hit) results.push({ id: decodeURIComponent(hit[1]), body: JSON.parse(init.body ?? "{}") });
    return response({ success: true, data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { results };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const command = (id: string, type: string, over: Partial<FleetCommand> = {}): FleetCommand => ({ id, type, sessionId: SID, createdAt: Date.now(), ...over });

const row = (sessionId: string): SessionView => ({
  key: `claude:${sessionId}`,
  provider: "claude",
  sessionId,
  title: "fix the bug",
  bucket: "working",
  sub: "working",
  detail: "",
  tooltip: "",
  capabilities: defaultCapabilities("claude", { kill: true }),
  lastActivityMs: Date.now(),
  stale: false,
  matchLabels: [],
});

/** Every file left in the inboxes, as <window>/<name>. */
function inboxFiles(m: Machine): string[] {
  const root = path.join(m.dir, "inbox");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((win) => fs.readdirSync(path.join(root, win)).map((name) => `${win}/${name}`));
}

const FAKE_CLOCK = { toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] } as const;

/** A command's file name in the inboxes: its id's sha256, cut to 32 characters. */
const fileKey = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 32);

/** Records `id` in the machine's seen-id store, as the window that got the command from the relay does before it hands it over. */
const record = (m: Machine, id: string): boolean => new SeenIds({ dir: path.join(m.dir, "seen"), now: () => Date.now(), fs: nodeSeenFs }).claim(id);

/** Puts `cmd` into `win`'s inbox as window A hands it over, with `deadline` (30 s from now unless given); returns the file. */
function handIn(m: Machine, win: string, cmd: FleetCommand, deadline = Date.now() + 30_000): string {
  const inbox = path.join(m.dir, "inbox", win);
  fs.mkdirSync(inbox, { recursive: true });
  const file = path.join(inbox, `${fileKey(cmd.id)}.cmd.json`);
  fs.writeFileSync(file, JSON.stringify({ v: 1, from: WIN_A, deadline, cmd }));
  return file;
}

/** The result `win`'s inbox holds for command `id`, or undefined. */
function resultFor(m: Machine, win: string, id: string): unknown {
  const file = path.join(m.dir, "inbox", win, `${fileKey(id)}.result.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
}

describe("a tab-bound remote command runs in the window that holds the session", () => {
  it("is handed to the live window holding the session, which runs it; the window that got it reports that result", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "send", { text: "run the tests", deviceId: "phone-1" } as Partial<FleetCommand>)]]);
    const a = windowOn(m, WIN_A);
    const b = windowOn(m, WIN_B, async () => ({ ok: true, message: "delivered via typed" }));
    b.held.add(SID);
    beat(m, WIN_A, []);
    beat(m, WIN_B, [SID]);
    await a.bridge.restart(); // takes the relay's first poll
    await b.bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(1), WAIT);

    expect(r.results[0]).toEqual({ id: "c1", body: { ok: true, message: "delivered via typed" } });
    expect(a.ran).toEqual([]);
    // As handed over: built from the signed type and arguments, with the relay's id, device and time.
    expect(b.ran).toEqual([{ id: "c1", type: "send", sessionId: SID, text: "run the tests", createdAt: expect.any(Number), deviceId: "phone-1" }]);
    expect(a.logs.join("\n")).toContain(`send c1 handed to window ${WIN_B}, which holds the session`);
    expect(b.logs.join("\n")).toContain(`send c1 from window ${WIN_A} -> ok: delivered via typed`);
    expect(inboxFiles(m)).toEqual([]); // the command and its result were removed once read
  });

  it("runs where it landed when this window holds the session itself, and every other type runs where it lands", async () => {
    commandsOn();
    const m = machine();
    const gate = deferred();
    const r = relay([[command("k1", "kill"), command("ra", "resumeAll", { sessionId: null }), command("an", "answer")]], gate.promise);
    const a = windowOn(m, WIN_A);
    a.held.add(SID);
    beat(m, WIN_B, [SID]); // listed by another window too
    await a.bridge.restart();
    a.bridge.onRows([row(SID)]); // the row cycle before the command arrives
    gate.resolve();
    await vi.waitFor(() => expect(r.results).toHaveLength(3), WAIT);

    expect(a.ran.map((c) => c.id)).toEqual(["k1", "ra", "an"]);
    expect(r.results.map((x) => x.body)).toEqual(Array(3).fill({ ok: true, message: `ran in ${WIN_A}` }));
    expect(inboxFiles(m)).toEqual([]);
  });

  it("runs where it landed when no other live window holds the session: a heartbeat past its 90 s or a holder whose process ended does not count", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "send", { text: "hi" }), command("c2", "kill")]]);
    const a = windowOn(m, WIN_A);
    beat(m, WIN_B, [SID], { ts: (Date.now() - LIVE_MS - 1_000) / 1000 });
    beat(m, WIN_C, [SID], { pid: 777 });
    m.ended.add(777);
    await a.bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(2), WAIT);

    expect(a.ran.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(r.results.map((x) => x.body.message)).toEqual([`ran in ${WIN_A}`, `ran in ${WIN_A}`]);
    expect(inboxFiles(m)).toEqual([]);
  });

  it("takes a handed-over command back and runs it here when the holder's process ends before it took the command", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "resume")]]);
    const a = windowOn(m, WIN_A);
    beat(m, WIN_B, [SID]); // live, but its bridge never reads its inbox: the window is closing
    await a.bridge.restart();
    const inbox = path.join(m.dir, "inbox", WIN_B);
    await vi.waitFor(() => expect(fs.existsSync(inbox) ? fs.readdirSync(inbox) : []).toHaveLength(1), WAIT);

    const [name] = fs.readdirSync(inbox);
    expect(name).toMatch(/^[0-9a-f]{32}\.cmd\.json$/);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(m.dir, "inbox")).mode & 0o777).toBe(0o700);
      expect(fs.statSync(inbox).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(inbox, name)).mode & 0o777).toBe(0o600);
    }
    expect(parseRequest(fs.readFileSync(path.join(inbox, name), "utf8"))).toMatchObject({ from: WIN_A, cmd: { id: "c1", type: "resume", sessionId: SID } });
    // The command built from the signed type and arguments, without the signature: the holder does not check it again.
    expect(parseRequest(fs.readFileSync(path.join(inbox, name), "utf8"))?.cmd).toEqual({ id: "c1", type: "resume", sessionId: SID, deviceId: "phone-1", createdAt: expect.any(Number) });
    expect(r.results).toEqual([]);

    m.ended.add(HOLDER_PID);
    await vi.waitFor(() => expect(r.results).toHaveLength(1), WAIT);
    expect(r.results[0].body).toEqual({ ok: true, message: `ran in ${WIN_A}` });
    expect(a.ran.map((c) => c.id)).toEqual(["c1"]);
    expect(a.logs.join("\n")).toContain(`window ${WIN_B} closed before it took c1; it runs here`);
    expect(inboxFiles(m)).toEqual([]);
  });

  it("takes a command back and runs it here when the live holder has not taken it within 3 s", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "kill")]]);
    const a = windowOn(m, WIN_A, undefined, { pollMs: 100 });
    beat(m, WIN_B, [SID]); // its process runs, but nothing reads its inbox: its bridge stopped, or its extension host is busy
    await a.bridge.restart();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(inboxFiles(m)).toEqual([`${WIN_B}/${fileKey("c1")}.cmd.json`]);
    expect(r.results).toEqual([]);

    await vi.advanceTimersByTimeAsync(200);
    expect(r.results).toEqual([{ id: "c1", body: { ok: true, message: `ran in ${WIN_A}` } }]);
    expect(a.ran.map((c) => c.id)).toEqual(["c1"]);
    expect(a.logs.join("\n")).toContain(`window ${WIN_B} did not take c1 within 3 s; it runs here`);
    expect(inboxFiles(m)).toEqual([]);
  });

  it("reports the holder's result when it comes within 2 s after the deadline", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "send", { text: "a long text" })]]);
    const a = windowOn(m, WIN_A, undefined, { pollMs: 100 });
    beat(m, WIN_B, [SID]); // the holder: this test takes the command and answers in its place
    await a.bridge.restart();
    await vi.advanceTimersByTimeAsync(500);
    const request = path.join(m.dir, "inbox", WIN_B, `${fileKey("c1")}.cmd.json`);
    fs.renameSync(request, `${request}.taken`); // taken within 3 s: it is not taken back
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 1_000 - 500); // 1 s past the deadline
    expect(r.results).toEqual([]);

    fs.mkdirSync(path.join(m.dir, "inbox", WIN_A), { recursive: true });
    fs.writeFileSync(path.join(m.dir, "inbox", WIN_A, `${fileKey("c1")}.result.json`), JSON.stringify({ v: 1, id: "c1", ok: true, message: "delivered via typed" }));
    await vi.advanceTimersByTimeAsync(200);
    expect(r.results).toEqual([{ id: "c1", body: { ok: true, message: "delivered via typed" } }]);
    expect(a.ran).toEqual([]);
  });

  it("removes the inbox of a window that is gone once nothing was written there for 2 minutes, temp files included", async () => {
    commandsOn();
    const m = machine();
    relay([]);
    const a = windowOn(m, WIN_A);
    const inbox = (win: string): string => path.join(m.dir, "inbox", win);
    const old = new Date(Date.now() - COMMAND_MAX_AGE_MS - 5_000);
    const leave = (win: string, names: string[], at?: Date): void => {
      fs.mkdirSync(inbox(win), { recursive: true });
      for (const name of names) {
        fs.writeFileSync(path.join(inbox(win), name), "x");
        if (at) fs.utimesSync(path.join(inbox(win), name), at, at);
      }
      if (at) fs.utimesSync(inbox(win), at, at);
    };
    leave("empty-4242", [".x.result.json.1.a.tmp", "y.result.json"], old); // an untitled window that closed: no health file
    leave(WIN_C, [`.${fileKey("z")}.cmd.json.1.b.tmp`], old); // its health file is past its 90 s
    beat(m, WIN_C, [], { ts: (Date.now() - LIVE_MS - 1_000) / 1000 });
    leave(WIN_B, ["b.result.json"], old); // a live window: it looks after its own inbox
    beat(m, WIN_B, []);
    leave("empty-777", ["fresh.result.json"]); // gone, but written to just now
    await a.bridge.restart();
    await vi.waitFor(() => expect(fs.existsSync(inbox("empty-4242"))).toBe(false), WAIT);

    expect(fs.existsSync(inbox(WIN_C))).toBe(false);
    expect(fs.readdirSync(inbox(WIN_B))).toEqual(["b.result.json"]);
    expect(fs.readdirSync(inbox("empty-777"))).toEqual(["fresh.result.json"]);
  });

  it("removes inbox files older than 2 minutes unread and runs nothing whose time was up", async () => {
    commandsOn();
    const m = machine();
    relay([]);
    const b = windowOn(m, WIN_B);
    const inbox = path.join(m.dir, "inbox", WIN_B);
    fs.mkdirSync(inbox, { recursive: true });
    const request = (id: string, deadline: number): string =>
      JSON.stringify({ v: 1, from: WIN_A, deadline, cmd: { id, type: "kill", sessionId: SID, createdAt: Date.now() } });
    const old = new Date(Date.now() - COMMAND_MAX_AGE_MS - 5_000);
    const stale: Array<[string, string]> = [
      ["old.cmd.json", request("old", Date.now() + 60_000)],
      ["old.result.json", JSON.stringify({ v: 1, id: "x", ok: true, message: "late" })],
      [".old.cmd.json.123.abc.tmp", "partial"],
    ];
    for (const [name, text] of stale) {
      fs.writeFileSync(path.join(inbox, name), text);
      fs.utimesSync(path.join(inbox, name), old, old);
    }
    fs.writeFileSync(path.join(inbox, "late.cmd.json"), request("late", Date.now() - 1)); // fresh, but its time is up
    fs.writeFileSync(path.join(inbox, "junk.cmd.json"), "not json");
    await b.bridge.restart();
    await vi.waitFor(() => expect(fs.readdirSync(inbox)).toEqual([]), WAIT);

    expect(b.ran).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, "inbox", WIN_A))).toBe(false); // no result for any of them
    expect(b.logs.join("\n")).toContain(`kill late from window ${WIN_A} not run: its time was up`);
    expect(b.logs.join("\n")).toContain("unreadable inbox file junk.cmd.json removed");
  });

  it("records each command id: a window that gets an id another window runs answers 'already run' and runs nothing", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "kill")], [command("c1", "kill")]]);
    const release = deferred();
    const a = windowOn(m, WIN_A, async () => {
      await release.promise;
      return { ok: true, message: "done in A" };
    });
    const b = windowOn(m, WIN_B);
    await a.bridge.restart(); // takes the first poll and stays busy with c1
    await vi.waitFor(() => expect(a.ran).toHaveLength(1), WAIT);
    await b.bridge.restart(); // takes the second poll: the same id
    await vi.waitFor(() => expect(r.results).toEqual([{ id: "c1", body: { ok: false, message: ALREADY_RUN } }]), WAIT);
    release.resolve();
    await vi.waitFor(() => expect(r.results).toHaveLength(2), WAIT);

    expect(r.results[1]).toEqual({ id: "c1", body: { ok: true, message: "done in A" } });
    expect(b.ran).toEqual([]);
  });

  it("cancels a command once its 60 s are up: the holder types nothing more and the window that got it reports 'timed out'", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    commandsOn();
    const m = machine();
    const r = relay([[command("slow", "send", { text: "a long text" })]]);
    const keystrokes: number[] = []; // when the holder typed
    let signal: AbortSignal | undefined;
    const a = windowOn(m, WIN_A, undefined, { pollMs: 100 });
    const b = windowOn(
      m,
      WIN_B,
      async (_cmd, s) => {
        signal = s;
        while (!s.aborted) {
          keystrokes.push(Date.now());
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        return { ok: false, message: "typing stopped" };
      },
      { pollMs: 100 },
    );
    b.held.add(SID);
    beat(m, WIN_B, [SID]);
    const took = Date.now();
    await a.bridge.restart();
    await b.bridge.restart();
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS - 1_000);
    expect(r.results).toEqual([]);
    expect(keystrokes.length).toBeGreaterThan(50);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(r.results).toEqual([{ id: "slow", body: { ok: false, message: TIMED_OUT } }]);
    expect(signal?.aborted).toBe(true);
    const typed = keystrokes.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(keystrokes).toHaveLength(typed);
    expect(Math.max(...keystrokes)).toBeLessThan(took + COMMAND_TIMEOUT_MS);
    expect(a.ran).toEqual([]);
  });

  it("lists the sessions this window holds while the bridge runs, and says when they change", async () => {
    commandsOn();
    const m = machine();
    relay([]);
    const a = windowOn(m, WIN_A);
    a.held.add(SID);
    a.bridge.onRows([row(SID), row(S2)]); // the bridge is off: nothing is listed
    expect(a.bridge.held()).toBeUndefined();
    expect(a.changed).toBe(0);
    await a.bridge.restart();
    a.bridge.onRows([row(S2), row(SID)]);
    expect(a.bridge.held()).toEqual([SID]);
    expect(a.changed).toBe(1);
    a.bridge.onRows([row(SID), row(S2)]);
    expect(a.changed).toBe(1);
    a.held.add(S2);
    a.bridge.onRows([row(SID), row(S2)]);
    expect(a.bridge.held()).toEqual([SID, S2].sort());
    expect(a.changed).toBe(2);
    await a.bridge.restart(); // a settings change: the bridge stops, so its health file lists nothing at once, then starts again
    expect(a.changed).toBe(3);
    a.bridge.onRows([row(SID), row(S2)]); // the first row cycle after the start lists them again
    expect(a.bridge.held()).toEqual([SID, S2].sort());
    expect(a.changed).toBe(4);
    a.bridge.dispose();
    expect(a.bridge.held()).toBeUndefined();
    expect(a.changed).toBe(5);
  });

  it("in observer mode keeps no inbox and no seen-id record: every command runs where it landed", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "send", { text: "hi" })], [command("c1", "send", { text: "hi" })]]);
    const a = windowOn(m, WIN_A, undefined, { shared: () => false });
    beat(m, WIN_B, [SID]);
    await a.bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(2), WAIT);

    expect(a.ran.map((c) => c.id)).toEqual(["c1", "c1"]);
    expect(fs.readdirSync(m.dir)).toEqual(["health"]); // only the health file this test wrote
  });
});

describe("a window runs its commands one at a time", () => {
  it("the next command waits while one that outlived its time still runs, and starts once that one settled", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "kill"), command("c2", "kill")]]);
    const t0 = Date.now();
    const steps: string[] = [];
    const a = windowOn(
      m,
      WIN_A,
      async (cmd) => {
        steps.push(`${cmd.id} starts at ${Date.now() - t0}`);
        // c1: a step that cannot stop once started (a keystroke run, a socket send) ends 5 s after the command's time
        if (cmd.id === "c1") await new Promise((resolve) => setTimeout(resolve, COMMAND_TIMEOUT_MS + 5_000));
        steps.push(`${cmd.id} ends at ${Date.now() - t0}`);
        return { ok: true, message: `${cmd.id} done` };
      },
      { pollMs: 100 },
    );
    await a.bridge.restart();
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 4_000);
    expect(r.results).toEqual([{ id: "c1", body: { ok: false, message: TIMED_OUT } }]);
    expect(steps).toEqual(["c1 starts at 0"]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(steps).toEqual(["c1 starts at 0", "c1 ends at 65000", "c2 starts at 65000", "c2 ends at 65000"]);
    expect(r.results[1]).toEqual({ id: "c2", body: { ok: true, message: "c2 done" } });
  });

  it("the next command runs 10 s after the deadline when the one before it never settles, and that is logged", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "kill"), command("c2", "kill")]]);
    const t0 = Date.now();
    const started: Array<[string, number]> = [];
    const a = windowOn(
      m,
      WIN_A,
      async (cmd) => {
        started.push([cmd.id, Date.now() - t0]);
        if (cmd.id === "c1") await new Promise(() => undefined);
        return { ok: true, message: `${cmd.id} done` };
      },
      { pollMs: 100 },
    );
    await a.bridge.restart();
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS + 9_000);
    expect(started).toEqual([["c1", 0]]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(started).toEqual([["c1", 0], ["c2", COMMAND_TIMEOUT_MS + 10_000]]);
    expect(r.results).toEqual([
      { id: "c1", body: { ok: false, message: TIMED_OUT } },
      { id: "c2", body: { ok: true, message: "c2 done" } },
    ]);
    expect(a.logs.join("\n")).toContain("kill c1 still runs 10 s after its time was up");
  });
});

describe("the window that holds the session checks a handed-over command again", () => {
  it("refuses it when its own settings refuse it, answers why and runs nothing", async () => {
    commandsOn();
    settings.set("remote.acceptCommands", false); // another editor that shares ~/.claude, with commands off
    const m = machine();
    relay([]);
    const b = windowOn(m, WIN_B);
    record(m, "c1");
    handIn(m, WIN_B, command("c1", "kill"));
    await b.bridge.restart();
    await vi.waitFor(() => expect(resultFor(m, WIN_A, "c1")).toEqual({ v: 1, id: "c1", ok: false, message: "remote commands disabled on this Mac" }), WAIT);
    expect(b.logs.join("\n")).toContain(`kill c1 from window ${WIN_A} -> failed: remote commands disabled on this Mac`);

    settings.set("remote.acceptCommands", true);
    settings.set("remote.allowedCommands", ["kill"]);
    record(m, "c2");
    handIn(m, WIN_B, command("c2", "send", { text: "hi" }));
    await vi.waitFor(() => expect(resultFor(m, WIN_A, "c2")).toEqual({ v: 1, id: "c2", ok: false, message: "send is not allowed on this Mac" }), WAIT);
    expect(b.ran).toEqual([]);
  });

  it("runs the device check too, never asking about a device itself: one not confirmed on this Mac is refused", async () => {
    commandsOn();
    const m = machine();
    relay([]);
    const checked: Array<[unknown, boolean | undefined]> = []; // device id, whether the check may ask about it
    const devices: DeviceCheck = {
      migrate: async () => undefined,
      refusal: async (deviceId, _lookup, ask) => {
        checked.push([deviceId, ask]);
        return deviceId === "phone-1" ? null : NOT_CONFIRMED;
      },
      pinnedKey: () => KEY,
      askToPin: () => undefined,
    };
    const b = windowOn(m, WIN_B, undefined, {}, devices);
    record(m, "c1");
    handIn(m, WIN_B, command("c1", "kill", { deviceId: "phone-2" }));
    await b.bridge.restart();
    await vi.waitFor(() => expect(resultFor(m, WIN_A, "c1")).toEqual({ v: 1, id: "c1", ok: false, message: NOT_CONFIRMED }), WAIT);

    record(m, "c2");
    handIn(m, WIN_B, command("c2", "kill", { deviceId: "phone-1" }));
    await vi.waitFor(() => expect(resultFor(m, WIN_A, "c2")).toEqual({ v: 1, id: "c2", ok: true, message: `ran in ${WIN_B}` }), WAIT);
    expect(b.ran.map((c) => c.id)).toEqual(["c2"]);
    expect(checked).toEqual([["phone-2", false], ["phone-1", false]]);
  });

  it("runs nothing whose id the seen-id store does not hold, and answers nothing", async () => {
    commandsOn();
    const m = machine();
    relay([]);
    const b = windowOn(m, WIN_B);
    const file = handIn(m, WIN_B, command("c9", "kill")); // never recorded: no window got it from the relay
    await b.bridge.restart();
    await vi.waitFor(() => expect(b.logs.join("\n")).toContain(`kill c9 from window ${WIN_A} not run: its id was not recorded`), WAIT);

    expect(fs.existsSync(file)).toBe(false);
    expect(b.ran).toEqual([]);
    expect(fs.existsSync(path.join(m.dir, "inbox", WIN_A))).toBe(false);
  });

  it("gives it at most its own 60 s, whatever deadline the file names", async () => {
    vi.useFakeTimers(FAKE_CLOCK);
    commandsOn();
    const m = machine();
    relay([]);
    let signal: AbortSignal | undefined;
    const b = windowOn(
      m,
      WIN_B,
      async (_cmd, s) => {
        signal = s;
        await new Promise<void>((resolve) => s.addEventListener("abort", () => resolve(), { once: true }));
        return { ok: false, message: "typing stopped" };
      },
      { pollMs: 100 },
    );
    record(m, "c1");
    handIn(m, WIN_B, command("c1", "kill"), Date.now() + 10 * 60_000);
    await b.bridge.restart();
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal?.aborted).toBe(true);
    expect(resultFor(m, WIN_A, "c1")).toEqual({ v: 1, id: "c1", ok: false, message: TIMED_OUT });
  });
});

describe("parseRequest", () => {
  it("gives the command back unchanged, its device id included, and refuses anything but a tab-bound command from a window", () => {
    const ok = { v: 1, from: WIN_A, deadline: 5, cmd: { id: "c1", type: "send", sessionId: SID, text: "hi", createdAt: 3, deviceId: "phone-1" } };
    expect(parseRequest(JSON.stringify(ok))).toEqual({ from: WIN_A, deadline: 5, cmd: ok.cmd });
    expect(TAB_BOUND_TYPES).toEqual(["send", "resume", "kill"]);
    for (const bad of [
      { ...ok, v: 2 },
      { ...ok, from: "../x" },
      { ...ok, deadline: "5" },
      { ...ok, cmd: { ...ok.cmd, type: "newSession" } },
      { ...ok, cmd: { ...ok.cmd, id: "" } },
      { ...ok, cmd: null },
    ]) {
      expect(parseRequest(JSON.stringify(bad))).toBeUndefined();
    }
    expect(parseRequest("not json")).toBeUndefined();
    expect(parseRequest(undefined)).toBeUndefined();
  });
});
