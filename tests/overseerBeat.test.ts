import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireSwitchLock } from "../src/accountSwitch";
import { HEALTH_VERSION, type WindowHealth } from "../src/health";
import { EMIT_GAP_MS, HEARTBEAT_EVERY, OverseerBeat, PRUNE_EVERY_MS, PRUNE_MS, TOOL_ID, liveWindows, overseerBin, pruneHealth, summarize, type BeatDeps } from "../src/overseerBeat";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const GONE_PID = 2_000_000_000; // above every platform's pid range: no process carries it
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function health(win: string, over: Partial<WindowHealth> = {}): WindowHealth {
  return {
    v: HEALTH_VERSION,
    win,
    pid: process.pid,
    version: "2.40.0",
    ts: NOW / 1000,
    features: { sessions: "ok", limits: "ok", remote: "disabled", autoResume: "ok", continuity: "disabled", wake: "ok", restartGuard: "ok" },
    refreshP95Ms: 12.5,
    refreshSamples: 120,
    guardArmed: true,
    ...over,
  };
}

/** The health file of a window that closed without removing it a day before `nowMs`. */
const gone = (win: string, nowMs: number): WindowHealth => health(win, { pid: GONE_PID, ts: (nowMs - PRUNE_MS) / 1000 - 1 });

interface Rig {
  deps: BeatDeps;
  runs: string[][];
  logs: string[];
  clock: { now: number };
  put(h: WindowHealth): void;
}

/** A window's BeatDeps on a real temp folder (real lock files); the CLI is recorded, not run. */
function rig(dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beat-")), exitText: (args: readonly string[]) => string | undefined = () => undefined): Rig {
  dirs.push(dir);
  const runs: string[][] = [];
  const logs: string[] = [];
  const clock = { now: NOW };
  const deps: BeatDeps = {
    dir,
    overseer: path.join(dir, "bin", "overseer"),
    shared: () => true,
    nowMs: () => clock.now,
    exists: (f) => f === path.join(dir, "bin", "overseer"),
    list: (d) => fs.readdirSync(d),
    read: (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : undefined),
    write: (f, text) => fs.writeFileSync(f, text),
    remove: (f) => fs.rmSync(f, { force: true }),
    alive: (pid) => pid !== GONE_PID,
    lock: (f) => acquireSwitchLock(f),
    run: async (_file, args) => {
      runs.push([...args]);
      return exitText(args);
    },
    log: (m) => void logs.push(m),
  };
  return { deps, runs, logs, clock, put: (h) => fs.writeFileSync(path.join(dir, `${h.win}.json`), JSON.stringify(h)) };
}

const lastArg = (args: string[]): string => args[args.length - 1];
const dataOf = (args: string[]): any => JSON.parse(args[args.indexOf("--data") + 1]);

describe("summarize", () => {
  it("one line for all live windows: count, versions, failing features, armed guards and the slowest p95", () => {
    const s = summarize([
      health("aaaaaaaaaaaaaaaa"),
      health("bbbbbbbbbbbbbbbb", { version: "2.39.0", guardArmed: false, refreshP95Ms: 31.2, features: { sessions: "ok", continuity: "error", wake: "error" } }),
    ]);
    expect(s.text).toBe("2 windows on 2.39.0, 2.40.0; features in error: continuity, wake; restart guard armed in 1 of 2; refresh p95 31 ms");
    expect(s.level).toBe("warn");
    expect(s.data.windows[1]).toEqual({ win: "bbbbbbbbbbbbbbbb", version: "2.39.0", refreshP95Ms: 31.2, guardArmed: false, failing: ["continuity", "wake"] });
  });

  it("one window without refreshes yet", () => {
    const s = summarize([health("aaaaaaaaaaaaaaaa", { refreshP95Ms: null })]);
    expect(s.text).toBe("1 window on 2.40.0; features in error: none; restart guard armed in 1 of 1; refresh p95 -");
    expect(s.level).toBe("info");
  });
});

/** Live, dead, stale and day-old health files, next to files that are no window's. */
function putMixed(r: Rig): void {
  r.put(health("aaaaaaaaaaaaaaaa"));
  r.put(health(`empty-${process.pid}`, { ts: NOW / 1000 - 60 }));
  r.put(health("cccccccccccccccc", { pid: GONE_PID })); // its window closed without removing the file
  r.put(health("dddddddddddddddd", { ts: NOW / 1000 - 120 })); // not written for 2 minutes
  r.put(health("eeeeeeeeeeeeeeee", { ts: (NOW - PRUNE_MS) / 1000 - 1 }));
  r.put(gone(`empty-${GONE_PID}`, NOW)); // a window without a folder that crashed
  fs.writeFileSync(path.join(r.deps.dir, "errors.json"), "{}");
  fs.writeFileSync(path.join(r.deps.dir, "ffffffffffffffff.json"), "not json");
}

describe("liveWindows", () => {
  it("reads the fresh files of live pids, skips the stale, dead and foreign ones, and removes none", () => {
    const r = rig();
    putMixed(r);
    const files = fs.readdirSync(r.deps.dir).sort();
    expect(liveWindows(r.deps, NOW).map((w) => w.win)).toEqual(["aaaaaaaaaaaaaaaa", `empty-${process.pid}`]);
    expect(fs.readdirSync(r.deps.dir).sort()).toEqual(files);
  });
});

describe("pruneHealth", () => {
  it("removes the health files of windows gone for a day and keeps every other file", () => {
    const r = rig();
    putMixed(r);
    pruneHealth(r.deps, NOW);
    expect(fs.readdirSync(r.deps.dir).sort()).toEqual(
      ["aaaaaaaaaaaaaaaa.json", "cccccccccccccccc.json", "dddddddddddddddd.json", `empty-${process.pid}.json`, "errors.json", "ffffffffffffffff.json"].sort(),
    );
  });
});

describe("OverseerBeat", () => {
  it("observer mode takes no lock, writes no state, emits nothing and removes no file", async () => {
    const r = rig();
    r.deps.shared = () => false;
    r.put(health("aaaaaaaaaaaaaaaa"));
    r.put(gone("eeeeeeeeeeeeeeee", NOW));
    expect(await new OverseerBeat(r.deps).tick()).toBe("observer mode");
    expect(r.runs).toEqual([]);
    expect(fs.readdirSync(r.deps.dir).sort()).toEqual(["aaaaaaaaaaaaaaaa.json", "eeeeeeeeeeeeeeee.json"]);
  });

  it("where overseer is not installed it sends nothing but still removes the health files of windows gone for a day", async () => {
    const r = rig();
    r.deps.exists = () => false;
    r.put(health("aaaaaaaaaaaaaaaa"));
    r.put(gone(`empty-${GONE_PID}`, NOW)); // a window without a folder that crashed: every such crash leaves a new file
    expect(await new OverseerBeat(r.deps).tick()).toBe("no overseer");
    expect(r.runs).toEqual([]);
    expect(fs.readdirSync(r.deps.dir)).toEqual(["aaaaaaaaaaaaaaaa.json"]);
  });

  it("looks for health files to remove at most once an hour, and at once after the clock was set back", async () => {
    const r = rig();
    r.deps.exists = () => false;
    const beat = new OverseerBeat(r.deps);
    const day = path.join(r.deps.dir, "eeeeeeeeeeeeeeee.json");
    await beat.tick(); // the first beat looks
    r.clock.now += 30_000;
    r.put(gone("eeeeeeeeeeeeeeee", r.clock.now));
    await beat.tick();
    expect(fs.existsSync(day)).toBe(true); // within the hour: not looked for again
    r.clock.now += PRUNE_EVERY_MS;
    await beat.tick();
    expect(fs.existsSync(day)).toBe(false);
    r.clock.now -= 3 * PRUNE_EVERY_MS; // the clock set back
    r.put(gone("eeeeeeeeeeeeeeee", r.clock.now));
    await beat.tick();
    expect(fs.existsSync(day)).toBe(false);
  });

  it("sends one heartbeat summarizing all live windows through overseer emit, then an action line for the new state", async () => {
    const r = rig();
    r.put(health("aaaaaaaaaaaaaaaa"));
    r.put(health("bbbbbbbbbbbbbbbb", { guardArmed: false }));
    expect(await new OverseerBeat(r.deps).tick()).toBe("emitted");
    const text = "2 windows on 2.40.0; features in error: none; restart guard armed in 1 of 2; refresh p95 13 ms";
    expect(r.runs).toHaveLength(2);
    expect(r.runs[0].slice(0, 7)).toEqual(["emit", "--tool", TOOL_ID, "--heartbeat", "--every", HEARTBEAT_EVERY, "--data"]);
    expect(lastArg(r.runs[0])).toBe(text);
    expect(dataOf(r.runs[0]).windows.map((w: any) => w.win)).toEqual(["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"]);
    expect(r.runs[1].slice(0, 5)).toEqual(["emit", "--tool", TOOL_ID, "--level", "info"]);
    expect(lastArg(r.runs[1])).toBe(text);
    expect(TOOL_ID).toBe("session-monitor");
    expect(fs.existsSync(path.join(r.deps.dir, "emit.lock"))).toBe(false);
  });

  it("at most one emit per 60 s across windows: the window that finds the last emit older sends the next", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-beat-"));
    const a = rig(dir);
    const b = rig(dir);
    a.put(health("aaaaaaaaaaaaaaaa"));
    b.put(health("bbbbbbbbbbbbbbbb"));
    const beatA = new OverseerBeat(a.deps);
    const beatB = new OverseerBeat(b.deps);
    expect(await beatA.tick()).toBe("emitted");
    b.clock.now = NOW + 30_000;
    expect(await beatB.tick()).toBe("recent");
    a.clock.now = NOW + 30_000;
    expect(await beatA.tick()).toBe("recent");
    b.clock.now = NOW + EMIT_GAP_MS;
    expect(await beatB.tick()).toBe("emitted");
    expect(a.runs.filter((x) => x.includes("--heartbeat"))).toHaveLength(1);
    expect(b.runs.filter((x) => x.includes("--heartbeat"))).toHaveLength(1);
    expect(b.runs.filter((x) => !x.includes("--heartbeat"))).toHaveLength(0); // same state: no second action line
  });

  it("one emitter: a live holder of the emitter lock makes the others skip, a dead holder's lock is taken over", async () => {
    const r = rig();
    r.put(health("aaaaaaaaaaaaaaaa"));
    fs.writeFileSync(path.join(r.deps.dir, "emit.lock"), `${process.pid} ${Date.now()} other-window`);
    expect(await new OverseerBeat(r.deps).tick()).toBe("busy");
    expect(r.runs).toEqual([]);
    fs.writeFileSync(path.join(r.deps.dir, "emit.lock"), `${GONE_PID} ${Date.now()} gone-window`);
    expect(await new OverseerBeat(r.deps).tick()).toBe("emitted");
    expect(r.runs.length).toBeGreaterThan(0);
  });

  it("an action line only when the state changes, warn while a feature is in error", async () => {
    const r = rig();
    const beat = new OverseerBeat(r.deps);
    r.put(health("aaaaaaaaaaaaaaaa"));
    await beat.tick();
    r.clock.now += EMIT_GAP_MS;
    r.put(health("aaaaaaaaaaaaaaaa", { ts: r.clock.now / 1000, refreshP95Ms: 40 })); // p95 alone is no new state
    await beat.tick();
    r.clock.now += EMIT_GAP_MS;
    r.put(health("aaaaaaaaaaaaaaaa", { ts: r.clock.now / 1000, features: { sessions: "ok", continuity: "error" } }));
    await beat.tick();
    const actions = r.runs.filter((x) => !x.includes("--heartbeat"));
    expect(actions.map((x) => x[4])).toEqual(["info", "warn"]);
    expect(lastArg(actions[1])).toContain("features in error: continuity");
    expect(r.runs.filter((x) => x.includes("--heartbeat"))).toHaveLength(3);
  });

  it("an action line that did not reach overseer is sent again with the next emit", async () => {
    let actionFails = true;
    const r = rig(undefined, (args) => (actionFails && !args.includes("--heartbeat") ? "inbox session-monitor.jsonl is locked" : undefined));
    const beat = new OverseerBeat(r.deps);
    r.put(health("aaaaaaaaaaaaaaaa"));
    expect(await beat.tick()).toBe("failed");
    actionFails = false;
    for (let i = 0; i < 2; i++) {
      r.clock.now += EMIT_GAP_MS;
      r.put(health("aaaaaaaaaaaaaaaa", { ts: r.clock.now / 1000 }));
      expect(await beat.tick()).toBe("emitted");
    }
    expect(r.runs.filter((x) => !x.includes("--heartbeat"))).toHaveLength(2); // the failed one and its resend, then none for the same state
  });

  it("a failing emit is logged once per reason and still counts as the minute's emit", async () => {
    let reason = "inbox session-monitor.jsonl is full";
    const r = rig(undefined, () => reason);
    const beat = new OverseerBeat(r.deps);
    r.put(health("aaaaaaaaaaaaaaaa"));
    expect(await beat.tick()).toBe("failed");
    r.clock.now += EMIT_GAP_MS;
    r.put(health("aaaaaaaaaaaaaaaa", { ts: r.clock.now / 1000 }));
    expect(await beat.tick()).toBe("failed"); // the action line sent again, failing for the same reason
    r.clock.now += EMIT_GAP_MS;
    r.put(health("aaaaaaaaaaaaaaaa", { ts: r.clock.now / 1000 }));
    reason = "overseer: permission denied";
    expect(await beat.tick()).toBe("failed");
    expect(r.logs).toEqual([
      "overseer: emit failed (heartbeat: inbox session-monitor.jsonl is full; action: inbox session-monitor.jsonl is full); repeats are not logged",
      "overseer: emit failed (heartbeat: overseer: permission denied; action: overseer: permission denied); repeats are not logged",
    ]);
    r.clock.now += 10_000;
    expect(await beat.tick()).toBe("recent");
  });

  it("a clock set back does not hold the emits until it passes the last one again", async () => {
    const r = rig();
    r.put(health("aaaaaaaaaaaaaaaa"));
    fs.writeFileSync(path.join(r.deps.dir, "emit.json"), JSON.stringify({ ts: NOW + 3600_000, sig: "" })); // sent before the clock went back an hour
    const beat = new OverseerBeat(r.deps);
    expect(await beat.tick()).toBe("emitted");
    r.clock.now += 30_000;
    expect(await beat.tick()).toBe("recent");
  });

  it("finds overseer in ~/.claude/bin", () => {
    expect(overseerBin("/home/u")).toBe("/home/u/.claude/bin/overseer");
  });
});
