import { describe, expect, it } from "vitest";
import { DROP_COUNT, DROP_WINDOW_MS, SUMMARY_EVERY_SEC, SessionDrops, liveKeys, sessionSummary } from "../src/sessionLog";

const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const SCOPE = '[["claude"],false]';
const key = (i: number): string => `claude:${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
const keys = (from: number, to: number): string[] => Array.from({ length: to - from }, (_, i) => key(from + i));

describe("SessionDrops", () => {
  it("logs one event when 5 live sessions are gone within 60 s, and nothing for 4", () => {
    const four = new SessionDrops();
    four.observe(keys(0, 20), SCOPE, T0);
    expect(four.observe(keys(4, 20), SCOPE, T0 + 1_500)).toBeUndefined();

    const five = new SessionDrops();
    five.observe(keys(0, 20), SCOPE, T0);
    expect(five.observe(keys(2, 20), SCOPE, T0 + 10_000)).toBeUndefined();
    expect(five.observe(keys(5, 20), SCOPE, T0 + 50_000)).toBe(
      "sessions: 5 live sessions gone within 60 s, 15 still live (00000000 00000001 00000002 00000003 00000004)",
    );
  });

  it("a wave of 14 within 21 s logs exactly one event", () => {
    const drops = new SessionDrops();
    drops.observe(keys(0, 20), SCOPE, T0);
    const events: string[] = [];
    for (let n = 1; n <= 14; n++) {
      const line = drops.observe(keys(n, 20), SCOPE, T0 + n * 1_500);
      if (line) events.push(line);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatch(/^sessions: 5 live sessions gone within 60 s, 15 still live/);
  });

  it("5 sessions gone over more than 60 s log nothing", () => {
    const drops = new SessionDrops();
    drops.observe(keys(0, 10), SCOPE, T0);
    const lines = [1, 2, 3, 4, 5].map((n) => drops.observe(keys(n, 10), SCOPE, T0 + n * 16_000));
    expect(lines.every((l) => l === undefined)).toBe(true);
  });

  it("a session that comes back is no longer counted as gone", () => {
    const drops = new SessionDrops();
    drops.observe(keys(0, 10), SCOPE, T0);
    drops.observe(keys(4, 10), SCOPE, T0 + 1_000); // 4 gone
    drops.observe(keys(0, 10), SCOPE, T0 + 2_000); // all back
    expect(drops.observe([...keys(0, 9)], SCOPE, T0 + 3_000)).toBeUndefined(); // 1 gone
  });

  it("after a quiet minute a new wave logs again", () => {
    const drops = new SessionDrops();
    drops.observe(keys(0, 30), SCOPE, T0);
    expect(drops.observe(keys(6, 30), SCOPE, T0 + 1_000)).toMatch(/^sessions: 6 live/);
    expect(drops.observe(keys(6, 30), SCOPE, T0 + 1_000 + DROP_WINDOW_MS)).toBeUndefined(); // the wave aged out
    expect(drops.observe(keys(12, 30), SCOPE, T0 + 2_000 + DROP_WINDOW_MS)).toMatch(/^sessions: 6 live/);
  });

  it("a new scope (filter, provider set, a failed collect) starts over without an event", () => {
    const drops = new SessionDrops();
    expect(drops.observe(keys(0, 20), SCOPE, T0)).toBeUndefined(); // the first list only sets the baseline
    expect(drops.observe(keys(0, 3), '[["claude"],"/repo"]', T0 + 1_000)).toBeUndefined();
    expect(drops.observe([], "collect failed", T0 + 2_000)).toBeUndefined();
    expect(drops.observe(keys(0, 20), SCOPE, T0 + 3_000)).toBeUndefined();
    expect(drops.observe(keys(DROP_COUNT, 20), SCOPE, T0 + 4_000)).toMatch(/^sessions: 5 live/);
  });
});

describe("liveKeys and sessionSummary", () => {
  const views = [
    { key: key(1), provider: "claude", bucket: "working" },
    { key: key(2), provider: "claude", bucket: "ended" },
    { key: "codex:abc", provider: "codex", bucket: "attention" },
  ] as any[];

  it("live sessions are the ones not ended", () => {
    expect(liveKeys(views)).toEqual([key(1), "codex:abc"]);
  });

  it("the summary carries the counts the 20 s line had, every 5 minutes", () => {
    expect(sessionSummary(views, 2)).toBe(
      'sessions=3 {"limited":0,"attention":1,"working":1,"ended":1,"unknown":0} providers={"all":3,"claude":2,"codex":1} dismissed=2',
    );
    expect(SUMMARY_EVERY_SEC).toBe(300);
  });
});
