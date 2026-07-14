/**
 * view.ts — pure (vscode-free) presentation helpers shared by the extension UI.
 * Kept separate from extension.ts so the grouping / formatting / matching logic
 * is unit-testable without a VS Code host.
 */
import type { SessionView, ModelStat } from "./core";

export type GroupKey = "limited" | "waiting" | "done" | "working" | "ended" | "unknown";

export interface GroupMeta {
  key: GroupKey;
  label: string;
  icon: string; // codicon id
  color: string; // ThemeColor id
}

export const GROUPS: GroupMeta[] = [
  { key: "limited", label: "Limited", icon: "error", color: "charts.red" },
  { key: "waiting", label: "Waiting for you", icon: "bell-dot", color: "charts.yellow" },
  { key: "done", label: "Your turn", icon: "comment", color: "charts.blue" },
  { key: "working", label: "Working", icon: "sync", color: "charts.green" },
  { key: "ended", label: "Ended", icon: "circle-slash", color: "disabledForeground" },
  { key: "unknown", label: "Unknown", icon: "question", color: "disabledForeground" },
];

export const GROUP_INDEX: Record<GroupKey, number> = {
  limited: 0,
  waiting: 1,
  done: 2,
  working: 3,
  ended: 4,
  unknown: 5,
};

export const NEEDS_YOU: GroupKey[] = ["limited", "waiting", "done"];

export function groupOf(v: SessionView): GroupKey {
  if (v.bucket === "limited") return "limited";
  if (v.bucket === "working") return "working";
  if (v.bucket === "ended") return "ended";
  if (v.bucket === "attention") return v.sub === "waiting for you" ? "waiting" : "done";
  return "unknown";
}

/** Utilization may arrive as a fraction (0-1) or a percent (0-100). Normalize to percent. */
export function normPct(u: unknown): number | null {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return u <= 1 ? u * 100 : u;
}

/** A reset timestamp may be epoch seconds, epoch ms, or an ISO string. Normalize to ms. */
export function normResetMs(r: unknown): number | null {
  if (typeof r === "number" && Number.isFinite(r)) return r < 1e12 ? r * 1000 : r;
  if (typeof r === "string") {
    const ms = Date.parse(r);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function fmtMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${mb}MB`;
}

/**
 * Max characters of a session title shown in the tree row. Kept short so that on
 * a narrow side panel the description after it (model · age · cwd) still fits;
 * the full title lives in the tooltip.
 */
export const TITLE_MAX = 24;

export function truncateTitle(s: string, max = TITLE_MAX): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/**
 * Sub-status labels that merely restate the group header (and the row icon), so
 * printing them on the row wastes width. Dropped from the row description; the
 * exceptional subs ("working (stalled?)", "session limit", "API error", ...)
 * still show because they carry information the group header does not.
 */
const REDUNDANT_SUBS = new Set(["working", "your turn", "waiting for you", "ended", "unknown"]);

export function isRedundantSub(sub: string): boolean {
  return REDUNDANT_SUBS.has(sub.trim().toLowerCase());
}

/** Clamp an already-percent-scale value to [0, 100]. */
export function clampPct(u: unknown): number | null {
  if (typeof u !== "number" || !Number.isFinite(u)) return null;
  return Math.max(0, Math.min(100, u));
}

export interface OfficialGauge {
  key: string;
  label: string;
  pct: number;
  resetMs: number | null;
}

/**
 * Parse the api.anthropic.com/api/oauth/usage payload into gauges.
 *
 * Prefers the modern `limits[]` array (kind/group/percent/resets_at/scope) —
 * this is where per-model scoped limits such as "Weekly · Fable" appear — and
 * falls back to the legacy five_hour / seven_day / seven_day_* objects.
 * All values are percent-scale (4.0 = 4%), never fractions.
 */
export function parseOfficialGauges(p: unknown): OfficialGauge[] {
  const gauges: OfficialGauge[] = [];
  const seen = new Set<string>();
  const push = (key: string, label: string, pct: number | null, resetMs: number | null): void => {
    if (pct == null || seen.has(key)) return;
    seen.add(key);
    gauges.push({ key, label, pct, resetMs });
  };
  const root = (p ?? {}) as Record<string, unknown>;

  const limits = root.limits;
  if (Array.isArray(limits)) {
    for (const raw of limits) {
      if (!raw || typeof raw !== "object") continue;
      const l = raw as Record<string, unknown>;
      const pct = clampPct(typeof l.percent === "number" ? l.percent : (l.utilization as number));
      const resetMs = normResetMs(l.resets_at);
      const kind = typeof l.kind === "string" ? l.kind : "";
      const scope = l.scope as { model?: { display_name?: string }; surface?: string } | null | undefined;
      const scopeName = scope?.model?.display_name || scope?.surface || "";
      if (kind === "session") push("session", "Session (5h)", pct, resetMs);
      else if (kind === "weekly_all") push("weekly", "Weekly (7d)", pct, resetMs);
      else if (scopeName) push(`weekly-${scopeName.toLowerCase()}`, `Weekly · ${scopeName}`, pct, resetMs);
      else if (kind) push(kind, kind.replace(/_/g, " "), pct, resetMs);
    }
  }

  // Legacy objects: only fill gaps the limits[] array did not cover.
  const legacy = (field: string, key: string, label: string): void => {
    const o = root[field] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (o && o.utilization != null) push(key, label, clampPct(o.utilization as number), normResetMs(o.resets_at));
  };
  legacy("five_hour", "session", "Session (5h)");
  legacy("seven_day", "weekly", "Weekly (7d)");
  legacy("seven_day_opus", "weekly-opus", "Weekly · Opus");
  legacy("seven_day_sonnet", "weekly-sonnet", "Weekly · Sonnet");
  return gauges;
}

// ---------------------------------------------------------------------------
// Multi-account presentation helpers
// ---------------------------------------------------------------------------

/** One account entry as shown in the webview's switcher row. */
export interface AccountView {
  id: string;
  email: string;
  label: string;
  active: boolean; // currently the Claude Code login on this machine
  selected: boolean; // currently displayed in the panel
  ts: number | null; // epoch sec of its last successful usage fetch
  stale: boolean; // stored token expired/rejected — data is last-known only
}

/**
 * Short pill labels for a set of account emails: the local part alone when it
 * is unambiguous ("bilal"), local@domain-word when two accounts share a local
 * part ("info@glossgo" vs "info@softween").
 */
export function accountPillLabels(emails: string[]): string[] {
  const locals = emails.map((e) => {
    const at = e.indexOf("@");
    return at > 0 ? e.slice(0, at) : e;
  });
  return locals.map((local, i) => {
    const dup = locals.some((other, j) => j !== i && other.toLowerCase() === local.toLowerCase());
    if (!dup) return local;
    const domain = emails[i].slice(emails[i].indexOf("@") + 1);
    const word = domain.split(".")[0] || domain;
    return word ? `${local}@${word}` : local;
  });
}

/**
 * History points belonging to one account: points tagged with its id, plus —
 * only for the account that is the CURRENT active login — untagged legacy
 * points (pre-multi-account extension writes and terminal-statusline writes,
 * which always describe the active login).
 */
export function filterHistoryForAccount<T extends { acct?: string }>(
  points: T[],
  accountId: string | null,
  isActiveLogin: boolean,
): T[] {
  if (!accountId) return points;
  return points.filter((p) => (p.acct ? p.acct === accountId : isActiveLogin));
}

/** One session row in the webview's "Sessions (5h tokens)" breakdown. */
export interface SessionTokenRow {
  label: string;
  tokens: number;
  pct: number; // share of the machine's 5h total, 0-100
}

/**
 * Top sessions by 5h token spend, labeled with live session titles where the
 * session is still visible (fallback: the short session id).
 */
export function topSessionRows(
  bySession5h: Record<string, number>,
  titles: Map<string, string>,
  fiveHourTotal: number,
  n = 6,
): SessionTokenRow[] {
  const summed = Object.values(bySession5h).reduce((s, v) => s + v, 0);
  const total = Math.max(fiveHourTotal, summed, 1);
  return Object.entries(bySession5h)
    .filter(([, tokens]) => tokens > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([sid, tokens]) => ({
      label: titles.get(sid) ?? `session ${sid.slice(0, 8)}`,
      tokens,
      pct: Math.min(100, Math.round((tokens / total) * 100)),
    }));
}

/** Strip trailing ellipsis/dots and lowercase, for tolerant tab-label matching. */
export function normLabel(s: string): string {
  return s.replace(/[….]+$/, "").trim().toLowerCase();
}

export function labelsMatch(tabLabel: string, title: string): boolean {
  const a = normLabel(tabLabel);
  const b = normLabel(title);
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function fmtTokensCompact(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
  return `${(n / 1e6).toFixed(2)}M`;
}

// ---------------------------------------------------------------------------
// Burn-rate ETA: from the 1/min usage history, how fast is the 5h window
// filling and will it hit 100% before its own reset?
// ---------------------------------------------------------------------------

export interface BurnEta {
  perHour: number; // percent points per hour
  fullAtMs: number; // projected epoch ms of hitting 100%
  beforeReset: boolean; // true = fills up BEFORE the window resets
}

export function computeBurnEta(
  history: { t: number; fh: number | null }[],
  currentPct: number | null,
  resetMs: number | null,
  nowMs: number,
  windowMs = 45 * 60_000,
): BurnEta | null {
  if (currentPct == null || currentPct >= 100) return null;
  const pts = history.filter((p) => p.fh != null && p.t > 0 && nowMs - p.t <= windowMs && p.t <= nowMs);
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const dtH = (last.t - first.t) / 3600e3;
  if (dtH < 10 / 60) return null; // need >= 10 min of signal
  // A reset inside the window (a big drop) makes the slope meaningless.
  for (let i = 1; i < pts.length; i++) {
    if ((pts[i].fh as number) < (pts[i - 1].fh as number) - 5) return null;
  }
  const perHour = ((last.fh as number) - (first.fh as number)) / dtH;
  if (perHour <= 0.5) return null; // flat or falling -> no meaningful ETA
  const fullAtMs = nowMs + ((100 - currentPct) / perHour) * 3600e3;
  return { perHour, fullAtMs, beforeReset: resetMs != null && fullAtMs < resetMs };
}

// ---------------------------------------------------------------------------
// Rough cost estimate per model. Prices are USD per MTok (input/output);
// cache-write is billed at 1.25x input. Models without public pricing
// (e.g. Fable/Mythos) return null and are labeled "not priced" in the UI.
// ---------------------------------------------------------------------------

function priceFor(modelId: string): { inUsd: number; outUsd: number } | null {
  const s = modelId.toLowerCase();
  if (s.includes("opus")) return { inUsd: 15, outUsd: 75 };
  if (s.includes("sonnet")) return { inUsd: 3, outUsd: 15 };
  if (s.includes("haiku")) return { inUsd: 1, outUsd: 5 };
  return null;
}

export function estimateCostUsd(m: ModelStat, modelId: string): number | null {
  const p = priceFor(modelId);
  if (!p) return null;
  return (m.inTok * p.inUsd + m.outTok * p.outUsd + m.cwTok * p.inUsd * 1.25) / 1e6;
}

/** Compact reasoning-effort label, e.g. "medium" -> "med". Passes unknowns through. */
export function shortEffort(effort: string | undefined): string | undefined {
  if (!effort) return undefined;
  const s = effort.trim().toLowerCase();
  if (!s) return undefined;
  const map: Record<string, string> = {
    minimal: "min",
    low: "low",
    medium: "med",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  };
  return map[s] ?? s;
}

/**
 * "claude-fable-5" -> "Fable 5", "claude-opus-4-8" -> "Opus 4.8",
 * "claude-haiku-4-5-20251001" -> "Haiku 4.5". The leading word is the family;
 * trailing numeric segments are the version and get joined with dots so
 * "opus-4-8" reads as a version ("4.8"), not two separate numbers.
 */
export function shortModelName(id: string): string {
  const base = id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .trim();
  if (!base) return id;
  const parts = base.split("-");
  const family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const rest = parts.slice(1);
  if (rest.length === 0) return family;
  const sep = rest.every((p) => /^\d+$/.test(p)) ? "." : " ";
  return `${family} ${rest.join(sep)}`;
}

/** Exponential 429 backoff: honor Retry-After, else double the previous, clamp [60, 900]. */
export function nextUsageBackoffSec(prevSec: number | undefined, retryAfterSec: number | undefined): number {
  const doubled = prevSec && prevSec > 0 ? prevSec * 2 : 60;
  return Math.max(60, Math.min(900, Math.max(retryAfterSec ?? 0, doubled)));
}

export interface PsRow {
  pid: number;
  cpu: number;
  rssMb: number;
}

/** Parse `ps -o pid=,pcpu=,rss=` output into rows (rss kB -> MB), skipping junk lines. */
export function parsePsOutput(stdout: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of stdout.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length < 3) continue;
    const pid = parseInt(p[0], 10);
    if (!Number.isFinite(pid)) continue;
    const cpu = parseFloat(p[1]);
    const rssKb = parseInt(p[2], 10);
    rows.push({
      pid,
      cpu: Number.isFinite(cpu) ? cpu : 0,
      rssMb: Math.round((Number.isFinite(rssKb) ? rssKb : 0) / 1024),
    });
  }
  return rows;
}
