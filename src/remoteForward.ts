/**
 * remoteForward.ts - where a remote command runs when several VS Code windows
 * poll the relay. Every window polls with the same host and token and the relay
 * hands a command to whichever window asks first, but a `send`, `resume` or
 * `kill` (TAB_BOUND_TYPES) needs what only one window has: the session's Claude
 * Code tab, or the terminal that window started or registered for it. A window
 * that gets such a command for a session it does not hold hands it to the live
 * window that does and reports that window's result; when no other live window
 * holds the session, the command runs where it landed.
 *
 * Each window lists the sessions it holds in its health file (health.ts `holds`;
 * a window counts while that file is at most 90 s old and its pid runs,
 * overseerBeat.ts liveWindows) and reads its inbox every 500 ms:
 * ~/.claude/session-monitor/remote/inbox/<window key>/ (folder 0700, files 0600,
 * written through a temp file and a rename). A handed-over command is
 * `<hash>.cmd.json` in the holder's inbox; its result comes back as
 * `<hash>.result.json` in the sender's. A file is removed once read; one older
 * than 2 minutes (how long a command stays valid) is removed unread, and so is
 * the inbox of a window that is gone once nothing was written there for 2 minutes.
 *
 * Before a command runs or is handed over, its id is recorded in the shared
 * seen-id store (seenIds.ts); an id already recorded is answered "already run".
 * The holder runs a handed-over command only when that record exists and its own
 * settings allow the command (the bridge's refusal step); a command the holder
 * has not taken within 3 s is taken back and runs where it landed.
 * A command has 60 s from the moment its window took it, the hand-over included:
 * then its AbortSignal fires, so it types and sends nothing more, and its result
 * is "timed out" (a sender still takes a result that comes within 2 s after
 * that). A step that cannot stop once started (keystroke typing, a socket send)
 * does not start with less than 10 s left. The commands of one window run one at
 * a time: the next starts once the one before it settled, or 10 s after that
 * one's time was up. No vscode import.
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { readText, writeTextAtomic } from "./continuity";
import { pidAlive } from "./core";
import type { WindowHealth } from "./health";
import { liveWindows } from "./overseerBeat";
import type { SessionView } from "./providers/types";
import { COMMAND_MAX_AGE_MS, COMMAND_TIMEOUT_MS, withTimeout } from "./remote";
import type { CommandOutcome, FleetCommand } from "./remoteBridge";
import { SeenIds, nodeSeenFs } from "./seenIds";

/** The command types that need the session's tab or terminal, which only one window has. */
export const TAB_BOUND_TYPES: readonly string[] = ["send", "resume", "kill"];
export const INBOX_POLL_MS = 500;
export const ALREADY_RUN = "already run";
export const TIMED_OUT = "timed out";
/** A step that cannot stop once started (keystroke typing, a socket send) starts only with at least this much of its command's time left. */
export const START_MARGIN_MS = 10_000;

const SETTLE_CAP_MS = 10_000; // the next command waits at most this long past the deadline of one that still runs
const TAKE_BACK_MS = 3_000; // a command the holder has not taken in this time is taken back
const RESULT_GRACE_MS = 2_000; // how long past the deadline a sender still looks for the holder's result
const PRUNE_EVERY_MS = 60_000; // how often a window looks for the inboxes of windows that are gone
const REQUEST = ".cmd.json";
const RESULT = ".result.json";
const WINDOW_KEY = /^(?:[0-9a-f]{16}|empty-\d+)$/; // continuity.ts windowKey

/** The file operations of the inboxes; nodeForwardFs is the real one. */
export interface ForwardFs {
  list(dir: string): string[]; // [] when the folder is missing
  read(file: string): string | undefined; // undefined when missing or unreadable
  write(file: string, text: string): void; // atomic: a temp file (0600), then a rename; the folder is created 0700
  remove(file: string): boolean; // false when it was gone already
  removeDir(dir: string): void; // an empty folder; one that is not empty or is gone stays as it is
  rename(from: string, to: string): boolean; // false when `from` was gone already
  mtimeMs(file: string): number | undefined;
}

export interface ForwardDeps {
  win: string; // this window's key (continuity.ts windowKey)
  dir: string; // the inboxes' folder; this window's inbox is <dir>/<win>
  healthDir: string; // the windows' health files (health.ts)
  shared(): boolean; // false in observer mode (observerMode.ts sharedFiles): no inbox, no seen-id store, every command runs here
  holds(v: SessionView): boolean; // this window holds the session's Claude Code tab or a terminal it started or registered
  seen: Pick<SeenIds, "claim" | "has">;
  fs: ForwardFs;
  now(): number; // epoch ms
  alive(pid: number): boolean;
  log(msg: string): void;
  pollMs?: number; // test seam: how often the inbox and a result are looked for (INBOX_POLL_MS)
}

/** Runs a command; its signal aborts when the command's time is up, at `deadline` (epoch ms). */
export type Executor = (cmd: FleetCommand, signal: AbortSignal, deadline: number) => Promise<CommandOutcome>;

/** Why a command must not run in this window (the bridge's refusal step, remoteBridge.ts), or null to run it. */
export type Refusal = (cmd: FleetCommand) => Promise<string | null>;

/** A command one window handed to another, as read from the inbox. */
export interface ForwardedCommand {
  from: string; // the sender's window key
  deadline: number; // epoch ms: the command's time is up
  cmd: FleetCommand;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const short = (id: string): string => id.slice(0, 8);
const fileKey = (id: string): string => createHash("sha256").update(id).digest("hex").slice(0, 32);
const timedOut = (): CommandOutcome => ({ ok: false, message: TIMED_OUT });

function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Whether a step that cannot stop once started may still start: at least 10 s left before `deadline` (epoch ms), or no deadline. */
export function canStart(deadline: number | undefined, now = Date.now()): boolean {
  return deadline === undefined || deadline - now >= START_MARGIN_MS;
}

/**
 * A handed-over command file's content, or undefined for anything else: a
 * tab-bound command with an id, from a window key. The command comes back as the
 * relay sent it, every field unchanged (the executor checks the ones it reads).
 */
export function parseRequest(text: string | undefined): ForwardedCommand | undefined {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.from !== "string" || !WINDOW_KEY.test(raw.from)) return undefined;
  if (typeof raw.deadline !== "number" || !isRecord(raw.cmd)) return undefined;
  const { id, type } = raw.cmd;
  if (typeof id !== "string" || !id || typeof type !== "string" || !TAB_BOUND_TYPES.includes(type)) return undefined;
  const cmd: FleetCommand = { ...(raw.cmd as Partial<FleetCommand>), id, type };
  return { from: raw.from, deadline: raw.deadline, cmd };
}

/**
 * Runs the relay's commands for the bridge (remoteBridge.ts) and serves this
 * window's inbox. Without ForwardDeps every command runs here, cancelled after 60 s.
 */
export class RemoteForwarder {
  private rows: SessionView[] = [];
  private held: string[] = [];
  private turn: Promise<unknown> = Promise.resolve(); // settles once the command of this window that runs now settled
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;
  private prunedAt = 0; // when the inboxes of windows that are gone were last looked for (epoch ms)

  constructor(private readonly execute: Executor, private readonly refusal: Refusal, private readonly deps?: ForwardDeps) {}

  /** The sessions this window holds, as the last row cycle saw them, sorted. */
  holdings(): string[] {
    return this.held;
  }

  /** The bridge's row cycle: keeps the rows and the sessions this window holds; true when those sessions changed. */
  observe(rows: SessionView[]): boolean {
    this.rows = rows;
    const deps = this.deps;
    if (!deps || !deps.shared()) return false;
    const held = rows.filter((v) => deps.holds(v)).map((v) => v.sessionId).sort();
    if (held.length === this.held.length && held.every((id, i) => id === this.held[i])) return false;
    this.held = held;
    return true;
  }

  /** Reads this window's inbox every 500 ms until stop(). */
  start(): void {
    if (!this.deps || this.timer) return;
    this.timer = setInterval(() => void this.scan(), this.deps.pollMs ?? INBOX_POLL_MS);
  }

  /** Stops reading the inbox; after the next start, the first row cycle lists the sessions this window holds again. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.held = [];
  }

  /**
   * A relay command that passed the bridge's checks: its id is recorded first (an
   * id recorded already is answered "already run"), then it runs here, or in the
   * live window holding its session when it is tab-bound and this window does not
   * hold that session. `stop` aborts when the bridge stops: a hand-over waits no longer.
   */
  async run(cmd: FleetCommand, stop: AbortSignal): Promise<CommandOutcome> {
    const deadline = this.now() + COMMAND_TIMEOUT_MS;
    const deps = this.deps;
    if (!deps || !deps.shared()) return this.runHere(cmd, deadline);
    if (!deps.seen.claim(cmd.id)) return { ok: false, message: ALREADY_RUN };
    const holder = this.holderFor(cmd, deps);
    return holder ? this.handOver(cmd, holder, deadline, stop, deps) : this.runHere(cmd, deadline);
  }

  private now(): number {
    return this.deps ? this.deps.now() : Date.now();
  }

  /** The live window to hand `cmd` to: it is tab-bound, this window does not hold its session and that window does. */
  private holderFor(cmd: FleetCommand, deps: ForwardDeps): WindowHealth | undefined {
    const sid = cmd.sessionId;
    if (!TAB_BOUND_TYPES.includes(cmd.type) || typeof sid !== "string" || !sid) return undefined;
    const v = this.rows.find((r) => r.sessionId === sid);
    if (v && deps.holds(v)) return undefined;
    return this.liveWindows(deps).find((w) => w.win !== deps.win && WINDOW_KEY.test(w.win) && w.holds?.includes(sid) === true);
  }

  /** The windows whose health file is live (overseerBeat.ts liveWindows). */
  private liveWindows(deps: ForwardDeps): WindowHealth[] {
    return liveWindows({ dir: deps.healthDir, list: (d) => deps.fs.list(d), read: (f) => deps.fs.read(f), alive: (pid) => deps.alive(pid) }, deps.now());
  }

  /**
   * Writes `cmd` into `holder`'s inbox and waits for its result until 2 s after
   * `deadline`. A command the holder has not taken within 3 s, or before its
   * process ended, is taken back and runs here; one never taken is removed, so
   * it cannot run later.
   */
  private async handOver(cmd: FleetCommand, holder: WindowHealth, deadline: number, stop: AbortSignal, deps: ForwardDeps): Promise<CommandOutcome> {
    const name = fileKey(cmd.id);
    const request = path.join(deps.dir, holder.win, name + REQUEST);
    const reply = path.join(deps.dir, deps.win, name + RESULT);
    try {
      deps.fs.write(request, JSON.stringify({ v: 1, from: deps.win, deadline, cmd }));
    } catch (e) {
      deps.log(`remote: ${cmd.type} ${short(cmd.id)} not handed to window ${holder.win} (${errText(e)}); it runs here`);
      return this.runHere(cmd, deadline);
    }
    const handed = deps.now();
    let waiting = true; // the command still lies in the holder's inbox, as far as this window knows
    deps.log(`remote: ${cmd.type} ${short(cmd.id)} handed to window ${holder.win}, which holds the session`);
    for (;;) {
      const result = this.takeResult(reply, deps);
      if (result) return result;
      const now = deps.now();
      if (now >= deadline + RESULT_GRACE_MS || stop.aborted) break;
      if (waiting && now < deadline) {
        const closed = !deps.alive(holder.pid);
        if (closed || now - handed >= TAKE_BACK_MS) {
          // The holder's rename and this unlink exclude each other: the command runs in one window only.
          if (deps.fs.remove(request)) {
            const what = closed ? `closed before it took ${short(cmd.id)}` : `did not take ${short(cmd.id)} within 3 s`;
            deps.log(`remote: window ${holder.win} ${what}; it runs here`);
            return this.runHere(cmd, deadline);
          }
          waiting = false; // the holder took it: its result comes back
        }
      }
      await sleep(Math.min(deps.pollMs ?? INBOX_POLL_MS, deadline + RESULT_GRACE_MS - now), stop);
    }
    deps.fs.remove(request);
    return stop.aborted ? { ok: false, message: "the bridge stopped" } : timedOut();
  }

  /** The result in `file`, which is then removed; undefined while there is none. */
  private takeResult(file: string, deps: ForwardDeps): CommandOutcome | undefined {
    const text = deps.fs.read(file);
    if (text === undefined) return undefined;
    deps.fs.remove(file);
    const r = parseJson(text);
    return isRecord(r) && typeof r.ok === "boolean" && typeof r.message === "string"
      ? { ok: r.ok, message: r.message }
      : { ok: false, message: "the window holding the session sent an unreadable result" };
  }

  /** Runs `cmd` in this window once the command before it settled, until `deadline`: then its signal aborts and it answers "timed out". */
  private runHere(cmd: FleetCommand, deadline: number): Promise<CommandOutcome> {
    const started = this.turn.then(() => this.begin(cmd, deadline));
    this.turn = started.then((s) => s.settled, () => undefined);
    return started.then((s) => s.answer);
  }

  /**
   * Starts `cmd` with the time left before `deadline`. `answer` is its result, or
   * "timed out" once that time is up; `settled` resolves once the command itself
   * settled (a step that cannot stop once started may outlive the deadline), at
   * most 10 s after the deadline.
   */
  private begin(cmd: FleetCommand, deadline: number): { answer: Promise<CommandOutcome>; settled: Promise<void> } {
    const left = deadline - this.now();
    if (left <= 0) return { answer: Promise.resolve(timedOut()), settled: Promise.resolve() };
    let work: Promise<unknown> = Promise.resolve();
    const answer = withTimeout((signal) => (work = this.execute(cmd, signal, deadline)), left, timedOut()); // calls the executor at once
    return { answer, settled: this.settledOrCapped(work, deadline, cmd) };
  }

  /** Resolves once `work` settled, or 10 s after `deadline` (logged then): what the next command of this window waits for. */
  private settledOrCapped(work: Promise<unknown>, deadline: number, cmd: FleetCommand): Promise<void> {
    return new Promise<void>((resolve) => {
      const cap = setTimeout(() => {
        this.deps?.log(`remote: ${cmd.type} ${short(cmd.id)} still runs 10 s after its time was up; the next command runs`);
        resolve();
      }, Math.max(0, deadline + SETTLE_CAP_MS - this.now()));
      const done = (): void => {
        clearTimeout(cap);
        resolve();
      };
      work.then(done, done);
    });
  }

  /** One look into this window's inbox: a file older than 2 minutes is removed unread, each command is taken and run in turn. */
  private async scan(): Promise<void> {
    const deps = this.deps;
    if (!deps || this.scanning || !deps.shared()) return;
    this.scanning = true;
    try {
      const dir = path.join(deps.dir, deps.win);
      for (const name of deps.fs.list(dir)) {
        const file = path.join(dir, name);
        const mtime = deps.fs.mtimeMs(file);
        if (mtime !== undefined && deps.now() - mtime > COMMAND_MAX_AGE_MS) deps.fs.remove(file);
        else if (name.endsWith(REQUEST)) await this.serve(file, deps);
      }
      this.pruneInboxes(deps);
    } catch (e) {
      deps.log(`remote: inbox not read: ${errText(e)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Takes the command in `file` (by a rename, so it is either taken here or taken
   * back by its sender) and checks it again before it runs here: within its
   * deadline and this window's own 60 s, its id recorded in the seen-id store (a
   * window took it from the relay), and allowed by this window's settings (a
   * refusal is its result). The result goes into the sender's inbox.
   */
  private async serve(file: string, deps: ForwardDeps): Promise<void> {
    const taken = `${file}.taken`;
    if (!deps.fs.rename(file, taken)) return;
    const req = parseRequest(deps.fs.read(taken));
    deps.fs.remove(taken);
    if (!req) {
      deps.log(`remote: unreadable inbox file ${path.basename(file)} removed`);
      return;
    }
    const tag = `${req.cmd.type} ${short(req.cmd.id)} from window ${req.from}`;
    const deadline = Math.min(req.deadline, deps.now() + COMMAND_TIMEOUT_MS);
    if (deadline <= deps.now()) {
      deps.log(`remote: ${tag} not run: its time was up`);
      return;
    }
    if (!deps.seen.has(req.cmd.id)) {
      deps.log(`remote: ${tag} not run: its id was not recorded`);
      return;
    }
    let out: CommandOutcome;
    try {
      const refusal = await this.refusal(req.cmd);
      out = refusal ? { ok: false, message: refusal } : await this.runHere(req.cmd, deadline);
    } catch (e) {
      out = { ok: false, message: String(e) };
    }
    deps.log(`remote: ${tag} -> ${out.ok ? "ok" : "failed"}: ${out.message}`);
    deps.fs.write(path.join(deps.dir, req.from, fileKey(req.cmd.id) + RESULT), JSON.stringify({ v: 1, id: req.cmd.id, ok: out.ok, message: out.message }));
  }

  /**
   * At most once a minute: removes the inbox of every window that is gone (no
   * live health file) once nothing was written there for 2 minutes. A live
   * window looks after its own inbox.
   */
  private pruneInboxes(deps: ForwardDeps): void {
    const now = deps.now();
    if (now - this.prunedAt < PRUNE_EVERY_MS) return;
    this.prunedAt = now;
    const old = (file: string): boolean => {
      const mtime = deps.fs.mtimeMs(file);
      return mtime !== undefined && now - mtime > COMMAND_MAX_AGE_MS;
    };
    const live = new Set(this.liveWindows(deps).map((w) => w.win));
    for (const win of deps.fs.list(deps.dir)) {
      const inbox = path.join(deps.dir, win);
      if (win === deps.win || live.has(win) || !WINDOW_KEY.test(win) || !old(inbox)) continue;
      for (const name of deps.fs.list(inbox)) {
        if (old(path.join(inbox, name))) deps.fs.remove(path.join(inbox, name));
      }
      deps.fs.removeDir(inbox);
    }
  }
}

/** Runs `op` on a file: true when it ran, false when the file was missing. */
function onFile(op: () => void): boolean {
  try {
    op();
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** The real file operations of the inboxes. */
export const nodeForwardFs: ForwardFs = {
  list(dir) {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: readText,
  write: writeTextAtomic,
  remove: (file) => onFile(() => fs.unlinkSync(file)),
  removeDir(dir) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty (written to meanwhile) or gone already */
    }
  },
  rename: (from, to) => onFile(() => fs.renameSync(from, to)),
  mtimeMs(file) {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

/** ForwardDeps on the real clock and file system: the inboxes in <monitorDir>/remote/inbox, the seen-id store in <monitorDir>/remote/seen. */
export function nodeForwardDeps(o: Pick<ForwardDeps, "win" | "healthDir" | "shared" | "holds" | "log"> & { monitorDir: string }): ForwardDeps {
  const root = path.join(o.monitorDir, "remote");
  return {
    win: o.win,
    dir: path.join(root, "inbox"),
    healthDir: o.healthDir,
    shared: o.shared,
    holds: o.holds,
    seen: new SeenIds({ dir: path.join(root, "seen"), now: () => Date.now(), fs: nodeSeenFs }),
    fs: nodeForwardFs,
    now: () => Date.now(),
    alive: (pid) => pidAlive(pid) !== false,
    log: o.log,
  };
}
