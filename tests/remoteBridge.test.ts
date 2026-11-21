import { createPrivateKey, randomUUID, sign } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, unknown>()); // user (global) values
const workspaceSettings = vi.hoisted(() => new Map<string, unknown>()); // a workspace's .vscode/settings.json

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) =>
        settings.has(key) || workspaceSettings.has(key)
          ? { globalValue: settings.get(key), workspaceValue: workspaceSettings.get(key) }
          : undefined,
    }),
  },
  window: { showWarningMessage: () => Promise.resolve(undefined) },
}));

import { nothingTyped } from "../src/keystrokeTyping";
import type { PeerSendResult } from "../src/peerSend";
import { DEFAULT_ALLOWED_COMMANDS, REMOTE_COMMAND_TYPES } from "../src/remote";
import { RemoteBridge, TYPED_REASON, deliverText, remoteAllowedCommands, remoteFlag, type CommandOutcome, type FleetCommand, type PathAttempt } from "../src/remoteBridge";
import { DeviceGate, nodeDeviceFs, type DeviceCheck } from "../src/remoteDevices";
import { RemoteForwarder } from "../src/remoteForward";
import { CONFIRM_KEY, NONCE_SEEN, NOT_VERIFIED, OTHER_HOST, TOO_OLD, UNSIGNED } from "../src/remoteSigned";

afterEach(() => {
  settings.clear();
  workspaceSettings.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --------------------------------------------------------------- deliverText ---

const delivered: PathAttempt = { ok: true };
const skip = (reason: string): PathAttempt => ({ ok: false, skip: true, reason });
const inboxOk: PeerSendResult = {
  ok: true,
  pid: 1,
  sessionId: "s1",
  socket: "/tmp/s1.sock",
  msgId: "m1",
  rawResponse: "",
  confirmed: "in-transcript",
};

function paths(o: { text?: string; terminal?: PathAttempt | Error; typed?: PathAttempt; uds?: PeerSendResult | Error }) {
  const calls: string[] = [];
  const inboxLines: string[] = []; // what the inbox was asked to deliver
  const run = () =>
    deliverText({
      text: o.text ?? "run the tests",
      terminal: async () => {
        calls.push("terminal");
        if (o.terminal instanceof Error) throw o.terminal;
        return o.terminal ?? skip("no terminal");
      },
      typed: async () => {
        calls.push("typed");
        return o.typed ?? skip("no tab");
      },
      uds: async (line: string) => {
        calls.push("uds");
        inboxLines.push(line);
        if (o.uds instanceof Error) throw o.uds;
        return o.uds ?? inboxOk;
      },
    });
  return { calls, inboxLines, run };
}

describe("deliverText: one delivery path per command", () => {
  it("writes into the session's terminal and stops there", async () => {
    const p = paths({ terminal: delivered });
    expect(await p.run()).toEqual({ ok: true, message: "delivered via terminal" });
    expect(p.calls).toEqual(["terminal"]);
  });

  it("types only when no terminal applies, and stops there", async () => {
    const p = paths({ typed: delivered });
    expect(await p.run()).toEqual({ ok: true, message: "delivered via typed" });
    expect(p.calls).toEqual(["terminal", "typed"]);
  });

  it("uses the inbox last", async () => {
    const p = paths({});
    expect(await p.run()).toEqual({ ok: true, message: "delivered via inbox (in-transcript, msg_id m1)" });
    expect(p.calls).toEqual(["terminal", "typed", "uds"]);
  });

  it("reports an accepted but unseen inbox frame as pending and types nothing after it", async () => {
    const p = paths({ uds: { ok: false, code: "unconfirmed", error: "frame accepted by the inbox", msgId: "m2" } });
    expect(await p.run()).toEqual({ ok: true, message: "delivered via inbox (pending in the session)" });
    expect(p.calls).toEqual(["terminal", "typed", "uds"]);
  });

  it("stops at the path that rejected the input or failed while writing or typing", async () => {
    const rejected = paths({ terminal: { ok: false, skip: false, reason: "rejected input" } });
    expect(await rejected.run()).toEqual({ ok: false, message: "not delivered via terminal: rejected input" });
    expect(rejected.calls).toEqual(["terminal"]);

    const keystroke = paths({ typed: { ok: false, skip: false, reason: "keystroke failed", detail: "timeout" } });
    expect(await keystroke.run()).toEqual({ ok: false, message: "not delivered via typed: keystroke failed (timeout)" });
    expect(keystroke.calls).toEqual(["terminal", "typed"]);

    const thrown = paths({ terminal: new Error("boom") });
    expect(await thrown.run()).toEqual({ ok: false, message: "not delivered via terminal: error (Error: boom)" });
    expect(thrown.calls).toEqual(["terminal"]);
  });

  it("reports typing that stopped midway as a failure, so the inbox never gets the text a second time", async () => {
    const stopped = paths({
      typed: {
        ok: false,
        skip: nothingTyped("interrupted"),
        reason: TYPED_REASON.interrupted,
        detail: 'the keyboard focus is on AXTextArea "Terminal 1, zsh" (after 200 of 450 characters; Return not pressed)',
      },
    });
    const out = await stopped.run();
    expect(out.ok).toBe(false);
    expect(out.message).toBe(
      `not delivered via typed: ${TYPED_REASON.interrupted} (the keyboard focus is on AXTextArea "Terminal 1, zsh" (after 200 of 450 characters; Return not pressed))`,
    );
    expect(TYPED_REASON.interrupted).toMatch(/Return was not pressed/);
    expect(stopped.calls).toEqual(["terminal", "typed"]);

    // Focus elsewhere before the first keystroke typed nothing: the inbox may still deliver.
    const before = paths({ typed: { ok: false, skip: nothingTyped("not-prompt"), reason: TYPED_REASON["not-prompt"] } });
    expect(TYPED_REASON["not-prompt"]).toBeDefined();
    expect(await before.run()).toEqual({ ok: true, message: "delivered via inbox (in-transcript, msg_id m1)" });
    expect(before.calls).toEqual(["terminal", "typed", "uds"]);
  });

  it("runs no further path once the command's time is up", async () => {
    for (const abortIn of ["terminal", "typed"]) {
      const ac = new AbortController();
      const calls: string[] = [];
      const step = (via: string) => async (): Promise<PathAttempt> => {
        calls.push(via);
        if (via === abortIn) ac.abort();
        return skip(`no ${via}`);
      };
      const out = await deliverText({
        text: "run the tests",
        terminal: step("terminal"),
        typed: step("typed"),
        uds: async () => {
          calls.push("uds");
          return inboxOk;
        },
        signal: ac.signal,
      });
      expect(out).toEqual({ ok: false, message: "timed out" });
      expect(calls).toEqual(abortIn === "terminal" ? ["terminal"] : ["terminal", "typed"]);
    }
  });

  it("starts no inbox send with less than 10 s of the command's time left", async () => {
    for (const [left, sent] of [[9_000, false], [11_000, true]] as const) {
      const calls: string[] = [];
      const out = await deliverText({
        text: "run the tests",
        terminal: async () => skip("no terminal"),
        typed: async () => skip("no tab"),
        uds: async () => {
          calls.push("uds");
          return inboxOk;
        },
        signal: new AbortController().signal,
        deadline: Date.now() + left,
      });
      expect(out).toEqual(sent ? { ok: true, message: "delivered via inbox (in-transcript, msg_id m1)" } : { ok: false, message: "timed out" });
      expect(calls).toEqual(sent ? ["uds"] : []);
    }
  });

  it("names every skipped path when the inbox fails too", async () => {
    const refused = paths({ uds: { ok: false, code: "target", error: "no session record" } });
    expect(await refused.run()).toEqual({
      ok: false,
      message: "not delivered: terminal: no terminal; typed: no tab; inbox target: no session record",
    });
    const thrown = paths({ uds: new Error("socket gone") });
    expect(await thrown.run()).toEqual({
      ok: false,
      message: "not delivered: terminal: no terminal; typed: no tab; inbox error: Error: socket gone",
    });
  });

  it("checks the text before the inbox like the terminal and the keystrokes: a rejected text never reaches it", async () => {
    for (const bad of ["!rm -rf ~", " /model opus", "#remember this", "tab\there", "esc \u001b[31m", "a".repeat(2001), " \r\n "]) {
      const p = paths({ text: bad });
      expect(await p.run()).toEqual({ ok: false, message: "not delivered via inbox: rejected input" });
      expect(p.calls).toEqual(["terminal", "typed"]);
    }
    // An accepted text reaches the inbox as the same one line the other paths write or type.
    const ok = paths({ text: "  fix the login\r\n\nthen run the tests \n" });
    expect(await ok.run()).toEqual({ ok: true, message: "delivered via inbox (in-transcript, msg_id m1)" });
    expect(ok.inboxLines).toEqual(["fix the login then run the tests"]);
  });
});

describe("remote settings", () => {
  const defaults = ["resume", "kill", "resumeAll", "autoResume", "answer"];

  it("remoteFlag reads the user value only and is off unless it is true", () => {
    expect(remoteFlag("remote.acceptCommands")).toBe(false);
    expect(remoteFlag("remote.typeFallback")).toBe(false);
    workspaceSettings.set("remote.acceptCommands", true); // a workspace cannot turn them on
    workspaceSettings.set("remote.typeFallback", true);
    expect(remoteFlag("remote.acceptCommands")).toBe(false);
    expect(remoteFlag("remote.typeFallback")).toBe(false);
    settings.set("remote.acceptCommands", true);
    settings.set("remote.typeFallback", "true"); // not a boolean: ignored
    expect(remoteFlag("remote.acceptCommands")).toBe(true);
    expect(remoteFlag("remote.typeFallback")).toBe(false);
    settings.set("remote.acceptCommands", false);
    expect(remoteFlag("remote.acceptCommands")).toBe(false);
  });

  it("remoteAllowedCommands reads the user list only; unset or not an array of strings means the default list", () => {
    expect(remoteAllowedCommands()).toEqual(defaults);
    workspaceSettings.set("remote.allowedCommands", ["send"]); // a workspace cannot widen it
    expect(remoteAllowedCommands()).toEqual(defaults);
    for (const bad of ["send", ["send", 1], { send: true }, null]) {
      settings.set("remote.allowedCommands", bad);
      expect(remoteAllowedCommands()).toEqual(defaults);
    }
    settings.set("remote.allowedCommands", ["send", "kill"]);
    expect(remoteAllowedCommands()).toEqual(["send", "kill"]);
    settings.set("remote.allowedCommands", []);
    expect(remoteAllowedCommands()).toEqual([]);
  });

  it("package.json keeps commands and typing off by default and offers every command type, all but send, newSession and switchAccount by default", () => {
    const props = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")).contributes.configuration.properties;
    for (const key of ["remote.acceptCommands", "remote.typeFallback"]) {
      expect(props[`claudeSessionMonitor.${key}`]).toMatchObject({ type: "boolean", scope: "application", default: false });
    }
    const allowed = props["claudeSessionMonitor.remote.allowedCommands"];
    expect(allowed).toMatchObject({ type: "array", scope: "application" });
    expect([...REMOTE_COMMAND_TYPES].sort()).toEqual(["answer", "autoResume", "kill", "newSession", "resume", "resumeAll", "send", "switchAccount"]);
    expect(allowed.items.enum).toEqual([...REMOTE_COMMAND_TYPES]);
    expect(DEFAULT_ALLOWED_COMMANDS).toEqual(defaults);
    expect(allowed.default).toEqual(defaults);
  });
});

// ------------------------------------------------------------- command loop ---

interface FetchCall {
  url: string;
  init: { method: string; body?: string; redirect?: string; signal: AbortSignal };
}

function response(body: unknown, contentLength?: string) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (n: string) => (n.toLowerCase() === "content-length" ? (contentLength ?? String(text.length)) : null) },
    text: async () => text,
  };
}

/** A fake relay: the first poll hands out `commands`, later polls hang until the bridge stops; GET /fleet/tokens lists `tokens`. */
function relay(commands: unknown[], contentLength?: string, tokens: unknown[] = []) {
  const calls: FetchCall[] = [];
  const results: Array<{ id: string; body: CommandOutcome }> = [];
  let polls = 0;
  const fetchMock = vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    if (init.method === "GET") {
      if (url.endsWith("/fleet/tokens")) return response({ success: true, data: { tokens } });
      if (++polls === 1) return response({ success: true, data: { commands } }, contentLength);
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const m = /\/fleet\/commands\/([^/]+)\/result$/.exec(url);
    if (m) results.push({ id: decodeURIComponent(m[1]), body: JSON.parse(init.body ?? "{}") });
    return response({ success: true, data: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, results };
}

// The phone's key in these tests: the RFC 8032 test 1 key (remoteSigned.test.ts checks the protocol's test vector with it).
const KEY = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
const phoneKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex")]),
  format: "der",
  type: "pkcs8",
});
const ARG_NAMES = ["sessionId", "text", "account", "cwd", "enabled", "toolUseId", "answers"];

/**
 * `cmd` as the phone sends it through the relay: its type and arguments signed for host "mac" with a fresh nonce
 * and the current time, by device "phone" unless `cmd` names one (undefined included); `over` replaces signed fields.
 */
function signed<T extends { type: string; deviceId?: string | null }>(cmd: T, over: Record<string, unknown> = {}): T & { signed: string; sig: string } {
  const withDevice: T = "deviceId" in cmd ? cmd : { ...cmd, deviceId: "phone" };
  const args = Object.fromEntries(Object.entries(cmd).filter(([name]) => ARG_NAMES.includes(name)));
  const text = JSON.stringify({ v: 1, nonce: randomUUID(), deviceId: withDevice.deviceId, host: "mac", type: cmd.type, args, ts: Date.now(), ...over });
  return { ...withDevice, signed: text, sig: sign(null, Buffer.from(text, "utf8"), phoneKey).toString("base64") };
}

/** A nonce store in memory: each nonce is taken once. */
function memoryNonces(): { claim(id: string): boolean } {
  const taken = new Set<string>();
  return { claim: (id) => !taken.has(id) && !!taken.add(id) };
}

/** Every device confirmed, with the phone's key pinned: the tests that are not about the device check (remoteDevices.ts). */
const everyDevice: DeviceCheck = { migrate: async () => undefined, refusal: async () => null, pinnedKey: () => KEY, askToPin: () => false };

/** A bridge on the fake relay; `flags` are user settings (commands on unless a test passes its own). */
function startBridge(
  execute: (cmd: FleetCommand, signal: AbortSignal) => Promise<CommandOutcome>,
  flags: Record<string, unknown> = { "remote.acceptCommands": true },
  devices: DeviceCheck = everyDevice,
): RemoteBridge {
  settings.set("remote.url", "https://relay.test");
  settings.set("remote.host", "mac");
  for (const [key, value] of Object.entries(flags)) settings.set(key, value);
  const ctx = {
    extension: { packageJSON: { version: "0.0.0-test" } },
    secrets: { get: async () => JSON.stringify({ origin: "https://relay.test", token: "test-token" }) },
  };
  return new RemoteBridge(ctx as never, { log: () => undefined, accounts: () => ({ accounts: [], bestId: null }), execute, devices, nonces: memoryNonces() });
}

describe("RemoteBridge command loop", () => {
  it("runs at most 20 commands per poll, expires old or undated ones unrun, and refuses redirects", async () => {
    const now = Date.now();
    const commands: FleetCommand[] = Array.from({ length: 25 }, (_, i) => signed({ id: `c${i}`, type: "kill", sessionId: "s1", createdAt: now }));
    commands[1] = { ...commands[1], createdAt: now - 121_000 };
    commands[2] = signed({ id: "c2", type: "kill", sessionId: "s1" });
    const r = relay(commands);
    const executed: string[] = [];
    const bridge = startBridge(async (cmd) => {
      executed.push(cmd.id);
      return { ok: true, message: "done" };
    });
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(20));
    bridge.dispose();

    expect(executed).toEqual(commands.slice(0, 20).map((c) => c.id).filter((id) => id !== "c1" && id !== "c2"));
    expect(r.results.find((x) => x.id === "c1")?.body).toEqual({ ok: false, message: "expired" });
    expect(r.results.find((x) => x.id === "c2")?.body).toEqual({ ok: false, message: "expired" });
    expect(r.results.find((x) => x.id === "c0")?.body).toEqual({ ok: true, message: "done" });
    expect(r.results.map((x) => x.id)).not.toContain("c20");
    expect(r.calls.length).toBeGreaterThan(20);
    expect(r.calls.every((c) => c.init.redirect === "error")).toBe(true);
  });

  it("with acceptCommands off answers every command unrun, before the allowlist, and keeps uploading the snapshot", async () => {
    const r = relay([{ id: "k1", type: "send", sessionId: "s1", text: "hi", createdAt: Date.now() }]);
    const execute = vi.fn(async () => ({ ok: true, message: "ran" }));
    const bridge = startBridge(execute, { "remote.acceptCommands": false });
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(1));
    bridge.onRows([]);
    await vi.waitFor(() => expect(r.calls.some((c) => c.url.endsWith("/fleet/ingest"))).toBe(true));
    bridge.dispose();

    expect(r.results[0].body).toEqual({ ok: false, message: "remote commands disabled on this Mac" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("with no user value for acceptCommands runs nothing: commands are off by default", async () => {
    const r = relay([{ id: "u1", type: "kill", sessionId: "s1", createdAt: Date.now() }]);
    const execute = vi.fn(async () => ({ ok: true, message: "ran" }));
    const bridge = startBridge(execute, {});
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(1));
    bridge.dispose();

    expect(r.results[0].body).toEqual({ ok: false, message: "remote commands disabled on this Mac" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs only allowed types: by default send, newSession, switchAccount and unknown types are answered unrun", async () => {
    const now = Date.now();
    const types = ["resume", "send", "kill", "newSession", "resumeAll", "switchAccount", "autoResume", "answer", "reboot"];
    const r = relay(types.map((type, i) => signed({ id: `t${i}`, type, sessionId: "s1", createdAt: now })));
    const executed: string[] = [];
    const bridge = startBridge(async (cmd) => {
      executed.push(cmd.type);
      return { ok: false, message: "ran" }; // not ok, so the autoResume result does not wait for a snapshot first
    });
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(types.length));
    bridge.dispose();

    expect(executed).toEqual(["resume", "kill", "resumeAll", "autoResume", "answer"]);
    const answer = (type: string) => r.results.find((x) => x.id === `t${types.indexOf(type)}`)?.body;
    for (const type of ["send", "newSession", "switchAccount", "reboot"]) {
      expect(answer(type)).toEqual({ ok: false, message: `${type} is not allowed on this Mac` });
    }
  });

  it("a user allowlist replaces the default one", async () => {
    const now = Date.now();
    const r = relay([
      signed({ id: "s1", type: "send", sessionId: "s1", text: "hi", createdAt: now }),
      signed({ id: "k1", type: "kill", sessionId: "s1", createdAt: now }),
    ]);
    const execute = vi.fn(async () => ({ ok: true, message: "ran" }));
    const bridge = startBridge(execute, { "remote.acceptCommands": true, "remote.allowedCommands": ["send"] });
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(2));
    bridge.dispose();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(r.results).toEqual([
      { id: "s1", body: { ok: true, message: "ran" } },
      { id: "k1", body: { ok: false, message: "kill is not allowed on this Mac" } },
    ]);
  });

  it("answers 'timed out' when a command runs past 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = relay([signed({ id: "slow", type: "kill", sessionId: "s1", createdAt: Date.now() })]);
    const bridge = startBridge(() => new Promise<CommandOutcome>(() => undefined));
    await bridge.restart();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(r.results).toEqual([{ id: "slow", body: { ok: false, message: "timed out" } }]));
    bridge.dispose();
  });

  it("cancels a command that runs past 60 s: its signal aborts and it types nothing more", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = relay([signed({ id: "slow", type: "send", sessionId: "s1", text: "a long text", createdAt: Date.now() })]);
    let keystrokes = 0;
    let signal: AbortSignal | undefined;
    const bridge = startBridge(
      async (_cmd, s) => {
        signal = s;
        while (!s.aborted) {
          keystrokes++;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        return { ok: false, message: "typing stopped" };
      },
      { "remote.acceptCommands": true, "remote.allowedCommands": ["send"] },
    );
    await bridge.restart();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(r.results).toEqual([{ id: "slow", body: { ok: false, message: "timed out" } }]));
    expect(signal?.aborted).toBe(true);
    const typed = keystrokes;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(keystrokes).toBe(typed);
    bridge.dispose();
  });

  it("after a newSession that started, pushes a snapshot inside the 10 s gap before it posts the result", async () => {
    const r = relay([signed({ id: "n1", type: "newSession", cwd: "/r/app", createdAt: Date.now() })]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const bridge = startBridge(
      async () => {
        await gate;
        return { ok: true, message: "new session s1 started in app" };
      },
      { "remote.acceptCommands": true, "remote.allowedCommands": ["newSession"] },
    );
    await bridge.restart();
    const ingests = () => r.calls.filter((c) => c.url.endsWith("/fleet/ingest")).length;
    bridge.onRows([]);
    await vi.waitFor(() => expect(ingests()).toBe(1), { timeout: 5000 });
    release();
    const tick = setInterval(() => bridge.onRows([]), 50); // the panel's poll cycle
    await vi.waitFor(() => expect(r.results).toHaveLength(1), { timeout: 5000 });
    clearInterval(tick);
    bridge.dispose();

    const order = r.calls
      .map((c) => (c.url.endsWith("/fleet/ingest") ? "ingest" : c.url.endsWith("/result") ? "result" : "poll"))
      .filter((x) => x !== "poll");
    expect(order.slice(0, 3)).toEqual(["ingest", "ingest", "result"]);
    expect(r.results[0].body).toEqual({ ok: true, message: "new session s1 started in app" });
  });

  it("refuses a relay answer over 256 KB and runs nothing from it", async () => {
    relay([{ id: "x1", type: "kill", sessionId: "s1", createdAt: Date.now() }], String(256 * 1024 + 1));
    const execute = vi.fn(async () => ({ ok: true, message: "ran" }));
    const bridge = startBridge(execute);
    await bridge.restart();
    await vi.waitFor(() => expect(bridge.status()).toContain("relay response too large"));
    bridge.dispose();
    expect(execute).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------- remote.allowedCwds ---

describe("remote.allowedCwds in the pushed snapshot", () => {
  const capabilities = { focus: true, transcript: false, resume: true, kill: false, bulkInput: true };
  const sessionRow = (sessionId: string, cwd: string): import("../src/providers/types").SessionView => ({
    key: `claude:${sessionId}`,
    provider: "claude",
    sessionId,
    title: "prompt text",
    bucket: "working",
    sub: "working",
    detail: "",
    tooltip: "",
    capabilities,
    cwd,
    lastActivityMs: 0,
    stale: false,
    matchLabels: [],
  });

  type Pushed = { sessions: Array<{ cwd: string | null }>; allowedCwds?: string[]; accounts: Array<{ email: string }> };

  async function pushOnce(): Promise<Pushed> {
    settings.set("remote.url", "https://relay.test");
    settings.set("remote.host", "mac");
    const r = relay([]);
    const ctx = {
      extension: { packageJSON: { version: "0.0.0-test" } },
      secrets: { get: async () => JSON.stringify({ origin: "https://relay.test", token: "test-token" }) },
    };
    const bridge = new RemoteBridge(ctx as never, {
      log: () => undefined,
      accounts: () => ({ accounts: [{ id: "a1", email: "alice@example.com", plan: null, active: true, gauges: [] }], bestId: null }),
      execute: async () => ({ ok: true, message: "" }),
      allowedCwds: () => ["/r/app", "/x/tool"],
      devices: everyDevice,
      nonces: memoryNonces(),
    });
    await bridge.restart();
    bridge.onRows([sessionRow("s1", "/r/app"), sessionRow("s2", "/x/secret")]);
    const ingest = () => r.calls.find((c) => c.url.endsWith("/fleet/ingest"));
    await vi.waitFor(() => expect(ingest()).toBeDefined(), { timeout: 5000 });
    bridge.dispose();
    return JSON.parse(ingest()!.init.body ?? "{}") as Pushed;
  }

  it("sends full paths only inside the user's roots and masks the account emails", async () => {
    settings.set("remote.allowedCwds", ["/r"]);
    const body = await pushOnce();
    expect(body.sessions.map((s) => s.cwd)).toEqual(["/r/app", "secret"]);
    expect(body.allowedCwds).toEqual(["/r/app"]);
    expect(body.accounts.map((a) => a.email)).toEqual(["a***@example.com"]);
  });

  it("ignores a workspace value, so a repository cannot widen the roots", async () => {
    workspaceSettings.set("remote.allowedCwds", ["/"]);
    const body = await pushOnce();
    expect(body.sessions.map((s) => s.cwd)).toEqual(["app", "secret"]);
    expect(body.allowedCwds).toEqual([]);
  });
});

describe("RemoteBridge device check", () => {
  let base = "";
  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = "";
  });

  /** A real gate over a temp file; the modal is recorded and closed without an answer. */
  function devicesIn(file: string, prompts: string[], now = Date.now) {
    return new DeviceGate({
      file,
      marker: path.join(path.dirname(file), "remote", "devices-first-run.json"),
      fs: nodeDeviceFs,
      now,
      prompt: async (d) => {
        prompts.push(`${d.id} ${d.name}`);
        return undefined;
      },
      askPin: async () => false,
      log: () => undefined,
    });
  }

  it("runs a command only from a device confirmed on this Mac and posts every refusal to the relay", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bridge-devices-"));
    const file = path.join(base, "remote-devices.json");
    const entry = (state: string, name: string) => ({ state, name, pairedAt: 1, decidedAt: 2 });
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: { phone: { ...entry("allowed", "iPhone"), publicKey: KEY }, tablet: entry("denied", "iPad") } }));
    const prompts: string[] = [];
    const now = Date.now();
    const kill = (id: string, deviceId?: string | null) => signed({ id, type: "kill", sessionId: "s1", createdAt: now, deviceId });
    const r = relay([kill("a", "phone"), kill("b", "tablet"), kill("c", "stranger"), kill("d"), kill("e", null)], undefined, [
      { id: "stranger", name: "Unknown phone", createdAt: now - 1000, lastUsedAt: null, current: false },
    ]);
    const execute = vi.fn(async (cmd: FleetCommand) => ({ ok: true, message: `ran ${cmd.id}` }));
    const bridge = startBridge(execute, undefined, devicesIn(file, prompts));
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(5));
    await vi.waitFor(() => expect(prompts).toEqual(["stranger Unknown phone"]));
    bridge.dispose();

    expect(execute.mock.calls.map(([cmd]) => cmd.id)).toEqual(["a"]);
    expect(r.results).toEqual([
      { id: "a", body: { ok: true, message: "ran a" } },
      { id: "b", body: { ok: false, message: "device denied on this Mac" } },
      { id: "c", body: { ok: false, message: "device not confirmed on this Mac" } },
      { id: "d", body: { ok: false, message: "device not confirmed on this Mac" } },
      { id: "e", body: { ok: false, message: "device not confirmed on this Mac" } },
    ]);
  });

  it("on its first start confirms the devices the relay lists, with the bridge token, once", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bridge-devices-"));
    const file = path.join(base, "session-monitor", "remote-devices.json");
    const r = relay([], undefined, [{ id: "phone", name: "iPhone", createdAt: 1, lastUsedAt: null, current: false }]);
    const bridge = startBridge(vi.fn(async () => ({ ok: true, message: "ran" })), undefined, devicesIn(file, [], () => 5));
    await bridge.restart();
    await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
    await bridge.restart();
    bridge.dispose();

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      devices: { phone: { state: "allowed", name: "iPhone", pairedAt: 1, decidedAt: 5 } },
    });
    const lookups = r.calls.filter((c) => c.url === "https://relay.test/fleet/tokens");
    expect(lookups).toHaveLength(1);
    expect((lookups[0].init as unknown as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer test-token");
  });
});

describe("RemoteBridge signed commands", () => {
  let base = "";
  afterEach(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
    base = "";
  });

  const ran = async (cmd: FleetCommand): Promise<CommandOutcome> => ({ ok: true, message: `ran ${cmd.id}` });

  it("refuses an unsigned command and one whose signature does not verify: neither reaches any delivery path", async () => {
    const now = Date.now();
    const good = signed({ id: "ok", type: "send", sessionId: "s1", text: "hi", createdAt: now });
    const r = relay([
      { id: "u1", type: "send", sessionId: "s1", text: "hi", createdAt: now },
      { ...signed({ id: "x1", type: "send", sessionId: "s1", text: "hi", createdAt: now }), sig: good.sig },
      { ...good, id: "x2", signed: good.signed.replace('"text":"hi"', '"text":"bye"') },
      good,
    ]);
    const execute = vi.fn(ran);
    const bridge = startBridge(execute, { "remote.acceptCommands": true, "remote.allowedCommands": ["send"], "remote.typeFallback": true });
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(4));
    bridge.dispose();

    expect(r.results).toEqual([
      { id: "u1", body: { ok: false, message: UNSIGNED } },
      { id: "x1", body: { ok: false, message: NOT_VERIFIED } },
      { id: "x2", body: { ok: false, message: NOT_VERIFIED } },
      { id: "ok", body: { ok: true, message: "ran ok" } },
    ]);
    expect(execute.mock.calls.map(([cmd]) => cmd.id)).toEqual(["ok"]);
  });

  it("runs a command from its signed type and arguments, never from the relay's other fields, here and in a hand-over", async () => {
    const now = Date.now();
    const s = signed({ id: "c1", type: "resume", sessionId: "signed-session", createdAt: now });
    const r = relay([{ ...s, type: "kill", sessionId: "relay-session", text: "relay text", cwd: "/elsewhere" }]);
    const run = vi.spyOn(RemoteForwarder.prototype, "run");
    const execute = vi.fn(ran);
    const bridge = startBridge(execute);
    let claimed: FleetCommand[] = [];
    try {
      await bridge.restart();
      await vi.waitFor(() => expect(r.results).toHaveLength(1));
      claimed = run.mock.calls.map(([cmd]) => cmd); // read before mockRestore, which clears them
    } finally {
      bridge.dispose();
      run.mockRestore();
    }

    // What the forwarder claims and runs here or hands to the window holding the session: the relay gives only its id, device and time.
    const rebuilt = { id: "c1", type: "resume", sessionId: "signed-session", deviceId: "phone", createdAt: now };
    expect(claimed).toEqual([rebuilt]);
    expect(execute.mock.calls.map(([cmd]) => cmd)).toEqual([rebuilt]);
    expect(r.results[0].body).toEqual({ ok: true, message: "ran c1" });
  });

  it("runs a signed command once: the relay handing it out again under another id gets it refused", async () => {
    const s = signed({ id: "a1", type: "kill", sessionId: "s1", createdAt: Date.now() });
    const r = relay([s, { ...s, id: "a2" }]);
    const execute = vi.fn(ran);
    const bridge = startBridge(execute);
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(2));
    bridge.dispose();

    expect(r.results).toEqual([
      { id: "a1", body: { ok: true, message: "ran a1" } },
      { id: "a2", body: { ok: false, message: NONCE_SEEN } },
    ]);
  });

  it("refuses a command signed for another host or more than 5 minutes ago", async () => {
    const now = Date.now();
    const r = relay([
      signed({ id: "h1", type: "kill", sessionId: "s1", createdAt: now }, { host: "Mac-test" }),
      signed({ id: "o1", type: "kill", sessionId: "s1", createdAt: now }, { ts: now - 6 * 60_000 }),
    ]);
    const execute = vi.fn(ran);
    const bridge = startBridge(execute);
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(2));
    bridge.dispose();

    expect(r.results).toEqual([
      { id: "h1", body: { ok: false, message: OTHER_HOST } },
      { id: "o1", body: { ok: false, message: TOO_OLD } },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("an allowed device without a pinned key: its first signed command is refused and asks to pin the relay's key; once pinned, its commands run", async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bridge-keys-"));
    const file = path.join(base, "remote-devices.json");
    const migrated = { state: "allowed", name: "iPhone", pairedAt: 1, decidedAt: 2 };
    fs.writeFileSync(file, JSON.stringify({ version: 1, devices: { phone: migrated } }));
    const pinAsks: string[] = [];
    const gate = new DeviceGate({
      file,
      marker: path.join(base, "remote", "devices-first-run.json"),
      fs: nodeDeviceFs,
      now: Date.now,
      prompt: async () => undefined,
      askPin: async (d) => {
        pinAsks.push(`${d.id} ${d.publicKey}`);
        return "pin";
      },
      log: () => undefined,
    });
    const listed = [{ id: "phone", name: "iPhone", createdAt: 1, lastUsedAt: null, current: false, publicKey: KEY }];
    const execute = vi.fn(ran);
    const first = relay([signed({ id: "p1", type: "kill", sessionId: "s1", createdAt: Date.now() })], undefined, listed);
    const bridge = startBridge(execute, undefined, gate);
    await bridge.restart();
    await vi.waitFor(() => expect(first.results).toHaveLength(1));
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(file, "utf8")).devices.phone).toEqual({ ...migrated, publicKey: KEY }));
    bridge.dispose();
    expect(first.results[0].body).toEqual({ ok: false, message: CONFIRM_KEY });
    expect(pinAsks).toEqual([`phone ${KEY}`]);

    const second = relay([signed({ id: "p2", type: "kill", sessionId: "s1", createdAt: Date.now() })], undefined, listed);
    const again = startBridge(execute, undefined, gate);
    await again.restart();
    await vi.waitFor(() => expect(second.results).toHaveLength(1));
    again.dispose();
    expect(second.results[0].body).toEqual({ ok: true, message: "ran p2" });
    expect(execute.mock.calls.map(([cmd]) => cmd.id)).toEqual(["p2"]);
  });
});
