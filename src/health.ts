/**
 * health.ts - this window's health file, ~/.claude/session-monitor/health/<win>.json,
 * rewritten atomically every 30 s: the extension version, each feature's status
 * (ok, error or disabled), the 95th percentile of the recent refresh durations,
 * whether the restart guard is armed and, while the remote bridge runs, the
 * sessions whose tab or terminal the window holds. <win> is the window key of the
 * debug log and the continuity heartbeat (continuity.ts windowKey). overseerBeat.ts
 * and remoteForward.ts read the files of all live windows. No vscode import.
 */
import * as path from "path";
import { performance } from "perf_hooks";

export const HEALTH_VERSION = 1;
export const HEALTH_EVERY_MS = 30_000;
export const REFRESH_SAMPLES = 120; // about 3 minutes of refreshes at the default 1.5 s poll
export const RECENT_FAIL_MS = 60_000; // a refresh stage that failed this recently marks its feature "error"

export type FeatureStatus = "ok" | "error" | "disabled";

export interface WindowHealth {
  v: number;
  win: string;
  pid: number;
  version: string;
  ts: number; // epoch seconds of this write
  features: Record<string, FeatureStatus>;
  refreshP95Ms: number | null; // null before the first refresh
  refreshSamples: number;
  guardArmed: boolean;
  holds?: string[]; // while the remote bridge runs: the sessions whose tab or terminal this window holds (remoteForward.ts)
}

/** A feature's stages in the stage guard: `start` runs once at activation; a refresh stage also matches "<stage> <detail>". */
export interface FeatureStages {
  start?: string;
  stages: readonly string[];
}

/** The stage names extension.ts gives the stage guard, by feature. */
export const FEATURES: Readonly<Record<string, FeatureStages>> = {
  sessions: { stages: ["refresh", "collect", "session drops", "sessions", "stuck check", "transitions", "sampling"] },
  limits: { stages: ["limits"] },
  remote: { start: "remote bridge start", stages: ["remote bridge"] },
  autoResume: { stages: ["auto-resume"] },
  continuity: { start: "continuity start", stages: ["continuity"] },
  wake: { start: "tab wake start", stages: ["tab wake"] },
  restartGuard: { start: "restart guard start", stages: [] },
  dailyReload: { start: "daily reload start", stages: [] },
};

/**
 * Each feature's status: error once its start failed (it stays off until the next
 * activation), or while one of its refresh stages failed within the last minute;
 * otherwise ok when its settings turn it on, disabled when they do not.
 */
export function featureStatuses(enabled: Readonly<Record<string, boolean>>, failures: ReadonlyMap<string, number>, nowMs: number): Record<string, FeatureStatus> {
  const recent = [...failures].filter(([, ms]) => nowMs - ms < RECENT_FAIL_MS).map(([stage]) => stage);
  const status = (name: string, f: FeatureStages): FeatureStatus => {
    if (f.start !== undefined && failures.has(f.start)) return "error";
    if (enabled[name] !== true) return "disabled";
    return recent.some((stage) => f.stages.some((s) => stage === s || stage.startsWith(`${s} `))) ? "error" : "ok";
  };
  return Object.fromEntries(Object.entries(FEATURES).map(([name, f]) => [name, status(name, f)]));
}

/** The last `size` durations in ms, and their 95th percentile (nearest rank). */
export class DurationRing {
  private readonly values: number[] = [];
  private next = 0;

  constructor(private readonly size = REFRESH_SAMPLES) {}

  add(ms: number): void {
    if (this.values.length < this.size) this.values.push(ms);
    else this.values[this.next] = ms;
    this.next = (this.next + 1) % this.size;
  }

  get count(): number {
    return this.values.length;
  }

  p95(): number | null {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.ceil(0.95 * sorted.length) - 1];
  }
}

/**
 * The main-thread time of an async run such as a refresh: the time between
 * its awaits. The run awaits through wait(), and the time a wait takes is not
 * counted, nor is work done inside the awaited promise meanwhile.
 */
export class BusyClock {
  private busy = 0;
  private mark: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.mark = now();
  }

  async wait<T>(promise: Promise<T>): Promise<T> {
    this.busy += this.now() - this.mark;
    try {
      return await promise;
    } finally {
      this.mark = this.now();
    }
  }

  /** The ms counted so far, the current slice included. */
  total(): number {
    return this.busy + this.now() - this.mark;
  }
}

export interface HealthDeps {
  dir: string;
  win: string;
  pid: number;
  version: string;
  nowMs(): number;
  enabled(): Record<string, boolean>; // by feature name, from the settings
  failures(): ReadonlyMap<string, number>; // stage -> when it last failed (safeStage.ts lastFailures)
  refresh: DurationRing;
  guardArmed(): boolean;
  holds?(): string[] | undefined; // the sessions this window holds while the remote bridge runs, else undefined
  shared(): boolean; // false in observer mode (observerMode.ts sharedFiles): the file is neither written nor removed
  write(file: string, text: string): void; // atomic
  remove(file: string): void;
}

export function healthFile(dir: string, win: string): string {
  return path.join(dir, `${win}.json`);
}

export function buildHealth(deps: HealthDeps): WindowHealth {
  const now = deps.nowMs();
  const p95 = deps.refresh.p95();
  const holds = deps.holds?.();
  return {
    v: HEALTH_VERSION,
    win: deps.win,
    pid: deps.pid,
    version: deps.version,
    ts: Math.floor(now / 1000),
    features: featureStatuses(deps.enabled(), deps.failures(), now),
    refreshP95Ms: p95 === null ? null : Math.round(p95 * 10) / 10,
    refreshSamples: deps.refresh.count,
    guardArmed: deps.guardArmed(),
    ...(holds ? { holds } : {}),
  };
}

/** Writes this window's health file now (not in observer mode). */
export function writeHealth(deps: HealthDeps): WindowHealth {
  const health = buildHealth(deps);
  if (deps.shared()) deps.write(healthFile(deps.dir, deps.win), `${JSON.stringify(health)}\n`);
  return health;
}

/** Removes this window's health file (the window is closing). */
export function removeHealth(deps: HealthDeps): void {
  if (deps.shared()) deps.remove(healthFile(deps.dir, deps.win));
}

const STATUSES: readonly string[] = ["ok", "error", "disabled"];

/** A health file's content, or undefined for anything else. */
export function parseHealth(text: string | undefined): WindowHealth | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const h = raw as Partial<WindowHealth>;
  const featuresOk = !!h.features && typeof h.features === "object" && Object.values(h.features).every((s) => STATUSES.includes(String(s)));
  const ok =
    h.v === HEALTH_VERSION &&
    typeof h.win === "string" &&
    typeof h.pid === "number" &&
    typeof h.version === "string" &&
    typeof h.ts === "number" &&
    featuresOk &&
    (h.refreshP95Ms === null || typeof h.refreshP95Ms === "number") &&
    typeof h.refreshSamples === "number" &&
    typeof h.guardArmed === "boolean" &&
    (h.holds === undefined || (Array.isArray(h.holds) && h.holds.every((id) => typeof id === "string")));
  return ok ? (h as WindowHealth) : undefined;
}
