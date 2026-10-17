import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountBadges, displayNames, headerChip, headerGauges, mergePanelAccounts, orderCards, panelAge, panelFresh, readPanel, renderSwitchBlock, worstGauge, type SwitchPanel } from "../src/switchPanel";

const NOW = 1_792_200_000_000;
const sec = NOW / 1000;
const hhmm = (t: number) => { const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

const full = (over: Partial<SwitchPanel> = {}): SwitchPanel => ({
  v: 1, ts: sec - 30, active: { uuid: "u1", email: "bilal@softween.com" },
  priority: ["esya@example.com", "bilal@softween.com", "bilal@glossgo.com"], paused: false,
  breaker: { open: false, count: 1, max: 4 },
  lastSwitch: { from: "bilal@glossgo.com", to: "bilal@softween.com", ts: sec - 41 * 60, reason: "auto-restore" },
  nextHint: "restore to bilal@softween.com when its peak <= 80 (now 92)",
  accounts: [
    { email: "esya@example.com", rank: 1, needsLogin: true, needsLoginReason: "refresh token revoked" },
    { email: "bilal@softween.com", rank: 2, needsLogin: false, needsLoginReason: null },
  ],
  events: [{ ts: sec - 100, kind: "switch", text: "a -> b (auto-restore)" }],
  ...over,
});

describe("readPanel", () => {
  it("returns null for missing, unparsable and wrong-version files", () => {
    const d = mkdtempSync(join(tmpdir(), "swp-"));
    expect(readPanel(join(d, "none.json"))).toBeNull();
    writeFileSync(join(d, "bad.json"), "{nope");
    expect(readPanel(join(d, "bad.json"))).toBeNull();
    writeFileSync(join(d, "v2.json"), JSON.stringify({ v: 2, ts: 1 }));
    expect(readPanel(join(d, "v2.json"))).toBeNull();
    writeFileSync(join(d, "ok.json"), JSON.stringify(full()));
    expect(readPanel(join(d, "ok.json"))?.active?.email).toBe("bilal@softween.com");
  });
  it("panelAge is seconds and never negative", () => {
    expect(panelAge(full(), NOW)).toBe(30);
    expect(panelAge(full({ ts: sec + 99 }), NOW)).toBe(0);
  });
});

describe("renderSwitchBlock", () => {
  it("renders line 1, the hint and a collapsed activity row", () => {
    const h = renderSwitchBlock(full(), NOW);
    expect(h).toContain("claude-switch · bilal@softween.com · #2 · auto<");
    expect(h).not.toContain("breaker");
    expect(h).not.toContain("last:");
    expect(h).toContain("next: restore to bilal@softween.com when its peak &lt;= 80 (now 92)");
    expect(h).toContain('aria-expanded="false"');
    expect(h).toContain("▸</span> Activity (1)");
    expect(h).toContain('data-testid="csm-switch-activity" hidden');
    expect(h).toContain(`${hhmm(sec - 100)}</span>  a -&gt; b (auto-restore)`);
  });
  it("renders expanded when asked", () => {
    const h = renderSwitchBlock(full(), NOW, true);
    expect(h).toContain('aria-expanded="true"');
    expect(h).toContain("▾</span> Activity (1)");
    expect(h).not.toContain(" hidden");
  });
  it("shows PAUSED and omits the rank when unknown", () => {
    expect(renderSwitchBlock(full({ paused: true }), NOW)).toContain("#2 · PAUSED<");
    expect(renderSwitchBlock(full({ active: { email: "x@y.z" } }), NOW)).toContain("claude-switch · x@y.z · auto<");
  });
  it("shows no data for a missing or stale file", () => {
    expect(renderSwitchBlock(null, NOW)).toContain("claude-switch: no data (file missing)");
    const stale = renderSwitchBlock(full({ ts: sec - 11 * 60 }), NOW);
    expect(stale).toContain("claude-switch: no data (11 min old)");
    expect(stale).not.toContain("Activity");
    expect(panelFresh(full(), NOW)).toBe(true);
    expect(panelFresh(full({ ts: sec - 11 * 60 }), NOW)).toBe(false);
    expect(panelFresh(null, NOW)).toBe(false);
  });
  it("filters kinds, orders newest first, truncates to 8, mutes offline and ratelimit", () => {
    const kinds = ["info", "kept", "debug", "switch", "restore", "needsLogin", "cleared", "error", "rollback", "paused", "resumed", "offline", "ratelimit"];
    const events = kinds.map((kind, i) => ({ ts: sec - 1000 + i * 10, kind, text: `ev-${kind}` }));
    const h = renderSwitchBlock(full({ events }), NOW);
    expect(h).toContain("Activity (8)");
    for (const k of ["info", "kept", "debug"]) expect(h).not.toContain(`ev-${k}<`);
    expect(h).toContain("ev-ratelimit<");
    expect(h.indexOf("ev-ratelimit")).toBeLessThan(h.indexOf("ev-offline"));
    expect(h).not.toContain("ev-switch<");
    expect(h).toContain("sw-ratelimit sw-muted");
    expect(h).toContain("sw-offline sw-muted");
    expect(h).not.toContain("sw-error sw-muted");
  });
  it("escapes event text", () => {
    expect(renderSwitchBlock(full({ events: [{ ts: sec, kind: "error", text: "<b>x</b>" }] }), NOW)).not.toContain("<b>x");
  });
});

describe("card helpers", () => {
  const g = (label: string, pct: number | null, resetMs: number | null = null) => ({ label, pct, resetMs });
  it("orders by rank, then priority order, unranked after, codex last (stable)", () => {
    const cards = [
      { provider: "codex", label: "Codex" },
      { provider: "claude", label: "Claude · bilal@glossgo.com" },
      { provider: "claude", label: "Claude · zed@x.com" },
      { provider: "claude", label: "Claude · bilal@softween.com" },
      { provider: "claude", label: "Claude · esya@example.com" },
    ];
    expect(orderCards(cards, full()).map((c) => c.label)).toEqual([
      "Claude · esya@example.com", "Claude · bilal@softween.com", "Claude · bilal@glossgo.com", "Claude · zed@x.com", "Codex",
    ]);
    expect(orderCards(cards, null)[4].label).toBe("Codex");
  });
  it("names are local parts, with the domain when local parts collide", () => {
    expect(displayNames(["a@x.com", "b@y.com"])).toEqual(["a", "b"]);
    expect(displayNames(["bilal@softween.com", "bilal@glossgo.com", "esya@example.com"])).toEqual(["bilal@softween", "bilal@glossgo", "esya"]);
  });
  it("worst gauge is the highest percent, label without the window", () => {
    expect(worstGauge([g("Session (5h)", 30), g("Weekly (7d)", 71), g("x", null)])).toEqual({ label: "Weekly", pct: 71 });
    expect(worstGauge([g("a", null)])).toBeUndefined();
    expect(worstGauge([])).toBeUndefined();
  });
  it("header gauges: session, weekly, then scoped in arrival order; omits missing; hot from 90", () => {
    const out = headerGauges([g("Weekly · Fable", 100), g("Weekly (7d)", 71), g("Weekly · Opus", 89.9), g("Session (5h)", 27), g("x", null)]);
    expect(out).toEqual([
      { label: "Session", short: "S", pct: 27, hot: false },
      { label: "Weekly", short: "W", pct: 71, hot: false },
      { label: "Fable", short: "F", pct: 100, hot: true },
      { label: "Opus", short: "O", pct: 89.9, hot: false },
    ]);
    expect(headerGauges([g("Session (5h)", 90), g("Weekly · Fable", 5)]).map((x) => [x.label, x.hot])).toEqual([["Session", true], ["Fable", false]]);
    expect(headerGauges([])).toEqual([]);
  });
  it("header gauges handle Codex session and weekly", () => {
    expect(headerGauges([g("Weekly (7d)", 12), g("Session (5h)", 3)]).map((x) => x.label)).toEqual(["Session", "Weekly"]);
  });
  it("chip precedence: login > exhausted > active > ready", () => {
    const base = { active: false, loginNeeded: false, gauges: [g("s", 10)] };
    expect(headerChip(base)).toEqual({ chip: "ready" });
    expect(headerChip({ ...base, active: true })).toEqual({ chip: "active" });
    expect(headerChip({ ...base, active: true, loginNeeded: true })).toEqual({ chip: "login" });
    expect(headerChip({ ...base, gauges: [g("s", 100, 5000), g("w", 100, 9000), g("f", 40, 99999)] })).toEqual({ chip: "exhausted", resetMs: 9000 });
    expect(headerChip({ ...base, gauges: [g("s", 99, 5000)] })).toEqual({ chip: "ready" });
  });
});

describe("mergePanelAccounts", () => {
  const U1 = "11111111-1111-1111-1111-111111111111", U2 = "22222222-2222-2222-2222-222222222222";
  it("adds missing panel accounts (identity only), keeps the rest and the active id", () => {
    const f = { v: 1 as const, accounts: [{ id: U1, email: "a@x.com", lastSeenTs: 5 }], activeId: U1 };
    const p = full({ accounts: [{ uuid: U1, email: "a@x.com" }, { uuid: U2, email: "b@x.com" }, { email: "nouuid@x.com" }, { uuid: "bad", email: "c@x.com" }] });
    const out = mergePanelAccounts(f, p);
    expect(out.accounts).toEqual([{ id: U1, email: "a@x.com", lastSeenTs: 5 }, { id: U2, email: "b@x.com", lastSeenTs: 0 }]);
    expect(out.activeId).toBe(U1);
    expect(JSON.stringify(out)).not.toMatch(/token/i);
    expect(f.accounts).toHaveLength(1);
  });
  it("returns the same object when nothing is missing", () => {
    const f = { v: 1 as const, accounts: [{ id: U1, email: "a@x.com", lastSeenTs: 5 }] };
    expect(mergePanelAccounts(f, full({ accounts: [{ uuid: U1, email: "a@x.com" }] }))).toBe(f);
    expect(mergePanelAccounts(f, null)).toBe(f);
  });
});

describe("accountBadges", () => {
  it("gives rank and login-needed reason", () => {
    expect(accountBadges(full(), "esya@example.com")).toEqual({ rank: 1, loginNeeded: "refresh token revoked" });
    expect(accountBadges(full(), "bilal@softween.com")).toEqual({ rank: 2 });
  });
  it("falls back to priority order and handles unknown or no panel", () => {
    expect(accountBadges(full(), "bilal@glossgo.com")).toEqual({ rank: 3 });
    expect(accountBadges(full(), "who@example.com")).toEqual({});
    expect(accountBadges(null, "x")).toEqual({});
  });
});
