import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Hold, WakeGate } from "../src/automationGate";
import { ContinuityServer, readText, writeTextAtomic } from "../src/continuity";
import { lastAssistantStop } from "../src/core";
import {
  OPEN_COMMAND,
  PENDING_KEY,
  REGISTRY_KEY,
  TabWaker,
  isLimitStop,
  nextRegistry,
  ownSessions,
  parseIdleMs,
  parsePressure,
  summaryText,
  type LiveSession,
  type RegistryEntry,
  type WakeDeps,
} from "../src/wakeTabs";

const NOW = Date.UTC(2026, 10, 10, 6, 15, 0); // 08:15 Istanbul, the restart of 2026-11-10
const none = (): undefined => undefined;
const titleOf = (sid: string): string => `Limit-stopped session ${sid}`;
const reg = (sid: string, title: string = titleOf(sid)): RegistryEntry => ({ sid, title, lastSeenMs: NOW - 3_600_000, missed: 2 });
const pend = (sid: string, attempts = 0) => ({ sid, title: titleOf(sid), attempts });
const REVEAL_MS = 30; // Claude Code shows the tab after editor.open returns (two more command round trips)

/** An automation gate that lets every wake through and counts them; abort() cancels the wake in progress (automationGate.test.ts tests the real one). */
function openGate(over: Partial<WakeGate> = {}) {
  let ctl = new AbortController();
  const gate = {
    spent: 0,
    abort: (why: string): void => {
      ctl.abort(why);
      ctl = new AbortController();
    },
    hold: async (): Promise<Hold | undefined> => undefined,
    admit: async (): Promise<Hold | undefined> => undefined,
    spend: (): void => {
      gate.spent++;
    },
    beforeRestore: async (): Promise<Hold | undefined> => undefined,
    signal: (): AbortSignal => ctl.signal,
    ...over,
  };
  return gate;
}

/**
 * Fake editor + machine: like Claude Code, a tab wake returns before its tab (labelled
 * with the session title) becomes active, 30 ms later; its process appears 0.4 s after the wake.
 */
function harness(over: Partial<WakeDeps<string>> = {}, stored: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(stored));
  const writes: Array<[string, unknown]> = [];
  const logs: string[] = [];
  // Every remembered session's Claude Code tab is open, labelled with its title, unless a test closes it.
  const remembered = [REGISTRY_KEY, PENDING_KEY].flatMap((key) => (stored[key] as Array<{ sid: string; title?: string }> | undefined) ?? []);
  const state = { live: [] as LiveSession[], active: "editor-a", spawn: true, tabs: remembered.map((e) => e.title ?? titleOf(e.sid)) };
  const executeCommand = vi.fn(async (_id: string, ...args: unknown[]) => {
    const sid = String(args[0]);
    setTimeout(() => (state.active = `claude-${sid}`), REVEAL_MS);
    if (state.spawn) setTimeout(() => state.live.push({ sessionId: sid, pid: 4242, entrypoint: "claude-vscode" }), 400);
  });
  const restoreTabs = vi.fn(async (memo: string) => {
    state.active = memo;
  });
  const parentPids = vi.fn(async () => new Map<number, number>());
  const deps: WakeDeps<string> = {
    enabled: () => true,
    store: {
      get: <T>(key: string) => store.get(key) as T | undefined,
      update: (key: string, value: unknown) => {
        store.set(key, value);
        writes.push([key, value]);
      },
    },
    log: (msg) => {
      logs.push(msg);
    },
    now: () => Date.now(),
    hostPid: 100,
    titleOf,
    liveSessions: () => state.live,
    parentPids,
    limitStop: () => ({ ts: (Date.now() - 60_000) / 1000, apiError: true, status: 429 }),
    idleMs: async () => 60_000,
    windowFocused: () => false,
    commandExists: async () => true,
    executeCommand,
    snapshotTabs: () => state.active,
    activeTab: () => state.active,
    activeClaudeLabel: () => (state.active.startsWith("claude-") ? titleOf(state.active.slice("claude-".length)) : undefined),
    restoreTabs,
    claudeTabLabels: () => state.tabs,
    gate: openGate(),
    ...over,
  };
  return { deps, store, writes, logs, state, executeCommand, restoreTabs, parentPids, waker: new TabWaker(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registry", () => {
  it("survives the exit of every process at shutdown; a closed tab leaves after 2 misses and 60 s", () => {
    const r0 = nextRegistry([], ["a", "b"], 0, none);
    // Shutdown: every process exits, two observations within 20 s.
    const shutdown = nextRegistry(nextRegistry(r0, [], 10_000, none), [], 20_000, none);
    expect(shutdown.map((e) => [e.sid, e.missed])).toEqual([["a", 2], ["b", 2]]);
    // b's tab closed while the window runs.
    const r1 = nextRegistry(nextRegistry(r0, ["a"], 50_000, none), ["a"], 59_999, none);
    expect(r1.map((e) => e.sid)).toEqual(["a", "b"]); // 2 misses, under 60 s
    expect(nextRegistry(r1, ["a"], 60_000, none).map((e) => e.sid)).toEqual(["a"]);
    expect(nextRegistry(r0, ["a"], 120_000, none).map((e) => e.sid)).toEqual(["a", "b"]); // 60 s, one miss
    expect(nextRegistry(r1, ["a", "b"], 70_000, none).find((e) => e.sid === "b")).toEqual({ sid: "b", lastSeenMs: 70_000, missed: 0 });
  });

  it("lists this window's tab sessions only: claude-vscode processes whose parent is this extension host", () => {
    const live: LiveSession[] = [
      { sessionId: "tab", pid: 11, entrypoint: "claude-vscode" },
      { sessionId: "other-window", pid: 12, entrypoint: "claude-vscode" },
      { sessionId: "terminal", pid: 13, entrypoint: "cli" },
    ];
    expect(ownSessions(live, new Map([[11, 100], [12, 200], [13, 100]]), 100)).toEqual(["tab"]);
  });

  it("counts a tab session behind a claudeProcessWrapper (claude -> wrapper -> host), not one in another window", () => {
    const live: LiveSession[] = [
      { sessionId: "wrapped", pid: 21, entrypoint: "claude-vscode" },
      { sessionId: "wrapped-twice", pid: 22, entrypoint: "claude-vscode" },
      { sessionId: "other-window", pid: 23, entrypoint: "claude-vscode" },
      { sessionId: "too-deep", pid: 24, entrypoint: "claude-vscode" },
      { sessionId: "orphan", pid: 25, entrypoint: "claude-vscode" },
    ];
    const parents = new Map([
      [21, 31], [31, 100], // claude -> prompt-split -> this host
      [22, 32], [32, 33], [33, 100],
      [23, 34], [34, 200], [200, 1], // the other window's host
      [24, 41], [41, 42], [42, 43], [43, 44], [44, 100], // four wrappers: past the bound
      [100, 1],
    ]);
    expect(ownSessions(live, parents, 100)).toEqual(["wrapped", "wrapped-twice"]);
    expect(ownSessions(live, parents, 200)).toEqual(["other-window"]);
  });

  it("observes at most every 10 s, keeps the row title and writes workspaceState only on change", async () => {
    const h = harness({ titleOf: (sid) => (sid === "s1" ? "Fix the build" : undefined) });
    h.parentPids.mockResolvedValue(new Map([[11, 100]]));
    h.state.live.push({ sessionId: "s1", pid: 11, entrypoint: "claude-vscode" });
    h.waker.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.store.get(REGISTRY_KEY)).toEqual([{ sid: "s1", title: "Fix the build", lastSeenMs: NOW, missed: 0 }]);
    h.waker.observe(); // throttled
    await vi.advanceTimersByTimeAsync(10_000);
    h.waker.observe(); // same sessions, only lastSeenMs moved
    await vi.advanceTimersByTimeAsync(0);
    expect(h.parentPids).toHaveBeenCalledTimes(2);
    expect(h.writes.filter(([key]) => key === REGISTRY_KEY)).toHaveLength(1);
    h.parentPids.mockResolvedValue(undefined as unknown as Map<number, number>); // ps failed: no observation
    await vi.advanceTimersByTimeAsync(10_000);
    h.waker.observe();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.writes).toHaveLength(1);
  });
});

describe("activation", () => {
  it("pending = remembered minus running, limit stops only, persisted; the first sweep runs after 60 s", async () => {
    const stops: Record<string, boolean> = { a: true, c: true, d: true, e: false };
    const h = harness(
      { limitStop: (sid) => (stops[sid] ? { ts: NOW / 1000 - 600, apiError: true, status: 429 } : undefined) },
      { [REGISTRY_KEY]: [reg("a"), reg("b"), reg("c"), reg("e")], [PENDING_KEY]: [pend("d", 1)] },
    );
    h.state.live.push({ sessionId: "b", pid: 7, entrypoint: "claude-vscode" });
    h.waker.start();
    expect(h.store.get(PENDING_KEY)).toEqual([pend("d", 1), pend("a"), pend("c")]);
    expect(h.logs).toEqual(["wake: activation registry=4 pending=4 with a tab=4 limit-stopped=3"]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.executeCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("a pending session that runs again by the sweep is dropped without a wake", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("a")] });
    h.waker.start();
    h.state.live.push({ sessionId: "a", pid: 9 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.store.get(PENDING_KEY)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a start keeps only sessions whose Claude Code tab is open: one closed while the setting was off is never reopened", async () => {
    let on = true;
    const h = harness({ enabled: () => on }, { [REGISTRY_KEY]: [reg("a"), reg("b")] });
    h.waker.start();
    on = false; // wakeDeadTabs off: the waker no longer sees tabs close
    h.waker.tabClosed(titleOf("a"));
    h.state.tabs = [titleOf("b")];
    on = true;
    h.waker.start(true);
    expect(h.store.get(PENDING_KEY)).toEqual([pend("b")]);
    expect(h.logs).toContain("wake: activation registry=2 pending=2 with a tab=1 limit-stopped=1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand.mock.calls.map((c) => c[1])).toEqual(["b"]);
  });

  it("turning the setting on again lifts the stop after two failed wakes in a row", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("a"), reg("b")] });
    h.state.spawn = false;
    h.waker.start();
    await vi.advanceTimersByTimeAsync(130_000); // a fails at 80 s, b at 130 s
    expect(h.logs).toContain("wake: stopped after 2 failed wakes in a row until the next activation, 2 pending");
    h.waker.start(); // a start that is no turn-on keeps the stop
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(2);
    h.state.spawn = true;
    h.waker.start(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(3);
  });

  it("a closed Claude Code tab drops its pending session (Claude Code's truncated label)", () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("a", "Refactor the billing module"), reg("b", "Other work here")] });
    h.waker.start();
    h.waker.tabClosed("Refactor the billing mod…");
    expect(h.store.get(PENDING_KEY)).toEqual([{ sid: "b", title: "Other work here", attempts: 0 }]);
    expect(h.logs).toContain("wake: a dropped, its tab was closed");
  });
});

describe("limit stop (lastAssistantStop + isLimitStop)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-wake-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const iso = (ms: number) => new Date(ms).toISOString();
  const write = (lines: object[]): string => {
    const file = path.join(tmp, "s.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  };
  const limitError = (ms: number, text = "You've hit your 5-hour limit · resets 10am (Europe/Istanbul)") => ({
    type: "assistant",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    error: "rate_limit",
    message: { model: "<synthetic>", content: [{ type: "text", text }] },
    timestamp: iso(ms),
  });
  const user = (ms: number, content: string) => ({ type: "user", message: { role: "user", content }, timestamp: iso(ms) });
  const stopOf = (lines: object[]) => isLimitStop(lastAssistantStop(write(lines)), NOW);

  it("a 429 API error as the last assistant entry is a limit stop, whatever its text", () => {
    const file = write([user(NOW - 120_000, "fix it"), limitError(NOW - 60_000), { type: "last-prompt", lastPrompt: "fix it" }]);
    expect(lastAssistantStop(file)).toEqual({ ts: (NOW - 60_000) / 1000, apiError: true, status: 429 });
    expect(stopOf([limitError(NOW - 60_000, "You've hit your weekly limit · resets Nov 12 at 5pm (Europe/Istanbul)")])).toBe(true);
    expect(stopOf([limitError(NOW - 60_000, "You've reached your Fable limit. Switch to another model to continue.")])).toBe(true);
  });

  it("user, attachment, system and task-notification entries after the error still count", () => {
    const notification = "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>";
    expect(
      stopOf([
        limitError(NOW - 60_000),
        { type: "attachment", attachment: { type: "queued_command" }, timestamp: iso(NOW - 50_000) },
        { type: "system", subtype: "informational", content: "note", timestamp: iso(NOW - 40_000) },
        user(NOW - 30_000, notification),
      ]),
    ).toBe(true);
  });

  it("a stop older than 24 h does not count", () => {
    const file = write([limitError(NOW - 24 * 3_600_000 - 1_000)]);
    expect(lastAssistantStop(file)?.status).toBe(429);
    expect(isLimitStop(lastAssistantStop(file), NOW)).toBe(false);
  });

  it("a reply after the error, a non-429 error or no transcript is no limit stop", () => {
    const reply = { type: "assistant", message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] }, timestamp: iso(NOW - 10_000) };
    expect(stopOf([limitError(NOW - 60_000), user(NOW - 20_000, "resume"), reply])).toBe(false);
    const overloaded = { type: "assistant", isApiErrorMessage: true, apiErrorStatus: 529, message: { content: [{ type: "text", text: "529 Overloaded" }] }, timestamp: iso(NOW - 10_000) };
    expect(stopOf([overloaded])).toBe(false);
    expect(lastAssistantStop(path.join(tmp, "missing.jsonl"))).toBeUndefined();
    expect(isLimitStop(undefined, NOW)).toBe(false);
  });
});

describe("preconditions", () => {
  it("checks the automation gate, then the command, then idle and focus, right before it acts", async () => {
    const order: string[] = [];
    const h = harness(
      {
        gate: openGate({ admit: async () => (order.push("gate"), undefined) }),
        commandExists: async () => (order.push("command"), true),
        idleMs: async () => (order.push("idle"), undefined), // unreadable: the window focus decides
        windowFocused: () => (order.push("focus"), false),
      },
      { [REGISTRY_KEY]: [reg("a")] },
    );
    const wake = h.executeCommand.getMockImplementation()!;
    h.executeCommand.mockImplementation(async (id: string, ...args: unknown[]) => {
      order.push("act");
      await wake(id, ...args);
    });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(order.slice(0, 5)).toEqual(["gate", "command", "idle", "focus", "act"]);
  });

  it("waits while the user is active and logs one line per reason per 10 min", async () => {
    let idle: number | undefined = 5_000;
    let focused = true;
    const h = harness({ idleMs: async () => idle, windowFocused: () => focused }, { [REGISTRY_KEY]: [reg("a")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000 + 30_000);
    idle = undefined; // unreadable: a focused window counts as active
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.logs.filter((l) => l.startsWith("wake: postponed"))).toEqual(["wake: postponed (user active), 1 pending"]);
    focused = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("waits while the automation gate holds (memory, the spawn budget) or without Claude Code's command; a wake counts against the budget", async () => {
    let held: Hold | undefined = { kind: "memory", reason: "memory pressure 2" };
    let hasCommand = true;
    const gate = openGate({ admit: async () => held });
    const h = harness({ gate, commandExists: async () => hasCommand }, { [REGISTRY_KEY]: [reg("a")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    held = { kind: "budget", reason: "3 wakes in 5 min" };
    await vi.advanceTimersByTimeAsync(30_000);
    held = undefined;
    hasCommand = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(gate.spent).toBe(0);
    expect(h.logs.filter((l) => l.startsWith("wake: postponed"))).toEqual([
      "wake: postponed (memory pressure 2), 1 pending",
      "wake: postponed (3 wakes in 5 min), 1 pending",
      `wake: postponed (no ${OPEN_COMMAND} command), 1 pending`,
    ]);
    hasCommand = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
    expect(gate.spent).toBe(1);
  });

  it("gate off: nothing is read, written, scheduled or woken", async () => {
    const h = harness({ enabled: () => false }, { [REGISTRY_KEY]: [reg("a")], [PENDING_KEY]: [pend("b")] });
    const get = vi.spyOn(h.deps.store, "get");
    h.waker.start();
    h.waker.observe();
    h.waker.tabClosed("whatever tab label");
    await expect(h.waker.runNow()).resolves.toEqual({ result: "off", woken: 0, failed: 0, pending: 0 });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(get).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.parentPids).not.toHaveBeenCalled();
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.logs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("sweep step", () => {
  it("opens the tab through claude-vscode.editor.open, waits for its process and restores the tabs", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("s1")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand.mock.calls).toEqual([[OPEN_COMMAND, "s1", undefined, undefined, undefined, undefined, { programmatic: true }]]);
    expect(h.restoreTabs).not.toHaveBeenCalled(); // still waiting for the process
    await vi.advanceTimersByTimeAsync(500);
    expect(h.restoreTabs).toHaveBeenCalledWith("editor-a");
    expect(h.state.active).toBe("editor-a");
    expect(h.logs).toContain("wake: s1 live after 0.5s pid=4242");
    expect(h.store.get(PENDING_KEY)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0); // nothing pending: no further sweep
  });

  it("leaves the focus alone when the user moved to another tab during the wait", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("s1")] });
    h.executeCommand.mockImplementationOnce(async () => {
      h.state.active = "claude-s1";
      setTimeout(() => (h.state.active = "editor-b"), 200);
      setTimeout(() => h.state.live.push({ sessionId: "s1", pid: 4242 }), 400);
    });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.logs).toContain("wake: s1 live after 0.5s pid=4242");
    expect(h.restoreTabs).not.toHaveBeenCalled();
    expect(h.state.active).toBe("editor-b");
  });

  it("records the woken tab once Claude Code shows it, waiting up to 1 s, so the tabs are put back", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("s1")] });
    h.executeCommand.mockImplementationOnce(async () => {
      setTimeout(() => (h.state.active = "claude-s1"), 600); // a slow reveal, still within 1 s
      setTimeout(() => h.state.live.push({ sessionId: "s1", pid: 4242 }), 400);
    });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_500);
    expect(h.restoreTabs).not.toHaveBeenCalled(); // the process runs, the tab is not shown yet
    await vi.advanceTimersByTimeAsync(500);
    expect(h.restoreTabs).toHaveBeenCalledWith("editor-a");
    expect(h.state.active).toBe("editor-a");
  });

  it("waits at most 1 s for the tab to show", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("s1")] });
    h.executeCommand.mockImplementationOnce(async () => {
      setTimeout(() => h.state.live.push({ sessionId: "s1", pid: 4242 }), 400); // no tab shows
    });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(h.logs).toContain("wake: s1 live after 1.0s pid=4242");
    expect(h.store.get(PENDING_KEY)).toEqual([]);
  });

  it("leaves the tabs alone while the user works in the focused window, puts them back after input elsewhere", async () => {
    let idle = 60_000;
    let focused = false;
    let inWindow = true; // where the input during the next wake's wait happens
    const h = harness({ idleMs: async () => idle, windowFocused: () => focused }, { [REGISTRY_KEY]: [reg("a"), reg("b")] });
    const wake = h.executeCommand.getMockImplementation()!;
    h.executeCommand.mockImplementation(async (id: string, ...args: unknown[]) => {
      await wake(id, ...args);
      setTimeout(() => {
        idle = 3_000;
        focused = inWindow;
      }, 200);
    });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(61_000); // a is woken at 60 s, its process runs at 60.5 s
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
    expect(h.restoreTabs).not.toHaveBeenCalled();
    expect(h.state.active).toBe("claude-a");
    expect(h.logs).toContain("wake: a tabs left as they are, the user is active in this window");

    idle = 60_000; // the user leaves; during b's wait there is input in another app
    focused = false;
    inWindow = false;
    await vi.advanceTimersByTimeAsync(31_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(2);
    expect(h.restoreTabs).toHaveBeenCalledTimes(1);
  });

  it("wakeDeadTabsNow wakes every pending tab at once, idle or not, at least 10 s apart", async () => {
    const h = harness({ idleMs: async () => 0, windowFocused: () => true }, { [REGISTRY_KEY]: [reg("a"), reg("b")] });
    h.waker.start();
    const run = h.waker.runNow();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.executeCommand.mock.calls.map((c) => c[1])).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.executeCommand.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(run).resolves.toEqual({ result: "empty", woken: 2, failed: 0, pending: 0, reason: undefined });
  });

  it("two failed wakes in a row stop the sweep until the next activation", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("a"), reg("b"), reg("c")] });
    h.state.spawn = false; // the process never appears
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000 + 20_000);
    expect(h.logs).toContain("wake: a failed after 20.0s (no process), attempt 1/2");
    expect(h.restoreTabs).toHaveBeenCalledTimes(1); // the woken tab stayed active: tabs restored after a failure too
    await vi.advanceTimersByTimeAsync(30_000 + 20_000);
    expect(h.logs).toContain("wake: stopped after 2 failed wakes in a row until the next activation, 3 pending");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.executeCommand.mock.calls.map((c) => c[1])).toEqual(["a", "b"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(h.store.get(PENDING_KEY)).toEqual([pend("c"), pend("a", 1), pend("b", 1)]);
    await expect(h.waker.runNow()).resolves.toMatchObject({ result: "stopped", woken: 0 });
  });

  it("a session is dropped after its second failed wake, also across a restart", async () => {
    const h = harness({}, { [PENDING_KEY]: [pend("a", 1)] });
    h.state.spawn = false;
    h.waker.start();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(h.logs).toContain("wake: a failed after 20.0s (no process), attempt 2/2");
    expect(h.store.get(PENDING_KEY)).toEqual([]);
  });

  it("checks the gate again right before the restore: tab automation turned off leaves the tabs as they are", async () => {
    const gate = openGate({ beforeRestore: async () => ({ kind: "off", reason: "tab automation is off" }) });
    const h = harness({ gate }, { [REGISTRY_KEY]: [reg("s1")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_500);
    expect(h.logs).toContain("wake: s1 tabs left as they are (tab automation is off)");
    expect(h.logs).toContain("wake: s1 live after 0.5s pid=4242");
    expect(h.restoreTabs).not.toHaveBeenCalled();
    expect(h.state.active).toBe("claude-s1");
  });

  it("turning the setting or tab automation off during the wait cancels it: no restore, no failed try, nothing more woken", async () => {
    let on = true;
    const gate = openGate();
    const h = harness({ gate, enabled: () => on }, { [REGISTRY_KEY]: [reg("a"), reg("b")] });
    h.state.spawn = false; // a's process never appears: the wake waits up to 20 s
    h.waker.start();
    await vi.advanceTimersByTimeAsync(65_000);
    on = false;
    gate.abort("wakeDeadTabs is off");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.logs).toContain("wake: a cancelled after 5.5s (wakeDeadTabs is off), tabs left as they are");
    expect(h.restoreTabs).not.toHaveBeenCalled();
    expect(h.store.get(PENDING_KEY)).toEqual([pend("a"), pend("b")]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a configuration change while the gate checks run cancels the wake before the show: nothing shown or spent", async () => {
    const gate = openGate();
    let first = true;
    gate.admit = async () => {
      if (first) gate.abort("tab automation is off"); // the change lands while the checks await sysctl and the rest
      first = false;
      return undefined;
    };
    const h = harness({ gate }, { [REGISTRY_KEY]: [reg("a")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(gate.spent).toBe(0);
    expect(h.logs).toContain("wake: a cancelled before the show (tab automation is off)");
    expect(h.store.get(PENDING_KEY)).toEqual([pend("a")]); // no try used
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });

  it("a command error counts as a failed wake", async () => {
    const h = harness({}, { [REGISTRY_KEY]: [reg("a")] });
    h.executeCommand.mockRejectedValueOnce(new Error("command 'claude-vscode.editor.open' not found"));
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.logs).toContain("wake: a failed after 0.0s (command 'claude-vscode.editor.open' not found), attempt 1/2");
  });
});

describe("machine probes and the command message", () => {
  it("parses ioreg idle time and the memory pressure level", () => {
    expect(parseIdleMs('    | |     "HIDIdleTime" = 519773375\n')).toBeCloseTo(519.773375);
    expect(parseIdleMs("no such key")).toBeUndefined();
    expect(parseIdleMs(null)).toBeUndefined();
    expect(parsePressure("2\n")).toBe(2);
    expect(parsePressure("")).toBeUndefined();
    expect(parsePressure(null)).toBeUndefined();
  });

  it("summarizes a wakeDeadTabsNow run", () => {
    expect(summaryText({ result: "empty", woken: 2, failed: 0, pending: 0 })).toBe("Agent Sessions: woke 2 limit-stopped tabs.");
    expect(summaryText({ result: "empty", woken: 0, failed: 0, pending: 0 })).toBe("Agent Sessions: no limit-stopped tabs to wake.");
    expect(summaryText({ result: "postponed", woken: 1, failed: 0, pending: 2, reason: "memory pressure 4" })).toBe(
      "Agent Sessions: woke 1 limit-stopped tab, postponed (memory pressure 4), 2 still pending.",
    );
    expect(summaryText({ result: "stopped", woken: 0, failed: 2, pending: 1 })).toBe(
      "Agent Sessions: woke 0 limit-stopped tabs, 2 failed, stopped after two failed wakes in a row, 1 still pending.",
    );
    expect(summaryText({ result: "off", woken: 0, failed: 0, pending: 0 })).toContain("claudeSessionMonitor.wakeDeadTabs");
  });
});

describe("continuity requests (continuity.ts)", () => {
  const STORAGE = "/ws/storage";
  const SID = "0b563428-5f1e-4c7a-9d2b-3e4f5a6b7c8d";
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-wake-continuity-"));
    const r1 = { id: "r1", sid: SID, storage: STORAGE, title: "Fix the build", action: "open", ts: NOW / 1000, expires: NOW / 1000 + 900 };
    fs.writeFileSync(path.join(dir, "requests.json"), JSON.stringify({ v: 1, ts: NOW / 1000, requests: [r1] }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /** The waker and a continuity server wired as extension.ts wires them; the request's tab gets its process 3 s after it is shown. */
  function wired(wakeOn: boolean) {
    const timeline: string[] = [];
    const at = () => ((Date.now() - NOW) / 1000).toFixed(1);
    let server: ContinuityServer<string, string> | undefined;
    const h = harness({ enabled: () => wakeOn, yieldTo: () => server?.pending() === true }, { [REGISTRY_KEY]: [reg("a")] });
    const wake = h.executeCommand.getMockImplementation();
    h.executeCommand.mockImplementation(async (id: string, ...args: unknown[]) => {
      timeline.push(`${at()} wake ${String(args[0])}`);
      await wake?.(id, ...args);
    });
    let active = "editor";
    server = new ContinuityServer<string, string>({
      enabled: () => true,
      storage: STORAGE,
      version: "2.38.0",
      pid: 1,
      dir,
      now: () => Date.now(),
      log: (m) => {
        if (m.includes(", request ")) timeline.push(`${at()} ${m}`);
      },
      read: readText,
      write: writeTextAtomic,
      liveSessions: () => h.state.live,
      windowFocused: () => false,
      idleMs: async () => 60_000,
      othersBusy: () => h.waker.isBusy(),
      tabs: () =>
        ["editor", "c1"].map((tab) => ({ group: "g0", tab, label: tab === "c1" ? "Fix the build" : "notes.md", claude: tab === "c1", active: active === tab })),
      activeGroup: () => "g0",
      activeTabOf: () => active,
      reveal: async (_group, tab) => {
        active = tab;
        if (tab !== "c1") return;
        timeline.push(`${at()} show c1`);
        setTimeout(() => h.state.live.push({ sessionId: SID, pid: 7 }), 3_000);
      },
      focusGroup: async () => undefined,
      gate: openGate(),
    });
    return { h, server, timeline };
  }

  it("a request and a limit-stopped tab both due: the request goes first, the wake follows in a later step", async () => {
    const { h, server, timeline } = wired(true);
    h.waker.start(); // a is limit-stopped: its first sweep runs at 60 s, the request's first step too
    await vi.advanceTimersByTimeAsync(58_500);
    for (let t = 0; t < 30; t++) {
      server.observe();
      h.waker.observe();
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(timeline).toEqual(["60.0 show c1", "63.0 continuity: 0b563428 opened after 3.0s pid=7, try 1/2, request r1", "90.0 wake a"]);
    expect(h.logs).toContain("wake: postponed (continuity request first), 1 pending");
    expect(JSON.stringify(h.writes)).not.toContain(SID); // never in csm.wake.pending or csm.wake.registry
  });

  it("a request is served with wakeDeadTabs off; the waker reads and writes nothing", async () => {
    const { h, server, timeline } = wired(false);
    h.waker.start();
    for (let t = 0; t < 43; t++) {
      server.observe();
      await vi.advanceTimersByTimeAsync(1_500);
    }
    expect(timeline).toEqual(["60.0 show c1", "63.0 continuity: 0b563428 opened after 3.0s pid=7, try 1/2, request r1"]);
    expect(h.writes).toEqual([]);
    expect(h.executeCommand).not.toHaveBeenCalled();
  });

  it("the waker postpones its wake while a request is served or waits", async () => {
    let first = true;
    const h = harness({ yieldTo: () => first }, { [REGISTRY_KEY]: [reg("a")] });
    h.waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.executeCommand).not.toHaveBeenCalled();
    expect(h.logs).toContain("wake: postponed (continuity request first), 1 pending");
    first = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.executeCommand).toHaveBeenCalledTimes(1);
  });
});
