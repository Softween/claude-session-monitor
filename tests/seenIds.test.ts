import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SEEN_RETAIN_MS, SeenIds, nodeSeenFs } from "../src/seenIds";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A store folder inside a fresh temp dir (the folder itself does not exist yet). */
function storeDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "csm-seen-"));
  dirs.push(root);
  return path.join(root, "remote", "seen");
}

/** One window's store on `dir` with its own clock. */
function store(dir: string, clock: { now: number }): SeenIds {
  return new SeenIds({ dir, now: () => clock.now, fs: nodeSeenFs });
}

describe("SeenIds", () => {
  it("records an id once for every window on the same folder: a second claim, from any window, is refused", () => {
    const dir = storeDir();
    const clock = { now: NOW };
    const a = store(dir, clock);
    const b = store(dir, clock);
    expect(a.claim("cmd-1")).toBe(true);
    expect(b.claim("cmd-1")).toBe(false);
    expect(a.claim("cmd-1")).toBe(false);
    expect(b.claim("cmd-2")).toBe(true);
    expect(a.has("cmd-2")).toBe(true);
    expect(a.has("cmd-3")).toBe(false);
  });

  it("keeps a record for 10 minutes, then removes it and lets the id through again", () => {
    const dir = storeDir();
    const clock = { now: NOW };
    const seen = store(dir, clock);
    expect(SEEN_RETAIN_MS).toBe(600_000);
    expect(seen.claim("cmd-1")).toBe(true);
    clock.now = NOW + SEEN_RETAIN_MS - 1;
    expect(seen.has("cmd-1")).toBe(true);
    expect(seen.claim("cmd-1")).toBe(false);
    clock.now = NOW + SEEN_RETAIN_MS;
    expect(seen.has("cmd-1")).toBe(false);
    seen.prune();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(seen.claim("cmd-1")).toBe(true);
  });

  it("names a record after the id's hash, so an id is never a path", () => {
    const dir = storeDir();
    const seen = store(dir, { now: NOW });
    expect(seen.claim("../../escape")).toBe(true);
    expect(seen.claim("a/b")).toBe(true);
    const names = fs.readdirSync(dir);
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(fs.readdirSync(path.dirname(dir))).toEqual(["seen"]);
  });

  it("prune removes old and unreadable records and leaves temp files and other names alone", () => {
    const dir = storeDir();
    const clock = { now: NOW };
    const seen = store(dir, clock);
    seen.claim("old");
    clock.now = NOW + SEEN_RETAIN_MS / 2;
    seen.claim("fresh");
    const unreadable = path.join(dir, `${"0".repeat(32)}.json`);
    fs.writeFileSync(unreadable, "not json");
    const temp = path.join(dir, `.${"1".repeat(32)}.json.123.abc.tmp`);
    fs.writeFileSync(temp, JSON.stringify({ ts: 0 }));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    clock.now = NOW + SEEN_RETAIN_MS + 1;
    seen.prune();
    expect(seen.has("fresh")).toBe(true);
    expect(seen.has("old")).toBe(false);
    const left = fs.readdirSync(dir);
    expect(left.filter((n) => /^[0-9a-f]{32}\.json$/.test(n))).toHaveLength(1); // the fresh record
    expect(left).toContain(path.basename(temp));
    expect(left).toContain("notes.txt");
    expect(fs.existsSync(unreadable)).toBe(false);
  });

  it("nodeSeenFs creates a record whole with private modes, refuses an existing one and leaves no temp file", () => {
    const dir = storeDir();
    const file = path.join(dir, `${"a".repeat(32)}.json`);
    expect(nodeSeenFs.create(file, '{"ts":1}')).toBe(true);
    expect(nodeSeenFs.create(file, '{"ts":2}')).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe('{"ts":1}');
    expect(fs.readdirSync(dir)).toEqual([path.basename(file)]);
    if (process.platform !== "win32") {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(nodeSeenFs.list(path.join(dir, "missing"))).toEqual([]);
    expect(nodeSeenFs.read(path.join(dir, "missing.json"))).toBeUndefined();
  });
});
