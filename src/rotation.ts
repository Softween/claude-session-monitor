// Account rotation: pure logic (no vscode imports) so it is unit-testable.
// Claude Code owns the ACTIVE login (keychain item "Claude Code-credentials" +
// ~/.claude.json oauthAccount). The extension vaults a snapshot of every login
// it has seen, keeps the inactive ones alive by refreshing their tokens, and can
// swap the active login by rewriting those two places.

export const KEYCHAIN_SERVICE = "Claude Code-credentials";
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

export const REFRESH_MARGIN_MS = 5 * 60_000; // background refresh when this close to expiry
export const SWITCH_REFRESH_MARGIN_MS = 2 * 60_000; // refresh the target before a switch
export const AUTO_ROTATE_DEBOUNCE_MS = 10 * 60_000;
export const AUTO_ROTATE_MARGIN_POINTS = 20;

export type OAuthBlob = Record<string, unknown> & {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
};

export interface RotationAccount {
  id: string;
  stale: boolean;
  gauges: { key: string; pct: number | null; resetMs: number | null }[];
}

export const vaultOauthKey = (id: string): string => `csm.oauth.${id}`;
export const vaultIdentKey = (id: string): string => `csm.ident.${id}`;

/** Lowest remaining headroom (100 - pct) across the account's gauges; null when it has no data. */
export function accountScore(a: Pick<RotationAccount, "gauges">): number | null {
  const pcts = a.gauges.map((g) => g.pct).filter((p): p is number => typeof p === "number" && Number.isFinite(p));
  if (!pcts.length) return null;
  return Math.min(...pcts.map((p) => 100 - p));
}

/** Reset time of the account's most-used gauge (the one that limits it); Infinity when unknown. */
function limitingReset(a: Pick<RotationAccount, "gauges">): number {
  let best: { pct: number; resetMs: number | null } | undefined;
  for (const g of a.gauges) {
    if (typeof g.pct !== "number") continue;
    if (!best || g.pct > best.pct) best = { pct: g.pct, resetMs: g.resetMs };
  }
  return best?.resetMs ?? Infinity;
}

/** Highest score wins (stale / no-data accounts excluded); tie -> earliest reset of its most-used gauge. */
export function pickBestAccount<T extends RotationAccount>(views: T[]): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const v of views) {
    if (v.stale) continue;
    const s = accountScore(v);
    if (s == null) continue;
    if (best === undefined || s > bestScore || (s === bestScore && limitingReset(v) < limitingReset(best))) {
      best = v;
      bestScore = s;
    }
  }
  return best;
}

export interface AutoRotateCfg {
  autoRotate: boolean;
  rotateAtPercent: number;
}

/** Auto-rotate only when the active account is nearly spent, a clearly better one exists, and not within 10 min of the last switch. */
export function shouldAutoRotate(
  active: RotationAccount | undefined,
  best: RotationAccount | undefined,
  cfg: AutoRotateCfg,
  lastSwitchTs: number,
  now: number,
): boolean {
  if (!cfg.autoRotate || !active || !best || best.id === active.id) return false;
  const activeScore = accountScore(active);
  const bestScore = accountScore(best);
  if (activeScore == null || bestScore == null) return false;
  if (100 - activeScore < cfg.rotateAtPercent) return false;
  if (bestScore - activeScore < AUTO_ROTATE_MARGIN_POINTS) return false;
  return now - lastSwitchTs >= AUTO_ROTATE_DEBOUNCE_MS;
}

/** "weekly 37% · session 6% left" — remaining headroom for the two main windows. */
export function remainingSummary(gauges: { key: string; pct: number | null }[]): string {
  const parts: string[] = [];
  for (const key of ["weekly", "session"]) {
    const g = gauges.find((x) => x.key === key);
    if (g && typeof g.pct === "number") parts.push(`${key} ${Math.max(0, Math.round(100 - g.pct))}%`);
  }
  return parts.length ? `${parts.join(" · ")} left` : "no usage data yet";
}

/** Keychain JSON with only claudeAiOauth replaced (mcpOAuth etc. preserved). */
export function buildKeychainPayload(existingJson: string, newOauth: OAuthBlob): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(existingJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
  } catch {
    /* unreadable existing item: write a fresh payload */
  }
  return JSON.stringify({ ...base, claudeAiOauth: newOauth });
}

export function needsRefresh(oauth: OAuthBlob, nowMs: number, marginMs: number): boolean {
  return typeof oauth.expiresAt !== "number" || oauth.expiresAt - nowMs <= marginMs;
}

/** Map a token-endpoint response onto the stored oauth blob; undefined when it has no access token. */
export function parseRefreshResponse(body: unknown, prev: OAuthBlob, nowMs: number): OAuthBlob | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.access_token !== "string" || !b.access_token) return undefined;
  if (typeof b.expires_in !== "number" || !Number.isFinite(b.expires_in)) return undefined;
  const next: OAuthBlob = {
    ...prev,
    accessToken: b.access_token,
    refreshToken: typeof b.refresh_token === "string" && b.refresh_token ? b.refresh_token : prev.refreshToken,
    expiresAt: nowMs + b.expires_in * 1000,
  };
  if (typeof b.scope === "string" && b.scope.trim()) next.scopes = b.scope.trim().split(/\s+/);
  if (typeof b.refresh_token_expires_in === "number" && Number.isFinite(b.refresh_token_expires_in)) {
    next.refreshTokenExpiresAt = nowMs + b.refresh_token_expires_in * 1000;
  }
  return next;
}

export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

/** Refresh an oauth blob the way the Claude CLI does: JSON POST with client_id and the granted scopes. */
export async function refreshOAuth(oauth: OAuthBlob, fetchFn: FetchLike, nowMs: number): Promise<OAuthBlob | undefined> {
  if (!oauth.refreshToken) return undefined;
  const body: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: OAUTH_CLIENT_ID,
  };
  if (Array.isArray(oauth.scopes) && oauth.scopes.length) body.scope = oauth.scopes.join(" ");
  try {
    const res = await fetchFn(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return undefined;
    return parseRefreshResponse(await res.json(), oauth, nowMs);
  } catch {
    return undefined;
  }
}

export function parseJsonObject(s: string | undefined): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface SwitchDeps {
  readKeychain(): Promise<string | undefined>;
  writeKeychain(json: string): Promise<void>;
  getSecret(key: string): Promise<string | undefined>;
  setSecret(key: string, value: string): Promise<void>;
  readClaudeJson(): Promise<string | undefined>;
  writeClaudeJson(text: string): Promise<void>; // must be atomic (temp file + rename)
  fetchFn: FetchLike;
  now(): number;
}

export type SwitchResult =
  | { ok: true; email: string; refreshed?: OAuthBlob }
  | { ok: false; error: string };

/**
 * Swap the active Claude Code login. Steps: snapshot the current login into the
 * vault, load the target, refresh it when about to expire, rewrite the keychain
 * (only claudeAiOauth) and ~/.claude.json (only oauthAccount).
 */
export async function performSwitch(deps: SwitchDeps, targetId: string, targetEmail: string): Promise<SwitchResult> {
  const kcRaw = await deps.readKeychain();
  const kc = parseJsonObject(kcRaw);
  const claudeJsonRaw = await deps.readClaudeJson();
  const claudeJson = parseJsonObject(claudeJsonRaw);
  if (!kcRaw || !kc || !claudeJsonRaw || !claudeJson) return { ok: false, error: "could not read the current Claude Code login" };

  // 1) snapshot the current active login so it can be switched back to.
  const curOauth = kc.claudeAiOauth;
  const curIdent = claudeJson.oauthAccount as Record<string, unknown> | undefined;
  const curId = curIdent && typeof curIdent.accountUuid === "string" ? curIdent.accountUuid : undefined;
  if (curId && curOauth && typeof curOauth === "object" && curIdent) {
    await deps.setSecret(vaultOauthKey(curId), JSON.stringify(curOauth));
    await deps.setSecret(vaultIdentKey(curId), JSON.stringify(curIdent));
  }
  if (curId === targetId) return { ok: true, email: targetEmail };

  // 2) load the target.
  const tOauth = parseJsonObject(await deps.getSecret(vaultOauthKey(targetId))) as OAuthBlob | undefined;
  const tIdent = parseJsonObject(await deps.getSecret(vaultIdentKey(targetId)));
  if (!tOauth || !tIdent || !tOauth.accessToken) {
    return { ok: false, error: "Log in once with this account so its token is captured" };
  }

  // 3) refresh when about to expire.
  let oauth = tOauth;
  let refreshed: OAuthBlob | undefined;
  if (needsRefresh(tOauth, deps.now(), SWITCH_REFRESH_MARGIN_MS)) {
    refreshed = await refreshOAuth(tOauth, deps.fetchFn, deps.now());
    if (!refreshed) return { ok: false, error: "this account's token expired and could not be refreshed — run /login with it" };
    oauth = refreshed;
    await deps.setSecret(vaultOauthKey(targetId), JSON.stringify(oauth));
  }

  // 4) keychain, then 5) ~/.claude.json.
  await deps.writeKeychain(buildKeychainPayload(kcRaw, oauth));
  await deps.writeClaudeJson(JSON.stringify({ ...claudeJson, oauthAccount: tIdent }, null, 2));
  return { ok: true, email: typeof tIdent.emailAddress === "string" ? tIdent.emailAddress : targetEmail, refreshed };
}
