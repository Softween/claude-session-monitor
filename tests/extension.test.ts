import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { EventEmitter } from "events";
import * as fs from "fs";

// Isolate the extension from the real home: core derives its dirs from os.homedir().
const HOME = "/tmp/csm-ext-test";

const rec = vi.hoisted(() => ({
  commands: new Map<string, (...a: any[]) => any>(),
  config: new Map<string, unknown>(),
  globals: new Map<string, unknown>(), // user (global) setting values, as inspect() reports them (the remote.* settings)
  configListeners: [] as Array<(event: any) => void>,
  executeCalls: [] as Array<{ id: string; args: any[] }>,
  warningMessages: [] as any[][],
  treeViews: [] as any[],
  webviews: [] as any[],
  statusBars: [] as any[],
  spawns: [] as any[],
  terminals: [] as any[],
  closeListeners: [] as Array<(terminal: any) => void>,
  bridgeDeps: null as any, // the remote bridge's deps, captured by the pass-through mock below
  execFileImpl: null as null | ((args: any[]) => boolean), // returns true when it handled the call
  spawnImpl: null as null | ((args: any[]) => any), // returns the child when it handled the call
  statusMessages: [] as string[],
  execFiles: [] as any[][], // every execFile call, handled or not
  infoMessages: [] as string[],
  outputChannels: [] as Array<{ name: string; lines: string[] }>,
  customEditors: [] as string[], // registered custom editor view types (the restart guard's)
  // The Claude Code extension the automation gate checks (automationGate.ts): installed, running, with its commands.
  claudeCode: { version: "2.1.327", active: true } as { version: string; active: boolean } | null,
  claudeCommands: ["claude-vscode.editor.open", "claude-vscode.focus"] as string[],
  extensionListeners: [] as Array<() => void>,
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
      rec.execFiles.push(args);
      const cb = args[args.length - 1];
      if (rec.execFileImpl?.(args)) return { on() {} } as any;
      if (typeof cb === "function") cb(new Error("mocked"), "", "");
      return { on() {} } as any;
    },
    spawn: (...args: any[]) => {
      rec.spawns.push(args);
      const custom = rec.spawnImpl?.(args);
      if (custom) return custom;
      const proc: any = new EventEmitter();
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = vi.fn();
      proc.unref = vi.fn();
      queueMicrotask(() => {
        const error: NodeJS.ErrnoException = new Error(`spawn ${String(args[0])} ENOENT`);
        error.code = "ENOENT";
        proc.emit("error", error);
      });
      return proc;
    },
  };
});

// No real fs watchers: each fs.watch call is recorded (watched dir + listener) and a test fires it.
// Every write still runs, and is recorded with its path arguments in `writes` (observer mode asserts there is none).
const watchRec = vi.hoisted(() => ({ watchers: [] as Array<{ dir: string; fire: (event: string, name: string | null) => void }>, writes: [] as string[] }));
vi.mock("fs", async (orig) => {
  const real = await orig<typeof import("fs")>();
  const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = real.constants;
  const writing = (flags: unknown): boolean =>
    typeof flags === "number" ? (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0 : typeof flags === "string" && !/^(r|rs|sr)$/.test(flags);
  const note = (name: string, args: unknown[]): void => {
    watchRec.writes.push(`${name} ${args.filter((a) => typeof a === "string").join(" ")}`);
  };
  const recorded = (name: string, fn: (...a: any[]) => any) => (...args: any[]) => {
    note(name, args);
    return fn(...args);
  };
  const promises: any = { ...real.promises };
  const writers: any = {};
  for (const name of ["writeFile", "appendFile", "rename", "unlink", "rm", "rmdir", "mkdir", "chmod", "copyFile", "symlink", "link", "truncate", "utimes", "cp"]) {
    const sync = `${name}Sync`;
    if (typeof (real as any)[sync] === "function") writers[sync] = recorded(sync, (real as any)[sync]);
    if (typeof (real as any)[name] === "function") writers[name] = recorded(name, (real as any)[name]);
    if (typeof (real.promises as any)[name] === "function") promises[name] = recorded(`promises.${name}`, (real.promises as any)[name].bind(real.promises));
  }
  promises.open = (p: any, flags?: any, ...rest: any[]) => {
    if (writing(flags)) note("promises.open", [p]);
    return real.promises.open(p, flags, ...rest);
  };
  return {
    ...real,
    ...writers,
    promises,
    openSync: (p: any, flags?: any, ...rest: any[]) => {
      if (writing(flags)) note("openSync", [p]);
      return real.openSync(p, flags, ...rest);
    },
    watch: (dir: string, ...rest: any[]) => {
      const listener = rest[rest.length - 1];
      const watcher = { on: () => watcher, close() {} };
      watchRec.watchers.push({ dir: String(dir), fire: (event, name) => listener(event, name) });
      return watcher;
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
  class TabInputWebview {
    constructor(public viewType: string) {}
  }
  class ThemeColor {
    constructor(public id: string) {}
  }
  return {
    EventEmitter,
    TreeItem,
    ThemeIcon,
    ThemeColor,
    TabInputWebview,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
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
      registerCustomEditorProvider: (viewType: string) => {
        rec.customEditors.push(viewType);
        return { dispose() {} };
      },
      createOutputChannel: (name: string) => {
        const channel = { name, lines: [] as string[], info: (line: string) => channel.lines.push(line), dispose() {} };
        rec.outputChannels.push(channel);
        return channel;
      },
      createStatusBarItem: () => {
        const s: any = { text: "", tooltip: "", command: "", backgroundColor: undefined, show() {}, dispose() {} };
        rec.statusBars.push(s);
        return s;
      },
      createTerminal: (options: any) => {
        const terminal = {
          options,
          name: options.name,
          shown: false,
          exitStatus: undefined as unknown,
          // Above the macOS pid range, so no real process can carry it.
          processId: Promise.resolve(990001 + rec.terminals.length),
          sent: [] as string[],
          show() {
            terminal.shown = true;
          },
          sendText(text: string) {
            terminal.sent.push(text);
          },
        };
        rec.terminals.push(terminal);
        return terminal;
      },
      get terminals() {
        return rec.terminals;
      },
      onDidCloseTerminal: (listener: (terminal: any) => void) => {
        rec.closeListeners.push(listener);
        return { dispose() {} };
      },
      showInformationMessage: (msg: unknown) => {
        rec.infoMessages.push(String(msg));
        return Promise.resolve(undefined);
      },
      showWarningMessage: (...args: any[]) => {
        rec.warningMessages.push(args);
        return Promise.resolve(undefined);
      },
      showErrorMessage: () => Promise.resolve(undefined),
      setStatusBarMessage: (text: string) => {
        rec.statusMessages.push(text);
        return { dispose() {} };
      },
      showTextDocument: () => Promise.resolve(undefined),
      tabGroups: { all: [], activeTabGroup: { activeTab: undefined }, onDidChangeTabs: () => ({ dispose() {} }) },
      state: { focused: true },
      activeTextEditor: undefined as unknown,
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: any) => (rec.config.has(key) ? rec.config.get(key) : def),
        inspect: (key: string) => (rec.globals.has(key) ? { globalValue: rec.globals.get(key) } : undefined),
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
      getCommands: () => Promise.resolve([...rec.claudeCommands, ...rec.commands.keys()]),
    },
    extensions: {
      all: [],
      getExtension: (id: string) =>
        id === "anthropic.claude-code" && rec.claudeCode ? { id, isActive: rec.claudeCode.active, packageJSON: { version: rec.claudeCode.version } } : undefined,
      onDidChange: (listener: () => void) => {
        rec.extensionListeners.push(listener);
        return {
          dispose() {
            const i = rec.extensionListeners.indexOf(listener);
            if (i >= 0) rec.extensionListeners.splice(i, 1);
          },
        };
      },
    },
  };
});

// Pass-through: records the bridge's deps so a test can run a remote command.
vi.mock("../src/remoteBridge", async (orig) => {
  const real = await orig<typeof import("../src/remoteBridge")>();
  return {
    ...real,
    registerRemoteBridge: (ctx: any, deps: any) => {
      rec.bridgeDeps = deps;
      return real.registerRemoteBridge(ctx, deps);
    },
  };
});

(globalThis as any).fetch = vi.fn(() => Promise.reject(new Error("mocked")));

import * as ext from "../src/extension";
import { keeperWaiting } from "../src/cliVault";
import { ContinuityServer, storageKey } from "../src/continuity";
import { TabWaker } from "../src/wakeTabs";

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(`${HOME}/.claude/projects`, { recursive: true });
  rec.config.clear();
  rec.config.set("enableCodex", false);
  rec.config.set("restartGuard", false); // the guard's tab flow has its own tests (restartGuard.test.ts)
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
      onDidChange: () => ({ dispose() {} }),
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
  rec.globals.clear();
  rec.configListeners.length = 0;
  rec.executeCalls.length = 0;
  rec.warningMessages.length = 0;
  rec.treeViews.length = 0;
  rec.webviews.length = 0;
  rec.statusBars.length = 0;
  rec.spawns.length = 0;
  // Close every terminal, so the module-level resume registry forgets them.
  for (const terminal of rec.terminals) for (const listener of rec.closeListeners) listener(terminal);
  rec.closeListeners.length = 0;
  rec.bridgeDeps = null;
  rec.terminals.length = 0;
  rec.execFileImpl = null;
  rec.spawnImpl = null;
  rec.statusMessages.length = 0;
  rec.execFiles.length = 0;
  rec.infoMessages.length = 0;
  rec.outputChannels.length = 0;
  rec.customEditors.length = 0;
  watchRec.writes.length = 0;
  rec.claudeCode = { version: "2.1.327", active: true };
  rec.claudeCommands = ["claude-vscode.editor.open", "claude-vscode.focus"];
  rec.extensionListeners.length = 0;
  keeperWaiting.clear(); // module-level: one test's claude-switch keeper state must not leak into the next
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

  it("openSession shows the terminal that hosts a session with no editor tab", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    // A remote new session runs `claude --session-id` as the terminal's own shell:
    // the terminal's pid is the session's pid and no editor tab carries its title.
    const terminal = {
      name: "Claude · REPOS",
      shown: false,
      exitStatus: undefined,
      processId: Promise.resolve(990777),
      sent: [] as string[],
      show() {
        terminal.shown = true;
      },
      sendText() {},
    };
    rec.terminals.push(terminal);
    await rec.commands.get("claudeSessionMonitor.openSession")!({
      key: "claude:terminal-session",
      provider: "claude",
      title: "Listing count gap",
      sessionId: "terminal-session",
      pid: 990777,
      bucket: "attention",
      sub: "your turn",
      capabilities: { focus: true, transcript: true, resume: true, kill: true, bulkInput: true },
      transcriptPath: `${HOME}/terminal-session.jsonl`,
      tooltip: "",
      detail: "",
      lastActivityMs: Date.now(),
      stale: false,
      matchLabels: ["Listing count gap"],
    });
    await vi.waitFor(() => expect(terminal.shown).toBe(true));
    const record = JSON.parse(fs.readFileSync(`${HOME}/.claude/session-monitor/tabs-debug.json`, "utf8"));
    expect(record.terminalLookup.via).toBe("match");
  });

  it("openSession records the terminal lookup when no terminal hosts the session", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    // A shell whose pid is neither the session's process nor one of its ancestors.
    rec.terminals.push({
      name: "zsh",
      shown: false,
      exitStatus: undefined,
      processId: Promise.resolve(990778),
      sent: [] as string[],
      show() {},
      sendText() {},
    });
    await rec.commands.get("claudeSessionMonitor.openSession")!({
      key: "claude:unhosted-session",
      provider: "claude",
      title: "Session in another terminal",
      sessionId: "unhosted-session",
      pid: 990779,
      bucket: "attention",
      sub: "your turn",
      capabilities: { focus: true, transcript: true, resume: true, kill: true, bulkInput: true },
      transcriptPath: `${HOME}/unhosted-session.jsonl`,
      tooltip: "",
      detail: "",
      lastActivityMs: Date.now(),
      stale: false,
      matchLabels: ["Session in another terminal"],
    });
    const file = `${HOME}/.claude/session-monitor/tabs-debug.json`;
    const record = await vi.waitFor(() => {
      const r = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(r).toMatchObject({ title: "Session in another terminal", action: "no-match -> prompt" });
      return r;
    });
    expect(record.terminalLookup.pid).toBe(990779);
    expect(record.terminalLookup.pidChain).toContain(990779);
    expect(record.terminalLookup.terminals).toContainEqual({ name: "zsh", pid: 990778 });
    expect(record.terminalLookup.via).toBeNull();
  });

  it("openSession has Claude Code show a session this window's Claude Code runs, whatever its tab label", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    // A session without an ai-title keeps its first prompt as tab label ("devam")
    // while its row shows the newest prompt ("evet"), and several tabs can share
    // that label: only Claude Code knows which tab hosts the session.
    const pid = process.ppid; // a live process, recorded as this window's tab process
    fs.mkdirSync(`${HOME}/.claude/sessions`, { recursive: true });
    fs.writeFileSync(
      `${HOME}/.claude/sessions/${pid}.json`,
      JSON.stringify({ pid, sessionId: "hosted-session", entrypoint: "claude-vscode" }),
    );
    rec.execFileImpl = (args) => {
      if (args[0] !== "ps" || !String(args[1]).includes("ppid=,pcpu=")) return false;
      args[args.length - 1](null, `${pid} ${process.pid} 0.0 1024\n`, "");
      return true;
    };
    await rec.commands.get("claudeSessionMonitor.openSession")!({
      key: "claude:hosted-session",
      provider: "claude",
      title: "evet",
      sessionId: "hosted-session",
      bucket: "attention",
      sub: "your turn",
      capabilities: { focus: true, transcript: true, resume: true, kill: true, bulkInput: true },
      transcriptPath: `${HOME}/hosted-session.jsonl`,
      tooltip: "",
      detail: "",
      lastActivityMs: Date.now(),
      stale: false,
      matchLabels: ["evet"],
    });
    await vi.waitFor(() =>
      expect(rec.executeCalls).toContainEqual({
        id: "claude-vscode.editor.open",
        args: ["hosted-session", undefined, undefined, undefined, undefined, { programmatic: true }],
      }),
    );
    expect(rec.infoMessages.filter((m) => m.includes("has no open tab"))).toEqual([]);
    const record = JSON.parse(fs.readFileSync(`${HOME}/.claude/session-monitor/tabs-debug.json`, "utf8"));
    expect(record.action).toBe("claude-vscode.editor.open (session runs in this window)");
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

  it("resumes Claude by the absolute path `which claude` resolved at activation", async () => {
    fs.mkdirSync(`${HOME}/bin`, { recursive: true });
    fs.writeFileSync(`${HOME}/bin/claude`, "#!/bin/sh\n", { mode: 0o755 });
    rec.execFileImpl = (args) => {
      if (args[0] !== "which") return false;
      args[args.length - 1](null, `${HOME}/bin/claude\n`, "");
      return true;
    };
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await settleAsync();
    rec.commands.get("claudeSessionMonitor.resumeSession")!({
      key: "claude:abs",
      provider: "claude",
      sessionId: "abs-session",
      title: "Claude session",
      cwd: "/tmp/claude workspace",
    });
    expect(rec.terminals.at(-1)).toMatchObject({
      options: { shellPath: `${HOME}/bin/claude`, shellArgs: ["--resume", "abs-session"] },
    });
  });

  it("deactivate() does not throw", () => {
    expect(() => ext.deactivate()).not.toThrow();
  });
});

describe("a failing refresh stage or feature start does not stop the others", () => {
  const MON = `${HOME}/.claude/session-monitor`;
  const SID = "s-stage";
  // csm-debug.log lines that mention `text`.
  const logged = (text: string): number =>
    fs.existsSync(`${MON}/csm-debug.log`)
      ? fs.readFileSync(`${MON}/csm-debug.log`, "utf8").split("\n").filter((l) => l.includes(text)).length
      : 0;
  const rowIds = (payload: any): string[] => payload.groups.flatMap((g: any) => g.rows.map((r: any) => r.id));
  const refresh = () => rec.commands.get("claudeSessionMonitor.refresh")!();
  let samples = 0; // `ps -axo` runs: the resource sampler, the last stage of a refresh

  beforeEach(() => {
    rec.execFileImpl = (args) => {
      if (args[0] !== "ps" || args[1]?.[0] !== "-axo") return false;
      samples++;
      args[args.length - 1](null, "", "");
      return true;
    };
    samples = 0;
    // A your-turn session with a live pid: every refresh has its row and a process to sample.
    const now = Date.now() / 1000;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const dir = `${HOME}/.claude/projects/-repo`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(MON, { recursive: true });
    const tx = `${dir}/${SID}.jsonl`;
    const lines = [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "run the tests" }] }, timestamp: iso(now - 40) },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" }, timestamp: iso(now - 30) },
    ];
    fs.writeFileSync(tx, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(`${MON}/${SID}.json`, JSON.stringify({ session_id: SID, provider: "claude", state: "idle", ts: now - 35, cwd: "/repo", transcript_path: tx, pid: process.pid }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Activates with a workspace state (so the limits payload is built) and resolves both views;
  // setting broken.sessions / broken.limits makes that view's postMessage throw.
  function activateWithViews(): { sessions: any[]; limits: any[]; broken: { sessions: boolean; limits: boolean } } {
    const ctx = mkCtx();
    ctx.workspaceState = { get: (_k: string, def?: unknown) => def, update: () => Promise.resolve() };
    lastCtx = ctx;
    ext.activate(ctx);
    const sessions: any[] = [];
    const limits: any[] = [];
    const broken = { sessions: false, limits: false };
    const resolve = (id: string, post: (m: any) => void) =>
      rec.webviews.find((w) => w.id === id)!.p.resolveWebviewView({
        webview: { options: {}, html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: post },
      });
    resolve("claudeSessionMonitor.view", (m) => {
      if (broken.sessions) throw new Error("sessions view gone");
      sessions.push(m);
    });
    resolve("claudeSessionMonitor.limits", (m) => {
      if (m?.type === "burn") return;
      if (broken.limits) throw new Error("limits view gone");
      limits.push(m);
    });
    return { sessions, limits, broken };
  }

  it("a throwing continuity stage still lets the sessions payload, the tab waker and the sampler run, and is logged once", () => {
    vi.spyOn(ContinuityServer.prototype, "observe").mockImplementation(() => {
      throw new Error("continuity broke");
    });
    const wake = vi.spyOn(TabWaker.prototype, "observe");
    const { sessions } = activateWithViews(); // the first refresh runs inside activate()
    expect(rowIds(sessions[sessions.length - 1])).toContain(`claude:${SID}`);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(samples).toBe(1);
    refresh();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(logged("continuity broke")).toBe(1);
  });

  it("a throwing limits payload is logged once while the sessions payload and the later stages still run", () => {
    const cont = vi.spyOn(ContinuityServer.prototype, "observe");
    const wake = vi.spyOn(TabWaker.prototype, "observe");
    const { sessions, limits, broken } = activateWithViews();
    expect(limits.length).toBeGreaterThan(0);
    broken.limits = true;
    const before = [sessions.length, cont.mock.calls.length, wake.mock.calls.length];
    refresh();
    refresh();
    expect([sessions.length, cont.mock.calls.length, wake.mock.calls.length]).toEqual(before.map((n) => n + 2));
    expect(logged("limits view gone")).toBe(1);
  });

  it("a throwing sessions push is logged once while the limits payload and the later stages still run", () => {
    const cont = vi.spyOn(ContinuityServer.prototype, "observe");
    const wake = vi.spyOn(TabWaker.prototype, "observe");
    const { sessions, limits, broken } = activateWithViews();
    broken.sessions = true;
    const before = [limits.length, cont.mock.calls.length, wake.mock.calls.length];
    expect(() => refresh()).not.toThrow();
    refresh();
    expect([limits.length, cont.mock.calls.length, wake.mock.calls.length]).toEqual(before.map((n) => n + 2));
    expect(logged("sessions view gone")).toBe(1);
    broken.sessions = false; // the view is back: the next refresh delivers the sessions payload again
    const shown = sessions.length;
    refresh();
    expect(sessions.length).toBe(shown + 1);
    expect(rowIds(sessions[sessions.length - 1])).toContain(`claude:${SID}`);
  });

  it("a feature that throws at activation leaves the others registered and the first refresh running", () => {
    vi.spyOn(TabWaker.prototype, "start").mockImplementation(() => {
      throw new Error("waker start broke");
    });
    const cont = vi.spyOn(ContinuityServer.prototype, "observe");
    let views: ReturnType<typeof activateWithViews> | undefined;
    expect(() => {
      views = activateWithViews();
    }).not.toThrow();
    expect(rec.commands.has("claudeSessionMonitor.remoteStatus")).toBe(true); // the remote bridge, started before
    expect(cont).toHaveBeenCalledTimes(1); // the continuity server, started after, observed by the first refresh
    expect(rec.commands.has("claudeSessionMonitor.openRestartGuard")).toBe(true); // the restart guard, started last
    expect(rowIds(views!.sessions[views!.sessions.length - 1])).toContain(`claude:${SID}`);
    expect(logged("waker start broke")).toBe(1);
  });
});

describe("refreshes wake only for files that matter and start at least 1 s apart", () => {
  const UUID = "e7ec778d-bd90-48a0-8fad-0dbd854ddb1e";
  const watcher = (dir: string) => watchRec.watchers.find((w) => w.dir === dir)!;

  beforeEach(() => {
    watchRec.watchers.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("only a hook record or a top-level transcript wakes a refresh; the log, state and temp files never do", () => {
    vi.useFakeTimers();
    rec.config.set("pollIntervalMs", 600_000); // the timer stays out of the way
    const cont = vi.spyOn(ContinuityServer.prototype, "observe"); // one call per refresh
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    vi.advanceTimersByTime(5_000);
    const monitor = watcher(`${HOME}/.claude/session-monitor`);
    const projects = watcher(`${HOME}/.claude/projects`);
    const base = cont.mock.calls.length;
    for (const name of ["csm-debug.log", "token-offsets.json", "token-buckets.json", "accounts.json", "official-usage.json", `.${UUID}.abc123.tmp`]) {
      monitor.fire("change", name);
    }
    projects.fire("change", `-repo/${UUID}/subagents/agent-a1.jsonl`);
    vi.advanceTimersByTime(5_000);
    expect(cont.mock.calls.length).toBe(base);
    monitor.fire("rename", `${UUID}.json`);
    vi.advanceTimersByTime(300);
    expect(cont.mock.calls.length).toBe(base + 1);
    vi.advanceTimersByTime(2_000);
    projects.fire("change", `-repo/${UUID}.jsonl`);
    vi.advanceTimersByTime(300);
    expect(cont.mock.calls.length).toBe(base + 2);
  });

  it("timer and watcher refreshes start at least 1 s apart", () => {
    vi.useFakeTimers();
    rec.config.set("pollIntervalMs", 500); // the timer asks twice a second
    const starts: number[] = [];
    vi.spyOn(ContinuityServer.prototype, "observe").mockImplementation(() => {
      starts.push(Date.now());
    });
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const monitor = watcher(`${HOME}/.claude/session-monitor`);
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(250);
      monitor.fire("rename", `${UUID}.json`); // and a hook record changes every 250 ms
    }
    vi.advanceTimersByTime(1_000);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(starts.length).toBeGreaterThan(4);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);
  });

  it("a Codex poll refreshes only when its data changed", async () => {
    vi.useFakeTimers();
    rec.config.set("enableClaude", false);
    rec.config.set("enableCodex", true);
    rec.config.set("codexExecutable", "/missing/codex");
    rec.config.set("pollIntervalMs", 600_000);
    const cont = vi.spyOn(ContinuityServer.prototype, "observe"); // one call per refresh
    lastCtx = mkCtx();
    ext.activate(lastCtx); // refresh 1; its poll finds no CLI: loading -> degraded, a change
    await vi.advanceTimersByTimeAsync(1_500);
    expect(rec.spawns).toHaveLength(1);
    expect(cont).toHaveBeenCalledTimes(2);
    await rec.commands.get("claudeSessionMonitor.refreshUsage")!(); // a forced poll sees the same degraded state
    await vi.advanceTimersByTimeAsync(1_500);
    expect(rec.spawns).toHaveLength(2);
    expect(cont).toHaveBeenCalledTimes(2);
  });
});

describe("the token scan", () => {
  it("runs no earlier than 60 s after activation, when Claude Code has restored its tabs", () => {
    vi.useFakeTimers();
    const buckets = `${HOME}/.claude/session-monitor/token-buckets.json`; // written by every scan
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    expect(fs.existsSync(buckets)).toBe(false);
    vi.advanceTimersByTime(59_000);
    expect(fs.existsSync(buckets)).toBe(false);
    vi.advanceTimersByTime(4_000);
    expect(fs.existsSync(buckets)).toBe(true);
  });
});

describe("active login and Use this account", () => {
  const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const UB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const MON = `${HOME}/.claude/session-monitor`;
  const SW = `${HOME}/.claude/state/claude-switch`;
  const session = (pct: number) => [{ key: "session", label: "Session (5h)", pct, resetMs: null }];
  const snapFile = (id: string) => `${MON}/official-usage-${id.slice(0, 16)}.json`;
  const registry = () => JSON.parse(fs.readFileSync(`${MON}/accounts.json`, "utf8"));
  const debugLog = () => fs.readFileSync(`${MON}/csm-debug.log`, "utf8");

  function writeLogin(id: string, email: string): void {
    fs.writeFileSync(`${HOME}/.claude.json`, JSON.stringify({ oauthAccount: { accountUuid: id, emailAddress: email } }));
  }
  function writePanel(id: string, email: string, tsSec = Date.now() / 1000, extra: object[] = []): void {
    fs.mkdirSync(SW, { recursive: true });
    const accounts = [{ uuid: UA, email: "a@x.com", rank: 1 }, { uuid: UB, email: "b@x.com", rank: 2 }, ...extra];
    fs.writeFileSync(`${SW}/panel.json`, JSON.stringify({ v: 1, ts: tsSec, active: { uuid: id, email }, priority: ["a@x.com", "b@x.com"], accounts, events: [] }));
  }
  // Every claude-switch surface is gated on this executable existing.
  function installSwitchCli(): void {
    fs.mkdirSync(`${HOME}/.claude/bin`, { recursive: true });
    fs.writeFileSync(`${HOME}/.claude/bin/claude-switch`, "#!/bin/sh\n", { mode: 0o755 });
  }
  // A fake claude-switch child per run: it ends only when the test calls exit(),
  // which writes its output into the files the runner handed to it.
  function fakeSwitch(): { calls: string[][]; children: any[]; exit(i: number, code: number, stdout?: string, stderr?: string): void } {
    const calls: string[][] = [];
    const children: any[] = [];
    rec.spawnImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return undefined;
      calls.push(args[1]);
      const child: any = Object.assign(new EventEmitter(), { kill: vi.fn(), unref: vi.fn(), stdio: args[2].stdio });
      children.push(child);
      return child;
    };
    const exit = (i: number, code: number, stdout = "", stderr = ""): void => {
      fs.writeSync(children[i].stdio[1], stdout);
      fs.writeSync(children[i].stdio[2], stderr);
      children[i].emit("close", code, null);
    };
    return { calls, children, exit };
  }
  // Registry still on A (the state the 2.20 panel was stuck in); the shared live
  // snapshot holds A's gauges without an acct tag, as an older build wrote it.
  function seedRegistryOnA(): void {
    fs.mkdirSync(MON, { recursive: true });
    const accounts = [{ id: UA, email: "a@x.com", lastSeenTs: 100 }, { id: UB, email: "b@x.com", lastSeenTs: 50 }];
    fs.writeFileSync(`${MON}/accounts.json`, JSON.stringify({ v: 1, activeId: UA, accounts }));
    fs.writeFileSync(snapFile(UA), JSON.stringify({ gauges: session(100), ts: Date.now() / 1000 - 30 }));
    fs.writeFileSync(snapFile(UB), JSON.stringify({ gauges: session(12), ts: Date.now() / 1000 - 120 }));
    fs.writeFileSync(`${MON}/official-usage.json`, JSON.stringify({ gauges: session(100), ts: Date.now() / 1000 - 30 }));
  }
  function activateWithLimitsView(secrets?: Record<string, string>): { posted: any[]; burnPosted: any[]; send: (m: any) => void } {
    const ctx = mkCtx();
    ctx.workspaceState = { get: (_k: string, def?: unknown) => def, update: () => Promise.resolve() };
    if (secrets) ctx.secrets.get = (k: string) => Promise.resolve(secrets[k]);
    lastCtx = ctx;
    ext.activate(ctx);
    const posted: any[] = [];
    const burnPosted: any[] = []; // Burn tab rankings, kept apart so posted[posted.length - 1] stays the limits payload
    let onMessage: (m: any) => void = () => undefined;
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.limits")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: (fn: (m: any) => void) => { onMessage = fn; }, postMessage: (m: any) => { (m?.type === "burn" ? burnPosted : posted).push(m); } },
    });
    return { posted, burnPosted, send: (m) => onMessage(m) };
  }
  const card = (payload: any, id: string) => payload.providers.find((p: any) => p.accountId === id);

  it("marks the ~/.claude.json login active at once while usage fetches fail, with its own gauge in the card and status bar", async () => {
    seedRegistryOnA();
    writeLogin(UB, "b@x.com");
    const { posted } = activateWithLimitsView();
    await vi.waitFor(() => expect(registry().activeId).toBe(UB));
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).active).toBe(true));
    const last = posted[posted.length - 1];
    expect(card(last, UA).active).toBe(false);
    expect(card(last, UB).gauges[0].pct).toBe(12); // B's own last fetch, not A's 100%
    expect(rec.statusBars[0].text).toContain("$(account) b 12%");
    expect(rec.statusBars[0].text).not.toContain("100%");
    expect(rec.statusBars[0].tooltip).toContain("Claude account: b@x.com (active)");
    expect(debugLog()).toContain("active: b@x.com (acct bbbbbbbb, from claude.json)");
  });

  it("a claude-switch panel.json fresher than ~/.claude.json decides the active login", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${HOME}/.claude.json`, old, old);
    writePanel(UB, "b@x.com");
    activateWithLimitsView();
    await vi.waitFor(() => expect(registry().activeId).toBe(UB));
    expect(debugLog()).toContain("from panel.json");
  });

  it("Limit resets: with claude-switch the payload carries the Resets tab in card order and remembers the chosen tab; without the Claude Code CLI it says so and nothing is called", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const fetchMock = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    const { posted, send } = activateWithLimitsView();
    const saved = new Map<string, unknown>(); // this test checks the chosen tab is kept, so its workspaceState keeps what is stored
    lastCtx.workspaceState = { get: (k: string, def?: unknown) => (saved.has(k) ? saved.get(k) : def), update: (k: string, v: unknown) => { saved.set(k, v); return Promise.resolve(); } };
    await vi.waitFor(() => expect(posted[posted.length - 1]?.resets?.cliMissing).toBe(true));
    const last = posted[posted.length - 1];
    expect(last.ui.tab).toBe("accounts");
    expect(last.resets.total).toBeNull();
    expect(last.resets.accounts.map((a: { id: string; email: string; name: string }) => [a.id, a.email, a.name])).toEqual([[UA, "a@x.com", "a"], [UB, "b@x.com", "b"]]);
    send({ type: "setUi", key: "tab", value: "bogus" });
    send({ type: "setUi", key: "tab", value: "resets" });
    expect([...saved]).toEqual([["csm.limitsTab", "resets"]]); // the unknown tab was not stored
    send({ type: "useReset", key: `${UA}|full`, at: 5 });
    await vi.waitFor(() => expect(posted[posted.length - 1].resets.done).toEqual({ at: 5 }));
    expect(posted[posted.length - 1].ui.tab).toBe("resets");
    expect(fetchMock.mock.calls.filter((c: unknown[]) => /cedar_ember|reset_rate_limits/.test(String(c[0])))).toEqual([]);
    expect(debugLog()).toContain("resets: Claude Code CLI not found, usage polls carry no reset data");
  });

  it("Burn tab: the ranking goes to the Usage limits view (no Limit burn view); a listed window changes it, anything else does nothing", async () => {
    const { posted, burnPosted, send } = activateWithLimitsView();
    expect(rec.webviews.map((w: { id: string }) => w.id)).not.toContain("claudeSessionMonitor.burn");
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(posted[posted.length - 1].burnOn).toBe(true);
    for (const m of [{ type: "burnWindow" }, { type: "burnWindow", ms: "3600000" }, { type: "burnWindow", ms: Number.NaN }, { type: "burnWindow", ms: -1 },
      { type: "burnWindow", ms: 12_345 }, { type: "openSession" }, { type: "openSession", id: "" }, { type: "openSession", id: 7 }]) send(m);
    send({ type: "burnWindow", ms: 3_600_000 });
    await vi.waitFor(() => expect(burnPosted[burnPosted.length - 1]).toMatchObject({ type: "burn", windowMs: 3_600_000 }));
    expect(burnPosted.every((p) => p.windowMs === 15 * 60_000 || p.windowMs === 3_600_000)).toBe(true);
  });

  // Limit resets ride on the usage polls: a passive account with a fresh token (claude-switch installed).
  const FABLE_GRANT = { id: "launch-2610-fable", resets_left: 1, ends_at: "2027-03-09T07:59:00Z", clears: ["five_hour", "seven_day_overage_included"], paused: false, usable_now: true, use_requires_limit: false, type: "full", gives_back_weekly: true, unavailable_reason: null };
  const passiveB = () => ({ [`csm.oauth.${UB}`]: JSON.stringify({ accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date.now() + 3_600_000 }), [`csm.token.${UB}`]: "at-b" });
  function usageReplies(body: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = (globalThis as any).fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    fetchMock.mockImplementation(async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body }));
    return fetchMock;
  }

  it("Limit resets ride on the usage poll: cedar_ember under the CLI User-Agent, saved to resets-<uuid>.json, shown at once after a reload", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    fs.mkdirSync(`${HOME}/.local/share/claude/versions`, { recursive: true });
    fs.writeFileSync(`${HOME}/.local/share/claude/versions/2.1.322`, "");
    const fetchMock = usageReplies({ five_hour: { utilization: 37, resets_at: null }, cedar_ember: { eligible: true, at_limit: false, grants: [FABLE_GRANT], next_grant_id: "launch-2610-fable" } });
    try {
      const { posted } = activateWithLimitsView(passiveB());
      const file = `${MON}/resets-${UB}.json`;
      await vi.waitFor(() => expect(fs.existsSync(file)).toBe(true));
      const calls = fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("https://api.anthropic.com/api/oauth/usage"));
      expect(calls).toHaveLength(1); // the poll itself, no separate listing call
      expect(calls[0][0]).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
      expect(calls[0][1].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer at-b", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.322 (external, cli)" });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(file, "utf8")).status.grants.map((g: { id: string }) => g.id)).toEqual(["launch-2610-fable"]);
      await vi.waitFor(() => expect(posted[posted.length - 1].resets.total).toBe(1));
      const b = posted[posted.length - 1].resets.accounts.find((x: { id: string }) => x.id === UB);
      expect(b.kinds.map((k: { kind: string; count: number; usable: boolean }) => [k.kind, k.count, k.usable])).toEqual([["fable", 1, true]]);
      expect(card(posted[posted.length - 1], UB).gauges[0].pct).toBe(37); // gauges parsed as before (the seed had 12)
      expect(debugLog()).toContain("resets: b@x.com fable=1");

      // Reload: the saved reading is on the Resets tab before any poll, and opening the tab calls nothing.
      disposeCtx(lastCtx);
      fetchMock.mockClear();
      fetchMock.mockImplementation(() => Promise.reject(new Error("mocked")));
      const again = activateWithLimitsView(passiveB());
      await vi.waitFor(() => expect(again.posted.length).toBeGreaterThan(0));
      const r = again.posted[again.posted.length - 1].resets;
      expect(r.total).toBe(1);
      expect(r.accounts.find((x: { id: string }) => x.id === UB).kinds[0]).toMatchObject({ kind: "fable", count: 1, usable: true });
      again.send({ type: "setUi", key: "tab", value: "resets" });
      expect(fetchMock.mock.calls).toEqual([]);
    } finally {
      ((globalThis as any).fetch as ReturnType<typeof vi.fn>).mockImplementation(() => Promise.reject(new Error("mocked")));
    }
  });

  it("without the Claude Code CLI the usage poll is the plain request it always was and nothing is saved", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    const fetchMock = usageReplies({ five_hour: { utilization: 37, resets_at: null } });
    try {
      const { posted } = activateWithLimitsView(passiveB());
      await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).gauges[0]?.pct).toBe(37));
      const calls = fetchMock.mock.calls.filter((c: unknown[]) => String(c[0]).startsWith("https://api.anthropic.com/api/oauth/usage"));
      expect(calls.map((c: unknown[]) => c[0])).toEqual(["https://api.anthropic.com/api/oauth/usage"]);
      expect(calls[0][1].headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer at-b", "anthropic-beta": "oauth-2025-04-20" });
      expect(fs.existsSync(`${MON}/resets-${UB}.json`)).toBe(false);
      expect(posted[posted.length - 1].resets.cliMissing).toBe(true);
    } finally {
      fetchMock.mockImplementation(() => Promise.reject(new Error("mocked")));
    }
  });

  it("Use this account: Switching… while claude-switch runs, then re-resolves and re-renders on exit", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const sw = fakeSwitch();
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    expect(sw.calls).toEqual([["use", "b@x.com"]]);
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    setTimeout(() => {
      writeLogin(UB, "b@x.com");
      writePanel(UB, "b@x.com");
      sw.exit(0, 0, "active: b@x.com (Max)\n");
    }, 30);
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at, ok: true, text: "active: b@x.com (Max)" }));
    const last = posted[posted.length - 1];
    expect(last.usePending).toBeUndefined();
    expect(card(last, UB).active).toBe(true);
    expect(card(last, UB).hdr.chip).toBe("active");
    expect(card(last, UA).active).toBe(false);
    expect(registry().activeId).toBe(UB);
    expect(debugLog()).toMatch(/use: b@x\.com \d+ms \(cli \d+ms, ok: active: b@x\.com \(Max\)\)/);
  });

  it("Use this account shows the CLI's error text in the panel and keeps the active login", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const sw = fakeSwitch();
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    send({ type: "useAccount", email: "b@x.com", at: Date.now() });
    sw.exit(0, 2, "", "claude-switch: vault for b@x.com has no oauthAccount; log in once with that account\n");
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult?.ok).toBe(false));
    const last = posted[posted.length - 1];
    expect(last.useResult.text).toBe("claude-switch: vault for b@x.com has no oauthAccount; log in once with that account");
    expect(card(last, UA).active).toBe(true);
    expect(registry().activeId).toBe(UA);

    send({ type: "useAccount", email: "nobody@x.com", at: Date.now() }); // not in panel.json: answered without running the CLI
    expect(posted[posted.length - 1].useResult).toMatchObject({ email: "nobody@x.com", ok: false });
    expect(posted[posted.length - 1].useResult.text).toContain("does not list this account");
  });

  it("a remote switch with claude-switch installed answers 'started' at once, runs claude-switch use, and the account list shows the result later", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const sw = fakeSwitch();
    const { posted } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    expect(await rec.bridgeDeps.execute({ id: "c1", type: "switchAccount", account: "b@x.com" })).toEqual({
      ok: true,
      message: "started: claude-switch use b@x.com; the account list shows the result when it finishes",
    });
    expect(sw.calls).toEqual([["use", "b@x.com"]]); // still running: the phone already has its answer
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    writeLogin(UB, "b@x.com");
    writePanel(UB, "b@x.com");
    sw.exit(0, 0, "active: b@x.com (Max)\n");
    await vi.waitFor(() => expect(registry().activeId).toBe(UB));
    expect(rec.bridgeDeps.accounts().accounts.find((a: any) => a.id === UB)?.active).toBe(true);
  });

  it("a remote switch refuses, without running claude-switch, while panel.json is older than 5 minutes", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com", Date.now() / 1000 - 400);
    const sw = fakeSwitch();
    const { posted } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const out = await rec.bridgeDeps.execute({ id: "c2", type: "switchAccount", account: "b@x.com" });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/^claude-switch's panel\.json is 40\d s old \(over 5 min\); not switching$/);
    expect(sw.calls).toEqual([]);
  });

  // Fake timers and Date only: setImmediate stays real, so settleAsync() lets file reads finish.
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });

  it("every status bar redraw, the resource sampler's too, names the active login with its own usage", async () => {
    fakeClock();
    seedRegistryOnA(); // the live snapshot still holds A's 100%
    writeLogin(UB, "b@x.com");
    activateWithLimitsView();
    await vi.waitFor(() => expect(rec.statusBars[0].text).toContain("$(account) b 12%"));
    const bar = rec.statusBars[0];
    const texts: string[] = [];
    let text: string = bar.text;
    Object.defineProperty(bar, "text", { get: () => text, set: (v: string) => { text = v; texts.push(v); } });
    vi.advanceTimersByTime(10_000); // ~6 ticks and 2-3 resource samples (no session pids: the sampler redraws at once)
    expect(texts.length).toBeGreaterThan(6);
    for (const t of texts) expect(t).toContain("$(account) b 12%");
  });

  it("the active card shows a background fetch newer than its live poll, and the live poll never overwrites it", async () => {
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    // A's live poll is from before a switch away (100%); a background poll since then saw it at 4% after its reset.
    fs.writeFileSync(`${MON}/official-usage.json`, JSON.stringify({ gauges: session(100), ts: Date.now() / 1000 - 600, acct: UA }));
    fs.writeFileSync(snapFile(UA), JSON.stringify({ gauges: session(4), ts: Date.now() / 1000 - 30 }));
    const { posted } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    rec.commands.get("claudeSessionMonitor.refresh")!();
    rec.commands.get("claudeSessionMonitor.refresh")!();
    const last = posted[posted.length - 1];
    expect(card(last, UA).active).toBe(true);
    expect(card(last, UA).gauges[0].pct).toBe(4);
    expect(rec.statusBars[0].text).toContain("$(account) a 4%");
  });

  it("Use this account recovers from a synchronous spawn failure: the error shows and the next click runs", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    let calls = 0;
    rec.spawnImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return undefined;
      calls++;
      throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG", syscall: "spawn" });
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    expect(() => send({ type: "useAccount", email: "b@x.com", at })).not.toThrow();
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at, ok: false, text: "could not start claude-switch: spawn E2BIG" }));
    expect(posted[posted.length - 1].usePending).toBeUndefined();
    send({ type: "useAccount", email: "b@x.com", at: Date.now() });
    expect(calls).toBe(2); // not refused as "already switching"
    expect(debugLog()).toContain("use: b@x.com");
  });

  it("after 90 s the panel stops showing Switching… but claude-switch use runs on: never signaled, nothing new starts, and its late exit still switches the login", async () => {
    fakeClock();
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const sw = fakeSwitch();
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    vi.advanceTimersByTime(88_000);
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    vi.advanceTimersByTime(4_000);
    expect(posted[posted.length - 1].usePending).toBeUndefined();
    expect(posted[posted.length - 1].useResult).toEqual({
      email: "b@x.com",
      at,
      ok: false,
      running: true,
      text: "claude-switch use has been running for 90 s; the panel will update from panel.json when it finishes",
    });
    expect(debugLog()).toContain("still running: claude-switch use has been running for 90 s");

    const again = Date.now();
    send({ type: "useAccount", email: "b@x.com", at: again }); // the buttons are back, but the run goes on: nothing new starts
    expect(sw.calls).toEqual([["use", "b@x.com"]]);
    expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at: again, ok: false, text: "claude-switch use b@x.com is still running (started 92 s ago)" });

    vi.advanceTimersByTime(150_000); // minutes past any old timeout
    expect(sw.children[0].kill).not.toHaveBeenCalled();
    writeLogin(UB, "b@x.com");
    writePanel(UB, "b@x.com");
    sw.exit(0, 0, "active: b@x.com (Max)\n"); // the run finishes late
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at, ok: true, text: "active: b@x.com (Max)" }));
    expect(card(posted[posted.length - 1], UB).active).toBe(true);
    expect(registry().activeId).toBe(UB);
    expect(debugLog()).toMatch(/use: b@x\.com \d+ms \(cli \d+ms, ok: active: b@x\.com \(Max\)\)/);
    expect(sw.children[0].kill).not.toHaveBeenCalled();
  });

  it("one claude-switch run at a time: Refresh Usage while use runs starts no tick, and Use while the tick runs starts nothing", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const sw = fakeSwitch();
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    send({ type: "useAccount", email: "b@x.com", at: Date.now() });
    await rec.commands.get("claudeSessionMonitor.refreshUsage")!();
    expect(sw.calls).toEqual([["use", "b@x.com"]]);
    expect(rec.statusMessages).toContainEqual(expect.stringMatching(/^claude-switch use b@x\.com is still running \(started \d+ s ago\)$/));
    sw.exit(0, 1, "", "claude-switch: boom\n");
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult).toMatchObject({ email: "b@x.com", ok: false, text: "claude-switch: boom" }));

    await rec.commands.get("claudeSessionMonitor.refreshUsage")!();
    expect(sw.calls).toEqual([["use", "b@x.com"], ["tick", "--fresh"]]);
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    expect(sw.calls).toHaveLength(2);
    expect(posted[posted.length - 1].usePending).toBeUndefined();
    expect(posted[posted.length - 1].useResult).toMatchObject({ email: "b@x.com", at, ok: false });
    expect(posted[posted.length - 1].useResult.text).toMatch(/^claude-switch tick --fresh is still running \(started \d+ s ago\)$/);
    sw.exit(1, 0, "no switch needed\n");
    await vi.waitFor(() => expect(rec.statusMessages).toContain("claude-switch: no switch needed"));
    for (const child of sw.children) expect(child.kill).not.toHaveBeenCalled();
  });

  it("a claude-switch that cannot be started (ENOENT) is named in the panel and the status bar, and the buttons come back", async () => {
    installSwitchCli(); // present for the gate; the mocked spawn answers ENOENT, as a missing interpreter on its #! line would
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    const text = "could not start claude-switch: ~/.claude/bin/claude-switch or the interpreter on its #! line was not found (ENOENT)";
    await vi.waitFor(() => expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at, ok: false, text }));
    expect(posted[posted.length - 1].usePending).toBeUndefined();
    await rec.commands.get("claudeSessionMonitor.refreshUsage")!();
    await vi.waitFor(() => expect(rec.statusMessages).toContain(text));
  });

  it("an untagged snapshot of the previous login never shows on the new active card when another window moved the registry", async () => {
    fakeClock();
    seedRegistryOnA(); // the shared live snapshot holds A's 100% without an acct tag (a 2.20.x window wrote it)
    const { posted } = activateWithLimitsView(); // no ~/.claude.json and no panel: only the registry names the login
    await settleAsync();
    const accounts = [{ id: UB, email: "b@x.com", lastSeenTs: 200 }, { id: UA, email: "a@x.com", lastSeenTs: 100 }];
    fs.writeFileSync(`${MON}/accounts.json`, JSON.stringify({ v: 1, activeId: UB, accounts }));
    vi.advanceTimersByTime(32_000); // the 30 s registry reload moves activeId to B
    await settleAsync();
    vi.advanceTimersByTime(7_000); // a usage poll reads the untagged snapshot
    await settleAsync();
    const last = posted[posted.length - 1];
    expect(card(last, UB).active).toBe(true);
    expect(card(last, UB).gauges[0].pct).toBe(12);
    expect(rec.statusBars[0].text).toContain("$(account) b 12%");
  });

  it("follows a switch another window already wrote to the registry without rewriting the file", async () => {
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    const { posted } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    await settleAsync();
    const written = JSON.stringify({ v: 1, activeId: UB, accounts: [{ id: UB, email: "b@x.com", lastSeenTs: 777 }, { id: UA, email: "a@x.com", lastSeenTs: 100 }] });
    fs.writeFileSync(`${MON}/accounts.json`, written);
    writeLogin(UB, "b@x.com");
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(`${HOME}/.claude.json`, later, later); // a distinct mtime: the identity parse is memoized on it
    rec.commands.get("claudeSessionMonitor.refresh")!(); // skipped while an earlier probe still runs: the next 1.5 s tick follows
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).active).toBe(true), { timeout: 3000 });
    expect(fs.readFileSync(`${MON}/accounts.json`, "utf8")).toBe(written);
    expect(debugLog()).toContain("active: b@x.com (acct bbbbbbbb, from claude.json)");
  });

  it("auto-resume follows the active login's own 5h gauge, not the previous login's live poll", () => {
    vi.useFakeTimers();
    const reset = Date.now() + 600_000;
    const s5 = (pct: number) => [{ key: "session", label: "Session (5h)", pct, resetMs: reset }];
    const start = (activePct: number, livePct: number): string => {
      disposeCtx(lastCtx);
      fs.rmSync(MON, { recursive: true, force: true });
      fs.mkdirSync(MON, { recursive: true });
      const accounts = [{ id: UB, email: "b@x.com", lastSeenTs: 200 }, { id: UA, email: "a@x.com", lastSeenTs: 100 }];
      fs.writeFileSync(`${MON}/accounts.json`, JSON.stringify({ v: 1, activeId: UB, accounts }));
      fs.writeFileSync(`${MON}/official-usage.json`, JSON.stringify({ gauges: s5(livePct), ts: Date.now() / 1000 - 30, acct: UA })); // still A's live poll
      fs.writeFileSync(snapFile(UB), JSON.stringify({ gauges: s5(activePct), ts: Date.now() / 1000 - 60 }));
      lastCtx = mkCtx();
      ext.activate(lastCtx);
      return debugLog();
    };
    rec.config.set("enableClaude", true);
    rec.config.set("autoResumeAfterReset", true);
    expect(start(12, 99)).not.toContain("auto-resume scheduled");
    expect(start(99, 10)).toContain("auto-resume scheduled");
  });

  it("without the claude-switch CLI a leftover panel.json is ignored: no block, badges, merged accounts or simplified cards, and nothing runs claude-switch", async () => {
    const UC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    seedRegistryOnA();
    writeLogin(UB, "b@x.com");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${HOME}/.claude.json`, old, old);
    // Fresher than ~/.claude.json and naming A: with the CLI installed it would keep A active and add C.
    writePanel(UA, "a@x.com", Date.now() / 1000, [{ uuid: UC, email: "c@x.com", rank: 3, needsLogin: true, needsLoginReason: "refresh token revoked" }]);
    const calls: string[][] = [];
    rec.execFileImpl = (args) => {
      if (String(args[0]).endsWith("/.claude/bin/claude-switch")) calls.push(args[1]);
      return false;
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(registry().activeId).toBe(UB));
    expect(debugLog()).toContain("active: b@x.com (acct bbbbbbbb, from claude.json)");
    expect(debugLog()).not.toContain("from panel.json");
    expect(registry().accounts.map((a: { id: string }) => a.id)).not.toContain(UC);
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).active).toBe(true));
    const last = posted[posted.length - 1];
    expect(last.switchHtml).toBeUndefined();
    expect(last.switchBadges).toEqual({});
    expect(last.panelFresh).toBe(false);
    expect(last.useEmails).toEqual([]);
    expect(last.providers.some((p: { hdr?: unknown }) => p.hdr)).toBe(false);
    expect(last.resets).toBeUndefined();
    send({ type: "useAccount", email: "a@x.com", at: Date.now() });
    await rec.commands.get("claudeSessionMonitor.refreshUsage")!();
    expect(calls).toEqual([]);
    expect(rec.spawns.filter((a) => String(a[0]).endsWith("/.claude/bin/claude-switch"))).toEqual([]);
  });

  it("without the claude-switch CLI a passive account keeps the extension's own token refresh and no claude-switch directory is created", async () => {
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    const expired = JSON.stringify({ accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date.now() - 60_000 });
    const { posted } = activateWithLimitsView({ [`csm.oauth.${UB}`]: expired });
    await vi.waitFor(() => expect(debugLog()).toContain("oauth refresh failed (acct bbbbbbbb, transient)"));
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).note).toContain("token expired"));
    expect(debugLog()).not.toContain("claude-switch");
    expect(fs.existsSync(`${HOME}/.claude/state`)).toBe(false);
  });

  it("with the claude-switch CLI a passive account's token is seeded into its vault and the keeper owns the refresh, as before", async () => {
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    const expired = JSON.stringify({ accessToken: "at-b", refreshToken: "rt-b", expiresAt: Date.now() - 60_000 });
    const { posted } = activateWithLimitsView({ [`csm.oauth.${UB}`]: expired });
    await vi.waitFor(() => expect(debugLog()).toContain("cli vault seeded (acct bbbbbbbb)"));
    expect(fs.statSync(`${SW}/vault/${UB}.json`).mode & 0o777).toBe(0o600);
    expect(debugLog()).toContain("acct bbbbbbbb: tokens expired, waiting for claude-switch keeper");
    expect(debugLog()).not.toContain("oauth refresh failed");
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).note).toBe("waiting for claude-switch keeper"));
    expect(posted[posted.length - 1].switchHtml).toContain("claude-switch: no data (file missing)");
  });
});

describe("a session's tab: shown by its index, typed into only when it is the one match", () => {
  const FOCUS = [
    "workbench.action.focusFirstEditorGroup",
    "workbench.action.focusSecondEditorGroup",
    "workbench.action.focusThirdEditorGroup",
  ];
  type FakeTab = { label: string; isActive: boolean };
  type FakeGroup = { viewColumn: number; isActive: boolean; tabs: FakeTab[]; activeTab: FakeTab | undefined };
  const restorers: Array<() => void> = [];
  let vscodeApi: any; // the vscode mock, resolved before a test turns on fake timers
  beforeEach(async () => {
    vscodeApi ??= await import("vscode");
  });
  afterEach(() => {
    for (const restore of restorers.splice(0)) restore();
  });

  /**
   * Editor groups listed in creation order (tabGroups.all) with VS Code's command
   * semantics: focus…EditorGroup picks the group at its screen slot (viewColumn),
   * openEditorAtIndex shows a tab of the active group (the index as argument, or
   * 1-9 in the command name), nextEditorInGroup the tab after the active one.
   * Every tab that becomes active is recorded as shown; the first group is active.
   */
  function fakeEditor(layout: Array<{ viewColumn: number; labels: string[] }>, claudeTabs: readonly string[] = []) {
    const vscode = vscodeApi;
    const tabGroups = vscode.window.tabGroups;
    const saved = { all: tabGroups.all, active: tabGroups.activeTabGroup };
    const groups: FakeGroup[] = layout.map(({ viewColumn, labels }) => {
      // A label in `claudeTabs` is a Claude Code panel (webview view type claudeVSCodePanel).
      const tabs = labels.map((label, i) => ({
        label,
        isActive: i === 0,
        ...(claudeTabs.includes(label) ? { input: new vscode.TabInputWebview("mainThreadWebview-claudeVSCodePanel") } : {}),
      }));
      return { viewColumn, isActive: false, tabs, activeTab: tabs[0] };
    });
    const shown: string[] = [];
    const calls: string[] = [];
    const focus = (g: FakeGroup): void => {
      for (const x of groups) x.isActive = x === g;
      tabGroups.activeTabGroup = g;
    };
    const show = (g: FakeGroup, i: number): void => {
      const tab = g.tabs[i];
      if (!tab) return;
      for (const t of g.tabs) t.isActive = t === tab;
      g.activeTab = tab;
      shown.push(tab.label);
    };
    tabGroups.all = groups;
    focus(groups[0]);
    const exec = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (id: any, ...args: any[]) => {
      if (!String(id).startsWith("workbench.action.")) return undefined;
      calls.push([id, ...args].join(" "));
      const g: FakeGroup = tabGroups.activeTabGroup;
      const slot = FOCUS.indexOf(id);
      const named = /^workbench\.action\.openEditorAtIndex(\d)$/.exec(id);
      if (slot >= 0) {
        const target = groups.find((x) => x.viewColumn === slot + 1);
        if (target) focus(target);
      } else if (id === "workbench.action.openEditorAtIndex") show(g, args[0]);
      else if (named) show(g, Number(named[1]) - 1);
      else if (id === "workbench.action.nextEditorInGroup") show(g, g.tabs.indexOf(g.activeTab!) + 1);
      return undefined;
    });
    restorers.push(() => {
      exec.mockRestore();
      tabGroups.all = saved.all;
      tabGroups.activeTabGroup = saved.active;
    });
    return { groups, shown, calls, activeLabel: (): string | undefined => tabGroups.activeTabGroup.activeTab?.label };
  }

  /** A your-turn Claude session titled `title` (its ai-title); `lastPrompt` adds a last-prompt line. */
  function seedSession(sid: string, title: string, lastPrompt?: string): void {
    const now = Date.now() / 1000;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const dir = `${HOME}/.claude/projects/-repo`;
    const mon = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(mon, { recursive: true });
    const tx = `${dir}/${sid}.jsonl`;
    const lines: object[] = [
      { type: "ai-title", aiTitle: title },
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: lastPrompt ?? title }] }, timestamp: iso(now - 40) },
      { type: "assistant", message: { id: `m-${sid}`, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn" }, timestamp: iso(now - 30) },
    ];
    if (lastPrompt) lines.push({ type: "last-prompt", lastPrompt });
    fs.writeFileSync(tx, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(`${mon}/${sid}.json`, JSON.stringify({ session_id: sid, provider: "claude", state: "idle", ts: now - 35, cwd: "/repo", transcript_path: tx }));
  }

  /** Records information messages and the typing sweep's "about to type" modal, which is answered with Start typing. */
  function recordMessages() {
    const vscode = vscodeApi;
    const infos: string[] = [];
    const sweeps: string[] = [];
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockImplementation(async (msg: any) => {
      infos.push(String(msg));
      return undefined;
    });
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockImplementation(async (msg: any) => {
      if (!String(msg).includes("about to type")) return undefined;
      sweeps.push(String(msg));
      return "Start typing";
    });
    restorers.push(() => {
      info.mockRestore();
      warn.mockRestore();
    });
    return { infos, sweeps };
  }

  /** Answers osascript like a frontmost VS Code and records the active tab's label at every keystroke run. */
  function recordTyping(e: { activeLabel(): string | undefined }): Array<string | undefined> {
    const typedInto: Array<string | undefined> = [];
    rec.execFileImpl = (args) => {
      if (args[0] !== "osascript") return false;
      const lines = args[1] as string[];
      const keystroke = lines.some((line) => line.startsWith("keystroke "));
      // The focus read before every chunk and before Enter (keystrokeTyping.ts): the Claude Code prompt input is focused.
      const readsFocus = lines.some((line) => line.includes("AXFocusedUIElement"));
      if (keystroke) typedInto.push(e.activeLabel());
      args[args.length - 1](null, keystroke || lines.some((line) => line === "key code 36" || line.includes("key code 36")) ? "typed" : readsFocus ? "com.microsoft.VSCode\nAXTextArea\nMessage input" : "", "");
      return true;
    };
    return typedInto;
  }

  const BILLING_EU = "Refactor the billing module for EU";
  const BILLING_US = "Refactor the billing module for US";
  const AUTH = "Continue the refactor of the auth layer";
  const NOTES = "Write the release notes for 2.39";
  // Claude Code's tab labels for them: the first 24 characters and an ellipsis.
  const BILLING_TAB = "Refactor the billing mod…";
  const AUTH_TAB = "Continue the refactor of…";
  const NOTES_TAB = "Write the release notes …";

  it("a click shows the session's tab past the ninth by its index, in the group at its on-screen slot", async () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    // tabGroups.all is creation order: the middle group was split off after the one to its right.
    const files = Array.from({ length: 15 }, (_, i) => `file-${i}.ts`);
    const e = fakeEditor([
      { viewColumn: 1, labels: ["notes.md"] },
      { viewColumn: 3, labels: ["right.md", "spec.md"] },
      { viewColumn: 2, labels: [...files, "Review the payment retri…", "file-16.ts"] },
    ]);
    const title = "Review the payment retries flow";
    rec.commands.get("claudeSessionMonitor.openSession")!({ provider: "claude", sessionId: "pay", title, matchLabels: [title] });
    await vi.waitFor(() => expect(e.shown).not.toHaveLength(0));
    await settleAsync();
    expect(e.calls).toEqual(["workbench.action.focusSecondEditorGroup", "workbench.action.openEditorAtIndex 15"]);
    expect(e.shown).toEqual(["Review the payment retri…"]);
  });

  it("the typing sweep types only into the one tab that matches: two titles sharing 24 characters and a \"continue\" prompt get nothing", async () => {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("eu", BILLING_EU);
    seedSession("us", BILLING_US);
    seedSession("flaky", "Fix the flaky login test", "continue");
    seedSession("auth", AUTH);
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    // The billing tab names both billing sessions; the auth tab loosely starts with "continue", the flaky session's last prompt.
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", BILLING_TAB, AUTH_TAB, NOTES_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ui.sweeps).toEqual([expect.stringContaining("for 2 session(s)")]);
    expect([...typedInto].sort()).toEqual([AUTH_TAB, NOTES_TAB]);
    expect(ui.infos).toContain("Claude Sessions: resume done · typed 2, skipped 0.");
  });

  it("the typing sweep queues only this window's sessions and skips one whose tab closed before its turn, without a prompt", async () => {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("notes", NOTES);
    seedSession("auth", AUTH);
    seedSession("elsewhere", "Plan the quarterly roadmap review"); // its tab is in another window
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", NOTES_TAB, AUTH_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ui.sweeps).toEqual([expect.stringContaining("for 2 session(s)")]);
    expect(typedInto).toHaveLength(1);
    const g = e.groups[0];
    g.tabs = g.tabs.filter((t) => t.label === "notes.md" || t.label === typedInto[0]); // the other session's tab is closed
    await vi.advanceTimersByTimeAsync(10_000);
    expect(typedInto).toHaveLength(1);
    expect(ui.infos.filter((m) => m.includes("has no open tab"))).toEqual([]);
    expect(ui.infos).toContain("Claude Sessions: resume done · typed 1, skipped 1.");
  });

  it("auto-resume after a limit reset stays silent in a window without the sessions' tabs and sweeps only this window's", async () => {
    vi.useFakeTimers();
    seedSession("notes", NOTES);
    seedSession("auth", AUTH);
    const gauge = { key: "session", label: "Session", pct: 99, resetMs: Date.now() + 10_000 };
    fs.writeFileSync(`${HOME}/.claude/session-monitor/official-usage.json`, JSON.stringify({ gauges: [gauge], ts: Date.now() / 1000 }));
    rec.config.set("autoResumeAfterReset", true);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md"] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    await vi.advanceTimersByTimeAsync(120_000); // the sweep is due 90 s after the reset
    expect(ui.infos.filter((m) => m.includes("auto resume"))).toEqual([]);
    expect(ui.sweeps).toEqual([]);

    e.groups[0].tabs.push({ label: NOTES_TAB, isActive: false }); // the notes session's tab opens in this window
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ui.infos).toContain("Claude Sessions: limit reset — starting auto resume sweep.");
    expect(ui.sweeps).toEqual([expect.stringContaining("for 1 session(s)")]);
    expect(typedInto).toEqual([NOTES_TAB]);
  });

  /** Answers osascript like a frontmost VS Code, the Claude prompt focused while `prompt()`, and names each run: activate, focus check, type, return. */
  function recordOsascript(prompt: () => boolean = () => true): string[] {
    const steps: string[] = [];
    rec.execFileImpl = (args) => {
      if (args[0] !== "osascript") return false;
      const lines = args[1] as string[];
      const type = lines.some((line) => line.startsWith("keystroke "));
      const enter = lines.some((line) => line.includes("key code 36"));
      const focusRead = lines.some((line) => line.includes("AXFocusedUIElement"));
      const activate = lines.some((line) => line.includes("to activate"));
      const step = type ? "type" : enter ? "return" : focusRead ? "focus check" : activate ? "activate" : undefined;
      if (step) steps.push(step);
      const focused = prompt() ? "com.microsoft.VSCode\nAXTextArea\nMessage input" : "com.microsoft.VSCode\nAXGroup\n";
      args[args.length - 1](null, type || enter ? "typed" : focusRead ? focused : "", "");
      return true;
    };
    return steps;
  }

  it("typing shows the session's tab by its index, also when it is active, and types only after the prompt focus check; claude-vscode.focus is never called", async () => {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: [NOTES_TAB, "notes.md"] }]); // the session's tab is the active one
    const ui = recordMessages();
    const steps = recordOsascript();
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.calls).toEqual(["workbench.action.focusFirstEditorGroup", "workbench.action.openEditorAtIndex 0"]);
    expect(vi.mocked(vscodeApi.commands.executeCommand).mock.calls.map((c: any[]) => c[0])).not.toContain("claude-vscode.focus");
    expect(steps).toEqual(["activate", "focus check", "type", "focus check", "return"]);
    expect(ui.infos).toContain("Claude Sessions: resume done · typed 1, skipped 0.");
    expect(debugLog()).toContain("typing resume claude:notes: prompt already focused");
  });

  const debugLog = (): string => {
    const file = `${HOME}/.claude/session-monitor/csm-debug.log`;
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  };
  const focusCommands = (): number =>
    vi.mocked(vscodeApi.commands.executeCommand).mock.calls.filter((c: any[]) => c[0] === "claude-vscode.focus").length;

  /** One session whose Claude panel is the active tab of the only group, typed into by Resume All. */
  async function sweepOneClaudeTab(prompt: () => boolean) {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: [NOTES_TAB, "notes.md"] }], [NOTES_TAB]);
    const ui = recordMessages();
    const steps = recordOsascript(prompt);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(15_000);
    return { e, ui, steps };
  }

  it("the prompt not focused after the tab is shown: Claude Code's focus command runs once, the tab's group is focused again and typing follows", async () => {
    const { e, ui, steps } = await sweepOneClaudeTab(() => focusCommands() > 0);
    expect(focusCommands()).toBe(1);
    expect(e.calls).toEqual(["workbench.action.focusFirstEditorGroup", "workbench.action.openEditorAtIndex 0", "workbench.action.focusFirstEditorGroup"]);
    expect(steps).toEqual(["activate", "focus check", "focus check", "type", "focus check", "return"]);
    expect(ui.infos).toContain("Claude Sessions: resume done · typed 1, skipped 0.");
    expect(debugLog()).toContain("typing resume claude:notes: prompt focused after claude-vscode.focus");
  });

  it("the focus command never runs while a text editor is active (its selection would become an @-mention): the session is skipped", async () => {
    const window = vscodeApi.window;
    window.activeTextEditor = { selection: { isEmpty: false } };
    try {
      const { ui, steps } = await sweepOneClaudeTab(() => false);
      expect(focusCommands()).toBe(0);
      expect(steps).toEqual(["activate", "focus check"]);
      expect(ui.infos).toContain("Claude Sessions: resume done · typed 0, skipped 1.");
      expect(debugLog()).toContain("typing resume claude:notes: skipped (not-prompt: ");
      expect(debugLog()).toContain("claude-vscode.focus not run: a text editor is active)");
    } finally {
      window.activeTextEditor = undefined;
    }
  });

  it("the prompt still not focused after the focus command: nothing is typed, the session is skipped", async () => {
    const { ui, steps } = await sweepOneClaudeTab(() => false);
    expect(focusCommands()).toBe(1);
    expect(steps).toEqual(["activate", "focus check", "focus check"]);
    expect(ui.infos).toContain("Claude Sessions: resume done · typed 0, skipped 1.");
    expect(debugLog()).toContain("typing resume claude:notes: skipped after claude-vscode.focus (not-prompt: ");
  });

  it("with tabAutomation off, Resume All shows no tab and types nothing", async () => {
    vi.useFakeTimers();
    rec.config.set("tabAutomation", false);
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", NOTES_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ui.sweeps).toEqual([]);
    expect(e.calls).toEqual([]);
    expect(typedInto).toEqual([]);
    expect(ui.infos).toContain("Claude Sessions: resume is off: tab automation is off.");
  });

  it("turning tabAutomation off stops a running sweep at once: the next session gets nothing", async () => {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("notes", NOTES);
    seedSession("auth", AUTH);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", NOTES_TAB, AUTH_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(typedInto).toHaveLength(1);
    rec.config.set("tabAutomation", false);
    fireConfigurationChange("claudeSessionMonitor.tabAutomation");
    expect(ui.infos).toContain("Claude Sessions: resume stopped: tab automation is off.");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(typedInto).toHaveLength(1);
    expect(e.calls.filter((c) => c.startsWith("workbench.action.openEditorAtIndex"))).toHaveLength(1);
  });

  it("turning autoResumeAfterReset off stops the running auto-resume sweep", async () => {
    vi.useFakeTimers();
    rec.config.set("resumeStaggerSeconds", 5);
    seedSession("notes", NOTES);
    seedSession("auth", AUTH);
    const gauge = { key: "session", label: "Session", pct: 99, resetMs: Date.now() + 10_000 };
    fs.writeFileSync(`${HOME}/.claude/session-monitor/official-usage.json`, JSON.stringify({ gauges: [gauge], ts: Date.now() / 1000 }));
    rec.config.set("autoResumeAfterReset", true);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", NOTES_TAB, AUTH_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    await vi.advanceTimersByTimeAsync(102_000); // the sweep starts 90 s after the reset
    expect(ui.infos).toContain("Claude Sessions: limit reset — starting auto resume sweep.");
    expect(typedInto).toHaveLength(1);
    rec.config.set("autoResumeAfterReset", false);
    fireConfigurationChange("claudeSessionMonitor.autoResumeAfterReset");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(typedInto).toHaveLength(1);
    expect(ui.infos).toContain("Claude Sessions: resume stopped: autoResumeAfterReset is off.");
  });

  it("turning wakeDeadTabs on starts the tab waker without a restart", () => {
    const start = vi.spyOn(TabWaker.prototype, "start");
    const reads: string[] = [];
    const ctx = mkCtx();
    ctx.workspaceState = {
      get: (key: string) => {
        reads.push(key);
        return undefined;
      },
      update: () => Promise.resolve(),
    };
    lastCtx = ctx;
    ext.activate(ctx);
    expect(reads).not.toContain("csm.wake.registry"); // off: the waker reads nothing
    rec.config.set("wakeDeadTabs", true);
    fireConfigurationChange("claudeSessionMonitor.wakeDeadTabs");
    expect(start).toHaveBeenCalledTimes(2);
    expect(reads).toContain("csm.wake.registry");
    start.mockRestore();
  });

  it("a Claude Code without the commands the automations call keeps the typing sweep off with one notice in the Sessions view, until an update brings them back", async () => {
    vi.useFakeTimers();
    rec.claudeCommands = [];
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const posted: any[] = [];
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.view")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (m: any) => { posted.push(m); } },
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: ["notes.md", NOTES_TAB] }]);
    const ui = recordMessages();
    const typedInto = recordTyping(e);
    rec.commands.get("claudeSessionMonitor.resumeAll")!();
    await vi.advanceTimersByTimeAsync(10_000);
    const reason = "Claude Code 2.1.327 has no claude-vscode.editor.open or claude-vscode.focus command";
    expect(typedInto).toEqual([]);
    expect(e.calls).toEqual([]);
    expect(ui.infos).toContain(`Claude Sessions: resume is off: ${reason}.`);
    const claude = (p: any) => p.health.filter((x: any) => x.provider === "claude");
    expect(claude(posted[posted.length - 1])).toEqual([expect.objectContaining({ state: "degraded", message: `tab automation off: ${reason}` })]);

    rec.claudeCommands = ["claude-vscode.editor.open", "claude-vscode.focus"]; // Claude Code updated
    for (const listener of rec.extensionListeners) listener();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(claude(posted[posted.length - 1])).toEqual([expect.objectContaining({ state: "ready" })]);
  });

  it("a remote send types into the session's tab only with at least 10 s of the command's time left", async () => {
    vi.useFakeTimers();
    seedSession("notes", NOTES);
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    await vi.advanceTimersByTimeAsync(2_000);
    const e = fakeEditor([{ viewColumn: 1, labels: [NOTES_TAB, "notes.md"] }], [NOTES_TAB]);
    const typedInto = recordTyping(e);
    rec.globals.set("remote.typeFallback", true);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" }); // keystrokes need macOS
    restorers.push(() => Object.defineProperty(process, "platform", platform));
    const send = async (id: string, left: number) => {
      const out = rec.bridgeDeps.execute({ id, type: "send", sessionId: "notes", text: "run the tests" }, new AbortController().signal, Date.now() + left);
      await vi.advanceTimersByTimeAsync(5_000);
      return out;
    };
    expect(await send("s1", 9_000)).toEqual({ ok: false, message: "not delivered via typed: timed out" });
    expect(typedInto).toEqual([]);
    expect(await send("s2", 60_000)).toEqual({ ok: true, message: "delivered via typed" });
    expect(typedInto).toEqual([NOTES_TAB]);
  });
});

describe("closingStatusMarkers setting", () => {
  // A your-turn Claude session whose final reply ends in an ordinary "✅ ..." line.
  function seedYourTurn(): void {
    const now = Date.now() / 1000;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const dir = `${HOME}/.claude/projects/-repo`;
    const mon = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(mon, { recursive: true });
    const tx = `${dir}/s-closing.jsonl`;
    const lines = [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "run the tests" }] }, timestamp: iso(now - 40) },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Ran the suite.\n\n✅ All tests pass" }], stop_reason: "end_turn" }, timestamp: iso(now - 30) },
    ];
    fs.writeFileSync(tx, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(`${mon}/s-closing.json`, JSON.stringify({ session_id: "s-closing", provider: "claude", state: "idle", ts: now - 35, cwd: "/repo", transcript_path: tx }));
  }
  function yourTurnRow(): any {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const posted: any[] = [];
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.view")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (m: any) => { posted.push(m); } },
    });
    const done = posted[posted.length - 1].groups.find((g: { key: string }) => g.key === "done");
    return done?.rows.find((r: { id: string }) => r.id === "claude:s-closing");
  }

  it("off by default: the your-turn row keeps the plain dot, with no closing text in the row or its tooltip", () => {
    seedYourTurn();
    const row = yourTurnRow();
    expect(row).toBeDefined();
    expect(row.closing).toBe("");
    expect(row.closingText).toBe("");
    expect(row.tip).not.toContain("closing:");
  });

  it("on: the your-turn row carries the closing marker and its text, and the tooltip a closing line", () => {
    rec.config.set("closingStatusMarkers", true);
    seedYourTurn();
    const row = yourTurnRow();
    expect(row.closing).toBe("done");
    expect(row.closingText).toBe("All tests pass");
    expect(row.tip).toContain("closing: ✅ All tests pass");
  });

  // A ⏳ session whose final reply was written `agoSec` ago and names `dueSec` (epoch) as its finish time.
  function seedPending(id: string, agoSec: number, dueSec: number): string {
    const now = Date.now() / 1000;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const d = new Date(dueSec * 1000);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const dir = `${HOME}/.claude/projects/-repo`;
    const mon = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(mon, { recursive: true });
    const tx = `${dir}/${id}.jsonl`;
    const lines = [
      { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "ship it" }] }, timestamp: iso(now - agoSec - 10) },
      { type: "assistant", message: { id: `m-${id}`, content: [{ type: "text", text: `Pushed.\n\n⏳ Kapatma: CI ve deploy · bitiş ~${hhmm}` }], stop_reason: "end_turn" }, timestamp: iso(now - agoSec) },
    ];
    fs.writeFileSync(tx, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(`${mon}/${id}.json`, JSON.stringify({ session_id: id, provider: "claude", state: "idle", ts: now - agoSec + 1, cwd: "/repo", transcript_path: tx }));
    return hhmm;
  }
  function sessionsPayload(): any {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const posted: any[] = [];
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.view")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: (m: any) => { posted.push(m); } },
    });
    return posted[posted.length - 1];
  }

  it("on: an on-time ⏳ row moves to In background, right after Your turn, soonest finish first", () => {
    rec.config.set("closingStatusMarkers", true);
    seedYourTurn();
    const now = Date.now() / 1000;
    const later = seedPending("s-later", 30, now + 7200);
    const sooner = seedPending("s-sooner", 30, now + 3600);
    const p = sessionsPayload();
    const keys = p.groups.map((g: { key: string }) => g.key);
    expect(keys.indexOf("background")).toBe(keys.indexOf("done") + 1);
    const done = p.groups.find((g: { key: string }) => g.key === "done");
    const bg = p.groups.find((g: { key: string }) => g.key === "background");
    expect(done.count).toBe(1);
    expect(bg.label).toBe("In background");
    expect(bg.count).toBe(2);
    expect(bg.rows.map((r: { id: string }) => r.id)).toEqual(["claude:s-sooner", "claude:s-later"]);
    expect(bg.rows.map((r: { due: string }) => r.due)).toEqual([sooner, later]);
    expect(bg.rows[0]).toMatchObject({ closing: "pending", late: "" });
    const bar = rec.statusBars.find((s) => String(s.tooltip).includes("your turn:"));
    expect(bar.tooltip).toContain("your turn: 1\nin background: 2");
  });

  it("on: an overdue ⏳ row goes back to Your turn with the late warning", () => {
    rec.config.set("closingStatusMarkers", true);
    const now = Date.now() / 1000;
    const due = seedPending("s-late", 7200, now - 3600);
    const p = sessionsPayload();
    expect(p.groups.find((g: { key: string }) => g.key === "background")).toBeUndefined();
    const row = p.groups.find((g: { key: string }) => g.key === "done").rows.find((r: { id: string }) => r.id === "claude:s-late");
    expect(row).toMatchObject({ closing: "pending", due, late: `past its finish time (~${due}); may be stuck` });
    expect(row.tip).toContain(`past its finish time (~${due}); may be stuck`);
  });

  it("off: a ⏳ session stays a plain Your turn row with no In background group", () => {
    seedPending("s-off", 30, Date.now() / 1000 + 3600);
    const p = sessionsPayload();
    expect(p.groups.map((g: { key: string }) => g.key)).toEqual(["done"]);
    const row = p.groups[0].rows.find((r: { id: string }) => r.id === "claude:s-off");
    expect(row).toMatchObject({ closing: "", closingText: "", due: "", late: "" });
    expect(row.tip).not.toContain("finish:");
  });
});

describe("resume terminals: reuse, and remote resume / send / kill without a hook pid", () => {
  const SID = "resumed-session";
  const TITLE = "fix the flaky test";
  let psCommand = "";

  // A your-turn terminal session whose hook record has no pid, plus a `claude`
  // that `which` resolves, so a remote resume may open a terminal.
  function activateWithSession(): (cmd: any) => Promise<{ ok: boolean; message: string }> {
    const now = Date.now() / 1000;
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const dir = `${HOME}/.claude/projects/-repo`;
    const mon = `${HOME}/.claude/session-monitor`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(mon, { recursive: true });
    fs.mkdirSync(`${HOME}/bin`, { recursive: true });
    fs.writeFileSync(`${HOME}/bin/claude`, "#!/bin/sh\n", { mode: 0o755 });
    const tx = `${dir}/${SID}.jsonl`;
    const lines = [
      { type: "ai-title", aiTitle: TITLE },
      { type: "user", entrypoint: "cli", cwd: "/repo", message: { content: [{ type: "text", text: TITLE }] }, timestamp: iso(now - 40) },
      { type: "assistant", message: { id: "m1", content: [{ type: "text", text: "Fixed." }], stop_reason: "end_turn" }, timestamp: iso(now - 30) },
    ];
    fs.writeFileSync(tx, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.writeFileSync(`${mon}/${SID}.json`, JSON.stringify({ session_id: SID, provider: "claude", state: "idle", ts: now - 35, cwd: "/repo", transcript_path: tx }));
    rec.execFileImpl = (args) => {
      const cb = args[args.length - 1];
      if (args[0] === "which") cb(null, `${HOME}/bin/claude\n`, "");
      else if (args[0] === "ps" && args[1]?.[0] === "-p") cb(null, `${psCommand}\n`, "");
      else return false;
      return true;
    };
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    return (cmd) => rec.bridgeDeps.execute(cmd, new AbortController().signal, Date.now() + 60_000);
  }
  const refresh = () => rec.commands.get("claudeSessionMonitor.refresh")!();

  it("Resume in Terminal reuses and shows the live terminal it opened; a closed or exited one is replaced", () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const resume = rec.commands.get("claudeSessionMonitor.resumeSession")!;
    const view = { key: "claude:reuse", provider: "claude", sessionId: "reuse", title: "Reuse me", cwd: "/tmp" };
    resume(view);
    rec.terminals[0].shown = false;
    resume(view);
    expect(rec.terminals).toHaveLength(1);
    expect(rec.terminals[0].shown).toBe(true);

    for (const listener of rec.closeListeners) listener(rec.terminals[0]);
    resume(view);
    expect(rec.terminals).toHaveLength(2);

    rec.terminals[1].exitStatus = { code: 0, reason: 0 };
    resume(view);
    expect(rec.terminals).toHaveLength(3);
  });

  it("a second remote resume writes into the terminal the first one opened; once it exits a new one opens", async () => {
    const execute = activateWithSession();
    expect(await execute({ id: "r1", type: "resume", sessionId: SID })).toEqual({
      ok: true,
      message: `resume terminal opened in the background for "${TITLE}"`,
    });
    expect(rec.terminals).toHaveLength(1);
    expect(rec.terminals[0]).toMatchObject({ shown: false, options: { shellPath: `${HOME}/bin/claude`, shellArgs: ["--resume", SID] } });

    expect(await execute({ id: "r2", type: "resume", sessionId: SID })).toEqual({
      ok: true,
      message: `"resume" written into the open session "${TITLE}"`,
    });
    expect(rec.terminals).toHaveLength(1);
    expect(rec.terminals[0].sent).toEqual(["resume\r"]);

    rec.terminals[0].exitStatus = { code: 0, reason: 0 };
    refresh();
    expect((await execute({ id: "r3", type: "resume", sessionId: SID })).message).toBe(
      `resume terminal opened in the background for "${TITLE}"`,
    );
    expect(rec.terminals).toHaveLength(2);
  });

  it("remote send reaches the resume terminal of a session without a hook pid; a ! line is rejected there", async () => {
    const execute = activateWithSession();
    await execute({ id: "r1", type: "resume", sessionId: SID });
    expect(await execute({ id: "s1", type: "send", sessionId: SID, text: "run the tests" })).toEqual({
      ok: true,
      message: "delivered via terminal",
    });
    expect(await execute({ id: "s2", type: "send", sessionId: SID, text: "!ls ~" })).toEqual({
      ok: false,
      message: "not delivered via terminal: rejected input",
    });
    expect(rec.terminals[0].sent).toEqual(["run the tests\r"]);
  });

  it("remote kill without a hook pid signals the resume terminal's process only when ps shows claude --resume <id>", async () => {
    const execute = activateWithSession();
    expect(await execute({ id: "k0", type: "kill", sessionId: SID })).toEqual({
      ok: false,
      message: "no process id known for this session",
    });
    await execute({ id: "r1", type: "resume", sessionId: SID });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      psCommand = `${HOME}/bin/claude --resume another-session`;
      expect(await execute({ id: "k1", type: "kill", sessionId: SID })).toEqual({
        ok: false,
        message: "the recorded process has exited or no longer matches",
      });
      expect(kill).not.toHaveBeenCalledWith(990001, "SIGTERM");

      psCommand = `${HOME}/bin/claude --resume ${SID}`;
      expect(await execute({ id: "k2", type: "kill", sessionId: SID })).toEqual({ ok: true, message: "sent SIGTERM to pid 990001" });
      expect(kill).toHaveBeenCalledWith(990001, "SIGTERM");
    } finally {
      kill.mockRestore();
    }
  });
});

describe("observer mode in an Extension Development Host", () => {
  const UA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const UB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const MON = `${HOME}/.claude/session-monitor`;
  const OLD_STATUS = `${MON}/old-session.json`;
  const MODE = { Production: 1, Development: 2, Test: 3 };
  const fakeClock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  const card = (payload: any, id: string) => payload.providers.find((p: any) => p.accountId === id);
  const writesUnderHome = () => watchRec.writes.filter((w) => w.includes(HOME));
  const observerLog = () => rec.outputChannels.flatMap((c) => c.lines).join("\n");
  const debugLog = () => (fs.existsSync(`${MON}/csm-debug.log`) ? fs.readFileSync(`${MON}/csm-debug.log`, "utf8") : "");

  // What a normal window acts on: a registry still on A while ~/.claude.json names B (the registry
  // follows), A's live usage at 99% near its reset (auto-resume), B's stored token expired with
  // claude-switch installed (its vault gets seeded), a status file 13 h old (cleanup), a transcript
  // (the token-count cache), and the wake, continuity and auto-resume settings on. Returns the secrets.
  function seedSharedState(): Record<string, string> {
    const now = Date.now();
    const s5 = [{ key: "session", label: "Session (5h)", pct: 99, resetMs: now + 600_000 }];
    fs.mkdirSync(MON, { recursive: true });
    const accounts = [{ id: UA, email: "a@x.com", lastSeenTs: 100 }, { id: UB, email: "b@x.com", lastSeenTs: 50 }];
    fs.writeFileSync(`${MON}/accounts.json`, JSON.stringify({ v: 1, activeId: UA, accounts }));
    fs.writeFileSync(`${MON}/official-usage.json`, JSON.stringify({ gauges: s5, ts: now / 1000 - 60, acct: UA }));
    for (const id of [UA, UB]) fs.writeFileSync(`${MON}/official-usage-${id.slice(0, 16)}.json`, JSON.stringify({ gauges: s5, ts: now / 1000 - 60 }));
    fs.writeFileSync(OLD_STATUS, JSON.stringify({ session_id: "old-session", provider: "claude", state: "idle", ts: now / 1000 - 13 * 3600 }));
    const old = new Date(now - 13 * 3600_000);
    fs.utimesSync(OLD_STATUS, old, old);
    fs.writeFileSync(`${HOME}/.claude.json`, JSON.stringify({ oauthAccount: { accountUuid: UB, emailAddress: "b@x.com" } }));
    fs.mkdirSync(`${HOME}/.claude/bin`, { recursive: true });
    fs.writeFileSync(`${HOME}/.claude/bin/claude-switch`, "#!/bin/sh\n", { mode: 0o755 });
    fs.mkdirSync(`${HOME}/.claude/projects/-repo`, { recursive: true });
    const turn = { type: "assistant", message: { content: [{ type: "text", text: "a" }], usage: { input_tokens: 1000, output_tokens: 0 } }, timestamp: new Date(now - 600_000).toISOString() };
    fs.writeFileSync(`${HOME}/.claude/projects/-repo/observer-tx.jsonl`, JSON.stringify(turn) + "\n");
    for (const key of ["wakeDeadTabs", "continuityChannel", "autoResumeAfterReset"]) rec.config.set(key, true);
    return { [`csm.oauth.${UB}`]: JSON.stringify({ accessToken: "at-b", refreshToken: "rt-b", expiresAt: now - 60_000 }) };
  }

  // Activates in `mode` with the limits view resolved; only what the extension writes from here on is recorded.
  function activateIn(mode: number, secrets: Record<string, string>): { posted: any[]; send: (m: any) => void } {
    const ctx = mkCtx();
    ctx.extensionMode = mode;
    ctx.workspaceState = { get: (_k: string, def?: unknown) => def, update: () => Promise.resolve() };
    ctx.secrets.get = (k: string) => Promise.resolve(secrets[k]);
    ctx.secrets.store = vi.fn(() => Promise.resolve());
    ctx.secrets.delete = vi.fn(() => Promise.resolve());
    lastCtx = ctx;
    watchRec.writes.length = 0;
    ext.activate(ctx);
    const posted: any[] = [];
    let onMessage: (m: any) => void = () => undefined;
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.limits")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: (fn: (m: any) => void) => { onMessage = fn; }, postMessage: (m: any) => { if (m?.type !== "burn") posted.push(m); } },
    });
    return { posted, send: (m) => onMessage(m) };
  }

  // A running window, in 1 s steps: the usage polls, the 30 s registry reload and the 60 s token scan all come due.
  async function runFor(seconds: number): Promise<void> {
    for (let i = 0; i < seconds; i++) {
      vi.advanceTimersByTime(1000);
      await settleAsync();
    }
  }

  it("Development mode starts no bridge, guard, wake, continuity or auto-resume, spawns nothing and writes nothing under the home, while both panels show the shared state", async () => {
    fakeClock();
    const secrets = seedSharedState();
    rec.config.set("restartGuard", true); // its own setting on: observer mode keeps it off all the same
    const { posted } = activateIn(MODE.Development, secrets);
    // ~/.claude.json is followed in memory only. Once a payload shows B active every later one must too,
    // across the 30 s registry reloads: the registry on disk still names A and this window never writes it.
    await vi.waitFor(() => expect(card(posted[posted.length - 1], UB).active).toBe(true), { timeout: 5000 });
    const followed = posted.length - 1;
    await runFor(65);
    expect([...new Set(posted.slice(followed).map((p) => card(p, UB).active))]).toEqual([true]);
    expect(rec.bridgeDeps).toBeNull();
    expect(rec.customEditors).toEqual([]);
    expect(rec.execFiles).toEqual([]);
    expect(rec.spawns).toEqual([]);
    expect(writesUnderHome()).toEqual([]);
    expect(fs.existsSync(OLD_STATUS)).toBe(true);
    expect(fs.existsSync(`${MON}/csm-debug.log`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${MON}/accounts.json`, "utf8")).activeId).toBe(UA);
    expect(rec.webviews.map((w) => w.id)).toEqual(expect.arrayContaining(["claudeSessionMonitor.view", "claudeSessionMonitor.limits"]));
    expect(card(posted[posted.length - 1], UB).gauges[0].pct).toBe(99); // B's usage as the other windows saved it
    expect(observerLog()).toContain(
      "observer mode (Extension Development Host): off remoteBridge, rotation, autoResume, wake, continuity, restartGuard, usagePolls, accountWrites, sharedFiles",
    );
    expect(observerLog()).toContain("active: b@x.com (acct bbbbbbbb, from claude.json)");
    expect(observerLog()).not.toContain("auto-resume scheduled");
    expect(observerLog()).not.toContain("wake: activation");
  });

  it.each([
    ["Production", MODE.Production],
    ["Test", MODE.Test],
  ])("%s mode keeps every feature: the same state starts the bridge and the guard, runs `which claude` and writes the shared files", async (_name, mode) => {
    fakeClock();
    const secrets = seedSharedState();
    activateIn(mode, secrets);
    await runFor(65);
    expect(rec.bridgeDeps).not.toBeNull();
    expect(rec.customEditors).toEqual(["claudeSessionMonitor.restartGuard"]);
    expect(rec.execFiles.map((args) => args[0])).toContain("which");
    expect(fs.existsSync(OLD_STATUS)).toBe(false); // the stale status file was cleaned up
    // Both finish on real file I/O, not on the fake clock: wait for them.
    await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(`${MON}/accounts.json`, "utf8")).activeId).toBe(UB), { timeout: 5000 }); // the registry followed ~/.claude.json
    await vi.waitFor(() => expect(fs.existsSync(`${HOME}/.claude/state/claude-switch/vault/${UB}.json`)).toBe(true), { timeout: 5000 }); // B's token seeded for claude-switch
    expect(fs.existsSync(`${MON}/token-buckets.json`)).toBe(true);
    expect(debugLog()).toContain("auto-resume scheduled");
    expect(debugLog()).toContain("wake: activation");
    expect(rec.outputChannels).toEqual([]);
  });

  it("dev.enableFeatures turns a listed feature back on in Development mode and leaves the others off", async () => {
    fakeClock();
    const secrets = seedSharedState();
    rec.config.set("dev.enableFeatures", ["remoteBridge"]);
    activateIn(MODE.Development, secrets);
    await runFor(5);
    expect(rec.bridgeDeps).not.toBeNull(); // the bridge started
    expect(rec.execFiles.map((args) => args[0])).toEqual(["which"]); // with its `which claude` lookup, and nothing else ran
    expect(rec.customEditors).toEqual([]);
    expect(writesUnderHome()).toEqual([]);
    expect(observerLog()).toContain("on through dev.enableFeatures remoteBridge");
  });

  it("Development mode refuses account and settings actions with a notice, and the commands of a feature that is off answer", async () => {
    fakeClock();
    const secrets = seedSharedState();
    const { posted, send } = activateIn(MODE.Development, secrets);
    await runFor(2);
    const registry = fs.readFileSync(`${MON}/accounts.json`, "utf8");
    await rec.commands.get("claudeSessionMonitor.forgetOtherAccounts")!();
    await rec.commands.get("claudeSessionMonitor.setEffortAll")!();
    await rec.commands.get("claudeSessionMonitor.refreshUsage")!(); // claude-switch is installed: no `tick --fresh` either
    send({ type: "useAccount", email: "a@x.com", at: Date.now() });
    for (const id of ["setRemoteToken", "remoteStatus", "openRestartGuard", "wakeDeadTabsNow"]) await rec.commands.get(`claudeSessionMonitor.${id}`)!();
    await runFor(2);
    const notices = (id: string) => rec.infoMessages.filter((m) => m.includes(`${id} is off in this Extension Development Host`)).length;
    expect([notices("accountWrites"), notices("remoteBridge"), notices("restartGuard"), notices("wake")]).toEqual([2, 2, 1, 1]);
    expect(posted[posted.length - 1].useResult).toMatchObject({ email: "a@x.com", ok: false });
    expect(posted[posted.length - 1].useResult.text).toContain("accountWrites is off");
    expect(lastCtx.secrets.store).not.toHaveBeenCalled();
    expect(lastCtx.secrets.delete).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${MON}/accounts.json`, "utf8")).toBe(registry);
    expect(fs.existsSync(`${HOME}/.claude/settings.json`)).toBe(false);
    expect(rec.spawns).toEqual([]);
    expect(rec.execFiles).toEqual([]);
    expect(writesUnderHome()).toEqual([]);
  });
});

describe("the debug log: activation line, session summary, drop events and errors.json", () => {
  const MON = `${HOME}/.claude/session-monitor`;
  const logLines = (): any[] =>
    fs.existsSync(`${MON}/csm-debug.log`)
      ? fs.readFileSync(`${MON}/csm-debug.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the activation writes one line with the version, the pid and the window key first, and every line carries them", () => {
    const storage = `${HOME}/workspaceStorage/0123abcd`;
    lastCtx = { ...mkCtx(), storageUri: { fsPath: `${storage}/softween.claude-code-session-monitor` }, extension: { packageJSON: { version: "9.9.9" } } };
    ext.activate(lastCtx);
    const win = storageKey(storage);
    const out = logLines();
    const at = out.findIndex((l) => l.feature === "activation");
    expect(out.filter((l) => l.feature === "activation")).toEqual([
      { ts: expect.any(String), pid: process.pid, win, ver: "9.9.9", feature: "activation", lvl: "info", msg: `activated: version 9.9.9 pid ${process.pid} window ${win}` },
    ]);
    expect(out.length - at).toBeGreaterThan(1); // the activation logged more, after its first line
    for (const l of out) expect(Object.keys(l)).toEqual(["ts", "pid", "win", "ver", "feature", "lvl", "msg"]);
    for (const l of out.slice(at)) expect(l).toMatchObject({ pid: process.pid, win, ver: "9.9.9" });
  });

  it("a window without a folder is empty-<pid>", () => {
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    expect(logLines().find((l) => l.feature === "activation")).toMatchObject({ win: `empty-${process.pid}`, ver: "0.0.0" });
  });

  it("logs the session count every 5 minutes instead of every 20 s", () => {
    vi.useFakeTimers();
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const summaries = (): number => logLines().filter((l) => l.msg.startsWith("sessions=")).length;
    expect(summaries()).toBe(1); // the first refresh
    vi.advanceTimersByTime(4 * 60_000);
    expect(summaries()).toBe(1);
    vi.advanceTimersByTime(61_000);
    expect(summaries()).toBe(2);
  });

  it("one line when 5 or more live sessions are gone within 60 s", () => {
    const now = Date.now() / 1000;
    const dir = `${HOME}/.claude/projects/-repo`;
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(MON, { recursive: true });
    const sids = [0, 1, 2, 3, 4, 5].map((i) => `${String(i).repeat(8)}-0000-4000-8000-000000000000`);
    const record = (sid: string, state: string, ts: number): void =>
      fs.writeFileSync(`${MON}/${sid}.json`, JSON.stringify({ session_id: sid, provider: "claude", state, ts, cwd: "/repo", transcript_path: `${dir}/${sid}.jsonl`, pid: process.pid }));
    for (const sid of sids) {
      const line = { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text: "work" }] }, timestamp: new Date((now - 40) * 1000).toISOString() };
      fs.writeFileSync(`${dir}/${sid}.jsonl`, JSON.stringify(line) + "\n");
      record(sid, "working", now - 30);
    }
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const refresh = rec.commands.get("claudeSessionMonitor.refresh")!;
    for (const sid of sids) record(sid, "ended", now);
    refresh();
    refresh();
    const events = logLines().filter((l) => l.msg.includes("live sessions gone within 60 s"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ feature: "sessions", lvl: "info" });
    expect(events[0].msg).toMatch(/^sessions: 6 live sessions gone within 60 s, 0 still live \(/);
    for (const sid of sids) expect(events[0].msg).toContain(sid.slice(0, 8));
  });

  it("errors.json gets the first stack and the count of a failing stage, saved after the first refresh and at dispose", () => {
    vi.spyOn(ContinuityServer.prototype, "observe").mockImplementation(() => {
      throw new Error("continuity broke");
    });
    lastCtx = mkCtx();
    ext.activate(lastCtx);
    const file = `${MON}/health/errors.json`;
    expect(JSON.parse(fs.readFileSync(file, "utf8")).errors["continuity: Error: continuity broke"].count).toBe(1);
    const refresh = rec.commands.get("claudeSessionMonitor.refresh")!;
    refresh();
    refresh();
    disposeCtx(lastCtx);
    lastCtx = undefined;
    const entry = JSON.parse(fs.readFileSync(file, "utf8")).errors["continuity: Error: continuity broke"];
    expect(entry).toMatchObject({ stage: "continuity", count: 3, ver: "0.0.0", win: `empty-${process.pid}` });
    expect(entry.stack).toMatch(/^Error: continuity broke\n\s+at /);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("the health file and the overseer heartbeat", () => {
  const MON = `${HOME}/.claude/session-monitor`;
  const STORAGE = `${HOME}/workspaceStorage/0123abcd`;
  const healthPath = (): string => `${MON}/health/${storageKey(STORAGE)}.json`;
  // A window with a folder, a version and a workspace state (without one the limits payload throws, as in mkCtx()).
  const ctxWithFolder = (): any => ({
    ...mkCtx(),
    storageUri: { fsPath: `${STORAGE}/softween.claude-code-session-monitor` },
    extension: { packageJSON: { version: "9.9.9" } },
    workspaceState: { get: (_k: string, def?: unknown) => def, update: () => Promise.resolve() },
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes this window's health file at activation and every 30 s, and removes it at dispose", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    lastCtx = ctxWithFolder();
    ext.activate(lastCtx);
    const first = JSON.parse(fs.readFileSync(healthPath(), "utf8"));
    expect(first).toEqual({
      v: 1,
      win: storageKey(STORAGE),
      pid: process.pid,
      version: "9.9.9",
      ts: Math.floor(Date.now() / 1000),
      features: { sessions: "ok", limits: "ok", remote: "disabled", autoResume: "disabled", continuity: "disabled", wake: "disabled", restartGuard: "disabled" },
      refreshP95Ms: expect.any(Number),
      refreshSamples: expect.any(Number),
      guardArmed: false,
    });
    expect(first.refreshSamples).toBeGreaterThanOrEqual(1); // the first refresh, timed
    expect(fs.statSync(healthPath()).mode & 0o777).toBe(0o600);
    vi.advanceTimersByTime(30_000);
    const second = JSON.parse(fs.readFileSync(healthPath(), "utf8"));
    expect(second.ts).toBe(first.ts + 30);
    expect(second.refreshSamples).toBeGreaterThan(10); // every refresh in between was timed
    disposeCtx(lastCtx);
    lastCtx = undefined;
    expect(fs.existsSync(healthPath())).toBe(false);
  });

  it("a feature whose refresh stage throws is in error in the health file", () => {
    vi.spyOn(ContinuityServer.prototype, "observe").mockImplementation(() => {
      throw new Error("continuity broke");
    });
    rec.config.set("continuityChannel", true);
    lastCtx = ctxWithFolder();
    ext.activate(lastCtx);
    expect(JSON.parse(fs.readFileSync(healthPath(), "utf8")).features).toMatchObject({ continuity: "error", sessions: "ok" });
  });

  it("sends the overseer heartbeat for all live windows only where ~/.claude/bin/overseer exists", async () => {
    lastCtx = ctxWithFolder();
    ext.activate(lastCtx);
    await settleAsync();
    const overseerCalls = (): any[][] => rec.execFiles.filter((args) => String(args[0]).endsWith("/.claude/bin/overseer"));
    expect(overseerCalls()).toEqual([]);
    disposeCtx(lastCtx);

    fs.mkdirSync(`${HOME}/.claude/bin`, { recursive: true });
    fs.writeFileSync(`${HOME}/.claude/bin/overseer`, "#!/bin/sh\n", { mode: 0o755 });
    rec.execFileImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/overseer")) return false;
      args[args.length - 1](null, "", "");
      return true;
    };
    lastCtx = ctxWithFolder();
    ext.activate(lastCtx);
    await settleAsync();
    const [heartbeat, action] = overseerCalls().map((args) => args[1]);
    expect(heartbeat.slice(0, 7)).toEqual(["emit", "--tool", "session-monitor", "--heartbeat", "--every", "5m", "--data"]);
    expect(heartbeat[heartbeat.length - 1]).toMatch(/^1 window on 9\.9\.9; features in error: none; restart guard armed in 0 of 1; refresh p95 \d+ ms$/);
    expect(JSON.parse(heartbeat[7]).windows).toEqual([expect.objectContaining({ win: storageKey(STORAGE), version: "9.9.9", failing: [] })]);
    expect(action.slice(0, 5)).toEqual(["emit", "--tool", "session-monitor", "--level", "info"]);
    expect(fs.existsSync(`${MON}/health/emit.lock`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${MON}/health/emit.json`, "utf8"))).toMatchObject({ ts: expect.any(Number) });
  });
});

