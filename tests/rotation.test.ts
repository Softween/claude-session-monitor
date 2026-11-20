import { describe, expect, it } from "vitest";
import {
  buildKeychainPayload,
  parseRefreshResponse,
  performSwitch,
  pickBestAccount,
  shouldAutoRotate,
  vaultIdentKey,
  vaultOauthKey,
  type RotationAccount,
  type SwitchDeps,
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
  it("skips accounts claude-switch excludes (the skip box), even with the most headroom", () => {
    const a = acct("a", 60, 10); // score 40
    const b = acct("b", 0, 0, { excluded: true }); // score 100, skipped
    expect(pickBestAccount([a, b])?.id).toBe("a");
    expect(pickBestAccount([b])).toBeUndefined();
    expect(pickBestAccount([a, { ...b, excluded: false }])?.id).toBe("b");
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

describe("performSwitch", () => {
  const NOW = 1_800_000_000_000;
  const A = { accountUuid: "ua", emailAddress: "a@x.com" };
  const B = { accountUuid: "ub", emailAddress: "b@x.com" };

  /**
   * Keychain item and ~/.claude.json as a running CLI would see them. `during`
   * runs while the target's token is refreshed, the way a CLI that refreshes its
   * own token or rewrites ~/.claude.json at that moment would.
   */
  function world(during: (w: { keychain: string; claudeJson: string }) => void = () => undefined) {
    const state = {
      keychain: JSON.stringify({ claudeAiOauth: { accessToken: "a-old", refreshToken: "ra" }, mcpOAuth: { srv: 1 } }),
      claudeJson: JSON.stringify({ numStartups: 42, oauthAccount: A }),
    };
    const secrets = new Map<string, string>([
      [vaultOauthKey("ub"), JSON.stringify({ accessToken: "b-old", refreshToken: "rb", expiresAt: NOW + 30_000 })],
      [vaultIdentKey("ub"), JSON.stringify(B)],
    ]);
    const log: string[] = [];
    let held = false;
    const deps: SwitchDeps = {
      lock: () => {
        log.push("lock");
        held = true;
        return () => {
          log.push("release");
          held = false;
        };
      },
      readKeychain: async () => {
        log.push("read keychain");
        return state.keychain;
      },
      writeKeychain: async (json) => {
        log.push(`write keychain${held ? " (locked)" : ""}`);
        state.keychain = json;
      },
      getSecret: async (k) => secrets.get(k),
      setSecret: async (k, v) => {
        secrets.set(k, v);
      },
      readClaudeJson: async () => {
        log.push("read claude.json");
        return state.claudeJson;
      },
      writeClaudeJson: async (text) => {
        log.push(`write claude.json${held ? " (locked)" : ""}`);
        state.claudeJson = text;
      },
      fetchFn: async () => {
        log.push("refresh");
        during(state);
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "b-new", refresh_token: "rb2", expires_in: 3600 }),
          text: async () => "",
        };
      },
      now: () => NOW,
    };
    return { state, secrets, log, deps };
  }

  it("writes the keychain item and oauthAccount from reads taken right before the writes, under the lock", async () => {
    const w = world((s) => {
      // A running CLI refreshed A's token and rewrote ~/.claude.json while the switch waited on the network.
      s.keychain = JSON.stringify({ claudeAiOauth: { accessToken: "a-cli", refreshToken: "ra2" }, mcpOAuth: { srv: 2 } });
      s.claudeJson = JSON.stringify({ numStartups: 43, projects: { "/repo": { trusted: true } }, oauthAccount: A });
    });
    expect(await performSwitch(w.deps, "ub", "b@x.com")).toMatchObject({ ok: true, email: "b@x.com" });
    expect(JSON.parse(w.state.keychain)).toEqual({
      claudeAiOauth: { accessToken: "b-new", refreshToken: "rb2", expiresAt: NOW + 3_600_000 },
      mcpOAuth: { srv: 2 },
    });
    expect(JSON.parse(w.state.claudeJson)).toEqual({ numStartups: 43, projects: { "/repo": { trusted: true } }, oauthAccount: B });
    // A's login as it was right before the switch is what a switch back restores.
    expect(JSON.parse(w.secrets.get(vaultOauthKey("ua"))!)).toEqual({ accessToken: "a-cli", refreshToken: "ra2" });
    expect(w.log).toEqual([
      "lock",
      "read keychain",
      "read claude.json",
      "refresh",
      "read keychain",
      "read claude.json",
      "write keychain (locked)",
      "write claude.json (locked)",
      "release",
    ]);
  });

  it("refuses without reading or writing anything while another switch holds the lock", async () => {
    const w = world();
    w.deps.lock = () => {
      w.log.push("lock busy");
      return null;
    };
    const before = { ...w.state };
    expect(await performSwitch(w.deps, "ub", "b@x.com")).toEqual({ ok: false, error: "another account switch is running" });
    expect(w.log).toEqual(["lock busy"]);
    expect(w.state).toEqual(before);
  });

  it("releases the lock when a write fails", async () => {
    const w = world();
    w.deps.writeKeychain = async () => {
      throw new Error("security add-generic-password failed");
    };
    await expect(performSwitch(w.deps, "ub", "b@x.com")).rejects.toThrow("security add-generic-password failed");
    expect(w.log[w.log.length - 1]).toBe("release");
  });
});
