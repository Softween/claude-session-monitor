// Live limit-burn feed: tails Claude Code transcripts (main thread and
// subagents) into a deduped BurnStore. IO only: no vscode import and no timers,
// the caller owns the cadence. Reads are async, chunked and yield between
// chunks, so the first scan (hundreds of MB) never blocks the extension host.

import * as fs from "fs";
import * as path from "path";
import { BurnStore, parseBurnLine, summarize, type BurnLine, type BurnRecord, type BurnSummary } from "./burn";

const DEFAULT_HORIZON_MS = 5.5 * 3_600_000;
const WALK_INTERVAL_MS = 60_000; // full discovery walk at most this often
const HOT_MS = 10 * 60_000; // sessions written this recently get their subagents dir re-listed
const CHUNK_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
const USAGE = Buffer.from('"usage"');
const TITLE = Buffer.from('title"');

interface Tracked {
  readonly file: string;
  readonly sessionId: string;
  readonly sessionDir: string; // <projectsDir>/<slug>/<sessionId>, parent of subagents/
  readonly sub: boolean;
  offset: number; // bytes consumed, always just past a newline
  size: number;
  mtimeMs: number;
}

interface Titles {
  ai?: string;
  custom?: string;
}

const yieldTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function listDir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function statOf(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

export class BurnTracker {
  private readonly projectsDir: string;
  private readonly horizonMs: number;
  private readonly now: () => number;
  private readonly store = new BurnStore();
  private readonly files = new Map<string, Tracked>();
  private readonly titles = new Map<string, Titles>();
  private readonly cwds = new Map<string, string>();
  private lastWalk = -Infinity;
  private inflight: Promise<boolean> | undefined;

  constructor(opts: { projectsDir: string; horizonMs?: number; now?: () => number }) {
    this.projectsDir = opts.projectsDir;
    this.horizonMs = opts.horizonMs ?? DEFAULT_HORIZON_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Read what the transcripts gained; true when records or titles changed. Callers share one run; never rejects. */
  refresh(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.run()
        .catch(() => false)
        .finally(() => {
          this.inflight = undefined;
        });
    }
    return this.inflight;
  }

  summary(windowMs: number): BurnSummary {
    return summarize(this.store.records(), this.now(), windowMs);
  }

  records(): IterableIterator<BurnRecord> {
    return this.store.records();
  }

  /** A custom (/rename) title wins over the ai title; the latest line of each kind wins. */
  titleOf(sessionId: string): string | undefined {
    const t = this.titles.get(sessionId);
    return t?.custom ?? t?.ai;
  }

  /** Working directory from the session's main-thread usage lines. */
  cwdOf(sessionId: string): string | undefined {
    return this.cwds.get(sessionId);
  }

  private async run(): Promise<boolean> {
    const now = this.now();
    const horizonStart = now - this.horizonMs;
    await this.restatTracked(horizonStart);
    if (now - this.lastWalk >= WALK_INTERVAL_MS) {
      this.lastWalk = now;
      await this.walk(horizonStart);
    } else {
      await this.relistHot(now, horizonStart);
    }
    let changed = false;
    for (const t of [...this.files.values()]) {
      if (await this.readAppended(t, horizonStart)) changed = true;
    }
    this.store.prune(horizonStart);
    this.forgetUntracked();
    return changed;
  }

  /** Refresh size and mtime of tracked files; untrack vanished ones and ones idle past the horizon. */
  private async restatTracked(horizonStart: number): Promise<void> {
    const tracked = [...this.files.values()];
    const stats = await Promise.all(tracked.map((t) => statOf(t.file)));
    tracked.forEach((t, i) => {
      const st = stats[i];
      if (!st || st.mtimeMs < horizonStart) {
        this.files.delete(t.file);
        return;
      }
      if (st.size < t.offset) t.offset = 0; // shrank: start over, dedupe absorbs the re-read
      t.size = st.size;
      t.mtimeMs = st.mtimeMs;
    });
  }

  /** Full discovery: main transcripts and subagent transcripts modified inside the horizon. */
  private async walk(horizonStart: number): Promise<void> {
    for (const slug of await listDir(this.projectsDir)) {
      if (!slug.isDirectory()) continue;
      const dir = path.join(this.projectsDir, slug.name);
      const entries = await listDir(dir);
      await Promise.all(
        entries.map((e) => {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name.endsWith(".jsonl")) {
            const sessionId = e.name.slice(0, -".jsonl".length);
            return this.track(full, sessionId, path.join(dir, sessionId), false, horizonStart);
          }
          return e.isDirectory() ? this.trackSubagents(full, e.name, horizonStart) : undefined;
        }),
      );
    }
  }

  /** Re-list subagents/ of sessions written in the last few minutes, so a new subagent shows up at once. */
  private async relistHot(now: number, horizonStart: number): Promise<void> {
    const hot = new Map<string, string>();
    for (const t of this.files.values()) if (now - t.mtimeMs <= HOT_MS) hot.set(t.sessionDir, t.sessionId);
    await Promise.all([...hot].map(([dir, sessionId]) => this.trackSubagents(dir, sessionId, horizonStart)));
  }

  private async trackSubagents(sessionDir: string, sessionId: string, horizonStart: number): Promise<void> {
    const dir = path.join(sessionDir, "subagents");
    const entries = await listDir(dir);
    await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => this.track(path.join(dir, e.name), sessionId, sessionDir, true, horizonStart)),
    );
  }

  private async track(file: string, sessionId: string, sessionDir: string, sub: boolean, horizonStart: number): Promise<void> {
    if (this.files.has(file)) return;
    const st = await statOf(file);
    if (!st || st.mtimeMs < horizonStart) return;
    this.files.set(file, { file, sessionId, sessionDir, sub, offset: 0, size: st.size, mtimeMs: st.mtimeMs });
  }

  /** Read the bytes appended since the last refresh in chunks of at most 4 MB; a trailing partial line waits. */
  private async readAppended(t: Tracked, horizonStart: number): Promise<boolean> {
    if (t.offset >= t.size) return false;
    const fh = await fs.promises.open(t.file, "r").catch(() => null);
    if (!fh) return false;
    let changed = false;
    try {
      let pos = t.offset;
      let pending: Buffer[] = []; // start of a line that did not end inside the previous chunk
      while (pos < t.size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, t.size - pos));
        const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        const nl = buf.lastIndexOf(NEWLINE, bytesRead - 1);
        if (nl < 0) {
          pending = [...pending, buf.subarray(0, bytesRead)];
          continue;
        }
        const block = Buffer.concat([...pending, buf.subarray(0, nl)]);
        if (this.ingest(block, t, horizonStart)) changed = true;
        t.offset += block.length + 1;
        pending = [buf.subarray(nl + 1, bytesRead)];
        await yieldTick();
      }
    } catch {
      // unreadable mid-read: the offset stays just past the last consumed newline
    } finally {
      await fh.close().catch(() => undefined);
    }
    return changed;
  }

  /** Parse the complete lines of `block`; only lines that mention usage or a title reach JSON.parse. */
  private ingest(block: Buffer, t: Tracked, horizonStart: number): boolean {
    let changed = false;
    let start = 0;
    while (start < block.length) {
      const nl = block.indexOf(NEWLINE, start);
      const end = nl < 0 ? block.length : nl;
      const line = block.subarray(start, end);
      if (line.includes(USAGE) || line.includes(TITLE)) {
        if (this.apply(parseBurnLine(line.toString("utf8")), t, horizonStart)) changed = true;
      }
      start = end + 1;
    }
    return changed;
  }

  private apply(p: BurnLine | null, t: Tracked, horizonStart: number): boolean {
    if (!p) return false;
    if (p.kind === "title") return !t.sub && this.setTitle(t.sessionId, p.title, p.custom);
    if (p.ts < horizonStart) return false;
    if (p.cwd && !t.sub) this.cwds.set(t.sessionId, p.cwd);
    return this.store.upsert({
      key: p.key,
      ts: p.ts,
      sessionId: t.sessionId,
      sub: t.sub,
      model: p.model,
      input: p.input,
      cacheWrite5m: p.cacheWrite5m,
      cacheWrite1h: p.cacheWrite1h,
      cacheRead: p.cacheRead,
      output: p.output,
      fileMtimeMs: t.mtimeMs,
    });
  }

  private setTitle(sessionId: string, title: string, custom: boolean): boolean {
    const prev = this.titles.get(sessionId) ?? {};
    if ((custom ? prev.custom : prev.ai) === title) return false;
    this.titles.set(sessionId, custom ? { ...prev, custom: title } : { ...prev, ai: title });
    return true;
  }

  /** Forget titles and cwds of sessions that no longer have a tracked transcript. */
  private forgetUntracked(): void {
    const live = new Set([...this.files.values()].map((t) => t.sessionId));
    for (const id of [...this.titles.keys()]) if (!live.has(id)) this.titles.delete(id);
    for (const id of [...this.cwds.keys()]) if (!live.has(id)) this.cwds.delete(id);
  }
}
