import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { hubHtml } from "../src/hub/html";

type UiEvent = { data?: unknown; key?: string; preventDefault?: () => void };

/** Small DOM boundary for exercising the generated script without a VS Code host. */
class Element {
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: UiEvent) => void>>();
  children: Element[] = [];
  textContent = "";
  value = "";
  disabled = false;
  hidden = false;
  focused = false;
  selected = false;
  tabIndex = 0;
  validationMessage = "";
  setCustomValidity(message: string): void { this.validationMessage = message; }
  setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  appendChild(element: Element): void { this.children.push(element); }
  replaceChildren(): void { this.children = []; }
  focus(): void { this.focused = true; }
  select(): void { this.selected = true; }
  addEventListener(name: string, callback: (event: UiEvent) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]);
  }
  fire(name: string, event: UiEvent = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function harness() {
  const html = hubHtml();
  const ids = new Map<string, Element>();
  const actions = new Map<string, Element>();
  const tabs: Element[] = [];
  const messages: unknown[] = [];
  let onMessage: (event: UiEvent) => void = () => {};
  const markup = html.slice(html.indexOf("<body>"), html.indexOf("<script"));
  for (const match of markup.matchAll(/<[a-z][a-z0-9]*\b([^>]*)>/g)) {
    const element = new Element();
    const attrs = Object.fromEntries(Array.from(match[1].matchAll(/([\w-]+)="([^"]*)"/g), (entry) => [entry[1], entry[2]]));
    element.disabled = /\bdisabled\b/.test(match[1]);
    if (attrs.id) ids.set(attrs.id, element);
    if (attrs["data-action"]) {
      element.dataset.action = attrs["data-action"];
      actions.set(element.dataset.action, element);
    }
    if (attrs["data-provider"]) {
      element.dataset.provider = attrs["data-provider"];
      tabs.push(element);
    }
  }
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Hub script is missing");
  runInNewContext(script, {
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => messages.push(message) }),
    document: {
      getElementById: (id: string) => ids.get(id),
      createElement: () => new Element(),
      querySelectorAll: (selector: string) => selector === "[data-provider]" ? tabs : [...actions.values()],
    },
    window: { addEventListener: (_name: string, callback: typeof onMessage) => { onMessage = callback; } },
  }, { timeout: 1000 });
  return {
    html, messages, tabs,
    element: (id: string) => ids.get(id)!,
    action: (name: string) => actions.get(name)!,
    state: (state: unknown) => onMessage({ data: state }),
  };
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    type: "state", activeProvider: "claude", workspace: { label: "my-project", trusted: true },
    providers: ["claude", "codex", "copilot"].map((id) => ({
      id, label: id === "claude" ? "Claude Code" : id, available: true,
      model: "", permissionPreset: "native", modelOptions: ["sample-model"],
      permissionOptions: [{ id: "native", label: "Provider settings" }, { id: "full", label: "Full access" }],
    })),
    ...overrides,
  };
}

describe("Agent Hub webview", () => {
  it("gives each document a fresh nonce and blocks remote scripts, assets and inline handlers", () => {
    const first = hubHtml();
    const second = hubHtml();
    const nonce = first.match(/script-src 'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(first).toContain(`<script nonce="${nonce}">`);
    expect(first).toContain(`<style nonce="${nonce}">`);
    expect(second).not.toContain(nonce);
    expect(first).toContain("default-src 'none'");
    expect(first).toContain("form-action 'none'");
    expect(first).not.toMatch(/unsafe-inline|\son\w+=|\.innerHTML\s*=|<script[^>]+src=/);
  });

  it("handshakes before receiving state and renders untrusted labels as text", () => {
    const ui = harness();
    expect(ui.messages).toEqual([{ type: "ready" }]);
    const hostileLabel = '<img src=x onerror="alert(1)">';
    const snapshot = state();
    snapshot.providers[0].label = hostileLabel;
    ui.state(snapshot);
    expect(ui.element("provider-name").textContent).toBe(hostileLabel);
    expect(ui.element("provider-name").children).toEqual([]);
    expect(ui.element("workspace").textContent).toBe("my-project");
    ui.state(state({ activeProvider: "unknown" }));
    expect(ui.element("provider-name").textContent).toBe(hostileLabel);
  });

  it("changes permissions only after Apply and preserves drafts during state refreshes", () => {
    const ui = harness();
    ui.state(state());
    ui.element("model").value = " custom-model ";
    ui.element("model").fire("input");
    ui.element("permissions").value = "full";
    ui.element("permissions").fire("change");
    expect(ui.element("permission-note").hidden).toBe(false);
    expect(ui.element("apply").disabled).toBe(false);
    expect(ui.messages).toEqual([{ type: "ready" }]);
    ui.state(state());
    expect(ui.element("model").value).toBe(" custom-model ");
    expect(ui.element("permissions").value).toBe("full");
    ui.element("settings-form").fire("submit", { preventDefault: () => {} });
    expect(ui.messages.at(-1)).toEqual({ type: "action", action: "configure", provider: "claude", model: "custom-model", permissionPreset: "full" });
  });

  it("blocks launching tools in untrusted workspaces and rejects unknown actions", () => {
    const ui = harness();
    ui.state(state({ workspace: { label: "untrusted", trusted: false } }));
    for (const name of ["start", "newSession", "login", "resume"]) {
      expect(ui.action(name).disabled).toBe(true);
      ui.action(name).fire("click");
    }
    ui.action("openUsage").dataset.action = "runArbitraryCommand";
    ui.action("openUsage").fire("click");
    expect(ui.messages).toEqual([{ type: "ready" }]);
    expect(ui.action("nativeSettings").disabled).toBe(true);
    expect(ui.element("model").disabled).toBe(true);
    expect(ui.element("permissions").disabled).toBe(true);
    ui.action("usageHelp").fire("click");
    expect(ui.messages.at(-1)).toEqual({ type: "action", action: "usageHelp", provider: "claude" });
  });

  it("does not submit malformed model IDs", () => {
    const ui = harness();
    ui.state(state());
    ui.element("model").value = "--shell-command";
    ui.element("model").fire("input");
    expect(ui.element("apply").disabled).toBe(true);
    expect(ui.element("model").validationMessage).not.toBe("");
    ui.element("settings-form").fire("submit", { preventDefault: () => {} });
    expect(ui.messages).toEqual([{ type: "ready" }]);
  });

  it("focuses session settings on request without changing or persisting them", () => {
    const ui = harness();
    ui.state(state());
    ui.element("model").value = "draft-model";
    ui.state({ type: "focusSettings" });
    expect(ui.element("model").focused).toBe(true);
    expect(ui.element("model").selected).toBe(true);
    expect(ui.element("model").value).toBe("draft-model");
    expect(ui.messages).toEqual([{ type: "ready" }]);
  });

  it("supports keyboard provider switching and never substitutes an unknown quota with zero", () => {
    const ui = harness();
    ui.state(state());
    let prevented = false;
    ui.tabs[0].fire("keydown", { key: "ArrowRight", preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);
    expect(ui.tabs[1].focused).toBe(true);
    expect(ui.messages.at(-1)).toEqual({ type: "action", action: "selectProvider", provider: "codex" });
    ui.state(state({ activeProvider: "codex" }));
    expect(ui.tabs[1].attributes["aria-selected"]).toBe("true");
    expect(ui.tabs[1].tabIndex).toBe(0);
    expect(ui.element("usage-detail").textContent).toBe("Live quotas and reset times are in Usage limits below.");
    expect(ui.element("usage-detail").textContent).not.toContain("0%");
  });
});
