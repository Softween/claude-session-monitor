import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readHookStatuses,
  findRecentTranscripts,
  cleanupMonitorFiles,
  cleanupEndedMonitorFiles,
} from "../src/core";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-io-"));
});
afterEach(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const nowSec = () => Date.now() / 1000;
const backdate = (p: string, secAgo: number) => fs.utimesSync(p, nowSec() - secAgo, nowSec() - secAgo);

describe("readHookStatuses", () => {
  it("reads valid hook JSON and skips non-json / invalid / non-.json", () => {
    fs.writeFileSync(path.join(tmp, "a.json"), JSON.stringify({ session_id: "a", state: "working", ts: nowSec() }));
    fs.writeFileSync(path.join(tmp, "b.json"), "not json {{");
    fs.writeFileSync(path.join(tmp, "c.txt"), JSON.stringify({ session_id: "c" }));
    fs.writeFileSync(path.join(tmp, "d.json"), JSON.stringify({ state: "x" })); // no session_id
    const m = readHookStatuses(tmp);
    expect(m.size).toBe(1);
    expect(m.get("a")?.state).toBe("working");
  });
  it("returns an empty map for a missing dir", () => {
    expect(readHookStatuses(path.join(tmp, "nope")).size).toBe(0);
  });
});

describe("findRecentTranscripts", () => {
  function project() {
    const root = path.join(tmp, "projects");
    fs.mkdirSync(root);
    const repo = path.join(root, "-Users-x-repo");
    const obs = path.join(root, "-Users-x--claude-mem-observer-sessions");
    fs.mkdirSync(repo);
    fs.mkdirSync(obs);
    fs.writeFileSync(path.join(repo, "s1.jsonl"), "{}");
    fs.writeFileSync(path.join(repo, "s2.jsonl"), "{}");
    fs.writeFileSync(path.join(obs, "o1.jsonl"), "{}");
    const old = path.join(repo, "old.jsonl");
    fs.writeFileSync(old, "{}");
    backdate(old, 7200); // 2h old
    return root;
  }

  it("returns recent .jsonl, excludes observer dirs and too-old files", () => {
    const root = project();
    const ids = findRecentTranscripts(3600 * 1000, 100, nowSec(), undefined, root).map((r) => r.sessionId);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).not.toContain("o1");
    expect(ids).not.toContain("old");
  });
  it("respects the limit and the onlyCwd filter", () => {
    const root = project();
    expect(findRecentTranscripts(3600 * 1000, 1, nowSec(), undefined, root).length).toBe(1);
    const only = findRecentTranscripts(3600 * 1000, 100, nowSec(), "/Users/x/repo", root);
    expect(only.length).toBe(2); // both repo sessions, none from elsewhere
  });
});

describe("cleanupMonitorFiles", () => {
  it("removes files older than maxAge and keeps fresh ones", () => {
    fs.writeFileSync(path.join(tmp, "fresh.json"), "{}");
    const stale = path.join(tmp, "stale.json");
    fs.writeFileSync(stale, "{}");
    backdate(stale, 7200); // 2h old
    const removed = cleanupMonitorFiles(3600 * 1000, nowSec(), tmp); // 1h threshold
    expect(removed).toBe(1);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(path.join(tmp, "fresh.json"))).toBe(true);
  });
});

describe("cleanupEndedMonitorFiles", () => {
  it("removes ended + stale sessions but keeps live ones", () => {
    fs.writeFileSync(path.join(tmp, "ended.json"), JSON.stringify({ session_id: "e", state: "ended" }));
    fs.writeFileSync(path.join(tmp, "live.json"), JSON.stringify({ session_id: "l", state: "working" }));
    const staleLive = path.join(tmp, "stale.json");
    fs.writeFileSync(staleLive, JSON.stringify({ session_id: "s", state: "working" }));
    backdate(staleLive, 13 * 3600); // >12h old
    const removed = cleanupEndedMonitorFiles(nowSec(), 12 * 3600 * 1000, tmp);
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(tmp, "live.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "ended.json"))).toBe(false);
  });
});
