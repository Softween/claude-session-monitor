/**
 * seenIds.ts - one record, shared by every window, of the ids that were already
 * taken: a folder with one file per id, named after the id's sha256 (folder
 * 0700, files 0600), holding when it was recorded. Recording an id creates its
 * file atomically and fails while the file exists, so of two windows that get
 * the same id at the same time only one goes on. Records are kept for 10
 * minutes (a remote command stays valid for 2), then removed, and so is a temp
 * file a crash left once it is 2 minutes old. The remote bridge records each
 * command id before it runs (remoteForward.ts). No vscode import: the clock and
 * the file system come in through SeenDeps.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { readText } from "./continuity";

export const SEEN_RETAIN_MS = 10 * 60_000;
const TEMP_MAX_AGE_MS = 2 * 60_000; // a create takes milliseconds: a temp file this old was left by a crash
const RECORD = /^[0-9a-f]{32}\.json$/;

/** The file operations of the store; nodeSeenFs is the real one. */
export interface SeenFs {
  /** Creates `file` holding `text` unless it exists, atomically (the folder is created 0700); false when it exists. */
  create(file: string, text: string): boolean;
  read(file: string): string | undefined; // undefined when missing or unreadable
  list(dir: string): string[]; // [] when the folder is missing
  remove(file: string): void;
  mtimeMs(file: string): number | undefined; // undefined when missing
}

export interface SeenDeps {
  dir: string; // the store's folder
  now(): number; // epoch ms
  fs: SeenFs;
  retainMs?: number; // how long a record is kept (SEEN_RETAIN_MS)
}

/** The ids recorded in the last `retainMs`, shared by every window that uses the same folder. */
export class SeenIds {
  constructor(private readonly deps: SeenDeps) {}

  private get retainMs(): number {
    return this.deps.retainMs ?? SEEN_RETAIN_MS;
  }

  /** Records `id` now: true when it was not recorded yet, false when it was (within the retention). */
  claim(id: string): boolean {
    this.prune();
    return this.deps.fs.create(this.fileOf(id), JSON.stringify({ ts: this.deps.now() }));
  }

  /** Whether `id` is recorded within the retention. */
  has(id: string): boolean {
    const ts = this.recordedAt(this.fileOf(id));
    return ts !== undefined && this.deps.now() - ts < this.retainMs;
  }

  /** Removes the records older than the retention, the unreadable ones and the temp files a crash left. */
  prune(): void {
    const now = this.deps.now();
    for (const name of this.deps.fs.list(this.deps.dir)) {
      const file = path.join(this.deps.dir, name);
      if (!RECORD.test(name)) {
        // A temp file belongs to a create in progress unless it is 2 minutes old.
        const mtime = name.endsWith(".tmp") ? this.deps.fs.mtimeMs(file) : undefined;
        if (mtime !== undefined && now - mtime > TEMP_MAX_AGE_MS) this.deps.fs.remove(file);
        continue;
      }
      const ts = this.recordedAt(file);
      if (ts === undefined || now - ts >= this.retainMs) this.deps.fs.remove(file);
    }
  }

  private fileOf(id: string): string {
    return path.join(this.deps.dir, `${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`);
  }

  private recordedAt(file: string): number | undefined {
    try {
      const ts = (JSON.parse(this.deps.fs.read(file) ?? "") as { ts?: unknown } | null)?.ts;
      return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * The real file system. create writes a temp file (0600) and hard-links it to
 * the record's name: the link fails while the name exists, and a reader never
 * sees a record without its time.
 */
export const nodeSeenFs: SeenFs = {
  create(file, text) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
    try {
      fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
      fs.linkSync(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  },
  read: readText,
  list(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  remove(file) {
    fs.rmSync(file, { force: true });
  },
  mtimeMs(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  },
};
