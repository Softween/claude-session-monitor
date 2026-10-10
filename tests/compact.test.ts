import { describe, expect, it } from "vitest";
import { gaugeShort, layoutAccounts, toggleExpanded, worstGauge } from "../src/compact";

const accts = [{ id: "a", active: true }, { id: "b" }, { id: "c" }];

describe("layoutAccounts", () => {
  it("active is full even when not expanded", () => {
    expect(layoutAccounts(accts, [])[0]).toEqual({ id: "a", mode: "full" });
  });
  it("non-active accounts are compact by default", () => {
    expect(layoutAccounts(accts, []).map((x) => x.mode)).toEqual(["full", "compact", "compact"]);
  });
  it("expanded non-active becomes full", () => {
    expect(layoutAccounts(accts, ["c"]).map((x) => x.mode)).toEqual(["full", "compact", "full"]);
  });
  it("ignores unknown expanded ids", () => {
    expect(layoutAccounts(accts, ["zzz"]).map((x) => x.mode)).toEqual(["full", "compact", "compact"]);
  });
});

describe("toggleExpanded", () => {
  it("adds then removes without mutating", () => {
    const base: string[] = [];
    const added = toggleExpanded(base, "b");
    expect(added).toEqual(["b"]);
    expect(base).toEqual([]);
    expect(toggleExpanded(added, "b")).toEqual([]);
  });
});

describe("worstGauge", () => {
  it("empty list gives null", () => expect(worstGauge([])).toBeNull());
  it("picks the highest pct", () => {
    expect(worstGauge([{ key: "session", pct: 10 }, { key: "weekly", pct: 72 }, { key: "x", pct: 5 }])).toEqual({ key: "weekly", pct: 72 });
  });
});

describe("gaugeShort", () => {
  it("maps known keys", () => {
    expect(gaugeShort("session")).toBe("S");
    expect(gaugeShort("weekly")).toBe("W");
    expect(gaugeShort("weekly-fable")).toBe("F");
    expect(gaugeShort("weekly_fable_opus")).toBe("F");
  });
  it("falls back to the upper-cased first letter", () => expect(gaugeShort("opus")).toBe("O"));
});
