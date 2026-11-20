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
 * process, then puts the tabs and focus back unless the user works in the window
 * by then. Nothing is ever sent to a session.
 * A continuity request (continuity.ts) goes first: no tab is woken while one is
 * served or waits. Every wake passes the automation gate (automationGate.ts: tab
 * automation, Claude Code, memory, the spawn budget) and every restore its switches
 * and Claude Code check; turning the setting or tab automation off cancels a wake
 * before its show, its wait and its restore. A start keeps only the sessions whose
 * Claude Code tab is open: tabs closed while the waker was off are never reopened.
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
import type { WakeGate } from "./automationGate";

export const OPEN_COMMAND = "claude-vscode.editor.open";
export const REGISTRY_KEY = "csm.wake.registry";
export const PENDING_KEY = "csm.wake.pending";

const OBSERVE_EVERY_MS = 10_000; // registry cadence (refresh runs every 1.5 s and on transcript writes)
const DROP_AFTER_MISSES = 2; // a session leaves the registry after 2 observations without it...
const DROP_AFTER_MS = 60_000; // ...and 60 s, so the mass exit at shutdown never empties it
export const FIRST_SWEEP_MS = 60_000;
const SWEEP_EVERY_MS = 30_000;
export const MIN_GAP_MS = 10_000; // between two wakes
export const IDLE_MIN_MS = 20_000;
export const WAIT_LIVE_MS = 20_000;
export const POLL_MS = 500;
const REVEAL_WAIT_MS = 1_000; // Claude Code shows the tab only after editor.open returns
const REVEAL_POLL_MS = 50;
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
  commandExists(id: string): Promise<boolean>;
  executeCommand(id: string, ...args: unknown[]): PromiseLike<unknown>;
  snapshotTabs(): M; // each group's active tab and the active group
  activeTab(): unknown;
  activeClaudeLabel(): string | undefined; // the active tab's label when it is a Claude Code tab
  restoreTabs(snapshot: M): Promise<void>;
  claudeTabLabels(): string[]; // the labels of this window's Claude Code tabs
  yieldTo?(): boolean; // a continuity request (continuity.ts) is served or waits: it goes first
  gate: WakeGate; // automationGate.ts, consulted right before a wake and its restore
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

  /**
   * Activation, before the first refresh, or the setting turned on (`explicit`: a stop after failed wakes is
   * lifted): pending = remembered minus running, limit stops with an open Claude Code tab carrying their title only.
   */
  start(explicit = false): void {
    if (!this.deps.enabled()) return; // the gate first: nothing is read, written or scheduled
    if (explicit) {
      this.stopped = false;
      this.failsInRow = 0;
    }
    const reg = asRegistry(this.deps.store.get(REGISTRY_KEY));
    this.registry = reg;
    this.pending = asPending(this.deps.store.get(PENDING_KEY));
    const live = new Set(this.deps.liveSessions().map((s) => s.sessionId));
    const remembered = pendingAt(reg, this.pending, live);
    const labels = this.deps.claudeTabLabels();
    const withTab = remembered.filter((p) => p.title !== undefined && labels.some((label) => labelsMatchStrict(label, p.title as string)));
    const now = this.deps.now();
    this.setPending(withTab.filter((p) => isLimitStop(this.deps.limitStop(p.sid), now)));
    this.deps.log(
      `wake: activation registry=${reg.length} pending=${remembered.length} with a tab=${withTab.length} limit-stopped=${this.pending.length}`,
    );
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

  /** A sweep step or wakeDeadTabsNow is running (continuity.ts waits for it). */
  isBusy(): boolean {
    return this.busy;
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
    const signal = this.deps.gate.signal(); // taken before the checks: a change while they run still cancels the wake
    const reason = await this.blocker(manual);
    if (reason) {
      this.postpone(reason);
      return "postponed";
    }
    const result = await this.wake(next, signal);
    if (result === "cancelled") return "postponed"; // no try used: the setting or tab automation went off during the wake
    this.settle(next, result === "woken");
    return result;
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

  /**
   * Why the next wake has to wait, or undefined: the gate (tab automation, Claude Code,
   * memory, the spawn budget), then the command, then the user (timed sweep only),
   * read last so the idle time is fresh when the wake starts.
   */
  private async blocker(manual: boolean): Promise<string | undefined> {
    const held = await this.deps.gate.admit();
    if (held) return held.reason;
    if (!(await this.deps.commandExists(OPEN_COMMAND))) return `no ${OPEN_COMMAND} command`;
    if (!manual && (await this.recentInput())) return "user active";
    if (this.deps.yieldTo?.()) return "continuity request first"; // last: nothing awaits between it and the wake
    return undefined;
  }

  /** Input in the last 20 s; with the idle time unreadable, a focused window counts as input. */
  private async recentInput(): Promise<boolean> {
    const idle = await this.deps.idleMs();
    return idle === undefined ? this.deps.windowFocused() : idle < IDLE_MIN_MS;
  }

  /** The user works in this window: input in the last 20 s while it is focused. */
  private async userAtWindow(): Promise<boolean> {
    return (await this.recentInput()) && this.deps.windowFocused();
  }

  private postpone(reason: string): void {
    this.lastReason = reason;
    const now = this.deps.now();
    if (now - (this.postponedAt.get(reason) ?? -Infinity) < POSTPONE_LOG_MS) return;
    this.postponedAt.set(reason, now);
    this.deps.log(`wake: postponed (${reason}), ${this.pending.length} pending`);
  }

  /**
   * Show `p`'s tab, wait up to 20 s for its process, then put the tabs back if the
   * woken tab is still active and the user does not work in this window. Turning the
   * setting or tab automation off ends the wait and leaves the tabs as they are.
   */
  private async wake(p: PendingEntry, signal: AbortSignal): Promise<"woken" | "failed" | "cancelled"> {
    if (signal.aborted) {
      this.lastReason = errText(signal.reason);
      this.deps.log(`wake: ${short(p.sid)} cancelled before the show (${this.lastReason})`);
      return "cancelled";
    }
    this.deps.gate.spend();
    const memo = this.deps.snapshotTabs();
    const started = this.deps.now();
    this.lastWakeMs = started;
    let error: string | undefined;
    try {
      await this.deps.executeCommand(OPEN_COMMAND, p.sid, undefined, undefined, undefined, undefined, { programmatic: true });
    } catch (e) {
      error = errText(e);
    }
    const [woken, pid]: [unknown, number | undefined] =
      error === undefined
        ? await Promise.all([this.shownTab(p, signal), this.waitLive(p.sid, started, signal)])
        : [this.deps.activeTab(), undefined];
    const secs = (): string => ((this.deps.now() - started) / 1000).toFixed(1);
    if (signal.aborted && pid === undefined) {
      this.lastReason = errText(signal.reason);
      this.deps.log(`wake: ${short(p.sid)} cancelled after ${secs()}s (${this.lastReason}), tabs left as they are`);
      return "cancelled";
    }
    const userActive = await this.userAtWindow();
    if (this.deps.activeTab() === woken) {
      if (userActive) this.deps.log(`wake: ${short(p.sid)} tabs left as they are, the user is active in this window`);
      else await this.restore(memo, p, signal);
    }
    if (pid !== undefined) this.deps.log(`wake: ${short(p.sid)} live after ${secs()}s pid=${pid}`);
    else this.deps.log(`wake: ${short(p.sid)} failed after ${secs()}s (${error ?? "no process"}), attempt ${p.attempts + 1}/${MAX_ATTEMPTS}`);
    return pid !== undefined ? "woken" : "failed";
  }

  /** The active tab once a Claude Code tab labelled with `p`'s title is (Claude Code shows it after the command returns), else after 1 s. */
  private async shownTab(p: PendingEntry, signal: AbortSignal): Promise<unknown> {
    const title = this.deps.titleOf(p.sid) ?? p.title;
    const shown = (): boolean => {
      const label = this.deps.activeClaudeLabel();
      return title !== undefined && label !== undefined && labelsMatchStrict(label, title);
    };
    const until = this.deps.now() + REVEAL_WAIT_MS;
    while (!shown() && !signal.aborted && this.deps.now() < until) await sleep(REVEAL_POLL_MS);
    return this.deps.activeTab();
  }

  private async waitLive(sid: string, since: number, signal: AbortSignal): Promise<number | undefined> {
    for (;;) {
      const hit = this.deps.liveSessions().find((s) => s.sessionId === sid);
      if (hit) return hit.pid;
      if (signal.aborted || this.deps.now() - since >= WAIT_LIVE_MS) return undefined;
      await sleep(POLL_MS);
    }
  }

  /** Put the tabs back unless the wake was cancelled or the gate holds right now (tab automation, the setting, Claude Code). */
  private async restore(memo: M, p: PendingEntry, signal: AbortSignal): Promise<void> {
    const held = signal.aborted ? errText(signal.reason) : (await this.deps.gate.beforeRestore())?.reason;
    if (held !== undefined) {
      this.deps.log(`wake: ${short(p.sid)} tabs left as they are (${held})`);
      return;
    }
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

type MachineDeps = Pick<WakeDeps<unknown>, "liveSessions" | "parentPids" | "limitStop" | "idleMs"> & {
  pressureLevel(): Promise<number | undefined>; // the automation gate's memory check (automationGate.ts); undefined: unavailable
};

/** The machine side of WakeDeps and the automation gate's memory pressure (no editor state); transcript paths are cached per session. */
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
