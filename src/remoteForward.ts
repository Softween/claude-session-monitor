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
 * than 2 minutes (how long a command stays valid) is removed unread.
 *
 * Before a command runs or is handed over, its id is recorded in the shared
 * seen-id store (seenIds.ts); an id already recorded is answered "already run".
 * A command has 60 s from the moment its window took it, the hand-over included:
 * then its AbortSignal fires, so it types and sends nothing more, and its result
 * is "timed out". The commands of one window run one at a time. No vscode import.
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

const REQUEST = ".cmd.json";
const RESULT = ".result.json";
const WINDOW_KEY = /^(?:[0-9a-f]{16}|empty-\d+)$/; // continuity.ts windowKey

/** The file operations of the inboxes; nodeForwardFs is the real one. */
export interface ForwardFs {
  list(dir: string): string[]; // [] when the folder is missing
  read(file: string): string | undefined; // undefined when missing or unreadable
  write(file: string, text: string): void; // atomic: a temp file (0600), then a rename; the folder is created 0700
  remove(file: string): boolean; // false when it was gone already
  rename(from: string, to: string): boolean; // false when `from` was gone already
  mtimeMs(file: string): number | undefined;
}

export interface ForwardDeps {
  win: string; // this window's key (continuity.ts windowKey)
  dir: string; // the inboxes' folder; this window's inbox is <dir>/<win>
  healthDir: string; // the windows' health files (health.ts)
  shared(): boolean; // false in observer mode (observerMode.ts sharedFiles): no inbox, no seen-id store, every command runs here
  holds(v: SessionView): boolean; // this window holds the session's Claude Code tab or a terminal it started or registered
  seen: Pick<SeenIds, "claim">;
  fs: ForwardFs;
  now(): number; // epoch ms
  alive(pid: number): boolean;
  log(msg: string): void;
  pollMs?: number; // test seam: how often the inbox and a result are looked for (INBOX_POLL_MS)
}

/** Runs a command; its signal aborts when the command's time is up. */
export type Executor = (cmd: FleetCommand, signal: AbortSignal) => Promise<CommandOutcome>;

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

/** A handed-over command file's content, or undefined for anything else; only the fields a tab-bound command reads are kept. */
export function parseRequest(text: string | undefined): ForwardedCommand | undefined {
  const raw = parseJson(text);
  if (!isRecord(raw) || raw.v !== 1 || typeof raw.from !== "string" || !WINDOW_KEY.test(raw.from)) return undefined;
  if (typeof raw.deadline !== "number" || !isRecord(raw.cmd)) return undefined;
  const { id, type, sessionId, text: line, createdAt } = raw.cmd;
  if (typeof id !== "string" || !id || typeof type !== "string" || !TAB_BOUND_TYPES.includes(type)) return undefined;
  const cmd: FleetCommand = {
    id,
    type,
    sessionId: typeof sessionId === "string" ? sessionId : null,
    text: typeof line === "string" ? line : null,
    ...(typeof createdAt === "number" ? { createdAt } : {}),
  };
  return { from: raw.from, deadline: raw.deadline, cmd };
}

/**
 * Runs the relay's commands for the bridge (remoteBridge.ts) and serves this
 * window's inbox. Without ForwardDeps every command runs here, cancelled after 60 s.
 */
export class RemoteForwarder {
  private rows: SessionView[] = [];
  private held: string[] = [];
  private turn: Promise<unknown> = Promise.resolve(); // the command of this window that runs now
  private timer: ReturnType<typeof setInterval> | undefined;
  private scanning = false;

  constructor(private readonly execute: Executor, private readonly deps?: ForwardDeps) {}

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

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
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
    const windows = liveWindows({ dir: deps.healthDir, list: (d) => deps.fs.list(d), read: (f) => deps.fs.read(f), alive: (pid) => deps.alive(pid) }, deps.now());
    return windows.find((w) => w.win !== deps.win && WINDOW_KEY.test(w.win) && w.holds?.includes(sid) === true);
  }

  /**
   * Writes `cmd` into `holder`'s inbox and waits for its result until `deadline`.
   * When the holder's process ends before it took the command, the command is
   * taken back and runs here; one never taken is removed, so it cannot run later.
   */
  private async handOver(cmd: FleetCommand, holder: WindowHealth, deadline: number, stop: AbortSignal, deps: ForwardDeps): Promise<CommandOutcome> {
    const name = fileKey(cmd.id);
    const request = path.join(deps.dir, holder.win, name + REQUEST);
    const reply = path.join(deps.dir, deps.win, name + RESULT);
    const body = { v: 1, from: deps.win, deadline, cmd: { id: cmd.id, type: cmd.type, sessionId: cmd.sessionId, text: cmd.text, createdAt: cmd.createdAt } };
    try {
      deps.fs.write(request, JSON.stringify(body));
    } catch (e) {
      deps.log(`remote: ${cmd.type} ${short(cmd.id)} not handed to window ${holder.win} (${errText(e)}); it runs here`);
      return this.runHere(cmd, deadline);
    }
    deps.log(`remote: ${cmd.type} ${short(cmd.id)} handed to window ${holder.win}, which holds the session`);
    for (;;) {
      const result = this.takeResult(reply, deps);
      if (result) return result;
      const left = deadline - deps.now();
      if (left <= 0 || stop.aborted) break;
      if (!deps.alive(holder.pid) && deps.fs.remove(request)) {
        deps.log(`remote: window ${holder.win} closed before it took ${short(cmd.id)}; it runs here`);
        return this.runHere(cmd, deadline);
      }
      await sleep(Math.min(deps.pollMs ?? INBOX_POLL_MS, left), stop);
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

  /** Runs `cmd` in this window once the command before it is done, until `deadline`; then its signal aborts. */
  private runHere(cmd: FleetCommand, deadline: number): Promise<CommandOutcome> {
    const turn = this.turn.then((): Promise<CommandOutcome> => {
      const left = deadline - this.now();
      return left > 0 ? withTimeout((signal) => this.execute(cmd, signal), left, timedOut()) : Promise.resolve(timedOut());
    });
    this.turn = turn.catch(() => undefined);
    return turn;
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
    } catch (e) {
      deps.log(`remote: inbox not read: ${errText(e)}`);
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Takes the command in `file` (by a rename, so it is either taken here or taken
   * back by its sender), runs it until its deadline and writes the result into
   * the sender's inbox. Not checked again: the sender's window did that.
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
    if (req.deadline <= deps.now()) {
      deps.log(`remote: ${tag} not run: its time was up`);
      return;
    }
    let out: CommandOutcome;
    try {
      out = await this.runHere(req.cmd, req.deadline);
    } catch (e) {
      out = { ok: false, message: String(e) };
    }
    deps.log(`remote: ${tag} -> ${out.ok ? "ok" : "failed"}: ${out.message}`);
    deps.fs.write(path.join(deps.dir, req.from, fileKey(req.cmd.id) + RESULT), JSON.stringify({ v: 1, id: req.cmd.id, ok: out.ok, message: out.message }));
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
