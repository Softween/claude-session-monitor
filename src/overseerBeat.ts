/**
 * overseerBeat.ts - one machine-level heartbeat for overseer, a local monitor of
 * autonomous tools. It is a private feature: nothing happens unless
 * ~/.claude/bin/overseer exists.
 *
 * Every window calls tick() right after writing its health file (health.ts, every
 * 30 s). The window that takes the O_EXCL lock health/emit.lock (a holder whose pid
 * is gone loses it) and finds the last emit in health/emit.json at least 60 s old
 * claims the next one, then reads the health files of all live windows and runs
 *   overseer emit --tool session-monitor --heartbeat --every 5m --data <json> "<summary>"
 * When the windows, versions, failing features or armed guards changed since the
 * last emit, an action line with the same summary follows (warn while a feature is
 * in error), so the change shows on the overseer timeline. Health files of windows
 * gone for a day are removed. No vscode import.
 */
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { acquireSwitchLock } from "./accountSwitch";
import { readText, writeTextAtomic } from "./continuity";
import { pidAlive } from "./core";
import { parseHealth, type WindowHealth } from "./health";

export const TOOL_ID = "session-monitor";
export const EMIT_GAP_MS = 60_000;
export const LIVE_MS = 90_000; // a health file at most this old, from a live pid, is a live window
export const PRUNE_MS = 24 * 3600_000; // health files of windows gone this long are removed
export const HEARTBEAT_EVERY = "5m"; // overseer calls the tool late after 2.5 x this without a heartbeat
const RUN_TIMEOUT_MS = 15_000;
const WINDOW_FILE = /^(?:[0-9a-f]{16}|empty-\d+)\.json$/;

export type TickResult = "observer mode" | "no overseer" | "busy" | "recent" | "emitted" | "failed";

export interface BeatDeps {
  dir: string; // the health folder
  overseer: string; // the overseer CLI
  shared(): boolean; // false in observer mode (observerMode.ts sharedFiles): no lock, no state file, no emit
  nowMs(): number;
  exists(file: string): boolean;
  list(dir: string): string[];
  read(file: string): string | undefined;
  write(file: string, text: string): void; // atomic
  remove(file: string): void;
  alive(pid: number): boolean;
  lock(file: string): (() => void) | null; // O_EXCL lock file, holder checked for liveness
  run(file: string, args: readonly string[]): Promise<string | undefined>; // undefined: exit 0; else why not
  log(msg: string): void;
}

export interface Summary {
  text: string;
  level: "info" | "warn";
  sig: string; // an action line is sent when this changes
  data: { windows: Array<Pick<WindowHealth, "win" | "version" | "refreshP95Ms" | "guardArmed"> & { failing: string[] }> };
}

/** ~/.claude/bin/overseer */
export function overseerBin(home: string = os.homedir()): string {
  return path.join(home, ".claude", "bin", "overseer");
}

/** The health files of the live windows (fresh, pid alive), by window key; files of windows gone for a day are removed. */
export function liveWindows(deps: Pick<BeatDeps, "dir" | "list" | "read" | "remove" | "alive">, nowMs: number): WindowHealth[] {
  const out: WindowHealth[] = [];
  for (const name of deps.list(deps.dir).filter((n) => WINDOW_FILE.test(n)).sort()) {
    const file = path.join(deps.dir, name);
    const health = parseHealth(deps.read(file));
    if (!health) continue;
    const age = nowMs - health.ts * 1000;
    if (age <= LIVE_MS && deps.alive(health.pid)) out.push(health);
    else if (age > PRUNE_MS) deps.remove(file);
  }
  return out;
}

/** One line for all live windows, and the state behind it. */
export function summarize(windows: readonly WindowHealth[]): Summary {
  const failingOf = (w: WindowHealth): string[] => Object.keys(w.features).filter((f) => w.features[f] === "error");
  const versions = [...new Set(windows.map((w) => w.version))].sort();
  const failing = [...new Set(windows.flatMap(failingOf))].sort();
  const armed = windows.filter((w) => w.guardArmed).length;
  const p95s = windows.map((w) => w.refreshP95Ms).filter((v): v is number => v !== null);
  const text = [
    `${windows.length} window${windows.length === 1 ? "" : "s"} on ${versions.join(", ") || "-"}`,
    `features in error: ${failing.join(", ") || "none"}`,
    `restart guard armed in ${armed} of ${windows.length}`,
    `refresh p95 ${p95s.length ? `${Math.round(Math.max(...p95s))} ms` : "-"}`,
  ].join("; ");
  return {
    text,
    level: failing.length ? "warn" : "info",
    sig: JSON.stringify([windows.length, versions, failing, armed]),
    data: { windows: windows.map((w) => ({ win: w.win, version: w.version, refreshP95Ms: w.refreshP95Ms, guardArmed: w.guardArmed, failing: failingOf(w) })) },
  };
}

interface EmitState {
  ts: number; // epoch ms of the last claimed emit
  sig: string;
}

function parseState(text: string | undefined): EmitState | undefined {
  try {
    const raw = JSON.parse(text ?? "") as Partial<EmitState>;
    return typeof raw?.ts === "number" && typeof raw.sig === "string" ? { ts: raw.ts, sig: raw.sig } : undefined;
  } catch {
    return undefined;
  }
}

export class OverseerBeat {
  private lastProblem = "";

  constructor(private readonly deps: BeatDeps) {}

  /** One step from this window's health beat; resolves with what happened. */
  async tick(): Promise<TickResult> {
    if (!this.deps.shared()) return "observer mode";
    if (!this.deps.exists(this.deps.overseer)) return "no overseer";
    const claim = this.claim();
    if (typeof claim === "string") return claim;
    const { summary, changed } = claim;
    const data = JSON.stringify(summary.data);
    const problems: string[] = [];
    const heartbeat = await this.deps.run(this.deps.overseer, ["emit", "--tool", TOOL_ID, "--heartbeat", "--every", HEARTBEAT_EVERY, "--data", data, summary.text]);
    if (heartbeat !== undefined) problems.push(`heartbeat: ${heartbeat}`);
    if (changed) {
      const action = await this.deps.run(this.deps.overseer, ["emit", "--tool", TOOL_ID, "--level", summary.level, "--data", data, summary.text]);
      if (action !== undefined) problems.push(`action: ${action}`);
    }
    const problem = problems.join("; ");
    if (problem && problem !== this.lastProblem) this.deps.log(`overseer: emit failed (${problem}); repeats are not logged`);
    this.lastProblem = problem;
    return problem ? "failed" : "emitted";
  }

  /** Under the emitter lock: the next emit is this window's when the last one is 60 s old; it is recorded before it runs. */
  private claim(): { summary: Summary; changed: boolean } | "busy" | "recent" {
    const release = this.deps.lock(path.join(this.deps.dir, "emit.lock"));
    if (!release) return "busy";
    try {
      const now = this.deps.nowMs();
      const stateFile = path.join(this.deps.dir, "emit.json");
      const last = parseState(this.deps.read(stateFile));
      if (last && now - last.ts < EMIT_GAP_MS) return "recent";
      const summary = summarize(liveWindows(this.deps, now));
      this.deps.write(stateFile, JSON.stringify({ ts: now, sig: summary.sig }));
      return { summary, changed: summary.sig !== last?.sig };
    } finally {
      release();
    }
  }
}

/** The file system, process and CLI side of BeatDeps. */
export function nodeBeatDeps(dir: string, overseer: string, shared: () => boolean, log: (msg: string) => void): BeatDeps {
  return {
    dir,
    overseer,
    shared,
    log,
    nowMs: () => Date.now(),
    exists: (file) => fs.existsSync(file),
    list: (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    },
    read: readText,
    write: writeTextAtomic,
    remove: (file) => fs.rmSync(file, { force: true }),
    alive: (pid) => pidAlive(pid) !== false,
    lock: (file) => acquireSwitchLock(file),
    run: (file, args) =>
      new Promise<string | undefined>((resolve) => {
        execFile(file, [...args], { timeout: RUN_TIMEOUT_MS }, (error, _stdout, stderr) => {
          if (!error) resolve(undefined);
          else resolve(String(stderr ?? "").trim().split("\n").pop() || error.message);
        });
      }),
  };
}
