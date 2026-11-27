import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  config: new Map<string, unknown>(),
  warnings: [] as any[][],
  executed: [] as string[],
}));

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => env.config.get(key) }),
  },
  window: {
    showWarningMessage: async (...args: any[]) => {
      env.warnings.push(args);
      return undefined;
    },
  },
  commands: {
    executeCommand: async (id: string) => {
      env.executed.push(id);
    },
  },
}));

import {
  COUNTDOWN_MS,
  DailyReloader,
  NOT_NOW,
  QUIET_MS,
  RELOAD_COMMAND,
  SNOOZE_MS,
  TICK_MS,
  activateDailyReload,
  decide,
  inFlight,
  readReloadSettings,
  type DecisionInput,
} from "../src/dailyReload";
import { readLiveSessions } from "../src/wakeTabs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const H = 3_600_000;
const MIN = 60_000;

const CALM: DecisionInput = {
  enabled: true,
  uptimeMs: 21 * H,
  afterMs: 20 * H,
  snoozedUntil: 0,
  nowMs: 1_000_000,
  working: 0,
  quietMs: QUIET_MS,
  busy: false,
  idleMs: 7 * MIN,
  idleMinMs: 5 * MIN,
};

describe("decide", () => {
  it("reloads only when every condition holds", () => {
    expect(decide(CALM)).toEqual({ action: "reload", detail: "up 21.0 h, idle 7 min, 0 working" });
  });

  it.each([
    ["off", { enabled: false }],
    ["young", { uptimeMs: 20 * H - 1 }],
    ["snoozed", { snoozedUntil: CALM.nowMs + 1 }],
    ["busy", { busy: true }],
    ["busy", { working: 2 }],
    ["busy", { quietMs: QUIET_MS - 1 }],
    ["user-active", { idleMs: 5 * MIN - 1 }],
    ["idle-unknown", { idleMs: undefined }],
  ] as const)("%s for %o", (action, over) => {
    expect(decide({ ...CALM, ...over }).action).toBe(action);
  });

  it("checks the clocks before the sessions: a young window is young whatever runs", () => {
    expect(decide({ ...CALM, uptimeMs: 0, working: 3, busy: true, idleMs: undefined }).action).toBe("young");
  });

  it("an idle minimum of 0 accepts any readable idle time, never an unreadable one", () => {
    expect(decide({ ...CALM, idleMinMs: 0, idleMs: 0 }).action).toBe("reload");
    expect(decide({ ...CALM, idleMinMs: 0, idleMs: undefined }).action).toBe("idle-unknown");
  });

  it("says why it waits", () => {
    expect(decide({ ...CALM, working: 2 }).detail).toBe("due, waiting (2 working)");
    expect(decide({ ...CALM, idleMs: 60_000 }).detail).toBe("due, waiting (input 1 min ago, needs 5 min)");
  });
});

describe("readReloadSettings", () => {
  it("takes the defaults for missing or broken values and keeps the minimums", () => {
    expect(readReloadSettings(() => undefined)).toEqual({ enabled: false, afterHours: 20, idleMinutes: 5 });
    const set: Record<string, unknown> = { dailyReload: true, dailyReloadAfterHours: 0, dailyReloadIdleMinutes: -3 };
    expect(readReloadSettings((k) => set[k])).toEqual({ enabled: true, afterHours: 0.01, idleMinutes: 0 });
    const broken: Record<string, unknown> = { dailyReload: "yes", dailyReloadAfterHours: NaN };
    expect(readReloadSettings((k) => broken[k])).toEqual({ enabled: false, afterHours: 20, idleMinutes: 5 });
  });
});

/** A reloader on fake deps; `st` is read on every check. */
function harness() {
  const st = {
    enabled: true,
    afterHours: 20,
    idleMinutes: 5,
    upAtStart: 21 * H + 10 * MIN,
    working: 0,
    idle: 10 * MIN as number | undefined,
    busy: false,
    choice: undefined as string | undefined,
  };
  const logs: string[] = [];
  const warnings: string[] = [];
  let reloads = 0;
  const t0 = Date.now();
  const reloader = new DailyReloader({
    log: (m) => logs.push(m),
    idleMs: async () => st.idle,
    working: async () => st.working,
    busy: () => st.busy,
    settings: () => ({ enabled: st.enabled, afterHours: st.afterHours, idleMinutes: st.idleMinutes }),
    uptimeMs: () => st.upAtStart + Date.now() - t0,
    now: () => Date.now(),
    warn: async (text, button) => {
      warnings.push(`${text} [${button}]`);
      return st.choice;
    },
    reload: async () => {
      reloads++;
    },
  });
  reloader.start();
  return { st, logs, warnings, reloads: () => reloads, reloader };
}

describe("DailyReloader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("when calm: the notice after 2 quiet minutes, the reload 20 s later, exactly once", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(3 * TICK_MS); // ticks at 1, 2 and 3 min: quiet from the first, due at the third
    expect(h.warnings).toEqual(["Agent Session Monitor will reload this window in 20 s (daily reload, open 21.2 h). [Not now]"]);
    expect(h.reloads()).toBe(0);
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(h.reloads()).toBe(1);
    expect(h.logs.at(-1)).toMatch(/^daily reload: reloading window \(up 21\.2 h, idle 10 min, 0 working\)$/);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(h.reloads()).toBe(1);
    expect(h.warnings).toHaveLength(1);
    h.reloader.dispose();
  });

  it.each([
    ["disabled", (st: ReturnType<typeof harness>["st"]) => (st.enabled = false)],
    ["young", (st: ReturnType<typeof harness>["st"]) => (st.upAtStart = 0)],
    ["a session working", (st: ReturnType<typeof harness>["st"]) => (st.working = 1)],
    ["the user active", (st: ReturnType<typeof harness>["st"]) => (st.idle = 30_000)],
    ["idle unknown", (st: ReturnType<typeof harness>["st"]) => (st.idle = undefined)],
    ["the extension busy", (st: ReturnType<typeof harness>["st"]) => (st.busy = true)],
  ])("never reloads with %s", async (_name, set) => {
    const h = harness();
    set(h.st);
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(h.warnings).toEqual([]);
    expect(h.reloads()).toBe(0);
    h.reloader.dispose();
  });

  it("waits for 2 quiet minutes after the last working session", async () => {
    const h = harness();
    h.st.working = 2;
    await vi.advanceTimersByTimeAsync(2.5 * TICK_MS);
    h.st.working = 0; // seen 0 first at the 3 min tick
    await vi.advanceTimersByTimeAsync(2 * TICK_MS); // up to 4.5 min: quiet for 2 min only at 5
    expect(h.warnings).toEqual([]);
    await vi.advanceTimersByTimeAsync(0.5 * TICK_MS + COUNTDOWN_MS);
    expect(h.reloads()).toBe(1);
    h.reloader.dispose();
  });

  it("logs a decision only when its action changes", async () => {
    const h = harness();
    h.st.working = 2;
    await vi.advanceTimersByTimeAsync(10 * TICK_MS);
    expect(h.logs).toEqual(["daily reload: due, waiting (2 working)"]);
    h.reloader.dispose();
  });

  it("Not now snoozes for 60 minutes", async () => {
    const h = harness();
    h.st.choice = NOT_NOW;
    await vi.advanceTimersByTimeAsync(3 * TICK_MS + COUNTDOWN_MS);
    expect(h.reloads()).toBe(0);
    expect(h.logs).toContain("daily reload: not now, snoozed for 60 min");
    h.st.choice = undefined;
    await vi.advanceTimersByTimeAsync(SNOOZE_MS - COUNTDOWN_MS - TICK_MS);
    expect(h.warnings).toHaveLength(1);
    expect(h.reloads()).toBe(0);
    await vi.advanceTimersByTimeAsync(4 * TICK_MS + COUNTDOWN_MS); // the snooze ends, then 2 quiet minutes again
    expect(h.warnings).toHaveLength(2);
    expect(h.reloads()).toBe(1);
    h.reloader.dispose();
  });

  it("a session that starts working during the countdown cancels the reload", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(3 * TICK_MS);
    expect(h.warnings).toHaveLength(1);
    h.st.working = 1;
    await vi.advanceTimersByTimeAsync(COUNTDOWN_MS);
    expect(h.reloads()).toBe(0);
    expect(h.logs.at(-1)).toBe("daily reload: due, waiting (1 working)");
    h.reloader.dispose();
  });

  it("dispose stops a countdown in progress", async () => {
    const h = harness();
    await vi.advanceTimersByTimeAsync(3 * TICK_MS);
    h.reloader.dispose();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(h.reloads()).toBe(0);
  });
});

describe("activateDailyReload", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    env.config.clear();
    env.warnings.length = 0;
    env.executed.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const start = () => {
    const ctx = { subscriptions: [] as { dispose(): void }[] };
    activateDailyReload(ctx as any, { log: () => {}, idleMs: async () => 0, working: async () => 0, busy: () => false });
    return ctx;
  };

  it("off by default: no notice and no reload", async () => {
    const ctx = start();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(env.warnings).toEqual([]);
    expect(env.executed).toEqual([]);
    for (const d of ctx.subscriptions) d.dispose();
  });

  it("on: warns with a Not now button, then runs Reload Window; dispose stops the checks", async () => {
    vi.spyOn(process, "uptime").mockReturnValue(3600);
    env.config.set("dailyReload", true);
    env.config.set("dailyReloadAfterHours", 0.5);
    env.config.set("dailyReloadIdleMinutes", 0);
    const ctx = start();
    expect(ctx.subscriptions).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3 * TICK_MS + COUNTDOWN_MS);
    expect(env.warnings).toEqual([["Agent Session Monitor will reload this window in 20 s (daily reload, open 1.0 h).", NOT_NOW]]);
    expect(env.executed).toEqual([RELOAD_COMMAND]);
    for (const d of ctx.subscriptions) d.dispose();
    await vi.advanceTimersByTimeAsync(3 * H);
    expect(env.executed).toEqual([RELOAD_COMMAND]);
  });
});

describe("inFlight", () => {
  it("counts a session Claude Code calls busy although the panel shows its turn as over (background agents)", () => {
    expect(inFlight([{ sessionId: "a", status: "busy" }], [], new Set(["a"]))).toBe(1);
  });

  it("does not count a session Claude Code calls idle although the panel still shows it working", () => {
    expect(inFlight([{ sessionId: "a", status: "idle" }], ["a"], new Set(["a"]))).toBe(0);
  });

  it("falls back to the panel's working group for a session without a status", () => {
    expect(inFlight([{ sessionId: "a" }, { sessionId: "b" }], ["a"], new Set(["a", "b"]))).toBe(1);
    expect(inFlight([], ["c"], new Set(["c"]))).toBe(1);
  });

  it("leaves other windows' sessions out, and counts every session when ownership is unreadable", () => {
    const live = [{ sessionId: "mine", status: "busy" }, { sessionId: "theirs", status: "busy" }];
    expect(inFlight(live, ["theirs"], new Set(["mine"]))).toBe(1);
    expect(inFlight(live, [], undefined)).toBe(2);
  });
});

describe("readLiveSessions", () => {
  it("carries the status Claude Code records for a session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-live-"));
    try {
      fs.writeFileSync(path.join(dir, "11.json"), JSON.stringify({ pid: 11, sessionId: "busy-one", status: "busy" }));
      fs.writeFileSync(path.join(dir, "12.json"), JSON.stringify({ pid: 12, sessionId: "old-cli" }));
      expect(readLiveSessions(dir, () => true).map((s) => [s.sessionId, s.status])).toEqual([["busy-one", "busy"], ["old-cli", undefined]]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
