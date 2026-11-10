import { describe, it, expect } from "vitest";
import {
  priceFor,
  costOf,
  parseBurnLine,
  BurnStore,
  summarize,
  driversOf,
  calibrate,
  HAIKU_5_TIER_TOKENS,
  type BurnRecord,
  type BurnSessionStat,
  type GaugeSample,
} from "../src/burn";

// --- helpers ----------------------------------------------------------------

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;

function rec(over: Partial<BurnRecord> = {}): BurnRecord {
  return {
    key: "req_1",
    ts: NOW - 60_000,
    sessionId: "s1",
    sub: false,
    model: "claude-opus-5-5",
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
    fileMtimeMs: NOW,
    ...over,
  };
}

/** Opus 5.5 output bills $20/MTok, so 50K output tokens cost exactly $1. */
const usd = (dollars: number, over: Partial<BurnRecord> = {}): BurnRecord => rec({ output: dollars * 50_000, ...over });

const row = (input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number) => ({
  input,
  output,
  cacheWrite5m,
  cacheWrite1h,
  cacheRead,
});

/** The real-shaped assistant line, as Claude Code writes it. */
const base = () => ({
  type: "assistant",
  timestamp: "2026-11-10T07:52:42.123Z",
  requestId: "req_a",
  uuid: "uuid_a",
  cwd: "/work/repo",
  sessionId: "line-session",
  message: {
    id: "msg_a",
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 3,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 410000,
      output_tokens: 800,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1200 },
    },
  },
});

/** `base()` with top-level and message-level overrides; undefined drops a field. */
function lineWith(over: object = {}, msgOver: object = {}): string {
  const b = base();
  return JSON.stringify({ ...b, ...over, message: { ...b.message, ...msgOver } });
}

// --- prices -----------------------------------------------------------------

describe("priceFor", () => {
  it.each([
    ["claude-fable-5-1", row(10, 50, 12.5, 20, 0.25)],
    ["claude-fable-5-2", row(10, 50, 12.5, 20, 0.25)],
    ["claude-mythos-5-1[1m]", row(10, 50, 12.5, 20, 0.25)],
    ["claude-fable-5", row(10, 50, 12.5, 20, 1)],
    ["claude-fable-5-20260115", row(10, 50, 12.5, 20, 1)],
    ["claude-mythos-5", row(10, 50, 12.5, 20, 1)],
    ["claude-opus-5-5", row(4, 20, 5, 8, 0.2)],
    ["CLAUDE-OPUS-5-5[1M]", row(4, 20, 5, 8, 0.2)],
    ["claude-opus-5", row(5, 25, 6.25, 10, 0.5)],
    ["claude-opus-4-1-20250805", row(5, 25, 6.25, 10, 0.5)],
    ["claude-sonnet-5", row(2, 10, 2.5, 4, 0.2)],
    ["claude-sonnet-5-5", row(2, 10, 2.5, 4, 0.2)],
    ["claude-sonnet-4-5-20250929", row(3, 15, 3.75, 6, 0.3)],
    ["claude-haiku-4-5", row(1, 5, 1.25, 2, 0.1)],
    ["some-future-model", row(4, 20, 5, 8, 0.2)],
  ])("%s", (model, want) => {
    expect(priceFor(model, 1000)).toEqual(want);
  });

  it("moves Haiku 5 to its long-context row above 100K prompt tokens", () => {
    expect(priceFor("claude-haiku-5", HAIKU_5_TIER_TOKENS)).toEqual(row(0.1, 0.5, 0.125, 0.2, 0.01));
    expect(priceFor("claude-haiku-5", HAIKU_5_TIER_TOKENS + 1)).toEqual(row(0.5, 2.5, 0.625, 1, 0.05));
  });
});

describe("costOf", () => {
  it("prices every token class at the model's row", () => {
    const r = rec({ input: 1000, cacheWrite5m: 2000, cacheWrite1h: 3000, cacheRead: 1_000_000, output: 500 });
    expect(costOf(r)).toBeCloseTo((1000 * 4 + 2000 * 5 + 3000 * 8 + 1_000_000 * 0.2 + 500 * 20) / 1e6, 12);
  });

  it("bills Haiku 5 by the prompt size of the request", () => {
    const small = rec({ model: "claude-haiku-5", input: 50_000, cacheRead: 50_000, output: 1_000_000 });
    const large = rec({ model: "claude-haiku-5", input: 50_001, cacheRead: 50_000, output: 1_000_000 });
    expect(costOf(small)).toBeCloseTo((50_000 * 0.1 + 50_000 * 0.01 + 1_000_000 * 0.5) / 1e6, 12);
    expect(costOf(large)).toBeCloseTo((50_001 * 0.5 + 50_000 * 0.05 + 1_000_000 * 2.5) / 1e6, 12);
  });
});

// --- lines ------------------------------------------------------------------

describe("parseBurnLine", () => {
  it("reads a real-shaped assistant line", () => {
    expect(parseBurnLine(JSON.stringify(base()))).toEqual({
      kind: "usage",
      key: "req_a",
      ts: Date.parse("2026-11-10T07:52:42.123Z"),
      model: "claude-opus-5-5",
      input: 3,
      cacheWrite5m: 0,
      cacheWrite1h: 1200,
      cacheRead: 410000,
      output: 800,
      cwd: "/work/repo",
    });
  });

  it("splits cache writes into 5m and 1h, clamps the 1h part, and reads no breakdown as 5m", () => {
    const writes = (usage: object) => {
      const p = parseBurnLine(lineWith({}, { usage }));
      return p?.kind === "usage" ? [p.cacheWrite5m, p.cacheWrite1h, p.input, p.output] : p;
    };
    expect(writes({ cache_creation_input_tokens: 1500, cache_creation: { ephemeral_1h_input_tokens: 1000 } })).toEqual([500, 1000, 0, 0]);
    expect(writes({ cache_creation_input_tokens: 1000, cache_creation: { ephemeral_1h_input_tokens: 5000 } })).toEqual([0, 1000, 0, 0]);
    expect(writes({ cache_creation_input_tokens: 700 })).toEqual([700, 0, 0, 0]);
  });

  it("keys by requestId, then message.id, then uuid", () => {
    const keyOf = (line: string) => {
      const p = parseBurnLine(line);
      return p?.kind === "usage" ? p.key : p;
    };
    expect(keyOf(lineWith({ requestId: undefined }))).toBe("msg_a");
    expect(keyOf(lineWith({ requestId: undefined }, { id: undefined }))).toBe("uuid_a");
    expect(keyOf(lineWith({ requestId: undefined, uuid: undefined }, { id: undefined }))).toBeNull();
  });

  it("skips synthetic models, bad timestamps, non-assistant lines and non-object usage", () => {
    expect(parseBurnLine(lineWith({}, { model: "<synthetic>" }))).toBeNull();
    expect(parseBurnLine(lineWith({}, { model: undefined }))).toBeNull();
    expect(parseBurnLine(lineWith({ timestamp: "not a date" }))).toBeNull();
    expect(parseBurnLine(lineWith({ type: "user" }))).toBeNull();
    expect(parseBurnLine(lineWith({}, { usage: null }))).toBeNull();
    expect(parseBurnLine(lineWith({}, { usage: [1, 2] }))).toBeNull();
  });

  it("reads ai and custom titles", () => {
    const ai = JSON.stringify({ type: "ai-title", aiTitle: " Fix the build ", sessionId: "s" });
    const custom = JSON.stringify({ type: "custom-title", customTitle: "Mine", sessionId: "s" });
    expect(parseBurnLine(ai)).toEqual({ kind: "title", title: "Fix the build", custom: false });
    expect(parseBurnLine(custom)).toEqual({ kind: "title", title: "Mine", custom: true });
    expect(parseBurnLine(JSON.stringify({ type: "ai-title", aiTitle: "  " }))).toBeNull();
  });

  it("never throws on garbage", () => {
    const garbage = ["", "{", "null", "[]", '"usage"', 'title"', '{"usage": 1', "\u0000\u0001", '{"type":"assistant","message":{"usage":5}}', '{"type":"assistant","usage":{}}'];
    for (const line of garbage) expect(parseBurnLine(line)).toBeNull();
  });
});

// --- store ------------------------------------------------------------------

describe("BurnStore", () => {
  it("dedupes repeated lines of one request with a per-field max", () => {
    const store = new BurnStore();
    expect(store.upsert(rec({ cacheRead: 5000, output: 10 }))).toBe(true);
    expect(store.upsert(rec({ cacheRead: 4000, output: 800 }))).toBe(true);
    expect(store.upsert(rec({ cacheRead: 4000, output: 800 }))).toBe(false);
    expect(store.size).toBe(1);
    expect([...store.records()][0]).toMatchObject({ cacheRead: 5000, output: 800 });
  });

  it("moves a resumed copy to the session whose file is newer, never back to an older one", () => {
    const store = new BurnStore();
    store.upsert(rec({ sessionId: "old", fileMtimeMs: 1000 }));
    expect(store.upsert(rec({ sessionId: "new", sub: true, fileMtimeMs: 2000 }))).toBe(true);
    expect([...store.records()][0]).toMatchObject({ sessionId: "new", sub: true, fileMtimeMs: 2000 });
    expect(store.upsert(rec({ sessionId: "old", fileMtimeMs: 1500 }))).toBe(false);
    expect([...store.records()][0]).toMatchObject({ sessionId: "new", sub: true });
  });

  it("prunes records older than the cutoff", () => {
    const store = new BurnStore();
    store.upsert(rec({ key: "a", ts: 100 }));
    store.upsert(rec({ key: "b", ts: 200 }));
    store.prune(200);
    expect([...store.records()].map((r) => r.key)).toEqual(["b"]);
  });
});

// --- ranking ----------------------------------------------------------------

describe("summarize", () => {
  it("counts only records in (now - window, now]", () => {
    const records = [
      usd(1, { key: "edge-out", ts: NOW - HOUR }),
      usd(1, { key: "edge-in", ts: NOW - HOUR + 1 }),
      usd(1, { key: "now", ts: NOW }),
      usd(1, { key: "future", ts: NOW + 1 }),
    ];
    const s = summarize(records, NOW, HOUR);
    expect(s.windowMs).toBe(HOUR);
    expect(s.totalCost).toBeCloseTo(2, 12);
    expect(s.sessions[0]).toMatchObject({ sessionId: "s1", requests: 2, lastTs: NOW });
  });

  it("ranks sessions by cost, shares sum to 1, zero-cost sessions are dropped", () => {
    const s = summarize(
      [
        usd(1, { key: "a", sessionId: "s1" }),
        usd(3, { key: "b", sessionId: "s2" }),
        usd(0.25, { key: "c", sessionId: "s3" }),
        usd(0.25, { key: "d", sessionId: "s3" }),
        rec({ key: "z", sessionId: "s4" }),
      ],
      NOW,
      HOUR,
    );
    expect(s.sessions.map((x) => x.sessionId)).toEqual(["s2", "s1", "s3"]);
    expect(s.sessions.reduce((sum, x) => sum + x.share, 0)).toBeCloseTo(1, 12);
    expect(s.sessions[0].share).toBeCloseTo(3 / 4.5, 12);
  });

  it("scales the last 5 minutes to an hourly rate, capped by the window", () => {
    const records = [usd(1, { key: "recent", ts: NOW - 120_000 }), usd(3, { key: "older", ts: NOW - 600_000 })];
    expect(summarize(records, NOW, HOUR).sessions[0].ratePerHour).toBeCloseTo(12, 9);
    expect(summarize(records, NOW, HOUR, 900_000).sessions[0].ratePerHour).toBeCloseTo(16, 9);
    expect(summarize(records, NOW, 180_000).sessions[0].ratePerHour).toBeCloseTo(20, 9);
    const two = summarize([...records, usd(0.5, { key: "other", sessionId: "s2", ts: NOW - 60_000 })], NOW, HOUR);
    expect(two.totalRatePerHour).toBeCloseTo(18, 9);
  });

  it("splits subagent and cache-write shares; avgContext ignores subagent requests", () => {
    const main = rec({ key: "m", cacheRead: 400_000 }); // $0.08
    const sub = rec({ key: "s", sub: true, cacheRead: 10_000, cacheWrite5m: 64_000 }); // $0.002 + $0.32
    const st = summarize([main, sub], NOW, HOUR).sessions[0];
    expect(st.avgContext).toBe(400_000);
    expect(st.subShare).toBeCloseTo(0.322 / 0.402, 9);
    expect(st.cacheWriteShare).toBeCloseTo(0.32 / 0.402, 9);
    expect(st.requests).toBe(2);
    expect(st.tokens).toEqual({ input: 0, cacheWrite: 64_000, cacheRead: 410_000, output: 0 });
    expect(summarize([sub], NOW, HOUR).sessions[0].avgContext).toBe(0);
  });

  it("lists models by cost with the claude- prefix stripped", () => {
    const st = summarize(
      [
        usd(1, { key: "a" }),
        rec({ key: "b", model: "claude-haiku-4-5", output: 300_000 }), // $1.50
        rec({ key: "c", model: "claude-haiku-4-5", output: 100_000 }), // $0.50
      ],
      NOW,
      HOUR,
    ).sessions[0];
    expect(st.models).toEqual(["haiku-4-5", "opus-5-5"]);
  });
});

describe("driversOf", () => {
  const stat = (over: Partial<BurnSessionStat>): BurnSessionStat => ({
    sessionId: "s",
    cost: 1,
    share: 1,
    ratePerHour: 0,
    requests: 1,
    subShare: 0,
    cacheWriteShare: 0,
    avgContext: 0,
    models: [],
    lastTs: 0,
    tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
    ...over,
  });

  it("tags each driver at its threshold, in a fixed order", () => {
    expect(driversOf(stat({ subShare: 0.5, avgContext: 300_000, cacheWriteShare: 0.35 }))).toEqual([
      "subagents 50%",
      "ctx 300K",
      "cache writes 35%",
    ]);
    expect(driversOf(stat({ subShare: 0.49, avgContext: 299_999, cacheWriteShare: 0.34 }))).toEqual([]);
    expect(driversOf(stat({ avgContext: 412_600, cacheWriteShare: 0.9 }))).toEqual(["ctx 413K", "cache writes 90%"]);
  });
});

describe("calibrate", () => {
  const RESET = NOW + 3 * HOUR;
  const T0 = NOW - 600_000;
  const ACCT = "a@example.com";
  const sample = (ts: number, pct: number, over: Partial<GaugeSample> = {}): GaugeSample => ({
    ts,
    acct: ACCT,
    pct,
    resetMs: RESET,
    ...over,
  });
  const burn = [
    usd(1, { key: "at-a", ts: T0 }),
    usd(1, { key: "r1", ts: T0 + 100_000 }),
    usd(1, { key: "r2", ts: NOW }),
    usd(1, { key: "after-b", ts: NOW + 1 }),
  ];

  it("divides the rise since the earliest qualifying sample by the cost in between", () => {
    const samples = [sample(NOW, 16), sample(T0, 10), sample(T0 + 300_000, 12)];
    expect(calibrate(samples, burn)).toEqual({ ptsPerUsd: 3, spanMs: 600_000, deltaPct: 6, acct: ACCT });
    expect(samples.map((s) => s.ts)).toEqual([NOW, T0, T0 + 300_000]); // input left unsorted
  });

  it("returns null when the rise or the span is too small", () => {
    expect(calibrate([sample(T0, 14), sample(NOW, 16)], burn)).toBeNull();
    expect(calibrate([sample(T0, 14), sample(NOW, 16)], burn, { minDeltaPct: 1 })).toEqual({
      ptsPerUsd: 1,
      spanMs: 600_000,
      deltaPct: 2,
      acct: ACCT,
    });
    expect(calibrate([sample(NOW - 60_000, 10), sample(NOW, 16)], burn)).toBeNull();
    expect(calibrate([sample(NOW - 60_000, 10), sample(NOW, 16)], burn, { minSpanMs: 30_000 })).not.toBeNull();
  });

  it("ignores samples of another account or another 5-hour window", () => {
    const b = sample(NOW, 16);
    expect(calibrate([sample(T0, 0, { acct: "b@example.com" }), sample(T0 + 300_000, 15), b], burn)).toBeNull();
    expect(calibrate([sample(T0, 0, { resetMs: RESET - 5 * HOUR }), sample(T0 + 300_000, 15), b], burn)).toBeNull();
    expect(calibrate([sample(T0, 10, { resetMs: RESET + 200_000 }), b], burn)).toEqual({
      ptsPerUsd: 3,
      spanMs: 600_000,
      deltaPct: 6,
      acct: ACCT,
    });
  });

  it("ignores a saturated tail pinned at 100%", () => {
    const samples = [sample(T0, 10), sample(T0 + 300_000, 40), sample(T0 + 400_000, 100), sample(NOW, 100)];
    expect(calibrate(samples, burn)).toEqual({ ptsPerUsd: 30, spanMs: 300_000, deltaPct: 30, acct: ACCT });
    expect(calibrate([sample(T0, 100), sample(NOW, 100)], burn)).toBeNull();
  });

  it("ends the run at an interleaved sample of another account", () => {
    const samples = [sample(T0, 10), sample(T0 + 200_000, 50, { acct: "b@example.com" }), sample(T0 + 300_000, 12), sample(NOW, 16)];
    expect(calibrate(samples, burn)).toEqual({ ptsPerUsd: 4, spanMs: 300_000, deltaPct: 4, acct: ACCT });
  });

  it("ends the run at a time gap above maxGapMs", () => {
    const samples = [sample(T0 - 700_000, 2), sample(T0, 10), sample(NOW, 16)];
    expect(calibrate(samples, burn)).toEqual({ ptsPerUsd: 3, spanMs: 600_000, deltaPct: 6, acct: ACCT });
    expect(calibrate(samples, burn, { maxGapMs: 800_000 })).toEqual({
      ptsPerUsd: 14 / 3,
      spanMs: 1_300_000,
      deltaPct: 14,
      acct: ACCT,
    });
  });

  it("drops samples older than sinceTs", () => {
    const samples = [sample(T0, 10), sample(T0 + 300_000, 12), sample(NOW, 16)];
    expect(calibrate(samples, burn, { sinceTs: T0 + 1 })).toEqual({ ptsPerUsd: 4, spanMs: 300_000, deltaPct: 4, acct: ACCT });
    expect(calibrate(samples, burn, { sinceTs: NOW + 1 })).toBeNull();
  });

  it("returns null without samples or without cost in the span", () => {
    expect(calibrate([], burn)).toBeNull();
    expect(calibrate([sample(T0, 10), sample(NOW, 16)], [])).toBeNull();
  });
});
