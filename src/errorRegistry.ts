/**
 * errorRegistry.ts - ~/.claude/session-monitor/health/errors.json: every distinct
 * error the stage guard (safeStage.ts) caught in any window, with the first stack
 * seen and a running count across windows and activations. Each window adds its
 * new occurrences under an O_EXCL lock file (holder checked for liveness) and
 * rewrites the file atomically. An entry is never shortened; past MAX_ERRORS
 * distinct errors the one seen longest ago is dropped. Only a missing file starts
 * an empty registry: a file that cannot be read, or is of another version or shape
 * (a newer window's), is left as it is. No vscode import.
 */
import * as fs from "fs";
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
  read(file: string): string | undefined; // undefined only for a missing file, any other error throws (readIfThere)
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

/** The valid entries of a parsed errors.json; undefined for a file of another version or shape. */
function entriesOf(raw: unknown): Record<string, StoredError> | undefined {
  if (!isRecord(raw) || raw.v !== ERRORS_VERSION || !isRecord(raw.errors)) return undefined;
  return Object.fromEntries(Object.entries(raw.errors).filter(([, e]) => isStored(e))) as Record<string, StoredError>;
}

/**
 * `prev` (a parsed errors.json, undefined when there is none) with `records` added: counts summed, the first stack
 * kept, the oldest last-seen dropped past `max`. Throws for a file of another version or shape: rewriting it would
 * drop every entry it holds.
 */
export function mergeErrors(prev: unknown, records: readonly ErrorRecord[], ver: string, win: string, max = MAX_ERRORS): ErrorsFile {
  const known = prev === undefined ? {} : entriesOf(prev);
  if (!known) throw new Error(`errors.json is of another version or shape (this window writes version ${ERRORS_VERSION}): left as it is`);
  const errors = { ...known };
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

/**
 * Adds `records` to errors.json under its lock; false in observer mode or while another window holds the lock (the
 * records stay unsaved). Throws, leaving the file as it is and the records unsaved, when the file cannot be read, is
 * not JSON or is of another version or shape; the stage guard that runs this logs each such error once.
 */
export function saveErrors(records: readonly ErrorRecord[], ver: string, win: string, deps: SaveDeps): boolean {
  if (!records.length) return true;
  if (!deps.shared()) return false;
  const release = deps.lock(`${deps.file}.lock`);
  if (!release) return false;
  try {
    const text = deps.read(deps.file);
    const prev: unknown = text === undefined ? undefined : JSON.parse(text);
    deps.write(deps.file, `${JSON.stringify(mergeErrors(prev, records, ver, win), null, 1)}\n`);
    return true;
  } finally {
    release();
  }
}

/** A file's text; undefined only when there is no such file, any other read error throws (SaveDeps.read). */
export function readIfThere(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
