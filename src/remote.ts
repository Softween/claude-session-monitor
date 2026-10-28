/**
 * remote.ts — pure (vscode-free) part of the optional remote bridge: the
 * snapshot pushed to `<url>/fleet/ingest`, its change hash, and the push /
 * backoff timing. Wire format: API contract v1 (`POST /fleet/ingest`).
 */
import { execFile } from "child_process";
import { createHash } from "crypto";
import * as os from "os";
import { parseResetToEpoch } from "./core";
import type { SessionView } from "./providers/types";
import { groupOf, type GroupKey } from "./view";

export type FleetBucket = "waiting" | "yourTurn" | "working" | "idle" | "limited" | "ended";

/**
 * Panel group (view.ts GroupKey) -> contract bucket:
 *   limited -> limited     (session / API limit hit)
 *   waiting -> waiting     (permission prompt or question: "Waiting for you")
 *   done    -> yourTurn    (turn finished: "Your turn")
 *   working -> working
 *   ended   -> ended
 *   unknown -> idle        (no hook state and no conversation signal yet)
 */
export const BUCKET_MAP: Record<GroupKey, FleetBucket> = {
  limited: "limited",
  waiting: "waiting",
  done: "yourTurn",
  working: "working",
  ended: "ended",
  unknown: "idle",
};

export const LAST_TEXT_MAX_BYTES = 2048;
export const MAX_SESSIONS = 200;
export const MIN_PUSH_GAP_MS = 10_000;
export const HEARTBEAT_MS = 120_000;
export const BACKOFF_MIN_MS = 2_000;
export const BACKOFF_MAX_MS = 60_000;
export const MACHINE_SAMPLE_MS = 15_000;
export const COMMAND_MAX_AGE_MS = 120_000;
export const COMMAND_TIMEOUT_MS = 60_000;
export const MAX_COMMANDS_PER_POLL = 20;
export const MAX_RESPONSE_BYTES = 256 * 1024;

export interface FleetGauge { key: string; label: string; pct: number; resetMs: number | null }

export interface FleetSession {
  id: string;
  provider: "claude" | "codex";
  title: string;
  bucket: FleetBucket;
  model: string | null;
  effort: string | null;
  cwd: string | null;
  project: string | null;
  pid: number | null;
  lastActivityTs: number | null; // epoch seconds
  lastText: string | null;
  closing: { kind: "done" | "pending" | "blocked"; text: string } | null;
  limit: { resetText: string | null; resetTs: number | null } | null;
  canResume: boolean;
  tokens: { ctxPct: number | null; total: number | null } | null;
  account: string | null;
}

export interface FleetAccount {
  id: string;
  email: string;
  tier: string | null;
  active: boolean;
  best: boolean;
  exhausted: boolean;
  gauges: FleetGauge[];
}

export interface FleetMachine {
  cpuPct: number | null;
  memFreeMb: number | null;
  memTotalMb: number | null;
  pressure: string | null;
  sessions: number;
}

export interface IngestBody {
  v: 1;
  host: string;
  sentAt: number; // epoch ms
  sessions: FleetSession[];
  accounts: FleetAccount[];
  machine: FleetMachine;
}

/** Account input: the panel's AccountView shape plus which one rotation would pick. */
export interface SnapshotAccountInput {
  id: string;
  email: string;
  plan: string | null;
  active: boolean;
  gauges: { key: string; label: string; pct: number | null; resetMs: number | null }[];
}

export interface SnapshotInput {
  host: string;
  rows: SessionView[];
  accounts: SnapshotAccountInput[];
  bestAccountId?: string | null;
  machine: FleetMachine;
  now?: number; // epoch ms
}

/** Cut a string to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function clipBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > maxBytes - 3) break;
    out += ch;
    used += n;
  }
  return out + "…";
}

// Secret-looking substrings never leave the machine in uploaded text.
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /xox[bpa]-[A-Za-z0-9-]{10,}/g,
  /AKIA[A-Z0-9]{12,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const BASE64_RUN = /[A-Za-z0-9+\/_-]{40,}={0,2}/g;

/**
 * Replace API keys, tokens, private-key headers, 40+ character hex runs and
 * 40+ character base64 runs with `[redacted]`. A base64 run counts only when it
 * mixes digits with lower- and upper-case letters, so long plain words and
 * paths without digits stay readable.
 */
export function redactSecrets(s: string): string {
  let out = s;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out.replace(BASE64_RUN, (m) => (/\d/.test(m) && /[a-z]/.test(m) && /[A-Z]/.test(m) ? "[redacted]" : m));
}

function sessionOf(v: SessionView, nowSec: number, activeEmail: string | null): FleetSession {
  const bucket = BUCKET_MAP[groupOf(v)];
  // The row keeps no assistant reply text; the most recent human-readable line it has
  // is the hook notification, then the closing status line, then the status detail.
  const text = v.notifMessage || v.closing?.text || v.detail || "";
  const resetTs = v.resetText ? parseResetToEpoch(v.resetText, nowSec) ?? null : null;
  return {
    id: v.sessionId,
    provider: v.provider,
    title: clipBytes(redactSecrets(v.title), 512),
    bucket,
    model: v.model ?? null,
    effort: v.effort ?? null,
    cwd: v.cwd ?? null,
    project: v.cwdLabel ?? (v.cwd ? v.cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null),
    pid: typeof v.pid === "number" ? v.pid : null,
    lastActivityTs: v.lastActivityMs ? Math.floor(v.lastActivityMs / 1000) : null,
    lastText: text ? clipBytes(redactSecrets(text), LAST_TEXT_MAX_BYTES) : null,
    closing: v.closing ? { kind: v.closing.kind, text: clipBytes(redactSecrets(v.closing.text), 512) } : null,
    limit: bucket === "limited" ? { resetText: v.resetText ?? null, resetTs } : null,
    canResume: !!v.capabilities?.resume,
    tokens: typeof v.tokens === "number" ? { ctxPct: null, total: v.tokens } : null,
    // Running Claude sessions follow the machine's active login at their next token refresh.
    account: v.provider === "claude" ? activeEmail : null,
  };
}

function accountOf(a: SnapshotAccountInput, bestId: string | null): FleetAccount {
  const gauges = a.gauges
    .filter((g): g is FleetGauge => typeof g.pct === "number" && Number.isFinite(g.pct))
    .map((g) => ({ key: g.key, label: g.label, pct: Math.round(g.pct), resetMs: g.resetMs ?? null }));
  return {
    id: a.id,
    email: a.email,
    tier: a.plan,
    active: a.active,
    best: !!bestId && a.id === bestId,
    exhausted: gauges.some((g) => g.pct >= 100),
    gauges,
  };
}

/**
 * Coarsen the machine sample so load / free-memory jitter alone never changes the
 * hash (CPU to 10 %, memory to 512 MB); the 2 min heartbeat carries the fresh values.
 */
function coarseMachine(m: FleetMachine): FleetMachine {
  return {
    cpuPct: m.cpuPct == null ? null : Math.round(m.cpuPct / 10) * 10,
    memFreeMb: m.memFreeMb == null ? null : Math.round(m.memFreeMb / 512) * 512,
    memTotalMb: m.memTotalMb,
    pressure: m.pressure,
    sessions: m.sessions,
  };
}

export function buildSnapshot(input: SnapshotInput): IngestBody {
  const now = input.now ?? Date.now();
  const activeEmail = input.accounts.find((a) => a.active)?.email ?? null;
  return {
    v: 1,
    host: input.host.slice(0, 64),
    sentAt: now,
    sessions: input.rows.slice(0, MAX_SESSIONS).map((v) => sessionOf(v, now / 1000, activeEmail)),
    accounts: input.accounts.map((a) => accountOf(a, input.bestAccountId ?? null)),
    machine: coarseMachine({ ...input.machine, sessions: input.rows.length }),
  };
}

/** JSON with object keys sorted at every level, so equal snapshots serialize equally. */
function stableJson(x: unknown): string {
  if (Array.isArray(x)) return "[" + x.map(stableJson).join(",") + "]";
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return (
      "{" +
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableJson(o[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(x ?? null);
}

/** sha1 over everything except `sentAt`. */
export function snapshotHash(body: IngestBody): string {
  const { sentAt: _sentAt, ...rest } = body;
  return createHash("sha1").update(stableJson(rest)).digest("hex");
}

/** 0 (no failure yet) -> 2 s, then doubling, capped at 60 s. */
export function nextBackoff(prevMs: number): number {
  if (!prevMs || prevMs < BACKOFF_MIN_MS) return BACKOFF_MIN_MS;
  return Math.min(BACKOFF_MAX_MS, prevMs * 2);
}

/** Push on a change once 10 s passed since the last push, or as a heartbeat every 2 min. */
export function shouldPush(o: { changed: boolean; lastPushTs: number; now: number }): boolean {
  const since = o.now - o.lastPushTs;
  if (!o.lastPushTs) return true;
  if (since >= HEARTBEAT_MS) return true;
  return o.changed && since >= MIN_PUSH_GAP_MS;
}

/**
 * macOS available memory from `vm_stat` text: (free + inactive + speculative + purgeable)
 * pages * page size in MB, clamped to [0, totalMb]; null when the text does not parse.
 */
export function availableMemoryMb(vmStatOutput: string, totalMb: number): number | null {
  const pageSize = Number(/page size of (\d+) bytes/.exec(vmStatOutput)?.[1]);
  if (!pageSize) return null;
  let pages = 0;
  for (const name of ["free", "inactive", "speculative", "purgeable"]) {
    const m = new RegExp(`^Pages ${name}:\\s+(\\d+)`, "m").exec(vmStatOutput);
    if (!m) return null;
    pages += Number(m[1]);
  }
  return Math.max(0, Math.min(totalMb, Math.round((pages * pageSize) / 1048576)));
}

/** `memory_pressure` text -> its "System-wide memory free percentage" (0-100); null when missing or out of range. */
export function freePctFromMemoryPressure(text: string): number | null {
  const m = /System-wide memory free percentage:\s*(\d+)%/.exec(text);
  const pct = m ? Number(m[1]) : NaN;
  return pct >= 0 && pct <= 100 ? pct : null;
}

/** stdout of a short tool run (async execFile), or null when it fails or runs past `timeoutMs`. */
export function runTool(cmd: string, args: string[] = [], timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/**
 * Free memory in MB. macOS `os.freemem()` counts only the kernel's free pages (near zero on
 * a busy Mac), so darwin takes the system-wide free percentage from `memory_pressure`, then
 * free + inactive + speculative + purgeable pages from `vm_stat`, then `os.freemem()`.
 */
async function freeMemoryMb(totalMb: number): Promise<number> {
  if (process.platform === "darwin") {
    const pct = freePctFromMemoryPressure((await runTool("/usr/bin/memory_pressure")) ?? "");
    if (pct !== null) return Math.round((totalMb * pct) / 100);
    const available = availableMemoryMb((await runTool("vm_stat")) ?? "", totalMb);
    if (available !== null) return available;
  }
  return Math.round(os.freemem() / 1048576);
}

type MachineReading = Pick<FleetMachine, "cpuPct" | "memFreeMb" | "memTotalMb">;
let machineCache: { at: number; value: MachineReading } | null = null;

async function measureMachine(): Promise<MachineReading> {
  const cpus = Math.max(1, os.cpus().length);
  const memTotalMb = Math.round(os.totalmem() / 1048576);
  return {
    cpuPct: Math.min(100, Math.round((os.loadavg()[0] / cpus) * 100)),
    memFreeMb: await freeMemoryMb(memTotalMb),
    memTotalMb,
  };
}

/**
 * Host-wide sample: 1-min load average as CPU %, free / total memory. The bridge asks on every
 * panel poll (~1.5 s), so a reading is reused for MACHINE_SAMPLE_MS (taken again if the clock
 * moved back); `pressure` and `sessions` always pass through. `now` / `measure`: test seams.
 */
export async function sampleMachine(
  pressure: string | null,
  sessions: number,
  now = Date.now(),
  measure: () => MachineReading | Promise<MachineReading> = measureMachine,
): Promise<FleetMachine> {
  let c = machineCache;
  if (!c || now < c.at || now - c.at >= MACHINE_SAMPLE_MS) c = machineCache = { at: now, value: await measure() };
  return { ...c.value, pressure, sessions };
}

/**
 * Why a relay command must not run, or null to run it: commands are switched off
 * on this Mac (`remote.acceptCommands`), or the command is older than 2 min. A
 * command without a numeric `createdAt` counts as expired.
 */
export function commandRefusal(createdAt: unknown, now: number, acceptCommands: boolean): string | null {
  if (!acceptCommands) return "remote commands disabled on this Mac";
  const age = typeof createdAt === "number" && Number.isFinite(createdAt) ? now - createdAt : NaN;
  return age <= COMMAND_MAX_AGE_MS ? null : "expired";
}

/** `p`, or `fallback` once `ms` pass without an answer. The work itself is not cancelled. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** A relay response's body text, refused above `max` bytes by its content-length header or by its size. */
export async function readCappedBody(
  res: { headers: { get(name: string): string | null }; text(): Promise<string> },
  max = MAX_RESPONSE_BYTES,
): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) throw new Error(`relay response too large (${declared} bytes)`);
  const text = await res.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new Error("relay response too large");
  return text;
}

/** `sysctl kern.memorystatus_vm_pressure_level` value -> label (macOS: 1 normal, 2 warn, 4 critical). */
export function pressureLabel(level: number | null): string | null {
  if (level === 1) return "normal";
  if (level === 2) return "warn";
  if (level === 4) return "critical";
  return null;
}

/**
 * The bridge URL check: https only, except plain http to localhost / 127.0.0.1 for
 * a local relay. Returns the normalized base URL (no trailing slash) or an error.
 */
export function checkRemoteUrl(raw: string): { url: string; origin: string } | { error: string } {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { error: `remote.url is not a valid URL ("${trimmed}")` };
  }
  const localHttp = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !localHttp) {
    return { error: `remote.url must use https:// (http:// only for localhost / 127.0.0.1), got "${trimmed}"` };
  }
  return { url: trimmed, origin: u.origin };
}

/** True only when `url` parses and its origin equals the origin the token was bound to. */
export function originMatches(storedOrigin: string | null | undefined, url: string): boolean {
  if (!storedOrigin) return false;
  try {
    return new URL(url.trim()).origin === storedOrigin;
  } catch {
    return false;
  }
}

export interface StoredRemoteToken { origin: string; token: string }

/** SecretStorage value `{origin, token}`; anything else (including a bare legacy string) is unbound. */
export function parseStoredToken(raw: string | undefined | null): StoredRemoteToken | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<StoredRemoteToken>;
    if (typeof j?.origin === "string" && j.origin && typeof j.token === "string" && j.token) {
      return { origin: j.origin, token: j.token };
    }
  } catch {
    /* not JSON */
  }
  return null;
}
