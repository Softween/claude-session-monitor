import { describe, it, expect } from "vitest";
import { stageGuard } from "../src/safeStage";

function guard() {
  const lines: string[] = [];
  return { lines, g: stageGuard((m) => lines.push(m)) };
}

describe("stageGuard", () => {
  it("returns a stage's result, and a throwing stage still lets the next one run", () => {
    const { g } = guard();
    const ran: string[] = [];
    expect(
      g.safe("first", () => {
        ran.push("first");
        throw new Error("boom");
      }),
    ).toBeUndefined();
    expect(
      g.safe("second", () => {
        ran.push("second");
        return 42;
      }),
    ).toBe(42);
    expect(ran).toEqual(["first", "second"]);
  });

  it("logs each distinct error once, with its stage and first stack frames, and keeps a running count of repeats", () => {
    const { g, lines } = guard();
    for (let i = 0; i < 3; i++) {
      g.safe("continuity", () => {
        throw new TypeError("bad state");
      });
    }
    g.safe("continuity", () => {
      throw new Error("other");
    });
    g.safe("limits", () => {
      throw new TypeError("bad state");
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("continuity: TypeError: bad state");
    expect(lines[0]).toContain("safeStage.test.ts");
    expect(lines[1]).toContain("continuity: Error: other");
    expect(lines[2]).toContain("limits: TypeError: bad state");
    expect(g.counts()).toEqual(
      new Map([
        ["continuity: TypeError: bad state", 3],
        ["continuity: Error: other", 1],
        ["limits: TypeError: bad state", 1],
      ]),
    );
  });

  it("records an error the caller caught itself, and a thrown value that is no Error", () => {
    const { g, lines } = guard();
    g.fail("limits", new Error("view gone"));
    g.fail("limits", new Error("view gone"));
    g.safe("sampling", () => {
      throw "plain text";
    });
    expect(lines).toHaveLength(2);
    expect(g.counts().get("limits: Error: view gone")).toBe(2);
    expect(g.counts().get("sampling: plain text")).toBe(1);
  });

  it("past 50 distinct errors, new ones are counted under one other-errors key per stage and logged once", () => {
    const { g, lines } = guard();
    for (let i = 0; i < 60; i++) g.fail("write", new Error(`rename /tmp/.accounts.json.${i}.tmp failed`));
    expect(lines).toHaveLength(51);
    expect(g.counts().size).toBe(51);
    expect(g.counts().get("write: other errors")).toBe(10);
  });
});
