/**
 * Error isolation for the refresh loop and activation: a stage that throws is
 * recorded and skipped, so the stages after it still run. Each distinct error
 * (stage and message) is logged once, with its first stack frames; a repeat
 * only raises that error's running count, so a stage that throws on every tick
 * cannot flood the log. The first full stack and the occurrences not saved yet
 * go to errors.json (errorRegistry.ts); the time each stage last failed feeds
 * the health file (health.ts).
 */

/** Past this many distinct errors, new ones are counted under one "other errors" key per stage. */
const MAX_DISTINCT = 50;

/** A distinct error with occurrences not saved yet. */
export interface ErrorRecord {
  key: string; // `<stage>: <error>`
  stage: string;
  count: number; // occurrences since the last save
  stack: string; // the first stack seen (the error text when the thrown value had none)
  firstMs: number;
  lastMs: number;
}

export interface StageGuard {
  /** Runs `fn`; a throw is recorded under `stage` and swallowed, and the result is then undefined. */
  safe<T>(stage: string, fn: () => T): T | undefined;
  /** Records an error the caller caught itself. */
  fail(stage: string, error: unknown): void;
  /** The running count of each distinct error so far, keyed `<stage>: <error>`. */
  counts(): Map<string, number>;
  /** Each distinct error with occurrences not saved yet; `count` is those occurrences. */
  unsaved(): ErrorRecord[];
  /** Marks the occurrences of `records`, as unsaved() returned them, as saved. */
  saved(records: readonly ErrorRecord[]): void;
  /** When each stage last failed (epoch ms). */
  lastFailures(): Map<string, number>;
}

interface Entry {
  stage: string;
  count: number;
  saved: number;
  stack: string;
  firstMs: number;
  lastMs: number;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return typeof error; // an object without a usable toString
  }
}

export function stageGuard(log: (msg: string) => void, nowMs: () => number = Date.now): StageGuard {
  const seen = new Map<string, Entry>();
  const failures = new Map<string, number>();
  const fail = (stage: string, error: unknown): void => {
    let key = `${stage}: ${errorText(error)}`;
    if (!seen.has(key) && seen.size >= MAX_DISTINCT) key = `${stage}: other errors`;
    const now = nowMs();
    failures.set(stage, now);
    const prev = seen.get(key);
    if (prev) {
      seen.set(key, { ...prev, count: prev.count + 1, lastMs: now });
      return;
    }
    const stack = error instanceof Error && error.stack ? error.stack : errorText(error);
    seen.set(key, { stage, count: 1, saved: 0, stack, firstMs: now, lastMs: now });
    const frames = error instanceof Error && error.stack ? error.stack.split("\n").slice(1, 5).map((l) => l.trim()) : [];
    log(`stage failed: ${key}${frames.length ? ` (${frames.join(" < ")})` : ""}; repeats are counted, not logged`);
  };
  return {
    safe<T>(stage: string, fn: () => T): T | undefined {
      try {
        return fn();
      } catch (error) {
        fail(stage, error);
        return undefined;
      }
    },
    fail,
    counts: () => new Map([...seen].map(([key, e]) => [key, e.count])),
    unsaved: () =>
      [...seen]
        .filter(([, e]) => e.count > e.saved)
        .map(([key, e]) => ({ key, stage: e.stage, count: e.count - e.saved, stack: e.stack, firstMs: e.firstMs, lastMs: e.lastMs })),
    saved(records: readonly ErrorRecord[]): void {
      for (const r of records) {
        const e = seen.get(r.key);
        if (e) seen.set(r.key, { ...e, saved: Math.min(e.count, e.saved + r.count) });
      }
    },
    lastFailures: () => new Map(failures),
  };
}
