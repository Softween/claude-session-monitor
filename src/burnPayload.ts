// Display contract of the "Limit burn" view: what the host sends to the
// webview (and what the terminal view prints). Pure, no fs and no vscode.

import { driversOf, type BurnScale, type BurnSessionStat, type BurnSummary, type GaugeSample } from "./burn";
import type { RawLimits } from "./core";

export interface BurnWindowOption {
  ms: number;
  label: string;
}

export const BURN_WINDOWS: readonly BurnWindowOption[] = [
  { ms: 5 * 60_000, label: "5m" },
  { ms: 15 * 60_000, label: "15m" },
  { ms: 60 * 60_000, label: "1h" },
  { ms: 5 * 60 * 60_000, label: "5h" },
];

export const DEFAULT_BURN_WINDOW_MS = 15 * 60_000;

/** How a session id maps onto the Sessions list. */
export interface BurnLookup {
  title: string;
  openId: string; // Sessions row id to open on click, "" when the session is no longer listed
  ended: boolean;
}

/** USD to 5h-limit percent, either measured in the current window or remembered for the account. */
export interface ResolvedScale {
  ptsPerUsd: number;
  acct: string;
  cached: boolean; // true when the current window gave no measurement and the remembered rate is used
  spanMs: number;
  deltaPct: number;
}

/** One ranked session, already formatted for display. */
export interface BurnRowView {
  sessionId: string;
  openId: string;
  rank: number; // 1-based
  title: string;
  meta: string; // "15% of burn · fable-5-2, opus-5-5 · subagents 78%"
  sharePct: number; // 0..100, share of the window's total burn
  barPct: number; // 0..100, bar width relative to the top row
  used: string; // "≈ 23%" of the 5h limit when scaled, else "$43.2"
  rate: string; // "+18%/h" when scaled, else "$41/h"; "idle" when nothing landed in the rate window
  live: boolean; // a request landed in the last 90 s
  ended: boolean;
  tip: string; // multi-line tooltip
}

export interface BurnPayload {
  type: "update";
  windowMs: number;
  windows: BurnWindowOption[];
  scaled: boolean; // true when `used` and `rate` are in 5h-limit percent
  headline: string; // "$226/h · ≈ +118%/h of the 5h limit · full in ~24 min"
  note: string; // one short line saying how the estimate is made
  rows: BurnRowView[];
  more: number; // ranked sessions that are not shown
  empty: string; // shown when rows is empty
}

export interface BurnPayloadArgs {
  summary: BurnSummary;
  scale: ResolvedScale | null;
  sessionPct: number | null; // current 5h gauge, null when unknown or stale
  nowMs: number;
  lookup: (sessionId: string) => BurnLookup;
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Gauge and scale
// ---------------------------------------------------------------------------

/** A fresh measurement at least this many gauge points wide is solid enough to remember. */
export const SOLID_DELTA_PCT = 10;

const REMEMBER_TOLERANCE = 0.05; // a solid rate within 5% of the remembered one leaves the cache as is
const LIVE_MS = 90_000;
const DEFAULT_MAX_ROWS = 12;

type RateCache = Readonly<Record<string, number>>;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Gauge history rows (ts in seconds) -> calibrate() samples (ms), ascending; rows without account or 5h data are dropped. */
export function gaugeSamplesFromHistory(history: readonly RawLimits[]): GaugeSample[] {
  return history
    .flatMap((h): GaugeSample[] => {
      const { acct, fh, fh_reset: resetMs, ts } = h;
      if (typeof acct !== "string" || !isNum(fh) || !isNum(resetMs) || !isNum(ts) || ts <= 0) return [];
      return [{ ts: Math.round(ts * 1000), acct, pct: fh, resetMs }];
    })
    .sort((a, b) => a.ts - b.ts);
}

/** sessionId -> share of the window's burn, 0..100. */
export function burnShares(summary: BurnSummary): Map<string, number> {
  return new Map(summary.sessions.map((s): [string, number] => [s.sessionId, s.share * 100]));
}

function rememberedRate(cache: RateCache, acct: string | null): number | undefined {
  if (acct === null || !Object.hasOwn(cache, acct)) return undefined;
  const rate = cache[acct];
  return isNum(rate) && rate > 0 ? rate : undefined;
}

const rememberedScale = (ptsPerUsd: number, acct: string): ResolvedScale => ({
  ptsPerUsd,
  acct,
  cached: true,
  spanMs: 0,
  deltaPct: 0,
});

/**
 * The USD to 5h-percent scale to show. A solid fresh measurement (at least
 * SOLID_DELTA_PCT points) wins and is remembered for its account; a weak one
 * yields to the remembered rate; without one, the remembered rate of `acct`.
 * The input cache is never mutated: a NEW object comes back only when the
 * remembered rate was added or moved by more than 5%, else the same `cache`.
 */
export function resolveScale(
  fresh: BurnScale | null,
  acct: string | null,
  cache: RateCache,
): { scale: ResolvedScale | null; cache: RateCache } {
  if (fresh && fresh.deltaPct >= SOLID_DELTA_PCT) {
    const prev = rememberedRate(cache, fresh.acct);
    const keep = prev !== undefined && Math.abs(fresh.ptsPerUsd - prev) <= prev * REMEMBER_TOLERANCE;
    return { scale: { ...fresh, cached: false }, cache: keep ? cache : { ...cache, [fresh.acct]: fresh.ptsPerUsd } };
  }
  if (fresh) {
    const prev = rememberedRate(cache, fresh.acct);
    return { scale: prev !== undefined ? rememberedScale(prev, fresh.acct) : { ...fresh, cached: false }, cache };
  }
  const prev = rememberedRate(cache, acct);
  return { scale: prev !== undefined && acct !== null ? rememberedScale(prev, acct) : null, cache };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "<0.1", one decimal below 10, else a whole number. */
function fmtPct(x: number): string {
  if (x < 0.1) return "<0.1";
  return x < 10 ? x.toFixed(1) : String(Math.round(x));
}

/** "$0.42", "$8.3", "$282". */
function fmtUsd(x: number): string {
  if (x < 1) return `$${x.toFixed(2)}`;
  return x < 100 ? `$${x.toFixed(1)}` : `$${Math.round(x)}`;
}

function compact(n: number): string {
  if (n < 1000) return String(Math.round(n));
  return n < 1_000_000 ? `${Math.round(n / 1000)}K` : `${(n / 1_000_000).toFixed(1)}M`;
}

function windowLabel(ms: number): string {
  return BURN_WINDOWS.find((w) => w.ms === ms)?.label ?? `${Math.round(ms / 60_000)} min`;
}

function metaOf(s: BurnSessionStat): string {
  const extra = s.models.length - 2;
  const models = s.models.slice(0, 2).join(", ") + (extra > 0 ? ` +${extra}` : "");
  return [`${Math.round(s.share * 100)}% of burn`, models, ...driversOf(s)].filter((part) => part !== "").join(" · ");
}

function tipOf(s: BurnSessionStat): string {
  const t = s.tokens;
  return [
    `requests: ${s.requests}`,
    `cost: ${fmtUsd(s.cost)} (API-equivalent)`,
    `tokens: in ${compact(t.input)} · cache write ${compact(t.cacheWrite)} · cache read ${compact(t.cacheRead)} · out ${compact(t.output)}`,
    s.avgContext > 0 ? `avg context: ${Math.round(s.avgContext / 1000)}K` : "",
    s.subShare > 0 ? `subagents: ${Math.round(s.subShare * 100)}% of cost` : "",
    `models: ${s.models.join(", ")}`,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function rateOf(ratePerHour: number, k: number | undefined): string {
  if (ratePerHour === 0) return "idle";
  return k !== undefined ? `+${fmtPct(ratePerHour * k)}%/h` : `${fmtUsd(ratePerHour)}/h`;
}

function rowOf(s: BurnSessionStat, rank: number, topShare: number, args: BurnPayloadArgs): BurnRowView {
  const k = args.scale?.ptsPerUsd;
  const who = args.lookup(s.sessionId);
  return {
    sessionId: s.sessionId,
    openId: who.openId,
    rank,
    title: who.title,
    meta: metaOf(s),
    sharePct: s.share * 100,
    barPct: topShare > 0 ? (s.share / topShare) * 100 : 0,
    used: k !== undefined ? `≈ ${fmtPct(s.cost * k)}%` : fmtUsd(s.cost),
    rate: rateOf(s.ratePerHour, k),
    live: args.nowMs - s.lastTs <= LIVE_MS,
    ended: who.ended,
    tip: tipOf(s),
  };
}

function etaOf(pctPerHour: number, sessionPct: number | null): string {
  if (sessionPct === null || sessionPct >= 100 || !(pctPerHour > 0)) return "";
  const minutes = ((100 - sessionPct) / pctPerHour) * 60;
  if (minutes < 90) return ` · full in ~${Math.round(minutes)} min`;
  return minutes < 300 ? ` · full in ~${(minutes / 60).toFixed(1)} h` : "";
}

function headlineOf(summary: BurnSummary, scale: ResolvedScale | null, sessionPct: number | null): string {
  const usdRate = `${fmtUsd(summary.totalRatePerHour)}/h`;
  if (!scale) return `${usdRate} API-equivalent`;
  const pctPerHour = summary.totalRatePerHour * scale.ptsPerUsd;
  return `${usdRate} · ≈ +${fmtPct(pctPerHour)}%/h of the 5h limit${etaOf(pctPerHour, sessionPct)}`;
}

function noteOf(scale: ResolvedScale | null): string {
  if (!scale) return "Estimate: API list prices. Limit percentages appear once the 5h gauge has moved 3 points.";
  if (scale.cached) return "Estimate: API list prices scaled with this account's last measured rate.";
  const pts = Number(scale.deltaPct.toFixed(1));
  return `Estimate: API list prices scaled to the 5h gauge (${pts} pts in ${Math.round(scale.spanMs / 60_000)} min).`;
}

/** The ranked sessions of one window, formatted for the webview and the terminal view. */
export function buildBurnPayload(args: BurnPayloadArgs): BurnPayload {
  const { summary } = args;
  const shown = summary.sessions.slice(0, args.maxRows ?? DEFAULT_MAX_ROWS);
  const topShare = summary.sessions[0]?.share ?? 0;
  return {
    type: "update",
    windowMs: summary.windowMs,
    windows: BURN_WINDOWS.map((w) => ({ ...w })),
    scaled: args.scale !== null,
    headline: headlineOf(summary, args.scale, args.sessionPct),
    note: noteOf(args.scale),
    rows: shown.map((s, i) => rowOf(s, i + 1, topShare, args)),
    more: summary.sessions.length - shown.length,
    empty: `No Claude requests in the last ${windowLabel(summary.windowMs)}.`,
  };
}
