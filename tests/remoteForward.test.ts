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

/** What the windows of one Mac share: a temp folder with the health files, the inboxes and the seen-id store. */
interface Machine {
  dir: string;
  ended: Set<number>; // pids whose process ended
}

function machine(): Machine {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-forward-"));
  dirs.push(dir);
  return { dir, ended: new Set() };
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

/** A window's bridge on the machine; its executor answers "ran in <win>" unless the test passes one. */
function windowOn(m: Machine, win: string, exec?: Exec, over: Partial<ForwardDeps> = {}): Win {
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

/** A relay every window polls: poll n (from any window) gets batches[n] once `gate` opens, later polls hang until their bridge stops. */
function relay(batches: FleetCommand[][], gate: Promise<void> = Promise.resolve()) {
  const results: Array<{ id: string; body: CommandOutcome }> = [];
  let polls = 0;
  const fetchMock = vi.fn(async (url: string, init: { method: string; body?: string; signal: AbortSignal }) => {
    if (init.method === "GET") {
      const batch = batches[polls++];
      if (!batch) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      await gate;
      return response({ success: true, data: { commands: batch } });
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

describe("a tab-bound remote command runs in the window that holds the session", () => {
  it("is handed to the live window holding the session, which runs it; the window that got it reports that result", async () => {
    commandsOn();
    const m = machine();
    const r = relay([[command("c1", "send", { text: "run the tests" })]]);
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
    expect(b.ran).toEqual([{ id: "c1", type: "send", sessionId: SID, text: "run the tests", createdAt: expect.any(Number) }]);
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
    expect(r.results).toEqual([]);

    m.ended.add(HOLDER_PID);
    await vi.waitFor(() => expect(r.results).toHaveLength(1), WAIT);
    expect(r.results[0].body).toEqual({ ok: true, message: `ran in ${WIN_A}` });
    expect(a.ran.map((c) => c.id)).toEqual(["c1"]);
    expect(a.logs.join("\n")).toContain(`window ${WIN_B} closed before it took c1; it runs here`);
    expect(inboxFiles(m)).toEqual([]);
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
    a.bridge.dispose();
    expect(a.bridge.held()).toBeUndefined();
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

describe("parseRequest", () => {
  it("keeps the fields a tab-bound command reads and refuses anything else", () => {
    const ok = { v: 1, from: WIN_A, deadline: 5, cmd: { id: "c1", type: "send", sessionId: SID, text: "hi", createdAt: 3, account: "x@y" } };
    expect(parseRequest(JSON.stringify(ok))).toEqual({ from: WIN_A, deadline: 5, cmd: { id: "c1", type: "send", sessionId: SID, text: "hi", createdAt: 3 } });
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
