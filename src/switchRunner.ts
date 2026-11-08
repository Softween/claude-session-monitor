// Runs the claude-switch CLI (`use`, `tick --fresh`) and never signals it. A run
// may legitimately take minutes (a tick's own deadline is 240 s; `use` can wait
// on Claude Code's refresh locks or the network), and a SIGTERM mid-switch can
// leave state.json and panel.json unsaved, lose a token refresh in flight (only
// its response carries the rotated refresh token) or duplicate a resume message.
// How long the UI waits is separate from the process. No vscode import, so it is
// unit-tested with an injected spawner and clock.
import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** How a claude-switch run ended, with the tail of its output. */
export interface SwitchResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export type Spawner = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Time and timers, injected so tests never wait out the 90 s UI timeout. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

// The globals are looked up per call, so fake timers installed after import apply.
const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Bytes kept of stdout and of stderr per run: the tail, whose last line is what gets shown. */
export const OUTPUT_CAP = 64 * 1024;

/** Two private files for stdout and stderr, unlinked at once: they live while an fd is open, so a run leaves nothing behind. */
function openOutputFiles(): number[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-switch-"));
  const fds: number[] = [];
  try {
    for (const name of ["stdout", "stderr"]) fds.push(fs.openSync(path.join(dir, name), "w+", 0o600));
    return fds;
  } catch (e) {
    for (const fd of fds) fs.closeSync(fd);
    throw e;
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows cannot remove open files: the OS temp cleanup does */
    }
  }
}

/** The last `cap` bytes of an output file, without the line the cut split ("" when unreadable). */
function readTail(fd: number, cap: number): string {
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, cap);
    const buf = Buffer.alloc(len);
    const text = buf.toString("utf8", 0, fs.readSync(fd, buf, 0, len, size - len));
    return size > cap ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  }
}

/**
 * Runs `command args` to its own end: resolves on 'close', rejects only when it
 * cannot start (ENOENT, EACCES, E2BIG). No timeout, no kill. Detached (its own
 * process group) with stdin ignored and stdout/stderr in files, not pipes, as
 * Node's docs ask of a child that must outlive its parent: a Reload Window or an
 * extension-host exit neither signals it nor breaks its next write (a print to a
 * closed pipe aborts a Python CLI with BrokenPipeError).
 */
export function runDetached(command: string, args: readonly string[], spawner: Spawner = spawn): Promise<SwitchResult> {
  return new Promise((resolve, reject) => {
    let fds: number[] = [];
    let settled = false;
    const settle = (done: () => void): void => {
      if (settled) return;
      settled = true;
      done();
      for (const fd of fds) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };
    try {
      fds = openOutputFiles();
      const child = spawner(command, args, { detached: true, stdio: ["ignore", fds[0], fds[1]] });
      child.once("error", (e) => settle(() => reject(e)));
      child.once("close", (code, signal) =>
        settle(() => resolve({ code, signal, stdout: readTail(fds[0], OUTPUT_CAP), stderr: readTail(fds[1], OUTPUT_CAP) })),
      );
      child.unref(); // the extension host never waits for it
    } catch (e) {
      settle(() => reject(e));
    }
  });
}

/** A claude-switch run this extension instance started that has not ended yet. */
export interface InFlight {
  args: string[];
  startedMs: number;
}

export type Launch = { started: true; done: Promise<SwitchResult> } | { started: false; running: InFlight };

/**
 * One claude-switch run at a time across `use` and `tick --fresh`: both take
 * claude-switch's run lock, but a paused tick writes panel.json outside it, so
 * a parallel run could overwrite the panel a switch just wrote. The UI timeout
 * only tells the caller to stop waiting; the run goes on and its result still
 * arrives through `done`.
 */
export class SwitchRunner {
  private current: InFlight | null = null;

  constructor(
    private readonly cli: string,
    private readonly spawner: Spawner = spawn,
    private readonly clock: Clock = systemClock,
  ) {}

  /** The run in flight, or null. */
  running(): InFlight | null {
    return this.current;
  }

  /** Starts `claude-switch <args>` unless a run is in flight (then nothing starts). `ui.onTimeout` fires once if the run outlives `ui.timeoutMs`. */
  start(args: string[], ui?: { timeoutMs: number; onTimeout: () => void }): Launch {
    if (this.current) return { started: false, running: this.current };
    const run: InFlight = { args: [...args], startedMs: this.clock.now() };
    this.current = run;
    const timer = ui ? this.clock.setTimeout(ui.onTimeout, ui.timeoutMs) : undefined;
    const done = runDetached(this.cli, args, this.spawner).finally(() => {
      if (ui) this.clock.clearTimeout(timer);
      this.current = null;
    });
    return { started: true, done };
  }
}

/** The run in flight as the UI shows it: "claude-switch use b@x.com is still running (started 95 s ago)". */
export function busyText(run: InFlight, nowMs: number): string {
  return `claude-switch ${run.args.join(" ")} is still running (started ${Math.max(0, Math.round((nowMs - run.startedMs) / 1000))} s ago)`;
}

/** How a run ended, for when it printed nothing to show. */
export function exitText(res: SwitchResult, command: string): string {
  return res.signal ? `claude-switch ${command} ended by ${res.signal}` : `claude-switch ${command} exited with code ${res.code}`;
}

/** A spawn failure in one clear line. */
export function spawnFailureText(e: unknown, cli: string): string {
  const home = os.homedir();
  const shown = cli.startsWith(home + path.sep) ? "~" + cli.slice(home.length) : cli;
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return `could not start claude-switch: ${shown} or the interpreter on its #! line was not found (ENOENT)`;
  if (code === "EACCES") return `could not start claude-switch: ${shown} is not executable (EACCES)`;
  return cleanLine(`could not start claude-switch: ${e instanceof Error ? e.message : String(e)}`);
}

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g; // control and bidi characters

/** One line of CLI output safe to show: no ANSI escapes, control or bidi characters, at most `max` characters. */
function cleanLine(s: string, max = 200): string {
  return s.replace(ANSI_RE, "").replace(CONTROL_RE, " ").trim().slice(0, max);
}

/** The last non-empty line of CLI output, cleaned ("" when there is none). */
export function lastLine(s: string, max = 200): string {
  return s.split("\n").map((l) => cleanLine(l, max)).filter(Boolean).pop() ?? "";
}
