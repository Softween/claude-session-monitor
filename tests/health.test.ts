import { describe, expect, it } from "vitest";
import {
  DurationRing,
  FEATURES,
  HEALTH_EVERY_MS,
  RECENT_FAIL_MS,
  buildHealth,
  featureStatuses,
  healthFile,
  parseHealth,
  removeHealth,
  timed,
  writeHealth,
  type HealthDeps,
} from "../src/health";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const ALL_ON = Object.fromEntries(Object.keys(FEATURES).map((f) => [f, true]));

describe("DurationRing", () => {
  it("has no p95 before the first sample, then the nearest-rank 95th percentile", () => {
    const ring = new DurationRing(200);
    expect(ring.p95()).toBeNull();
    for (let ms = 1; ms <= 100; ms++) ring.add(ms);
    expect(ring.p95()).toBe(95);
    expect(ring.count).toBe(100);
  });

  it("keeps only the last `size` durations", () => {
    const ring = new DurationRing(3);
    for (const ms of [500, 1, 2, 3]) ring.add(ms);
    expect(ring.count).toBe(3);
    expect(ring.p95()).toBe(3); // the 500 ms refresh fell out
  });

  it("timed() adds the duration of a call, a throwing one too", () => {
    const ring = new DurationRing(10);
    let t = 100;
    const clock = (): number => t;
    timed(ring, () => (t += 7), clock);
    expect(() =>
      timed(
        ring,
        () => {
          t += 3;
          throw new Error("refresh broke");
        },
        clock,
      ),
    ).toThrow("refresh broke");
    expect(ring.count).toBe(2);
    expect(ring.p95()).toBe(7);
  });
});

describe("featureStatuses", () => {
  it("names every feature of the stage guard: ok when on, disabled when off", () => {
    expect(featureStatuses({ ...ALL_ON, remote: false, wake: false }, new Map(), NOW)).toEqual({
      sessions: "ok",
      limits: "ok",
      remote: "disabled",
      autoResume: "ok",
      continuity: "ok",
      wake: "disabled",
      restartGuard: "ok",
    });
  });

  it("error while a refresh stage of the feature failed within the last minute, a detailed stage name included", () => {
    const failures = new Map([
      ["continuity", NOW - 5_000],
      ["collect 1a2b3c4d-0000-4000-8000-000000000000", NOW - 30_000],
      ["limits", NOW - RECENT_FAIL_MS - 1], // an old failure: ok again
    ]);
    const out = featureStatuses(ALL_ON, failures, NOW);
    expect(out).toMatchObject({ continuity: "error", sessions: "error", limits: "ok", wake: "ok" });
  });

  it("error for good once the feature's start failed, even while its setting is off", () => {
    const failures = new Map([["tab wake start", NOW - 3_600_000]]);
    expect(featureStatuses({ ...ALL_ON, wake: false }, failures, NOW).wake).toBe("error");
  });

  it("a failing stage of a feature that is off leaves it disabled", () => {
    expect(featureStatuses({ ...ALL_ON, autoResume: false }, new Map([["auto-resume", NOW]]), NOW).autoResume).toBe("disabled");
  });
});

describe("the health file", () => {
  function deps(over: Partial<HealthDeps> = {}): HealthDeps & { files: Map<string, string> } {
    const files = new Map<string, string>();
    const refresh = new DurationRing();
    for (const ms of [4, 6, 9]) refresh.add(ms);
    return {
      files,
      dir: "/home/u/.claude/session-monitor/health",
      win: "c7464c24ed54e168",
      pid: 4242,
      version: "2.40.0",
      nowMs: () => NOW,
      enabled: () => ({ ...ALL_ON, remote: false }),
      failures: () => new Map([["tab wake", NOW - 1_000]]),
      refresh,
      guardArmed: () => true,
      shared: () => true,
      write: (file, text) => void files.set(file, text),
      remove: (file) => void files.delete(file),
      ...over,
    };
  }

  it("is written as <dir>/<window key>.json with the version, each feature's status, the refresh p95 and the guard state", () => {
    const d = deps();
    writeHealth(d);
    const file = "/home/u/.claude/session-monitor/health/c7464c24ed54e168.json";
    expect(healthFile(d.dir, d.win)).toBe(file);
    expect(JSON.parse(d.files.get(file)!)).toEqual({
      v: 1,
      win: "c7464c24ed54e168",
      pid: 4242,
      version: "2.40.0",
      ts: NOW / 1000,
      features: { sessions: "ok", limits: "ok", remote: "disabled", autoResume: "ok", continuity: "ok", wake: "error", restartGuard: "ok" },
      refreshP95Ms: 9,
      refreshSamples: 3,
      guardArmed: true,
    });
    expect(HEALTH_EVERY_MS).toBe(30_000);
  });

  it("has a null p95 before the first refresh, and is removed when the window closes", () => {
    const d = deps({ refresh: new DurationRing(), guardArmed: () => false });
    expect(buildHealth(d)).toMatchObject({ refreshP95Ms: null, refreshSamples: 0, guardArmed: false });
    writeHealth(d);
    removeHealth(d);
    expect(d.files.size).toBe(0);
  });

  it("observer mode neither writes nor removes it", () => {
    const d = deps({ shared: () => false });
    d.files.set(healthFile(d.dir, d.win), "from before");
    expect(writeHealth(d).version).toBe("2.40.0");
    removeHealth(d);
    expect([...d.files.values()]).toEqual(["from before"]);
  });

  it("parseHealth takes back what writeHealth wrote and nothing else", () => {
    const d = deps();
    writeHealth(d);
    const text = [...d.files.values()][0];
    expect(parseHealth(text)).toEqual(JSON.parse(text));
    expect(parseHealth(undefined)).toBeUndefined();
    expect(parseHealth("not json")).toBeUndefined();
    expect(parseHealth(JSON.stringify({ ...JSON.parse(text), v: 2 }))).toBeUndefined();
    expect(parseHealth(JSON.stringify({ ...JSON.parse(text), features: { wake: "broken" } }))).toBeUndefined();
  });

  it("lists the sessions the window holds while its remote bridge runs, and parseHealth checks that list", () => {
    expect("holds" in buildHealth(deps())).toBe(false);
    expect("holds" in buildHealth(deps({ holds: () => undefined }))).toBe(false); // the bridge is off
    const d = deps({ holds: () => ["s1", "s2"] });
    writeHealth(d);
    const text = [...d.files.values()][0];
    expect(parseHealth(text)?.holds).toEqual(["s1", "s2"]);
    expect(parseHealth(JSON.stringify({ ...JSON.parse(text), holds: [] }))?.holds).toEqual([]);
    expect(parseHealth(JSON.stringify({ ...JSON.parse(text), holds: "s1" }))).toBeUndefined();
    expect(parseHealth(JSON.stringify({ ...JSON.parse(text), holds: ["s1", 2] }))).toBeUndefined();
  });
});
