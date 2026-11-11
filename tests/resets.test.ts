import { describe, expect, it } from "vitest";
import {
  USAGE_URL,
  accountView,
  claimReset,
  claimUnresolved,
  cliUserAgent,
  describeClaim,
  fmtUseBy,
  grantKind,
  isUsable,
  parseCedarEmber,
  parseResetsFile,
  pickGrant,
  refillText,
  resetsFilePath,
  resetsFileText,
  resetsTotal,
  summarize,
  usageRequest,
  withResetsLeft,
  type CedarEmber,
  type ClaimOutcome,
  type ResetGrant,
  type ResetsFetch,
} from "../src/resets";

const NOW = Date.parse("2026-11-11T09:00:00Z");
const ORG = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
const UA = "claude-cli/2.1.322 (external, cli)";
const REQ = "7d4f0c5e-2b1a-4c3d-9e8f-0a1b2c3d4e5f";

// Wire shapes as the usage endpoint returns them (2026-11-11, read-only calls).
const wire = (over: Record<string, unknown>) => ({
  label: "", resets_total: 1, resets_left: 1, starts_at: null, ends_at: "2026-12-10T22:00:00Z", clears: [],
  paused: false, usable_now: true, use_requires_limit: false, percent_used: {}, blocking: [], type: null,
  gives_back_weekly: false, unavailable_reason: null, ...over,
});
const FULL_TEAM = wire({ id: "full-reset-2611", type: "full", clears: ["five_hour", "seven_day", "seven_day_overage_included"] });
const FABLE = (id: string) => wire({ id, type: "full", gives_back_weekly: true, clears: ["five_hour", "seven_day_overage_included"], ends_at: "2027-03-09T07:59:00Z" });
const WEEKLY_MAX = wire({ id: "full-reset-2611", type: "weekly", clears: ["seven_day", "seven_day_overage_included"] });
const body = (grants: unknown[], over: Record<string, unknown> = {}) => ({
  five_hour: { utilization: 12 },
  cedar_ember: { eligible: true, ineligible_reason: null, at_limit: false, exhausted: [], grants, next_grant_id: "full-reset-2611", weekly_resets_at: null, cooldown_until: null, event_props: null, ...over },
});
const status = (grants: unknown[], over: Record<string, unknown> = {}): CedarEmber => {
  const s = parseCedarEmber(body(grants, over));
  if (!s) throw new Error("fixture did not parse");
  return s;
};
const grant = (over: Partial<ResetGrant> = {}): ResetGrant => ({
  id: "g", resetsLeft: 1, endsAt: null, clears: ["five_hour"], paused: false, usableNow: true, useRequiresLimit: false,
  type: null, givesBackWeekly: false, unavailableReason: null, ...over,
});

const MAX = () => status([WEEKLY_MAX, FABLE("launch-2610-fable"), FABLE("launch-2610-fable-6mo"), FABLE("launch-2610-fable-12mo")]);
const TEAM = () => status([FULL_TEAM, FABLE("launch-2610-fable")]);

type Call = { url: string; init: Parameters<ResetsFetch>[1] };
function fakeFetch(code: number, reply: unknown, headers: Record<string, string> = {}): { fn: ResetsFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn: ResetsFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => (typeof reply === "string" ? reply : JSON.stringify(reply)),
    };
  };
  return { fn, calls };
}
const throwingFetch: ResetsFetch = async () => {
  throw new Error("socket hang up");
};

describe("parseCedarEmber", () => {
  it("returns null for a missing or malformed block", () => {
    expect(parseCedarEmber(null)).toBeNull();
    expect(parseCedarEmber("x")).toBeNull();
    expect(parseCedarEmber({})).toBeNull();
    expect(parseCedarEmber({ cedar_ember: null })).toBeNull(); // a plain /api/oauth/usage
    expect(parseCedarEmber({ cedar_ember: [] })).toBeNull();
    expect(parseCedarEmber({ cedar_ember: { eligible: "yes", grants: [] } })).toBeNull();
  });

  it("parses the live Max shape, drops malformed grants and applies the CLI's defaults", () => {
    const s = parseCedarEmber(body([
      WEEKLY_MAX, FABLE("launch-2610-fable"),
      { id: "Bad Id", resets_left: 1 }, { id: "no-left" }, { id: "neg", resets_left: -1 }, { id: "frac", resets_left: 0.5 }, "junk",
      { id: "bare", resets_left: 2 },
    ]));
    expect(s).not.toBeNull();
    expect(s!.eligible).toBe(true);
    expect(s!.atLimit).toBe(false);
    expect(s!.nextGrantId).toBe("full-reset-2611");
    expect(s!.grants.map((g) => g.id)).toEqual(["full-reset-2611", "launch-2610-fable", "bare"]);
    expect(s!.grants[1]).toEqual({
      id: "launch-2610-fable", resetsLeft: 1, endsAt: "2027-03-09T07:59:00Z", clears: ["five_hour", "seven_day_overage_included"],
      paused: false, usableNow: true, useRequiresLimit: false, type: "full", givesBackWeekly: true, unavailableReason: null,
    });
    expect(s!.grants[2]).toMatchObject({ paused: false, usableNow: false, useRequiresLimit: true, type: null, givesBackWeekly: false, endsAt: null, clears: [] });
  });

  it("keeps next_grant_id only when it names a listed grant; reads at_limit and the ineligible reason", () => {
    expect(parseCedarEmber(body([FULL_TEAM], { next_grant_id: "gone" }))!.nextGrantId).toBeNull();
    const s = parseCedarEmber({ cedar_ember: { eligible: false, ineligible_reason: "surface", at_limit: true } });
    expect(s).toEqual({ eligible: false, ineligibleReason: "surface", atLimit: true, grants: [], nextGrantId: null });
  });
});

describe("grantKind", () => {
  it("copies the CLI: Fable give-back first, then the type, else from the clears", () => {
    expect(grantKind(grant({ givesBackWeekly: true, type: "full" }))).toBe("fable");
    expect(grantKind(grant({ type: "full", clears: ["five_hour"] }))).toBe("full");
    expect(grantKind(grant({ type: "weekly", clears: ["five_hour"] }))).toBe("weekly");
    expect(grantKind(grant({ type: "session", clears: ["seven_day"] }))).toBe("session");
    expect(grantKind(grant({ clears: ["five_hour"] }))).toBe("session");
    expect(grantKind(grant({ clears: ["seven_day"] }))).toBe("weekly");
    expect(grantKind(grant({ clears: ["seven_day", "seven_day_overage_included"] }))).toBe("weekly");
    expect(grantKind(grant({ clears: ["five_hour", "seven_day"] }))).toBe("full");
    expect(grantKind(grant({ clears: [] }))).toBe("full");
  });

  it("classifies the live grants", () => {
    const [full, fable] = TEAM().grants;
    expect(grantKind(full)).toBe("full");
    expect(grantKind(fable)).toBe("fable");
    expect(MAX().grants.map(grantKind)).toEqual(["weekly", "fable", "fable", "fable"]);
  });
});

describe("isUsable", () => {
  const ends = (ms: number) => new Date(ms).toISOString();
  it("is usable when unpaused, usable now, unexpired and holding a reset", () => {
    expect(isUsable(grant(), false, NOW)).toBe(true);
    expect(isUsable(grant({ endsAt: ends(NOW + 60_000) }), false, NOW)).toBe(true);
    expect(isUsable(grant({ endsAt: "not a date" }), false, NOW)).toBe(true);
  });
  it("is not usable when paused, not usable now, expired or spent", () => {
    expect(isUsable(grant({ paused: true }), true, NOW)).toBe(false);
    expect(isUsable(grant({ usableNow: false }), true, NOW)).toBe(false);
    expect(isUsable(grant({ endsAt: ends(NOW - 1) }), true, NOW)).toBe(false);
    expect(isUsable(grant({ endsAt: ends(NOW) }), true, NOW)).toBe(false);
    expect(isUsable(grant({ resetsLeft: 0 }), true, NOW)).toBe(false);
  });
  it("needs a limit hit when use_requires_limit is set", () => {
    expect(isUsable(grant({ useRequiresLimit: true }), false, NOW)).toBe(false);
    expect(isUsable(grant({ useRequiresLimit: true }), true, NOW)).toBe(true);
  });
});

describe("summarize", () => {
  it("Max: 3 Fable resets and 1 Weekly reset, ordered fable first, with the first expiry", () => {
    const rows = summarize(MAX(), NOW);
    expect(rows.map((r) => [r.kind, r.label, r.count, r.usable])).toEqual([
      ["fable", "Fable reset", 3, true],
      ["weekly", "Weekly reset", 1, true],
    ]);
    expect(rows[0].firstEndsAt).toBe("2027-03-09T07:59:00Z");
    expect(rows[1].firstEndsAt).toBe("2026-12-10T22:00:00Z");
    expect(rows[0].grants).toHaveLength(3);
    expect(rows[0].refill).toBe("Refills your 5-hour limit and Fable allowance, and gives back what Fable used on your weekly limit");
    expect(rows[1].refill).toBe("Refills your weekly limit and Fable allowance");
    expect(rows[0].why).toBeUndefined();
  });

  it("first expiry is the earliest use-by among the kind's grants", () => {
    const rows = summarize(status([FABLE("a"), { ...FABLE("b"), ends_at: "2027-01-02T10:00:00Z" }, { ...FABLE("c"), ends_at: null }]), NOW);
    expect(rows[0].firstEndsAt).toBe("2027-01-02T10:00:00Z");
    expect(rows[0].count).toBe(3);
  });

  it("a grant spent elsewhere (resets_left 0, usable_now false) is not counted and has no row; next_grant_id moved on", () => {
    const spent = { ...FULL_TEAM, resets_left: 0, usable_now: false };
    const s = status([spent, FABLE("launch-2610-fable")], { next_grant_id: "launch-2610-fable" });
    expect(summarize(s, NOW).map((r) => [r.kind, r.count])).toEqual([["fable", 1]]);
    expect(pickGrant(s, "full", NOW)).toBeNull();
    expect(pickGrant(s, "fable", NOW)?.id).toBe("launch-2610-fable");
    const view = accountView({ ts: NOW / 1000, status: s }, undefined, NOW);
    expect(view.kinds.map((k) => k.kind)).toEqual(["fable"]);
    expect(resetsTotal([{ ts: NOW / 1000, status: s }, undefined], NOW)).toBe(1);
  });

  it("an unusable kind keeps its count and says why; expired grants drop out", () => {
    const needs = { ...FULL_TEAM, use_requires_limit: true };
    expect(summarize(status([needs]), NOW)[0]).toMatchObject({ kind: "full", count: 1, usable: false, why: "needs a limit hit first" });
    expect(summarize(status([needs], { at_limit: true }), NOW)[0]).toMatchObject({ usable: true });
    const blocked = { ...FULL_TEAM, usable_now: false, unavailable_reason: "blocked_five_hour" };
    expect(summarize(status([blocked]), NOW)[0].why).toBe("can't be used while you're at your 5-hour limit");
    expect(summarize(status([{ ...FULL_TEAM, usable_now: false }]), NOW)[0].why).toBe("not available right now");
    expect(summarize(status([{ ...FULL_TEAM, paused: true }]), NOW)[0].why).toBe("paused");
    expect(summarize(status([{ ...FULL_TEAM, ends_at: "2026-11-01T00:00:00Z" }]), NOW)).toEqual([]);
  });

  it("an ineligible account has no rows", () => {
    expect(summarize(status([FULL_TEAM], { eligible: false, ineligible_reason: "surface" }), NOW)).toEqual([]);
  });
});

describe("pickGrant", () => {
  it("prefers next_grant_id when it is a usable grant of the kind", () => {
    const s = status([FABLE("launch-2610-fable"), FABLE("launch-2610-fable-6mo")], { next_grant_id: "launch-2610-fable-6mo" });
    expect(pickGrant(s, "fable", NOW)?.id).toBe("launch-2610-fable-6mo");
  });
  it("falls back to the first usable grant of the kind in list order", () => {
    expect(pickGrant(MAX(), "fable", NOW)?.id).toBe("launch-2610-fable"); // next_grant_id is the weekly one
    const s = status([{ ...FABLE("a"), paused: true }, FABLE("b"), FABLE("c")], { next_grant_id: "a" });
    expect(pickGrant(s, "fable", NOW)?.id).toBe("b");
  });
  it("returns null when no grant of the kind is usable", () => {
    expect(pickGrant(MAX(), "session", NOW)).toBeNull();
    expect(pickGrant(status([{ ...FULL_TEAM, use_requires_limit: true }]), "full", NOW)).toBeNull();
    expect(pickGrant(status([FULL_TEAM], { eligible: false }), "full", NOW)).toBeNull();
  });
});

describe("refillText", () => {
  it("names what the live shapes refill", () => {
    const [full, fable] = TEAM().grants;
    expect(refillText(full)).toBe("Refills your 5-hour limit, weekly limit and Fable allowance");
    expect(refillText(fable)).toBe("Refills your 5-hour limit and Fable allowance, and gives back what Fable used on your weekly limit");
    expect(refillText(MAX().grants[0])).toBe("Refills your weekly limit and Fable allowance");
  });
  it("humanizes unknown keys and handles empty clears", () => {
    expect(refillText({ clears: ["seven_day_opus"], givesBackWeekly: false })).toBe("Refills your seven day opus limit");
    expect(refillText({ clears: [], givesBackWeekly: true })).toBe("Gives back what Fable used on your weekly limit");
    expect(refillText({ clears: [], givesBackWeekly: false })).toBe("Refills your usage limits");
  });
});

describe("fmtUseBy", () => {
  const now = new Date(2026, 10, 11, 12).getTime();
  it("omits the year when it is this year and adds it otherwise (local time)", () => {
    expect(fmtUseBy(new Date(2026, 11, 11, 12).toISOString(), now)).toBe("11 Dec");
    expect(fmtUseBy(new Date(2027, 2, 9, 12).toISOString(), now)).toBe("9 Mar 2027");
    expect(fmtUseBy("nope", now)).toBe("");
  });
});

describe("cliUserAgent", () => {
  const home = "/h";
  const lookup = (versions: string[] | null, link: string | null) => ({
    home,
    readdir: (dir: string) => {
      if (dir !== "/h/.local/share/claude/versions" || !versions) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return versions;
    },
    realpath: (p: string) => {
      if (p !== "/h/.local/bin/claude" || !link) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return link;
    },
  });
  it("uses the highest numeric version in the versions dir", () => {
    expect(cliUserAgent(lookup(["2.1.99", "2.1.322", "2.0.500", "2.1.323.tmp", "latest"], null))).toBe("claude-cli/2.1.322 (external, cli)");
    expect(cliUserAgent(lookup(["2.1.9", "2.1.10"], null))).toBe("claude-cli/2.1.10 (external, cli)");
  });
  it("falls back to the claude link target, else null", () => {
    expect(cliUserAgent(lookup(null, "/h/.local/share/claude/versions/2.1.318"))).toBe("claude-cli/2.1.318 (external, cli)");
    expect(cliUserAgent(lookup([], "/h/.local/share/claude/versions/2.1.318"))).toBe("claude-cli/2.1.318 (external, cli)");
    expect(cliUserAgent(lookup(null, "/opt/claude/bin/claude"))).toBeNull();
    expect(cliUserAgent(lookup(null, null))).toBeNull();
  });
});

describe("usageRequest", () => {
  const plain = { "Content-Type": "application/json", Authorization: "Bearer tok-1", "anthropic-beta": "oauth-2025-04-20" };
  it("is the plain usage request, without a User-Agent, unless Limit resets are on and the CLI was found", () => {
    expect(usageRequest("tok-1", false, UA)).toEqual({ url: "https://api.anthropic.com/api/oauth/usage", headers: plain });
    expect(usageRequest("tok-1", true, null)).toEqual({ url: "https://api.anthropic.com/api/oauth/usage", headers: plain });
    expect(usageRequest("tok-1", false, null)).toEqual({ url: USAGE_URL, headers: plain });
  });
  it("asks for the cedar_ember block, without the spend block, under the CLI's User-Agent", () => {
    expect(usageRequest("tok-1", true, UA)).toEqual({
      url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1",
      headers: { ...plain, "User-Agent": "claude-cli/2.1.322 (external, cli)" },
    });
  });
});

describe("persisted resets file", () => {
  const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  it("lives next to the usage snapshots, only for plain account uuids", () => {
    expect(resetsFilePath("/h/.claude/session-monitor", ID)).toBe(`/h/.claude/session-monitor/resets-${ID}.json`);
    expect(resetsFilePath("/h", "default")).toBeNull();
    expect(resetsFilePath("/h", "../../etc/passwd-aaaaaaaaaaaaaaaaaaaa")).toBeNull();
  });
  it("round-trips {ts, status} in the server's wire shape", () => {
    for (const st of [MAX(), TEAM(), status([FULL_TEAM], { at_limit: true, next_grant_id: null }), status([], { eligible: false, ineligible_reason: "surface" })]) {
      const text = resetsFileText({ ts: 1_762_850_000.5, status: st });
      const raw = JSON.parse(text);
      expect(Object.keys(raw)).toEqual(["ts", "status"]);
      expect(raw.status.grants.every((g: Record<string, unknown>) => "resets_left" in g && "usable_now" in g)).toBe(true);
      expect(parseResetsFile(text)).toEqual({ ts: 1_762_850_000.5, status: st });
    }
  });
  it("ignores a malformed file", () => {
    const good = JSON.parse(resetsFileText({ ts: 1_762_850_000, status: TEAM() }));
    expect(parseResetsFile("")).toBeNull();
    expect(parseResetsFile("{not json")).toBeNull();
    expect(parseResetsFile("null")).toBeNull();
    expect(parseResetsFile("[]")).toBeNull();
    expect(parseResetsFile(JSON.stringify({ status: good.status }))).toBeNull();
    expect(parseResetsFile(JSON.stringify({ ts: "1762850000", status: good.status }))).toBeNull();
    expect(parseResetsFile(JSON.stringify({ ts: 0, status: good.status }))).toBeNull();
    expect(parseResetsFile(JSON.stringify({ ts: 1_762_850_000 }))).toBeNull();
    expect(parseResetsFile(JSON.stringify({ ts: 1_762_850_000, status: { grants: [] } }))).toBeNull();
    // a malformed grant inside a valid file is dropped like in a live response
    const mixed = parseResetsFile(JSON.stringify({ ts: 1_762_850_000, status: { ...good.status, grants: [...good.status.grants, { id: "Bad Id", resets_left: 1 }] } }));
    expect(mixed?.status.grants.map((g) => g.id)).toEqual(["full-reset-2611", "launch-2610-fable"]);
  });
});

describe("claimReset", () => {
  it("POSTs the grant to the organization's reset_rate_limits with the exact body", async () => {
    const f = fakeFetch(200, { result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"], weekly_resets_at: null });
    const r = await claimReset("tok-2", ORG, "full-reset-2611", REQ, UA, f.fn);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(`https://api.anthropic.com/api/organizations/${ORG}/reset_rate_limits`);
    expect(f.calls[0].init.method).toBe("POST");
    expect(f.calls[0].init.body).toBe(`{"program":"cedar_ember","grant_id":"full-reset-2611","request_id":"${REQ}"}`);
    expect(f.calls[0].init.headers).toMatchObject({ Authorization: "Bearer tok-2", "anthropic-beta": "oauth-2025-04-20", "User-Agent": UA });
    expect(r).toEqual({ ok: true, reply: { result: "reset", reason: null, resetsLeft: 0, cleared: ["five_hour", "seven_day"], cooldownUntil: null } });
  });

  it("refuses malformed grant, request or organization ids without calling fetch", async () => {
    const f = fakeFetch(200, { result: "reset" });
    expect(await claimReset("t", ORG, "Full Reset", REQ, UA, f.fn)).toEqual({ ok: false, kind: "invalid", field: "grant id" });
    expect(await claimReset("t", ORG, "x".repeat(41), REQ, UA, f.fn)).toMatchObject({ kind: "invalid", field: "grant id" });
    expect(await claimReset("t", ORG, "../x", REQ, UA, f.fn)).toMatchObject({ kind: "invalid", field: "grant id" });
    expect(await claimReset("t", ORG, "full-reset-2611", "has space", UA, f.fn)).toMatchObject({ kind: "invalid", field: "request id" });
    expect(await claimReset("t", ORG, "full-reset-2611", "r".repeat(65), UA, f.fn)).toMatchObject({ kind: "invalid", field: "request id" });
    expect(await claimReset("t", "not-a-uuid", "full-reset-2611", REQ, UA, f.fn)).toMatchObject({ kind: "invalid", field: "organization id" });
    expect(await claimReset("t", "../../../../api/x/aaaaaaaaaaaaaaaaaaaaa", "full-reset-2611", REQ, UA, f.fn)).toMatchObject({ kind: "invalid", field: "organization id" });
    expect(f.calls).toHaveLength(0);
  });

  it("parses every result; an unknown result reads as unavailable", async () => {
    for (const result of ["already_used", "not_limited", "cooldown", "ineligible", "unavailable"]) {
      const r = await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(200, { result, reason: "not_next_grant" }).fn);
      expect(r).toMatchObject({ ok: true, reply: { result, reason: "not_next_grant" } });
    }
    expect(await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(200, { result: "maybe" }).fn)).toMatchObject({ ok: true, reply: { result: "unavailable" } });
  });

  it("maps 429, 401/403, other non-2xx, unreadable bodies and network errors", async () => {
    expect(await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(429, "", { "retry-after": "30" }).fn)).toEqual({ ok: false, kind: "rate_limited", httpStatus: 429, retryAfterSec: 30 });
    expect(await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(403, "").fn)).toEqual({ ok: false, kind: "auth", httpStatus: 403 });
    expect(await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(400, "{}").fn)).toEqual({ ok: false, kind: "error", httpStatus: 400 });
    expect(await claimReset("t", ORG, "g-1", REQ, UA, fakeFetch(200, "not json").fn)).toEqual({ ok: false, kind: "error", httpStatus: 200 });
    expect(await claimReset("t", ORG, "g-1", REQ, UA, throwingFetch)).toEqual({ ok: false, kind: "error" });
  });
});

describe("claimUnresolved", () => {
  const reply = (result: string): ClaimOutcome => ({ ok: true, reply: { result: result as "reset", reason: null, resetsLeft: null, cleared: [], cooldownUntil: null } });
  it("keeps the request id after unavailable, network errors, timeouts, 5xx and unreadable 2xx", () => {
    expect(claimUnresolved(reply("unavailable"))).toBe(true);
    expect(claimUnresolved({ ok: false, kind: "error" })).toBe(true);
    expect(claimUnresolved({ ok: false, kind: "error", httpStatus: 503 })).toBe(true);
    expect(claimUnresolved({ ok: false, kind: "error", httpStatus: 200 })).toBe(true);
  });
  it("drops it once the server answered", () => {
    for (const r of ["reset", "already_used", "not_limited", "cooldown", "ineligible"]) expect(claimUnresolved(reply(r))).toBe(false);
    expect(claimUnresolved({ ok: false, kind: "error", httpStatus: 400 })).toBe(false);
    expect(claimUnresolved({ ok: false, kind: "auth", httpStatus: 401 })).toBe(false);
    expect(claimUnresolved({ ok: false, kind: "rate_limited", httpStatus: 429 })).toBe(false);
  });
});

describe("describeClaim", () => {
  const now = new Date(2026, 10, 11, 12).getTime();
  const out = (result: string, extra: Record<string, unknown> = {}): ClaimOutcome => ({
    ok: true, reply: { result: result as "reset", reason: null, resetsLeft: null, cleared: [], cooldownUntil: null, ...extra },
  });
  it("one sentence per result", () => {
    expect(describeClaim(out("reset"), "Fable reset", "a@x.com", now)).toBe("Fable reset used on a@x.com.");
    expect(describeClaim(out("already_used"), "Fable reset", "a@x.com", now)).toBe("That reset was already used.");
    expect(describeClaim(out("not_limited"), "Full reset", "a@x.com", now)).toBe("a@x.com is not at a limit right now, so the server kept the reset.");
    expect(describeClaim(out("cooldown", { cooldownUntil: new Date(2026, 10, 11, 14, 5).toISOString() }), "Full reset", "a@x.com", now))
      .toBe("The Full reset on a@x.com is cooling down; available again at 14:05.");
    expect(describeClaim(out("cooldown"), "Full reset", "a@x.com", now)).toContain("available again shortly");
    expect(describeClaim(out("ineligible", { reason: "surface" }), "Full reset", "a@x.com", now)).toBe("a@x.com is not eligible for limit resets (surface).");
    expect(describeClaim(out("unavailable", { reason: "not_next_grant" }), "Weekly reset", "a@x.com", now))
      .toBe("The Weekly reset on a@x.com is not available right now (another reset has to be used first). Trying again is safe: it repeats the same request.");
  });
  it("explains failures", () => {
    expect(describeClaim({ ok: false, kind: "rate_limited", httpStatus: 429, retryAfterSec: 30 }, "Full reset", "a@x.com", now)).toContain("try again in 30 s");
    expect(describeClaim({ ok: false, kind: "auth", httpStatus: 401 }, "Full reset", "a@x.com", now)).toContain("rejected (HTTP 401)");
    expect(describeClaim({ ok: false, kind: "error" }, "Full reset", "a@x.com", now)).toContain("may or may not have been used");
    expect(describeClaim({ ok: false, kind: "error", httpStatus: 404 }, "Full reset", "a@x.com", now)).toBe("The server refused the Full reset on a@x.com (HTTP 404).");
    expect(describeClaim({ ok: false, kind: "invalid", field: "grant id" }, "Full reset", "a@x.com", now)).toContain("nothing was sent");
  });
});

describe("accountView", () => {
  const TS = NOW / 1000 - 60;
  it("waits for the first usage reading", () => {
    expect(accountView(undefined, undefined, NOW)).toEqual({ atLimit: false, state: "waiting", ts: null, note: "waiting for the next usage reading", kinds: [] });
    expect(accountView(undefined, { kind: "rate_limited", httpStatus: 429 }, NOW).note).toBe("waiting for the next usage reading · usage API rate-limited");
  });
  it("rows come from the last known reading, with its time", () => {
    expect(accountView({ ts: TS, status: MAX() }, undefined, NOW)).toEqual({
      atLimit: false, state: "ok", ts: TS,
      kinds: [
        { kind: "fable", label: "Fable reset", count: 3, until: fmtUseBy("2027-03-09T07:59:00Z", NOW), tip: "Refills your 5-hour limit and Fable allowance, and gives back what Fable used on your weekly limit", usable: true },
        { kind: "weekly", label: "Weekly reset", count: 1, until: fmtUseBy("2026-12-10T22:00:00Z", NOW), tip: "Refills your weekly limit and Fable allowance", usable: true },
      ],
    });
  });
  it("a failed latest poll keeps the rows and adds its short note", () => {
    const v = accountView({ ts: TS, status: TEAM() }, { kind: "rate_limited", httpStatus: 429 }, NOW);
    expect(v.state).toBe("ok");
    expect(v.note).toBe("usage API rate-limited");
    expect(v.kinds.map((k) => k.kind)).toEqual(["fable", "full"]);
    expect(accountView({ ts: TS, status: TEAM() }, { kind: "auth", httpStatus: 401 }, NOW).note).toBe("token rejected (HTTP 401)");
    expect(accountView({ ts: TS, status: TEAM() }, { kind: "auth" }, NOW).note).toBe("token rejected");
  });
  it("ineligible accounts and the at-limit flag", () => {
    expect(accountView({ ts: TS, status: status([], { eligible: false, ineligible_reason: "surface" }) }, undefined, NOW))
      .toEqual({ atLimit: false, state: "ineligible", ts: TS, note: "not eligible (surface)", kinds: [] });
    expect(accountView({ ts: TS, status: status([], { eligible: false, ineligible_reason: "surface" }) }, { kind: "auth", httpStatus: 403 }, NOW).note)
      .toBe("not eligible (surface) · token rejected (HTTP 403)");
    expect(accountView({ ts: TS, status: status([FULL_TEAM], { at_limit: true }) }, undefined, NOW).atLimit).toBe(true);
  });
  it("resetsTotal counts every account with a known reading; null until one has one", () => {
    expect(resetsTotal([undefined, undefined], NOW)).toBeNull();
    expect(resetsTotal([{ ts: TS, status: MAX() }, undefined, { ts: TS, status: TEAM() }], NOW)).toBe(6);
    expect(resetsTotal([{ ts: TS, status: status([], { eligible: false }) }], NOW)).toBe(0);
  });
  it("withResetsLeft updates one grant without touching the original", () => {
    const s = TEAM();
    const after = withResetsLeft(s, "full-reset-2611", 0);
    expect(summarize(after, NOW).map((r) => r.kind)).toEqual(["fable"]);
    expect(summarize(s, NOW).map((r) => r.kind)).toEqual(["fable", "full"]);
  });
});
