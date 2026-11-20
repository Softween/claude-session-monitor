/**
 * debugLog.ts - the debug log, ~/.claude/session-monitor/csm-debug.log.
 *
 * Every window (one extension host each) appends to the same file. A line is one
 * JSON object {ts, pid, win, ver, feature, lvl, msg}, written with one append of
 * a whole line, so the lines of several writers never mix. `msg` keeps the text
 * the old plain lines carried, so a reader that searches for it still finds it.
 *
 * Rotation keeps whole lines: once the file holds `rotateLines` lines it is
 * renamed to .1 (.1 to .2 and so on, the oldest of `keep` dropped), by one writer
 * at a time under an O_EXCL lock file whose holder is checked for liveness. A
 * writer that opened the file before the rename finishes its line in the renamed
 * file. Lines are counted from the bytes appended since the last count, by every
 * writer, at most COUNT_CHUNK bytes per append.
 *
 * Sizing (measured on 2026-11-20 over 12.6 h of this file): 329 lines an hour, of
 * which 128 were the 20 s session-count line that a 5-minute summary replaces,
 * so about 214 lines an hour (293 in the busiest hour). Rotation at 20,000 lines
 * with 3 old files keeps at least 60,000 lines: 11.7 days at the average rate,
 * 8.5 days at the busiest hour's.
 *
 * No vscode import: the lock is injected (accountSwitch.ts acquireSwitchLock).
 */
import * as fs from "fs";
import * as path from "path";

export const ROTATE_LINES = 20_000;
export const KEEP = 3; // csm-debug.log.1 .. .3
const MAX_MSG = 2_000; // characters of one message: a line stays one small append
const COUNT_STEP = 64 * 1024; // count the new lines once this many bytes were appended since the last count
const COUNT_CHUNK = 1 << 20; // bytes read by one count

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  ts: string;
  pid: number;
  win: string;
  ver: string;
  feature: string;
  lvl: LogLevel;
  msg: string;
}

export interface DebugLogOptions {
  file: string;
  pid: number;
  /** Takes an O_EXCL lock file; returns its release, or null while a live holder has it. */
  lock(file: string): (() => void) | null;
  nowMs?(): number;
  rotateLines?: number;
  keep?: number;
  countStep?: number; // bytes appended between two line counts
}

/**
 * The feature and level of a plain message: a stage failure (safeStage.ts) is an
 * error of feature "stage"; otherwise the feature is the leading word ("wake: ..."
 * -> "wake", "restart guard: ..." -> "restart-guard") and a message that reports
 * an error or a failure is a warning.
 */
export function classify(msg: string): { feature: string; lvl: LogLevel } {
  if (msg.startsWith("stage failed:")) return { feature: "stage", lvl: "error" };
  const feature = msg.startsWith("restart guard") ? "restart-guard" : (/^[A-Za-z][\w-]*/.exec(msg)?.[0].toLowerCase() ?? "general");
  return { feature, lvl: /\b(error|errors|failed|failure)\b/i.test(msg) ? "warn" : "info" };
}

interface Counted {
  ino: number; // the file the count is for
  offset: number; // bytes counted
  lines: number;
}

const NONE: Counted = { ino: -1, offset: 0, lines: 0 };

function renameIfThere(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export class DebugLog {
  private win: string;
  private ver = "";
  private counted: Counted = NONE;
  private modeChecked = false;
  private readonly rotateLines: number;
  private readonly keep: number;
  private readonly countStep: number;

  constructor(private readonly o: DebugLogOptions) {
    this.win = `empty-${o.pid}`;
    this.rotateLines = o.rotateLines ?? ROTATE_LINES;
    this.keep = o.keep ?? KEEP;
    this.countStep = o.countStep ?? COUNT_STEP;
  }

  /** The window key and extension version every following line carries. */
  identify(win: string, ver: string): void {
    this.win = win;
    this.ver = ver;
  }

  /** Appends one line (feature and level from the message unless given); never throws. */
  write(msg: string, feature?: string, lvl?: LogLevel): void {
    try {
      const c = classify(msg);
      const line: LogLine = {
        ts: new Date(this.o.nowMs?.() ?? Date.now()).toISOString(),
        pid: this.o.pid,
        win: this.win,
        ver: this.ver,
        feature: feature ?? c.feature,
        lvl: lvl ?? c.lvl,
        msg: msg.length > MAX_MSG ? `${msg.slice(0, MAX_MSG)}…` : msg,
      };
      this.afterAppend(this.append(`${JSON.stringify(line)}\n`));
    } catch {
      /* best-effort: the log never breaks a caller */
    }
  }

  /** One write on an O_APPEND descriptor; a symlink in place of the log is replaced, never followed. */
  private append(text: string): fs.Stats {
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
    let fd: number;
    try {
      fd = fs.openSync(this.o.file, flags, 0o600);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") fs.mkdirSync(path.dirname(this.o.file), { recursive: true, mode: 0o700 });
      else if (code === "ELOOP") fs.unlinkSync(this.o.file);
      else throw e;
      fd = fs.openSync(this.o.file, flags, 0o600);
    }
    try {
      fs.writeSync(fd, text);
      if (!this.modeChecked) {
        fs.fchmodSync(fd, 0o600); // a log an older version created with another mode
        this.modeChecked = true;
      }
      return fs.fstatSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private afterAppend(st: fs.Stats): void {
    if (st.ino !== this.counted.ino || st.size < this.counted.offset) this.counted = { ino: st.ino, offset: 0, lines: 0 };
    if (st.size - this.counted.offset >= this.countStep) this.count(st.ino);
    if (this.counted.lines >= this.rotateLines) this.rotate();
  }

  /** Adds the lines in the next bytes not counted yet, read from the file `ino` names. */
  private count(ino: number): void {
    const fd = fs.openSync(this.o.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const st = fs.fstatSync(fd);
      if (st.ino !== ino) return; // rotated meanwhile: the next append counts the new file
      const len = Math.min(st.size - this.counted.offset, COUNT_CHUNK);
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, this.counted.offset);
      let lines = 0;
      for (let i = buf.indexOf(10); i !== -1 && i < read; i = buf.indexOf(10, i + 1)) lines++;
      this.counted = { ino, offset: this.counted.offset + read, lines: this.counted.lines + lines };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Renames the full file to .1 and shifts the older ones, unless another writer holds the lock or already did. */
  private rotate(): void {
    const release = this.o.lock(`${this.o.file}.lock`);
    if (!release) return;
    try {
      if (fs.lstatSync(this.o.file).ino !== this.counted.ino) return;
      for (let i = this.keep - 1; i >= 1; i--) renameIfThere(`${this.o.file}.${i}`, `${this.o.file}.${i + 1}`);
      fs.renameSync(this.o.file, `${this.o.file}.1`);
      this.counted = NONE;
    } finally {
      release();
    }
  }
}
