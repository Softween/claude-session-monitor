import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  AutomationGate,
  CHECKED_CLAUDE_CODE,
  CLAUDE_CODE_COMMANDS,
  newerVersion,
  pulseStageOf,
  readPulseStage,
  strayViewTypes,
  type Automation,
  type ClaudeCodeInfo,
  type GateDeps,
  type TabView,
} from "../src/automationGate";
import { OPEN_COMMAND, REGISTRY_KEY, TabWaker, type LiveSession } from "../src/wakeTabs";

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const ALL: readonly Automation[] = ["wake", "continuity", "autoResume", "typingSweep", "remoteTyping"];
const PANEL = "mainThreadWebview-claudeVSCodePanel";
const MISSING = `Claude Code ${CHECKED_CLAUDE_CODE} has no ${OPEN_COMMAND} or claude-vscode.focus command`;

/** A gate over settings, memory, tabs and a Claude Code the test changes as it goes. */
function harness() {
  const env = {
    master: true,
    features: new Set<Automation>(ALL),
    pressure: 1 as number | undefined,
    pulse: undefined as string | undefined,
    claudeCode: { version: CHECKED_CLAUDE_CODE, active: true } as ClaudeCodeInfo | undefined,
    commands: ["workbench.action.openEditorAtIndex", ...CLAUDE_CODE_COMMANDS],
    tabs: [] as TabView[],
    titles: [] as string[],
  };
  const logs: string[] = [];
  const pressure = vi.fn(async () => env.pressure);
  const commands = vi.fn(async () => env.commands);
  const deps: GateDeps = {
    log: (m) => {
      logs.push(m);
    },
    now: () => Date.now(),
    masterOn: () => env.master,
    featureOn: (a) => env.features.has(a),
    pressureLevel: pressure,
    pulseStage: async () => env.pulse,
    claudeCode: () => env.claudeCode,
    commands,
    tabViews: () => env.tabs,
    claudeTitles: () => env.titles,
  };
  return { env, logs, pressure, commands, gate: new AutomationGate(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("switches", () => {
  it("every automation needs tab automation, its own setting and a Claude Code that passed the check", async () => {
    const h = harness();
    expect(h.gate.blocker("wake")).toBe("Claude Code is not checked yet");
    await h.gate.checkCompat();
    for (const a of ALL) expect([a, h.gate.blocker(a)]).toEqual([a, undefined]);
    h.env.features.delete("wake");
    h.env.features.delete("remoteTyping");
    h.env.features.delete("typingSweep");
    expect(h.gate.blocker("wake")).toBe("wakeDeadTabs is off");
    expect(h.gate.blocker("remoteTyping")).toBe("remote.typeFallback is off");
    expect(h.gate.blocker("typingSweep")).toBe("the Claude provider is off");
    h.env.master = false;
    for (const a of ALL) expect(h.gate.blocker(a)).toBe("tab automation is off");
    expect(await h.gate.wakeGate("continuity").admit()).toEqual({ kind: "off", reason: "tab automation is off" });
    expect(h.logs).toEqual([]); // a switch that is off is no refusal: no backoff
  });
});

describe("Claude Code compatibility", () => {
  it("a missing Claude Code command keeps every automation off with one log line and one panel notice; an update that has it turns them back on", async () => {
    const h = harness();
    h.env.commands = ["workbench.action.openEditorAtIndex"];
    await h.gate.checkCompat();
    for (const a of ALL) expect(h.gate.blocker(a)).toBe(MISSING);
    expect(h.gate.notice()).toBe(`tab automation off: ${MISSING}`);
    expect(h.gate.notice()).toBe(`tab automation off: ${MISSING}`);
    expect(h.logs).toEqual([`compat: tab automation off: ${MISSING}`]);
    h.env.master = false;
    expect(h.gate.notice()).toBeUndefined(); // tab automation off by choice: no notice
    h.env.master = true;

    h.env.commands = [...CLAUDE_CODE_COMMANDS];
    await h.gate.checkCompat(); // extensions.onDidChange
    expect(h.gate.blocker("wake")).toBeUndefined();
    expect(h.gate.notice()).toBeUndefined();
    expect(h.logs).toEqual([`compat: tab automation off: ${MISSING}`, "compat: Claude Code passed the check, tab automation on"]);
  });

  it("a Claude Code newer than the checked version is logged once and turns nothing off", async () => {
    const h = harness();
    h.env.claudeCode = { version: "2.1.400", active: true };
    await h.gate.checkCompat();
    await h.gate.checkCompat();
    for (const a of ALL) expect(h.gate.blocker(a)).toBeUndefined();
    expect(h.gate.notice()).toBeUndefined();
    expect(h.logs).toEqual([
      `compat: Claude Code 2.1.400 is newer than ${CHECKED_CLAUDE_CODE}, the newest version the tab automations were checked against`,
    ]);
    expect(newerVersion("2.2.0", "2.1.327")).toBe(true);
    expect(newerVersion("2.1.328-beta.1", "2.1.327")).toBe(true);
    expect(newerVersion("2.1.327", "2.1.327")).toBe(false);
    expect(newerVersion("2.1.99", "2.1.327")).toBe(false);
  });

  it("without Claude Code the automations are off, logged once, without a panel notice", async () => {
    const h = harness();
    h.env.claudeCode = undefined;
    await h.gate.checkCompat();
    expect(h.gate.blocker("typingSweep")).toBe("the Claude Code extension is not installed");
    expect(h.gate.notice()).toBeUndefined();
    expect(h.commands).not.toHaveBeenCalled();
    expect(h.logs).toEqual(["compat: tab automation off: the Claude Code extension is not installed"]);
  });

  it("a Claude Code that has not started yet (no commands registered) holds the automations silently; the next consult checks again once it runs", async () => {
    const h = harness();
    h.env.claudeCode = { version: CHECKED_CLAUDE_CODE, active: false };
    h.env.commands = [];
    await h.gate.checkCompat();
    expect(h.gate.blocker("wake")).toBe("Claude Code has not started yet");
    expect(h.commands).not.toHaveBeenCalled();
    h.env.claudeCode = { version: CHECKED_CLAUDE_CODE, active: true };
    h.env.commands = [...CLAUDE_CODE_COMMANDS];
    h.gate.blocker("wake"); // sees it running: checks again
    expect(h.commands).toHaveBeenCalledTimes(1);
    await h.gate.checkCompat(); // the same check, still in flight
    expect(h.commands).toHaveBeenCalledTimes(1);
    expect(h.gate.blocker("wake")).toBeUndefined();
    expect(h.logs).toEqual([]);
  });

  it("a command list that cannot be read keeps the automations off only until the next consult checks again", async () => {
    const h = harness();
    h.commands.mockRejectedValueOnce(new Error("extension host busy"));
    await h.gate.checkCompat();
    expect(h.gate.blocker("wake")).toBe("the command list could not be read"); // this consult starts the check again
    await h.gate.checkCompat(); // the same check, still in flight
    expect(h.commands).toHaveBeenCalledTimes(2);
    expect(h.gate.blocker("wake")).toBeUndefined();
    expect(h.logs).toEqual(["compat: tab automation off: the command list could not be read", "compat: Claude Code passed the check, tab automation on"]);
  });

  it("a tab that shows a listed Claude session must be a Claude Code panel; with none open that half passes", async () => {
    const h = harness();
    await h.gate.checkCompat();
    h.env.titles = ["Refactor the billing module for EU"];
    h.env.tabs = [{ label: "Preview notes.md", viewType: "mainThreadWebview-markdown.preview" }];
    expect(h.gate.blocker("wake")).toBeUndefined();
    h.env.tabs.push({ label: "Refactor the billing mod…", viewType: PANEL }); // Claude Code's truncated label
    expect(h.gate.blocker("wake")).toBeUndefined();
    h.env.tabs.push({ label: "Refactor the billing mod…", viewType: "mainThreadWebview-claudeCodeChat" });
    const reason = "a Claude session's tab has view type mainThreadWebview-claudeCodeChat, not claudeVSCodePanel";
    expect(h.gate.blocker("continuity")).toBe(reason);
    expect(h.gate.notice()).toBe(`tab automation off: ${reason}`);
    h.env.tabs.pop();
    expect(h.gate.blocker("continuity")).toBeUndefined();
    expect(h.logs).toEqual([`compat: tab automation off: ${reason}`, "compat: Claude Code passed the check, tab automation on"]);
    // another extension's webview tab counts only when its label is a listed Claude session's title
    expect(strayViewTypes([{ label: "Cline", viewType: "mainThreadWebview-claude-dev.TabPanelProvider" }], h.env.titles)).toEqual([]);
  });
});

describe("memory", () => {
  it("wakes wait at memory pressure 2 or above or with pulse at ORANGE or RED; pressure 1, no reading, GREEN, YELLOW or no pulse let them go", async () => {
    const h = harness();
    await h.gate.checkCompat();
    const wake = h.gate.wakeGate("wake");
    const table: Array<[number | undefined, string | undefined, string | undefined]> = [
      [1, undefined, undefined],
      [undefined, undefined, undefined],
      [2, undefined, "memory pressure 2"],
      [4, undefined, "memory pressure 4"],
      [1, "GREEN", undefined],
      [1, "YELLOW", undefined],
      [1, "ORANGE", "pulse ORANGE"],
      [undefined, "RED", "pulse RED"],
    ];
    for (const [pressure, pulse, reason] of table) {
      h.env.pressure = pressure;
      h.env.pulse = pulse;
      expect([pressure, pulse, (await wake.hold())?.reason]).toEqual([pressure, pulse, reason]);
    }
  });

  it("reads the pulse stage from its state file only where the pulse CLI is installed; a missing, unparsable or stale file is unknown", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "csm-gate-"));
    try {
      const state = path.join(home, ".claude", "state", "pulse", "state.json");
      fs.mkdirSync(path.dirname(state), { recursive: true });
      fs.writeFileSync(state, JSON.stringify({ v: 1, ts: NOW / 1000 - 30, stage: "ORANGE" }));
      expect(await readPulseStage(NOW, home)).toBeUndefined(); // no ~/.claude/bin/pulse: the file is not used
      fs.mkdirSync(path.join(home, ".claude", "bin"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "bin", "pulse"), "#!/bin/sh\n");
      expect(await readPulseStage(NOW, home)).toBe("ORANGE");
      fs.rmSync(state);
      expect(await readPulseStage(NOW, home)).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
    expect(pulseStageOf("{not json", NOW)).toBeUndefined();
    expect(pulseStageOf(JSON.stringify({ ts: NOW / 1000 }), NOW)).toBeUndefined();
    expect(pulseStageOf(JSON.stringify({ stage: "RED", ts: String(NOW / 1000) }), NOW)).toBeUndefined();
    expect(pulseStageOf(JSON.stringify({ stage: "RED", ts: NOW / 1000 - 121 }), NOW)).toBeUndefined(); // older than 2 minutes
    expect(pulseStageOf(JSON.stringify({ stage: "RED", ts: NOW / 1000 - 120 }), NOW)).toBe("RED");
  });

  it("right before a restore the switches and Claude Code hold; memory and the spent budget do not (a restore starts no process)", async () => {
    const h = harness();
    await h.gate.checkCompat();
    const wake = h.gate.wakeGate("wake");
    for (let i = 0; i < 3; i++) wake.spend();
    expect((await wake.admit())?.kind).toBe("budget");
    expect(await wake.beforeRestore()).toBeUndefined();
    h.env.pressure = 4;
    h.env.pulse = "RED";
    expect(await wake.beforeRestore()).toBeUndefined();
    h.env.features.delete("wake");
    expect(await wake.beforeRestore()).toEqual({ kind: "off", reason: "wakeDeadTabs is off" });
    h.env.features.add("wake");
    h.env.commands = [];
    await h.gate.checkCompat();
    expect(await wake.beforeRestore()).toEqual({ kind: "off", reason: MISSING });
  });
});

describe("spawn budget", () => {
  it("at most 3 wakes per 5 minutes per window, shared by the tab wakes and continuity", async () => {
    const h = harness();
    await h.gate.checkCompat();
    const wake = h.gate.wakeGate("wake");
    const continuity = h.gate.wakeGate("continuity");
    for (const g of [wake, continuity, wake]) {
      expect(await g.admit()).toBeUndefined();
      g.spend();
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(await continuity.admit()).toEqual({ kind: "budget", reason: "3 wakes in 5 min" });
    expect(await continuity.hold()).toEqual({ kind: "budget", reason: "3 wakes in 5 min" });
    await vi.advanceTimersByTimeAsync(270_000); // 5 minutes after the first wake
    expect(await wake.admit()).toBeUndefined();
  });

  it("each refusal in a row doubles the wait before the next try, from 30 s up to 10 min, without reading memory meanwhile; a wake resets it", async () => {
    const h = harness();
    await h.gate.checkCompat();
    const wake = h.gate.wakeGate("wake");
    h.env.pressure = 2;
    const held = { kind: "memory", reason: "memory pressure 2" };
    const waits = [30, 60, 120, 240, 480, 600, 600];
    for (const s of waits) {
      expect(await wake.admit()).toEqual(held);
      await vi.advanceTimersByTimeAsync(s * 1000 - 1);
      const reads = h.pressure.mock.calls.length;
      expect(await wake.admit()).toEqual(held); // still backing off
      expect(h.pressure.mock.calls.length).toBe(reads);
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(h.logs).toEqual(waits.map((s) => `gate: wake held back (memory pressure 2), next try in ${s} s`));
    h.env.pressure = 1;
    expect(await wake.admit()).toBeUndefined();
    wake.spend();
    h.env.pressure = 2;
    expect(await wake.admit()).toEqual(held);
    expect(h.logs[h.logs.length - 1]).toBe("gate: wake held back (memory pressure 2), next try in 30 s");
  });

  it("the tab waker behind the real gate: memory pressure 2 holds its wakes; it wakes 3 tabs in 5 minutes, then waits for the budget", async () => {
    const h = harness();
    await h.gate.checkCompat();
    h.env.pressure = 2;
    const live: LiveSession[] = [];
    const sids = ["a", "b", "c", "d", "e"];
    const store = new Map<string, unknown>([[REGISTRY_KEY, sids.map((sid) => ({ sid, title: `Limit-stopped ${sid}`, lastSeenMs: NOW - 3_600_000, missed: 2 }))]]);
    const woken: string[] = [];
    const logs: string[] = [];
    const waker = new TabWaker<string>({
      enabled: () => true,
      store: {
        get: <T>(key: string) => store.get(key) as T | undefined,
        update: (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
      log: (m) => {
        logs.push(m);
      },
      now: () => Date.now(),
      hostPid: 1,
      titleOf: () => undefined,
      liveSessions: () => live,
      parentPids: async () => new Map<number, number>(),
      limitStop: () => ({ ts: Date.now() / 1000 - 60, apiError: true, status: 429 }),
      idleMs: async () => 60_000,
      windowFocused: () => false,
      commandExists: async () => true,
      executeCommand: async (_id: string, ...args: unknown[]) => {
        woken.push(String(args[0]));
        live.push({ sessionId: String(args[0]), pid: 7, entrypoint: "claude-vscode" });
      },
      snapshotTabs: () => "editor",
      activeTab: () => "editor",
      activeClaudeLabel: () => undefined,
      restoreTabs: async () => undefined,
      claudeTabLabels: () => sids.map((sid) => `Limit-stopped ${sid}`),
      gate: h.gate.wakeGate("wake"),
    });
    waker.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(woken).toEqual([]);
    expect(logs).toContain("wake: postponed (memory pressure 2), 5 pending");
    h.env.pressure = 1;
    await vi.advanceTimersByTimeAsync(240_000); // t = 300 s
    expect(woken).toEqual(["a", "b", "c"]);
    expect(logs).toContain("wake: postponed (3 wakes in 5 min), 2 pending");
    await vi.advanceTimersByTimeAsync(120_000); // t = 420 s: the first wake is more than 5 minutes old
    expect(woken).toEqual(["a", "b", "c", "d"]);
    waker.dispose();
  });
});

describe("cancellation", () => {
  it("a configuration change that turns an automation or tab automation off aborts that automation's signal; other changes abort nothing", () => {
    const h = harness();
    const wake = h.gate.signal("wake");
    const continuity = h.gate.signal("continuity");
    const sweep = h.gate.signal("typingSweep");
    h.gate.configChanged((s) => s === "claudeSessionMonitor.pollIntervalMs");
    h.gate.configChanged((s) => s === "claudeSessionMonitor.wakeDeadTabs"); // still on
    expect([wake.aborted, continuity.aborted, sweep.aborted]).toEqual([false, false, false]);

    h.env.features.delete("wake");
    h.gate.configChanged((s) => s === "claudeSessionMonitor.wakeDeadTabs");
    expect([wake.aborted, wake.reason, continuity.aborted, sweep.aborted]).toEqual([true, "wakeDeadTabs is off", false, false]);
    const next = h.gate.signal("wake");
    expect(next.aborted).toBe(false); // a fresh signal for the next wake

    h.env.master = false;
    h.gate.configChanged((s) => s === "claudeSessionMonitor.tabAutomation");
    expect([next.aborted, continuity.aborted, sweep.aborted, sweep.reason]).toEqual([true, true, true, "tab automation is off"]);
    expect(h.logs).toEqual([
      "gate: wake turned off (wakeDeadTabs is off), its work in progress is cancelled",
      "gate: wake turned off (tab automation is off), its work in progress is cancelled",
      "gate: continuity turned off (tab automation is off), its work in progress is cancelled",
      "gate: typingSweep turned off (tab automation is off), its work in progress is cancelled",
    ]);
  });
});
