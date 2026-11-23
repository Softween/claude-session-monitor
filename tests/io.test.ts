import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  readHookStatuses,
  findRecentTranscripts,
  cleanupMonitorFiles,
  cleanupEndedMonitorFiles,
  type HookCache,
} from "../src/core";

// The path of every file read, so a test can tell which files a call read.
const readPaths = vi.hoisted(() => [] as string[]);
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  const note = <F extends (...a: any[]) => any>(fn: F) => ((p: unknown, ...rest: unknown[]) => {
    readPaths.push(String(p));
    return fn(p, ...rest);
  }) as unknown as F;
  return {
    ...real,
    readFileSync: note(real.readFileSync),
    promises: { ...real.promises, readFile: note(real.promises.readFile.bind(real.promises)) },
  };
});

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
  it("reads valid hook JSON and skips non-json / invalid / non-.json", async () => {
    fs.writeFileSync(path.join(tmp, "a.json"), JSON.stringify({ session_id: "a", state: "working", ts: nowSec() }));
    fs.writeFileSync(path.join(tmp, "b.json"), "not json {{");
    fs.writeFileSync(path.join(tmp, "c.txt"), JSON.stringify({ session_id: "c" }));
    fs.writeFileSync(path.join(tmp, "d.json"), JSON.stringify({ state: "x" })); // no session_id
    const m = await readHookStatuses(tmp);
    expect(m.size).toBe(1);
    expect(m.get("a")?.state).toBe("working");
  });
  it("returns an empty map for a missing dir", async () => {
    expect((await readHookStatuses(path.join(tmp, "nope"))).size).toBe(0);
  });
  it("never reads the monitor's own state files, and reads a record again only when it changed", async () => {
    const record = (id: string, state: string) => JSON.stringify({ session_id: id, state, ts: nowSec() });
    fs.writeFileSync(path.join(tmp, "a.json"), record("a", "working"));
    fs.writeFileSync(path.join(tmp, "b.json"), record("b", "idle"));
    for (const f of ["accounts.json", "token-offsets.json", "token-buckets.json", "official-usage.json", "official-usage-x.json", "limits.json", "statusline-last-raw.json"]) {
      fs.writeFileSync(path.join(tmp, f), JSON.stringify({ session_id: "a" }));
    }
    const cache: HookCache = new Map();
    readPaths.length = 0;
    const first = await readHookStatuses(tmp, cache);
    expect([...first.keys()].sort()).toEqual(["a", "b"]);
    expect(readPaths.map((p) => path.basename(p)).sort()).toEqual(["a.json", "b.json"]);

    readPaths.length = 0;
    expect((await readHookStatuses(tmp, cache)).get("a")?.state).toBe("working");
    expect(readPaths).toEqual([]); // nothing changed: nothing read

    fs.writeFileSync(path.join(tmp, "a.json"), record("a", "waiting"));
    fs.rmSync(path.join(tmp, "b.json"));
    const third = await readHookStatuses(tmp, cache);
    expect(readPaths.map((p) => path.basename(p))).toEqual(["a.json"]);
    expect(third.get("a")?.state).toBe("waiting");
    expect(third.has("b")).toBe(false);
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

  it("returns recent .jsonl, excludes observer dirs and too-old files", async () => {
    const root = project();
    const ids = (await findRecentTranscripts(3600 * 1000, 100, nowSec(), undefined, root)).map((r) => r.sessionId);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
    expect(ids).not.toContain("o1");
    expect(ids).not.toContain("old");
  });
  it("respects the limit and the onlyCwd filter", async () => {
    const root = project();
    expect((await findRecentTranscripts(3600 * 1000, 1, nowSec(), undefined, root)).length).toBe(1);
    const only = await findRecentTranscripts(3600 * 1000, 100, nowSec(), "/Users/x/repo", root);
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
    const accounts = path.join(tmp, "accounts.json");
    fs.writeFileSync(accounts, JSON.stringify({ v: 1, accounts: [] }));
    const staleLive = path.join(tmp, "stale.json");
    fs.writeFileSync(staleLive, JSON.stringify({ session_id: "s", state: "working" }));
    backdate(staleLive, 13 * 3600); // >12h old
    backdate(accounts, 13 * 3600); // infrastructure state must never be treated as a session
    const removed = cleanupEndedMonitorFiles(nowSec(), 12 * 3600 * 1000, tmp);
    expect(removed).toBe(2);
    expect(fs.existsSync(path.join(tmp, "live.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmp, "ended.json"))).toBe(false);
    expect(fs.existsSync(accounts)).toBe(true);
  });
});
