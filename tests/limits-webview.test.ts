// Runs the real Usage Limits webview script (an inline <script> inside a TS
// template string, invisible to tsc) against a stub DOM, so a missing render
// helper fails here instead of leaving the panel on "Waiting for usage-limit data".
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { allBadges, displayNames, headerChip, orderCards, renderSwitchBlock, headerGauges, type CardHeader, type SwitchPanel } from "../src/switchPanel";

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
        ...headerChip({ active: p.active, loginNeeded: false, gauges: p.gauges }), gauges: headerGauges(p.gauges),
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
    expect(html).toContain('</span> 100%</span> · <span class="hg"><span class="gl">Weekly</span><span class="gs">W</span> 60%');
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
    expect(h.posted).toContainEqual({ type: "useAccount", email: "bilal@glossgo.com", at: expect.any(Number) });
    expect(h.posted.some((m) => (m as { type: string }).type === "switchAccount")).toBe(false);

    h.click("swtoggle", "1");
    expect(h.root.innerHTML).toContain('aria-expanded="true"');
    expect(h.root.innerHTML).not.toContain('data-testid="csm-switch-activity" hidden');
    expect(h.posted).toContainEqual({ type: "setUi", key: "switchActivityOpen", value: true });
    h.key("swtoggle", "1", " ");
    expect(h.root.innerHTML).toContain('data-testid="csm-switch-activity" hidden');
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
      panelFresh: true, ui: { switchActivityOpen: false, expandedAccounts: { "claude:b": true } }, useEmails: ["ben@example.com", "ana@example.com"],
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
      panelFresh: true, ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: [],
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
      panelFresh: true, ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: [], providers,
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
      ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: [],
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
      ui: { switchActivityOpen: false, expandedAccounts: {} }, useEmails: [],
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
      panelFresh: true, ui: { switchActivityOpen: false, expandedAccounts: { "claude:esya": true } },
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
