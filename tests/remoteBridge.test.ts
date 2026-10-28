import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, unknown>());

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: (key: string) => (settings.has(key) ? { globalValue: settings.get(key) } : undefined),
    }),
  },
  window: { showWarningMessage: () => Promise.resolve(undefined) },
}));

import type { PeerSendResult } from "../src/peerSend";
import { RemoteBridge, deliverText, remoteFlag, type CommandOutcome, type FleetCommand, type PathAttempt } from "../src/remoteBridge";

afterEach(() => {
  settings.clear();
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

function paths(o: { terminal?: PathAttempt | Error; typed?: PathAttempt; uds?: PeerSendResult | Error }) {
  const calls: string[] = [];
  const run = () =>
    deliverText({
      terminal: async () => {
        calls.push("terminal");
        if (o.terminal instanceof Error) throw o.terminal;
        return o.terminal ?? skip("no terminal");
      },
      typed: async () => {
        calls.push("typed");
        return o.typed ?? skip("no tab");
      },
      uds: async () => {
        calls.push("uds");
        if (o.uds instanceof Error) throw o.uds;
        return o.uds ?? inboxOk;
      },
    });
  return { calls, run };
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
});

describe("remoteFlag", () => {
  it("reads the user value only and defaults to on", () => {
    expect(remoteFlag("remote.acceptCommands")).toBe(true);
    settings.set("remote.acceptCommands", false);
    settings.set("remote.typeFallback", "false"); // not a boolean: ignored
    expect(remoteFlag("remote.acceptCommands")).toBe(false);
    expect(remoteFlag("remote.typeFallback")).toBe(true);
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

/** A fake relay: the first poll hands out `commands`, later polls hang until the bridge stops. */
function relay(commands: unknown[], contentLength?: string) {
  const calls: FetchCall[] = [];
  const results: Array<{ id: string; body: CommandOutcome }> = [];
  let polls = 0;
  const fetchMock = vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    if (init.method === "GET") {
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

function startBridge(execute: (cmd: FleetCommand) => Promise<CommandOutcome>): RemoteBridge {
  settings.set("remote.url", "https://relay.test");
  settings.set("remote.host", "mac");
  const ctx = {
    extension: { packageJSON: { version: "0.0.0-test" } },
    secrets: { get: async () => JSON.stringify({ origin: "https://relay.test", token: "test-token" }) },
  };
  return new RemoteBridge(ctx as never, { log: () => undefined, accounts: () => ({ accounts: [], bestId: null }), execute });
}

describe("RemoteBridge command loop", () => {
  it("runs at most 20 commands per poll, expires old or undated ones unrun, and refuses redirects", async () => {
    const now = Date.now();
    const commands: FleetCommand[] = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, type: "kill", sessionId: "s1", createdAt: now }));
    commands[1] = { ...commands[1], createdAt: now - 121_000 };
    commands[2] = { id: "c2", type: "kill", sessionId: "s1" };
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

  it("with acceptCommands off answers every command unrun and keeps uploading the snapshot", async () => {
    settings.set("remote.acceptCommands", false);
    const r = relay([{ id: "k1", type: "send", sessionId: "s1", text: "hi", createdAt: Date.now() }]);
    const execute = vi.fn(async () => ({ ok: true, message: "ran" }));
    const bridge = startBridge(execute);
    await bridge.restart();
    await vi.waitFor(() => expect(r.results).toHaveLength(1));
    bridge.onRows([]);
    await vi.waitFor(() => expect(r.calls.some((c) => c.url.endsWith("/fleet/ingest"))).toBe(true));
    bridge.dispose();

    expect(r.results[0].body).toEqual({ ok: false, message: "remote commands disabled on this Mac" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers 'timed out' when a command runs past 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const r = relay([{ id: "slow", type: "kill", sessionId: "s1", createdAt: Date.now() }]);
    const bridge = startBridge(() => new Promise<CommandOutcome>(() => undefined));
    await bridge.restart();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(r.results).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(r.results).toEqual([{ id: "slow", body: { ok: false, message: "timed out" } }]));
    bridge.dispose();
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
