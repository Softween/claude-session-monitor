/**
 * What may wake the refresh loop besides an explicit action: a watcher event
 * only for a file the session list reads, never two refreshes within a second,
 * and a Codex poll only when it saw new data.
 */
import type { CodexProviderSnapshot } from "./providers/codex";

/** Timer, watcher and Codex poll refreshes start at least this far apart. */
export const REFRESH_GAP_MS = 1000;

const HOOK_RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;

/**
 * A monitor-dir event matters only for a hook record (`<uuid>.json`, written by
 * hook.py), never for the log, temp or state files beside it. An event without
 * a file name counts, since it could be any file.
 */
export function monitorEventMatters(name: string | null | undefined): boolean {
  return name == null || HOOK_RECORD.test(name);
}

/**
 * A projects-dir event (recursive watch, `<project dir>/<file>`) matters only
 * for a top-level session transcript, not for a subagent transcript or a tool
 * result further down. An event without a file name counts.
 */
export function projectsEventMatters(name: string | null | undefined): boolean {
  if (name == null) return true;
  const parts = name.split(/[\\/]/);
  return parts.length === 2 && parts[1].endsWith(".jsonl");
}

export interface Throttled {
  (): void;
  cancel(): void;
}

/**
 * Refresh requests from the timer, the watchers and the Codex poll. A request
 * runs at once when the last refresh from any path (`lastStart`, epoch ms)
 * began at least `gapMs` ago, else once when that gap ends; requests in between
 * join that run, and a refresh started meanwhile moves it to the end of its own
 * gap.
 */
export function throttle(fn: () => void, gapMs: number, lastStart: () => number, now: () => number = () => Date.now()): Throttled {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const request = (() => {
    if (timer) return;
    const wait = lastStart() + gapMs - now();
    if (wait <= 0) {
      fn();
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      request();
    }, wait);
  }) as Throttled;
  request.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return request;
}

/**
 * `fn` runs once at a time: a call while it runs gets the run in flight (like
 * BurnTracker.refresh). A throw goes to `onError`; the promise never rejects.
 */
export function singleFlight(fn: () => Promise<void>, onError: (error: unknown) => void): () => Promise<void> {
  let inflight: Promise<void> | undefined;
  return () => {
    inflight ??= fn()
      .catch(onError)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  };
}

/**
 * A Codex snapshot without the poll's own time stamps (health.updatedAt,
 * usage.ts) and the age text of each row (detail, tooltip): equal for two
 * polls that saw the same data.
 */
export function codexSignature(snapshot: CodexProviderSnapshot): string {
  return JSON.stringify({
    sessions: snapshot.sessions.map(({ detail: _detail, tooltip: _tooltip, ...row }) => row),
    usage: snapshot.usage && { ...snapshot.usage, ts: undefined },
    health: { ...snapshot.health, updatedAt: undefined },
  });
}
