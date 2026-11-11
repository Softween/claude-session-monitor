// Runs the real Usage Limits webview script (an inline <script> inside a TS
// template string, invisible to tsc) against a stub DOM, so a missing render
// helper fails here instead of leaving the panel on "Waiting for usage-limit data".
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { allBadges, displayNames, headerChip, orderCards, renderSwitchActivity, renderSwitchBlock, headerGauges, type CardHeader, type SwitchPanel } from "../src/switchPanel";
import { accountView, parseCedarEmber } from "../src/resets";

function webviewScript(): string {
  const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
  const marker = src.indexOf("Waiting for usage-limit");
  const open = src.indexOf("<script", marker);
  const start = src.indexOf(">", open) + 1;
  const end = src.indexOf("</script>", start);
  if (marker < 0 || open < 0 || end < 0) throw new Error("limits webview script not found");
  return src.slice(start, end).replace(/\$\{[^}]*\}/g, "0").replace(/\\`/g, "`");
}

interface Harness {
  root: { innerHTML: string }; send: (data: unknown) => void; posted: unknown[]; click: (attr: string, value: string) => void; key: (attr: string, value: string, k: string) => void;
  clickOn: (target: unknown) => void; change: (attr: string, value: string, checked: boolean) => void;
}
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
    clickOn: (t) => handlers.click({ target: t, currentTarget: root }),
    change: (attr, value, checked) => handlers.change({ target: { ...target(attr, value), checked } }),
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
      switchHtml: renderSwitchBlock(panel, now), switchActivity: renderSwitchActivity(panel, now), switchBadges: allBadges(panel),
      providers: [
        { id: "c:a", provider: "claude", label: "Claude · one@example.com", active: true, official: true, ts: now / 1000, note: null, gauges: [session] },
        { id: "c:b", provider: "claude", label: "Claude · two@example.com", active: false, official: true, ts: now / 1000, note: null, gauges: [session] },
      ],
    });
    const html = h.root.innerHTML;
    expect(html.indexOf("claude-switch")).toBeLessThan(html.indexOf("one@example.com</span>"));
    expect(html).not.toContain("a -&gt; b (auto)"); // on the Activity tab
    expect(html).toContain('data-testid="csm-tab-activity">Activity 1</button>');
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
        ...headerChip({ active: p.active, loginNeeded: false, gauges: p.gauges }), gauges: headerGauges(p.gauges),
      };
      return { ...p, hdr };
    });
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: [{ id: "s" }, { id: "g" }], eta: null, tokens: null, models: [],
      switchHtml: renderSwitchBlock(panel, now), switchActivity: renderSwitchActivity(panel, now), switchBadges: allBadges(panel), panelFresh: true,
      ui: { tab: "accounts", expandedAccounts: {} }, useEmails: ["bilal@glossgo.com", "bilal@softween.com"], providers,
    });
    let html = h.root.innerHTML;
    expect(html).not.toContain("Rotate");
    expect(html).not.toContain("data-switch=");
    expect(html.indexOf("bilal@glossgo</span>")).toBeLessThan(html.indexOf("bilal@softween</span>"));
    expect(html.indexOf("bilal@softween</span>")).toBeLessThan(html.indexOf(">Codex</span>"));
    expect(html).toContain("exhausted · 1h");
    expect(html).toContain('</span> 100%</span> · <span class="hg"><span class="gl">Weekly</span><span class="gs">W</span> 60%');
    expect(html).toContain('aria-expanded="true"'); // the active card
    expect((html.match(/data-toggle=/g) ?? [])).toHaveLength(3);
    expect((html.match(/class="bar"/g) ?? []).length).toBe(2); // only the active card body
    expect(html).not.toContain("Use this account");
    expect(html).not.toContain("csm-switch-activity"); // on the Activity tab

    h.click("toggle", "claude:g");
    html = h.root.innerHTML;
    expect((html.match(/class="bar"/g) ?? []).length).toBe(4);
    expect(html).toContain("Use this account");
    expect(h.posted).toContainEqual({ type: "setUi", key: "expandedAccounts", value: { "claude:g": true } });
    h.key("toggle", "claude:s", "Enter");
    expect((h.root.innerHTML.match(/class="bar"/g) ?? []).length).toBe(2);
    expect(h.posted).toContainEqual({ type: "setUi", key: "expandedAccounts", value: { "claude:g": true, "claude:s": false } });

    h.click("use", "bilal@glossgo.com");
    expect(h.posted).toContainEqual({ type: "useAccount", email: "bilal@glossgo.com", at: expect.any(Number) });
    expect(h.posted.some((m) => (m as { type: string }).type === "switchAccount")).toBe(false);

    h.click("tab", "activity");
    html = h.root.innerHTML;
    expect(h.posted).toContainEqual({ type: "setUi", key: "tab", value: "activity" });
    expect(html).toContain("a -&gt; b (auto)");
    expect(html).toContain('class="ltab active" aria-selected="true" data-tab="activity"');
    expect(html.indexOf("csm-switch-block")).toBeLessThan(html.indexOf("csm-switch-activity"));
    expect(html).not.toContain('data-testid="csm-account-row"');
    h.click("tab", "accounts");
    expect(h.root.innerHTML.match(/data-testid="csm-account-row"/g)).toHaveLength(3);
    expect(h.root.innerHTML).not.toContain("csm-switch-activity");
  });
  it("active login: marked active even when exhausted, no Use button; Use shows Switching… until the host's result", () => {
    const now = Date.now();
    const full = { ...gauge("session", "Session (5h)", 100), resetMs: now + 3_600_000 };
    const card = (email: string, id: string, active: boolean, gauges: ReturnType<typeof gauge>[]) => ({
      id: `claude:${id}`, provider: "claude", label: `Claude · ${email}`, email, accountId: id, active, official: true, ts: now / 1000, note: null, gauges,
      hdr: { name: email.split("@")[0], ...headerChip({ active, loginNeeded: false, gauges }), gauges: headerGauges(gauges) } as CardHeader,
    });
    const base = {
      type: "update", ts: now / 1000, official: true, accounts: [{ id: "s" }, { id: "b" }], eta: null, tokens: null, models: [], switchHtml: "", switchBadges: {},
      panelFresh: true, ui: { expandedAccounts: { "claude:b": true } }, useEmails: ["ben@example.com", "ana@example.com"],
    };
    const before = [card("ben@example.com", "s", true, [full]), card("ana@example.com", "b", false, [gauge("session", "Session (5h)", 0)])];
    const after = [card("ben@example.com", "s", false, [full]), card("ana@example.com", "b", true, [gauge("session", "Session (5h)", 0)])];
    const row = (h: Harness, email: string) => h.root.innerHTML.split('data-testid="csm-account-row"').find((r) => r.includes(`title="Claude · ${email}"`)) ?? "";

    const h = mount();
    h.send({ ...base, providers: before });
    expect(row(h, "ben@example.com")).toContain('class="adot"');
    expect(row(h, "ben@example.com")).toContain("active · exhausted · 1h");
    expect(row(h, "ben@example.com")).not.toContain("Use this account");
    expect(row(h, "ana@example.com")).toContain('data-use="ana@example.com"');
    expect(row(h, "ana@example.com")).toContain(">ready</span>");

    h.click("use", "ana@example.com");
    const msg = h.posted.find((m) => (m as { type: string }).type === "useAccount") as { email: string; at: number };
    expect(msg).toEqual({ type: "useAccount", email: "ana@example.com", at: expect.any(Number) });
    expect(row(h, "ana@example.com")).toContain('disabled aria-busy="true" data-testid="csm-use-account">Switching…</button>');
    expect(row(h, "ana@example.com")).not.toContain("data-use=");
    h.click("use", "ana@example.com"); // a second click while switching posts nothing
    expect(h.posted.filter((m) => (m as { type: string }).type === "useAccount")).toHaveLength(1);
    h.send({ ...base, providers: before, usePending: "ana@example.com" }); // a tick while the CLI runs
    expect(row(h, "ana@example.com")).toContain("Switching…");

    h.send({ ...base, providers: after, useResult: { email: "ana@example.com", at: msg.at, ok: true, text: "active: ana@example.com (Max)" } });
    expect(h.root.innerHTML).toContain('data-testid="csm-use-result">Switched to ana@example.com</div>');
    expect(row(h, "ana@example.com")).toContain('<span class="adot" title="active login"></span><span class="chip">active</span>');
    expect(row(h, "ana@example.com")).not.toContain("Use this account");
    expect(row(h, "ana@example.com")).not.toContain("Switching…");
    expect(row(h, "ben@example.com")).toContain("exhausted · 1h");
    expect(row(h, "ben@example.com")).not.toContain('class="adot"');

    // A reloaded webview learns the running switch from the host, then shows the CLI's error text.
    const r = mount();
    r.send({ ...base, providers: before, usePending: "ana@example.com" });
    expect(row(r, "ana@example.com")).toContain("Switching…");
    r.send({ ...base, providers: before, useResult: { email: "ana@example.com", at: 1, ok: false, text: "claude-switch: vault for ana@example.com has no oauthAccount" } });
    expect(r.root.innerHTML).toContain('class="useres err" role="status" data-testid="csm-use-result">Could not switch to ana@example.com: claude-switch: vault for ana@example.com has no oauthAccount</div>');
    expect(row(r, "ana@example.com")).toContain('data-use="ana@example.com" data-testid="csm-use-account">Use this account</button>');
  });

  it("active login that claude-switch flags as needing a login shows both states in its chip", () => {
    const now = Date.now();
    const mk = (name: string, active: boolean, loginNeeded: boolean, gauges: ReturnType<typeof gauge>[]) => ({
      id: `claude:${name}`, provider: "claude", label: `Claude · ${name}@x.com`, email: `${name}@x.com`, accountId: name, active, official: true, ts: now / 1000, note: null, gauges,
      hdr: { name, ...headerChip({ active, loginNeeded, gauges }), gauges: headerGauges(gauges) } as CardHeader,
    });
    const base = {
      type: "update", ts: now / 1000, official: true, accounts: [{ id: "ana" }, { id: "ben" }], eta: null, tokens: null, models: [], switchHtml: "", switchBadges: {},
      panelFresh: true, ui: { expandedAccounts: {} }, useEmails: [],
    };
    const row = (h: Harness, name: string) => h.root.innerHTML.split('data-testid="csm-account-row"').find((r) => r.includes(`title="Claude · ${name}@x.com"`)) ?? "";
    const ok = [gauge("session", "Session (5h)", 20)];
    const full = [{ ...gauge("session", "Session (5h)", 100), resetMs: now + 3_600_000 }];

    const h = mount();
    h.send({ ...base, providers: [mk("ana", true, true, ok), mk("ben", false, true, ok)] });
    expect(row(h, "ana")).toContain('<span class="adot" title="active login"></span><span class="chip login">active · login needed</span>');
    expect(row(h, "ben")).toContain('<span class="chip login">login needed</span>');
    h.send({ ...base, providers: [mk("ana", true, true, full), mk("ben", false, false, ok)] });
    expect(row(h, "ana")).toContain('<span class="chip login">active · login needed · exhausted · 1h');
    h.send({ ...base, providers: [mk("ana", true, false, ok), mk("ben", false, false, ok)] });
    expect(row(h, "ana")).toContain('<span class="adot" title="active login"></span><span class="chip">active</span>');
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
    const mkHdr = (name: string, active: boolean, g: ReturnType<typeof gauge>[]): CardHeader => ({ name, ...headerChip({ active, loginNeeded: false, gauges: g }), gauges: headerGauges(g) });
    const providers = Array.from({ length: 8 }, (_, n) => {
      const g = [gauge("session", "Session (5h)", 10 * n), gauge("weekly", "Weekly (7d)", 5 * n)];
      const email = `acct${n}@example.com`;
      return { id: `claude:${n}`, provider: "claude", label: `Claude · ${email}`, email, accountId: String(n), active: n === 3, official: true, ts: now / 1000, note: null, gauges: g, hdr: mkHdr(`acct${n}`, n === 3, g) };
    });
    const cg = [gauge("primary", "Session", 0)];
    providers.push({ id: "codex", provider: "codex", label: "Codex", email: "Codex", accountId: "", active: false, official: true, ts: now / 1000, note: null, gauges: cg, hdr: mkHdr("Codex", false, cg) });
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: providers.slice(0, 8).map((p) => ({ id: p.accountId })), eta: null, tokens: null, models: [],
      panelFresh: true, ui: { expandedAccounts: {} }, useEmails: [], providers,
    });
    const html = h.root.innerHTML;
    expect(html.match(/data-toggle=/g)).toHaveLength(9);
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(8);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html.match(/class="cbody"/g)).toHaveLength(1);
    expect(html.match(/class="bar"/g)).toHaveLength(2);
  });

  it("account header lists every gauge with a percentage, omitting missing ones", () => {
    const h = mount();
    const now = Date.now();
    const mk = (id: string, gauges: ReturnType<typeof gauge>[]) => {
      const p = { id, provider: "claude", label: `Claude · ${id}@x.com`, email: `${id}@x.com`, accountId: id, active: false, official: true, ts: now / 1000, note: null, gauges };
      return { ...p, hdr: { name: id, ...headerChip({ active: false, loginNeeded: false, gauges }), gauges: headerGauges(gauges) } as CardHeader };
    };
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: [], eta: null, tokens: null, models: [], switchHtml: "", switchBadges: {}, panelFresh: true,
      ui: { expandedAccounts: {} }, useEmails: [],
      providers: [mk("full", [gauge("session", "Session (5h)", 27), gauge("weekly", "Weekly (7d)", 71), gauge("weekly-fable", "Weekly · Fable", 95)]), mk("two", [gauge("session", "Session (5h)", 10), gauge("weekly-fable", "Weekly · Fable", 20)])],
    });
    const spans = (id: string) => {
      const row = h.root.innerHTML.split('data-testid="csm-account-row"').find((r) => r.includes(`title="Claude · ${id}@x.com"`)) ?? "";
      return row.match(/<span class="hg[^"]*">/g) ?? [];
    };
    expect(spans("full")).toHaveLength(3);
    expect(spans("two")).toHaveLength(2);
    expect(h.root.innerHTML).toContain(">Session</span><span class=\"gs\">S</span> 27%");
    expect(h.root.innerHTML).toContain("71%");
    expect(spans("full")[2]).toContain("hot");
  });

  it("an old reading shows ~ before its percentages and its age in the header: active login over 2 min, other accounts over 10 min", () => {
    const h = mount();
    const now = Date.now();
    const mk = (id: string, active: boolean, ageS: number) => {
      const gauges = [gauge("session", "Session (5h)", 83), gauge("weekly", "Weekly (7d)", 40)];
      const p = { id, provider: "claude", label: `Claude · ${id}@x.com`, email: `${id}@x.com`, accountId: id, active, official: true, ts: now / 1000 - ageS, note: null, gauges };
      return { ...p, hdr: { name: id, ...headerChip({ active, loginNeeded: false, gauges }), gauges: headerGauges(gauges) } as CardHeader };
    };
    h.send({
      type: "update", ts: now / 1000, official: true, accounts: [], eta: null, tokens: null, models: [], switchHtml: "", switchBadges: {}, panelFresh: true,
      ui: { expandedAccounts: {} }, useEmails: [],
      providers: [mk("hot", true, 12 * 60), mk("live", true, 30), mk("calm", false, 5 * 60), mk("cold", false, 15 * 60)],
    });
    const row = (id: string) => h.root.innerHTML.split('data-testid="csm-account-row"').find((r) => r.includes(`title="Claude · ${id}@x.com"`)) ?? "";
    expect(row("hot")).toContain('<span class="cold num" title="');
    expect(row("hot")).toContain(">12m ago</span>");
    expect(row("hot")).toContain("</span> ~83%");
    expect(row("hot")).toMatch(/<span class="p num" style="color:[^"]*">~83%<\/span>/);
    expect(row("live")).not.toContain("ago</span>");
    expect(row("live")).not.toContain("~");
    expect(row("calm")).not.toContain("ago</span>");
    expect(row("calm")).not.toContain("~");
    expect(row("cold")).toContain(">15m ago</span>");
    expect(row("cold")).toContain("</span> ~40%");
  });

  it("skip box: ticked for excluded accounts, outside the toggle header; a change posts setExcluded, never toggles the card and holds until the panel agrees, a failure or 20 s", () => {
    const now = Date.now();
    const ok = [gauge("session", "Session (5h)", 20)];
    const mk = (name: string, active: boolean, excluded: boolean | undefined) => ({
      id: `claude:${name}`, provider: "claude", label: `Claude · ${name}@x.com`, email: `${name}@x.com`, accountId: name, active, official: true, ts: now / 1000, note: null, gauges: ok,
      hdr: { name, ...headerChip({ active, loginNeeded: false, excluded, gauges: ok }), gauges: headerGauges(ok) } as CardHeader,
    });
    const codex = { id: "codex", provider: "codex", label: "Codex", email: "Codex", active: false, official: true, ts: now / 1000, note: null, gauges: ok,
      hdr: { name: "Codex", ...headerChip({ active: false, loginNeeded: false, gauges: ok }), gauges: headerGauges(ok) } as CardHeader };
    const base = {
      type: "update", ts: now / 1000, official: true, accounts: [{ id: "ana" }, { id: "esya" }, { id: "zed" }], eta: null, tokens: null, models: [], switchHtml: "", switchBadges: {},
      panelFresh: true, ui: { expandedAccounts: { "claude:esya": true } },
    };
    // esya excluded or not; zed is a Claude login claude-switch does not list (no excluded flag)
    const state = (esya: boolean, ana = false) => ({
      ...base, providers: [mk("ana", true, ana), mk("esya", false, esya), mk("zed", false, undefined), codex],
      useEmails: ["ana@x.com", ...(esya ? [] : ["esya@x.com"]), "zed@x.com"],
    });
    const row = (h: Harness, name: string) => h.root.innerHTML.split('data-testid="csm-account-row"').find((r) => r.includes(`title="Claude · ${name}@x.com"`)) ?? "";
    const box = (h: Harness, name: string) => row(h, name).match(/<input type="checkbox"[^>]*>/)?.[0] ?? "";
    const hdr = (h: Harness, name: string) => row(h, name).match(/<div class="chdr[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
    const skips = (h: Harness) => h.posted.filter((m) => (m as { type: string }).type === "setExcluded") as { email: string; excluded: boolean; at: number }[];

    const h = mount();
    h.send(state(true));
    expect(hdr(h, "esya")).toContain('<div class="chdr excl" role="button"');
    expect(hdr(h, "esya")).toContain('<span class="chip">excluded</span>');
    expect(hdr(h, "esya")).not.toContain("skip");
    expect(row(h, "esya")).toContain('<div class="chrow"><div class="chdr excl"');
    expect(row(h, "esya")).toContain('</div><label class="skipbox" title="Skip: claude-switch never switches to this account. Untick to use it again.">');
    expect(box(h, "esya")).toContain('data-skip="esya@x.com"');
    expect(box(h, "esya")).toContain('data-testid="csm-account-skip" checked>');
    expect(row(h, "esya")).toContain('class="cbody"'); // expanded, yet no Use button for an excluded account
    expect(row(h, "esya")).not.toContain("Use this account");
    expect(hdr(h, "ana")).toContain('<div class="chdr" role="button"');
    expect(box(h, "ana")).not.toContain("checked");
    expect(box(h, "zed")).toBe("");
    expect(h.root.innerHTML.match(/data-testid="csm-account-skip"/g)).toHaveLength(2); // ana + esya: not zed, not Codex

    // the active login can be excluded too: it stays active, dimmed, until claude-switch moves off it
    h.send(state(true, true));
    expect(hdr(h, "ana")).toContain('<div class="chdr excl"');
    expect(hdr(h, "ana")).toContain('<span class="adot" title="active login"></span><span class="chip">active · excluded</span>');
    expect(box(h, "ana")).toContain("checked");

    // neither a click on the box or its label nor Space/Enter on the box reaches a data-toggle ancestor
    const toggler = { dataset: { toggle: "claude:esya" }, classList: { contains: () => false }, parentElement: null };
    const label = { dataset: {}, classList: { contains: (c: string) => c === "skipbox" }, parentElement: toggler };
    const input = { dataset: { skip: "esya@x.com" }, classList: { contains: () => false }, parentElement: label };
    h.clickOn(input);
    h.clickOn(label);
    h.key("skip", "esya@x.com", " ");
    h.key("skip", "esya@x.com", "Enter");
    expect(h.posted).toEqual([]);

    // unticking posts include; the box stays unticked across ticks until panel.json agrees
    h.change("skip", "esya@x.com", false);
    expect(skips(h)).toEqual([{ type: "setExcluded", email: "esya@x.com", excluded: false, at: expect.any(Number) }]);
    expect(h.posted).toHaveLength(1);
    h.send(state(true));
    expect(box(h, "esya")).not.toContain("checked");
    h.send(state(false));
    expect(box(h, "esya")).not.toContain("checked");
    expect(hdr(h, "esya")).toContain(">ready</span>");
    expect(row(h, "esya")).toContain('data-use="esya@x.com"');
    h.send(state(true)); // settled: the box follows the panel again
    expect(box(h, "esya")).toContain("checked");

    // a failure for that click drops the pending state (an older failure does not)
    h.change("skip", "esya@x.com", false);
    const at = skips(h)[1].at;
    h.send({ ...state(true), skipFailed: { email: "esya@x.com", at: at - 1 } });
    expect(box(h, "esya")).not.toContain("checked");
    h.send({ ...state(true), skipFailed: { email: "esya@x.com", at } });
    expect(box(h, "esya")).toContain("checked");

    // with no answer at all the box returns to the panel's value after 20 s
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + 1_000);
      h.change("skip", "esya@x.com", false);
      h.send(state(true));
      expect(box(h, "esya")).not.toContain("checked");
      clock.mockReturnValue(now + 1_000 + 20_001);
      h.send(state(true));
      expect(box(h, "esya")).toContain("checked");
    } finally {
      clock.mockRestore();
    }
  });
});

describe("Usage Limits webview: Limit resets", () => {
  const now = Date.now();
  const card = (id: string, email: string, active: boolean) => ({
    id: `claude:${id}`, provider: "claude", label: `Claude · ${email}`, email, accountId: id, active, official: true, ts: now / 1000, note: null, gauges: [gauge("session", "Session (5h)", 20)],
  });
  const base = {
    type: "update", ts: now / 1000, official: true, accounts: [{ id: "m" }, { id: "s" }, { id: "n" }, { id: "t" }], eta: null, tokens: null, models: [],
    switchHtml: '<div class="swblock" data-testid="csm-switch-block"><div class="swline">claude-switch · max@x.com · auto</div></div>', switchBadges: {},
    providers: [card("m", "max@x.com", true), card("s", "soft@x.com", false), card("n", "none@x.com", false), card("t", "team@x.com", false)],
  };
  // Live 2026-11-11: a Full reset spent elsewhere comes back as resets_left 0 / usable_now false and next_grant_id moves on.
  const spent = parseCedarEmber({ cedar_ember: { eligible: true, at_limit: false, next_grant_id: "launch-2610-fable", grants: [
    { id: "full-reset-2611", type: "full", clears: ["five_hour", "seven_day", "seven_day_overage_included"], resets_left: 0, usable_now: false, use_requires_limit: false, ends_at: "2026-12-10T22:00:00Z" },
    { id: "launch-2610-fable", type: "full", gives_back_weekly: true, clears: ["five_hour", "seven_day_overage_included"], resets_left: 1, usable_now: true, use_requires_limit: false, ends_at: "2027-03-09T07:59:00Z" },
  ] } });
  const resets = (over: Record<string, unknown> = {}) => ({
    total: 6, done: null,
    accounts: [
      { id: "m", name: "max", email: "max@x.com", atLimit: true, state: "ok", kinds: [
        { kind: "fable", label: "Fable reset", count: 3, until: "9 Mar 2027", tip: "Refills your 5-hour limit and Fable allowance, and gives back what Fable used on your weekly limit", usable: true },
        { kind: "full", label: "Full reset", count: 1, until: "11 Dec", tip: "Refills your 5-hour limit, weekly limit and Fable allowance", usable: true },
        { kind: "weekly", label: "Weekly reset", count: 1, until: "11 Dec", tip: "Refills your weekly limit and Fable allowance", usable: false, why: "needs a limit hit first" },
      ] },
      { id: "s", name: "soft", email: "soft@x.com", active: false, ...accountView(spent ? { ts: now / 1000, status: spent } : undefined, undefined, now) },
      { id: "n", name: "none", email: "none@x.com", active: false, atLimit: false, state: "ok", ts: now / 1000, kinds: [] },
      { id: "t", name: "team", email: "team@x.com", active: false, atLimit: false, state: "waiting", ts: null, note: "waiting for the next usage reading · usage API rate-limited", kinds: [] },
    ],
    ...over,
  });
  const opened = { ui: { tab: "resets", expandedAccounts: {} } };
  const acct = (h: Harness, name: string) => h.root.innerHTML.split('data-testid="csm-resets-account"').find((r) => r.includes(`title="${name}@x.com"`)) ?? "";
  const resetPosts = (h: Harness) => h.posted.filter((m) => (m as { type: string }).type === "useReset") as { type: string; key: string; at: number }[];

  it("no resets field (claude-switch not installed): no Resets tab and, with no other section, no tab bar", () => {
    const h = mount();
    h.send(base);
    expect(h.root.innerHTML).not.toContain("csm-resets");
    expect(h.root.innerHTML).not.toContain("csm-limits-tabs");
  });

  it("Resets tab in the bottom bar with the total; its list shows only on that tab, under the claude-switch block; a tab click posts setUi tab", () => {
    const h = mount();
    h.send({ ...base, resets: resets() });
    let html = h.root.innerHTML;
    expect(html).toContain('<div class="ltabs" role="tablist" aria-label="Usage Limits sections" data-testid="csm-limits-tabs"><button type="button" role="tab" class="ltab active" aria-selected="true" data-tab="accounts" data-testid="csm-tab-accounts">Accounts</button><button type="button" role="tab" class="ltab" aria-selected="false" data-tab="resets" data-testid="csm-tab-resets">Resets 6</button></div>');
    expect(html.indexOf('data-testid="csm-account-row"')).toBeLessThan(html.indexOf("csm-limits-tabs"));
    expect(html).not.toContain("csm-resets-account");
    expect(html).not.toContain("csm-reset-row");

    h.click("tab", "resets");
    expect(h.posted).toEqual([{ type: "setUi", key: "tab", value: "resets" }]);
    html = h.root.innerHTML;
    expect(html).toContain('class="ltab active" aria-selected="true" data-tab="resets" data-testid="csm-tab-resets">Resets 6</button>');
    expect(html.match(/data-testid="csm-resets-account"/g)).toHaveLength(4);
    expect(html.indexOf("csm-switch-block")).toBeLessThan(html.indexOf('data-testid="csm-resets"'));
    expect(html).not.toContain('data-testid="csm-account-row"');
    h.click("tab", "accounts");
    expect(h.posted).toContainEqual({ type: "setUi", key: "tab", value: "accounts" });
    expect(h.root.innerHTML).not.toContain("csm-resets-account");
  });

  it("open: per account its name, at-limit chip and note, one row per kind with Use or the reason; a spent reset has no row", () => {
    const h = mount();
    h.send({ ...base, ...opened, resets: resets() });
    const max = acct(h, "max");
    expect(max).toContain('<span class="ctitle" title="max@x.com">max</span><span class="chip">at limit</span></div>');
    expect(max).toContain('<div class="rsrow" title="Refills your 5-hour limit and Fable allowance, and gives back what Fable used on your weekly limit" data-testid="csm-reset-row"><span class="rsk">Fable reset · 3</span><span class="rsd">first expires 9 Mar 2027</span><button type="button" class="useacct" data-use-reset="m|fable" data-testid="csm-reset-use">Use</button></div>');
    expect(max).toContain('<span class="rsk">Full reset · 1</span><span class="rsd">use by 11 Dec</span><button type="button" class="useacct" data-use-reset="m|full"');
    expect(max).toContain('<span class="rsk">Weekly reset · 1</span><span class="rsd">use by 11 Dec</span><span class="rsact" title="needs a limit hit first">needs a limit hit first</span></div>');
    expect(max).not.toContain('data-use-reset="m|weekly"');

    const soft = acct(h, "soft");
    expect(soft.match(/data-testid="csm-reset-row"/g)).toHaveLength(1);
    expect(soft).toContain('<span class="rsk">Fable reset · 1</span>');
    expect(soft).toContain('data-use-reset="s|fable"');
    expect(soft).not.toContain("Full reset");
    expect(soft).not.toContain('data-use-reset="s|full"');

    expect(acct(h, "none")).toContain('<div class="rsnone">no resets</div>');
    const team = acct(h, "team");
    expect(team).toContain('<span class="rsnote" title="waiting for the next usage reading · usage API rate-limited">waiting for the next usage reading · usage API rate-limited</span>');
    expect(team).not.toContain("no resets");
    expect(h.root.innerHTML).not.toContain("csm-resets-asof"); // every reading here is fresh
    expect(h.root.innerHTML.match(/<span class="chip">at limit<\/span>/g)).toHaveLength(1);
  });

  it("Use posts useReset with its key and shows Using… until the host's done.at for that click; other Use buttons wait", () => {
    const h = mount();
    h.send({ ...base, ...opened, resets: resets() });
    h.click("useReset", "m|fable");
    const posts = resetPosts(h);
    expect(posts).toEqual([{ type: "useReset", key: "m|fable", at: expect.any(Number) }]);
    const at = posts[0].at;
    expect(acct(h, "max")).toContain('<span class="rsk">Fable reset · 3</span><span class="rsd">first expires 9 Mar 2027</span><button type="button" class="useacct" disabled aria-busy="true" data-testid="csm-reset-use">Using…</button>');
    expect(acct(h, "max")).toContain('data-use-reset="m|full" disabled data-testid="csm-reset-use">Use</button>');
    expect(acct(h, "soft")).toContain('data-use-reset="s|fable" disabled');
    h.click("useReset", "m|full");
    expect(resetPosts(h)).toHaveLength(1);

    h.send({ ...base, ...opened, resets: resets() }); // a tick while the modal is open
    expect(acct(h, "max")).toContain("Using…");
    h.send({ ...base, ...opened, resets: resets({ done: { at: at - 1 } }) }); // an older click's answer
    expect(acct(h, "max")).toContain("Using…");
    h.send({ ...base, ...opened, resets: resets({ done: { at } }) });
    expect(acct(h, "max")).not.toContain("Using…");
    expect(acct(h, "max")).toContain('data-use-reset="m|fable" data-testid="csm-reset-use">Use</button>');
    expect(acct(h, "max")).toContain('data-use-reset="m|full" data-testid="csm-reset-use">Use</button>');
  });

  it("a lost answer: Using… ends after 60 s", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      clock.mockReturnValue(now + 1_000);
      const h = mount();
      h.send({ ...base, ...opened, resets: resets() });
      h.click("useReset", "m|fable");
      expect(acct(h, "max")).toContain("Using…");
      clock.mockReturnValue(now + 1_000 + 59_000);
      h.send({ ...base, ...opened, resets: resets() });
      expect(acct(h, "max")).toContain("Using…");
      clock.mockReturnValue(now + 1_000 + 60_001);
      h.send({ ...base, ...opened, resets: resets() });
      expect(acct(h, "max")).not.toContain("Using…");
      expect(acct(h, "max")).toContain('data-use-reset="m|fable" data-testid="csm-reset-use">Use</button>');
    } finally {
      clock.mockRestore();
    }
  });

  it("a plain Resets tab until any reading; Claude Code CLI not found replaces the accounts; waiting for the first reading", () => {
    const loading = [{ id: "m", name: "max", email: "max@x.com", active: true, atLimit: false, state: "waiting", ts: null, note: "waiting for the next usage reading", kinds: [] }];
    const h = mount();
    h.send({ ...base, ...opened, resets: { total: null, cliMissing: true, accounts: loading, done: null } });
    expect(h.root.innerHTML).toContain('data-testid="csm-tab-resets">Resets</button>');
    expect(h.root.innerHTML).toContain('<div class="rsnone">Claude Code CLI not found</div>');
    expect(h.root.innerHTML).not.toContain("csm-resets-account");
    const l = mount();
    l.send({ ...base, ...opened, resets: { total: null, accounts: loading, done: null } });
    expect(acct(l, "max")).toContain('<span class="rsnote" title="waiting for the next usage reading">waiting for the next usage reading</span>');
    expect(acct(l, "max")).not.toContain("no resets");
  });

  it("an old reading shows its time (active login after 10 min, others after 20 min) and a failed poll keeps the rows with its note", () => {
    const noon = new Date(2026, 10, 11, 12, 0).getTime();
    const ago = (min: number) => noon / 1000 - min * 60;
    const fable = { kind: "fable", label: "Fable reset", count: 1, until: "9 Mar 2027", tip: "T", usable: true };
    const row = (id: string, active: boolean, ts: number, note?: string) => ({
      id, name: id, email: `${id}@x.com`, active, atLimit: false, state: "ok", ts, ...(note ? { note } : {}), kinds: [fable],
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(noon);
    try {
      const h = mount();
      h.send({ ...base, ...opened, resets: { total: 6, done: null, accounts: [
        row("live", true, ago(9)), row("act", true, ago(11)), row("calm", false, ago(19)),
        row("kept", false, ago(25), "usage API rate-limited"), row("old", false, new Date(2026, 10, 10, 14, 5).getTime() / 1000),
      ] } });
      expect(acct(h, "live")).not.toContain("as of");
      expect(acct(h, "act")).toContain('<span class="rsnote" data-testid="csm-resets-asof">as of 11:49</span>');
      expect(acct(h, "calm")).not.toContain("as of");
      const kept = acct(h, "kept");
      expect(kept).toContain('<span class="ctitle" title="kept@x.com">kept</span><span class="rsnote" data-testid="csm-resets-asof">as of 11:35</span><span class="rsnote" title="usage API rate-limited">usage API rate-limited</span></div>');
      expect(kept).toContain('<span class="rsk">Fable reset · 1</span><span class="rsd">use by 9 Mar 2027</span><button type="button" class="useacct" data-use-reset="kept|fable" data-testid="csm-reset-use">Use</button>');
      expect(acct(h, "old")).toContain("as of 10 Nov 14:05");

      clock.mockReturnValue(noon + 2 * 60_000); // two minutes on, the same reading is past 10 min: the next render shows its time
      h.send({ ...base, ...opened, resets: { total: 6, done: null, accounts: [row("live", true, ago(9))] } });
      expect(acct(h, "live")).toContain("as of 11:51");
    } finally {
      clock.mockRestore();
    }
  });
});
