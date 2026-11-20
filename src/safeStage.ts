/**
 * Error isolation for the refresh loop and activation: a stage that throws is
 * recorded and skipped, so the stages after it still run. Each distinct error
 * (stage and message) is logged once, with its first stack frames; a repeat
 * only raises that error's running count, so a stage that throws on every tick
 * cannot flood the log.
 */

/** Past this many distinct errors, new ones are counted under one "other errors" key per stage. */
const MAX_DISTINCT = 50;

export interface StageGuard {
  /** Runs `fn`; a throw is recorded under `stage` and swallowed, and the result is then undefined. */
  safe<T>(stage: string, fn: () => T): T | undefined;
  /** Records an error the caller caught itself. */
  fail(stage: string, error: unknown): void;
  /** The running count of each distinct error so far, keyed `<stage>: <error>`. */
  counts(): Map<string, number>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  try {
    return String(error);
  } catch {
    return typeof error; // an object without a usable toString
  }
}

export function stageGuard(log: (msg: string) => void): StageGuard {
  const seen = new Map<string, number>();
  const fail = (stage: string, error: unknown): void => {
    let key = `${stage}: ${errorText(error)}`;
    if (!seen.has(key) && seen.size >= MAX_DISTINCT) key = `${stage}: other errors`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count > 1) return;
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
    counts: () => new Map(seen),
  };
}
