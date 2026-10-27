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
  execFileImpl: null as null | ((args: any[]) => boolean), // returns true when it handled the call
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
  rec.terminals.length = 0;
  rec.execFileImpl = null;
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
    const calls: string[][] = [];
    rec.execFileImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return false;
      calls.push(args[1]);
      setTimeout(() => {
        writeLogin(UB, "b@x.com");
        writePanel(UB, "b@x.com");
        args[args.length - 1](null, "active: b@x.com (Max)\n", "");
      }, 30);
      return true;
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    expect(calls).toEqual([["use", "b@x.com"]]);
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
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
    rec.execFileImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return false;
      const err = Object.assign(new Error("Command failed: claude-switch use b@x.com"), { code: 2 });
      setTimeout(() => args[args.length - 1](err, "", "claude-switch: vault for b@x.com has no oauthAccount; log in once with that account\n"), 10);
      return true;
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    send({ type: "useAccount", email: "b@x.com", at: Date.now() });
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
    rec.execFileImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return false;
      calls++;
      throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG", syscall: "spawn" });
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    expect(() => send({ type: "useAccount", email: "b@x.com", at })).not.toThrow();
    const last = posted[posted.length - 1];
    expect(last.usePending).toBeUndefined();
    expect(last.useResult).toEqual({ email: "b@x.com", at, ok: false, text: "could not start claude-switch: spawn E2BIG" });
    send({ type: "useAccount", email: "b@x.com", at: Date.now() });
    expect(calls).toBe(2); // not refused as "already switching"
    expect(debugLog()).toContain("use: b@x.com");
  });

  it("the host gives up a claude-switch use that never exits after 90 s, and its late exit does not clear a newer switch", async () => {
    fakeClock();
    installSwitchCli();
    seedRegistryOnA();
    writeLogin(UA, "a@x.com");
    writePanel(UA, "a@x.com");
    const exits: Array<(err: unknown, stdout: string, stderr: string) => void> = [];
    rec.execFileImpl = (args) => {
      if (!String(args[0]).endsWith("/.claude/bin/claude-switch")) return false;
      exits.push(args[args.length - 1]); // a hung child: no exit yet
      return true;
    };
    const { posted, send } = activateWithLimitsView();
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0));
    const at = Date.now();
    send({ type: "useAccount", email: "b@x.com", at });
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    vi.advanceTimersByTime(88_000);
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    vi.advanceTimersByTime(4_000);
    expect(posted[posted.length - 1].usePending).toBeUndefined();
    expect(posted[posted.length - 1].useResult).toEqual({ email: "b@x.com", at, ok: false, text: "claude-switch use did not exit within 90 s" });

    send({ type: "useAccount", email: "b@x.com", at: Date.now() }); // the buttons are back
    expect(exits).toHaveLength(2);
    expect(posted[posted.length - 1].usePending).toBe("b@x.com");
    exits[0](null, "active: b@x.com (Max)\n", ""); // the first child exits late
    await vi.waitFor(() => expect(debugLog()).toContain("exited without error but the active login is a@x.com"));
    expect(posted[posted.length - 1].usePending).toBe("b@x.com"); // still the second switch
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
