import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { hubHtml } from "./html";
import {
  buildLaunchSpec,
  defaultModelsFor,
  defaultPermissionPreset,
  isProviderId,
  isValidModel,
  normalizePermissionPreset,
  permissionOptionsFor,
  providerLabel,
  type PermissionPreset,
  type ProviderId,
} from "./model";
import { openKnownSettings } from "./settings";

interface ProviderHubState {
  id: ProviderId;
  label: string;
  available: boolean;
  executable?: string;
  model?: string;
  permissionPreset: PermissionPreset;
  modelOptions: string[];
  permissionOptions: ReturnType<typeof permissionOptionsFor>;
  usage: { label: string; detail: string };
  sessionNote?: string;
}

interface HubState {
  type: "state";
  activeProvider: ProviderId;
  providers: ProviderHubState[];
  workspace: { label?: string; trusted: boolean };
  notice?: string;
}

interface FocusSettingsMessage {
  type: "focusSettings";
}

type HubAction =
  | "selectProvider"
  | "selectWorkspace"
  | "start"
  | "newSession"
  | "configure"
  | "nativeSettings"
  | "login"
  | "resume"
  | "usageHelp"
  | "openUsage";

interface HubMessage {
  type: "ready" | "action";
  action?: HubAction;
  provider?: unknown;
  model?: unknown;
  permissionPreset?: unknown;
}

const EXECUTABLE_SETTING: Record<ProviderId, string> = {
  claude: "agentHub.claudeExecutable",
  codex: "claudeSessionMonitor.codexExecutable",
  copilot: "agentHub.copilotExecutable",
};

const COMMON_BIN_FOLDERS = [".local/bin", ".npm-global/bin"];

function canExecute(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Resolve a configured or discoverable executable without running a shell. */
export function resolveAgentExecutable(
  provider: ProviderId,
  configured?: string,
  envPath = process.env.PATH,
  home = os.homedir(),
): string | undefined {
  const name = provider;
  const candidates: string[] = [];
  const value = configured?.trim();
  if (value && path.isAbsolute(value)) return canExecute(value) ? value : undefined;
  if (value && !path.isAbsolute(value) && !/[\\/]/.test(value)) {
    for (const folder of (envPath ?? "").split(path.delimiter)) if (path.isAbsolute(folder)) candidates.push(path.join(folder, value));
  }
  for (const folder of (envPath ?? "").split(path.delimiter)) if (path.isAbsolute(folder)) candidates.push(path.join(folder, name));
  for (const folder of COMMON_BIN_FOLDERS) candidates.push(path.join(home, folder, name));
  candidates.push(path.join("/opt/homebrew/bin", name), path.join("/usr/local/bin", name));
  return candidates.find(canExecute);
}

function terminalName(provider: ProviderId, workspace: string): string {
  return `${providerLabel(provider)} · ${path.basename(workspace) || workspace}`;
}

function workspaceLabel(workspace?: string): string | undefined {
  return workspace ? path.basename(workspace) || workspace : undefined;
}

export function registerAgentHub(ctx: vscode.ExtensionContext): vscode.Disposable {
  let activeProvider = ctx.globalState.get<ProviderId>("agentHub.activeProvider", "claude");
  if (!isProviderId(activeProvider)) activeProvider = "claude";
  let notice: string | undefined;
  let view: vscode.WebviewView | undefined;
  let webviewReady = false;
  let focusSettingsOnReady = false;
  const terminals = new Map<string, vscode.Terminal>();
  const selectedWorkspaceKey = "agentHub.workspace";

  const configuredExecutable = (provider: ProviderId): string => {
    const config = vscode.workspace.getConfiguration();
    const fallback = provider === "codex" ? "codex" : provider;
    const inspected = config.inspect?.<string>(EXECUTABLE_SETTING[provider]);
    const value = inspected?.globalValue ?? inspected?.defaultValue ?? config.get<string>(EXECUTABLE_SETTING[provider], fallback);
    return value.trim();
  };
  const selectedWorkspace = (): string | undefined => {
    const saved = ctx.globalState.get<string>(selectedWorkspaceKey);
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.find((folder) => folder.uri.fsPath === saved)?.uri.fsPath ?? (folders.length === 1 ? folders[0].uri.fsPath : undefined);
  };
  const state = (): HubState => {
    const workspace = selectedWorkspace();
    return {
      type: "state",
      activeProvider,
      providers: (["claude", "codex", "copilot"] as const).map((provider) => {
        const model = ctx.globalState.get<string>(`agentHub.model.${provider}`);
        const permission = normalizePermissionPreset(
          provider,
          ctx.globalState.get<PermissionPreset>(`agentHub.permission.${provider}`, defaultPermissionPreset(provider)),
        );
        const executable = resolveAgentExecutable(provider, configuredExecutable(provider));
        return {
          id: provider,
          label: providerLabel(provider),
          available: !!executable,
          executable,
          model,
          permissionPreset: permission,
          modelOptions: defaultModelsFor(provider),
          permissionOptions: permissionOptionsFor(provider),
          usage: { label: "Usage limits", detail: "Open Usage limits for live provider gauges." },
          sessionNote: terminals.has(`${provider}:${workspace ?? ""}`) ? "Managed terminal is open" : undefined,
        };
      }),
      workspace: { label: workspaceLabel(workspace), trusted: vscode.workspace.isTrusted },
      notice,
    };
  };
  const publish = (): void => {
    view?.webview.postMessage(state());
    notice = undefined;
  };
  const focusSettings = (): void => {
    focusSettingsOnReady = true;
    if (view && webviewReady) {
      view.webview.postMessage({ type: "focusSettings" } satisfies FocusSettingsMessage);
      focusSettingsOnReady = false;
    }
  };
  const ensureTrusted = (): boolean => {
    if (vscode.workspace.isTrusted) return true;
    notice = "Trust this workspace before starting, resuming, or logging into an agent.";
    vscode.window.showWarningMessage(notice);
    publish();
    return false;
  };
  const chooseWorkspace = async (): Promise<string | undefined> => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      notice = "Open a folder or workspace before starting an agent.";
      return undefined;
    }
    if (folders.length === 1) return folders[0].uri.fsPath;
    const picked = await vscode.window.showQuickPick(
      folders.map((folder) => ({ label: folder.name, description: folder.uri.fsPath, folder })),
      { placeHolder: "Choose the workspace folder for this agent terminal" },
    );
    if (!picked) return undefined;
    await ctx.globalState.update(selectedWorkspaceKey, picked.folder.uri.fsPath);
    return picked.folder.uri.fsPath;
  };
  const createOrRevealTerminal = async (
    provider: ProviderId,
    mode: "start" | "new" | "login" | "resume",
  ): Promise<void> => {
    if (!ensureTrusted()) return;
    const workspace = (mode === "start" || mode === "new" ? selectedWorkspace() : undefined) ?? (await chooseWorkspace());
    if (!workspace) {
      publish();
      return;
    }
    const executable = resolveAgentExecutable(provider, configuredExecutable(provider));
    if (!executable) {
      notice = `${providerLabel(provider)} CLI was not found. Configure ${EXECUTABLE_SETTING[provider]} with an executable path.`;
      vscode.window.showWarningMessage(notice);
      publish();
      return;
    }
    const key = `${provider}:${workspace}`;
    const existing = terminals.get(key);
    if (existing && mode === "start") {
      existing.show(false);
      notice = "Selected the existing managed terminal. Model and permission changes apply to its next session.";
      publish();
      return;
    }
    const model = ctx.globalState.get<string>(`agentHub.model.${provider}`);
    const permission = ctx.globalState.get<PermissionPreset>(`agentHub.permission.${provider}`, defaultPermissionPreset(provider));
    const args =
      mode === "login"
        ? provider === "claude"
          ? ["auth", "login"]
          : ["login"]
        : mode === "resume"
          ? provider === "claude" || provider === "copilot"
            ? ["--resume"]
            : ["resume"]
          : buildLaunchSpec(provider, model, permission).args;
    const terminal = vscode.window.createTerminal({
      name: mode === "new" ? `${terminalName(provider, workspace)} · new` : terminalName(provider, workspace),
      cwd: workspace,
      shellPath: executable,
      shellArgs: args,
      location: { viewColumn: vscode.ViewColumn.Active },
    });
    if (mode === "start" || mode === "new") terminals.set(key, terminal);
    terminal.show(false);
    notice = mode === "start" || mode === "new" ? "Started a native agent terminal in the editor area." : "Opened the provider's native flow in the editor area.";
    publish();
  };
  const handle = async (message: HubMessage): Promise<void> => {
    if (!message || (message.type !== "ready" && message.type !== "action")) return;
    if (message.type === "ready") {
      webviewReady = true;
      publish();
      if (focusSettingsOnReady) focusSettings();
      return;
    }
    const action = message.action;
    const provider = isProviderId(message.provider) ? message.provider : activeProvider;
    if (!action) return;
    if (action === "selectProvider" && isProviderId(message.provider)) {
      activeProvider = message.provider;
      await ctx.globalState.update("agentHub.activeProvider", activeProvider);
    } else if (action === "selectWorkspace") {
      await chooseWorkspace();
    } else if (action === "configure") {
      if (!ensureTrusted()) return;
      if (message.model !== "" && !isValidModel(message.model)) {
        notice = "Model names may contain only letters, digits, dots, colons, slashes, underscores, and hyphens.";
        publish();
        return;
      }
      await ctx.globalState.update(`agentHub.model.${provider}`, message.model || undefined);
      await ctx.globalState.update(`agentHub.permission.${provider}`, normalizePermissionPreset(provider, message.permissionPreset));
      notice = "Saved for the next native session.";
    } else if (action === "start") {
      await createOrRevealTerminal(provider, "start");
      return;
    } else if (action === "newSession") {
      await createOrRevealTerminal(provider, "new");
      return;
    } else if (action === "login") {
      await createOrRevealTerminal(provider, "login");
      return;
    } else if (action === "resume") {
      await createOrRevealTerminal(provider, "resume");
      return;
    } else if (action === "nativeSettings") {
      if (!ensureTrusted()) return;
      await openKnownSettings(os.homedir(), selectedWorkspace());
    } else if (action === "openUsage") {
      await vscode.env.openExternal(vscode.Uri.parse(usageUrl(provider)));
    } else if (action === "usageHelp") {
      vscode.window.showInformationMessage(usageCommandHelp(provider));
    }
    publish();
  };
  const provider: vscode.WebviewViewProvider = {
    resolveWebviewView(nextView): void {
      view = nextView;
      webviewReady = false;
      nextView.webview.options = { enableScripts: true };
      nextView.webview.html = hubHtml();
      nextView.webview.onDidReceiveMessage((message: HubMessage) => void handle(message));
      publish();
    },
  };
  const registrations: vscode.Disposable[] = [
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.hub", provider),
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [key, value] of terminals) if (value === terminal) terminals.delete(key);
      publish();
    }),
  ];
  const selectProvider = (requested?: unknown): Promise<void> => {
    const next = isProviderId(requested)
      ? requested
      : activeProvider === "claude"
        ? "codex"
        : activeProvider === "codex"
          ? "copilot"
          : "claude";
    return handle({ type: "action", action: "selectProvider", provider: next });
  };
  const commands: Array<[string, (...args: unknown[]) => unknown]> = [
    ["agentHub.open", () => vscode.commands.executeCommand("claudeSessionMonitor.hub.focus")],
    ["agentHub.selectProvider", (requested?: unknown) => selectProvider(requested)],
    ["agentHub.start", () => createOrRevealTerminal(activeProvider, "start")],
    ["agentHub.newSession", () => createOrRevealTerminal(activeProvider, "new")],
    ["agentHub.configure", async () => {
      await vscode.commands.executeCommand("claudeSessionMonitor.hub.focus");
      focusSettings();
    }],
    ["agentHub.nativeSettings", () => ensureTrusted() && openKnownSettings(os.homedir(), selectedWorkspace())],
    ["agentHub.login", () => createOrRevealTerminal(activeProvider, "login")],
    ["agentHub.resume", () => createOrRevealTerminal(activeProvider, "resume")],
  ];
  for (const [id, callback] of commands) registrations.push(vscode.commands.registerCommand(id, callback));
  return vscode.Disposable.from(...registrations, { dispose: () => terminals.clear() });
}

function usageUrl(provider: ProviderId): string {
  if (provider === "claude") return "https://docs.anthropic.com/en/docs/claude-code/overview";
  if (provider === "codex") return "https://help.openai.com/en/articles/11052062-codex-usage-limits";
  return "https://docs.github.com/en/copilot/how-tos/monitoring-usage-and-entitlements";
}

function usageCommandHelp(provider: ProviderId): string {
  if (provider === "claude") return "Claude Code: use /status in the native session to inspect account and session status.";
  if (provider === "codex") return "Codex: use /status in the native session to inspect account and session usage.";
  return "GitHub Copilot: use /usage or /statusline quota in the native session to inspect quota.";
}
