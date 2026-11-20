/**
 * automationGate.ts — the one gate a tab automation passes right before it shows
 * or moves a tab or types (claudeSessionMonitor.tabAutomation, on by default).
 *
 * The automations: limit-stopped tab wakes (wakeTabs.ts), continuity requests
 * (continuity.ts), the resume and command sweeps, auto-resume after a limit reset
 * and remote typing. Each goes only while tab automation and its own setting are
 * on. A wake (continuity's included) also waits under critical memory pressure,
 * and right before a wake puts the tabs back the switches are checked again. A
 * configuration change that turns an automation off aborts its AbortSignal: a
 * wake's wait and restore and a running sweep stop.
 *
 * No `vscode` import: extension.ts injects the editor side (GateDeps).
 */

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

export const PRESSURE_CRITICAL = 4; // kern.memorystatus_vm_pressure_level: 1 normal, 2 warn, 4 critical

/** What holds a wake back: an automation switched off, or memory. */
export interface Hold {
  kind: "off" | "memory";
  reason: string;
}

/** The gate as one tab-waking feature (wakeTabs.ts, continuity.ts) sees it. */
export interface WakeGate {
  /** What would hold a wake back now (continuity's heartbeat). */
  hold(): Promise<Hold | undefined>;
  /** Right before a wake. */
  admit(): Promise<Hold | undefined>;
  /** Right before a wake puts the tabs back: tab automation and the feature's own setting. */
  beforeRestore(): Promise<Hold | undefined>;
  /** Aborted once a configuration change turns the feature or tab automation off. */
  signal(): AbortSignal;
}

export interface GateDeps {
  log(msg: string): void;
  masterOn(): boolean; // claudeSessionMonitor.tabAutomation
  featureOn(a: Automation): boolean; // the Claude provider and the automation's own setting
  pressureLevel(): Promise<number | undefined>; // kern.memorystatus_vm_pressure_level; undefined: unavailable
}

export class AutomationGate {
  private readonly controllers = new Map<Automation, AbortController>();

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
      admit: () => this.wakeHold(a),
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
    const level = await this.deps.pressureLevel();
    return level !== undefined && level >= PRESSURE_CRITICAL ? { kind: "memory", reason: `memory pressure ${level}` } : undefined;
  }

  private async restoreHold(a: Automation): Promise<Hold | undefined> {
    const off = this.blocker(a);
    return off ? { kind: "off", reason: off } : undefined;
  }
}
