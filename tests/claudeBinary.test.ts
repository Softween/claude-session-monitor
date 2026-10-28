import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { claudeFallbacks, isExecutableFile, resolveClaudeBinary } from "../src/claudeBinary";

const HOME = "/Users/someone";
const only = (...ok: string[]) => (p: string) => ok.includes(p);

describe("resolveClaudeBinary", () => {
  it("takes the first line of `which claude` when it is an absolute executable", async () => {
    const which = async () => "/Users/someone/.local/bin/claude\n";
    expect(await resolveClaudeBinary({ which, home: HOME, isExecutable: only("/Users/someone/.local/bin/claude") })).toBe(
      "/Users/someone/.local/bin/claude",
    );
  });

  it("falls back in order when which fails, throws, or answers a relative or unusable path", async () => {
    expect(claudeFallbacks(HOME)).toEqual(["/Users/someone/.claude/local/claude", "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
    const isExecutable = only("/opt/homebrew/bin/claude", "/usr/local/bin/claude");
    expect(await resolveClaudeBinary({ which: async () => null, home: HOME, isExecutable })).toBe("/opt/homebrew/bin/claude");
    expect(await resolveClaudeBinary({ which: () => Promise.reject(new Error("no which")), home: HOME, isExecutable })).toBe(
      "/opt/homebrew/bin/claude",
    );
    expect(await resolveClaudeBinary({ which: async () => "claude", home: HOME, isExecutable })).toBe("/opt/homebrew/bin/claude");
    expect(await resolveClaudeBinary({ which: async () => "/gone/claude", home: HOME, isExecutable })).toBe("/opt/homebrew/bin/claude");
    expect(
      await resolveClaudeBinary({ which: async () => null, home: HOME, isExecutable: only("/Users/someone/.claude/local/claude", "/usr/local/bin/claude") }),
    ).toBe("/Users/someone/.claude/local/claude");
  });

  it("is undefined when nothing is executable", async () => {
    expect(await resolveClaudeBinary({ which: async () => "", home: HOME, isExecutable: () => false })).toBeUndefined();
  });
});

describe("isExecutableFile", () => {
  it("accepts an executable regular file only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-claude-bin-"));
    try {
      const exe = path.join(dir, "claude");
      const plain = path.join(dir, "notes.txt");
      fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(plain, "x", { mode: 0o644 });
      expect(isExecutableFile(exe)).toBe(true);
      expect(isExecutableFile(plain)).toBe(false);
      expect(isExecutableFile(dir)).toBe(false);
      expect(isExecutableFile(path.join(dir, "missing"))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
