import { describe, it, expect, beforeAll } from "vitest";
import { BURN_WINDOWS, DEFAULT_BURN_WINDOW_MS, type BurnPayload, type BurnRowView } from "../src/burnPayload";

// --- helpers ----------------------------------------------------------------

type Cli = typeof import("../src/burnCli");

// Loaded here rather than at the top so the test can prove that importing the
// module does not start the CLI: its entry point registers a SIGINT handler
// before its first await, so a started CLI would show up in the listener count.
let cli: Cli;
let sigintBefore = 0;
let sigintAfter = 0;
beforeAll(async () => {
  sigintBefore = process.listenerCount("SIGINT");
  cli = await import("../src/burnCli");
  sigintAfter = process.listenerCount("SIGINT");
});

function row(over: Partial<BurnRowView> = {}): BurnRowView {
  return {
    sessionId: "s1",
    openId: "",
    rank: 1,
    title: "Fix the build",
    meta: "75% of burn · opus-5-5",
    sharePct: 75,
    barPct: 100,
    used: "≈ 12%",
    rate: "+9.9%/h",
    live: true,
    ended: false,
    tip: "",
    ...over,
  };
}

function payload(over: Partial<BurnPayload> = {}): BurnPayload {
  return {
    type: "update",
    windowMs: 15 * 60_000,
    windows: BURN_WINDOWS.map((w) => ({ ...w })),
    scaled: true,
    headline: "$226/h · ≈ +118%/h of the 5h limit · full in ~24 min",
    note: "Estimate: API list prices scaled to the 5h gauge (6 pts in 10 min).",
    rows: [row()],
    more: 0,
    empty: "No Claude requests in the last 15m.",
    ...over,
  };
}

const FIRST_ROW = " 1 ●  75.0%   +9.9%/h    ≈ 12%  Fix the build · 75% of burn · opus-5-5";

// --- module -----------------------------------------------------------------

describe("burnCli module", () => {
  it("does not start the CLI when imported", () => {
    expect(sigintAfter).toBe(sigintBefore);
  });
});

// --- parseBurnArgs ----------------------------------------------------------

describe("parseBurnArgs", () => {
  it("defaults to the 15m window, a 5 s interval and watch mode", () => {
    expect(cli.parseBurnArgs([])).toEqual({ windowMs: DEFAULT_BURN_WINDOW_MS, intervalSec: 5, once: false, json: false });
  });

  it("accepts every window label and falls back to the default otherwise", () => {
    for (const w of BURN_WINDOWS) expect(cli.parseBurnArgs(["--window", w.label]).windowMs).toBe(w.ms);
    expect(cli.parseBurnArgs(["--window", "2m"]).windowMs).toBe(DEFAULT_BURN_WINDOW_MS);
    expect(cli.parseBurnArgs(["--window"]).windowMs).toBe(DEFAULT_BURN_WINDOW_MS);
  });

  it("takes an interval of at least 1 s, else 5", () => {
    expect(cli.parseBurnArgs(["--interval", "2"]).intervalSec).toBe(2);
    expect(cli.parseBurnArgs(["--interval", "1"]).intervalSec).toBe(1);
    const bad = [["--interval", "0.5"], ["--interval", "0"], ["--interval", "-3"], ["--interval", "abc"], ["--interval"]];
    for (const argv of bad) expect(cli.parseBurnArgs(argv).intervalSec).toBe(5);
  });

  it("prints once with --once, and --json implies once", () => {
    expect(cli.parseBurnArgs(["--once"])).toMatchObject({ once: true, json: false });
    expect(cli.parseBurnArgs(["--json"])).toMatchObject({ once: true, json: true });
    expect(cli.parseBurnArgs(["--window", "1h", "--interval", "10", "--once"])).toEqual({
      windowMs: 60 * 60_000,
      intervalSec: 10,
      once: true,
      json: false,
    });
  });
});

// --- burnTable --------------------------------------------------------------

describe("burnTable", () => {
  it("prints the header, the note, a column header and one line per row", () => {
    const old = row({ rank: 2, live: false, sharePct: 4, rate: "idle", used: "≈ <0.1%", title: "Old one", meta: "4% of burn · haiku-4-5" });
    expect(cli.burnTable(payload({ rows: [row(), old] }), 200)).toEqual([
      "Limit burn · last 15m · $226/h · ≈ +118%/h of the 5h limit · full in ~24 min",
      "Estimate: API list prices scaled to the 5h gauge (6 pts in 10 min).",
      "",
      " #    share       now     used  session",
      FIRST_ROW,
      " 2 ○   4.0%      idle  ≈ <0.1%  Old one · 4% of burn · haiku-4-5",
    ]);
  });

  it("adds a more line, singular or plural, only when sessions were cut", () => {
    expect(cli.burnTable(payload(), 200).at(-1)).toBe(FIRST_ROW);
    expect(cli.burnTable(payload({ more: 1 }), 200).at(-1)).toBe("     + 1 more session");
    expect(cli.burnTable(payload({ more: 3 }), 200).at(-1)).toBe("     + 3 more sessions");
  });

  it("prints the empty text and no column header when there are no rows", () => {
    const empty = payload({ rows: [], headline: "$0.00/h API-equivalent", note: "Estimate: API list prices." });
    expect(cli.burnTable(empty, 200)).toEqual([
      "Limit burn · last 15m · $0.00/h API-equivalent",
      "Estimate: API list prices.",
      "",
      "No Claude requests in the last 15m.",
    ]);
  });

  it("clips every line to the width with a trailing ellipsis", () => {
    const lines = cli.burnTable(payload({ more: 2 }), 30);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
    expect(lines[0]).toBe("Limit burn · last 15m · $226/…");
    expect(lines[2]).toBe("");
    expect(lines.at(-1)).toBe("     + 2 more sessions");
  });

  it("names the window by its label, or in minutes when it is not a listed window", () => {
    expect(cli.burnTable(payload({ windowMs: 5 * 3_600_000 }), 200)[0]).toMatch(/^Limit burn · last 5h · /);
    expect(cli.burnTable(payload({ windowMs: 7 * 60_000 }), 200)[0]).toMatch(/^Limit burn · last 7 min · /);
  });
});
