import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import * as fs from "fs";

// Isolate the extension from the real home: core derives its dirs from os.homedir().
const HOME = "/tmp/csm-ext-test";

const rec = vi.hoisted(() => ({
  commands: new Map<string, (...a: any[]) => any>(),
  config: new Map<string, unknown>(),
  configListeners: [] as Array<(event: any) => void>,
  executeCalls: [] as Array<{ id: string; args: any[] }>,
  warningMessages: [] as any[][],
  treeViews: [] as any[],
  webviews: [] as any[],
  statusBars: [] as any[],
  spawns: [] as any[],
  terminals: [] as any[],
}));

vi.mock("os", async (orig) => {
  const real = await orig<typeof import("os")>();
  return { ...real, homedir: () => "/tmp/csm-ext-test", userInfo: () => ({ username: "tester" }) };
});

// No real process spawns (keychain / ps / osascript).
vi.mock("child_process", async () => {
  const { EventEmitter } = await import("events");
  const { PassThrough } = await import("stream");
  return {
    execFile: (...args: any[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") cb(new Error("mocked"), "", "");
      return { on() {} } as any;
    },
    spawn: (...args: any[]) => {
      rec.spawns.push(args);
      const proc: any = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = vi.fn();
      queueMicrotask(() => {
        const error: NodeJS.ErrnoException = new Error(`spawn ${String(args[0])} ENOENT`);
        error.code = "ENOENT";
        proc.emit("error", error);
      });
      return proc;
    },
  };
});

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
      createTerminal: (options: any) => {
        const terminal = {
          options,
          shown: false,
          show() {
            terminal.shown = true;
          },
        };
        rec.terminals.push(terminal);
        return terminal;
      },
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: (...args: any[]) => {
        rec.warningMessages.push(args);
        return Promise.resolve(undefined);
      },
      showErrorMessage: () => Promise.resolve(undefined),
      setStatusBarMessage: () => ({ dispose() {} }),
      showTextDocument: () => Promise.resolve(undefined),
      tabGroups: { all: [], activeTabGroup: { activeTab: undefined } },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: any) => (rec.config.has(key) ? rec.config.get(key) : def),
      }),
      workspaceFolders: undefined,
      openTextDocument: () => Promise.resolve({}),
      onDidChangeConfiguration: (listener: any) => {
        rec.configListeners.push(listener);
        return {
          dispose() {
            const i = rec.configListeners.indexOf(listener);
            if (i >= 0) rec.configListeners.splice(i, 1);
          },
        };
      },
    },
    commands: {
      registerCommand: (id: string, fn: any) => {
        rec.commands.set(id, fn);
        return { dispose() {} };
      },
      executeCommand: (id: string, ...args: any[]) => {
        rec.executeCalls.push({ id, args });
        return Promise.resolve(undefined);
      },
    },
  };
});

(globalThis as any).fetch = vi.fn(() => Promise.reject(new Error("mocked")));

import * as ext from "../src/extension";

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(`${HOME}/.claude/projects`, { recursive: true });
  rec.config.clear();
  rec.config.set("enableCodex", false);
});
afterAll(() => {
  try {
    fs.rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkCtx(state = new Map<string, unknown>()): any {
  return {
    subscriptions: [],
    state,
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

function disposeCtx(ctx: any): void {
  for (const d of ctx?.subscriptions ?? []) {
    try {
      d.dispose?.();
    } catch {
      /* ignore */
    }
  }
}

function fireConfigurationChange(...keys: string[]): void {
  const changed = new Set(keys);
  for (const listener of [...rec.configListeners]) {
    listener({ affectsConfiguration: (key: string) => changed.has(key) });
  }
}

async function settleAsync(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

let lastCtx: any;
afterEach(() => {
  disposeCtx(lastCtx);
  rec.commands.clear();
  rec.config.clear();
  rec.configListeners.length = 0;
  rec.executeCalls.length = 0;
  rec.warningMessages.length = 0;
  rec.treeViews.length = 0;
  rec.webviews.length = 0;
  rec.statusBars.length = 0;
  rec.spawns.length = 0;
  rec.terminals.length = 0;
  lastCtx = undefined;
  vi.useRealTimers();
});

const REQUIRED_COMMANDS = [
  "refresh",
  "focus",
  "toggleWorkspaceOnly",
  "toggleNeedsYouOnly",
  "toggleProvider",
  "clearEnded",
  "removeSession",
  "dumpTabs",
  "stopResumeAll",
  "resumeAll",
  "setModelAll",
  "setEffortAll",
  "openTranscript",
  "openSession",
  "resumeSession",
  "focusNextNeedsYou",
  "copySessionId",
  "revealCwd",
  "killProcess",
  "refreshUsage",
  "forgetOtherAccounts",
];

describe("extension activate()", () => {
  it("creates private monitor dirs on a fresh activation without an automatic tab dump", () => {
    vi.useFakeTimers();
    const claudeDir = `${HOME}/.claude/session-monitor`;
    const codexDir = `${HOME}/.codex/session-monitor`;
    expect(fs.existsSync(claudeDir)).toBe(false);
    expect(fs.existsSync(codexDir)).toBe(false);

    lastCtx = mkCtx();
    ext.activate(lastCtx);

    expect(fs.statSync(claudeDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(codexDir).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(`${claudeDir}/tabs-debug.json`)).toBe(false);
    vi.advanceTimersByTime(6000);
    expect(fs.existsSync(`${claudeDir}/tabs-debug.json`)).toBe(false);
  });

  it("writes an explicit tab dump as a private 0600 file", () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const file = `${HOME}/.claude/session-monitor/tabs-debug.json`;
    expect(fs.existsSync(file)).toBe(false);

    rec.commands.get("claudeSessionMonitor.dumpTabs")!();

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({ groups: [] });
  });

  it("silently seeds a working session that was already stale at startup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    const monitorDir = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(
      `${monitorDir}/stale-at-start.json`,
      JSON.stringify({
        session_id: "stale-at-start",
        provider: "claude",
        state: "working",
        event: "UserPromptSubmit",
        ts: Date.now() / 1000 - 10 * 60,
        cwd: "/workspace",
      }),
    );

    lastCtx = mkCtx();
    ext.activate(lastCtx);
    vi.advanceTimersByTime(5000);

    expect(
      rec.warningMessages.some((args) => String(args[0]).includes("Possibly stuck")),
    ).toBe(false);
  });

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
    expect(rec.spawns).toHaveLength(0);
  });

  it("refresh and openSession run without throwing on an empty home", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    expect(() => rec.commands.get("claudeSessionMonitor.refresh")!()).not.toThrow();
    await rec.commands.get("claudeSessionMonitor.openSession")!({
      key: "claude:s",
      provider: "claude",
      title: "x",
      sessionId: "s",
      bucket: "working",
      sub: "working",
      capabilities: {
        focus: true,
        transcript: true,
        resume: true,
        kill: false,
        bulkInput: true,
      },
      transcriptPath: `${HOME}/x.jsonl`,
      tooltip: "",
      detail: "",
      lastActivityMs: Date.now(),
      stale: false,
      matchLabels: ["x"],
    });
    expect(rec.statusBars[0].text).toContain("$(pulse)");
  });

  it("persists a hidden ended Codex dismissal across activation reloads", async () => {
    const sessionId = "ended-codex-hidden";
    const codexDir = `${HOME}/.codex/session-monitor`;
    const statusFile = `${codexDir}/${sessionId}.json`;
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      statusFile,
      JSON.stringify({
        session_id: sessionId,
        provider: "codex",
        state: "ended",
        ts: Date.now() / 1000,
      }),
    );
    const sharedState = new Map<string, unknown>();

    const firstCtx = mkCtx(sharedState);
    lastCtx = firstCtx;
    ext.activate(firstCtx);
    await rec.commands.get("claudeSessionMonitor.clearEnded")!();

    const persisted = sharedState.get("dismissedSessionsV2") as Array<{
      key: string;
      at: number;
    }>;
    expect(persisted).toEqual([
      { key: `codex:${sessionId}`, at: expect.any(Number) },
    ]);
    expect(fs.existsSync(statusFile)).toBe(false);

    disposeCtx(firstCtx);
    lastCtx = mkCtx(sharedState);
    ext.activate(lastCtx);
    rec.commands.get("claudeSessionMonitor.refresh")!();

    expect(sharedState.get("dismissedSessionsV2")).toEqual(persisted);
  });

  it("removes a persisted tombstone after newer live activity", () => {
    const sessionId = "active-after-dismissal";
    const now = Date.now();
    const sharedState = new Map<string, unknown>([
      [
        "dismissedSessionsV2",
        [{ key: `claude:${sessionId}`, at: now - 10_000 }],
      ],
    ]);
    const monitorDir = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(
      `${monitorDir}/${sessionId}.json`,
      JSON.stringify({
        session_id: sessionId,
        provider: "claude",
        state: "working",
        ts: now / 1000,
        cwd: "/tmp/new-activity",
      }),
    );

    lastCtx = mkCtx(sharedState);
    ext.activate(lastCtx);

    expect(sharedState.get("dismissedSessionsV2")).toEqual([]);
  });

  it("backs off automatic Codex retries after a missing CLI but manual refresh forces one", async () => {
    rec.config.set("enableClaude", false);
    rec.config.set("enableCodex", true);
    rec.config.set("codexPollSeconds", 5);
    rec.config.set("codexExecutable", "/missing/codex");
    lastCtx = mkCtx();

    ext.activate(lastCtx);
    await settleAsync();
    expect(rec.spawns).toHaveLength(1);
    expect(rec.spawns[0].slice(0, 2)).toEqual([
      "/missing/codex",
      ["app-server", "--stdio"],
    ]);

    rec.commands.get("claudeSessionMonitor.refresh")!();
    rec.commands.get("claudeSessionMonitor.refresh")!();
    await settleAsync();
    expect(rec.spawns).toHaveLength(1);

    await rec.commands.get("claudeSessionMonitor.refreshUsage")!();
    expect(rec.spawns).toHaveLength(2);
  });

  it("cancels a scheduled auto-resume when Claude is disabled", () => {
    vi.useFakeTimers();
    const now = new Date("2030-01-01T00:00:00.000Z");
    vi.setSystemTime(now);
    const monitorDir = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(monitorDir, { recursive: true });
    fs.writeFileSync(
      `${monitorDir}/official-usage.json`,
      JSON.stringify({
        gauges: [
          {
            key: "session",
            label: "Session",
            pct: 99,
            resetMs: now.getTime() + 10_000,
          },
        ],
        ts: now.getTime() / 1000,
      }),
    );
    rec.config.set("enableClaude", true);
    rec.config.set("autoResumeAfterReset", true);
    lastCtx = mkCtx();

    ext.activate(lastCtx);
    expect(fs.readFileSync(`${monitorDir}/csm-debug.log`, "utf8")).toContain(
      "auto-resume scheduled",
    );

    rec.config.set("enableClaude", false);
    fireConfigurationChange("claudeSessionMonitor.enableClaude");
    vi.advanceTimersByTime(120_000);

    expect(
      rec.executeCalls.filter(
        ({ id }) => id === "claudeSessionMonitor.resumeAll",
      ),
    ).toHaveLength(0);
  });

  it("resumes each provider with shellPath and an unescaped shellArgs array", () => {
    rec.config.set("codexExecutable", "/opt/Codex Bin/codex");
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const resume = rec.commands.get("claudeSessionMonitor.resumeSession")!;

    resume({
      key: "codex:unused",
      provider: "codex",
      sessionId: `codex id with 'quotes'`,
      title: "Codex session",
      cwd: "/tmp/codex workspace",
    });
    resume({
      key: "claude:unused",
      provider: "claude",
      sessionId: `claude id with "quotes"`,
      title: "Claude session",
      cwd: "/tmp/claude workspace",
    });

    expect(rec.terminals).toHaveLength(2);
    expect(rec.terminals[0]).toMatchObject({
      shown: true,
      options: {
        cwd: "/tmp/codex workspace",
        shellPath: "/opt/Codex Bin/codex",
        shellArgs: ["resume", `codex id with 'quotes'`],
      },
    });
    expect(rec.terminals[1]).toMatchObject({
      shown: true,
      options: {
        cwd: "/tmp/claude workspace",
        shellPath: "claude",
        shellArgs: ["--resume", `claude id with "quotes"`],
      },
    });
  });

  it("deactivate() does not throw", () => {
    expect(() => ext.deactivate()).not.toThrow();
  });
});
