/**
 * core.ts — pure Node data layer for the Claude Session Monitor.
 *
 * No `vscode` import lives here on purpose: this module is unit-testable on its
 * own (see verify.ts) and is consumed by extension.ts for the UI.
 *
 * Data sources, merged per session id:
 *   1. ~/.claude/session-monitor/<id>.json  — live state written by hook.py
 *      (working / idle / waiting / ended) plus the Notification message.
 *   2. ~/.claude/projects/.../<id>.jsonl    — the transcript; its TAIL gives the
 *      session title (ai-title), the newest CONVERSATIONAL activity, the session
 *      entrypoint, and "limited" detection (isApiErrorMessage + 429).
 *
 * Only interactive sessions are shown. The discriminator is `entrypoint`:
 *   claude-vscode / cli = real tabs;  sdk-cli / sdk-py = claude-mem observers
 *   and SDK subagents (filtered out).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HOME = os.homedir();
export const MONITOR_DIR = path.join(HOME, ".claude", "session-monitor");
export const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
export const SETTINGS_FILE = path.join(HOME, ".claude", "settings.json");

const MAX_TAIL = 512 * 1024; // bytes of transcript tail to read
const MAX_TAIL_GROW = 4 * 1024 * 1024; // grown window when a huge last line hides the conv line
const STALE_SECONDS = 120;

export const DEFAULT_ENTRYPOINTS = ["claude-vscode", "cli"];
const EXCLUDED_DIR_HINTS = ["observer-sessions", "claude-mem"];

export type Bucket = "limited" | "attention" | "working" | "ended" | "unknown";

export type ConvKind =
  | "end_turn"
  | "tool_use"
  | "tool_result"
  | "user_text"
  | "assistant_other"
  | "api_error"
  | "none";

export interface HookStatus {
  session_id: string;
  state: string; // working | idle | waiting | ended | unknown
  event?: string;
  ts: number; // epoch seconds
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  message?: string;
  notif_type?: string;
  prompt?: string;
  source?: string;
  stop_reason?: string;
  reason?: string;
  pid?: number;
}

export interface LimitInfo {
  kind: "session" | "rate" | "error";
  text: string;
  resetText?: string;
  status?: number;
}

export interface TxInfo {
  title?: string;
  lastPrompt?: string;
  entrypoint?: string;
  convTs: number; // epoch seconds of newest user/assistant line
  convKind: ConvKind;
  convType?: "user" | "assistant";
  limit?: LimitInfo; // set only when convKind === "api_error" AND status 429
  activityTs: number; // newest ts across all lines (incl. hook/meta attachments)
  mtimeMs: number;
  sizeBytes: number;
  cwd?: string;
  model?: string; // model id of the newest assistant line (message.model)
}

export interface SessionView {
  sessionId: string;
  title: string;
  bucket: Bucket;
  sub: string; // short status label
  detail: string; // tree row description
  tooltip: string;
  cwd?: string;
  cwdLabel?: string;
  transcriptPath?: string;
  lastActivityMs: number;
  resetText?: string;
  permissionMode?: string;
  notifMessage?: string;
  entrypoint?: string;
  pid?: number;
  stale: boolean;
  model?: string; // model id in use (from the newest assistant transcript line)
  effort?: string; // reasoning effort level (global effortLevel from settings.json)
}

export const BUCKET_ORDER: Record<Bucket, number> = {
  limited: 0,
  attention: 1,
  working: 2,
  ended: 3,
  unknown: 4,
};

// ---------------------------------------------------------------------------
// Hook status files
// ---------------------------------------------------------------------------

export function readHookStatuses(dir = MONITOR_DIR): Map<string, HookStatus> {
  const map = new Map<string, HookStatus>();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const obj = JSON.parse(raw) as HookStatus;
      if (obj && obj.session_id) map.set(obj.session_id, obj);
    } catch {
      // ignore unreadable/partial files
    }
  }
  return map;
}

/**
 * Read the global reasoning-effort level from ~/.claude/settings.json.
 * Effort is a global Claude Code setting (there is no per-session effort in the
 * transcript or hook files), so every live session shares this value.
 */
export function readGlobalEffort(file = SETTINGS_FILE): string | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    const e = (v as { effortLevel?: unknown } | null)?.effortLevel;
    return typeof e === "string" && e.trim() ? e.trim() : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transcript tail parsing
// ---------------------------------------------------------------------------

function readTail(file: string, maxBytes: number): { text: string; partialFirst: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return { text: "", partialFirst: false };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8"), partialFirst: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function toEpochSeconds(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function extractText(obj: any): string {
  const content = obj?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

export function classifyLimit(text: string, status?: number): LimitInfo | null {
  if (!text) return null;
  if (/hit your session limit/i.test(text)) {
    const m = text.match(/resets\s+([^()]+?)(?:\s*\(|$)/i);
    return { kind: "session", text, resetText: m ? m[1].trim() : undefined, status };
  }
  if (/temporarily limiting|rate limited|not your usage limit/i.test(text)) {
    return { kind: "rate", text, status };
  }
  return null;
}

/** Classify one user/assistant transcript line. */
function classifyConvLine(obj: any): {
  kind: ConvKind;
  ctype: "user" | "assistant";
  limit?: LimitInfo;
  errText?: string;
} {
  if (obj.type === "assistant") {
    if (obj.isApiErrorMessage === true) {
      const text = extractText(obj);
      // Limits are specifically apiErrorStatus 429. A 529/500/etc. that happens
      // to contain "rate limited" in its text is NOT a usage/session limit.
      const limit =
        obj.apiErrorStatus === 429 ? (classifyLimit(text, obj.apiErrorStatus) ?? undefined) : undefined;
      return { kind: "api_error", ctype: "assistant", limit, errText: text };
    }
    const msg = obj.message || {};
    const sr = msg.stop_reason;
    if (sr === "end_turn" || sr === "stop_sequence") return { kind: "end_turn", ctype: "assistant" };
    if (sr === "tool_use") return { kind: "tool_use", ctype: "assistant" };
    if (Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === "tool_use"))
      return { kind: "tool_use", ctype: "assistant" };
    return { kind: "assistant_other", ctype: "assistant" };
  }
  // user
  const content = obj?.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result"))
    return { kind: "tool_result", ctype: "user" };
  return { kind: "user_text", ctype: "user" };
}

/** Parse a single tail window of `maxBytes`. */
function parseWindow(file: string, stat: fs.Stats, maxBytes: number): TxInfo {
  const info: TxInfo = {
    convTs: 0,
    convKind: "none",
    activityTs: 0,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };

  let text = "";
  let partialFirst = false;
  try {
    const r = readTail(file, maxBytes);
    text = r.text;
    partialFirst = r.partialFirst;
  } catch {
    return info;
  }

  const lines = text.split("\n");
  if (partialFirst && lines.length) lines.shift(); // drop incomplete leading line

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const type = obj.type;

    if (type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle.trim()) {
      info.title = obj.aiTitle.trim();
      continue;
    }
    if (type === "last-prompt" && typeof obj.lastPrompt === "string" && obj.lastPrompt.trim()) {
      info.lastPrompt = obj.lastPrompt.trim();
      continue;
    }

    if (obj.cwd && !info.cwd) info.cwd = obj.cwd;
    // entrypoint is carried on user/assistant/system/attachment lines; read from any.
    if (obj.entrypoint && !info.entrypoint) info.entrypoint = obj.entrypoint;

    const ts = toEpochSeconds(obj.timestamp);
    if (ts <= 0) continue;
    if (ts > info.activityTs) info.activityTs = ts;

    if (type === "assistant" && typeof obj.message?.model === "string") {
      // Append-only transcript -> the last assistant line carries the current model.
      // Skip placeholder models like "<synthetic>": Claude Code stamps that on
      // locally-injected messages (API-error notices, "out of credits", etc.),
      // not real turns, so the badge should keep showing the last real model.
      const m = obj.message.model.trim();
      if (m && !m.startsWith("<")) info.model = m;
    }

    if (type === "user" || type === "assistant") {
      // Last writer wins, EXCEPT a same-second tie must not clear an api_error limit
      // (e.g. a user line written in the same second as a 429 would hide the limit).
      if (ts > info.convTs || (ts === info.convTs && info.convKind !== "api_error")) {
        info.convTs = ts;
        const c = classifyConvLine(obj);
        info.convKind = c.kind;
        info.convType = c.ctype;
        info.limit = c.kind === "api_error" ? c.limit : undefined;
      }
    }
  }

  return info;
}

/**
 * Parse the tail of a transcript file. `prev` lets the caller skip re-parsing
 * unchanged files (cache by mtime + size). If a single line larger than the
 * tail window hides the newest conversational line, the window is grown once.
 */
export function parseTranscriptTail(file: string, prev?: TxInfo): TxInfo {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return prev ?? { convTs: 0, convKind: "none", activityTs: 0, mtimeMs: 0, sizeBytes: 0 };
  }
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
    return prev; // unchanged
  }

  let info = parseWindow(file, stat, MAX_TAIL);
  if (info.convKind === "none" && stat.size > MAX_TAIL) {
    // The newest conversational line was probably bigger than the window.
    info = parseWindow(file, stat, Math.min(stat.size, MAX_TAIL_GROW));
  }
  return info;
}

// ---------------------------------------------------------------------------
// State resolution
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  now: number; // epoch seconds
  txPath?: string; // fallback transcript path (when no hook file)
  effort?: string; // global reasoning-effort level (same for every session)
}

function resolve(
  sessionId: string,
  hook: HookStatus | undefined,
  tx: TxInfo | undefined,
  opts: ResolveOpts,
): SessionView {
  const now = opts.now;
  const hookTs = hook?.ts ?? 0;
  const convTs = tx?.convTs ?? 0;
  const mtimeS = tx ? tx.mtimeMs / 1000 : 0;
  const lastActivity = Math.max(hookTs, convTs, tx?.activityTs ?? 0, mtimeS);

  const title =
    tx?.title || hook?.prompt || tx?.lastPrompt || `session ${sessionId.slice(0, 8)}`;
  const cwd = hook?.cwd || tx?.cwd;
  const cwdLabel = cwd ? path.basename(cwd) : undefined;
  const transcriptPath = hook?.transcript_path || opts.txPath;
  const entrypoint = tx?.entrypoint;
  const model = tx?.model;
  const effort = opts.effort;

  let bucket: Bucket = "unknown";
  let sub = "unknown";
  let resetText: string | undefined;
  let stale = false;

  const applyWorking = () => {
    bucket = "working";
    stale = now - lastActivity > STALE_SECONDS;
    sub = stale ? "working (stalled?)" : "working";
  };

  // 1) "limited" wins only when the api-error is at least as new as the newest
  //    hook event (a resumed session writes a newer hook event and stays out).
  if (tx?.limit && (tx.limit.kind === "session" || tx.limit.kind === "rate") && convTs >= hookTs) {
    bucket = "limited";
    if (tx.limit.kind === "session") {
      sub = "session limit";
      resetText = tx.limit.resetText;
    } else {
      sub = "rate limited";
    }
  }

  // 2) hook is the newest signal -> trust its state.
  if (bucket === "unknown" && hook && hookTs >= convTs) {
    switch (hook.state) {
      case "working":
        applyWorking();
        break;
      case "waiting":
        bucket = "attention";
        sub = "waiting for you";
        break;
      case "idle":
        bucket = "attention";
        sub = "your turn";
        break;
      case "ended":
        bucket = "ended";
        sub = "ended";
        break;
      default:
        break;
    }
  }

  // 3) derive from the newest conversational line.
  if (bucket === "unknown") {
    switch (tx?.convKind) {
      case "tool_use":
      case "tool_result":
      case "user_text":
      case "assistant_other":
        applyWorking();
        break;
      case "end_turn":
        bucket = "attention";
        sub = "your turn";
        break;
      case "api_error":
        bucket = "attention";
        sub = "API error";
        break;
      default:
        if (hook?.state === "ended") {
          bucket = "ended";
          sub = "ended";
        }
        break;
    }
  }

  const ageStr = lastActivity ? humanizeAge(now - lastActivity) : "";
  const parts: string[] = [];
  if (resetText) parts.push(`reset ${formatReset(resetText, now)}`);
  if (ageStr) parts.push(ageStr);
  if (cwdLabel) parts.push(cwdLabel);
  const detail = parts.join(" · ");

  const tipLines = [
    title,
    `status: ${sub}`,
    model ? `model: ${model}` : "",
    effort ? `effort: ${effort}` : "",
    cwd ? `cwd: ${cwd}` : "",
    entrypoint ? `source: ${entrypoint}` : "",
    hook?.permission_mode ? `mode: ${hook.permission_mode}` : "",
    hook?.message ? `notification: ${hook.message}` : "",
    resetText ? `limit reset: ${formatReset(resetText, now)}` : "",
    lastActivity ? `last activity: ${ageStr} ago` : "",
    `id: ${sessionId}`,
  ].filter(Boolean);

  return {
    sessionId,
    title,
    bucket,
    sub,
    detail,
    tooltip: tipLines.join("\n"),
    cwd,
    cwdLabel,
    transcriptPath,
    lastActivityMs: lastActivity * 1000,
    resetText,
    permissionMode: hook?.permission_mode,
    notifMessage: hook?.message,
    entrypoint,
    pid: hook?.pid,
    stale,
    model,
    effort,
  };
}

export function humanizeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Parse a limit reset clock like "1:50pm" / "1:50am" / "13:50" to epoch sec. */
export function parseResetToEpoch(resetText: string, nowSec: number): number | undefined {
  const m = resetText.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  const now = new Date(nowSec * 1000);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  let t = d.getTime() / 1000;
  if (t < nowSec - 60) t += 24 * 3600; // already passed -> assume next day
  return t;
}

/** "1:50pm (12m left)" style live countdown; falls back to the raw text. */
export function formatReset(resetText: string, nowSec: number): string {
  const t = parseResetToEpoch(resetText, nowSec);
  if (!t) return resetText;
  const remain = t - nowSec;
  if (remain <= 0) return `${resetText} (now)`;
  return `${resetText} (${humanizeAge(remain)} left)`;
}

// ---------------------------------------------------------------------------
// Recent transcript discovery (bootstrap + ongoing)
// ---------------------------------------------------------------------------

export interface RecentTranscript {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

function dirExcluded(name: string): boolean {
  return EXCLUDED_DIR_HINTS.some((h) => name.includes(h));
}

/** Claude Code encodes a cwd as the project dir name (slashes/dots -> dashes). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Scan ~/.claude/projects for transcripts modified within `maxAgeMs`.
 * Skips claude-mem/observer dirs. Stat-only; cheap at ~30s cadence.
 */
export function findRecentTranscripts(
  maxAgeMs: number,
  limit: number,
  now: number,
  onlyCwd?: string,
  projectsRoot = PROJECTS_DIR,
): RecentTranscript[] {
  const out: RecentTranscript[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = now - maxAgeMs / 1000;
  const wantDir = onlyCwd ? encodeProjectDir(onlyCwd) : undefined;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (dirExcluded(d.name)) continue;
    if (wantDir && d.name !== wantDir) continue;
    const dirPath = path.join(projectsRoot, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dirPath, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs / 1000 >= cutoff) {
          out.push({ sessionId: f.replace(/\.jsonl$/, ""), path: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // ignore
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Top-level collection
// ---------------------------------------------------------------------------

export interface CollectOpts {
  now: number; // epoch seconds
  extraTranscripts?: RecentTranscript[];
  txCache?: Map<string, TxInfo>;
  hideEndedOlderThanSec?: number;
  maxAgeSec?: number;
  allowedEntrypoints?: string[]; // default DEFAULT_ENTRYPOINTS; [] = allow all
  workspaceCwd?: string; // when set, only sessions under this cwd
  hookStatuses?: Map<string, HookStatus>; // injectable for tests; default readHookStatuses()
  showEnded?: boolean; // default false: closed/ended sessions are hidden entirely
  globalEffort?: string; // injectable for tests; default readGlobalEffort()
}

function entrypointAllowed(ep: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true; // explicit "allow all"
  if (!ep) return true; // unknown -> show (benefit of the doubt)
  return allowed.includes(ep);
}

export function collectSessions(opts: CollectOpts): SessionView[] {
  const now = opts.now;
  const hooks = opts.hookStatuses ?? readHookStatuses();
  const txCache = opts.txCache ?? new Map<string, TxInfo>();
  const allowed = opts.allowedEntrypoints ?? DEFAULT_ENTRYPOINTS;
  const effort = opts.globalEffort ?? readGlobalEffort();

  const candidates = new Map<string, string | undefined>();
  for (const [sid, h] of hooks) candidates.set(sid, h.transcript_path);
  for (const rt of opts.extraTranscripts ?? []) {
    if (!candidates.has(rt.sessionId) || !candidates.get(rt.sessionId))
      candidates.set(rt.sessionId, rt.path);
  }

  const views: SessionView[] = [];
  for (const [sid, txPath] of candidates) {
    let tx: TxInfo | undefined;
    if (txPath) {
      const prev = txCache.get(txPath);
      tx = parseTranscriptTail(txPath, prev);
      txCache.set(txPath, tx);
    }
    const hook = hooks.get(sid);

    // Filter out observer / SDK-subagent sessions.
    if (!entrypointAllowed(tx?.entrypoint, allowed)) continue;
    const cwd = hook?.cwd || tx?.cwd;
    if (cwd && dirExcluded(cwd)) continue;

    const view = resolve(sid, hook, tx, { now, txPath, effort });
    views.push(view);
  }

  const maxAge = opts.maxAgeSec ?? 6 * 3600;
  const hideEnded = opts.hideEndedOlderThanSec ?? 30 * 60;
  const showEnded = opts.showEnded ?? false;
  const wsCwd = opts.workspaceCwd;

  const filtered = views.filter((v) => {
    if (wsCwd && v.cwd !== wsCwd) return false;
    if (v.bucket === "ended" && !showEnded) return false; // closed sessions hidden by default
    const ageSec = v.lastActivityMs ? now - v.lastActivityMs / 1000 : Infinity;
    if (v.bucket === "ended" && ageSec > hideEnded) return false;
    if (ageSec > maxAge) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const bd = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bd !== 0) return bd;
    return b.lastActivityMs - a.lastActivityMs;
  });

  return filtered;
}

export interface BucketCounts {
  limited: number;
  attention: number;
  working: number;
  ended: number;
  unknown: number;
}

export function countBuckets(views: SessionView[]): BucketCounts {
  const c: BucketCounts = { limited: 0, attention: 0, working: 0, ended: 0, unknown: 0 };
  for (const v of views) c[v.bucket]++;
  return c;
}

/** Delete monitor json files older than maxAgeMs (keeps the dir tidy). */
export function cleanupMonitorFiles(maxAgeMs: number, now: number, dir = MONITOR_DIR): number {
  let removed = 0;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    // Infrastructure files are state, not per-session status — age never
    // invalidates them (accounts.json in particular may legitimately sit
    // untouched for days between account switches).
    if (f === "accounts.json" || f.startsWith("official-usage")) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (now * 1000 - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * Delete only status files for sessions that have ENDED, or that are stale
 * beyond `staleMs`. Live working/waiting sessions are kept (their only
 * "waiting"/Notification signal must survive a manual cleanup).
 */
export function cleanupEndedMonitorFiles(now: number, staleMs = 12 * 3600 * 1000, dir = MONITOR_DIR): number {
  let removed = 0;
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      let ended = false;
      try {
        const obj = JSON.parse(fs.readFileSync(full, "utf8")) as HookStatus;
        ended = obj.state === "ended";
      } catch {
        ended = true; // unreadable -> safe to drop
      }
      if (ended || now * 1000 - st.mtimeMs > staleMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Rate-limit budget (written by statusline.sh from Claude Code's rate_limits)
// ---------------------------------------------------------------------------

export const LIMITS_FILE = path.join(MONITOR_DIR, "limits.json");
export const LIMITS_HISTORY = path.join(MONITOR_DIR, "limits-history.jsonl");

/** Raw shape written by statusline.sh. Utilization may be 0-1 or 0-100. */
export interface RawLimits {
  fh?: number | null;
  fh_reset?: number | string | null;
  sd?: number | null;
  sd_reset?: number | string | null;
  sds?: number | null;
  sds_reset?: number | string | null;
  model?: string;
  ts?: number;
  src?: string; // "ext" = written by the extension (percent scale, never 0-1)
  acct?: string; // account id the point belongs to (absent on legacy/statusline points)
}

export function readLimits(file = LIMITS_FILE): RawLimits | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as RawLimits) : undefined;
  } catch {
    return undefined;
  }
}

export function readLimitsHistory(maxPoints = 240, file = LIMITS_HISTORY): RawLimits[] {
  let text = "";
  let partialFirst = false;
  try {
    const r = readTail(file, 256 * 1024);
    text = r.text;
    partialFirst = r.partialFirst;
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (partialFirst && lines.length) lines.shift();
  const out: RawLimits[] = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as RawLimits);
    } catch {
      // ignore
    }
  }
  return out.slice(-maxPoints);
}

/**
 * Append one usage sample to the history series. Throttled via file mtime so
 * the extension's 10s poll and a terminal statusline (also <=1/min) do not
 * flood the file or double-write the same minute.
 */
export function appendLimitsHistory(point: RawLimits, file = LIMITS_HISTORY, minGapSec = 55): void {
  try {
    let lastMs = 0;
    try {
      lastMs = fs.statSync(file).mtimeMs;
    } catch {
      /* first write */
    }
    if (minGapSec > 0 && Date.now() - lastMs < minGapSec * 1000) return;
    fs.appendFileSync(file, JSON.stringify(point) + "\n");
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Official usage snapshot — shared across ALL VS Code windows so only one
// window actually polls the API (single-flight) and everyone shows the same
// last-known gauges. Also carries the 429 backoff state all windows honor.
// ---------------------------------------------------------------------------

export const OFFICIAL_USAGE_FILE = path.join(MONITOR_DIR, "official-usage.json");

export interface OfficialSnapshotGauge {
  key: string;
  label: string;
  pct: number;
  resetMs: number | null;
}

export interface OfficialSnapshot {
  gauges: OfficialSnapshotGauge[];
  ts: number; // epoch sec of last SUCCESSFUL fetch (0 = never)
  attemptTs?: number; // epoch sec of last attempt by any window (single-flight)
  backoffUntil?: number; // epoch sec all windows wait until after a 429
  backoffSec?: number; // last backoff length, for exponential growth
  tokenStale?: boolean; // stored token rejected/expired — gauges are last-known only
}

export function readOfficialSnapshot(file = OFFICIAL_USAGE_FILE): OfficialSnapshot | undefined {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    if (v && typeof v === "object" && Array.isArray(v.gauges) && typeof v.ts === "number") {
      return v as OfficialSnapshot;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

export function writeOfficialSnapshot(snap: OfficialSnapshot, file = OFFICIAL_USAGE_FILE): void {
  try {
    atomicWrite(file, JSON.stringify(snap));
  } catch {
    /* ignore */
  }
}

/** Per-account official-usage snapshot path (the active account also mirrors to the legacy file). */
export function officialUsageFileFor(accountId: string): string {
  const safe = accountId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 16) || "default";
  return path.join(MONITOR_DIR, `official-usage-${safe}.json`);
}

// ---------------------------------------------------------------------------
// Account registry — every Claude account seen as the active login on this
// machine, so the UI can show usage for each account of a user who switches
// logins. Identity + freshness metadata only; tokens live in VS Code
// SecretStorage (OS keychain), never in this file.
// ---------------------------------------------------------------------------

export const ACCOUNTS_FILE = path.join(MONITOR_DIR, "accounts.json");

export interface AccountInfo {
  id: string; // Anthropic account UUID ("default" when identity is unknown)
  email: string;
  lastSeenTs: number; // epoch sec this account was last seen as the active login
  tokenExpiresAt?: number; // epoch ms the stored access token expires (from the keychain payload)
}

export interface AccountsFile {
  v: 1;
  accounts: AccountInfo[];
  activeId?: string;
}

export function readAccountsFile(file = ACCOUNTS_FILE): AccountsFile {
  const raw = readJson<Record<string, unknown>>(file, {});
  const accounts = Array.isArray(raw.accounts)
    ? (raw.accounts as AccountInfo[]).filter(
        (a) => !!a && typeof a.id === "string" && typeof a.email === "string" && typeof a.lastSeenTs === "number",
      )
    : [];
  return { v: 1, accounts, activeId: typeof raw.activeId === "string" ? raw.activeId : undefined };
}

/** Pure upsert: a NEW AccountsFile with `acct` recorded as the active login, newest first. */
export function upsertActiveAccount(
  f: AccountsFile,
  acct: { id: string; email: string; tokenExpiresAt?: number },
  nowSec: number,
): AccountsFile {
  const prev = f.accounts.find((a) => a.id === acct.id);
  const entry: AccountInfo = {
    id: acct.id,
    email: acct.email,
    lastSeenTs: nowSec,
    tokenExpiresAt: acct.tokenExpiresAt ?? prev?.tokenExpiresAt,
  };
  const rest = f.accounts.filter((a) => a.id !== acct.id);
  return { v: 1, accounts: [entry, ...rest].sort((a, b) => b.lastSeenTs - a.lastSeenTs), activeId: acct.id };
}

export function writeAccountsFile(f: AccountsFile, file = ACCOUNTS_FILE): void {
  try {
    atomicWrite(file, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}

export function pruneLimitsHistory(maxLines = 3000): void {
  try {
    const lines = fs.readFileSync(LIMITS_HISTORY, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > maxLines) {
      atomicWrite(LIMITS_HISTORY, lines.slice(-maxLines).join("\n") + "\n");
    }
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Token usage windows (rolling 5h / 7d) from transcripts.
//
// Real proxy for "how hard am I using Claude" since the official 5h/7d limit %
// is not exposed to extensions in the VS Code app. Sums message.usage tokens
// into hourly buckets. Incremental: each transcript's byte offset is persisted
// so only newly appended bytes are read after the first (bounded) backfill.
// ---------------------------------------------------------------------------

export const TOKEN_OFFSETS = path.join(MONITOR_DIR, "token-offsets.json");
export const TOKEN_BUCKETS = path.join(MONITOR_DIR, "token-buckets.json");
const BACKFILL_CAP = 4 * 1024 * 1024; // first-pass per-file tail cap
const FILE_READ_CAP = 8 * 1024 * 1024; // max bytes read from a single file per scan call
const SCAN_BYTE_BUDGET = 30 * 1024 * 1024; // max bytes read per scan call (backfill spreads over ticks)

export interface ModelStat {
  tokens: number; // in + out + cache-write
  inTok: number;
  outTok: number;
  cwTok: number;
}

export interface TokenUsage {
  fiveHour: number;
  sevenDay: number;
  hourly: { hour: number; tokens: number }[]; // last 48 hourly buckets
  bySession5h: Record<string, number>; // top 5h consumers by session id
  byModel7d: Record<string, ModelStat>; // 7d totals per model id
}

function tokensOfLine(obj: any): { t: number; i: number; o: number; c: number } | null {
  const u = obj?.message?.usage;
  if (!u) return null;
  // input + output + cache-write. cache_read is excluded: it is huge and counts
  // minimally toward limits, so including it would drown out the real signal.
  const i = u.input_tokens || 0;
  const o = u.output_tokens || 0;
  const c = u.cache_creation_input_tokens || 0;
  const t = i + o + c;
  return t ? { t, i, o, c } : null;
}

/**
 * On-disk bucket store. v2 adds per-session and per-model hourly buckets;
 * a v1 file (plain hour->tokens map) is migrated in place on first load.
 */
interface BucketStore {
  v: 2;
  global: Record<string, number>; // hour -> tokens
  session: Record<string, number>; // "hour:sessionId" -> tokens
  model: Record<string, ModelStat>; // "hour:modelId" -> stat
}

function loadBucketStore(file: string): BucketStore {
  const raw = readJson<Record<string, unknown>>(file, {});
  if (raw.v === 2 && raw.global && typeof raw.global === "object") {
    return {
      v: 2,
      global: (raw.global as Record<string, number>) ?? {},
      session: ((raw.session as Record<string, number>) ?? {}) as Record<string, number>,
      model: ((raw.model as Record<string, ModelStat>) ?? {}) as Record<string, ModelStat>,
    };
  }
  const global: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "number") global[k] = v;
  return { v: 2, global, session: {}, model: {} };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    // Guard against a literal "null"/array/primitive (e.g. a truncated write):
    // returning those would make the caller's object access throw.
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Write atomically (temp + rename) so a mid-write kill cannot truncate the target. */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export interface TokenScanOpts {
  maxBytesPerCall?: number;
  offsetsFile?: string;
  bucketsFile?: string;
  backfillCap?: number; // overridable for tests
  fileReadCap?: number; // overridable for tests
}

export function scanTokenUsage(
  transcripts: { path: string }[],
  now: number,
  opts: TokenScanOpts = {},
): TokenUsage {
  const offsetsFile = opts.offsetsFile ?? TOKEN_OFFSETS;
  const bucketsFile = opts.bucketsFile ?? TOKEN_BUCKETS;
  const maxBytesPerCall = opts.maxBytesPerCall ?? SCAN_BYTE_BUDGET;
  const backfillCap = opts.backfillCap ?? BACKFILL_CAP;
  const fileReadCap = opts.fileReadCap ?? FILE_READ_CAP;
  const offsets = readJson<Record<string, { offset: number; size: number }>>(offsetsFile, {});
  const store = loadBucketStore(bucketsFile);
  const buckets = store.global;
  let bytesRead = 0;

  for (const t of transcripts) {
    if (bytesRead >= maxBytesPerCall) break; // resume remaining files next call (offsets persist)
    let st: fs.Stats;
    try {
      st = fs.statSync(t.path);
    } catch {
      continue;
    }
    const prev = offsets[t.path];
    let start = prev ? prev.offset : Math.max(0, st.size - backfillCap);
    if (prev && st.size < prev.size) start = Math.max(0, st.size - backfillCap); // rotated/truncated
    if (start >= st.size) {
      offsets[t.path] = { offset: st.size, size: st.size };
      continue;
    }

    // Bounded read: never more than fileReadCap or the remaining budget, so a huge
    // delta cannot exhaust memory, and the offset always advances (no infinite re-read).
    const want = Math.min(st.size - start, fileReadCap, maxBytesPerCall - bytesRead);
    if (want <= 0) break;
    let chunk = "";
    let read = 0;
    try {
      const fd = fs.openSync(t.path, "r");
      try {
        const buf = Buffer.alloc(want);
        read = fs.readSync(fd, buf, 0, want, start);
        chunk = buf.toString("utf8", 0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    bytesRead += read;
    const atEof = start + read >= st.size;

    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl < 0) {
      // No complete line in this chunk.
      if (atEof) offsets[t.path] = { offset: start, size: st.size }; // last line still being written
      else offsets[t.path] = { offset: start + read, size: st.size }; // skip past an over-long line
      continue;
    }
    const body = chunk.slice(0, lastNl);
    // Advance by BYTES (not char index) so multi-byte UTF-8 does not drift the offset.
    const consumed = Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
    const lines = body.split("\n");
    // Backfill starts mid-file -> drop the first (partial) line, UNLESS `start` is
    // exactly on a line boundary (the preceding byte is a newline), in which case the
    // first line is complete and must be kept.
    let startIdx = 0;
    if (!prev && start > 0) {
      startIdx = 1;
      try {
        const fd2 = fs.openSync(t.path, "r");
        try {
          const b = Buffer.alloc(1);
          fs.readSync(fd2, b, 0, 1, start - 1);
          if (b[0] === 0x0a) startIdx = 0;
        } finally {
          fs.closeSync(fd2);
        }
      } catch {
        /* keep startIdx = 1 */
      }
    }

    for (let i = startIdx; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      let obj: any;
      try {
        obj = JSON.parse(s);
      } catch {
        continue;
      }
      if (obj.type !== "assistant") continue;
      const tok = tokensOfLine(obj);
      if (!tok) continue;
      const ms = Date.parse(obj.timestamp);
      if (!Number.isFinite(ms)) continue;
      const hour = Math.floor(ms / 1000 / 3600);
      buckets[hour] = (buckets[hour] || 0) + tok.t;
      const sid = path.basename(t.path, ".jsonl");
      const skey = `${hour}:${sid}`;
      store.session[skey] = (store.session[skey] || 0) + tok.t;
      const model = typeof obj.message?.model === "string" ? obj.message.model : "unknown";
      const mkey = `${hour}:${model}`;
      const m = store.model[mkey] ?? { tokens: 0, inTok: 0, outTok: 0, cwTok: 0 };
      m.tokens += tok.t;
      m.inTok += tok.i;
      m.outTok += tok.o;
      m.cwTok += tok.c;
      store.model[mkey] = m;
    }
    offsets[t.path] = { offset: start + consumed, size: st.size };
  }

  const cutoffHour = Math.floor((now - 8 * 86400) / 3600);
  for (const k of Object.keys(buckets)) if (parseInt(k, 10) < cutoffHour) delete buckets[k];
  for (const k of Object.keys(store.session)) if (parseInt(k, 10) < cutoffHour) delete store.session[k];
  for (const k of Object.keys(store.model)) if (parseInt(k, 10) < cutoffHour) delete store.model[k];

  // Prune offsets of transcripts that fell out of the scan window so the
  // offsets file cannot grow without bound over months of sessions. Already-
  // counted tokens stay in `buckets`; a pruned file that reappears would be
  // outside the 7d window anyway.
  const known = new Set(transcripts.map((t) => t.path));
  const offsetKeys = Object.keys(offsets);
  if (offsetKeys.length > known.size + 100) {
    for (const k of offsetKeys) if (!known.has(k)) delete offsets[k];
  }

  try {
    atomicWrite(offsetsFile, JSON.stringify(offsets));
  } catch {
    /* ignore */
  }
  try {
    atomicWrite(bucketsFile, JSON.stringify(store));
  } catch {
    /* ignore */
  }

  const nowHour = Math.floor(now / 3600);
  const fiveCutHour = Math.floor((now - 5 * 3600) / 3600);
  const sevenCutHour = Math.floor((now - 7 * 86400) / 3600);
  let fiveHour = 0;
  let sevenDay = 0;
  for (const [k, v] of Object.entries(buckets)) {
    const hr = parseInt(k, 10);
    if (hr >= fiveCutHour) fiveHour += v;
    if (hr >= sevenCutHour) sevenDay += v;
  }
  const hourly: { hour: number; tokens: number }[] = [];
  for (let hr = nowHour - 47; hr <= nowHour; hr++) hourly.push({ hour: hr, tokens: buckets[hr] || 0 });

  // Per-session 5h totals (top 8 consumers).
  const bySessionAll: Record<string, number> = {};
  for (const [k, v] of Object.entries(store.session)) {
    if (parseInt(k, 10) < fiveCutHour) continue;
    const idx = k.indexOf(":");
    if (idx < 0) continue;
    const sid = k.slice(idx + 1);
    bySessionAll[sid] = (bySessionAll[sid] || 0) + v;
  }
  const bySession5h: Record<string, number> = {};
  for (const [sid, v] of Object.entries(bySessionAll).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    bySession5h[sid] = v;
  }

  // Per-model 7d totals.
  const byModel7d: Record<string, ModelStat> = {};
  for (const [k, m] of Object.entries(store.model)) {
    if (parseInt(k, 10) < sevenCutHour) continue;
    const idx = k.indexOf(":");
    if (idx < 0) continue;
    const id = k.slice(idx + 1);
    const agg = byModel7d[id] ?? { tokens: 0, inTok: 0, outTok: 0, cwTok: 0 };
    agg.tokens += m.tokens;
    agg.inTok += m.inTok;
    agg.outTok += m.outTok;
    agg.cwTok += m.cwTok;
    byModel7d[id] = agg;
  }

  return { fiveHour, sevenDay, hourly, bySession5h, byModel7d };
}
