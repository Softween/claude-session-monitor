import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A disk that fills up while a file is written: once `full` is on, writeFileSync creates the file empty, then fails.
const disk = vi.hoisted(() => ({ full: false }));
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (!disk.full) return real.writeFileSync(...args);
      real.writeFileSync(args[0], "", args[2]);
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
    },
  };
});

import { SEEN_RETAIN_MS, SeenIds, nodeSeenFs } from "../src/seenIds";

const NOW = Date.parse("2026-11-21T12:00:00.000Z");
const dirs: string[] = [];
afterEach(() => {
  disk.full = false;
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

  it("prune removes old and unreadable records and leaves a fresh temp file and other names alone", () => {
    const dir = storeDir();
    const clock = { now: NOW };
    const seen = store(dir, clock);
    seen.claim("old");
    clock.now = NOW + SEEN_RETAIN_MS / 2;
    seen.claim("fresh");
    const unreadable = path.join(dir, `${"0".repeat(32)}.json`);
    fs.writeFileSync(unreadable, "not json");
    clock.now = NOW + SEEN_RETAIN_MS + 1;
    const temp = path.join(dir, `.${"1".repeat(32)}.json.123.abc.tmp`); // a create in progress
    fs.writeFileSync(temp, JSON.stringify({ ts: 0 }));
    fs.utimesSync(temp, new Date(clock.now), new Date(clock.now));
    fs.writeFileSync(path.join(dir, "notes.txt"), "x");
    seen.prune();
    expect(seen.has("fresh")).toBe(true);
    expect(seen.has("old")).toBe(false);
    const left = fs.readdirSync(dir);
    expect(left.filter((n) => /^[0-9a-f]{32}\.json$/.test(n))).toHaveLength(1); // the fresh record
    expect(left).toContain(path.basename(temp));
    expect(left).toContain("notes.txt");
    expect(fs.existsSync(unreadable)).toBe(false);
  });

  it("prune removes a temp file a crash left once it is 2 minutes old", () => {
    const dir = storeDir();
    const clock = { now: Date.now() };
    const seen = store(dir, clock);
    seen.claim("cmd-1"); // creates the folder
    const crashed = path.join(dir, `.${"1".repeat(32)}.json.123.abc.tmp`);
    const recent = path.join(dir, `.${"2".repeat(32)}.json.456.def.tmp`);
    for (const file of [crashed, recent]) fs.writeFileSync(file, JSON.stringify({ ts: clock.now }));
    const old = new Date(clock.now - 2 * 60_000 - 1_000);
    fs.utimesSync(crashed, old, old);
    const young = new Date(clock.now - 2 * 60_000 + 5_000);
    fs.utimesSync(recent, young, young);
    seen.prune();
    expect(fs.existsSync(crashed)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(seen.has("cmd-1")).toBe(true);
  });

  it("nodeSeenFs leaves no temp file when writing it fails", () => {
    const dir = storeDir();
    fs.mkdirSync(dir, { recursive: true });
    disk.full = true;
    expect(() => nodeSeenFs.create(path.join(dir, `${"a".repeat(32)}.json`), '{"ts":1}')).toThrow("ENOSPC");
    disk.full = false;
    expect(fs.readdirSync(dir)).toEqual([]);
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
