import { describe, expect, it } from "vitest";

import { parseParentPid, pickSessionTerminal } from "../src/terminalMatch";

const eq = (a: string, b: string) => a === b;

describe("pickSessionTerminal", () => {
  const terms = [
    { name: "zsh", pid: 100 },
    { name: "Claude · fix login", pid: 200 },
    { name: "Claude · fix login", pid: 300 },
  ];
  it("prefers the terminal whose shell pid is an ancestor of the session", () => {
    expect(pickSessionTerminal(terms, ["Claude · fix login"], [4242, 300, 1], eq)).toBe(2);
  });
  it("falls back to a unique name match", () => {
    const t = [{ name: "zsh", pid: 100 }, { name: "Claude · fix login", pid: 200 }];
    expect(pickSessionTerminal(t, ["Claude · fix login"], [9999], eq)).toBe(1);
  });
  it("returns -1 when several names match and no pid matches", () => {
    expect(pickSessionTerminal(terms, ["Claude · fix login"], [9999], eq)).toBe(-1);
  });
  it("returns -1 when nothing matches", () => {
    expect(pickSessionTerminal(terms, ["Claude · other"], [], eq)).toBe(-1);
    expect(pickSessionTerminal([], ["Claude · fix login"], [100], eq)).toBe(-1);
  });
  it("ignores terminals without a pid for the process-tree match", () => {
    const t = [{ name: "Claude · fix login" }, { name: "Claude · fix login", pid: 300 }];
    expect(pickSessionTerminal(t, ["Claude · fix login"], [300], eq)).toBe(1);
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
