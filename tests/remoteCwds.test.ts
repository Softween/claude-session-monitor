import { describe, expect, it } from "vitest";

import {
  ALLOWED_CWDS_MAX,
  SEEN_TTL_MS,
  allowedCwds,
  checkNewSession,
  isInside,
  isUsablePath,
  mergeSeen,
  withoutPaths,
} from "../src/remoteCwds";

const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
const any = () => true;

describe("isUsablePath", () => {
  it("takes absolute, normalized paths up to 512 characters", () => {
    expect(isUsablePath("/Users/u/Developer/REPOS")).toBe(true);
    expect(isUsablePath("/Users/u/My Repo (copy)")).toBe(true);
    expect(isUsablePath("/" + "a".repeat(511))).toBe(true);
  });

  it("refuses relative, root, trailing-slash, dot-segment, control-character and overlong paths", () => {
    for (const p of [
      "Users/u/repo",
      "~/repo",
      "/",
      "/Users/u/repo/",
      "/Users/u/repo/../.ssh",
      "/Users/u/./repo",
      "/Users//u",
      "/Users/u/re\npo",
      "/Users/u/re\u2028po",
      "/" + "a".repeat(512),
      "",
      42,
      null,
    ]) {
      expect(isUsablePath(p)).toBe(false);
    }
  });
});

describe("isInside", () => {
  it("is the folder itself or a path under it, never a sibling sharing its prefix", () => {
    expect(isInside("/r/repo", "/r/repo")).toBe(true);
    expect(isInside("/r/repo/app", "/r/repo")).toBe(true);
    expect(isInside("/r/repo-two", "/r/repo")).toBe(false);
    expect(isInside("/r", "/r/repo")).toBe(false);
  });
});

describe("mergeSeen", () => {
  it("keeps the newest time per path and drops entries past 7 days, from the future or unusable", () => {
    const prev = { "/a": NOW - DAY, "/b": NOW - SEEN_TTL_MS - 1, "/c/": NOW, "/d": "x", "/e": NOW + 120_000 };
    expect(mergeSeen(prev, [["/a", NOW - 5], ["/a", NOW - 9], ["rel", NOW]], NOW)).toEqual({ "/a": NOW - 5 });
  });

  it("orders newest first and keeps at most `cap` entries", () => {
    const seen = Array.from({ length: 5 }, (_, i) => [`/p${i}`, NOW - i * 1000] as const);
    expect(Object.keys(mergeSeen({}, seen, NOW, 3))).toEqual(["/p0", "/p1", "/p2"]);
  });

  it("treats a stored value that is not a map as empty", () => {
    for (const prev of [undefined, null, [], "x", 5]) expect(mergeSeen(prev, [["/a", NOW]], NOW)).toEqual({ "/a": NOW });
  });
});

describe("withoutPaths", () => {
  it("drops only the named paths", () => {
    expect(withoutPaths({ "/a": 1, "/b": 2 }, ["/a", "/c"])).toEqual({ "/b": 2 });
  });
});

describe("allowedCwds", () => {
  const trusted = { "/r/REPOS": NOW - 1000 };

  it("lists trusted folders and the session cwds inside them, newest first, each once", () => {
    const sessions = {
      "/r/REPOS/personal/app": NOW - 10,
      "/r/REPOS": NOW - 500,
      "/r/REPOS/old": NOW - DAY,
      "/private/tmp/scratch": NOW,
      "/r/REPOS-copy": NOW,
    };
    expect(allowedCwds({ trusted, sessions, now: NOW, exists: any })).toEqual(["/r/REPOS/personal/app", "/r/REPOS", "/r/REPOS/old"]);
  });

  it("leaves out every session cwd when no folder is trusted", () => {
    expect(allowedCwds({ trusted: {}, sessions: { "/r/REPOS/app": NOW }, now: NOW, exists: any })).toEqual([]);
  });

  it("drops trusted folders and sessions older than 7 days", () => {
    const old = { "/r/REPOS": NOW - SEEN_TTL_MS - 1 };
    expect(allowedCwds({ trusted: old, sessions: { "/r/REPOS/app": NOW }, now: NOW, exists: any })).toEqual([]);
    expect(allowedCwds({ trusted, sessions: { "/r/REPOS/app": NOW - SEEN_TTL_MS - 1 }, now: NOW, exists: any })).toEqual(["/r/REPOS"]);
  });

  it("keeps only folders `exists` accepts and stops at 30", () => {
    const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`/r/REPOS/p${i}`, NOW - i]));
    const list = allowedCwds({ trusted, sessions, now: NOW, exists: (p) => p !== "/r/REPOS/p0" });
    expect(list).toHaveLength(ALLOWED_CWDS_MAX);
    expect(list[0]).toBe("/r/REPOS/p1");
    expect(list).not.toContain("/r/REPOS/p0");
  });
});

describe("checkNewSession", () => {
  const allowed = ["/r/REPOS", "/r/REPOS/personal/app"];

  it("accepts a folder that is exactly in the list, with or without a first message", () => {
    expect(checkNewSession({ cwd: "/r/REPOS/personal/app" }, allowed)).toEqual({ ok: true, cwd: "/r/REPOS/personal/app", line: null });
    expect(checkNewSession({ cwd: "/r/REPOS", text: "" }, allowed)).toEqual({ ok: true, cwd: "/r/REPOS", line: null });
    expect(checkNewSession({ cwd: "/r/REPOS", text: null }, allowed)).toEqual({ ok: true, cwd: "/r/REPOS", line: null });
    expect(checkNewSession({ cwd: "/r/REPOS", text: " merhaba, bu bir test; hiçbir şey yapma " }, allowed)).toEqual({
      ok: true,
      cwd: "/r/REPOS",
      line: "merhaba, bu bir test; hiçbir şey yapma",
    });
    expect(checkNewSession({ cwd: "/r/REPOS", text: "€".repeat(1365) }, allowed)).toMatchObject({ ok: true }); // 4095 bytes
    expect(checkNewSession({ cwd: "/r/REPOS", text: "satır bir\nsatır iki" }, allowed)).toEqual({ ok: true, cwd: "/r/REPOS", line: "satır bir satır iki" });
  });

  it("refuses any folder not exactly in the list", () => {
    for (const cwd of ["/r/REPOS/", "/r/REPOS/personal", "/r/REPOS/personal/app/../..", "/r/repos", "/etc", "", undefined, 7]) {
      expect(checkNewSession({ cwd }, allowed)).toEqual({ ok: false, message: "folder not allowed on this Mac" });
    }
  });

  it("refuses a first message over 4 KB in bytes, with control characters or a leading ! / #", () => {
    const refused = { ok: false, message: "first message: rejected input" };
    expect(checkNewSession({ cwd: "/r/REPOS", text: "€".repeat(1366) }, allowed)).toEqual(refused); // 4098 bytes, 1366 characters
    for (const text of ["!rm -rf ~", "/clear", "#remember this", "  !ls", "a\u0007b", "a\u001b[2Jb", "   ", 12]) {
      expect(checkNewSession({ cwd: "/r/REPOS", text }, allowed)).toEqual(refused);
    }
  });
});
