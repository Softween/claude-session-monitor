// Limit resets: the gift resets ("cedar_ember" grants) Anthropic gives a Claude account,
// listed per account in the Usage Limits panel and spent one at a time on a click.
// Pure logic (no vscode import) so it stays unit-testable: fetch and the file lookups
// are injected. The resets ride along on the extension's own usage polls (usageRequest)
// and the last reading per account is kept on disk; claimReset spends a reset and the
// extension calls it only after the user's click and a modal confirm. Token values are
// never logged or returned.

import * as path from "path";

export type ResetKind = "fable" | "full" | "weekly" | "session";
/** Display order of the kinds. */
export const RESET_KINDS: readonly ResetKind[] = ["fable", "full", "weekly", "session"];
export const KIND_LABEL: Record<ResetKind, string> = {
  fable: "Fable reset",
  full: "Full reset",
  weekly: "Weekly reset",
  session: "5-hour reset",
};

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const claimUrl = (orgUuid: string): string => `https://api.anthropic.com/api/organizations/${orgUuid}/reset_rate_limits`;
const PROGRAM = "cedar_ember";
const CLAIM_TIMEOUT_MS = 25_000;
const GRANT_ID_RE = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ORG_UUID_RE = /^[0-9a-f-]{36}$/i;
const ACCOUNT_UUID_RE = /^[0-9a-f-]{36}$/i;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface ResetGrant {
  id: string;
  resetsLeft: number;
  endsAt: string | null; // ISO "use by"
  clears: string[]; // limit keys it refills: five_hour, seven_day, seven_day_overage_included, ...
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  type: "session" | "weekly" | "full" | null;
  givesBackWeekly: boolean;
  unavailableReason: string | null;
}

export interface CedarEmber {
  eligible: boolean;
  ineligibleReason: string | null;
  atLimit: boolean;
  grants: ResetGrant[];
  nextGrantId: string | null; // only when it names a listed grant
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);

function parseGrant(v: unknown): ResetGrant | null {
  if (!isObj(v) || typeof v.id !== "string" || !GRANT_ID_RE.test(v.id)) return null;
  const left = v.resets_left;
  if (typeof left !== "number" || !Number.isInteger(left) || left < 0) return null;
  return {
    id: v.id,
    resetsLeft: left,
    endsAt: str(v.ends_at),
    clears: strings(v.clears),
    paused: bool(v.paused, false),
    usableNow: bool(v.usable_now, false),
    useRequiresLimit: bool(v.use_requires_limit, true), // the CLI's default when the field is missing
    type: v.type === "session" || v.type === "weekly" || v.type === "full" ? v.type : null,
    givesBackWeekly: bool(v.gives_back_weekly, false),
    unavailableReason: str(v.unavailable_reason),
  };
}

/** The cedar_ember block of a usage response; null when it is missing or malformed. Malformed grants are dropped. */
export function parseCedarEmber(body: unknown): CedarEmber | null {
  const ce = isObj(body) ? body.cedar_ember : undefined;
  if (!isObj(ce) || typeof ce.eligible !== "boolean") return null;
  const grants = (Array.isArray(ce.grants) ? ce.grants : []).map(parseGrant).filter((g): g is ResetGrant => g !== null);
  const next = str(ce.next_grant_id);
  return {
    eligible: ce.eligible,
    ineligibleReason: str(ce.ineligible_reason),
    atLimit: ce.at_limit === true,
    grants,
    nextGrantId: next && grants.some((g) => g.id === next) ? next : null,
  };
}

/** The CLI's kind: a Fable give-back first, then the server's type, else from what it clears. */
export function grantKind(g: Pick<ResetGrant, "givesBackWeekly" | "type" | "clears">): ResetKind {
  if (g.givesBackWeekly) return "fable";
  if (g.type) return g.type;
  const five = g.clears.includes("five_hour");
  const other = g.clears.some((c) => c !== "five_hour");
  return five && !other ? "session" : other && !five ? "weekly" : "full";
}

const endsMs = (iso: string | null): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};
const expired = (g: ResetGrant, nowMs: number): boolean => {
  const t = endsMs(g.endsAt);
  return t !== null && t <= nowMs;
};

/** A reset a click may spend now: one left, not paused, usable now, not expired, and at a limit when it needs one. */
export function isUsable(g: ResetGrant, atLimit: boolean, nowMs: number): boolean {
  return g.resetsLeft > 0 && !g.paused && g.usableNow && !expired(g, nowMs) && !(g.useRequiresLimit && !atLimit);
}

// The CLI's wording for the reasons a reset cannot be used.
const REASONS: Record<string, string> = {
  needs_limit: "needs a limit hit first",
  cooldown: "cooling down, try again in a minute",
  blocked_five_hour: "can't be used while you're at your 5-hour limit",
  blocked_seven_day: "can't be used while you're at your weekly limit",
  blocked_opus: "can't be used while you're at your Opus limit",
  blocked_sonnet: "can't be used while you're at your Sonnet limit",
  blocked_other: "can't be used while you're at another limit it doesn't refill",
  cannot_clear: "doesn't refill the limit you've reached",
  not_next_grant: "another reset has to be used first",
};
export const reasonText = (reason: string): string => REASONS[reason] ?? reason.replace(/_/g, " ");

function whyNot(g: ResetGrant, atLimit: boolean): string {
  if (g.paused) return "paused";
  if (!g.usableNow) return g.unavailableReason ? reasonText(g.unavailableReason) : "not available right now";
  if (g.useRequiresLimit && !atLimit) return g.unavailableReason ? reasonText(g.unavailableReason) : "needs a limit hit first";
  return "not available right now";
}

/** The grant a click on `kind` spends: next_grant_id when it is a usable grant of that kind, else the first usable one in list order. */
export function pickGrant(status: CedarEmber, kind: ResetKind, nowMs: number): ResetGrant | null {
  if (!status.eligible) return null;
  const ok = (g: ResetGrant): boolean => grantKind(g) === kind && isUsable(g, status.atLimit, nowMs);
  const next = status.grants.find((g) => g.id === status.nextGrantId);
  return next && ok(next) ? next : status.grants.find(ok) ?? null;
}

const CLEARS: Record<string, string> = { five_hour: "5-hour limit", seven_day: "weekly limit", seven_day_overage_included: "Fable allowance" };
const GIVE_BACK = "gives back what Fable used on your weekly limit";

/** What using the reset refills, from its clears (unknown keys humanized). */
export function refillText(g: Pick<ResetGrant, "clears" | "givesBackWeekly">): string {
  const names = [...new Set(g.clears.map((c) => CLEARS[c] ?? `${c.replace(/[_-]+/g, " ").trim()} limit`))];
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
  if (!list) return g.givesBackWeekly ? `G${GIVE_BACK.slice(1)}` : "Refills your usage limits";
  return `Refills your ${list}${g.givesBackWeekly ? `, and ${GIVE_BACK}` : ""}`;
}

export interface KindSummary {
  kind: ResetKind;
  label: string;
  count: number; // resets left across the kind's grants that still hold one (unexpired)
  firstEndsAt: string | null; // the earliest "use by" among them
  usable: boolean;
  why?: string; // why none of them can be used now
  refill: string; // what a click refills (the grant it would spend, else the first one)
  grants: ResetGrant[];
}

/** One row per kind that holds a reset, ordered fable, full, weekly, session. */
export function summarize(status: CedarEmber, nowMs: number): KindSummary[] {
  if (!status.eligible) return [];
  const rows: KindSummary[] = [];
  for (const kind of RESET_KINDS) {
    const grants = status.grants.filter((g) => grantKind(g) === kind && g.resetsLeft > 0 && !expired(g, nowMs));
    if (!grants.length) continue;
    const pick = pickGrant(status, kind, nowMs);
    let first: { iso: string; ms: number } | null = null;
    for (const g of grants) {
      const ms = endsMs(g.endsAt);
      if (ms !== null && g.endsAt && (!first || ms < first.ms)) first = { iso: g.endsAt, ms };
    }
    rows.push({
      kind,
      label: KIND_LABEL[kind],
      count: grants.reduce((n, g) => n + g.resetsLeft, 0),
      firstEndsAt: first?.iso ?? null,
      usable: !!pick,
      ...(pick ? {} : { why: whyNot(grants[0], status.atLimit) }),
      refill: refillText(pick ?? grants[0]),
      grants,
    });
  }
  return rows;
}

/** The status with one grant's resets_left replaced (after a claim, until the next listing). */
export function withResetsLeft(status: CedarEmber, grantId: string, left: number): CedarEmber {
  return { ...status, grants: status.grants.map((g) => (g.id === grantId ? { ...g, resetsLeft: left } : g)) };
}

/** "11 Dec", or "9 Mar 2027" when the year differs from now's (local time); "" when unparsable. */
export function fmtUseBy(iso: string, nowMs: number): string {
  const ms = endsMs(iso);
  if (ms === null) return "";
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() !== new Date(nowMs).getFullYear() ? ` ${d.getFullYear()}` : ""}`;
}

/** "at 14:05" today, else "on 11 Dec at 14:05" (local time). */
function whenText(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.toDateString() === new Date(nowMs).toDateString() ? `at ${hhmm}` : `on ${fmtUseBy(d.toISOString(), nowMs)} at ${hhmm}`;
}

export interface CliLookup {
  home: string;
  readdir: (dir: string) => string[];
  realpath: (p: string) => string;
}

const cmpVersion = (a: string, b: string): number => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The installed Claude Code CLI version: the highest of ~/.local/share/claude/versions/, else the ~/.local/bin/claude link target; null when none. */
export function cliVersion(o: CliLookup): string | null {
  try {
    const versions = o.readdir(path.join(o.home, ".local", "share", "claude", "versions")).filter((n) => VERSION_RE.test(n));
    if (versions.length) return versions.reduce((a, b) => (cmpVersion(a, b) >= 0 ? a : b));
  } catch {
    /* no versions dir */
  }
  try {
    const name = path.basename(o.realpath(path.join(o.home, ".local", "bin", "claude")));
    if (VERSION_RE.test(name)) return name;
  } catch {
    /* no launcher link */
  }
  return null;
}

/** The User-Agent the server requires before it lists any grant; null when the CLI is not installed (no calls then). */
export function cliUserAgent(o: CliLookup): string | null {
  const v = cliVersion(o);
  return v ? `claude-cli/${v} (external, cli)` : null;
}

export interface ResetsResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type ResetsFetch = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<ResetsResponse>;

export type FailKind = "rate_limited" | "auth" | "error";

/**
 * The usage poll's request. With Limit resets on and the Claude Code CLI found it also asks for the
 * cedar_ember block, under the CLI's User-Agent (the only one the server lists resets for); nothing
 * reads the spend block, so skip_spend=1. Otherwise it is the plain request it always was, without a
 * User-Agent.
 */
export function usageRequest(token: string, resetsOn: boolean, ua: string | null): { url: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
  if (!resetsOn || !ua) return { url: USAGE_URL, headers };
  return { url: `${USAGE_URL}?cedar_ember=1&skip_spend=1`, headers: { ...headers, "User-Agent": ua } };
}

const apiHeaders = (token: string, ua: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
  "User-Agent": ua,
});

function httpFailure(res: ResetsResponse): { ok: false; kind: FailKind; httpStatus: number; retryAfterSec?: number } {
  if (res.status === 429) {
    const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
    return { ok: false, kind: "rate_limited", httpStatus: 429, ...(Number.isFinite(ra) ? { retryAfterSec: ra } : {}) };
  }
  return { ok: false, kind: res.status === 401 || res.status === 403 ? "auth" : "error", httpStatus: res.status };
}

async function readJson(res: ResetsResponse): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return undefined;
  }
}

export type ClaimResult = "reset" | "already_used" | "not_limited" | "cooldown" | "ineligible" | "unavailable";
const CLAIM_RESULTS: readonly string[] = ["reset", "already_used", "not_limited", "cooldown", "ineligible", "unavailable"];
export interface ClaimReply {
  result: ClaimResult;
  reason: string | null;
  resetsLeft: number | null;
  cleared: string[];
  cooldownUntil: string | null;
}
export type ClaimOutcome =
  | { ok: true; reply: ClaimReply }
  | { ok: false; kind: FailKind; httpStatus?: number; retryAfterSec?: number }
  | { ok: false; kind: "invalid"; field: "grant id" | "request id" | "organization id" };

/** A claim response body; null when it is not an object. An unknown result reads as "unavailable", as in the CLI. */
export function parseClaimReply(body: unknown): ClaimReply | null {
  if (!isObj(body)) return null;
  const left = body.resets_left;
  return {
    result: typeof body.result === "string" && CLAIM_RESULTS.includes(body.result) ? (body.result as ClaimResult) : "unavailable",
    reason: str(body.reason),
    resetsLeft: typeof left === "number" && Number.isInteger(left) && left >= 0 ? left : null,
    cleared: strings(body.cleared),
    cooldownUntil: str(body.cooldown_until),
  };
}

/** Spend one reset of a grant. Malformed ids are refused before anything is sent. */
export async function claimReset(
  token: string,
  orgUuid: string,
  grantId: string,
  requestId: string,
  ua: string,
  fetchFn: ResetsFetch,
): Promise<ClaimOutcome> {
  if (!GRANT_ID_RE.test(grantId)) return { ok: false, kind: "invalid", field: "grant id" };
  if (!REQUEST_ID_RE.test(requestId)) return { ok: false, kind: "invalid", field: "request id" };
  if (!ORG_UUID_RE.test(orgUuid)) return { ok: false, kind: "invalid", field: "organization id" };
  let res: ResetsResponse;
  try {
    res = await fetchFn(claimUrl(orgUuid), {
      method: "POST",
      headers: apiHeaders(token, ua),
      body: JSON.stringify({ program: PROGRAM, grant_id: grantId, request_id: requestId }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: "error" }; // network error or timeout
  }
  if (!res.ok) return httpFailure(res);
  const reply = parseClaimReply(await readJson(res));
  return reply ? { ok: true, reply } : { ok: false, kind: "error", httpStatus: res.status };
}

/** True when the server may or may not have spent the reset (unavailable, network error, timeout, 5xx, unreadable 2xx): the next try on that grant reuses the request id. */
export function claimUnresolved(o: ClaimOutcome): boolean {
  if (o.ok) return o.reply.result === "unavailable";
  if (o.kind !== "error") return false;
  return o.httpStatus === undefined || o.httpStatus >= 500 || o.httpStatus < 300;
}

const SAFE_RETRY = "Trying again is safe: it repeats the same request.";

/** One user-facing sentence for a claim outcome. */
export function describeClaim(o: ClaimOutcome, label: string, email: string, nowMs: number): string {
  if (!o.ok) {
    if (o.kind === "invalid") return `The ${label} was not used: its ${o.field} looks malformed, so nothing was sent.`;
    if (o.kind === "rate_limited") return `Anthropic rate-limited the request; try again ${o.retryAfterSec ? `in ${o.retryAfterSec} s` : "in a few minutes"}.`;
    if (o.kind === "auth") return `The token for ${email} was rejected (HTTP ${o.httpStatus ?? "?"}); the ${label} was not used.`;
    if (o.httpStatus !== undefined && o.httpStatus >= 400 && o.httpStatus < 500) return `The server refused the ${label} on ${email} (HTTP ${o.httpStatus}).`;
    return `No clear answer from Anthropic${o.httpStatus ? ` (HTTP ${o.httpStatus})` : ""}: the ${label} on ${email} may or may not have been used. ${SAFE_RETRY}`;
  }
  const r = o.reply;
  const why = r.reason ? ` (${reasonText(r.reason)})` : "";
  switch (r.result) {
    case "reset":
      return `${label} used on ${email}.`;
    case "already_used":
      return "That reset was already used.";
    case "not_limited":
      return `${email} is not at a limit right now, so the server kept the reset.`;
    case "cooldown": {
      const until = endsMs(r.cooldownUntil);
      return `The ${label} on ${email} is cooling down; available again ${until !== null ? whenText(until, nowMs) : "shortly"}.`;
    }
    case "ineligible":
      return `${email} is not eligible for limit resets${why}.`;
    case "unavailable":
      return `The ${label} on ${email} is not available right now${why}. ${SAFE_RETRY}`;
  }
}

/** The last known resets of one account: the cedar_ember block of its newest usage reading. */
export interface ResetsEntry {
  ts: number; // epoch seconds of that reading
  status: CedarEmber;
}

/** How an account's latest usage poll failed; its resets stay at the last reading meanwhile. */
export interface UsageFail {
  kind: "rate_limited" | "auth";
  httpStatus?: number;
}

/** A status in the server's wire shape, so a stored file is read back through parseCedarEmber. */
function toWire(s: CedarEmber): Record<string, unknown> {
  return {
    eligible: s.eligible,
    ineligible_reason: s.ineligibleReason,
    at_limit: s.atLimit,
    next_grant_id: s.nextGrantId,
    grants: s.grants.map((g) => ({
      id: g.id,
      resets_left: g.resetsLeft,
      ends_at: g.endsAt,
      clears: g.clears,
      paused: g.paused,
      usable_now: g.usableNow,
      use_requires_limit: g.useRequiresLimit,
      type: g.type,
      gives_back_weekly: g.givesBackWeekly,
      unavailable_reason: g.unavailableReason,
    })),
  };
}

/** `<dir>/resets-<accountUuid>.json`, or null when the id is not a plain uuid (no path escape). */
export function resetsFilePath(dir: string, accountId: string): string | null {
  return ACCOUNT_UUID_RE.test(accountId) ? path.join(dir, `resets-${accountId}.json`) : null;
}

/** The stored file: `{ts, status}`, status in the server's cedar_ember shape. */
export function resetsFileText(e: ResetsEntry): string {
  return JSON.stringify({ ts: e.ts, status: toWire(e.status) });
}

const jsonOf = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** A stored file read back and validated like a fresh response; null when it is malformed. */
export function parseResetsFile(text: string): ResetsEntry | null {
  const v = jsonOf(text);
  if (!isObj(v) || typeof v.ts !== "number" || !Number.isFinite(v.ts) || v.ts <= 0) return null;
  const status = parseCedarEmber({ cedar_ember: v.status });
  return status ? { ts: v.ts, status } : null;
}

export type ResetsState = "ok" | "ineligible" | "waiting"; // waiting: no reading with resets yet
export interface ResetsKindView {
  kind: ResetKind;
  label: string;
  count: number;
  until: string; // fmtUseBy of the first expiry ("" when none)
  tip: string; // what it refills
  usable: boolean;
  why?: string;
}
export interface ResetsAccountView {
  atLimit: boolean;
  state: ResetsState;
  ts: number | null; // epoch seconds of the reading the rows come from: the webview shows "as of" once it is old
  note?: string;
  kinds: ResetsKindView[]; // from the last known reading, also while the latest poll fails
}

const failText = (f: UsageFail): string => (f.kind === "rate_limited" ? "usage API rate-limited" : `token rejected${f.httpStatus ? ` (HTTP ${f.httpStatus})` : ""}`);

/** The panel's view of one account: rows from its last known reading, and why its latest usage poll failed. */
export function accountView(e: ResetsEntry | undefined, fail: UsageFail | undefined, nowMs: number): ResetsAccountView {
  const failNote = fail ? failText(fail) : undefined;
  if (!e) return { atLimit: false, state: "waiting", ts: null, note: ["waiting for the next usage reading", failNote].filter((n): n is string => !!n).join(" · "), kinds: [] };
  const s = e.status;
  const kinds: ResetsKindView[] = summarize(s, nowMs).map((r) => ({
    kind: r.kind,
    label: r.label,
    count: r.count,
    until: r.firstEndsAt ? fmtUseBy(r.firstEndsAt, nowMs) : "",
    tip: r.refill,
    usable: r.usable,
    ...(r.why ? { why: r.why } : {}),
  }));
  const ineligible = s.eligible ? undefined : `not eligible${s.ineligibleReason ? ` (${reasonText(s.ineligibleReason)})` : ""}`;
  const notes = [ineligible, failNote].filter((n): n is string => !!n);
  return { atLimit: s.atLimit, state: s.eligible ? "ok" : "ineligible", ts: e.ts, ...(notes.length ? { note: notes.join(" · ") } : {}), kinds };
}

/** The section header's N: resets left across every account with a known reading; null until one has one. */
export function resetsTotal(entries: (ResetsEntry | undefined)[], nowMs: number): number | null {
  let total: number | null = null;
  for (const e of entries) if (e) total = (total ?? 0) + summarize(e.status, nowMs).reduce((n, r) => n + r.count, 0);
  return total;
}

/** The Limit resets section of the Usage Limits payload. */
export interface ResetsPayload {
  total: number | null; // null until any account has a known reading
  cliMissing?: boolean;
  accounts: ({ id: string; name: string; email: string; active: boolean } & ResetsAccountView)[];
  done?: { at: number } | null; // the last finished Use click (at = its click time)
}
