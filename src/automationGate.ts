/**
 * automationGate.ts — the one gate a tab automation passes right before it shows
 * or moves a tab or types (claudeSessionMonitor.tabAutomation, on by default).
 *
 * The automations: limit-stopped tab wakes (wakeTabs.ts), continuity requests
 * (continuity.ts), the resume and command sweeps, auto-resume after a limit reset
 * and remote typing. Each goes only while tab automation and its own setting are
 * on.
 *
 * A wake shows a tab whose `claude` process then starts, so wakes (continuity's
 * included) also wait while memory is tight (kern.memorystatus_vm_pressure_level at
 * warn or above, or the pulse daemon at ORANGE or RED where it is installed) and
 * once this window woke 3 tabs in 5 minutes; each such refusal backs the next try
 * off, 30 s doubling up to 10 min. Right before a wake puts the tabs back the
 * switches and memory are checked again. A configuration change that
 * turns an automation off aborts its AbortSignal: a wake's wait and restore and a
 * running sweep stop.
 *
 * No `vscode` import: extension.ts injects the editor side (GateDeps).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const SECTION = "claudeSessionMonitor";
export const MASTER_SETTING = "tabAutomation";

export type Automation = "wake" | "continuity" | "autoResume" | "typingSweep" | "remoteTyping";
const AUTOMATIONS: readonly Automation[] = ["wake", "continuity", "autoResume", "typingSweep", "remoteTyping"];

/** Each automation's own setting; a sweep started by hand has none. */
export const OWN_SETTING: Readonly<Record<Automation, string | undefined>> = {
  wake: "wakeDeadTabs",
  continuity: "continuityChannel",
  autoResume: "autoResumeAfterReset",
  typingSweep: undefined,
  remoteTyping: "remote.typeFallback",
};

export const PRESSURE_WARN = 2; // kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical
const PULSE_HOLD: readonly string[] = ["ORANGE", "RED"];
export const PULSE_MAX_AGE_MS = 2 * 60_000;
export const WAKE_BUDGET = 3; // wakes per window...
export const BUDGET_WINDOW_MS = 5 * 60_000; // ...in any 5 minutes
export const BACKOFF_MS = 30_000; // after a refused wake, doubling with each refusal in a row...
export const BACKOFF_MAX_MS = 10 * 60_000; // ...up to 10 minutes

/** What holds a wake back: an automation switched off, memory, or the spawn budget. */
export interface Hold {
  kind: "off" | "memory" | "budget";
  reason: string;
}

/** The gate as one tab-waking feature (wakeTabs.ts, continuity.ts) sees it. */
export interface WakeGate {
  /** What would hold a wake back now; nothing is counted (continuity's heartbeat). */
  hold(): Promise<Hold | undefined>;
  /** Right before a wake: hold(), and a memory or budget hold backs the next try off. */
  admit(): Promise<Hold | undefined>;
  /** The wake starts: it counts against this window's budget. */
  spend(): void;
  /** Right before a wake puts the tabs back: the switches and memory (not the budget). */
  beforeRestore(): Promise<Hold | undefined>;
  /** Aborted once a configuration change turns the feature or tab automation off. */
  signal(): AbortSignal;
}

export interface GateDeps {
  log(msg: string): void;
  now(): number; // epoch ms
  masterOn(): boolean; // claudeSessionMonitor.tabAutomation
  featureOn(a: Automation): boolean; // the Claude provider and the automation's own setting
  pressureLevel(): Promise<number | undefined>; // kern.memorystatus_vm_pressure_level; undefined: unavailable
  pulseStage(): Promise<string | undefined>; // readPulseStage
}

/** The pulse daemon's stage in its state file's text; undefined when unparsable, without a stage, or more than 2 minutes off. */
export function pulseStageOf(text: string | undefined, nowMs: number): string | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const { stage, ts } = raw as { stage?: unknown; ts?: unknown };
  if (typeof stage !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return undefined;
  return Math.abs(nowMs - ts * 1000) <= PULSE_MAX_AGE_MS ? stage : undefined;
}

/** The pulse daemon's stage where ~/.claude/bin/pulse is installed, from its state file (the CLI is never run); else undefined. */
export async function readPulseStage(nowMs: number, home: string = os.homedir()): Promise<string | undefined> {
  if (!fs.existsSync(path.join(home, ".claude", "bin", "pulse"))) return undefined;
  const text = await fs.promises.readFile(path.join(home, ".claude", "state", "pulse", "state.json"), "utf8").catch(() => undefined);
  return pulseStageOf(text, nowMs);
}

export class AutomationGate {
  private readonly controllers = new Map<Automation, AbortController>();
  private wakes: number[] = []; // wakes started in the budget window (epoch ms)
  private refusals = 0; // wakes refused in a row
  private backoff: { until: number; hold: Hold } | undefined;

  constructor(private readonly deps: GateDeps) {}

  /** Why automation `a` may not show, move or type now, or undefined. */
  blocker(a: Automation): string | undefined {
    return this.offReason(a);
  }

  /** The AbortSignal of `a`'s work in progress: aborted once a configuration change turns `a` or tab automation off. */
  signal(a: Automation): AbortSignal {
    let c = this.controllers.get(a);
    if (!c) {
      c = new AbortController();
      this.controllers.set(a, c);
    }
    return c.signal;
  }

  /** onDidChangeConfiguration (`affects`: its affectsConfiguration): aborts the work in progress of every automation the change turned off. */
  configChanged(affects: (setting: string) => boolean): void {
    const general = affects(`${SECTION}.${MASTER_SETTING}`) || affects(`${SECTION}.enableClaude`);
    for (const a of AUTOMATIONS) {
      const own = OWN_SETTING[a];
      if (!general && !(own !== undefined && affects(`${SECTION}.${own}`))) continue;
      const why = this.offReason(a);
      const c = this.controllers.get(a);
      if (why === undefined || !c) continue;
      this.controllers.delete(a);
      c.abort(why);
      this.deps.log(`gate: ${a} turned off (${why}), its work in progress is cancelled`);
    }
  }

  /** The gate as `a`'s tab wakes see it. */
  wakeGate(a: "wake" | "continuity"): WakeGate {
    return {
      hold: () => this.wakeHold(a),
      admit: () => this.admit(a),
      spend: () => this.spend(),
      beforeRestore: () => this.restoreHold(a),
      signal: () => this.signal(a),
    };
  }

  private offReason(a: Automation): string | undefined {
    if (!this.deps.masterOn()) return "tab automation is off";
    if (!this.deps.featureOn(a)) return `${OWN_SETTING[a] ?? "the Claude provider"} is off`;
    return undefined;
  }

  private async wakeHold(a: Automation): Promise<Hold | undefined> {
    const off = this.blocker(a);
    if (off) return { kind: "off", reason: off };
    if (this.backoff && this.deps.now() < this.backoff.until) return this.backoff.hold;
    const memory = await this.memoryReason();
    if (memory) return { kind: "memory", reason: memory };
    return this.recentWakes().length >= WAKE_BUDGET ? { kind: "budget", reason: `${WAKE_BUDGET} wakes in 5 min` } : undefined;
  }

  private async admit(a: Automation): Promise<Hold | undefined> {
    const backingOff = this.backoff !== undefined && this.deps.now() < this.backoff.until;
    const h = await this.wakeHold(a);
    if (h && h.kind !== "off" && !backingOff) {
      this.refusals++;
      const ms = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * 2 ** (this.refusals - 1));
      this.backoff = { until: this.deps.now() + ms, hold: h };
      this.deps.log(`gate: ${a} held back (${h.reason}), next try in ${ms / 1000} s`);
    }
    return h;
  }

  private spend(): void {
    this.wakes = [...this.recentWakes(), this.deps.now()];
    this.refusals = 0;
    this.backoff = undefined;
  }

  private recentWakes(): number[] {
    const now = this.deps.now();
    return this.wakes.filter((t) => now - t < BUDGET_WINDOW_MS);
  }

  private async restoreHold(a: Automation): Promise<Hold | undefined> {
    const off = this.blocker(a);
    if (off) return { kind: "off", reason: off };
    const memory = await this.memoryReason();
    return memory ? { kind: "memory", reason: memory } : undefined;
  }

  private async memoryReason(): Promise<string | undefined> {
    const level = await this.deps.pressureLevel();
    if (level !== undefined && level >= PRESSURE_WARN) return `memory pressure ${level}`;
    const stage = await this.deps.pulseStage();
    return stage !== undefined && PULSE_HOLD.includes(stage) ? `pulse ${stage}` : undefined;
  }
}
