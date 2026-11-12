/**
 * closingBuckets.ts — pure (vscode-free) timing of the ⏳ closing status line
 * ("⏳ Kapatma: <what still runs> · bitiş ~HH:MM"). A your-turn session that only
 * waits on a background job is listed under In background until it is overdue
 * (OVERDUE_GRACE_SEC past its finish time, or NO_DUE_IDLE_SEC idle without one);
 * then it returns to Your turn flagged late.
 */
import type { ClosingTiming, SessionView } from "./providers/types";

export const OVERDUE_GRACE_SEC = 5 * 60;
export const NO_DUE_IDLE_SEC = 90 * 60;

// "bitiş ~06:15", "bitis 06:15", "finish ~6:15", "due: 06:15"
const DUE_RE = /(?<![\p{L}\p{N}])(?:biti[sş]|finish|due)\s*:?\s*~?\s*(\d{1,2}):(\d{2})(?!\d)/iu;

/** The finish clock named in a ⏳ line, or undefined. */
export function parseDueClock(text: string): { h: number; m: number } | undefined {
  const m = DUE_RE.exec(text);
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : undefined;
}

/** Epoch sec of the first local h:m at or after the minute of `fromSec` (23:50 -> 00:30 is the next day). */
export function resolveDueSec(h: number, m: number, fromSec: number): number {
  const fromMin = Math.floor(fromSec / 60) * 60;
  const d = new Date(fromMin * 1000);
  d.setHours(h, m, 0, 0);
  if (d.getTime() / 1000 < fromMin) d.setDate(d.getDate() + 1);
  return d.getTime() / 1000;
}

/** Finish time and overdue state of a ⏳ line whose turn ended at `endedSec` (its final assistant message). */
export function pendingTiming(text: string, endedSec: number, nowSec: number): ClosingTiming {
  const clock = parseDueClock(text);
  if (!clock) return { dueMs: null, overdue: nowSec - endedSec >= NO_DUE_IDLE_SEC };
  const dueSec = resolveDueSec(clock.h, clock.m, endedSec);
  return { dueMs: dueSec * 1000, overdue: nowSec > dueSec + OVERDUE_GRACE_SEC };
}

/** In background: an on-time ⏳ row that asks nothing of you (a 🟡 inside the line keeps it in Your turn). */
export function isBackground(v: SessionView): boolean {
  return !!v.closingTiming && !v.closingTiming.overdue && !v.closing?.text.includes("🟡");
}

/** Local "HH:MM" of an epoch ms. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Tooltip line of a ⏳ row: its finish time, or the overdue warning ("" for an on-time row without one). */
export function timingNote(t: ClosingTiming): string {
  const due = t.dueMs !== null ? fmtClock(t.dueMs) : "";
  if (t.overdue) return due ? `past its finish time (~${due}); may be stuck` : "no finish time and idle 90+ min; may be stuck";
  return due ? `finish: ~${due}` : "";
}

/** In background rows by finish time (none last) after the other rows, which keep their order. */
export function backgroundByDue(views: SessionView[]): SessionView[] {
  const due = (v: SessionView): number => v.closingTiming?.dueMs ?? Number.MAX_SAFE_INTEGER;
  const bg = views.filter((v) => isBackground(v)).sort((a, b) => due(a) - due(b));
  return [...views.filter((v) => !isBackground(v)), ...bg];
}
