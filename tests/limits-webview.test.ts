// Runs the real Usage Limits webview script (an inline <script> inside a TS
// template string, invisible to tsc) against a stub DOM, so a missing render
// helper fails here instead of leaving the panel on "Waiting for usage-limit data".
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

function webviewScript(): string {
  const src = readFileSync(join(__dirname, "..", "src", "extension.ts"), "utf8");
  const marker = src.indexOf("Waiting for usage-limit");
  const open = src.indexOf("<script", marker);
  const start = src.indexOf(">", open) + 1;
  const end = src.indexOf("</script>", start);
  if (marker < 0 || open < 0 || end < 0) throw new Error("limits webview script not found");
  return src.slice(start, end).replace(/\$\{[^}]*\}/g, "0").replace(/\\`/g, "`");
}

interface Harness { root: { innerHTML: string }; send: (data: unknown) => void }

function mount(): Harness {
  const root = { innerHTML: "", addEventListener: () => undefined };
  let onMessage: ((e: { data: unknown }) => void) | null = null;
  const sandbox = {
    document: { getElementById: () => root, documentElement: {} },
    window: { addEventListener: (_t: string, fn: (e: { data: unknown }) => void) => { onMessage = fn; } },
    acquireVsCodeApi: () => ({ postMessage: () => undefined, getState: () => ({}), setState: () => undefined }),
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
  return { root, send: (data) => send({ data }) };
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
});
