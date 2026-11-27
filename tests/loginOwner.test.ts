import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_HOLDS,
  PROFILE_URL,
  SEED_HOLDS,
  fetchProfileAnswer,
  heldFor,
  judgeOwner,
  ownerKey,
  profileAccountUuid,
  profileAskable,
  type OwnerHold,
} from "../src/loginOwner";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T = 1_800_000_000_000;

describe("profileAccountUuid", () => {
  it("reads account.uuid", () => expect(profileAccountUuid({ account: { uuid: B, email: "b@x.com" }, organization: {} })).toBe(B));
  it("null without an account uuid", () => {
    expect(profileAccountUuid({ account: { email: "b@x.com" } })).toBeNull();
    expect(profileAccountUuid({ account: { uuid: 7 } })).toBeNull();
    expect(profileAccountUuid({ account: { uuid: "" } })).toBeNull();
    expect(profileAccountUuid({})).toBeNull();
    expect(profileAccountUuid(null)).toBeNull();
    expect(profileAccountUuid("x")).toBeNull();
  });
});

describe("profileAskable", () => {
  it("needs an access token that has not expired", () => {
    expect(profileAskable({ accessToken: "at", expiresAt: T + 1 }, T)).toBe(true);
    expect(profileAskable({ accessToken: "at" }, T)).toBe(true); // no expiry stored: the server decides
    expect(profileAskable({ accessToken: "at", expiresAt: T }, T)).toBe(false);
    expect(profileAskable({ accessToken: "at", expiresAt: T - 60_000 }, T)).toBe(false);
    expect(profileAskable({ refreshToken: "rt", expiresAt: T + 1 }, T)).toBe(false);
    expect(profileAskable(undefined, T)).toBe(false);
    expect(profileAskable(null, T)).toBe(false);
  });
});

describe("ownerKey", () => {
  it("one key per (account, refresh token), with no token in it", () => {
    expect(ownerKey(A, "rt-1")).toBe(ownerKey(A, "rt-1"));
    expect(ownerKey(A, "rt-1")).not.toBe(ownerKey(A, "rt-2"));
    expect(ownerKey(A, "rt-1")).not.toBe(ownerKey(B, "rt-1"));
    expect(ownerKey(A, "rt-1")).not.toContain("rt-1");
    expect(ownerKey(A, undefined)).toBe(ownerKey(A, undefined));
  });
});

describe("judgeOwner", () => {
  const key = ownerKey(A, "rt");
  it("match: no hold, nothing to log", () =>
    expect(judgeOwner(null, key, A, { uuid: A }, T, CAPTURE_HOLDS)).toEqual({ verdict: "match", hold: null, log: false }));
  it("capture: another account is held 5 min, no answer 60 s", () => {
    expect(judgeOwner(null, key, A, { uuid: B }, T, CAPTURE_HOLDS)).toEqual({
      verdict: "mismatch",
      hold: { key, verdict: "mismatch", owner: B, until: T + 5 * 60_000 },
      log: true,
    });
    expect(judgeOwner(null, key, A, { uuid: null, reason: "HTTP 429" }, T, CAPTURE_HOLDS)).toEqual({
      verdict: "unknown",
      hold: { key, verdict: "unknown", until: T + 60_000 },
      log: true,
    });
  });
  it("seed: another account is refused for good, no answer held 5 min", () => {
    expect(judgeOwner(null, key, A, { uuid: B }, T, SEED_HOLDS).hold?.until).toBe(Infinity);
    expect(judgeOwner(null, key, A, { uuid: null, reason: "timeout" }, T, SEED_HOLDS).hold?.until).toBe(T + 5 * 60_000);
  });
  it("logs once per pair and verdict: a renewal stays quiet, a new pair or a new verdict logs", () => {
    const first = judgeOwner(null, key, A, { uuid: null, reason: "HTTP 503" }, T, CAPTURE_HOLDS);
    const again = judgeOwner(first.hold, key, A, { uuid: null, reason: "HTTP 429" }, T + 61_000, CAPTURE_HOLDS);
    expect(again.log).toBe(false);
    expect(again.hold?.until).toBe(T + 61_000 + 60_000);
    expect(judgeOwner(first.hold, ownerKey(A, "rt-new"), A, { uuid: null, reason: "HTTP 429" }, T + 61_000, CAPTURE_HOLDS).log).toBe(true);
    expect(judgeOwner(first.hold, key, A, { uuid: B }, T + 61_000, CAPTURE_HOLDS).log).toBe(true);
  });
});

describe("heldFor", () => {
  const key = ownerKey(A, "rt");
  const hold: OwnerHold = { key, verdict: "unknown", until: T + 60_000 };
  it("the hold for the same pair stays in force until it runs out", () => {
    expect(heldFor(hold, key, T + 59_999)).toBe(hold);
    expect(heldFor(hold, key, T + 60_000)).toBeNull();
  });
  it("a changed pair starts fresh", () => expect(heldFor(hold, ownerKey(A, "rt-new"), T)).toBeNull());
  it("no hold, nothing held", () => {
    expect(heldFor(null, key, T)).toBeNull();
    expect(heldFor(undefined, key, T)).toBeNull();
  });
  it("a refused seed is held for good", () => {
    const refused: OwnerHold = { key, verdict: "mismatch", owner: B, until: Infinity };
    expect(heldFor(refused, key, T + 365 * 86_400_000)).toBe(refused);
  });
});

describe("fetchProfileAnswer", () => {
  const headers = { Authorization: "Bearer at", "anthropic-beta": "oauth-2025-04-20" };
  const reply = (status: number, body: unknown = {}) =>
    vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));

  it("GETs the profile with the given headers and a timeout, and returns the account uuid", async () => {
    const f = reply(200, { account: { uuid: B, email: "b@x.com" } });
    expect(await fetchProfileAnswer(headers, f)).toEqual({ uuid: B });
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; signal?: AbortSignal; method?: string }];
    expect(url).toBe(PROFILE_URL);
    expect(PROFILE_URL).toBe("https://api.anthropic.com/api/oauth/profile");
    expect(init.headers).toEqual(headers);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method ?? "GET").toBe("GET");
  });
  it("an HTTP error is no answer, with its status", async () => {
    for (const s of [401, 403, 429, 500, 503]) expect(await fetchProfileAnswer(headers, reply(s))).toEqual({ uuid: null, reason: `HTTP ${s}` });
  });
  it("a body without an account is no answer", async () => {
    expect(await fetchProfileAnswer(headers, reply(200, { error: "x" }))).toEqual({ uuid: null, reason: "no account in the answer" });
    const badJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad"); } }));
    expect(await fetchProfileAnswer(headers, badJson)).toEqual({ uuid: null, reason: "network error" });
  });
  it("a network error or a timeout is no answer", async () => {
    expect(await fetchProfileAnswer(headers, vi.fn(async () => { throw new TypeError("fetch failed"); }))).toEqual({ uuid: null, reason: "network error" });
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    expect(await fetchProfileAnswer(headers, vi.fn(async () => { throw timeout; }))).toEqual({ uuid: null, reason: "timeout" });
  });
});
