import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from "vitest";
import { EventEmitter } from "events";
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
  closeListeners: [] as Array<(terminal: any) => void>,
  bridgeDeps: null as any, // the remote bridge's deps, captured by the pass-through mock below
  execFileImpl: null as null | ((args: any[]) => boolean), // returns true when it handled the call
  spawnImpl: null as null | ((args: any[]) => any), // returns the child when it handled the call
  statusMessages: [] as string[],
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
      showInformationMessage: () => Promise.resolve(undefined),
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
    },
    workspace: {
      getConfiguration: () => ({
        get: (key: string, def: any) => (rec.config.has(key) ? rec.config.get(key) : def),
        inspect: () => undefined,
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
  function activateWithLimitsView(secrets?: Record<string, string>): { posted: any[]; send: (m: any) => void } {
    const ctx = mkCtx();
    ctx.workspaceState = { get: (_k: string, def?: unknown) => def, update: () => Promise.resolve() };
    if (secrets) ctx.secrets.get = (k: string) => Promise.resolve(secrets[k]);
    lastCtx = ctx;
    ext.activate(ctx);
    const posted: any[] = [];
    let onMessage: (m: any) => void = () => undefined;
    rec.webviews.find((w) => w.id === "claudeSessionMonitor.limits")!.p.resolveWebviewView({
      webview: { options: {}, html: "", onDidReceiveMessage: (fn: (m: any) => void) => { onMessage = fn; }, postMessage: (m: any) => { posted.push(m); } },
    });
    return { posted, send: (m) => onMessage(m) };
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
    return rec.bridgeDeps.execute;
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
