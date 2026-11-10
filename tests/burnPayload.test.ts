import { describe, it, expect } from "vitest";
import {
  BURN_WINDOWS,
  SOLID_DELTA_PCT,
  buildBurnPayload,
  burnShares,
  gaugeSamplesFromHistory,
  resolveScale,
  type BurnLookup,
  type ResolvedScale,
} from "../src/burnPayload";
import type { BurnScale, BurnSessionStat, BurnSummary } from "../src/burn";
import type { RawLimits } from "../src/core";

// --- helpers ----------------------------------------------------------------

const NOW = Date.parse("2026-11-10T12:00:00.000Z");

function stat(over: Partial<BurnSessionStat> = {}): BurnSessionStat {
  return {
    sessionId: "s1",
    cost: 1,
    share: 1,
    ratePerHour: 0,
    requests: 1,
    subShare: 0,
    cacheWriteShare: 0,
    avgContext: 0,
    models: ["opus-5-5"],
    lastTs: NOW - 600_000,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    ...over,
  };
}

function summary(sessions: BurnSessionStat[], over: Partial<BurnSummary> = {}): BurnSummary {
  return {
    windowMs: 15 * 60_000,
    totalCost: sessions.reduce((sum, s) => sum + s.cost, 0),
    totalRatePerHour: sessions.reduce((sum, s) => sum + s.ratePerHour, 0),
    sessions,
    ...over,
  };
}

const lookup = (id: string): BurnLookup => ({ title: `title ${id}`, openId: `row-${id}`, ended: id === "gone" });

const measured = (ptsPerUsd: number, over: Partial<ResolvedScale> = {}): ResolvedScale => ({
  ptsPerUsd,
  acct: "acct-a",
  cached: false,
  spanMs: 600_000,
  deltaPct: 6,
  ...over,
});

const build = (s: BurnSummary, scale: ResolvedScale | null = null, sessionPct: number | null = null) =>
  buildBurnPayload({ summary: s, scale, sessionPct, nowMs: NOW, lookup });

/** One session per cost, in the given order, ids s0..sN. */
const byCost = (costs: number[], rate = 0): BurnSummary =>
  summary(costs.map((cost, i) => stat({ sessionId: `s${i}`, cost, share: 1 / costs.length, ratePerHour: rate })));

// --- buildBurnPayload -------------------------------------------------------

describe("buildBurnPayload", () => {
  it("formats used in limit percent when scaled: <0.1, one decimal below 10, whole from 10", () => {
    const p = build(byCost([12.4, 10, 9.94, 0.1, 0.05]), measured(1));
    expect(p.scaled).toBe(true);
    expect(p.rows.map((r) => r.used)).toEqual(["≈ 12%", "≈ 10%", "≈ 9.9%", "≈ 0.1%", "≈ <0.1%"]);
  });

  it("formats used in USD when unscaled: cents below $1, one decimal below $100, whole above", () => {
    const p = build(byCost([282.4, 100, 99.9, 8.3, 1, 0.42]));
    expect(p.scaled).toBe(false);
    expect(p.rows.map((r) => r.used)).toEqual(["$282", "$100", "$99.9", "$8.3", "$1.0", "$0.42"]);
  });

  it("writes the rate per hour, idle when nothing landed in the rate window", () => {
    const sessions = [stat({ sessionId: "a", ratePerHour: 4.97 }), stat({ sessionId: "b", ratePerHour: 150 }), stat({ sessionId: "c" })];
    expect(build(summary(sessions), measured(2)).rows.map((r) => r.rate)).toEqual(["+9.9%/h", "+300%/h", "idle"]);
    expect(build(summary(sessions)).rows.map((r) => r.rate)).toEqual(["$5.0/h", "$150/h", "idle"]);
  });

  it("builds meta from share, the first two models plus a count, and the drivers", () => {
    const busy = stat({ share: 0.75, subShare: 0.78, models: ["fable-5-2", "opus-5-5", "haiku-4-5"] });
    expect(build(summary([busy])).rows[0].meta).toBe("75% of burn · fable-5-2, opus-5-5 +1 · subagents 78%");
    const big = stat({ share: 0.25, avgContext: 412_600, cacheWriteShare: 0.4 });
    expect(build(summary([big])).rows[0].meta).toBe("25% of burn · opus-5-5 · ctx 413K · cache writes 40%");
  });

  it("puts one fact per tooltip line, optional lines only when non-zero", () => {
    const full = stat({
      cost: 6.2,
      requests: 12,
      subShare: 0.78,
      avgContext: 250_000,
      models: ["fable-5-2", "opus-5-5"],
      tokens: { input: 3, cacheWrite: 2_400_000, cacheRead: 410_000, output: 800 },
    });
    expect(build(summary([full])).rows[0].tip.split("\n")).toEqual([
      "requests: 12",
      "cost: $6.2 (API-equivalent)",
      "tokens: in 3 · cache write 2.4M · cache read 410K · out 800",
      "avg context: 250K",
      "subagents: 78% of cost",
      "models: fable-5-2, opus-5-5",
    ]);
    expect(build(summary([stat({ cost: 0.02 })])).rows[0].tip.split("\n")).toEqual([
      "requests: 1",
      "cost: $0.02 (API-equivalent)",
      "tokens: in 0 · cache write 0 · cache read 0 · out 0",
      "models: opus-5-5",
    ]);
  });

  it("ranks rows, sizes bars against the top row, marks live at the 90 s edge, and copies the lookup", () => {
    const p = build(
      summary([
        stat({ sessionId: "a", share: 0.75, lastTs: NOW - 90_000 }),
        stat({ sessionId: "gone", share: 0.25, lastTs: NOW - 90_001 }),
      ]),
    );
    expect(p.rows.map((r) => [r.rank, r.sessionId, r.sharePct, r.live])).toEqual([
      [1, "a", 75, true],
      [2, "gone", 25, false],
    ]);
    expect(p.rows[0]).toMatchObject({ barPct: 100, title: "title a", openId: "row-a", ended: false });
    expect(p.rows[1]).toMatchObject({ title: "title gone", openId: "row-gone", ended: true });
    expect(p.rows[1].barPct).toBeCloseTo(100 / 3, 9);
  });

  it("shows maxRows rows (default 12) and counts the rest in more", () => {
    const many = byCost(Array.from({ length: 14 }, (_, i) => 14 - i));
    expect(build(many).rows).toHaveLength(12);
    expect(build(many).more).toBe(2);
    const two = buildBurnPayload({ summary: many, scale: null, sessionPct: null, nowMs: NOW, lookup, maxRows: 2 });
    expect(two.rows.map((r) => r.sessionId)).toEqual(["s0", "s1"]);
    expect(two.more).toBe(12);
  });

  it("writes the headline with and without a scale, with the time until the 5h limit is full", () => {
    const s = summary([stat({ cost: 50, ratePerHour: 100 })]);
    expect(build(s).headline).toBe("$100/h API-equivalent");
    expect(build(s, null, 80).headline).toBe("$100/h API-equivalent");
    expect(build(s, measured(0.5)).headline).toBe("$100/h · ≈ +50%/h of the 5h limit");
    expect(build(s, measured(0.5), 80).headline).toBe("$100/h · ≈ +50%/h of the 5h limit · full in ~24 min");
    expect(build(s, measured(0.5), 0).headline).toBe("$100/h · ≈ +50%/h of the 5h limit · full in ~2.0 h");
    expect(build(s, measured(0.1), 0).headline).toBe("$100/h · ≈ +10%/h of the 5h limit");
    expect(build(s, measured(0.5), 100).headline).toBe("$100/h · ≈ +50%/h of the 5h limit");
    expect(build(summary([stat()]), measured(0.5), 50).headline).toBe("$0.00/h · ≈ +<0.1%/h of the 5h limit");
  });

  it("explains how the estimate is made", () => {
    const s = summary([stat()]);
    expect(build(s, measured(0.5, { deltaPct: 6, spanMs: 600_000 })).note).toBe(
      "Estimate: API list prices scaled to the 5h gauge (6 pts in 10 min).",
    );
    expect(build(s, measured(0.5, { cached: true, spanMs: 0, deltaPct: 0 })).note).toBe(
      "Estimate: API list prices scaled with this account's last measured rate.",
    );
    expect(build(s).note).toBe("Estimate: API list prices. Limit percentages appear once the 5h gauge has moved 3 points.");
  });

  it("carries the window, a copy of the window list and the empty text", () => {
    const p = build(summary([]));
    expect(p).toMatchObject({ type: "update", windowMs: 15 * 60_000, rows: [], more: 0 });
    expect(p.empty).toBe("No Claude requests in the last 15m.");
    expect(p.windows).toEqual(BURN_WINDOWS);
    expect(p.windows).not.toBe(BURN_WINDOWS);
    expect(build(summary([], { windowMs: 60 * 60_000 })).empty).toBe("No Claude requests in the last 1h.");
    expect(build(summary([], { windowMs: 7 * 60_000 })).empty).toBe("No Claude requests in the last 7 min.");
  });
});

// --- gauge history ----------------------------------------------------------

describe("gaugeSamplesFromHistory", () => {
  it("keeps account rows with numeric 5h data, seconds to ms, ascending", () => {
    const reset = 1_794_322_799_912;
    const history: RawLimits[] = [
      { src: "ext", acct: "acct-a", fh: 88, fh_reset: reset + 213, ts: 1_794_305_646.242 },
      { src: "ext", acct: "acct-a", fh: 49, fh_reset: reset, ts: 1_794_304_978 },
      { fh: 50, fh_reset: reset, ts: 1_794_305_000 }, // legacy row without an account
      { acct: "acct-a", fh: 51, fh_reset: null, ts: 1_794_305_010 },
      { acct: "acct-a", fh: 52, fh_reset: "2026-11-10T15:00:00Z", ts: 1_794_305_020 },
      { acct: "acct-a", fh: null, fh_reset: reset, ts: 1_794_305_030 },
      { acct: "acct-a", fh: 53, fh_reset: reset, ts: 0 },
      { acct: "acct-a", fh: 54, fh_reset: reset, ts: -5 },
      { acct: "acct-a", fh: 55, fh_reset: reset },
    ];
    const before = JSON.stringify(history);
    expect(gaugeSamplesFromHistory(history)).toEqual([
      { ts: 1_794_304_978_000, acct: "acct-a", pct: 49, resetMs: reset },
      { ts: 1_794_305_646_242, acct: "acct-a", pct: 88, resetMs: reset + 213 },
    ]);
    expect(JSON.stringify(history)).toBe(before);
    expect(gaugeSamplesFromHistory([])).toEqual([]);
  });
});

describe("burnShares", () => {
  it("maps each session to its share in percent", () => {
    const shares = burnShares(summary([stat({ sessionId: "a", share: 0.75 }), stat({ sessionId: "b", share: 0.25 })]));
    expect([...shares]).toEqual([
      ["a", 75],
      ["b", 25],
    ]);
    expect(burnShares(summary([])).size).toBe(0);
  });
});

// --- resolveScale -----------------------------------------------------------

describe("resolveScale", () => {
  const fresh = (ptsPerUsd: number, deltaPct: number, acct = "acct-a"): BurnScale => ({ ptsPerUsd, spanMs: 900_000, deltaPct, acct });

  it("uses a solid measurement and remembers it in a NEW cache object", () => {
    const cache = Object.freeze({ "acct-b": 0.4 });
    const r = resolveScale(fresh(0.55, SOLID_DELTA_PCT), "acct-a", cache);
    expect(r.scale).toEqual({ ptsPerUsd: 0.55, spanMs: 900_000, deltaPct: SOLID_DELTA_PCT, acct: "acct-a", cached: false });
    expect(r.cache).not.toBe(cache);
    expect(r.cache).toEqual({ "acct-b": 0.4, "acct-a": 0.55 });
    expect(cache).toEqual({ "acct-b": 0.4 });
  });

  it("keeps the SAME cache object when a solid rate is within 5% of the remembered one", () => {
    const cache = Object.freeze({ "acct-a": 0.55 });
    const r = resolveScale(fresh(0.57, 12), "acct-a", cache);
    expect(r.scale).toEqual({ ptsPerUsd: 0.57, spanMs: 900_000, deltaPct: 12, acct: "acct-a", cached: false });
    expect(r.cache).toBe(cache);
  });

  it("replaces the remembered rate in a NEW cache object when a solid rate moved by more than 5%", () => {
    const cache = Object.freeze({ "acct-a": 0.55, "acct-b": 0.4 });
    const r = resolveScale(fresh(0.6, 12), "acct-a", cache);
    expect(r.scale).toMatchObject({ ptsPerUsd: 0.6, cached: false });
    expect(r.cache).not.toBe(cache);
    expect(r.cache).toEqual({ "acct-a": 0.6, "acct-b": 0.4 });
    expect(cache).toEqual({ "acct-a": 0.55, "acct-b": 0.4 });
  });

  it("prefers the remembered rate over a weak measurement", () => {
    const cache = Object.freeze({ "acct-a": 0.55 });
    const r = resolveScale(fresh(0.9, SOLID_DELTA_PCT - 1), "acct-a", cache);
    expect(r.scale).toEqual({ ptsPerUsd: 0.55, acct: "acct-a", cached: true, spanMs: 0, deltaPct: 0 });
    expect(r.cache).toBe(cache);
  });

  it("uses a weak measurement when nothing is remembered, without remembering it", () => {
    const cache = Object.freeze({ "acct-b": 0.4 });
    const r = resolveScale(fresh(0.9, 4), "acct-a", cache);
    expect(r.scale).toEqual({ ptsPerUsd: 0.9, spanMs: 900_000, deltaPct: 4, acct: "acct-a", cached: false });
    expect(r.cache).toBe(cache);
    expect(cache).toEqual({ "acct-b": 0.4 });
  });

  it("falls back to the account's remembered rate without a measurement, else null", () => {
    const cache = Object.freeze({ "acct-a": 0.55 });
    const r = resolveScale(null, "acct-a", cache);
    expect(r.scale).toEqual({ ptsPerUsd: 0.55, acct: "acct-a", cached: true, spanMs: 0, deltaPct: 0 });
    expect(r.cache).toBe(cache);
    expect(resolveScale(null, "acct-b", cache)).toEqual({ scale: null, cache });
    expect(resolveScale(null, "acct-b", cache).cache).toBe(cache);
    expect(resolveScale(null, null, cache).scale).toBeNull();
    expect(resolveScale(null, "toString", cache).scale).toBeNull();
  });
});
