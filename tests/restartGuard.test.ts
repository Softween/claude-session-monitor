import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  config: new Map<string, unknown>(),
  groups: [] as any[],
  focused: undefined as any, // tabGroups.activeTabGroup; the first group when unset
  closed: [] as any[][],
  executed: [] as Array<{ id: string; args: any[] }>,
  onExecute: null as null | ((id: string, args: any[]) => void),
  commands: new Map<string, (...a: any[]) => any>(),
  configListeners: [] as Array<(e: any) => void>,
  providers: [] as Array<{ viewType: string; provider: any; options: any }>,
  tabListeners: [] as Array<(e: any) => void>,
  windowListeners: [] as Array<(e: any) => void>,
  windowFocused: true,
}));

vi.mock("vscode", () => {
  class TabInputCustom {
    constructor(
      public uri: unknown,
      public viewType: string,
    ) {}
  }
  class TabInputText {
    constructor(public uri: unknown) {}
  }
  return {
    TabInputCustom,
    TabInputText,
    ViewColumn: { One: 1 },
    Uri: { file: (p: string) => ({ scheme: "file", fsPath: p }) },
    window: {
      tabGroups: {
        get all() {
          return env.groups;
        },
        get activeTabGroup() {
          return env.focused ?? env.groups[0];
        },
        close: async (tabs: any[]) => {
          env.closed.push(tabs);
          return true;
        },
        onDidChangeTabs: (listener: (e: any) => void) => {
          env.tabListeners.push(listener);
          return { dispose() {} };
        },
      },
      get state() {
        return { focused: env.windowFocused };
      },
      onDidChangeWindowState: (listener: (e: any) => void) => {
        env.windowListeners.push(listener);
        return { dispose() {} };
      },
      registerCustomEditorProvider: (viewType: string, provider: any, options: any) => {
        env.providers.push({ viewType, provider, options });
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (id: string, fn: any) => {
        env.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id: string, ...args: any[]) => {
        env.executed.push({ id, args });
        env.onExecute?.(id, args);
      },
    },
    workspace: {
      getConfiguration: () => ({ get: (key: string, def: unknown) => (env.config.has(key) ? env.config.get(key) : def) }),
      onDidChangeConfiguration: (listener: (e: any) => void) => {
        env.configListeners.push(listener);
        return { dispose() {} };
      },
    },
  };
});

import * as vscode from "vscode";
import {
  GUARD_FILE_NAME,
  GUARD_VIEW_TYPE,
  GuardEditorProvider,
  OPEN_GUARD_COMMAND,
  activateRestartGuard,
  ensureGuardFile,
  findGuardTab,
  guardHtml,
  isGuardTab,
} from "../src/restartGuard";

afterEach(() => {
  env.config.clear();
  env.groups = [];
  env.focused = undefined;
  env.closed.length = 0;
  env.executed.length = 0;
  env.onExecute = null;
  env.commands.clear();
  env.configListeners.length = 0;
  env.providers.length = 0;
  env.tabListeners.length = 0;
  env.windowListeners.length = 0;
  env.windowFocused = true;
  vi.useRealTimers();
});

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "csm-guard-"));
const guardTab = (uri: unknown = { fsPath: "/g/x.claudeguard" }): any => ({ input: new vscode.TabInputCustom(uri as any, GUARD_VIEW_TYPE) });
const textTab = () => ({ input: new vscode.TabInputText({ fsPath: "/w/a.txt" } as any) });
/** Puts tabs into an editor group whose active tab is the first; each tab points back at its group like vscode.Tab.group. */
const group = (viewColumn: number, ...tabs: any[]) => {
  const g: any = { viewColumn, tabs, activeTab: tabs[0] };
  for (const t of tabs) t.group = g;
  return g;
};
const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => setImmediate(r));
};

function fakePanel() {
  const disposeListeners: Array<() => void> = [];
  return {
    webview: { options: {} as any, html: "" },
    onDidDispose: (l: () => void) => {
      disposeListeners.push(l);
      return { dispose() {} };
    },
    dispose: () => disposeListeners.forEach((l) => l()),
  };
}

const MRU_BACK = "workbench.action.openPreviousRecentlyUsedEditorInGroup";

/** Like VS Code, vscode.openWith makes the guard tab its group's active tab, adding it when the group has none. */
function showGuard(uri: unknown, viewColumn: number): void {
  const g = env.groups.find((x) => x.viewColumn === viewColumn);
  if (!g) return;
  let tab = g.tabs.find((t: any) => isGuardTab(t));
  if (!tab) {
    tab = guardTab(uri);
    tab.group = g;
    g.tabs.push(tab);
  }
  g.activeTab = tab;
}

/** Activates the guard with recording deps; `resolveOnOpen` makes vscode.openWith resolve the editor like VS Code does. */
function activate(dir: string, resolveOnOpen = true) {
  const calls: string[] = [];
  env.onExecute = (id, args) => {
    calls.push(id);
    if (id !== "vscode.openWith") return;
    showGuard(args[0], args[2].viewColumn);
    if (resolveOnOpen) env.providers[0].provider.resolveCustomTextEditor({}, fakePanel());
  };
  const ctx: any = { subscriptions: [], globalStorageUri: { fsPath: dir } };
  activateRestartGuard(ctx, {
    log: (m) => calls.push(`log ${m}`),
    focusGroup: async (i) => {
      calls.push(`focus ${i}`);
    },
  });
  return { calls, ctx };
}

const opens = () => env.executed.filter((e) => e.id === "vscode.openWith").length;
const fireTabsClosed = (...closed: any[]) => env.tabListeners.forEach((l) => l({ opened: [], closed, changed: [] }));
const fireWindow = (focused: boolean) => {
  env.windowFocused = focused;
  env.windowListeners.forEach((l) => l({ focused }));
};
/** Closes the guard tab like the user would: it leaves its group and the group's first tab becomes active. */
const closeGuardTab = (g: any): void => {
  const guard = g.tabs.find((t: any) => isGuardTab(t));
  g.tabs = g.tabs.filter((t: any) => t !== guard);
  g.activeTab = g.tabs[0];
  fireTabsClosed(guard);
};
const fireConfig = (key: string) => env.configListeners.forEach((l) => l({ affectsConfiguration: (k: string) => k === key }));

describe("guard page and file", () => {
  it("is static HTML: no script, a CSP that only allows inline styles", () => {
    const html = guardHtml();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline';"`);
    expect(html).toContain("Claude restart guard");
    expect(html).toContain("claudeSessionMonitor.restartGuard");
  });

  it("matches the package.json contributions", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    const editor = pkg.contributes.customEditors.find((e: any) => e.viewType === GUARD_VIEW_TYPE);
    expect(editor.selector).toEqual([{ filenamePattern: "*.claudeguard" }]);
    expect(GUARD_FILE_NAME).toBe("Restart stops Claude sessions.claudeguard");
    expect(pkg.contributes.configuration.properties["claudeSessionMonitor.restartGuard"].default).toBe(false);
    expect(pkg.contributes.commands.map((c: any) => c.command)).toContain(OPEN_GUARD_COMMAND);
  });

  it("writes the guard file once and keeps an existing one", () => {
    const dir = path.join(tmpDir(), "globalStorage");
    const file = ensureGuardFile(dir);
    expect(file).toBe(path.join(dir, GUARD_FILE_NAME));
    expect(fs.readFileSync(file, "utf8")).toContain("claudeSessionMonitor.restartGuard");
    fs.writeFileSync(file, "kept");
    expect(ensureGuardFile(dir)).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe("kept");
  });
});

describe("guard tab detection", () => {
  it("knows the guard editor's tab and nothing else", () => {
    expect(isGuardTab(guardTab() as any)).toBe(true);
    expect(isGuardTab({ input: new vscode.TabInputCustom({} as any, "other.viewType") } as any)).toBe(false);
    expect(isGuardTab(textTab() as any)).toBe(false);
    expect(isGuardTab({ input: undefined } as any)).toBe(false);
  });

  it("finds the guard tab in any group", () => {
    const guard = guardTab();
    expect(findGuardTab([group(1, textTab()), group(2, textTab(), guard)] as any)).toBe(guard);
    expect(findGuardTab([group(1, textTab())] as any)).toBeUndefined();
  });
});

describe("GuardEditorProvider", () => {
  it("renders the page without scripts and is live until the editor closes", () => {
    const provider = new GuardEditorProvider();
    const panel = fakePanel();
    provider.resolveCustomTextEditor({} as any, panel as any);
    expect(panel.webview.options).toEqual({ enableScripts: false });
    expect(panel.webview.html).toBe(guardHtml());
    expect(provider.live).toBe(true);
    panel.dispose();
    expect(provider.live).toBe(false);
  });

  it("reports the next resolve, or false after the timeout", async () => {
    vi.useFakeTimers();
    const provider = new GuardEditorProvider();
    const next = provider.nextResolve(10_000);
    provider.resolveCustomTextEditor({} as any, fakePanel() as any);
    await expect(next).resolves.toBe(true);
    const missed = provider.nextResolve(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(missed).resolves.toBe(false);
  });
});

describe("activateRestartGuard", () => {
  beforeEach(() => env.config.set("restartGuard", true)); // off by default; these tests turn it on
  it("opens the guard in the first group without focus, and once it is resolved takes one most-recently-used step back", async () => {
    const dir = tmpDir();
    const prev = textTab();
    const g = group(1, textTab(), prev);
    g.activeTab = prev;
    env.groups = [g];
    const { calls } = activate(dir, false);
    await flush();
    expect(env.providers[0]).toMatchObject({ viewType: GUARD_VIEW_TYPE, options: { supportsMultipleEditorsPerDocument: false } });
    expect(calls).toEqual(["vscode.openWith"]); // nothing moves until the editor is resolved
    const [uri, viewType, options] = env.executed[0].args;
    expect(uri.fsPath).toBe(path.join(dir, GUARD_FILE_NAME));
    expect(viewType).toBe(GUARD_VIEW_TYPE);
    expect(options).toEqual({ viewColumn: 1, preview: false, preserveFocus: true });

    env.providers[0].provider.resolveCustomTextEditor({}, fakePanel());
    await flush();
    expect(calls).toEqual(["vscode.openWith", "focus 0", MRU_BACK, "log restart guard: tab opened"]);
  });

  it("steps back in the guard's group, then gives the focus back to the group that had it", async () => {
    const other = group(2, textTab());
    env.groups = [group(1, textTab()), other];
    env.focused = other;
    const { calls } = activate(tmpDir());
    await flush();
    expect(calls).toEqual(["vscode.openWith", "focus 0", MRU_BACK, "focus 1", "log restart guard: tab opened"]);
  });

  it("shows a restored guard tab once in its own group, and leaves it alone after it is resolved", async () => {
    const restored = guardTab({ fsPath: "/elsewhere/x.claudeguard" });
    env.groups = [group(1, textTab()), group(2, textTab(), restored)];
    const { calls } = activate(tmpDir());
    await flush();
    expect(calls).toEqual(["vscode.openWith", "focus 1", MRU_BACK, "focus 0", "log restart guard: restored tab shown once"]);
    expect(env.executed[0].args[0]).toBe(restored.input.uri);
    expect(env.executed[0].args[2]).toMatchObject({ viewColumn: 2, preserveFocus: true });

    fireConfig("claudeSessionMonitor.restartGuard");
    await flush();
    expect(calls).toHaveLength(5);
    expect(env.executed).toHaveLength(2);
  });

  it("takes no step back when the guard's group had no active tab", async () => {
    env.groups = [group(1)];
    const { calls } = activate(tmpDir());
    await flush();
    expect(calls).toEqual(["vscode.openWith", "log restart guard: tab opened"]);
  });

  it("takes no step back when the restored guard tab already was its group's active tab", async () => {
    const restored = guardTab();
    const g = group(1, textTab(), restored);
    g.activeTab = restored;
    env.groups = [g];
    const { calls } = activate(tmpDir());
    await flush();
    expect(calls).toEqual(["vscode.openWith", "log restart guard: restored tab shown once"]);
  });

  it("still steps back and logs when the editor does not resolve in time", async () => {
    vi.useFakeTimers();
    env.groups = [group(1, textTab())];
    const { calls } = activate(tmpDir(), false);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await flush();
    expect(calls).toEqual(["vscode.openWith", "focus 0", MRU_BACK, "log restart guard: tab opened, not resolved within 10 s"]);
  });

  it("closes only guard tabs when turned off, opens again when turned back on", async () => {
    const guard = guardTab();
    const other = textTab();
    env.groups = [group(1, other, guard)];
    env.config.set("restartGuard", false);
    const { calls } = activate(tmpDir());
    await flush();
    expect(env.closed).toEqual([[guard]]);
    expect(env.executed).toHaveLength(0);
    expect(calls).toEqual(["log restart guard: off, closed 1 tab(s)"]);

    env.groups = [group(1, other)];
    env.config.set("restartGuard", true);
    fireConfig("claudeSessionMonitor.restartGuard");
    await flush();
    expect(calls.slice(1)).toEqual(["vscode.openWith", "focus 0", MRU_BACK, "log restart guard: tab opened"]);
  });

  it("opens a closed guard tab again once the window loses focus, not while you work in it", async () => {
    const g = group(1, textTab());
    env.groups = [g];
    const { calls } = activate(tmpDir());
    await flush();
    expect(opens()).toBe(1);

    closeGuardTab(g);
    await flush();
    expect(opens()).toBe(1); // the window is focused: nothing moves under the user
    expect(calls.at(-1)).toBe("log restart guard: tab closed, opens again when the window is not focused");

    fireWindow(false);
    await flush();
    expect(calls.slice(-4)).toEqual(["vscode.openWith", "focus 0", MRU_BACK, "log restart guard: tab opened"]);
    expect(findGuardTab(env.groups)).toBeDefined();

    fireWindow(true);
    fireWindow(false);
    await flush();
    expect(opens()).toBe(2); // once per close
  });

  it("opens a closed guard tab again right away when the window is not focused", async () => {
    const g = group(1, textTab());
    env.groups = [g];
    activate(tmpDir());
    await flush();
    env.windowFocused = false;
    closeGuardTab(g);
    await flush();
    expect(opens()).toBe(2);
  });

  it("does not open it again for another tab's close or once the setting is off", async () => {
    const g = group(1, textTab());
    env.groups = [g];
    activate(tmpDir());
    await flush();
    fireTabsClosed(textTab());
    fireWindow(false);
    await flush();
    expect(opens()).toBe(1);

    fireWindow(true);
    env.config.set("restartGuard", false);
    closeGuardTab(g);
    fireWindow(false);
    await flush();
    expect(opens()).toBe(1);
  });

  it("opens the guard with focus from the command, and logs a failure instead of throwing", async () => {
    env.config.set("restartGuard", false);
    const { calls } = activate(tmpDir());
    await flush();
    await env.commands.get(OPEN_GUARD_COMMAND)!();
    await flush();
    expect(env.executed[0].args[2]).toEqual({ viewColumn: 1, preview: false, preserveFocus: false });

    env.onExecute = () => {
      throw new Error("no editor");
    };
    env.commands.get(OPEN_GUARD_COMMAND)!();
    await flush();
    expect(calls).toContain("log restart guard: open failed: no editor");
  });
});
