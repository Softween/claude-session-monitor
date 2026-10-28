import { describe, expect, it } from "vitest";

import { parseParentPid, pickSessionTerminal, pickUniqueLabel } from "../src/terminalMatch";

describe("pickSessionTerminal", () => {
  const terms = [
    { name: "zsh", pid: 100 },
    { name: "Claude · fix login", pid: 200 },
    { name: "Claude · fix login", pid: 300 },
  ];
  it("prefers the terminal whose shell pid is an ancestor of the session", () => {
    expect(pickSessionTerminal(terms, ["Claude · fix login"], [4242, 300, 1])).toBe(2);
  });
  it("falls back to the one terminal whose name equals a candidate (case and whitespace only)", () => {
    const t = [{ name: "zsh", pid: 100 }, { name: "Claude · fix login", pid: 200 }];
    expect(pickSessionTerminal(t, ["Claude · fix login"], [9999])).toBe(1);
    expect(pickSessionTerminal(t, ["  claude ·   FIX login "], [9999])).toBe(1);
  });
  it("returns -1 when several terminals carry the matching name and no pid matches", () => {
    expect(pickSessionTerminal(terms, ["Claude · fix login"], [9999])).toBe(-1);
  });
  it("never matches by prefix; a truncated name only matches a title that truncates to it", () => {
    const t = [{ name: "Claude · fix login bug in auth", pid: 1 }, { name: "Getfund.space affiliate …", pid: 2 }];
    expect(pickSessionTerminal(t, ["Claude · fix login"], [])).toBe(-1);
    expect(pickSessionTerminal(t, ["Claude · fix login bug in auth flow"], [])).toBe(-1);
    expect(pickSessionTerminal(t, ["Getfund.space affiliate"], [])).toBe(-1);
    expect(pickSessionTerminal(t, ["Getfund.space affiliate modeli"], [])).toBe(1);
  });
  it("refuses a name another listed session matches too", () => {
    const t = [{ name: "Getfund.space affiliate …", pid: 2 }];
    expect(pickSessionTerminal(t, ["Getfund.space affiliate modeli"], [], ["Getfund.space affiliate program"])).toBe(-1);
    expect(pickSessionTerminal(t, ["Getfund.space affiliate modeli"], [2], ["Getfund.space affiliate program"])).toBe(0); // pid stays exact
  });
  it("ignores names shorter than 8 characters", () => {
    expect(pickSessionTerminal([{ name: "resume" }, { name: "zsh" }], ["resume", "zsh"], [])).toBe(-1);
  });
  it("returns -1 when nothing matches", () => {
    expect(pickSessionTerminal(terms, ["Claude · other"], [])).toBe(-1);
    expect(pickSessionTerminal([], ["Claude · fix login"], [100])).toBe(-1);
  });
  it("ignores terminals without a pid for the process-tree match", () => {
    const t = [{ name: "Claude · fix login" }, { name: "Claude · fix login", pid: 300 }];
    expect(pickSessionTerminal(t, ["Claude · fix login"], [300])).toBe(1);
  });
});

describe("pickUniqueLabel", () => {
  it("returns the index of the only label equal to a candidate", () => {
    expect(pickUniqueLabel(["Mail aksiyon listesi", "Kalan iş", "yap"], ["kalan iş"])).toBe(1);
    expect(pickUniqueLabel(["Mail aksiyon listesi", "Kalan iş"], ["nothing here", "Mail aksiyon listesi"])).toBe(0);
  });
  it("refuses the real pair of tabs whose two sessions share their first 24 characters", () => {
    const sunumu = "Getfund.space ambassador sunumu";
    const teklifi = "Getfund.space ambassador teklifi Instagram mesajı";
    // tabs 8 and 13 of the real dump carry the same label
    expect(pickUniqueLabel(["Kalan iş", "Getfund.space ambassador…", "Getfund.space ambassador…"], [sunumu])).toBe(-1);
    // one tab here, the other session's tab elsewhere: the rival makes it ambiguous
    expect(pickUniqueLabel(["Kalan iş", "Getfund.space ambassador…"], [sunumu])).toBe(1);
    expect(pickUniqueLabel(["Kalan iş", "Getfund.space ambassador…"], [sunumu], [teklifi, "Kalan iş"])).toBe(-1);
    // two listed sessions with the same title, and a rival that matches another label only
    expect(pickUniqueLabel(["Kalan iş", "Getfund.space ambassador…"], ["kalan iş"], ["Kalan iş"])).toBe(-1);
    expect(pickUniqueLabel(["Kalan iş", "Getfund.space ambassador…"], ["kalan iş"], [teklifi])).toBe(0);
  });
  it("returns -1 for none, for duplicates and for empty labels", () => {
    expect(pickUniqueLabel(["Glossgo başvuru takibi"], ["Glossgo başvuru"])).toBe(-1);
    expect(pickUniqueLabel(["Glossgo başvuru takibi", "Glossgo başvuru takibi"], ["Glossgo başvuru takibi"])).toBe(-1);
    expect(pickUniqueLabel(["", "Kalan iş"], ["", "kalan iş"])).toBe(1);
    expect(pickUniqueLabel([], ["Kalan iş"])).toBe(-1);
  });
});

describe("parseParentPid", () => {
  it("parses ps output", () => {
    expect(parseParentPid("  4242\n")).toBe(4242);
  });
  it("rejects garbage and pid 0", () => {
    expect(parseParentPid("")).toBeNull();
    expect(parseParentPid("abc")).toBeNull();
    expect(parseParentPid("0")).toBeNull();
  });
});
