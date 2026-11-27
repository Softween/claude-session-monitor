// Login ownership (2026-11-27): a login is vaulted, moved or seeded under an
// account id only once api/oauth/profile named that account for that exact
// login. On 2026-11-26 an account switch that failed to roll back left the
// keychain on B's login while ~/.claude.json named A for 93 s: the settle window
// passed, B's login was vaulted under A (B's entries deleted) and seeded over A's
// claude-switch vault entry, and the keeper's refresh of it as A cost both
// accounts their login. A wait proves nothing about whose login it is; the
// profile does.
// Pure helpers first (unit-tested), the thin profile request last. Tokens are never logged.

import { tokenFingerprint } from "./capture";
import type { OAuthBlob } from "./rotation";

export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const PROFILE_TIMEOUT_MS = 8000; // as the usage poll

export type OwnerVerdict = "match" | "mismatch" | "unknown";

/** What the profile said about one login: the account uuid it named, or why it named none. */
export interface ProfileAnswer {
  uuid: string | null;
  reason?: string; // when uuid is null: "HTTP 429", "timeout", "network error", ...
}

/** A profile verdict other than "match", remembered so the same pair is not asked again before `until`. */
export interface OwnerHold {
  key: string; // ownerKey of the (account, refresh token) pair
  verdict: "mismatch" | "unknown";
  owner?: string; // the account the profile named (mismatch)
  until: number; // ms; Infinity = for good
}

export interface OwnerHoldMs {
  mismatch: number;
  unknown: number;
}

/** Capture: a login the profile gives to another account is asked about again after 5 min, an unanswered one after 60 s. */
export const CAPTURE_HOLDS: OwnerHoldMs = { mismatch: 5 * 60_000, unknown: 60_000 };
/** Seed: a refused login is never seeded (nor asked about) again, an unanswered one is asked again after 5 min. */
export const SEED_HOLDS: OwnerHoldMs = { mismatch: Infinity, unknown: 5 * 60_000 };

/** The key a verdict is kept under: account id + refresh token fingerprint (no token kept). A changed pair starts fresh. */
export function ownerKey(accountId: string, refreshToken: string | undefined): string {
  return `${accountId}|${tokenFingerprint(refreshToken) ?? "-"}`;
}

/** A login the profile can be asked about: an access token that has not expired (no expiry stored: the server decides). */
export function profileAskable(blob: OAuthBlob | null | undefined, nowMs: number): boolean {
  if (!blob?.accessToken) return false;
  return !(typeof blob.expiresAt === "number" && blob.expiresAt <= nowMs);
}

/** The account uuid a profile response names (`account.uuid`), or null. */
export function profileAccountUuid(body: unknown): string | null {
  const account = body && typeof body === "object" ? (body as { account?: unknown }).account : undefined;
  const uuid = account && typeof account === "object" ? (account as { uuid?: unknown }).uuid : undefined;
  return typeof uuid === "string" && uuid ? uuid : null;
}

/** The hold in force for `key` at `nowMs`, or null: while one is, the profile is not asked about that pair. */
export function heldFor(hold: OwnerHold | null | undefined, key: string, nowMs: number): OwnerHold | null {
  return hold && hold.key === key && nowMs < hold.until ? hold : null;
}

/**
 * What one profile answer means for a login about to be filed under
 * `expectedId`: the verdict, the hold it leaves (null on a match) and whether
 * to log it. A pair logs once per verdict: renewing the same hold stays quiet.
 */
export function judgeOwner(
  prev: OwnerHold | null | undefined,
  key: string,
  expectedId: string,
  answer: ProfileAnswer,
  nowMs: number,
  holds: OwnerHoldMs,
): { verdict: OwnerVerdict; hold: OwnerHold | null; log: boolean } {
  if (answer.uuid === expectedId) return { verdict: "match", hold: null, log: false };
  const verdict = answer.uuid === null ? "unknown" : "mismatch";
  const hold: OwnerHold = { key, verdict, ...(answer.uuid !== null ? { owner: answer.uuid } : {}), until: nowMs + holds[verdict] };
  return { verdict, hold, log: !(prev && prev.key === key && prev.verdict === verdict) };
}

export type ProfileFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** GET api/oauth/profile with the given headers (the usage poll's: bearer token, oauth beta, User-Agent). */
export async function fetchProfileAnswer(headers: Record<string, string>, fetchFn: ProfileFetch): Promise<ProfileAnswer> {
  try {
    const res = await fetchFn(PROFILE_URL, { headers, signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS) });
    if (!res.ok) return { uuid: null, reason: `HTTP ${res.status}` };
    const uuid = profileAccountUuid(await res.json());
    return uuid ? { uuid } : { uuid: null, reason: "no account in the answer" };
  } catch (e) {
    return { uuid: null, reason: (e as { name?: unknown })?.name === "TimeoutError" ? "timeout" : "network error" };
  }
}
