import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "fs";

// Isolate the extension from the real home: core derives its dirs from os.homedir().
const HOME = "/tmp/csm-ext-test";

const rec = vi.hoisted(() => ({
  commands: new Map<string, (...a: any[]) => any>(),
  treeViews: [] as any[],
  webviews: [] as any[],
  statusBars: [] as any[],
}));

vi.mock("os", async (orig) => {
  const real = await orig<typeof import("os")>();
  return { ...real, homedir: () => "/tmp/csm-ext-test", userInfo: () => ({ username: "tester" }) };
});

// No real process spawns (keychain / ps / osascript).
vi.mock("child_process", () => ({
  execFile: (...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(new Error("mocked"), "", "");
    return { on() {} } as any;
  },
}));

vi.mock("vscode", () => {
  class EventEmitter {
    private ls: any[] = [];
    event = (l: any) => {
      this.ls.push(l);
      return { dispose() {} };
    };
    fire(e?: any) {
      for (const l of this.ls) l(e);
    }
  }
  class TreeItem {
    description: any;
    tooltip: any;
    iconPath: any;
    contextValue: any;
    command: any;
    constructor(
      public label: any,
      public collapsibleState?: any,
    ) {}
  }
  class ThemeIcon {
    constructor(
      public id: string,
      public color?: any,
    ) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
    window: {
      createTreeView: (id: string) => {
        const tv: any = { id, badge: undefined, message: undefined, dispose() {} };
        rec.treeViews.push(tv);
        return tv;
      },
      registerWebviewViewProvider: (id: string, p: any) => {
        rec.webviews.push({ id, p });
        return { dispose() {} };
      },
      createStatusBarItem: () => {
        const s: any = { text: "", tooltip: "", command: "", backgroundColor: undefined, show() {}, dispose() {} };
        rec.statusBars.push(s);
        return s;
      },
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showErrorMessage: () => Promise.resolve(undefined),
      showTextDocument: () => Promise.resolve(undefined),
      tabGroups: { all: [], activeTabGroup: { activeTab: undefined } },
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, def: any) => def }),
      workspaceFolders: undefined,
      openTextDocument: () => Promise.resolve({}),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id: string, fn: any) => {
        rec.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: () => Promise.resolve(undefined),
    },
  };
});

(globalThis as any).fetch = vi.fn(() => Promise.reject(new Error("mocked")));

import * as ext from "../src/extension";

beforeAll(() => {
  fs.mkdirSync(`${HOME}/.claude/session-monitor`, { recursive: true });
  fs.mkdirSync(`${HOME}/.claude/projects`, { recursive: true });
});
afterAll(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkCtx(): any {
  const state = new Map<string, unknown>();
  return {
    subscriptions: [],
    globalState: {
      get: (k: string, def?: unknown) => (state.has(k) ? state.get(k) : def),
      update: (k: string, v: unknown) => {
        state.set(k, v);
        return Promise.resolve();
      },
    },
    secrets: {
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
  };
}

let lastCtx: any;
afterEach(() => {
  for (const d of lastCtx?.subscriptions ?? []) {
    try {
      d.dispose?.();
    } catch {
      /* ignore */
    }
  }
  rec.commands.clear();
  rec.treeViews.length = 0;
  rec.webviews.length = 0;
  rec.statusBars.length = 0;
});

const REQUIRED_COMMANDS = [
  "refresh",
  "focus",
  "toggleWorkspaceOnly",
  "toggleNeedsYouOnly",
  "clearEnded",
  "removeSession",
  "dumpTabs",
  "stopResumeAll",
  "resumeAll",
  "openTranscript",
  "openSession",
  "refreshUsage",
  "forgetOtherAccounts",
];

describe("extension activate()", () => {
  it("wires the tree, webview, status bar and all commands without throwing", () => {
    lastCtx = mkCtx();
    expect(() => ext.activate(lastCtx)).not.toThrow();
    const ids = [...rec.commands.keys()];
    for (const c of REQUIRED_COMMANDS) {
      expect(ids).toContain(`claudeSessionMonitor.${c}`);
    }
    expect(rec.treeViews).toHaveLength(0); // the sessions list is a webview table now
    expect(rec.webviews.some((w) => w.id === "claudeSessionMonitor.view")).toBe(true);
    expect(rec.webviews.some((w) => w.id === "claudeSessionMonitor.limits")).toBe(true);
    expect(rec.statusBars).toHaveLength(1);
  });

  it("refresh and openSession run without throwing on an empty home", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    expect(() => rec.commands.get("claudeSessionMonitor.refresh")!()).not.toThrow();
    await rec.commands.get("claudeSessionMonitor.openSession")!({
      title: "x",
      sessionId: "s",
      bucket: "working",
      sub: "working",
      transcriptPath: `${HOME}/x.jsonl`,
    });
    expect(rec.statusBars[0].text).toContain("$(pulse)");
  });

  it("deactivate() does not throw", () => {
    expect(() => ext.deactivate()).not.toThrow();
  });
});
