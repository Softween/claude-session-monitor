import { describe, it, expect } from "vitest";
import { groupOf, normPct, normResetMs, fmtMb, normLabel, labelsMatch, parsePsOutput, clampPct, parseOfficialGauges, computeBurnEta, estimateCostUsd, shortModelName, shortEffort, isRedundantSub, fmtTokensCompact, nextUsageBackoffSec, accountPillLabels, filterHistoryForAccount, topSessionRows } from "../src/view";
import type { SessionView } from "../src/core";

const v = (bucket: SessionView["bucket"], sub: string): SessionView =>
  ({ bucket, sub } as SessionView);

describe("groupOf", () => {
  it("maps buckets and attention sub-states to display groups", () => {
    expect(groupOf(v("limited", "session limit"))).toBe("limited");
    expect(groupOf(v("working", "working"))).toBe("working");
    expect(groupOf(v("ended", "ended"))).toBe("ended");
    expect(groupOf(v("attention", "waiting for you"))).toBe("waiting");
    expect(groupOf(v("attention", "your turn"))).toBe("done");
    expect(groupOf(v("attention", "API error"))).toBe("done");
    expect(groupOf(v("unknown", "unknown"))).toBe("unknown");
  });
});

describe("normPct", () => {
  it("normalizes 0-1 fractions and 0-100 percents", () => {
    expect(normPct(0.07)).toBeCloseTo(7);
    expect(normPct(25)).toBe(25);
    expect(normPct(1)).toBe(100);
    expect(normPct(0)).toBe(0);
  });
  it("returns null for non-finite/non-number", () => {
    expect(normPct(null)).toBeNull();
    expect(normPct(undefined)).toBeNull();
    expect(normPct(NaN)).toBeNull();
    expect(normPct("7")).toBeNull();
  });
});

describe("normResetMs", () => {
  it("handles epoch seconds, epoch ms, and ISO strings", () => {
    expect(normResetMs(1781830737)).toBe(1781830737000); // seconds -> ms
    expect(normResetMs(1781830737857)).toBe(1781830737857); // already ms
    expect(normResetMs("2026-06-17T23:40:00.000Z")).toBe(Date.parse("2026-06-17T23:40:00.000Z"));
  });
  it("returns null for garbage", () => {
    expect(normResetMs("nope")).toBeNull();
    expect(normResetMs(null)).toBeNull();
    expect(normResetMs(undefined)).toBeNull();
  });
});

describe("fmtMb", () => {
  it("formats MB and GB", () => {
    expect(fmtMb(240)).toBe("240MB");
    expect(fmtMb(1024)).toBe("1.0GB");
    expect(fmtMb(1536)).toBe("1.5GB");
  });
});

describe("normLabel / labelsMatch", () => {
  it("strips trailing ellipsis/dots and lowercases", () => {
    expect(normLabel("WhatsApp neden çalışmıyor…")).toBe("whatsapp neden çalışmıyor");
    expect(normLabel("Foo.")).toBe("foo");
    expect(normLabel("  Bar  ")).toBe("bar");
  });
  it("matches exact, prefix, and truncated tab labels", () => {
    expect(labelsMatch("Refactor auth", "Refactor auth")).toBe(true);
    expect(labelsMatch("Beauty service marketpl…", "Beauty service marketplace mekan")).toBe(true);
    expect(labelsMatch("Beauty service marketplace mekan", "Beauty service marketpl…")).toBe(true);
    expect(labelsMatch("Totally different", "Refactor auth")).toBe(false);
    expect(labelsMatch("", "x")).toBe(false);
  });
});

describe("parsePsOutput", () => {
  it("parses ps rows (kB->MB) and skips junk lines", () => {
    const out = "  1234  12.5  262144\n  5678   0.0   1024\ngarbage line\n  99 not-a-num xx\n";
    const m = new Map(parsePsOutput(out).map((r) => [r.pid, r]));
    expect(m.get(1234)).toEqual({ pid: 1234, cpu: 12.5, rssMb: 256 });
    expect(m.get(5678)).toEqual({ pid: 5678, cpu: 0, rssMb: 1 });
    expect(m.get(99)).toEqual({ pid: 99, cpu: 0, rssMb: 0 }); // NaN cpu/rss coerced to 0
    expect(m.size).toBe(3); // 2-token "garbage line" skipped
  });
});

describe("clampPct", () => {
  it("passes percent-scale values through (1.0 means 1%, not 100%)", () => {
    expect(clampPct(1)).toBe(1);
    expect(clampPct(4)).toBe(4);
    expect(clampPct(0.5)).toBe(0.5);
  });
  it("clamps to [0,100] and rejects non-numbers", () => {
    expect(clampPct(150)).toBe(100);
    expect(clampPct(-5)).toBe(0);
    expect(clampPct("7")).toBeNull();
    expect(clampPct(NaN)).toBeNull();
  });
});

describe("parseOfficialGauges", () => {
  const payload = {
    five_hour: { utilization: 4.0, resets_at: "2026-07-04T01:39:59+00:00" },
    seven_day: { utilization: 1.0, resets_at: "2026-07-05T18:59:59+00:00" },
    limits: [
      { kind: "session", group: "session", percent: 4, resets_at: "2026-07-04T01:39:59+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 1, resets_at: "2026-07-05T18:59:59+00:00", scope: null },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 12,
        resets_at: "2026-07-05T18:59:59+00:00",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
      },
    ],
  };
  it("prefers limits[] and surfaces per-model scoped limits like Fable", () => {
    const g = parseOfficialGauges(payload);
    expect(g.map((x) => x.key)).toEqual(["session", "weekly", "weekly-fable"]);
    const fable = g.find((x) => x.key === "weekly-fable")!;
    expect(fable.label).toBe("Weekly · Fable");
    expect(fable.pct).toBe(12);
    expect(fable.resetMs).toBe(Date.parse("2026-07-05T18:59:59+00:00"));
  });
  it("treats utilization/percent as percent scale (no 1.0 -> 100% blowup)", () => {
    const g = parseOfficialGauges(payload);
    expect(g.find((x) => x.key === "weekly")!.pct).toBe(1);
  });
  it("falls back to legacy fields when limits[] is absent", () => {
    const g = parseOfficialGauges({
      five_hour: { utilization: 71, resets_at: 1780500000 },
      seven_day: { utilization: 85, resets_at: 1780900000 },
      seven_day_sonnet: { utilization: 3, resets_at: 1780900000 },
    });
    expect(g.map((x) => x.key)).toEqual(["session", "weekly", "weekly-sonnet"]);
    expect(g[0].pct).toBe(71);
  });
  it("does not duplicate gauges covered by both limits[] and legacy fields", () => {
    const g = parseOfficialGauges(payload);
    expect(g.filter((x) => x.key === "session").length).toBe(1);
  });
  it("returns empty for garbage payloads", () => {
    expect(parseOfficialGauges(null)).toEqual([]);
    expect(parseOfficialGauges({ limits: "nope" })).toEqual([]);
    expect(parseOfficialGauges({ limits: [{ kind: "session", percent: "x" }] })).toEqual([]);
  });
});

describe("computeBurnEta", () => {
  const NOW = 1_780_000_000_000; // ms
  const mk = (minAgo: number, fh: number) => ({ t: NOW - minAgo * 60_000, fh });

  it("projects a linear fill and flags fills that land before the reset", () => {
    // +1%/min over 30 min -> 60%/h; at 70% now, full in ~30 min.
    const hist = [mk(30, 40), mk(20, 50), mk(10, 60), mk(0, 70)];
    const eta = computeBurnEta(hist, 70, NOW + 3 * 3600_000, NOW)!;
    expect(eta).not.toBeNull();
    expect(eta.perHour).toBeCloseTo(60, 0);
    expect(eta.fullAtMs - NOW).toBeCloseTo(30 * 60_000, -4);
    expect(eta.beforeReset).toBe(true);
  });
  it("is null with too few points or too little time spread", () => {
    expect(computeBurnEta([mk(1, 50), mk(0, 51)], 51, null, NOW)).toBeNull();
    expect(computeBurnEta([mk(5, 50), mk(3, 51), mk(0, 52)], 52, null, NOW)).toBeNull();
  });
  it("is null when usage is flat or falling", () => {
    const flat = [mk(30, 50), mk(20, 50), mk(10, 50), mk(0, 50)];
    expect(computeBurnEta(flat, 50, null, NOW)).toBeNull();
  });
  it("bails when a reset happened inside the window", () => {
    const dropped = [mk(30, 80), mk(20, 90), mk(10, 2), mk(0, 6)];
    expect(computeBurnEta(dropped, 6, null, NOW)).toBeNull();
  });
  it("marks beforeReset=false when the reset comes first", () => {
    const hist = [mk(30, 40), mk(20, 43), mk(10, 46), mk(0, 49)]; // 18%/h, ~2.8h to full
    const eta = computeBurnEta(hist, 49, NOW + 30 * 60_000, NOW)!;
    expect(eta.beforeReset).toBe(false);
  });
});

describe("estimateCostUsd / shortModelName", () => {
  it("prices known models (cache-write at 1.25x input) and returns null for unpriced", () => {
    const m = { tokens: 3_000_000, inTok: 1_000_000, outTok: 1_000_000, cwTok: 1_000_000 };
    expect(estimateCostUsd(m, "claude-opus-4-8")).toBeCloseTo(15 + 75 + 18.75, 2);
    expect(estimateCostUsd(m, "claude-haiku-4-5-20251001")).toBeCloseTo(1 + 5 + 1.25, 2);
    expect(estimateCostUsd(m, "claude-fable-5")).toBeNull();
  });
  it("shortens model ids, joining numeric version segments with dots", () => {
    expect(shortModelName("claude-fable-5")).toBe("Fable 5");
    expect(shortModelName("claude-opus-4-8")).toBe("Opus 4.8");
    expect(shortModelName("claude-sonnet-5")).toBe("Sonnet 5");
    expect(shortModelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(shortModelName("unknown")).toBe("Unknown");
  });
});

describe("shortEffort", () => {
  it("compacts known effort levels and passes unknowns through", () => {
    expect(shortEffort("medium")).toBe("med");
    expect(shortEffort("xhigh")).toBe("xhigh");
    expect(shortEffort("HIGH")).toBe("high");
    expect(shortEffort("weird")).toBe("weird");
    expect(shortEffort(undefined)).toBeUndefined();
    expect(shortEffort("")).toBeUndefined();
  });
});

describe("isRedundantSub", () => {
  it("treats group-restating statuses as redundant, keeps informative ones", () => {
    expect(isRedundantSub("your turn")).toBe(true);
    expect(isRedundantSub("working")).toBe(true);
    expect(isRedundantSub("waiting for you")).toBe(true);
    expect(isRedundantSub("ended")).toBe(true);
    expect(isRedundantSub("working (stalled?)")).toBe(false);
    expect(isRedundantSub("session limit")).toBe(false);
    expect(isRedundantSub("rate limited")).toBe(false);
    expect(isRedundantSub("API error")).toBe(false);
  });
});

describe("fmtTokensCompact", () => {
  it("formats token counts", () => {
    expect(fmtTokensCompact(999)).toBe("999");
    expect(fmtTokensCompact(1500)).toBe("1.5K");
    expect(fmtTokensCompact(250_000)).toBe("250K");
    expect(fmtTokensCompact(13_450_000)).toBe("13.45M");
  });
});

describe("nextUsageBackoffSec", () => {
  it("starts at 60s and doubles up to the 15m cap", () => {
    expect(nextUsageBackoffSec(undefined, undefined)).toBe(60);
    expect(nextUsageBackoffSec(60, undefined)).toBe(120);
    expect(nextUsageBackoffSec(480, undefined)).toBe(900);
    expect(nextUsageBackoffSec(900, undefined)).toBe(900);
  });
  it("honors a larger Retry-After and floors at 60s", () => {
    expect(nextUsageBackoffSec(undefined, 300)).toBe(300);
    expect(nextUsageBackoffSec(undefined, 5)).toBe(60);
    expect(nextUsageBackoffSec(120, 1000)).toBe(900);
  });
});

describe("accountPillLabels", () => {
  it("uses the bare local part when unambiguous", () => {
    expect(accountPillLabels(["bilal@glossgo.com", "emir@glossgo.com"])).toEqual(["bilal", "emir"]);
  });
  it("disambiguates duplicate local parts with the domain word", () => {
    expect(accountPillLabels(["info@glossgo.com", "info@softween.com"])).toEqual(["info@glossgo", "info@softween"]);
  });
  it("passes through values without an @", () => {
    expect(accountPillLabels(["this account"])).toEqual(["this account"]);
  });
});

describe("filterHistoryForAccount", () => {
  const pts = [{ acct: "a", fh: 1 }, { acct: "b", fh: 2 }, { fh: 3 }] as { acct?: string; fh: number }[];
  it("keeps tagged points of the account plus legacy points only for the active login", () => {
    expect(filterHistoryForAccount(pts, "a", true).map((p) => p.fh)).toEqual([1, 3]);
    expect(filterHistoryForAccount(pts, "a", false).map((p) => p.fh)).toEqual([1]);
    expect(filterHistoryForAccount(pts, "b", false).map((p) => p.fh)).toEqual([2]);
  });
  it("returns everything when no account is selected", () => {
    expect(filterHistoryForAccount(pts, null, true)).toHaveLength(3);
  });
});

describe("topSessionRows", () => {
  it("sorts by tokens, labels from live titles, falls back to the short id", () => {
    const rows = topSessionRows(
      { "aaaabbbb-1111": 500_000, "ccccdddd-2222": 1_500_000 },
      new Map([["ccccdddd-2222", "Fix the deploy"]]),
      2_000_000,
    );
    expect(rows.map((r) => r.label)).toEqual(["Fix the deploy", "session aaaabbbb"]);
    expect(rows[0].pct).toBe(75);
    expect(rows[1].pct).toBe(25);
  });
  it("caps at n rows, drops zero rows, and never exceeds 100%", () => {
    const by: Record<string, number> = {};
    for (let i = 0; i < 9; i++) by["s" + i] = (i + 1) * 1000;
    by.zero = 0;
    const rows = topSessionRows(by, new Map(), 100, 6); // total smaller than the sum
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.pct <= 100)).toBe(true);
    expect(rows.find((r) => r.tokens === 0)).toBeUndefined();
  });
});
