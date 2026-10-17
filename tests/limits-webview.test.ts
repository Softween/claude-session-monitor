// Runs the real Usage Limits webview script (an inline <script> inside a TS
// template string, invisible to tsc) against a stub DOM, so a missing render
// helper fails here instead of leaving the panel on "Waiting for usage-limit data".
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { allBadges, displayNames, headerChip, orderCards, renderSwitchBlock, worstGauge, type CardHeader, type SwitchPanel } from "../src/switchPanel";

function webviewScript(): string {
  const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
  const marker = src.indexOf("Waiting for usage-limit");
  const open = src.indexOf("<script", marker);
  const start = src.indexOf(">", open) + 1;
  const end = src.indexOf("</script>", start);
  if (marker < 0 || open < 0 || end < 0) throw new Error("limits webview script not found");
  return src.slice(start, end).replace(/\$\{[^}]*\}/g, "0").replace(/\\`/g, "`");
}

interface Harness { root: { innerHTML: string }; send: (data: unknown) => void; posted: unknown[]; click: (attr: string, value: string) => void; key: (attr: string, value: string, k: string) => void }
type Handler = (ev: any) => void;

function mount(): Harness {
  const handlers: Record<string, Handler> = {};
  const posted: unknown[] = [];
  const root = { innerHTML: "", addEventListener: (t: string, fn: Handler) => { handlers[t] = fn; } };
  let onMessage: ((e: { data: unknown }) => void) | null = null;
  const sandbox = {
    document: { getElementById: () => root, documentElement: {} },
    window: { addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => { onMessage = fn; } },
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(m); }, getState: () => ({}), setState: () => undefined }),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    setInterval: () => 0,
    Date,
    Math,
    String,
    console,
  };
  vm.runInNewContext(webviewScript(), sandbox);
  if (!onMessage) throw new Error("webview registered no message listener");
  const send = onMessage as (e: { data: unknown }) => void;
  const target = (attr: string, value: string) => ({ dataset: { [attr]: value }, classList: { contains: () => false }, parentElement: null });
  return {
    root, posted, send: (data) => send({ data }),
    click: (attr, value) => handlers.click({ target: target(attr, value), currentTarget: root }),
    key: (attr, value, k) => handlers.keydown({ key: k, target: target(attr, value), preventDefault: () => undefined }),
  };
}

const gauge = (key: string, label: string, pct: number) => ({ key, label, pct, resetMs: Date.now() + 3_600_000 });

describe("Usage Limits webview", () => {
  it("renders one card per account with a bar row per gauge, badges and notes", () => {
    const h = mount();
    const session = gauge("session", "Session (5h)", 30);
    const fable = gauge("weekly-fable", "Weekly · Fable", 42);
    h.send({
      type: "update", ts: Date.now() / 1000, official: true, accounts: [{ id: "a" }, { id: "b" }], eta: null,
      tokens: { fiveHour: 1e6, sevenDay: 5e7 }, models: [],
      providers: [
        { id: "c:a", provider: "claude", label: "one@example.com", plan: "$100 Max", active: true, best: true, official: true,
          ts: Date.now() / 1000, note: "usage API rate-limited, retrying in 48s", accountId: "a", gauges: [session, fable], cols: { session, fable } },
        { id: "c:b", provider: "claude", label: "two@example.com", plan: "$200 Max", active: false, official: true, loginNeeded: true,
          ts: Date.now() / 1000, note: "token expired, last-known data; log in once to refresh", accountId: "b",
          gauges: [gauge("session", "Session (5h)", 0)], cols: { session: gauge("session", "Session (5h)", 0), fable: gauge("weekly-fable", "Weekly · Fable", 3) } },
        { id: "codex", provider: "codex", label: "Codex", plan: "$100 Pro Lite", active: false, official: true, ts: Date.now() / 1000, note: null,
          gauges: [gauge("primary", "Session", 0), gauge("secondary", "Weekly", 13)] },
      ],
    });
    const html = h.root.innerHTML;
    expect(html.match(/class="card"/g)).toHaveLength(3);
    expect((html.match(/class="bar"/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain("one@example.com");
    expect(html).toContain("two@example.com");
    expect(html).toContain('class="clogin">login');
    expect(html).toContain('class="adot"');
    expect(html).toContain("42%");
    expect(html).toContain("13%");
    expect(html).toContain("rate-limited");
    expect(html).toContain("Rotate");
  });

  it("renders the undecorated single-account payload without a decorated cols field", () => {
    const h = mount();
    h.send({ type: "update", ts: Date.now() / 1000, official: true, gauges: [gauge("session", "Session (5h)", 12)], usageNote: null });
    expect(h.root.innerHTML).toContain("12%");
    expect(h.root.innerHTML).toContain("csm-account-row");
  });

  it("injects the claude-switch block above the cards (legacy cards without a fresh panel flag)", () => {
    const h = mount();
    const now = Date.now();
    const panel: SwitchPanel = {
      v: 1, ts: now / 1000, active: { email: "one@example.com" }, priority: ["two@example.com", "one@example.com"],
      paused: false, nextHint: "hold",
      accounts: [{ email: "two@example.com", rank: 1, needsLogin: true, needsLoginReason: "refresh revoked" }],
      events: [{ ts: now / 1000, kind: "switch", text: "a -> b (auto)" }],
    };
    const session = gauge("session", "Session (5h)", 30);
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: [], eta: null, tokens: null, models: [],
      switchHtml: renderSwitchBlock(panel, now), switchBadges: allBadges(panel),
      providers: [
        { id: "c:a", provider: "claude", label: "Claude · one@example.com", active: true, official: true, ts: now / 1000, note: null, gauges: [session] },
        { id: "c:b", provider: "claude", label: "Claude · two@example.com", active: false, official: true, ts: now / 1000, note: null, gauges: [session] },
      ],
    });
    const html = h.root.innerHTML;
    expect(html.indexOf("claude-switch")).toBeLessThan(html.indexOf("one@example.com</span>"));
    expect(html).toContain("a -&gt; b (auto)");
    expect(html).toContain("#2</span>");
    expect(html).toContain("login needed (refresh revoked)");
  });

  it("fresh panel: ordered collapsible headers, toggling, Use this account, no Rotate or name-switch", () => {
    const h = mount();
    const now = Date.now();
    const panel: SwitchPanel = {
      v: 1, ts: now / 1000, active: { email: "bilal@softween.com" }, priority: ["bilal@glossgo.com", "bilal@softween.com"],
      paused: false, nextHint: "hold",
      accounts: [{ email: "bilal@glossgo.com", rank: 1 }, { email: "bilal@softween.com", rank: 2 }],
      events: [{ ts: now / 1000, kind: "switch", text: "a -> b (auto)" }],
    };
    const full = { ...gauge("session", "Session (5h)", 100), resetMs: Date.now() + 3_600_000 };
    const week = gauge("weekly", "Weekly (7d)", 60);
    const raw = [
      { id: "codex", provider: "codex", label: "Codex", active: false, official: true, ts: now / 1000, note: null, gauges: [week] },
      { id: "claude:s", provider: "claude", label: "Claude · bilal@softween.com", email: "bilal@softween.com", accountId: "s", active: true, official: true, ts: now / 1000, note: null, gauges: [gauge("session", "Session (5h)", 20), week] },
      { id: "claude:g", provider: "claude", label: "Claude · bilal@glossgo.com", email: "bilal@glossgo.com", accountId: "g", active: false, official: true, ts: now / 1000, note: null, gauges: [full, week] },
    ];
    const names = displayNames(["bilal@glossgo.com", "bilal@softween.com"]);
    const providers = orderCards(raw, panel).map((p) => {
      const rank = p.email === "bilal@glossgo.com" ? 1 : p.email === "bilal@softween.com" ? 2 : undefined;
      const hdr: CardHeader = {
        ...(rank ? { rank } : {}), name: p.provider === "codex" ? "Codex" : names[p.email === "bilal@glossgo.com" ? 0 : 1],
        ...headerChip({ active: p.active, loginNeeded: false, gauges: p.gauges }), worst: worstGauge(p.gauges),
      };
      return { ...p, hdr };
    });
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: [{ id: "s" }, { id: "g" }], eta: null, tokens: null, models: [],
      switchHtml: renderSwitchBlock(panel, now), switchBadges: allBadges(panel), panelFresh: true,
      ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: ["bilal@glossgo.com", "bilal@softween.com"], providers,
    });
    let html = h.root.innerHTML;
    expect(html).not.toContain("Rotate");
    expect(html).not.toContain("data-switch=");
    expect(html.indexOf("bilal@glossgo</span>")).toBeLessThan(html.indexOf("bilal@softween</span>"));
    expect(html.indexOf("bilal@softween</span>")).toBeLessThan(html.indexOf(">Codex</span>"));
    expect(html).toContain("exhausted · 1h");
    expect(html).toContain("Session 100%");
    expect(html).toContain('aria-expanded="true"'); // active card only (activity row is false)
    expect((html.match(/data-toggle=/g) ?? [])).toHaveLength(3);
    expect((html.match(/class="bar"/g) ?? []).length).toBe(2); // only the active card body
    expect(html).not.toContain("Use this account");
    expect(html).toContain('data-testid="csm-switch-activity" hidden');

    h.click("toggle", "claude:g");
    html = h.root.innerHTML;
    expect((html.match(/class="bar"/g) ?? []).length).toBe(4);
    expect(html).toContain("Use this account");
    expect(h.posted).toContainEqual({ type: "setUi", key: "expandedAccounts", value: { "claude:g": true } });
    h.key("toggle", "claude:s", "Enter");
    expect((h.root.innerHTML.match(/class="bar"/g) ?? []).length).toBe(2);
    expect(h.posted).toContainEqual({ type: "setUi", key: "expandedAccounts", value: { "claude:g": true, "claude:s": false } });

    h.click("use", "bilal@glossgo.com");
    expect(h.posted).toContainEqual({ type: "useAccount", email: "bilal@glossgo.com" });
    expect(h.posted.some((m) => (m as { type: string }).type === "switchAccount")).toBe(false);

    h.click("swtoggle", "1");
    expect(h.root.innerHTML).toContain('aria-expanded="true"');
    expect(h.root.innerHTML).not.toContain('data-testid="csm-switch-activity" hidden');
    expect(h.posted).toContainEqual({ type: "setUi", key: "switchActivityOpen", value: true });
    h.key("swtoggle", "1", " ");
    expect(h.root.innerHTML).toContain('data-testid="csm-switch-activity" hidden');
  });
  it("hides the Tokens row and Models block unless showTokenStats is set", () => {
    const base = {
      type: "update", ts: Date.now() / 1000, official: true, accounts: [], eta: null,
      tokens: { fiveHour: 1e6, sevenDay: 5e7 }, models: [{ name: "Opus", tokens: 5e7, pct: 100, cost: null }],
      providers: [{ id: "c:a", provider: "claude", label: "one@example.com", active: true, official: true, ts: Date.now() / 1000, note: null, gauges: [gauge("session", "Session (5h)", 30)] }],
    };
    const off = mount();
    off.send(base);
    expect(off.root.innerHTML).not.toContain("Tokens");
    expect(off.root.innerHTML).not.toContain("Models, 7d share");
    const on = mount();
    on.send({ ...base, showTokenStats: true });
    expect(on.root.innerHTML).toContain("Tokens");
    expect(on.root.innerHTML).toContain("Models, 7d share");
  });

  it("renders 8 Claude accounts + Codex as 9 collapsed headers and one expanded active card", () => {
    const h = mount();
    const now = Date.now();
    const mkHdr = (name: string, active: boolean, g: ReturnType<typeof gauge>[]): CardHeader => ({ name, ...headerChip({ active, loginNeeded: false, gauges: g }), worst: worstGauge(g) });
    const providers = Array.from({ length: 8 }, (_, n) => {
      const g = [gauge("session", "Session (5h)", 10 * n), gauge("weekly", "Weekly (7d)", 5 * n)];
      const email = `acct${n}@example.com`;
      return { id: `claude:${n}`, provider: "claude", label: `Claude · ${email}`, email, accountId: String(n), active: n === 3, official: true, ts: now / 1000, note: null, gauges: g, hdr: mkHdr(`acct${n}`, n === 3, g) };
    });
    const cg = [gauge("primary", "Session", 0)];
    providers.push({ id: "codex", provider: "codex", label: "Codex", email: "Codex", accountId: "", active: false, official: true, ts: now / 1000, note: null, gauges: cg, hdr: mkHdr("Codex", false, cg) });
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: providers.slice(0, 8).map((p) => ({ id: p.accountId })), eta: null, tokens: null, models: [],
      panelFresh: true, ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: [], providers,
    });
    const html = h.root.innerHTML;
    expect(html.match(/data-toggle=/g)).toHaveLength(9);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(8);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/class="cbody"/g)).toHaveLength(1);
    expect(html.match(/class="bar"/g)).toHaveLength(2);
  });
});
