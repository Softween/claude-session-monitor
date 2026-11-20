/**
 * sessionLog.ts - what the debug log says about the session list: a summary every
 * 5 minutes (it replaced a session-count line every 20 s), and one event when 5 or
 * more live sessions are gone within 60 s, as when an extension-host restart stops
 * every session of its window at once. No vscode import.
 */
import { countBuckets, type SessionView } from "./core";
import { countProviders } from "./providers/registry";

export const SUMMARY_EVERY_SEC = 300;
export const DROP_COUNT = 5;
export const DROP_WINDOW_MS = 60_000;

/** The keys of the sessions that are not ended. */
export function liveKeys(views: readonly SessionView[]): string[] {
  return views.filter((v) => v.bucket !== "ended").map((v) => v.key);
}

/** The 5-minute summary line, with the counts the 20 s line carried. */
export function sessionSummary(views: SessionView[], dismissed: number): string {
  return `sessions=${views.length} ${JSON.stringify(countBuckets(views))} providers=${JSON.stringify(countProviders(views))} dismissed=${dismissed}`;
}

interface Gone {
  key: string;
  ms: number;
}

/** Watches the live sessions between refreshes and reports a wave of them going. */
export class SessionDrops {
  private live = new Set<string>();
  private scope: string | undefined;
  private gone: readonly Gone[] = [];
  private inWave = false;

  /**
   * `keys`: the live sessions now; `scope`: what decides the list (enabled providers,
   * workspace filter): a change starts over without an event, like the first call.
   * Returns the event line once per wave: when 5 or more sessions went within 60 s,
   * and not again until fewer than 5 went in the last 60 s.
   */
  observe(keys: readonly string[], scope: string, nowMs: number): string | undefined {
    const now = new Set(keys);
    const before = this.live;
    this.live = now;
    if (scope !== this.scope) {
      this.scope = scope;
      this.gone = [];
      this.inWave = false;
      return undefined;
    }
    const went = [...before].filter((k) => !now.has(k)).map((key) => ({ key, ms: nowMs }));
    this.gone = [...this.gone.filter((g) => !now.has(g.key) && nowMs - g.ms < DROP_WINDOW_MS), ...went];
    if (this.gone.length < DROP_COUNT) {
      this.inWave = false;
      return undefined;
    }
    if (this.inWave) return undefined;
    this.inWave = true;
    const ids = this.gone.map((g) => g.key.slice(g.key.indexOf(":") + 1, g.key.indexOf(":") + 9)).join(" ");
    return `sessions: ${this.gone.length} live sessions gone within ${DROP_WINDOW_MS / 1000} s, ${now.size} still live (${ids})`;
  }
}
