// Limit burn: which Claude Code session spends the subscription limits fastest.
// Pure logic (no fs, no vscode imports) so it is unit-testable. Claude Code
// writes one transcript line per content block and repeats the same usage on
// each, so requests are deduped by key with a per-field max. API list prices
// only weight the token mix; calibrate() turns USD into points of the 5-hour gauge.

const HOUR_MS = 3_600_000;
const SAME_WINDOW_MS = 300_000; // gauge reset times this close belong to one 5-hour window

export interface BurnRecord {
  key: string; // requestId || message.id || uuid
  ts: number; // epoch ms from `timestamp`
  sessionId: string; // owning top-level session (from the file path)
  sub: boolean; // came from a subagent transcript
  model: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  fileMtimeMs: number; // mtime of the source file when the line was read
}

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface BurnSessionStat {
  sessionId: string;
  cost: number;
  share: number; // of the window's total cost, 0..1
  ratePerHour: number; // USD per hour over the rate window
  requests: number;
  subShare: number; // cost share of subagent requests
  cacheWriteShare: number; // cost share of cache writes
  avgContext: number; // mean prompt tokens of main-thread requests
  models: string[]; // `claude-` stripped, by cost desc
  lastTs: number;
  tokens: { input: number; cacheWrite: number; cacheRead: number; output: number };
}

export interface BurnSummary {
  windowMs: number;
  totalCost: number;
  totalRatePerHour: number;
  sessions: BurnSessionStat[];
}

export interface GaugeSample {
  ts: number;
  acct: string;
  pct: number;
  resetMs: number;
}

/** Percentage points of the 5-hour limit per USD of list-price burn, measured on one account. */
export interface BurnScale {
  ptsPerUsd: number;
  spanMs: number;
  deltaPct: number;
  acct: string;
}

export interface BurnUsage {
  kind: "usage";
  key: string;
  ts: number;
  model: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  cwd?: string;
}

export interface BurnTitle {
  kind: "title";
  title: string;
  custom: boolean;
}

export type BurnLine = BurnUsage | BurnTitle;

type TokenCounts = Pick<BurnRecord, "input" | "cacheWrite5m" | "cacheWrite1h" | "cacheRead" | "output">;
const TOKEN_FIELDS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"] as const;

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

const price = (input: number, output: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number): ModelPrice =>
  Object.freeze({ input, output, cacheWrite5m, cacheWrite1h, cacheRead });

const FABLE_MINOR = price(10, 50, 12.5, 20, 0.25);
const FABLE_BASE = price(10, 50, 12.5, 20, 1);
const OPUS_5_5 = price(4, 20, 5, 8, 0.2);
const OPUS = price(5, 25, 6.25, 10, 0.5);
const SONNET_5 = price(2, 10, 2.5, 4, 0.2);
const SONNET = price(3, 15, 3.75, 6, 0.3);
const HAIKU_5 = price(0.1, 0.5, 0.125, 0.2, 0.01);
const HAIKU_5_LONG = price(0.5, 2.5, 0.625, 1, 0.05);
const HAIKU = price(1, 5, 1.25, 2, 0.1);

/** Haiku 5 prompts above this many tokens bill at its long-context row. */
export const HAIKU_5_TIER_TOKENS = 100_000;

// A minor version (fable-5-1, mythos-5-2); a date suffix (fable-5-20260115) is not one.
const FABLE_MINOR_RE = /(?:fable|mythos)-5-(\d{1,2})(?!\d)/;

/** List price for a model id, most specific match first; unknown ids price as Opus 5.5. */
export function priceFor(model: string, promptTokens: number): ModelPrice {
  const m = model.toLowerCase();
  const minor = FABLE_MINOR_RE.exec(m);
  if (minor && Number(minor[1]) >= 1) return FABLE_MINOR;
  if (/(?:fable|mythos)-5(?!\d)/.test(m)) return FABLE_BASE;
  if (/opus-5-5(?!\d)/.test(m)) return OPUS_5_5;
  if (m.includes("opus")) return OPUS;
  if (/sonnet-5(?!\d)/.test(m)) return SONNET_5;
  if (m.includes("sonnet")) return SONNET;
  if (/haiku-5(?!\d)/.test(m)) return promptTokens <= HAIKU_5_TIER_TOKENS ? HAIKU_5 : HAIKU_5_LONG;
  if (m.includes("haiku")) return HAIKU;
  return OPUS_5_5;
}

/** Everything the model read for one request: uncached input plus cache writes and reads. */
function promptTokensOf(r: TokenCounts): number {
  return r.input + r.cacheWrite5m + r.cacheWrite1h + r.cacheRead;
}

function costParts(r: TokenCounts & { model: string }): { total: number; cacheWrite: number } {
  const p = priceFor(r.model, promptTokensOf(r));
  const cacheWrite = (r.cacheWrite5m * p.cacheWrite5m + r.cacheWrite1h * p.cacheWrite1h) / 1e6;
  const rest = (r.input * p.input + r.cacheRead * p.cacheRead + r.output * p.output) / 1e6;
  return { total: cacheWrite + rest, cacheWrite };
}

/** List-price USD of one request. */
export function costOf(rec: BurnRecord): number {
  return costParts(rec).total;
}

// ---------------------------------------------------------------------------
// Transcript lines
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * One transcript line -> the usage of an assistant request, a session title,
 * or null. Cheap substring prefilter before JSON.parse; never throws.
 */
export function parseBurnLine(line: string): BurnLine | null {
  const hasUsage = line.includes('"usage"');
  if (!hasUsage && !line.includes('title"')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(obj)) return null;
  if (obj.type === "assistant") return hasUsage ? usageOf(obj) : null;
  return titleOf(obj);
}

function usageOf(obj: Obj): BurnUsage | null {
  const msg = obj.message;
  if (!isObj(msg) || !isObj(msg.usage)) return null;
  const model = text(msg.model);
  const key = text(obj.requestId) || text(msg.id) || text(obj.uuid);
  const ts = Date.parse(text(obj.timestamp));
  if (!model || model.startsWith("<") || !key || !Number.isFinite(ts)) return null;
  const u = msg.usage;
  const written = count(u.cache_creation_input_tokens);
  const split: Obj = isObj(u.cache_creation) ? u.cache_creation : {};
  const cacheWrite1h = Math.min(count(split.ephemeral_1h_input_tokens), written);
  const usage: BurnUsage = {
    kind: "usage",
    key,
    ts,
    model,
    input: count(u.input_tokens),
    cacheWrite5m: written - cacheWrite1h,
    cacheWrite1h,
    cacheRead: count(u.cache_read_input_tokens),
    output: count(u.output_tokens),
  };
  const cwd = text(obj.cwd);
  return cwd ? { ...usage, cwd } : usage;
}

function titleOf(obj: Obj): BurnTitle | null {
  const custom = obj.type === "custom-title";
  if (!custom && obj.type !== "ai-title") return null;
  const title = text(custom ? obj.customTitle : obj.aiTitle).trim();
  return title ? { kind: "title", title, custom } : null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const maxTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: Math.max(a.input, b.input),
  cacheWrite5m: Math.max(a.cacheWrite5m, b.cacheWrite5m),
  cacheWrite1h: Math.max(a.cacheWrite1h, b.cacheWrite1h),
  cacheRead: Math.max(a.cacheRead, b.cacheRead),
  output: Math.max(a.output, b.output),
});

/** Requests deduped by key. Stored records are replaced, never mutated. */
export class BurnStore {
  private readonly byKey = new Map<string, BurnRecord>();

  get size(): number {
    return this.byKey.size;
  }

  /**
   * Add a request or fold a repeat into it (per-field max). A copy under another
   * session (resume/fork) moves the request there when its file is newer: the
   * newer file is the live continuation. True when the stored request changed.
   */
  upsert(rec: BurnRecord): boolean {
    const old = this.byKey.get(rec.key);
    if (!old) {
      this.byKey.set(rec.key, rec);
      return true;
    }
    const moved = rec.sessionId !== old.sessionId && rec.fileMtimeMs > old.fileMtimeMs;
    const next: BurnRecord = {
      ...(moved ? rec : old),
      ...maxTokens(old, rec),
      fileMtimeMs: Math.max(old.fileMtimeMs, rec.fileMtimeMs),
    };
    this.byKey.set(rec.key, next);
    return moved || TOKEN_FIELDS.some((f) => next[f] !== old[f]);
  }

  /** Drop requests older than `cutoffTs`. */
  prune(cutoffTs: number): void {
    for (const [key, r] of this.byKey) if (r.ts < cutoffTs) this.byKey.delete(key);
  }

  records(): IterableIterator<BurnRecord> {
    return this.byKey.values();
  }
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

interface SessionAcc {
  cost: number;
  rateCost: number;
  subCost: number;
  cacheWriteCost: number;
  requests: number;
  mainRequests: number;
  mainPrompt: number;
  lastTs: number;
  modelCost: Map<string, number>;
  tokens: BurnSessionStat["tokens"];
}

const newAcc = (): SessionAcc => ({
  cost: 0,
  rateCost: 0,
  subCost: 0,
  cacheWriteCost: 0,
  requests: 0,
  mainRequests: 0,
  mainPrompt: 0,
  lastTs: 0,
  modelCost: new Map(),
  tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
});

function addRecord(acc: SessionAcc, r: BurnRecord, inRate: boolean): void {
  const { total, cacheWrite } = costParts(r);
  const model = r.model.replace(/^claude-/, "");
  acc.cost += total;
  acc.rateCost += inRate ? total : 0;
  acc.subCost += r.sub ? total : 0;
  acc.cacheWriteCost += cacheWrite;
  acc.requests += 1;
  acc.mainRequests += r.sub ? 0 : 1;
  acc.mainPrompt += r.sub ? 0 : promptTokensOf(r);
  acc.lastTs = Math.max(acc.lastTs, r.ts);
  acc.modelCost.set(model, (acc.modelCost.get(model) ?? 0) + total);
  acc.tokens.input += r.input;
  acc.tokens.cacheWrite += r.cacheWrite5m + r.cacheWrite1h;
  acc.tokens.cacheRead += r.cacheRead;
  acc.tokens.output += r.output;
}

function toStat(sessionId: string, a: SessionAcc, totalCost: number, rateSpanMs: number): BurnSessionStat {
  return {
    sessionId,
    cost: a.cost,
    share: a.cost / totalCost,
    ratePerHour: rateSpanMs > 0 ? (a.rateCost * HOUR_MS) / rateSpanMs : 0,
    requests: a.requests,
    subShare: a.subCost / a.cost,
    cacheWriteShare: a.cacheWriteCost / a.cost,
    avgContext: a.mainRequests > 0 ? a.mainPrompt / a.mainRequests : 0,
    models: [...a.modelCost].sort((x, y) => y[1] - x[1]).map(([m]) => m),
    lastTs: a.lastTs,
    tokens: { ...a.tokens },
  };
}

/**
 * Rank sessions by list-price cost of the requests in (now - windowMs, now].
 * ratePerHour scales the cost of the last min(rateWindowMs, windowMs) to one hour.
 */
export function summarize(records: Iterable<BurnRecord>, now: number, windowMs: number, rateWindowMs = 300_000): BurnSummary {
  const rateSpanMs = Math.min(rateWindowMs, windowMs);
  const accs = new Map<string, SessionAcc>();
  for (const r of records) {
    if (r.ts <= now - windowMs || r.ts > now) continue;
    const acc = accs.get(r.sessionId) ?? newAcc();
    accs.set(r.sessionId, acc);
    addRecord(acc, r, r.ts > now - rateSpanMs);
  }
  const live = [...accs].filter(([, a]) => a.cost > 0);
  const totalCost = live.reduce((sum, [, a]) => sum + a.cost, 0);
  const sessions = live.map(([id, a]) => toStat(id, a, totalCost, rateSpanMs)).sort((x, y) => y.cost - x.cost);
  const totalRatePerHour = sessions.reduce((sum, s) => sum + s.ratePerHour, 0);
  return { windowMs, totalCost, totalRatePerHour, sessions };
}

const percent = (share: number): number => Math.round(share * 100);

/** Why a session burns: subagents, a big context, cache writes; each tag only past its threshold. */
export function driversOf(stat: BurnSessionStat): string[] {
  return [
    stat.subShare >= 0.5 ? `subagents ${percent(stat.subShare)}%` : "",
    stat.avgContext >= 300_000 ? `ctx ${Math.round(stat.avgContext / 1000)}K` : "",
    stat.cacheWriteShare >= 0.35 ? `cache writes ${percent(stat.cacheWriteShare)}%` : "",
  ].filter((tag) => tag !== "");
}

/**
 * The latest sample and the unbroken run before it (ascending): same account,
 * same window, no gap above `maxGapMs`. A sample of another account (a switch)
 * or another window ends the run.
 */
function latestRun(sorted: GaugeSample[], maxGapMs: number): GaugeSample[] {
  const target = sorted[sorted.length - 1];
  const run = [target];
  for (let i = sorted.length - 2; i >= 0; i--) {
    const s = sorted[i];
    const later = run[run.length - 1];
    if (s.acct !== target.acct || Math.abs(s.resetMs - target.resetMs) > SAME_WINDOW_MS) break;
    if (later.ts - s.ts > maxGapMs) break;
    run.push(s);
  }
  return run.reverse();
}

/**
 * Points of the 5-hour gauge per list-price USD for the account of the latest
 * sample: on its run (saturated samples at 100% dropped, they stop rising while
 * spending goes on elsewhere), the rise from the earliest sample at least
 * `minDeltaPct` points and `minSpanMs` before the latest one, over the cost
 * burned in between.
 */
export function calibrate(
  samples: GaugeSample[],
  records: Iterable<BurnRecord>,
  opts: { minDeltaPct?: number; minSpanMs?: number; maxGapMs?: number; sinceTs?: number } = {},
): BurnScale | null {
  const minDelta = opts.minDeltaPct ?? 3;
  const minSpan = opts.minSpanMs ?? 120_000;
  const since = opts.sinceTs ?? -Infinity;
  const sorted = samples.filter((s) => s.ts >= since).sort((x, y) => x.ts - y.ts);
  if (!sorted.length) return null;
  const run = latestRun(sorted, opts.maxGapMs ?? 600_000).filter((s) => s.pct < 100);
  if (!run.length) return null;
  const b = run[run.length - 1];
  const a = run.find((s) => b.pct - s.pct >= minDelta && b.ts - s.ts >= minSpan);
  if (!a) return null;
  let cost = 0;
  for (const r of records) if (r.ts > a.ts && r.ts <= b.ts) cost += costOf(r);
  if (!(cost > 0)) return null;
  return { ptsPerUsd: (b.pct - a.pct) / cost, spanMs: b.ts - a.ts, deltaPct: b.pct - a.pct, acct: b.acct };
}
