import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountBadges, panelAge, readPanel, renderSwitchBlock, type SwitchPanel } from "../src/switchPanel";

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
  it("renders the status line, hint and events from a full fixture", () => {
    const h = renderSwitchBlock(full(), NOW);
    expect(h).toContain("claude-switch · active bilal@softween.com · priority #2 · auto · breaker 1/4 · last: bilal@glossgo.com → bilal@softween.com (auto-restore, 41 min ago)");
    expect(h).toContain("next: restore to bilal@softween.com when its peak &lt;= 80 (now 92)");
    expect(h).toContain(`${hhmm(sec - 100)}</span>  a -&gt; b (auto-restore)`);
    expect(h).toContain("sw-switch");
  });
  it("shows PAUSED", () => {
    expect(renderSwitchBlock(full({ paused: true }), NOW)).toContain("· PAUSED ·");
  });
  it("shows no data for a missing or stale file", () => {
    expect(renderSwitchBlock(null, NOW)).toContain("claude-switch: no data (file missing)");
    const stale = renderSwitchBlock(full({ ts: sec - 11 * 60 }), NOW);
    expect(stale).toContain("claude-switch: no data (11 min old)");
    expect(stale).not.toContain("active ");
  });
  it("orders events newest first and truncates to 8", () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ ts: sec - 1000 + i * 10, kind: i === 11 ? "error" : "info", text: `ev${i}` }));
    const h = renderSwitchBlock(full({ events }), NOW);
    expect((h.match(/class="swline/g) ?? []).length).toBe(2 + 8);
    expect(h.indexOf("ev11")).toBeLessThan(h.indexOf("ev10"));
    expect(h).toContain("sw-error");
    expect(h).not.toContain("ev3<");
    expect(h).toContain("ev4<");
  });
  it("escapes event text", () => {
    expect(renderSwitchBlock(full({ events: [{ ts: sec, kind: "info", text: "<b>x</b>" }] }), NOW)).not.toContain("<b>x");
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
