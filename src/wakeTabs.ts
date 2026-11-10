/**
 * wakeTabs.ts — after VS Code restarts, start the process of Claude Code tabs
 * whose session had stopped on a usage limit (claudeSessionMonitor.wakeDeadTabs,
 * off by default).
 *
 * A restored Claude Code tab gets its `claude --resume` process only once the tab
 * is shown, so the paths that resume running sessions (claude-switch's nudge, the
 * resume sweep) miss a limit-stopped session in a background tab. The waker keeps
 * a registry of the sessions that had a tab in this window (workspaceState). On
 * activation the remembered sessions that run nowhere and whose last assistant
 * entry is a 429 API error at most 24 h old become pending; a sweep shows them one
 * at a time through Claude Code's `claude-vscode.editor.open`, waits for the
 * process, then puts the tabs and focus back. Nothing is ever sent to a session.
 *
 * No `vscode` import: extension.ts injects the editor side (WakeDeps).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PROJECTS_DIR, lastAssistantStop, pidAlive, type AssistantStop } from "./core";
import { loadRecords, type SessionRecord } from "./peerSend";
import { runTool } from "./remote";
import { labelsMatchStrict, parsePsOutput } from "./view";

export const OPEN_COMMAND = "claude-vscode.editor.open";
export const REGISTRY_KEY = "csm.wake.registry";
export const PENDING_KEY = "csm.wake.pending";

const OBSERVE_EVERY_MS = 10_000; // registry cadence (refresh runs every 1.5 s and on transcript writes)
const DROP_AFTER_MISSES = 2; // a session leaves the registry after 2 observations without it...
const DROP_AFTER_MS = 60_000; // ...and 60 s, so the mass exit at shutdown never empties it
const FIRST_SWEEP_MS = 60_000;
const SWEEP_EVERY_MS = 30_000;
const MIN_GAP_MS = 10_000; // between two wakes
const IDLE_MIN_MS = 20_000;
const PRESSURE_CRITICAL = 4; // kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
const WAIT_LIVE_MS = 20_000;
const POLL_MS = 500;
const MAX_ATTEMPTS = 2; // failed wakes per session
const MAX_FAILS_IN_ROW = 2; // then the sweep stops until the next activation
const STOP_MAX_AGE_MS = 24 * 3600_000;
const POSTPONE_LOG_MS = 10 * 60_000; // one postponement line per reason per 10 min
const SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");

/** A session that had a tab in this window; `title` is its panel row title (tab-close matching). */
export interface RegistryEntry {
  sid: string;
  title?: string;
  lastSeenMs: number;
  missed: number; // consecutive observations without it
}

export interface PendingEntry {
  sid: string;
  title?: string;
  attempts: number; // failed wakes so far
}

/** A running Claude process: a ~/.claude/sessions/<pid>.json record whose pid is alive. */
export interface LiveSession {
  sessionId: string;
  pid: number;
  entrypoint?: string;
}

export interface WakeStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void> | void;
}

/** What the waker needs from the editor and the machine; M is the tab snapshot type. */
export interface WakeDeps<M> {
  enabled(): boolean; // the gate, checked before anything else
  store: WakeStore; // workspaceState
  log(msg: string): void;
  now(): number; // epoch ms
  hostPid: number; // this extension host, the parent of this window's tab processes
  titleOf(sid: string): string | undefined;
  liveSessions(): LiveSession[];
  parentPids(): Promise<Map<number, number> | undefined>; // undefined: ps failed
  limitStop(sid: string): AssistantStop | undefined;
  idleMs(): Promise<number | undefined>; // undefined: unreadable
  windowFocused(): boolean;
  pressureLevel(): Promise<number | undefined>; // undefined: unavailable
  commandExists(id: string): Promise<boolean>;
  executeCommand(id: string, ...args: unknown[]): PromiseLike<unknown>;
  snapshotTabs(): M; // each group's active tab and the active group
  activeTab(): unknown;
  restoreTabs(snapshot: M): Promise<void>;
}

export type StepResult = "off" | "stopped" | "empty" | "postponed" | "woken" | "failed";

export interface WakeSummary {
  result: StepResult | "busy";
  woken: number;
  failed: number;
  pending: number;
  reason?: string; // why the sweep was postponed
}

const short = (sid: string): string => sid.slice(0, 8);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One registry observation: listed sessions are refreshed, an absent one leaves after 2 misses and 60 s. */
export function nextRegistry(
  reg: readonly RegistryEntry[],
  own: readonly string[],
  nowMs: number,
  titleOf: (sid: string) => string | undefined,
): RegistryEntry[] {
  const seen = new Set(own);
  const out: RegistryEntry[] = [];
  for (const e of reg) {
    if (seen.delete(e.sid)) out.push({ sid: e.sid, title: titleOf(e.sid) ?? e.title, lastSeenMs: nowMs, missed: 0 });
    else if (e.missed + 1 < DROP_AFTER_MISSES || nowMs - e.lastSeenMs < DROP_AFTER_MS) out.push({ ...e, missed: e.missed + 1 });
  }
  for (const sid of seen) out.push({ sid, title: titleOf(sid), lastSeenMs: nowMs, missed: 0 });
  return out;
}

/** Same sessions, titles and miss counts: lastSeenMs alone changes on every observation. */
function sameShape(a: readonly RegistryEntry[], b: readonly RegistryEntry[]): boolean {
  return a.length === b.length && a.every((e, i) => e.sid === b[i].sid && e.title === b[i].title && e.missed === b[i].missed);
}

/** This window's Claude Code tab sessions: claude-vscode processes whose parent is this extension host. */
export function ownSessions(live: readonly LiveSession[], parents: ReadonlyMap<number, number>, hostPid: number): string[] {
  return live.filter((s) => s.entrypoint === "claude-vscode" && parents.get(s.pid) === hostPid).map((s) => s.sessionId);
}

/** Pending at activation: remembered sessions (the last activation's pending, then the registry) that run nowhere. */
export function pendingAt(
  reg: readonly RegistryEntry[],
  prev: readonly PendingEntry[],
  live: ReadonlySet<string>,
): PendingEntry[] {
  const out = new Map<string, PendingEntry>();
  for (const p of prev) if (!live.has(p.sid)) out.set(p.sid, p);
  for (const e of reg) if (!live.has(e.sid) && !out.has(e.sid)) out.set(e.sid, { sid: e.sid, title: e.title, attempts: 0 });
  return [...out.values()];
}

/** The session's newest assistant entry is a 429 API error (text ignored) at most 24 h old. */
export function isLimitStop(stop: AssistantStop | undefined, nowMs: number): boolean {
  return !!stop && stop.apiError && stop.status === 429 && nowMs - stop.ts * 1000 <= STOP_MAX_AGE_MS;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object";
const titleField = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function asRegistry(raw: unknown): RegistryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .filter((e) => typeof e.sid === "string" && Number.isFinite(e.lastSeenMs) && Number.isFinite(e.missed))
    .map((e) => ({ sid: e.sid as string, title: titleField(e.title), lastSeenMs: e.lastSeenMs as number, missed: e.missed as number }));
}

function asPending(raw: unknown): PendingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .filter((e) => typeof e.sid === "string" && Number.isFinite(e.attempts))
    .map((e) => ({ sid: e.sid as string, title: titleField(e.title), attempts: e.attempts as number }));
}

/** The message the wakeDeadTabsNow command shows. */
export function summaryText(s: WakeSummary): string {
  if (s.result === "off") return "Agent Sessions: turn on claudeSessionMonitor.wakeDeadTabs to wake limit-stopped tabs.";
  if (s.result === "busy") return "Agent Sessions: a tab wake is already running.";
  if (!s.woken && !s.failed) {
    if (s.result === "empty") return "Agent Sessions: no limit-stopped tabs to wake.";
    if (s.result === "stopped") return "Agent Sessions: tab waking stopped after two failed wakes in a row; reload the window to try again.";
  }
  const parts = [`woke ${s.woken} limit-stopped tab${s.woken === 1 ? "" : "s"}`];
  if (s.failed) parts.push(`${s.failed} failed`);
  if (s.result === "stopped") parts.push("stopped after two failed wakes in a row");
  if (s.result === "postponed") parts.push(`postponed (${s.reason ?? "unknown"})`);
  if (s.pending) parts.push(`${s.pending} still pending`);
  return `Agent Sessions: ${parts.join(", ")}.`;
}

export class TabWaker<M> {
  private registry: RegistryEntry[] | undefined;
  private pending: PendingEntry[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastObserveMs = -Infinity;
  private observing = false;
  private lastWakeMs = -Infinity;
  private failsInRow = 0;
  private stopped = false;
  private busy = false;
  private disposed = false;
  private lastReason: string | undefined;
  private readonly postponedAt = new Map<string, number>();

  constructor(private readonly deps: WakeDeps<M>) {}

  /** Activation, before the first refresh: pending = remembered minus running, limit stops only. */
  start(): void {
    if (!this.deps.enabled()) return; // the gate first: nothing is read, written or scheduled
    const reg = asRegistry(this.deps.store.get(REGISTRY_KEY));
    this.registry = reg;
    this.pending = asPending(this.deps.store.get(PENDING_KEY));
    const live = new Set(this.deps.liveSessions().map((s) => s.sessionId));
    const remembered = pendingAt(reg, this.pending, live);
    const now = this.deps.now();
    this.setPending(remembered.filter((p) => isLimitStop(this.deps.limitStop(p.sid), now)));
    this.deps.log(`wake: activation registry=${reg.length} pending=${remembered.length} limit-stopped=${this.pending.length}`);
    if (this.pending.length) this.schedule(FIRST_SWEEP_MS);
  }

  /** Refresh cycle: record this window's running tab sessions (at most every 10 s, one ps snapshot). */
  observe(): void {
    if (!this.on() || this.observing) return;
    const now = this.deps.now();
    if (now - this.lastObserveMs < OBSERVE_EVERY_MS) return;
    this.lastObserveMs = now;
    this.observing = true;
    void this.deps.parentPids().then(
      (parents) => {
        this.observing = false;
        if (parents && this.on()) this.record(parents);
      },
      () => {
        this.observing = false;
      },
    );
  }

  /** A Claude Code tab was closed: its pending session is not woken (that would open a new tab). */
  tabClosed(label: string): void {
    if (!this.on() || !this.pending.length) return;
    const gone = this.pending.filter((p) => p.title !== undefined && labelsMatchStrict(label, p.title));
    if (!gone.length) return;
    for (const p of gone) this.deps.log(`wake: ${short(p.sid)} dropped, its tab was closed`);
    this.setPending(this.pending.filter((p) => !gone.includes(p)));
  }

  /** wakeDeadTabsNow: wake every pending session now, 10 s apart, idle or not. */
  async runNow(): Promise<WakeSummary> {
    if (!this.on()) return { result: "off", woken: 0, failed: 0, pending: 0 };
    if (this.busy) return { result: "busy", woken: 0, failed: 0, pending: this.pending.length };
    this.busy = true;
    let woken = 0;
    let failed = 0;
    let result: StepResult = "empty";
    try {
      for (;;) {
        result = await this.step(true);
        if (result === "woken") woken++;
        else if (result === "failed") failed++;
        else break;
      }
    } finally {
      this.busy = false;
    }
    const reason = result === "postponed" ? this.lastReason : undefined;
    return { result, woken, failed, pending: this.pending.length, reason };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private on(): boolean {
    return !this.disposed && this.deps.enabled();
  }

  private record(parents: ReadonlyMap<number, number>): void {
    const live = this.deps.liveSessions();
    const own = ownSessions(live, parents, this.deps.hostPid);
    const prev = this.registry ?? asRegistry(this.deps.store.get(REGISTRY_KEY));
    const next = nextRegistry(prev, own, this.deps.now(), (sid) => this.deps.titleOf(sid));
    this.registry = next;
    if (!sameShape(prev, next)) void this.deps.store.update(REGISTRY_KEY, next);
    const running = new Set(live.map((s) => s.sessionId));
    if (this.pending.some((p) => running.has(p.sid))) this.setPending(this.pending.filter((p) => !running.has(p.sid)));
  }

  private setPending(next: PendingEntry[]): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.pending);
    this.pending = next;
    if (changed) void this.deps.store.update(PENDING_KEY, next);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, ms);
  }

  /** The timed sweep: one step (skipped while wakeDeadTabsNow runs), then again in 30 s while pending. */
  private async tick(): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      try {
        await this.step(false);
      } finally {
        this.busy = false;
      }
    }
    if (this.on() && !this.stopped && this.pending.length) this.schedule(SWEEP_EVERY_MS);
  }

  /** One sweep step: drop what no longer qualifies, keep 10 s between wakes, check the preconditions, wake one tab. */
  private async step(manual: boolean): Promise<StepResult> {
    if (!this.on()) return "off";
    if (this.stopped) return "stopped";
    if (!this.nextCandidate()) return "empty";
    const gap = this.lastWakeMs + MIN_GAP_MS - this.deps.now();
    if (gap > 0) await sleep(gap);
    if (!this.on()) return "off";
    const next = this.nextCandidate();
    if (!next) return "empty";
    const reason = await this.blocker(manual);
    if (reason) {
      this.postpone(reason);
      return "postponed";
    }
    const ok = await this.wake(next);
    this.settle(next, ok);
    return ok ? "woken" : "failed";
  }

  /** The first pending session that still qualifies; running ones and those no longer limit-stopped are dropped. */
  private nextCandidate(): PendingEntry | undefined {
    const live = new Set(this.deps.liveSessions().map((s) => s.sessionId));
    const now = this.deps.now();
    const keep = this.pending.filter((p) => !live.has(p.sid));
    while (keep.length && !isLimitStop(this.deps.limitStop(keep[0].sid), now)) keep.shift();
    this.setPending(keep);
    return keep[0];
  }

  /** Why the next wake has to wait, or undefined (idle counts only for the timed sweep). */
  private async blocker(manual: boolean): Promise<string | undefined> {
    if (!manual) {
      const idle = await this.deps.idleMs();
      if (idle === undefined ? this.deps.windowFocused() : idle < IDLE_MIN_MS) return "user active";
    }
    const level = await this.deps.pressureLevel();
    if (level !== undefined && level >= PRESSURE_CRITICAL) return `memory pressure ${level}`;
    if (!(await this.deps.commandExists(OPEN_COMMAND))) return `no ${OPEN_COMMAND} command`;
    return undefined;
  }

  private postpone(reason: string): void {
    this.lastReason = reason;
    const now = this.deps.now();
    if (now - (this.postponedAt.get(reason) ?? -Infinity) < POSTPONE_LOG_MS) return;
    this.postponedAt.set(reason, now);
    this.deps.log(`wake: postponed (${reason}), ${this.pending.length} pending`);
  }

  /** Show `p`'s tab, wait up to 20 s for its process, then put the tabs back if the woken tab is still active. */
  private async wake(p: PendingEntry): Promise<boolean> {
    const memo = this.deps.snapshotTabs();
    const started = this.deps.now();
    this.lastWakeMs = started;
    let error: string | undefined;
    try {
      await this.deps.executeCommand(OPEN_COMMAND, p.sid, undefined, undefined, undefined, undefined, { programmatic: true });
    } catch (e) {
      error = errText(e);
    }
    const woken = this.deps.activeTab();
    const pid = error === undefined ? await this.waitLive(p.sid, started) : undefined;
    if (this.deps.activeTab() === woken) await this.restore(memo);
    const secs = ((this.deps.now() - started) / 1000).toFixed(1);
    if (pid !== undefined) this.deps.log(`wake: ${short(p.sid)} live after ${secs}s pid=${pid}`);
    else this.deps.log(`wake: ${short(p.sid)} failed after ${secs}s (${error ?? "no process"}), attempt ${p.attempts + 1}/${MAX_ATTEMPTS}`);
    return pid !== undefined;
  }

  private async waitLive(sid: string, since: number): Promise<number | undefined> {
    for (;;) {
      const hit = this.deps.liveSessions().find((s) => s.sessionId === sid);
      if (hit) return hit.pid;
      if (this.deps.now() - since >= WAIT_LIVE_MS) return undefined;
      await sleep(POLL_MS);
    }
  }

  private async restore(memo: M): Promise<void> {
    try {
      await this.deps.restoreTabs(memo);
    } catch (e) {
      this.deps.log(`wake: tab restore failed: ${errText(e)}`);
    }
  }

  /** A woken session leaves pending; a failed one goes behind the others, or out after its 2nd failure. */
  private settle(p: PendingEntry, ok: boolean): void {
    const rest = this.pending.filter((x) => x.sid !== p.sid);
    if (ok) {
      this.failsInRow = 0;
      this.setPending(rest);
      return;
    }
    this.failsInRow++;
    this.setPending(p.attempts + 1 >= MAX_ATTEMPTS ? rest : [...rest, { ...p, attempts: p.attempts + 1 }]);
    if (this.failsInRow < MAX_FAILS_IN_ROW) return;
    this.stopped = true;
    this.deps.log(`wake: stopped after ${MAX_FAILS_IN_ROW} failed wakes in a row until the next activation, ${this.pending.length} pending`);
  }
}

// ----------------------------------------------------------- machine side ---

/** Running Claude processes: ~/.claude/sessions/<pid>.json records whose pid is alive. */
export function readLiveSessions(dir = SESSIONS_DIR, alive: (pid: number) => boolean | undefined = pidAlive): LiveSession[] {
  let recs: Array<SessionRecord & { entrypoint?: unknown }>;
  try {
    recs = loadRecords(dir);
  } catch {
    return []; // no sessions dir
  }
  return recs
    .filter((r) => typeof r.sessionId === "string" && r.sessionId !== "" && alive(r.pid) === true)
    .map((r) => ({
      sessionId: r.sessionId as string,
      pid: r.pid,
      entrypoint: typeof r.entrypoint === "string" ? r.entrypoint : undefined,
    }));
}

/** Parent pid of every process from one `ps` snapshot (the resource sampler's format); undefined when ps failed. */
export async function readParentPids(run: typeof runTool = runTool): Promise<Map<number, number> | undefined> {
  const out = await run("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], 4000);
  if (out === null) return undefined;
  const parents = new Map<number, number>();
  for (const r of parsePsOutput(out)) if (r.ppid !== undefined) parents.set(r.pid, r.ppid);
  return parents;
}

/** HIDIdleTime (ns) of `ioreg -r -c IOHIDSystem -d 1`, in ms; undefined when absent. */
export function parseIdleMs(out: string | null): number | undefined {
  const m = out?.match(/"HIDIdleTime"\s*=\s*(\d+)/);
  return m ? Number(m[1]) / 1e6 : undefined;
}

/** `sysctl -n kern.memorystatus_vm_pressure_level` as a number; undefined when unavailable. */
export function parsePressure(out: string | null): number | undefined {
  const n = out === null ? NaN : parseInt(out.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Session `sid`'s transcript, ~/.claude/projects/<project>/<sid>.jsonl. */
export function findTranscript(sid: string, root = PROJECTS_DIR): string | undefined {
  if (!/^[\w-]+$/.test(sid)) return undefined;
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  for (const d of dirs) {
    const file = path.join(root, d, `${sid}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

type MachineDeps = Pick<WakeDeps<unknown>, "liveSessions" | "parentPids" | "limitStop" | "idleMs" | "pressureLevel">;

/** The machine side of WakeDeps (no editor state); transcript paths are cached per session. */
export function nodeProbes(run: typeof runTool = runTool): MachineDeps {
  const transcripts = new Map<string, string>();
  return {
    liveSessions: () => readLiveSessions(),
    parentPids: () => readParentPids(run),
    limitStop: (sid) => {
      const file = transcripts.get(sid) ?? findTranscript(sid);
      if (file) transcripts.set(sid, file);
      return file ? lastAssistantStop(file) : undefined;
    },
    idleMs: async () =>
      process.platform === "darwin" ? parseIdleMs(await run("ioreg", ["-r", "-c", "IOHIDSystem", "-d", "1"], 3000)) : undefined,
    pressureLevel: async () => parsePressure(await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], 3000)),
  };
}
