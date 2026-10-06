import { describe, expect, it } from "vitest";
import {
  buildKeychainPayload,
  parseRefreshResponse,
  pickBestAccount,
  shouldAutoRotate,
  type RotationAccount,
} from "../src/rotation";

const acct = (id: string, weekly: number | null, session: number | null, over: Partial<RotationAccount> = {}, resetW = 1000): RotationAccount => ({
  id,
  stale: false,
  gauges: [
    { key: "weekly", pct: weekly, resetMs: resetW },
    { key: "session", pct: session, resetMs: 500 },
  ],
  ...over,
});

describe("pickBestAccount", () => {
  it("ranks by the minimum remaining headroom", () => {
    const a = acct("a", 60, 10); // score 40
    const b = acct("b", 30, 50); // score 50
    expect(pickBestAccount([a, b])?.id).toBe("b");
  });
  it("excludes stale and data-less accounts", () => {
    const a = acct("a", 90, 90);
    const b = acct("b", 0, 0, { stale: true });
    const c = acct("c", null, null);
    expect(pickBestAccount([a, b, c])?.id).toBe("a");
    expect(pickBestAccount([b, c])).toBeUndefined();
  });
  it("breaks ties by the earliest reset of the most-used gauge", () => {
    const a = acct("a", 50, 10, {}, 5000);
    const b = acct("b", 50, 10, {}, 2000);
    expect(pickBestAccount([a, b])?.id).toBe("b");
  });
});

describe("shouldAutoRotate", () => {
  const cfg = { autoRotate: true, rotateAtPercent: 90 };
  const active = acct("a", 92, 10); // score 8
  const best = acct("b", 20, 10); // score 80
  const now = 10_000_000;
  it("rotates when over threshold, 20+ points better, and not debounced", () => {
    expect(shouldAutoRotate(active, best, cfg, now - 11 * 60_000, now)).toBe(true);
  });
  it("respects the disabled flag and threshold", () => {
    expect(shouldAutoRotate(active, best, { ...cfg, autoRotate: false }, 0, now)).toBe(false);
    expect(shouldAutoRotate(acct("a", 80, 10), best, cfg, 0, now)).toBe(false);
  });
  it("requires a 20-point margin", () => {
    expect(shouldAutoRotate(active, acct("b", 80, 10), cfg, 0, now)).toBe(false); // score 20 vs 8
    expect(shouldAutoRotate(active, acct("b", 72, 10), cfg, 0, now)).toBe(true); // score 28 vs 8
  });
  it("debounces to once per 10 minutes and ignores best == active", () => {
    expect(shouldAutoRotate(active, best, cfg, now - 5 * 60_000, now)).toBe(false);
    expect(shouldAutoRotate(active, active, cfg, 0, now)).toBe(false);
  });
});

describe("buildKeychainPayload", () => {
  it("replaces claudeAiOauth and preserves everything else", () => {
    const existing = JSON.stringify({ claudeAiOauth: { accessToken: "old" }, mcpOAuth: { srv: { t: 1 } }, mcpOAuthClientConfig: { c: 2 } });
    const out = JSON.parse(buildKeychainPayload(existing, { accessToken: "new", refreshToken: "r" }));
    expect(out.claudeAiOauth).toEqual({ accessToken: "new", refreshToken: "r" });
    expect(out.mcpOAuth).toEqual({ srv: { t: 1 } });
    expect(out.mcpOAuthClientConfig).toEqual({ c: 2 });
  });
  it("tolerates an unreadable existing payload", () => {
    expect(JSON.parse(buildKeychainPayload("not json", { accessToken: "x" }))).toEqual({ claudeAiOauth: { accessToken: "x" } });
  });
});

describe("parseRefreshResponse", () => {
  const prev = { accessToken: "old", refreshToken: "oldr", expiresAt: 1, subscriptionType: "max", scopes: ["a"] };
  it("maps expires_in to expiresAt ms and keeps untouched fields", () => {
    const out = parseRefreshResponse({ access_token: "n", refresh_token: "nr", expires_in: 3600, scope: "x y" }, prev, 1000);
    expect(out).toMatchObject({ accessToken: "n", refreshToken: "nr", expiresAt: 1000 + 3_600_000, subscriptionType: "max", scopes: ["x", "y"] });
  });
  it("keeps the old refresh token when none is returned", () => {
    expect(parseRefreshResponse({ access_token: "n", expires_in: 10 }, prev, 0)?.refreshToken).toBe("oldr");
  });
  it("rejects malformed responses", () => {
    expect(parseRefreshResponse({ expires_in: 10 }, prev, 0)).toBeUndefined();
    expect(parseRefreshResponse({ access_token: "n" }, prev, 0)).toBeUndefined();
    expect(parseRefreshResponse(null, prev, 0)).toBeUndefined();
  });
});
