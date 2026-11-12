/**
 * autoResume.ts — per-session choice for the limit auto-resume (remote `autoResume`
 * command, the phone's limit card). claudeSessionMonitor.autoResumeAfterReset runs one
 * staggered resume sweep shortly after a limit resets; a limited Claude session can be
 * switched on for that sweep (also with the setting off) or off (also with it on). The
 * choice is kept in globalState (shared by every window), applies while the session is
 * limited and is dropped once a refresh lists it as not limited, or after 7 days.
 */
import type { SessionView } from "./providers/types";
import type { FleetAutoResume } from "./remote";
import { groupOf } from "./view";

export const OVERRIDES_KEY = "csm.autoResume.overrides";
const OVERRIDE_TTL_MS = 7 * 24 * 3600_000;
const MAX_OVERRIDES = 500;

export interface AutoResumeOverride {
  enabled: boolean;
  setAt: number; // epoch ms
}

export type Overrides = Record<string, AutoResumeOverride>;

/** The stored overrides that are well-formed and younger than 7 days. */
export function readOverrides(raw: unknown, now: number): Overrides {
  const out: Overrides = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [sid, value] of Object.entries(raw as Record<string, unknown>)) {
    const o = value as Partial<AutoResumeOverride> | null;
    if (typeof o?.enabled !== "boolean" || typeof o.setAt !== "number") continue;
    if (now - o.setAt < OVERRIDE_TTL_MS && o.setAt <= now + 60_000) out[sid] = { enabled: o.enabled, setAt: o.setAt };
  }
  return out;
}

/** `overrides` with one session switched on or off (the newest 500 kept). */
export function withOverride(overrides: Overrides, sessionId: string, enabled: boolean, now: number): Overrides {
  const entries = Object.entries({ ...overrides, [sessionId]: { enabled, setAt: now } });
  return Object.fromEntries(entries.sort((a, b) => b[1].setAt - a[1].setAt).slice(0, MAX_OVERRIDES));
}

/** `overrides` without the sessions a refresh lists as not limited; null when nothing goes. */
export function settledOverrides(overrides: Overrides, views: SessionView[]): Overrides | null {
  const out: Overrides = {};
  let dropped = false;
  for (const [sid, o] of Object.entries(overrides)) {
    const v = views.find((x) => x.provider === "claude" && x.sessionId === sid);
    if (v && groupOf(v) !== "limited") dropped = true;
    else out[sid] = o;
  }
  return dropped ? out : null;
}

const isLimitedClaude = (v: SessionView): boolean => v.provider === "claude" && groupOf(v) === "limited";

/** Whether the sweep resumes this limited session: its own choice, else the setting (`all`). */
export function autoResumeOn(v: SessionView, overrides: Overrides, all: boolean): boolean {
  return overrides[v.sessionId]?.enabled ?? all;
}

/** The limited Claude sessions the sweep is for; their reset times decide when it runs. */
export function limitedToResume(views: SessionView[], overrides: Overrides, all: boolean): SessionView[] {
  return views.filter((v) => isLimitedClaude(v) && autoResumeOn(v, overrides, all));
}

/**
 * The sessions the sweep types the resume prompt into: open Claude sessions that take bulk
 * input; a limited one when it is on, any other one only with the setting on.
 */
export function sweepQueue(views: SessionView[], overrides: Overrides, all: boolean): SessionView[] {
  return views.filter((v) => {
    if (v.provider !== "claude" || !v.capabilities.bulkInput || groupOf(v) === "ended") return false;
    return isLimitedClaude(v) ? autoResumeOn(v, overrides, all) : all;
  });
}

/** A limited Claude row's snapshot field: on or off, and the scheduled sweep (epoch s) while on; null on other rows. */
export function rowAutoResume(v: SessionView, overrides: Overrides, all: boolean, sweepAtMs: number): FleetAutoResume | null {
  if (!isLimitedClaude(v)) return null;
  const enabled = autoResumeOn(v, overrides, all);
  return { enabled, at: enabled && sweepAtMs > 0 ? Math.floor(sweepAtMs / 1000) : null };
}
