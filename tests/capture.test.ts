import { describe, expect, it } from "vitest";
import {
  CAPTURE_MOVE_SETTLE_MS,
  classifyIdentityChange,
  classifyRefreshFailure,
  decideCapture,
  refreshBlocked,
  settleCapture,
  tokenFingerprint,
  withoutNeedsLogin,
} from "../src/capture";
import { upsertActiveAccount } from "../src/core";
import { refreshOAuth, type FetchLike, type OAuthBlob } from "../src/rotation";

const blob = (over: Partial<OAuthBlob> = {}): OAuthBlob => ({
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: 1_000,
  subscriptionType: "max",
  ...over,
});
const ident = { id: "uuid-a", email: "a@example.com" };

describe("decideCapture", () => {
  it("stores when nothing is vaulted yet", () => {
    expect(decideCapture({ identity: ident, keychain: blob(), vaulted: null })).toBe("store");
  });
  it("skips when the vaulted blob matches the keychain", () => {
    expect(decideCapture({ identity: ident, keychain: blob(), vaulted: blob() })).toBe("skip");
  });
  it("stores when the refresh token changed", () => {
    expect(decideCapture({ identity: ident, keychain: blob({ refreshToken: "rt-2" }), vaulted: blob() })).toBe("store");
  });
  it("stores when the access token or expiry changed", () => {
    expect(decideCapture({ identity: ident, keychain: blob({ accessToken: "at-2" }), vaulted: blob() })).toBe("store");
    expect(decideCapture({ identity: ident, keychain: blob({ expiresAt: 2_000 }), vaulted: blob() })).toBe("store");
  });
  it("skips the unknown 'default' identity", () => {
    expect(decideCapture({ identity: { id: "default", email: "x@example.com" }, keychain: blob(), vaulted: null })).toBe("skip");
  });
  it("skips when the identity has no email", () => {
    expect(decideCapture({ identity: { id: "uuid-a" }, keychain: blob(), vaulted: null })).toBe("skip");
  });
  it("skips without an identity or a keychain blob", () => {
    expect(decideCapture({ identity: null, keychain: blob(), vaulted: null })).toBe("skip");
    expect(decideCapture({ identity: ident, keychain: null, vaulted: null })).toBe("skip");
  });
});

describe("classifyRefreshFailure", () => {
  it("400 invalid_grant is permanent", () => {
    expect(classifyRefreshFailure(400, '{"error":"invalid_grant"}')).toBe("permanent");
  });
  it("401 with the OAuth JSON invalid_grant error is permanent", () => {
    expect(classifyRefreshFailure(401, '{"error": "invalid_grant", "error_description": "Refresh token not found"}')).toBe("permanent");
  });
  it("a bare 'revoked' or invalid_client is transient (client-id / gateway problem, not a dead token)", () => {
    expect(classifyRefreshFailure(401, '{"error":"token revoked"}')).toBe("transient");
    expect(classifyRefreshFailure(400, '{"error":"invalid_client"}')).toBe("transient");
  });
  it("429 is transient", () => {
    expect(classifyRefreshFailure(429, '{"error":"invalid_grant"}')).toBe("transient");
  });
  it("503 is transient", () => {
    expect(classifyRefreshFailure(503, "upstream unavailable")).toBe("transient");
  });
  it("no status (timeout / network) is transient", () => {
    expect(classifyRefreshFailure(null, "")).toBe("transient");
  });
  it("400 without a grant error is transient", () => {
    expect(classifyRefreshFailure(400, '{"error":"invalid_request"}')).toBe("transient");
  });
});

describe("refreshOAuth result", () => {
  const respond =
    (status: number, body: unknown): FetchLike =>
    async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });

  it("returns the refreshed blob on success", async () => {
    const r = await refreshOAuth(blob(), respond(200, { access_token: "at-9", expires_in: 3600 }), 0);
    expect(r.ok && r.blob.accessToken).toBe("at-9");
  });
  it("flags invalid_grant as permanent with status and a token-free snippet", async () => {
    const r = await refreshOAuth(blob(), respond(400, { error: "invalid_grant", hint: "sk-ant-ort01-secret" }), 0);
    expect(r).toMatchObject({ ok: false, permanent: true, status: 400 });
    expect(!r.ok && r.snippet).not.toContain("sk-ant-ort01-secret");
  });
  it("masks any opaque 24+ char run echoed in an error body", async () => {
    const opaque = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    const r = await refreshOAuth(blob(), respond(400, { error: "invalid_grant", token: opaque }), 0);
    expect(!r.ok && r.snippet).not.toContain(opaque);
    expect(!r.ok && r.snippet).toContain("invalid_grant");
  });
  it("treats 429 and network errors as transient", async () => {
    expect(await refreshOAuth(blob(), respond(429, "slow down"), 0)).toMatchObject({ ok: false, permanent: false, status: 429 });
    const boom: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await refreshOAuth(blob(), boom, 0)).toMatchObject({ ok: false, permanent: false, status: null });
  });
});

describe("upsertActiveAccount", () => {
  it("clears needsLogin when the account is captured again", () => {
    const f = { v: 1 as const, accounts: [{ id: "uuid-a", email: "a@example.com", lastSeenTs: 1, needsLogin: true }] };
    const next = upsertActiveAccount(f, { id: "uuid-a", email: "a@example.com", tokenExpiresAt: 5 }, 2);
    expect(next.accounts[0].needsLogin).toBeUndefined();
    expect(next.accounts[0].tokenExpiresAt).toBe(5);
  });
});

describe("settleCapture", () => {
  const pair = { accountUuid: "uuid-a", refreshToken: "rt-1" };

  it("waits on the first sighting and remembers the pair", () => {
    expect(settleCapture(null, pair, 10_000)).toEqual({ action: "wait", pending: { ...pair, observedAt: 10_000, holdMs: 3_000 } });
  });
  it("stores when the same pair is seen again 3 s later, clearing pending", () => {
    const first = settleCapture(null, pair, 10_000);
    expect(settleCapture(first.pending, pair, 13_000)).toEqual({ action: "store", pending: null });
  });
  it("keeps waiting (same first-sighting time) when the same pair is seen after only 1 s", () => {
    const first = settleCapture(null, pair, 10_000);
    expect(settleCapture(first.pending, pair, 11_000)).toEqual({ action: "wait", pending: { ...pair, observedAt: 10_000, holdMs: 3_000 } });
  });
  it("restarts the window when the account or the refresh token changed", () => {
    const first = settleCapture(null, pair, 10_000);
    const otherAcct = { accountUuid: "uuid-b", refreshToken: "rt-1" };
    expect(settleCapture(first.pending, otherAcct, 14_000)).toEqual({ action: "wait", pending: { ...otherAcct, observedAt: 14_000, holdMs: 3_000 } });
    const otherToken = { accountUuid: "uuid-a", refreshToken: "rt-2" };
    expect(settleCapture(first.pending, otherToken, 14_000)).toEqual({ action: "wait", pending: { ...otherToken, observedAt: 14_000, holdMs: 3_000 } });
  });
  it("after a store the next sighting starts a fresh window", () => {
    const stored = settleCapture(settleCapture(null, pair, 0).pending, pair, 5_000);
    expect(stored.action).toBe("store");
    expect(settleCapture(stored.pending, pair, 6_000)).toEqual({ action: "wait", pending: { ...pair, observedAt: 6_000, holdMs: 3_000 } });
  });
  it("a move (token vaulted under another id) still waits at 5 s, keeping the first-seen time", () => {
    const first = settleCapture(null, pair, 0);
    const at5 = settleCapture(first.pending, pair, 5_000, CAPTURE_MOVE_SETTLE_MS);
    expect(at5).toEqual({ action: "wait", pending: { ...pair, observedAt: 0, holdMs: 30_000 } });
  });
  it("a move stores once the same pair held for 30 s (seen again at 31 s)", () => {
    const at5 = settleCapture(settleCapture(null, pair, 0, CAPTURE_MOVE_SETTLE_MS).pending, pair, 5_000, CAPTURE_MOVE_SETTLE_MS);
    expect(settleCapture(at5.pending, pair, 31_000, CAPTURE_MOVE_SETTLE_MS)).toEqual({ action: "store", pending: null });
  });
});

describe("classifyIdentityChange", () => {
  const block = { accountUuid: "uuid-a", emailAddress: "a@example.com", profileFetchedAt: 1 };
  const ident = (b: Record<string, unknown>) => ({ id: String(b.accountUuid), block: b });

  it("an unrelated ~/.claude.json rewrite (same oauthAccount, other key order) is no change", () => {
    const reordered = { profileFetchedAt: 1, emailAddress: "a@example.com", accountUuid: "uuid-a" };
    expect(classifyIdentityChange(ident(block), ident(reordered))).toBe("none");
  });
  it("a different account is an account change", () => {
    expect(classifyIdentityChange(ident(block), ident({ ...block, accountUuid: "uuid-b" }))).toBe("account");
    expect(classifyIdentityChange(undefined, ident(block))).toBe("account");
  });
  it("an edited oauthAccount of the same account is a block change", () => {
    expect(classifyIdentityChange(ident(block), ident({ ...block, profileFetchedAt: 2 }))).toBe("block");
  });
});

describe("needsLogin flag", () => {
  const flagged = { needsLogin: true, needsLoginFp: tokenFingerprint("rt-1") };

  it("fingerprints are short hex and never the token", () => {
    expect(tokenFingerprint("rt-1")).toMatch(/^[0-9a-f]{12}$/);
    expect(tokenFingerprint(undefined)).toBeUndefined();
  });
  it("blocks refresh only while the vault still holds the rejected token", () => {
    expect(refreshBlocked(flagged, "rt-1")).toBe(true);
    expect(refreshBlocked(flagged, "rt-2")).toBe(false);
    expect(refreshBlocked({}, "rt-1")).toBe(false);
  });
  it("withoutNeedsLogin drops both flag fields and keeps the rest", () => {
    expect(withoutNeedsLogin({ id: "a", ...flagged })).toEqual({ id: "a" });
  });
});
