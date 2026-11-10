// Runs the real "Limit burn" webview script (the inline <script> of burnHtml())
// against a stub DOM, and drives the BurnView provider with a hand-made WebviewView.
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { BurnView, burnHtml } from "../src/burnView";
import type { BurnPayload, BurnRowView } from "../src/burnPayload";

type Handler = (ev: any) => void;

function webviewScript(): string {
  const html = burnHtml();
  const open = html.indexOf("<script");
  const start = html.indexOf(">", open) + 1;
  const end = html.indexOf("</script>", start);
  if (open < 0 || end < 0) throw new Error("burn webview script not found");
  return html.slice(start, end);
}

function mount() {
  const handlers: Record<string, Handler> = {};
  const posted: unknown[] = [];
  const root = { innerHTML: "", addEventListener: (t: string, fn: Handler) => { handlers[t] = fn; } };
  let onMessage: ((e: { data: unknown }) => void) | null = null;
  vm.runInNewContext(webviewScript(), {
    document: { getElementById: () => root },
    window: { addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => { onMessage = fn; } },
    acquireVsCodeApi: () => ({ postMessage: (m: unknown) => { posted.push(m); } }),
  });
  if (!onMessage) throw new Error("webview registered no message listener");
  const send = onMessage as (e: { data: unknown }) => void;
  // Stub element: its data-* attributes and the parent chain the script walks up to the root.
  const el = (dataset: Record<string, string>, parentElement: unknown = root) => ({ dataset, parentElement });
  const key = (target: unknown, k: string): boolean => {
    let prevented = false;
    handlers.keydown({ key: k, target, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { root, posted, el, key, send: (data: unknown) => send({ data }), click: (target: unknown) => handlers.click({ target }) };
}

const MIN = 60_000;
const WINDOWS = [
  { ms: 5 * MIN, label: "5m" }, { ms: 15 * MIN, label: "15m" }, { ms: 60 * MIN, label: "1h" }, { ms: 300 * MIN, label: "5h" },
];

function row(over: Partial<BurnRowView> = {}): BurnRowView {
  return {
    sessionId: "s1", openId: "open-1", rank: 1, title: "Fix the login flow", meta: "52% of burn · opus-5-5 · subagents 78%",
    sharePct: 52, barPct: 100, used: "≈ 23%", rate: "+18%/h", live: true, ended: false, tip: "Fix the login flow\n52% of burn", ...over,
  };
}

function payload(over: Partial<BurnPayload> = {}): BurnPayload {
  return {
    type: "update", windowMs: 15 * MIN, windows: WINDOWS, scaled: true,
    headline: "$226/h · ≈ +118%/h of the 5h limit · full in ~24 min",
    note: "Estimate: token cost scaled by the measured 5h-limit rate.",
    rows: [
      row(),
      row({ sessionId: "s2", openId: "", rank: 2, title: "Old refactor", meta: "20% of burn · fable-5-2", sharePct: 20,
        barPct: 37.5, used: "≈ 9%", rate: "idle", live: false, ended: true, tip: "Old refactor" }),
    ],
    more: 3, empty: "No Claude Code usage in this window yet.", ...over,
  };
}

const rowsOf = (html: string) => html.split('<div class="row').slice(1);
const buttonsOf = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/g) ?? [];

describe("Limit burn webview", () => {
  it("ships a nonce-locked CSP, no external resources and a neutral line before the first payload", () => {
    const html = burnHtml();
    const nonce = /script-src 'nonce-([a-z0-9]+)'/.exec(html)?.[1] ?? "";
    expect(nonce).not.toBe("");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/https?:|<link|\ssrc=/);
    expect(html).toContain("Collecting usage…");
  });

  it("renders one two-line entry per row with rank, title, rate, used, meta and the bar", () => {
    const h = mount();
    h.send(payload());
    const html = h.root.innerHTML;
    const [first, second] = rowsOf(html);
    expect(rowsOf(html)).toHaveLength(2);
    expect(first).toContain('title="Fix the login flow\n52% of burn"');
    expect(first).toContain('<span class="num rank">1</span>');
    expect(first).toContain('class="dot live"');
    expect(first).toContain('<span class="title">Fix the login flow</span>');
    expect(first).toContain('<span class="num rate">+18%/h</span>');
    expect(first).toContain('<span class="num used">≈ 23%</span>');
    expect(first).toContain('<span class="meta">52% of burn · opus-5-5 · subagents 78%</span>');
    expect(first).toContain('style="width:100%"');
    expect(second.startsWith(' ended"')).toBe(true);
    expect(second).toContain('class="dot"');
    expect(second).toContain('style="width:37.5%"');
    expect(html).toContain('<div class="head">$226/h · ≈ +118%/h of the 5h limit · full in ~24 min</div>');
    expect(html).toContain('<div class="note">Estimate: token cost scaled by the measured 5h-limit rate.</div>');
  });

  it("marks only the selected window as pressed", () => {
    const h = mount();
    h.send(payload());
    const pressed = () => buttonsOf(h.root.innerHTML).filter((b) => b.includes('aria-pressed="true"'));
    expect(buttonsOf(h.root.innerHTML)).toHaveLength(4);
    expect(pressed()).toEqual([expect.stringContaining(">15m<")]);
    h.send(payload({ windowMs: 5 * MIN }));
    expect(pressed()).toEqual([expect.stringContaining(">5m<")]);
    expect(buttonsOf(h.root.innerHTML).filter((b) => b.includes('aria-pressed="false"'))).toHaveLength(3);
  });

  it("escapes payload strings in text and in attributes", () => {
    const h = mount();
    h.send(payload({
      headline: "<b>hot</b>",
      rows: [row({ title: "<img src=x onerror=1>", openId: 'a"b><script>', tip: '"><img src=y>', meta: "<i>m</i>" })],
    }));
    const html = h.root.innerHTML;
    expect(html).not.toMatch(/<img|<script|<b>|<i>/);
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
    expect(html).toContain('data-id="a&quot;b&gt;&lt;script&gt;"');
    expect(html).toContain('title="&quot;&gt;&lt;img src=y&gt;"');
    expect(html).toContain("&lt;b&gt;hot&lt;/b&gt;");
  });

  it("shows the more line only when ranked sessions are hidden", () => {
    const h = mount();
    h.send(payload());
    expect(h.root.innerHTML).toContain('<div class="more">+ 3 more sessions</div>');
    h.send(payload({ more: 1 }));
    expect(h.root.innerHTML).toContain('<div class="more">+ 1 more session</div>');
    h.send(payload({ more: 0 }));
    expect(h.root.innerHTML).not.toContain('class="more"');
  });

  it("shows the empty message instead of the list and keeps the buttons, headline and note", () => {
    const h = mount();
    h.send(payload({ rows: [], more: 0 }));
    const html = h.root.innerHTML;
    expect(html).toContain('<div class="empty">No Claude Code usage in this window yet.</div>');
    expect(rowsOf(html)).toHaveLength(0);
    expect(buttonsOf(html)).toHaveLength(4);
    expect(html).toContain('class="head"');
    expect(html).toContain('class="note"');
  });

  it("posts the window when a window button is pressed", () => {
    const h = mount();
    h.send(payload());
    expect(h.root.innerHTML).toContain('data-ms="300000"');
    h.click(h.el({ ms: "300000" }));
    expect(h.posted).toEqual([{ type: "window", ms: 300000 }]);
  });

  it("opens a row with an openId by click, by a click inside it, and by Enter or Space", () => {
    const h = mount();
    h.send(payload());
    const [first] = rowsOf(h.root.innerHTML);
    expect(first).toContain('data-id="open-1" tabindex="0" role="button"');
    const target = h.el({ id: "open-1" });
    h.click(target);
    h.click(h.el({}, target));
    expect(h.key(target, "Enter")).toBe(true);
    expect(h.key(target, " ")).toBe(true);
    expect(h.key(target, "a")).toBe(false);
    expect(h.posted).toEqual(Array(4).fill({ type: "open", id: "open-1" }));
  });

  it("leaves a row without an openId inert: not focusable and posting nothing", () => {
    const h = mount();
    h.send(payload());
    const [, second] = rowsOf(h.root.innerHTML);
    expect(second).not.toMatch(/data-id|tabindex|role="button"/);
    const target = h.el({});
    h.click(target);
    h.click(h.el({}, target));
    expect(h.key(target, "Enter")).toBe(false);
    expect(h.posted).toEqual([]);
  });
});

function fakeView() {
  const posted: unknown[] = [];
  let listener: ((m: unknown) => void) | undefined;
  const webview = {
    options: {} as unknown,
    html: "",
    postMessage: (m: unknown) => { posted.push(m); return Promise.resolve(true); },
    onDidReceiveMessage: (fn: (m: unknown) => void) => { listener = fn; return { dispose: () => undefined }; },
  };
  const view = { webview } as unknown as Parameters<BurnView["resolveWebviewView"]>[0];
  return { view, webview, posted, send: (m: unknown) => listener?.(m) };
}

describe("BurnView provider", () => {
  it("replays the pending payload on resolve and forwards only well-formed messages", () => {
    const actions: Array<[string, string]> = [];
    const provider = new BurnView((action, value) => { actions.push([action, value]); });
    const first = payload();
    provider.update(first);
    const f = fakeView();
    provider.resolveWebviewView(f.view);
    expect(f.webview.options).toEqual({ enableScripts: true });
    expect(f.webview.html).toContain("<script nonce=");
    expect(f.posted).toEqual([first]);
    const next = payload({ more: 0 });
    provider.update(next);
    expect(f.posted).toEqual([first, next]);
    const again = fakeView();
    provider.resolveWebviewView(again.view);
    expect(again.posted).toEqual([next]);

    const malformed = [null, undefined, "open", 42, {}, { type: "open" }, { type: "open", id: "" }, { type: "open", id: 7 },
      { type: "window" }, { type: "window", ms: "900000" }, { type: "window", ms: Number.NaN }, { type: "window", ms: -1 },
      { type: "delete", id: "s1" }];
    for (const m of malformed) again.send(m);
    expect(actions).toEqual([]);
    again.send({ type: "window", ms: 300000 });
    again.send({ type: "open", id: "open-1" });
    expect(actions).toEqual([["window", "300000"], ["open", "open-1"]]);
  });
});
