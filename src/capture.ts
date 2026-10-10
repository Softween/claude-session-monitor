// Login capture: pure logic (no vscode imports) so it is unit-testable.
// The extension vaults every Claude Code login it sees as the active one; these
// helpers decide when the keychain blob is worth (re)storing and whether a
// failed background token refresh can ever recover without a new login.

import { createHash } from "crypto";
import type { OAuthBlob } from "./rotation";

export interface CaptureInput {
  identity: { id: string; email?: string } | null;
  keychain: OAuthBlob | null;
  vaulted: OAuthBlob | null;
}

/** "store" when the active login has a real identity and its keychain blob differs from the vaulted one. */
export function decideCapture(input: CaptureInput): "store" | "skip" {
  const { identity, keychain, vaulted } = input;
  if (!identity || !identity.id || identity.id === "default" || !identity.email || !keychain) return "skip";
  if (!vaulted) return "store";
  const changed =
    vaulted.refreshToken !== keychain.refreshToken ||
    vaulted.accessToken !== keychain.accessToken ||
    vaulted.expiresAt !== keychain.expiresAt;
  return changed ? "store" : "skip";
}

/**
 * "permanent" only for invalid_grant (plain text or the OAuth JSON error) on a
 * 400/401/403: the refresh token itself is dead. invalid_client, other 4xx,
 * rate limits, 5xx and network errors are transient (a client-id or gateway
 * problem must not flag every account).
 */
export function classifyRefreshFailure(status: number | null, body: string): "permanent" | "transient" {
  if (status !== 400 && status !== 401 && status !== 403) return "transient";
  return /invalid_grant/.test(body) ? "permanent" : "transient";
}

/** Short one-way fingerprint of a token, so the registry can say WHICH token was rejected without storing it. */
export function tokenFingerprint(token: string | undefined): string | undefined {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 12) : undefined;
}

export interface NeedsLoginFlag {
  needsLogin?: boolean;
  needsLoginFp?: string; // tokenFingerprint of the refresh token that was rejected
}

/** A needsLogin account stays blocked only while its vault still holds the rejected refresh token. */
export function refreshBlocked(entry: NeedsLoginFlag, vaultRefreshToken: string | undefined): boolean {
  if (entry.needsLogin !== true) return false;
  if (!entry.needsLoginFp) return true;
  return tokenFingerprint(vaultRefreshToken) === entry.needsLoginFp;
}

/** The entry without its needsLogin flag (a refresh succeeded or the vault moved past the rejected token). */
export function withoutNeedsLogin<T extends NeedsLoginFlag>(entry: T): Omit<T, "needsLogin" | "needsLoginFp"> {
  const { needsLogin: _n, needsLoginFp: _f, ...rest } = entry;
  return rest;
}

/** Order-independent serialization of an oauthAccount block. */
function identityKey(block: Record<string, unknown> | undefined): string {
  return block ? JSON.stringify(Object.keys(block).sort().map((k) => [k, block[k]])) : "";
}

/**
 * What a re-parsed ~/.claude.json means for capture: "account" (a different
 * login), "block" (same account, oauthAccount edited, e.g. a re-login) or
 * "none" (Claude Code rewrote unrelated state, which it does every few seconds).
 */
export function classifyIdentityChange(
  prev: { id: string; block?: Record<string, unknown> } | undefined,
  next: { id: string; block?: Record<string, unknown> } | undefined,
): "account" | "block" | "none" {
  if (prev?.id !== next?.id) return "account";
  return identityKey(prev?.block) !== identityKey(next?.block) ? "block" : "none";
}

export const CAPTURE_SETTLE_MS = 3000;
export const CAPTURE_MOVE_SETTLE_MS = 30_000; // the token is vaulted under ANOTHER id: moving it needs a longer proof

/** One fresh read of the active login: ~/.claude.json account + keychain refresh token. */
export interface Observation {
  accountUuid: string;
  refreshToken?: string;
}

export interface PendingCapture extends Observation {
  observedAt: number; // ms of the first sighting of this exact pair
  holdMs: number; // window the latest observation required (3 s, or 30 s for a move)
}

/**
 * Settle rule: Claude Code writes the keychain and ~/.claude.json separately, in
 * either order, so a changed login is stored only once the SAME (account,
 * refresh token) pair is seen again at least `minMs` after its first sighting.
 * A different pair restarts the window; a grown `minMs` (a move became pending)
 * keeps the pair's original first-seen time.
 */
export function settleCapture(
  prev: PendingCapture | null,
  now: Observation,
  nowMs: number,
  minMs = CAPTURE_SETTLE_MS,
): { action: "wait" | "store"; pending: PendingCapture | null } {
  if (!prev || prev.accountUuid !== now.accountUuid || prev.refreshToken !== now.refreshToken) {
    const pending = { accountUuid: now.accountUuid, refreshToken: now.refreshToken, observedAt: nowMs, holdMs: minMs };
    return { action: "wait", pending };
  }
  if (nowMs - prev.observedAt < minMs) return { action: "wait", pending: { ...prev, holdMs: minMs } };
  return { action: "store", pending: null };
}
