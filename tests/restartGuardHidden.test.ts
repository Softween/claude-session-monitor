import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  config: new Map<string, unknown>(),
  groups: [] as any[],
  panels: [] as any[], // the guard editors resolved so far
  closed: [] as any[][],
  calls: [] as string[], // commands, tab closes, debug starts and stops, log lines, in order
  commands: new Map<string, (...a: any[]) => any>(),
  configListeners: [] as Array<(e: any) => void>,
  trustListeners: [] as Array<() => void>,
  providers: [] as Array<{ viewType: string; provider: any }>,
  tabListeners: [] as Array<(e: any) => void>,
  windowListeners: [] as Array<(e: any) => void>,
  windowFocused: true,
  trusted: true,
  factories: [] as Array<{ type: string; factory: any }>,
  startListeners: [] as Array<(s: any) => void>,
  endListeners: [] as Array<(s: any) => void>,
  starts: [] as Array<{ folder: unknown; config: any; options: any }>,
  stops: [] as any[],
  startResult: (): boolean => true, // what startDebugging resolves to, or throws
  sessions: [] as any[], // the debug sessions running
  nextId: 1,
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
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose() {} };
    };
    fire(e: T): void {
      this.listeners.forEach((l) => l(e));
    }
    dispose(): void {}
  }
  class DebugAdapterInlineImplementation {
    constructor(public implementation: unknown) {}
  }
  const endSession = (s: any): void => {
    env.sessions = env.sessions.filter((x) => x !== s);
    env.endListeners.forEach((l) => l(s));
  };
  return {
    TabInputCustom,
    TabInputText,
    EventEmitter,
    DebugAdapterInlineImplementation,
    ViewColumn: { One: 1 },
    Uri: { file: (p: string) => ({ scheme: "file", fsPath: p }) },
    window: {
      tabGroups: {
        get all() {
          return env.groups;
        },
        get activeTabGroup() {
          return env.groups[0];
        },
        // Like VS Code: the tabs leave their groups, their editors are disposed and onDidChangeTabs fires.
        close: async (tabs: any[]) => {
          env.calls.push("close");
          env.closed.push(tabs);
          for (const g of env.groups) {
            g.tabs = g.tabs.filter((t: any) => !tabs.includes(t));
            if (!g.tabs.includes(g.activeTab)) g.activeTab = g.tabs[0];
          }
          env.panels.splice(0).forEach((p) => p.dispose());
          env.tabListeners.forEach((l) => l({ opened: [], closed: tabs, changed: [] }));
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
      registerCustomEditorProvider: (viewType: string, provider: any) => {
        env.providers.push({ viewType, provider });
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand: (id: string, fn: any) => {
        env.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: async (id: string, ...args: any[]) => {
        env.calls.push(id);
        if (id === "vscode.openWith") openGuardTab(args[0], args[2].viewColumn);
      },
    },
    workspace: {
      get isTrusted() {
        return env.trusted;
      },
      getConfiguration: () => ({ get: (key: string, def: unknown) => (env.config.has(key) ? env.config.get(key) : def) }),
      onDidChangeConfiguration: (listener: (e: any) => void) => {
        env.configListeners.push(listener);
        return { dispose() {} };
      },
      onDidGrantWorkspaceTrust: (listener: () => void) => {
        env.trustListeners.push(listener);
        return { dispose() {} };
      },
    },
    debug: {
      registerDebugAdapterDescriptorFactory: (type: string, factory: any) => {
        env.factories.push({ type, factory });
        return { dispose() {} };
      },
      onDidStartDebugSession: (listener: (s: any) => void) => {
        env.startListeners.push(listener);
        return { dispose() {} };
      },
      onDidTerminateDebugSession: (listener: (s: any) => void) => {
        env.endListeners.push(listener);
        return { dispose() {} };
      },
      // Like VS Code: the session's start event comes before startDebugging resolves.
      startDebugging: async (folder: unknown, config: any, options: any) => {
        env.calls.push("startDebugging");
        env.starts.push({ folder, config, options });
        if (!env.startResult()) return false;
        const s = { id: `session-${env.nextId++}`, type: config.type, name: config.name };
        env.sessions.push(s);
        env.startListeners.forEach((l) => l(s));
        return true;
      },
      stopDebugging: async (s: any) => {
        env.calls.push("stopDebugging");
        env.stops.push(s);
        endSession(s);
      },
    },
  };

  /** Like vscode.openWith: the guard tab becomes its group's active tab and its editor is resolved. */
  function openGuardTab(uri: unknown, viewColumn: number): void {
    const g = env.groups.find((x) => x.viewColumn === viewColumn);
    if (!g) return;
    let tab = g.tabs.find((t: any) => t.input instanceof TabInputCustom);
    if (!tab) {
      tab = { input: new TabInputCustom(uri, "claudeSessionMonitor.restartGuard"), group: g };
      g.tabs.push(tab);
    }
    g.activeTab = tab;
    const disposeListeners: Array<() => void> = [];
    const panel = {
      webview: { options: {}, html: "" },
      onDidDispose: (l: () => void) => {
        disposeListeners.push(l);
        return { dispose() {} };
      },
      dispose: () => disposeListeners.forEach((l) => l()),
    };
    env.panels.push(panel);
    env.providers[0].provider.resolveCustomTextEditor({}, panel);
  }
});

import * as vscode from "vscode";
import { GUARD_VIEW_TYPE, activateRestartGuard } from "../src/restartGuard";
import { GuardDebugAdapter } from "../src/restartGuardSession";

function resetEnv(): void {
  env.config.clear();
  env.groups = [];
  env.panels.length = 0;
  env.closed.length = 0;
  env.calls.length = 0;
  env.commands.clear();
  env.configListeners.length = 0;
  env.trustListeners.length = 0;
  env.providers.length = 0;
  env.tabListeners.length = 0;
  env.windowListeners.length = 0;
  env.windowFocused = true;
  env.trusted = true;
  env.factories.length = 0;
  env.startListeners.length = 0;
  env.endListeners.length = 0;
  env.starts.length = 0;
  env.stops.length = 0;
  env.startResult = () => true;
  env.sessions = [];
}

afterEach(resetEnv);

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "csm-guard-hidden-"));
const guardTab = (): any => ({ input: new vscode.TabInputCustom({ fsPath: "/g/x.claudeguard" } as any, GUARD_VIEW_TYPE) });
const textTab = () => ({ input: new vscode.TabInputText({ fsPath: "/w/a.txt" } as any) });
/** Puts tabs into an editor group whose active tab is the first; each tab points back at its group like vscode.Tab.group. */
const group = (viewColumn: number, ...tabs: any[]) => {
  const g: any = { viewColumn, tabs, activeTab: tabs[0] };
  for (const t of tabs) t.group = g;
  return g;
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};

/** Turns the guard on with the given style and activates it with recording deps. */
function activate(style: "tab" | "hidden" = "hidden") {
  env.config.set("restartGuard", true);
  env.config.set("restartGuardStyle", style);
  if (!env.groups.length) env.groups = [group(1, textTab())];
  const ctx: any = { subscriptions: [], globalStorageUri: { fsPath: tmpDir() } };
  return activateRestartGuard(ctx, {
    log: (m) => env.calls.push(`log ${m}`),
    focusGroup: async () => undefined,
    idleMs: async () => 60_000,
  });
}

const opens = () => env.calls.filter((c) => c === "vscode.openWith").length;
const logged = (line: string) => env.calls.includes(`log restart guard: ${line}`);
const fireConfig = (key: string) => env.configListeners.forEach((l) => l({ affectsConfiguration: (k: string) => k === key }));
const setStyle = (style: string) => {
  env.config.set("restartGuardStyle", style);
  fireConfig("claudeSessionMonitor.restartGuardStyle");
};
const turnOff = () => {
  env.config.set("restartGuard", false);
  fireConfig("claudeSessionMonitor.restartGuard");
};
/** Ends a running guard session the way a user's Stop or a gone adapter does: not through stopDebugging. */
const endByOthers = (s: any) => {
  env.sessions = env.sessions.filter((x) => x !== s);
  env.endListeners.forEach((l) => l(s));
};
/** The steps that arm or drop a guard, in order. */
const steps = () => env.calls.filter((c) => ["vscode.openWith", "close", "startDebugging", "stopDebugging"].includes(c));

describe("restart guard, hidden style", () => {
  it("starts the debug session with the guard's config and options and opens no tab", async () => {
    activate();
    await flush();
    expect(env.starts).toEqual([
      {
        folder: undefined,
        config: { type: "claude-restart-guard", request: "attach", name: "Claude restart guard", internalConsoleOptions: "neverOpen" },
        options: { suppressDebugToolbar: true, suppressDebugStatusbar: true, suppressDebugView: true, suppressSaveBeforeStart: true },
      },
    ]);
    expect(opens()).toBe(0);
    expect(logged("hidden session started")).toBe(true);
    expect(env.factories.map((f) => f.type)).toEqual(["claude-restart-guard"]);
    const descriptor = env.factories[0].factory.createDebugAdapterDescriptor();
    expect(descriptor).toBeInstanceOf(vscode.DebugAdapterInlineImplementation);
    expect(descriptor.implementation).toBeInstanceOf(GuardDebugAdapter);
  });

  it("closes a restored guard tab only after the session started, and does not reopen it", async () => {
    const restored = guardTab();
    env.groups = [group(1, textTab(), restored)];
    activate();
    await flush();
    expect(steps()).toEqual(["startDebugging", "close"]);
    expect(env.closed).toEqual([[restored]]);
    expect(logged("hidden session running, closed 1 tab(s)")).toBe(true);
    env.windowFocused = false;
    env.windowListeners.forEach((l) => l({ focused: false }));
    await flush();
    expect(opens()).toBe(0);
    expect(env.calls.some((c) => c.includes("opens again"))).toBe(false);
  });

  it("starts a session someone else ended again, and stops it for good when the setting goes off", async () => {
    activate();
    await flush();
    endByOthers(env.sessions[0]);
    await flush();
    expect(env.starts).toHaveLength(2);
    expect(env.sessions).toHaveLength(1);
    expect(logged("hidden session ended, starting again")).toBe(true);
    turnOff();
    await flush();
    expect(env.stops).toHaveLength(1);
    expect(env.sessions).toEqual([]);
    expect(env.starts).toHaveLength(2);
    expect(logged("off, stopped the hidden session")).toBe(true);
  });

  it("uses the tab after three sessions in a row each ended within 5 s of starting", async () => {
    activate();
    await flush();
    for (let i = 0; i < 3; i++) {
      endByOthers(env.sessions[0]);
      await flush();
    }
    expect(env.starts).toHaveLength(3);
    expect(env.sessions).toEqual([]);
    expect(opens()).toBe(1);
    expect(logged("hidden session ended within 5 s of starting 3 times in a row, using the tab")).toBe(true);
  });

  it("uses the tab and logs the reason when the session does not start", async () => {
    env.startResult = () => false;
    activate();
    await flush();
    expect(opens()).toBe(1);
    expect(logged("hidden session could not start (startDebugging returned false), using the tab")).toBe(true);
    resetEnv();
    env.startResult = () => {
      throw new Error("no debug adapter");
    };
    activate();
    await flush();
    expect(env.starts).toHaveLength(1);
    expect(opens()).toBe(1);
    expect(logged("hidden session could not start (no debug adapter), using the tab")).toBe(true);
  });

  it("uses the tab in an untrusted workspace and switches to the session once it is trusted", async () => {
    env.trusted = false;
    activate();
    await flush();
    expect(env.starts).toEqual([]);
    expect(opens()).toBe(1);
    expect(logged("hidden needs a trusted workspace, using the tab until it is trusted")).toBe(true);
    env.trusted = true;
    env.trustListeners.forEach((l) => l());
    await flush();
    expect(env.starts).toHaveLength(1);
    expect(env.closed).toHaveLength(1);
    expect(env.groups[0].tabs.some((t: any) => t.input instanceof vscode.TabInputCustom)).toBe(false);
  });

  it("arms the new style before it drops the old one when the style changes", async () => {
    activate("tab");
    await flush();
    expect(steps()).toEqual(["vscode.openWith"]);
    env.calls.length = 0;
    setStyle("hidden");
    await flush();
    expect(steps()).toEqual(["startDebugging", "close"]);
    env.calls.length = 0;
    setStyle("tab");
    await flush();
    expect(steps()).toEqual(["vscode.openWith", "stopDebugging"]);
    expect(env.sessions).toEqual([]);
    expect(env.starts).toHaveLength(1);
    expect(logged("tab in use, stopped the hidden session")).toBe(true);
  });

  it("reports armed while the session runs and not after the setting goes off", async () => {
    const state = activate();
    await flush();
    expect(opens()).toBe(0);
    expect(state.armed()).toBe(true);
    turnOff();
    await flush();
    expect(state.armed()).toBe(false);
  });

  it("answers the debug adapter protocol requests and ignores other messages", () => {
    const adapter = new GuardDebugAdapter();
    const sent: any[] = [];
    adapter.onDidSendMessage((m) => sent.push(m));
    adapter.handleMessage({ type: "request", seq: 1, command: "initialize" } as any);
    expect(sent).toEqual([
      { seq: 1, type: "response", request_seq: 1, command: "initialize", success: true, body: { supportsConfigurationDoneRequest: true } },
      { seq: 2, type: "event", event: "initialized" },
    ]);
    sent.length = 0;
    adapter.handleMessage({ type: "request", seq: 2, command: "threads" } as any);
    expect(sent).toEqual([{ seq: 3, type: "response", request_seq: 2, command: "threads", success: true, body: { threads: [] } }]);
    sent.length = 0;
    adapter.handleMessage({ type: "request", seq: 3, command: "disconnect" } as any);
    expect(sent).toEqual([
      { seq: 4, type: "response", request_seq: 3, command: "disconnect", success: true },
      { seq: 5, type: "event", event: "terminated" },
    ]);
    sent.length = 0;
    adapter.handleMessage({ type: "event", seq: 4, event: "output" } as any);
    adapter.handleMessage({ type: "response", seq: 5, request_seq: 1, command: "x", success: true } as any);
    expect(sent).toEqual([]);
  });

  it("matches the package.json contributions", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
    expect(pkg.contributes.debuggers).toContainEqual({ type: "claude-restart-guard", label: "Claude restart guard" });
    const style = pkg.contributes.configuration.properties["claudeSessionMonitor.restartGuardStyle"];
    expect(style.default).toBe("tab");
    expect(style.enum).toEqual(["tab", "hidden"]);
    expect(style.enumDescriptions).toHaveLength(2);
  });
});
