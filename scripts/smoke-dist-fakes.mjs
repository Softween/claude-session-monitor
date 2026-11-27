// Fakes for scripts/smoke-dist.mjs: the vscode API the bundle touches while it
// activates and refreshes, an ExtensionContext, and a child_process that never
// starts a process. Settings read their package.json defaults, so a new
// setting needs no change here. Every fake object reports a member the bundle
// reads but the fake lacks (see `track`): a new vscode API then fails the smoke
// with its name instead of a TypeError from minified code.
import { EventEmitter } from "node:events";
import * as path from "node:path";
import { PassThrough } from "node:stream";

/** Read for module interop or inspection, never as a vscode API member. */
const NOT_API = new Set(["__esModule", "then", "toJSON"]);

/**
 * Puts a tracker at the end of `obj`'s prototype chain: reading a member `obj`
 * does not have adds `<name>.<member>` to `missing`. esbuild's namespace import
 * (`__toESM`) keeps the module's prototype, so top-level `vscode.X` is covered.
 */
export function track(obj, name, missing) {
  const tracker = new Proxy(Object.create(null), {
    get(_target, key, receiver) {
      if (typeof key === "symbol" || key in Object.prototype || NOT_API.has(key)) return Reflect.get(Object.prototype, key, receiver);
      missing.add(`${name}.${key}`);
      return undefined;
    },
  });
  return Object.setPrototypeOf(obj, tracker);
}

const disposable = () => ({ dispose() {} });

/** A vscode.Event that never fires; its disposable joins `disposables` when given, as in VS Code. */
const onEvent = (_listener, _thisArg, disposables) => {
  const d = disposable();
  if (Array.isArray(disposables)) disposables.push(d);
  return d;
};

const fileUri = (p) => ({ scheme: "file", authority: "", path: p, query: "", fragment: "", fsPath: p, toString: () => `file://${p}` });

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}

const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

/** workspace.getConfiguration: no user or workspace values, so every key reads its package.json default. */
function configuration(pkg, missing) {
  const sections = [].concat(pkg.contributes?.configuration ?? []);
  const props = Object.assign({}, ...sections.map((s) => s.properties ?? {}));
  const hasDefault = (key) => Object.hasOwn(props, key) && Object.hasOwn(props[key], "default");
  return (section) => {
    const full = (key) => (section ? `${section}.${key}` : key);
    return track(
      {
        get: (key, fallback) => (hasDefault(full(key)) ? props[full(key)].default : fallback),
        has: (key) => Object.hasOwn(props, full(key)),
        inspect: (key) => (Object.hasOwn(props, full(key)) ? { key: full(key), defaultValue: props[full(key)].default } : undefined),
      },
      "WorkspaceConfiguration",
      missing,
    );
  };
}

function commands(rec, missing) {
  return track(
    {
      registerCommand(id, handler) {
        if (rec.liveCommands.has(id)) throw new Error(`command '${id}' already exists`); // as VS Code does
        rec.liveCommands.set(id, handler);
        rec.registeredCommands.add(id);
        return { dispose: () => rec.liveCommands.delete(id) };
      },
      executeCommand: async (id, ...args) => rec.liveCommands.get(id)?.(...args),
      getCommands: async () => [...rec.liveCommands.keys()],
    },
    "vscode.commands",
    missing,
  );
}

function window(rec, missing) {
  const group = { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] }; // one empty editor group
  const notify = (level) => (message) => {
    rec.messages.push(`${level}: ${message}`);
    return Promise.resolve(undefined); // no button picked
  };
  return track(
    {
      state: { focused: true, active: true },
      terminals: [],
      tabGroups: track(
        { all: [group], activeTabGroup: group, onDidChangeTabs: onEvent, onDidChangeTabGroups: onEvent, close: async () => true },
        "vscode.window.tabGroups",
        missing,
      ),
      onDidChangeWindowState: onEvent,
      onDidCloseTerminal: onEvent,
      createStatusBarItem: (alignment = 1, priority = undefined) => ({
        alignment,
        priority,
        name: undefined,
        text: "",
        tooltip: undefined,
        color: undefined,
        backgroundColor: undefined,
        command: undefined,
        accessibilityInformation: undefined,
        show() {},
        hide() {},
        dispose() {},
      }),
      registerWebviewViewProvider: (viewId, provider) => {
        rec.webviewViews.set(viewId, provider);
        return disposable();
      },
      registerCustomEditorProvider: () => disposable(),
      showInformationMessage: notify("info"),
      showWarningMessage: notify("warning"),
      showErrorMessage: notify("error"),
      setStatusBarMessage: () => disposable(),
    },
    "vscode.window",
    missing,
  );
}

/** The `vscode` module as the bundle sees it. `rec` collects what the bundle did. */
export function fakeVscode({ pkg, rec, missing, workspaceDir }) {
  return track(
    {
      ExtensionMode,
      StatusBarAlignment: { Left: 1, Right: 2 },
      ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
      ThemeColor,
      TabInputWebview,
      TabInputCustom,
      Uri: track({ file: fileUri }, "vscode.Uri", missing),
      commands: commands(rec, missing),
      window: window(rec, missing),
      workspace: track(
        {
          getConfiguration: configuration(pkg, missing),
          onDidChangeConfiguration: onEvent,
          onDidGrantWorkspaceTrust: onEvent,
          workspaceFolders: [{ uri: fileUri(workspaceDir), name: path.basename(workspaceDir), index: 0 }],
          isTrusted: true,
        },
        "vscode.workspace",
        missing,
      ),
      debug: track(
        { registerDebugAdapterDescriptorFactory: () => disposable(), onDidStartDebugSession: onEvent, onDidTerminateDebugSession: onEvent },
        "vscode.debug",
        missing,
      ),
      extensions: track({ all: [], getExtension: () => undefined, onDidChange: onEvent }, "vscode.extensions", missing),
    },
    "vscode",
    missing,
  );
}

/** A shown WebviewView for resolveWebviewView; `messages` collects what the extension posts to it. */
export function fakeWebviewView(viewType, missing) {
  const messages = [];
  const webview = track(
    {
      options: {},
      html: "",
      cspSource: "vscode-webview://smoke",
      onDidReceiveMessage: onEvent,
      postMessage: (message) => {
        messages.push(message);
        return Promise.resolve(true);
      },
    },
    "Webview",
    missing,
  );
  const view = track(
    { viewType, webview, title: undefined, description: undefined, badge: undefined, visible: true, onDidDispose: onEvent, onDidChangeVisibility: onEvent, show() {} },
    "WebviewView",
    missing,
  );
  return { view, messages };
}

/** An ExtensionContext for a Production-mode activation; storage lives in the temporary `home`. */
export function extensionContext({ root, home, pkg, missing }) {
  const memento = (extra = {}) => {
    const data = new Map();
    return track(
      {
        get: (key, fallback) => (data.has(key) ? data.get(key) : fallback),
        update: async (key, value) => void (value === undefined ? data.delete(key) : data.set(key, value)),
        keys: () => [...data.keys()],
        ...extra,
      },
      "Memento",
      missing,
    );
  };
  const secrets = new Map();
  return track(
    {
      subscriptions: [],
      extensionMode: ExtensionMode.Production,
      extension: { id: `${pkg.publisher}.${pkg.name}`, extensionPath: root, extensionUri: fileUri(root), packageJSON: pkg, isActive: true },
      extensionPath: root,
      extensionUri: fileUri(root),
      asAbsolutePath: (relative) => path.join(root, relative),
      globalState: memento({ setKeysForSync() {} }),
      workspaceState: memento(),
      secrets: track(
        {
          get: async (key) => secrets.get(key),
          store: async (key, value) => void secrets.set(key, value),
          delete: async (key) => void secrets.delete(key),
          onDidChange: onEvent,
        },
        "SecretStorage",
        missing,
      ),
      globalStorageUri: fileUri(path.join(home, "globalStorage")),
      storageUri: fileUri(path.join(home, "workspaceStorage")),
      logUri: fileUri(path.join(home, "logs")),
    },
    "ExtensionContext",
    missing,
  );
}

/**
 * child_process where every program is missing: spawn emits 'error' (ENOENT)
 * and then 'close', execFile calls back with that error. Each call's program
 * is recorded in `rec.spawned`.
 */
export function childProcessStub(rec, missing) {
  const enoent = (file) => Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT", errno: -2, syscall: `spawn ${file}`, path: file });
  const child = (file, args) =>
    Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      killed: false,
      spawnfile: file,
      spawnargs: [file, ...args],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
      ref() {},
      unref() {},
    });
  return track(
    {
      spawn(file, args = [], _options = undefined) {
        rec.spawned.push(file);
        const proc = child(file, Array.isArray(args) ? args : []);
        process.nextTick(() => {
          proc.emit("error", enoent(file)); // like Node, an 'error' with no listener throws
          proc.stdin.destroy();
          proc.stdout.end();
          proc.stderr.end();
          proc.emit("close", -2, null);
        });
        return proc;
      },
      execFile(file, ...rest) {
        rec.spawned.push(file);
        const callback = rest.find((a) => typeof a === "function");
        process.nextTick(() => callback?.(enoent(file), "", ""));
        return child(file, Array.isArray(rest[0]) ? rest[0] : []);
      },
    },
    "child_process",
    missing,
  );
}
