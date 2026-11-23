import { describe, expect, it } from "vitest";
import { projectOf, readProjectRules } from "../src/projects";

const rules = readProjectRules([
  { name: "askdalam", patterns: ["askdalam", "dalam"] },
  { name: "getfund", patterns: ["getfund", "glossgo-fund"] },
  { name: "glossgo", patterns: ["glossgo"] },
]);

describe("readProjectRules", () => {
  it("drops malformed, duplicate and reserved entries and lowercases patterns", () => {
    expect(readProjectRules([{ name: "A", patterns: ["Foo", 3, " "] }, { name: "A", patterns: ["x"] }, { name: "other", patterns: ["y"] }, { patterns: ["z"] }, "x"])).toEqual([
      { name: "A", patterns: ["foo"] },
    ]);
    expect(readProjectRules(undefined)).toEqual([]);
  });
});

describe("projectOf", () => {
  it("is undefined without rules", () => {
    expect(projectOf([], { cwd: "/r/glossgo/glossgo-be" })).toBeUndefined();
  });

  it("takes the cwd first, the more specific rule winning", () => {
    expect(projectOf(rules, { cwd: "/r/glossgo/glossgo-fund", title: "glossgo bug" })).toBe("getfund");
    expect(projectOf(rules, { cwd: "/r/external/askdalam", title: "getfund deck" })).toBe("askdalam");
  });

  it("uses a title that names one project when the cwd names none", () => {
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Getfund için rakip siteler", refs: ["cd glossgo/glossgo-be"] })).toBe("getfund");
  });

  it("does not count getfund's glossgo-fund as glossgo in a title", () => {
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "glossgo-fund deploy" })).toBe("getfund");
  });

  it("settles a title naming two projects by tool-call paths", () => {
    const refs = ["/r/glossgo/glossgo-fund/a.ts", "/r/glossgo/glossgo-fund/b.ts", "cd /r/glossgo/glossgo-be"];
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Glossgo ve getfund", refs })).toBe("getfund");
  });

  it("falls back to the most hit project in tool calls, a tie to the newest", () => {
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Bus sorunu", refs: ["/r/external/askdalam/x", "/r/glossgo/glossgo-fe/y"] })).toBe("glossgo");
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Bus sorunu", refs: ["/r/glossgo/glossgo-fe/y", "/r/external/askdalam/x"] })).toBe("askdalam");
  });

  it("then the last prompt, then nothing", () => {
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Sorun çözümü", prompt: "dalam admin paneli" })).toBe("askdalam");
    expect(projectOf(rules, { cwd: "/r/REPOS", title: "Farsight villa listings page" })).toBeUndefined();
  });
});
