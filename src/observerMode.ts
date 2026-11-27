/**
 * observerMode.ts - observer mode for a window in an Extension Development Host.
 *
 * A dev host runs next to the owner's own windows, on the same machine and the
 * same ~/.claude, so every feature that acts on that shared state would act a
 * second time from it: the remote bridge, account rotation, auto-resume, tab
 * wakes, the continuity channel, the restart guard, account and settings writes,
 * the window's own usage polls and the files under ~/.claude/session-monitor.
 * In Development mode all of them are off: the window reads the sessions, usage
 * and accounts the other windows saved and shows them in both panels.
 * `claudeSessionMonitor.dev.enableFeatures` turns chosen ones back on for a live
 * test; any other mode ignores it. Each feature start and each write path asks
 * featureAllowed. No `vscode` import: extension.ts passes the mode, the setting
 * and a notifier in.
 */

/** The features observer mode keeps off, by the ids `claudeSessionMonitor.dev.enableFeatures` takes. */
export const OBSERVER_FEATURES = [
  "remoteBridge", // the remote bridge and its `which claude` lookup
  "rotation", // automatic account rotation (autoRotate)
  "autoResume", // the auto-resume sweep after a limit reset
  "wake", // tab wakes after a restart (wakeDeadTabs)
  "continuity", // the continuity channel
  "restartGuard", // the restart guard tab or its debug session
  "usagePolls", // this window's own usage polls and what they save: usage snapshots, limits history, reset readings, registry entries, token refreshes
  "accountWrites", // login capture into the token vault, account switches (keychain, ~/.claude.json), claude-switch runs, forgetting accounts, reset claims, ~/.claude/settings.json, registry writes
  "sharedFiles", // the debug log, the monitor folders, the token-count cache and the stale status-file cleanup
] as const;

export type ObserverFeature = (typeof OBSERVER_FEATURES)[number];

/** Commands a feature registers when it starts; while it is off they answer with its notice instead. */
const FEATURE_COMMANDS: Readonly<Partial<Record<ObserverFeature, readonly string[]>>> = {
  remoteBridge: ["claudeSessionMonitor.setRemoteToken", "claudeSessionMonitor.remoteStatus"],
  restartGuard: ["claudeSessionMonitor.openRestartGuard"],
};

export interface ObserverDeps {
  development: boolean; // ctx.extensionMode === vscode.ExtensionMode.Development
  enableFeatures: unknown; // claudeSessionMonitor.dev.enableFeatures, read once at activation
  notify(text: string): void; // tells the user why an action did nothing
}

export interface ObserverMode {
  readonly on: boolean; // this window runs in an Extension Development Host
  featureAllowed(id: ObserverFeature): boolean; // a feature start or a background write
  actionAllowed(id: ObserverFeature): boolean; // a user action: featureAllowed, and the notice when it is refused
  notice(id: ObserverFeature): string; // why a refused action did nothing
  offCommands(): { command: string; feature: ObserverFeature }[]; // the commands of the features that are off
  summary(): string; // the activation log line
}

export function observerMode(deps: ObserverDeps): ObserverMode {
  const listed: readonly unknown[] = Array.isArray(deps.enableFeatures) ? deps.enableFeatures : [];
  const featureAllowed = (id: ObserverFeature): boolean => !deps.development || listed.includes(id);
  const notice = (id: ObserverFeature): string =>
    `Agent Sessions: ${id} is off in this Extension Development Host (observer mode). To test it here, add "${id}" to claudeSessionMonitor.dev.enableFeatures; the window reads it when it starts.`;
  const withState = (allowed: boolean): ObserverFeature[] => OBSERVER_FEATURES.filter((id) => featureAllowed(id) === allowed);
  return {
    on: deps.development,
    featureAllowed,
    actionAllowed: (id) => {
      if (featureAllowed(id)) return true;
      deps.notify(notice(id));
      return false;
    },
    notice,
    offCommands: () => withState(false).flatMap((feature) => (FEATURE_COMMANDS[feature] ?? []).map((command) => ({ command, feature }))),
    summary: () =>
      `observer mode (Extension Development Host): off ${withState(false).join(", ") || "none"}; on through dev.enableFeatures ${withState(true).join(", ") || "none"}`,
  };
}
