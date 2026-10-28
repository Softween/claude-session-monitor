import { describe, expect, it } from "vitest";

import { REMOTE_LINE_MAX, sanitizeRemoteLine } from "../src/remoteInput";

const rejected = { ok: false, reason: "rejected input" };

describe("sanitizeRemoteLine", () => {
  it("collapses line breaks into one space and trims", () => {
    expect(sanitizeRemoteLine("  fix the login\r\n\nthen run the tests \n")).toEqual({ ok: true, line: "fix the login then run the tests" });
    expect(sanitizeRemoteLine("resume")).toEqual({ ok: true, line: "resume" });
  });

  it("rejects control characters and Unicode line separators", () => {
    for (const bad of ["tab\there", "bell\u0007", "esc \u001b[31m red", "nul\u0000", "del\u007f", "c1\u0085", "c1\u009b", "ls\u2028x", "ps\u2029x"]) {
      expect(sanitizeRemoteLine(bad)).toEqual(rejected);
    }
  });

  it("rejects a leading !, / or # (after the trim and the line-break collapse)", () => {
    for (const bad of ["!rm -rf ~", " /model opus", "#remember this", "\n!ls", "\r\n/login"]) {
      expect(sanitizeRemoteLine(bad)).toEqual(rejected);
    }
  });

  it("keeps !, / and # later in the text", () => {
    expect(sanitizeRemoteLine("deploy it now!")).toEqual({ ok: true, line: "deploy it now!" });
    expect(sanitizeRemoteLine("check src/a.ts and issue #12")).toEqual({ ok: true, line: "check src/a.ts and issue #12" });
  });

  it("rejects more than 2000 characters and empty input", () => {
    expect(REMOTE_LINE_MAX).toBe(2000);
    expect(sanitizeRemoteLine("a".repeat(2000))).toEqual({ ok: true, line: "a".repeat(2000) });
    expect(sanitizeRemoteLine("a".repeat(2001))).toEqual(rejected);
    expect(sanitizeRemoteLine("a".repeat(1000) + "\n" + "b".repeat(999))).toMatchObject({ ok: true });
    expect(sanitizeRemoteLine("")).toEqual(rejected);
    expect(sanitizeRemoteLine(" \r\n \n ")).toEqual(rejected);
  });
});
