/**
 * errorRegistry.ts - ~/.claude/session-monitor/health/errors.json: every distinct
 * error the stage guard (safeStage.ts) caught in any window, with the first stack
 * seen and a running count across windows and activations. Each window adds its
 * new occurrences under an O_EXCL lock file (holder checked for liveness) and
 * rewrites the file atomically. An entry is never shortened; past MAX_ERRORS
 * distinct errors the one seen longest ago is dropped. No vscode import.
 */
import type { ErrorRecord } from "./safeStage";

export const MAX_ERRORS = 500;
export const ERRORS_VERSION = 1;

export interface StoredError {
  stage: string;
  count: number;
  first: string; // ISO time first seen
  last: string; // ISO time last seen
  stack: string; // the first stack seen, whole
  ver: string; // extension version that saw it first
  win: string; // window key that saw it first
}

export interface ErrorsFile {
  v: number;
  errors: Record<string, StoredError>;
}

export interface SaveDeps {
  file: string;
  shared(): boolean; // false in observer mode (observerMode.ts sharedFiles): nothing is written
  lock(file: string): (() => void) | null;
  read(file: string): string | undefined;
  write(file: string, text: string): void; // atomic
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (ms: number): string => new Date(ms).toISOString();

function isStored(v: unknown): v is StoredError {
  return (
    isRecord(v) &&
    typeof v.stage === "string" &&
    typeof v.count === "number" &&
    typeof v.first === "string" &&
    typeof v.last === "string" &&
    typeof v.stack === "string" &&
    typeof v.ver === "string" &&
    typeof v.win === "string"
  );
}

/** The valid entries of a parsed errors.json; nothing for anything else. */
function entriesOf(raw: unknown): Record<string, StoredError> {
  if (!isRecord(raw) || raw.v !== ERRORS_VERSION || !isRecord(raw.errors)) return {};
  return Object.fromEntries(Object.entries(raw.errors).filter(([, e]) => isStored(e))) as Record<string, StoredError>;
}

/** `prev` (a parsed errors.json) with `records` added: counts summed, the first stack kept, the oldest last-seen dropped past `max`. */
export function mergeErrors(prev: unknown, records: readonly ErrorRecord[], ver: string, win: string, max = MAX_ERRORS): ErrorsFile {
  const errors = { ...entriesOf(prev) };
  for (const r of records) {
    const old = errors[r.key];
    const first = iso(r.firstMs);
    const last = iso(r.lastMs);
    errors[r.key] = old
      ? { ...old, count: old.count + r.count, first: first < old.first ? first : old.first, last: last > old.last ? last : old.last }
      : { stage: r.stage, count: r.count, first, last, stack: r.stack, ver, win };
  }
  const keys = Object.keys(errors);
  if (keys.length <= max) return { v: ERRORS_VERSION, errors };
  const kept = keys.sort((a, b) => (errors[b].last > errors[a].last ? 1 : errors[b].last < errors[a].last ? -1 : 0)).slice(0, max);
  return { v: ERRORS_VERSION, errors: Object.fromEntries(kept.map((k) => [k, errors[k]])) };
}

/** Adds `records` to errors.json under its lock; false in observer mode or while another window holds the lock (the records stay unsaved). */
export function saveErrors(records: readonly ErrorRecord[], ver: string, win: string, deps: SaveDeps): boolean {
  if (!records.length) return true;
  if (!deps.shared()) return false;
  const release = deps.lock(`${deps.file}.lock`);
  if (!release) return false;
  try {
    let prev: unknown;
    try {
      prev = JSON.parse(deps.read(deps.file) ?? "null");
    } catch {
      prev = undefined; // unreadable: written atomically, so only a hand edit gets here
    }
    deps.write(deps.file, `${JSON.stringify(mergeErrors(prev, records, ver, win), null, 1)}\n`);
    return true;
  } finally {
    release();
  }
}
