/**
 * dailyReload.ts - reload the window once it has been open a long time
 * (claudeSessionMonitor.dailyReload, off by default).
 *
 * A window that holds many Claude Code tabs grows: after 17 hours one held
 * 10 GB in its renderer and extension host, 3 GB when fresh. A reload gives the
 * memory back, but it stops every Claude Code session in the window (each
 * `claude` process is a child of the extension host); they come back as their
 * tabs are shown. So it waits for a calm moment: the extension host has run
 * dailyReloadAfterHours, none of this window's sessions has had work in flight
 * (a running turn or background agents) for 2 minutes, the monitor runs no tab
 * automation, and keyboard and mouse have
 * been idle dailyReloadIdleMinutes. An unreadable idle time never reloads.
 * Checked every minute; when due, a notification gives 20 s and a "Not now"
 * button (an hour's snooze), and the window reloads only if the moment is still
 * calm after them.
 */
import * as vscode from "vscode";

export const TICK_MS = 60_000;
export const QUIET_MS = 2 * 60_000; // no working session for this long
export const COUNTDOWN_MS = 20_000; // from the notification to the reload
export const SNOOZE_MS = 60 * 60_000; // "Not now", and a reload that did not happen
export const NOT_NOW = "Not now";
export const RELOAD_COMMAND = "workbench.action.reloadWindow";
const HOUR_MS = 3_600_000;
const DEFAULTS: Readonly<ReloadSettings> = { enabled: false, afterHours: 20, idleMinutes: 5 };

export type ReloadAction = "off" | "young" | "snoozed" | "busy" | "user-active" | "idle-unknown" | "reload";

export interface Decision {
  action: ReloadAction;
  detail: string;
}

/** What the decision reads. */
export interface DecisionInput {
  enabled: boolean;
  uptimeMs: number; // of the extension host
  afterMs: number; // dailyReloadAfterHours
  snoozedUntil: number; // epoch ms; 0: not snoozed
  nowMs: number;
  working: number; // this window's sessions mid-turn
  quietMs: number; // how long `working` has been 0
  busy: boolean; // the monitor runs a tab automation
  idleMs: number | undefined; // since the last keyboard or mouse input; undefined: unreadable
  idleMinMs: number; // dailyReloadIdleMinutes
}

type TimeInput = Pick<DecisionInput, "enabled" | "uptimeMs" | "afterMs" | "snoozedUntil" | "nowMs">;

const hours = (ms: number): string => (ms / HOUR_MS).toFixed(1);
const minutes = (ms: number): number => Math.floor(ms / 60_000);

/** off, young or snoozed, from the settings and the clocks alone; undefined once the reload is due. */
export function timeGate(i: TimeInput): Decision | undefined {
  if (!i.enabled) return { action: "off", detail: "off" };
  if (i.uptimeMs < i.afterMs) return { action: "young", detail: `not due yet (up ${hours(i.uptimeMs)} h, due at ${hours(i.afterMs)} h)` };
  if (i.nowMs < i.snoozedUntil) return { action: "snoozed", detail: `due, snoozed for ${Math.ceil((i.snoozedUntil - i.nowMs) / 60_000)} min` };
  return undefined;
}

/** Whether to reload now; anything unknown keeps the window as it is. */
export function decide(i: DecisionInput): Decision {
  const gate = timeGate(i);
  if (gate) return gate;
  if (i.busy) return { action: "busy", detail: "due, waiting (tab automation running)" };
  if (i.working > 0) return { action: "busy", detail: `due, waiting (${i.working} working)` };
  if (i.quietMs < QUIET_MS) return { action: "busy", detail: `due, waiting (no session working for ${Math.floor(i.quietMs / 1000)} s of ${QUIET_MS / 1000})` };
  if (i.idleMs === undefined) return { action: "idle-unknown", detail: "due, waiting (keyboard and mouse idle time unreadable)" };
  if (i.idleMs < i.idleMinMs) return { action: "user-active", detail: `due, waiting (input ${minutes(i.idleMs)} min ago, needs ${minutes(i.idleMinMs)} min)` };
  return { action: "reload", detail: `up ${hours(i.uptimeMs)} h, idle ${minutes(i.idleMs)} min, ${i.working} working` };
}

/** A running Claude process as ~/.claude/sessions/<pid>.json records it. */
export interface SessionLoad {
  sessionId: string;
  status?: string; // Claude Code's own "busy" | "idle"; absent on a CLI that records none
}

/**
 * How many of this window's sessions have work in flight. Claude Code's own
 * status wins where a session has one: a session whose turn ended while its
 * background agents still run is "busy" there and not in the panel's working
 * group (measured 2026-11-27: 4 of 18 busy sessions). A session without a
 * status counts when the panel shows it working. `own` undefined: ownership
 * could not be read, so every session counts.
 */
export function inFlight(live: readonly SessionLoad[], panelWorking: readonly string[], own: ReadonlySet<string> | undefined): number {
  const status = new Map(live.map((s) => [s.sessionId, s.status] as const));
  const working = new Set(panelWorking);
  let n = 0;
  for (const sid of new Set([...status.keys(), ...working])) {
    if (own && !own.has(sid)) continue;
    const st = status.get(sid);
    if (st === undefined ? working.has(sid) : st === "busy") n++;
  }
  return n;
}

export interface ReloadSettings {
  enabled: boolean;
  afterHours: number;
  idleMinutes: number;
}

/** What the reload needs from extension.ts. */
export interface DailyReloadDeps {
  log(msg: string): void;
  idleMs(): Promise<number | undefined>; // since the last keyboard or mouse input; undefined: unreadable
  working(): Promise<number>; // this window's sessions in the panel's working group
  busy(): boolean; // a tab wake or a resume sweep runs
}

/** DailyReloadDeps plus the editor and the clocks; activateDailyReload fills them in. */
export interface ReloaderDeps extends DailyReloadDeps {
  settings(): ReloadSettings;
  uptimeMs(): number;
  now(): number;
  warn(text: string, button: string): Thenable<string | undefined>;
  reload(): Thenable<unknown>;
}

/** The minute check, the 20 s countdown and the reload. */
export class DailyReloader {
  private lastAction: ReloadAction = "off"; // a decision is logged when its action changes
  private quietSince: number | undefined; // when `working` was last seen go to 0
  private snoozedUntil = 0;
  private running = false; // a check or a countdown is in progress
  private disposed = false;
  private interval: ReturnType<typeof setInterval> | undefined;
  private countdownTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: ReloaderDeps) {}

  start(): void {
    this.interval = setInterval(() => void this.tick(), TICK_MS);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.interval);
    clearTimeout(this.countdownTimer);
  }

  /** One check; when it says reload, the countdown. Resolves once both are over. */
  async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      const d = await this.check();
      if (d.action === "reload") await this.countdown(d);
    } catch (e: unknown) {
      this.deps.log(`daily reload: check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }

  /** The decision now; the sessions and the idle time are read only once the reload is due. */
  private async check(): Promise<Decision> {
    const s = this.deps.settings();
    const time: TimeInput = { enabled: s.enabled, uptimeMs: this.deps.uptimeMs(), afterMs: s.afterHours * HOUR_MS, snoozedUntil: this.snoozedUntil, nowMs: this.deps.now() };
    const early = timeGate(time);
    if (early) {
      this.quietSince = undefined; // sessions are not watched meanwhile: the quiet starts again
      return this.note(early);
    }
    const [working, idleMs] = await Promise.all([this.deps.working(), this.deps.idleMs()]);
    const now = this.deps.now();
    if (working > 0) this.quietSince = undefined;
    else this.quietSince ??= now;
    const quietMs = this.quietSince === undefined ? 0 : now - this.quietSince;
    return this.note(decide({ ...time, nowMs: now, working, quietMs, busy: this.deps.busy(), idleMs, idleMinMs: s.idleMinutes * 60_000 }));
  }

  /** Logs `d` when its action differs from the last one; the reload logs its own lines. */
  private note(d: Decision): Decision {
    if (d.action !== this.lastAction && d.action !== "reload") this.deps.log(`daily reload: ${d.detail}`);
    this.lastAction = d.action;
    return d;
  }

  /** The notice, 20 s, a second check, then the reload if that check still says so. */
  private async countdown(d: Decision): Promise<void> {
    this.deps.log(`daily reload: due, reloading in ${COUNTDOWN_MS / 1000} s unless "${NOT_NOW}" (${d.detail})`);
    const text = `Agent Session Monitor will reload this window in ${COUNTDOWN_MS / 1000} s (daily reload, open ${hours(this.deps.uptimeMs())} h).`;
    void Promise.resolve(this.deps.warn(text, NOT_NOW)).then(
      (choice) => {
        if (choice !== NOT_NOW) return;
        this.snoozedUntil = this.deps.now() + SNOOZE_MS;
        this.lastAction = "snoozed";
        this.deps.log(`daily reload: not now, snoozed for ${SNOOZE_MS / 60_000} min`);
      },
      () => undefined,
    );
    await new Promise<void>((resolve) => (this.countdownTimer = setTimeout(resolve, COUNTDOWN_MS)));
    if (this.disposed) return;
    const again = await this.check();
    if (again.action !== "reload" || this.disposed) return;
    this.deps.log(`daily reload: reloading window (${again.detail})`);
    await this.deps.reload();
    // Still here: the reload did not happen (a dialog was cancelled, say). The next try is an hour away, not a minute.
    this.snoozedUntil = this.deps.now() + SNOOZE_MS;
  }
}

/** A finite number of at least `min`, else `def`. */
function num(v: unknown, def: number, min: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : def;
}

/** Reads the three settings each check, so a change applies within a minute without a restart. */
export function readReloadSettings(get: (key: string) => unknown): ReloadSettings {
  return {
    enabled: get("dailyReload") === true,
    afterHours: num(get("dailyReloadAfterHours"), DEFAULTS.afterHours, 0.01),
    idleMinutes: num(get("dailyReloadIdleMinutes"), DEFAULTS.idleMinutes, 0),
  };
}

/** Starts the minute check; it stops with the extension. */
export function activateDailyReload(ctx: vscode.ExtensionContext, deps: DailyReloadDeps): DailyReloader {
  const reloader = new DailyReloader({
    ...deps,
    settings: () => {
      const c = vscode.workspace.getConfiguration("claudeSessionMonitor");
      return readReloadSettings((key) => c.get<unknown>(key));
    },
    uptimeMs: () => process.uptime() * 1000,
    now: () => Date.now(),
    warn: (text, button) => vscode.window.showWarningMessage(text, button),
    reload: () => vscode.commands.executeCommand(RELOAD_COMMAND),
  });
  reloader.start();
  ctx.subscriptions.push(reloader);
  return reloader;
}
