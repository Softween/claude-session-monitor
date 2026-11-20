/**
 * restartGuard.ts — make VS Code ask before it restarts extensions
 * (claudeSessionMonitor.restartGuard, off by default).
 *
 * Each Claude Code session's `claude` process runs as a child of the extension
 * host, so one "Restart Extensions" (to apply an extension update, say) stops
 * every session in the window. Before VS Code stops the extension host for a
 * restart it asks the open editors, and an open custom text editor whose
 * document is loaded vetoes: VS Code then asks "Please confirm restart of
 * extensions." with a Restart Anyway button. The guard keeps one such editor
 * open, a small static tab in the first editor group. Window reloads are not
 * covered.
 *
 * VS Code loads a custom editor's document only once its tab is shown: a tab
 * opened in the background, or restored by a window reload and not shown since,
 * does not veto. So the guard tab is shown once without taking focus, and the
 * tab that was active in its group is put back as soon as it is resolved, if the
 * guard still covers it. At activation the guard first waits for a 2 s pause in
 * input while the window is focused.
 */
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const GUARD_VIEW_TYPE = "claudeSessionMonitor.restartGuard";
export const GUARD_FILE_NAME = "Restart stops Claude sessions.claudeguard";
export const OPEN_GUARD_COMMAND = "claudeSessionMonitor.openRestartGuard";
const SETTING = "restartGuard";
const GUARD_FILE_TEXT =
  "Kept open by Agent Session Monitor so VS Code asks before it restarts extensions (claudeSessionMonitor.restartGuard).\n";
const RESOLVE_TIMEOUT_MS = 10_000;
const PAUSE_MS = 2_000; // at activation: no input for this long, or the window not focused
const MRU_BACK_COMMAND = "workbench.action.openPreviousRecentlyUsedEditorInGroup";

/** The guard tab's page: static text, no scripts. */
export function guardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude restart guard</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px 24px; max-width: 46em; line-height: 1.5; }
  h1 { font-size: 1.4em; font-weight: 600; }
  code { font-family: var(--vscode-editor-font-family); }
</style>
</head>
<body>
<h1>Claude restart guard</h1>
<p>While this tab is open, VS Code asks before it restarts extensions. Restarting extensions stops every Claude Code session in this window, because each session's process runs inside the extension host.</p>
<p>Extension updates still install in the background and take effect the next time the window reloads.</p>
<p>To turn the guard off, set <code>claudeSessionMonitor.restartGuard</code> to <code>false</code>.</p>
</body>
</html>`;
}

/** A tab that shows the guard editor. */
export function isGuardTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputCustom && tab.input.viewType === GUARD_VIEW_TYPE;
}

export function findGuardTab(groups: readonly vscode.TabGroup[]): vscode.Tab | undefined {
  for (const g of groups) for (const t of g.tabs) if (isGuardTab(t)) return t;
  return undefined;
}

/** Writes the guard's file into `dir` unless it is there; returns its path. */
export function ensureGuardFile(dir: string): string {
  const file = path.join(dir, GUARD_FILE_NAME);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, GUARD_FILE_TEXT, "utf8");
  }
  return file;
}

/** Renders the guard page and tracks the guard editors resolved in this extension host. */
export class GuardEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private waiters: Array<() => void> = [];

  /** True while a guard editor this extension host resolved is open: its loaded document vetoes a restart. */
  get live(): boolean {
    return this.panels.size > 0;
  }

  resolveCustomTextEditor(_document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: false };
    panel.webview.html = guardHtml();
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  /** Resolves true at the next resolveCustomTextEditor call, false after `ms` without one. */
  nextResolve(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      this.waiters.push(done);
    });
  }
}

/** The guard's state for the health file (health.ts). */
export interface RestartGuardState {
  /** The setting is on and a guard editor this extension host resolved is open: a restart asks first. */
  armed(): boolean;
}

/** What the guard needs from extension.ts. */
export interface GuardDeps {
  log(msg: string): void;
  focusGroup(group: vscode.TabGroup): Thenable<unknown>; // focuses `group` by its on-screen slot (tabFocus.ts)
  idleMs(): Promise<number | undefined>; // since the last keyboard or mouse input; undefined: unreadable
}

/** Opens `tab`'s guard editor in its own group, or the guard file in the first group. */
async function openGuard(tab: vscode.Tab | undefined, fileUri: () => vscode.Uri, preserveFocus: boolean): Promise<void> {
  const input = tab?.input as vscode.TabInputCustom | undefined;
  await vscode.commands.executeCommand("vscode.openWith", input?.uri ?? fileUri(), GUARD_VIEW_TYPE, {
    viewColumn: tab?.group.viewColumn ?? vscode.ViewColumn.One,
    preview: false,
    preserveFocus,
  });
}

/**
 * While the guard tab still covers `prev` (it is the active tab of their group),
 * makes `prev` the active tab again with one most-recently-used step, then gives
 * the focus back to the group that has it now; a tab chosen meanwhile stays in
 * front. Groups are focused by their on-screen slot. It never walks a group's
 * tabs: that would show every tab in between for a moment, and showing a Claude
 * Code tab that a window reload restored can start its session.
 */
async function putBack(group: vscode.TabGroup, prev: vscode.Tab | undefined, deps: GuardDeps): Promise<void> {
  const active = group.activeTab;
  if (!prev || !active || active === prev || !isGuardTab(active)) return;
  const focused = vscode.window.tabGroups.activeTabGroup;
  await deps.focusGroup(group);
  await vscode.commands.executeCommand(MRU_BACK_COMMAND);
  if (focused !== group) await deps.focusGroup(focused);
}

/** Resolves once the window is not focused or had no input for 2 s; an unreadable idle time does not wait. */
async function untilPaused(deps: GuardDeps): Promise<void> {
  for (;;) {
    const idle = await deps.idleMs();
    if (idle === undefined || idle >= PAUSE_MS || !vscode.window.state.focused) return;
    await new Promise<void>((resolve) => setTimeout(resolve, PAUSE_MS - idle));
  }
}

/**
 * Opens the guard tab, or shows a restored one this extension host has not
 * resolved, without taking focus; once it is resolved (only then does it veto)
 * the tab that was active in its group comes back.
 */
async function ensureGuard(provider: GuardEditorProvider, fileUri: () => vscode.Uri, deps: GuardDeps): Promise<void> {
  const groups = vscode.window.tabGroups;
  const tab = findGuardTab(groups.all);
  if (tab && provider.live) return;
  const group = tab?.group ?? groups.all.find((g) => g.viewColumn === vscode.ViewColumn.One) ?? groups.activeTabGroup;
  const prev = group.activeTab;
  const resolved = provider.nextResolve(RESOLVE_TIMEOUT_MS);
  await openGuard(tab, fileUri, true);
  const ok = await resolved;
  await putBack(group, prev, deps);
  const late = ok ? "" : `, not resolved within ${RESOLVE_TIMEOUT_MS / 1000} s`;
  deps.log(`restart guard: ${tab ? "restored tab shown once" : "tab opened"}${late}`);
}

async function closeGuard(log: (msg: string) => void): Promise<void> {
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isGuardTab));
  if (!tabs.length) return;
  await vscode.window.tabGroups.close(tabs);
  log(`restart guard: off, closed ${tabs.length} tab(s)`);
}

/**
 * Registers the guard editor and the Open command, and applies the setting now
 * and on every change: on opens the guard, off closes it. A guard tab closed
 * while the setting is on opens again the next time the window is not focused
 * (right away when it is not focused already): nothing moves while you work in
 * the window, and a restart is not left unguarded until the next activation.
 * At activation the guard opens after a pause in input (untilPaused).
 */
export function activateRestartGuard(ctx: vscode.ExtensionContext, deps: GuardDeps): RestartGuardState {
  const provider = new GuardEditorProvider();
  const fileUri = (): vscode.Uri => vscode.Uri.file(ensureGuardFile(ctx.globalStorageUri.fsPath));
  const enabled = (): boolean => vscode.workspace.getConfiguration("claudeSessionMonitor").get<boolean>(SETTING, false) === true;
  let queue: Promise<void> = Promise.resolve(); // one guard job at a time
  const run = (what: string, job: () => Promise<void>): void => {
    queue = queue.then(job).catch((e: unknown) => deps.log(`restart guard: ${what} failed: ${e instanceof Error ? e.message : String(e)}`));
  };
  const apply = (atActivation = false): void => {
    const open = (): Promise<void> => ensureGuard(provider, fileUri, deps);
    if (enabled()) run("open", atActivation ? () => untilPaused(deps).then(open) : open);
    else run("close", () => closeGuard(deps.log));
  };
  let reopenPending = false; // a guard tab was closed while the setting is on
  const reopenIfDue = (): void => {
    if (!reopenPending || vscode.window.state.focused || !enabled()) return;
    reopenPending = false;
    run("open", () => ensureGuard(provider, fileUri, deps));
  };
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(GUARD_VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: false }),
    vscode.commands.registerCommand(OPEN_GUARD_COMMAND, () =>
      run("open", () => openGuard(findGuardTab(vscode.window.tabGroups.all), fileUri, false)),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`claudeSessionMonitor.${SETTING}`)) apply();
    }),
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      if (!enabled() || !e.closed.some(isGuardTab)) return;
      reopenPending = true;
      deps.log("restart guard: tab closed, opens again when the window is not focused");
      reopenIfDue();
    }),
    vscode.window.onDidChangeWindowState(reopenIfDue),
  );
  apply(true);
  return { armed: () => enabled() && provider.live };
}
