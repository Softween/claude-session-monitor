export type ProviderId = "claude" | "codex" | "copilot";
export type PermissionPreset = "native" | "ask" | "auto" | "full";

export interface PermissionOption {
  id: PermissionPreset;
  label: string;
}

export interface LaunchSpec {
  args: string[];
  label: string;
}

const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "copilot"];
const MODEL_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && PROVIDERS.includes(value as ProviderId);
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return value === "native" || value === "ask" || value === "auto" || value === "full";
}

export function isValidModel(value: unknown): value is string {
  return typeof value === "string" && MODEL_PATTERN.test(value);
}

export function defaultPermissionPreset(provider: ProviderId): PermissionPreset {
  void provider;
  return "native";
}

export function permissionOptionsFor(provider: ProviderId): PermissionOption[] {
  if (provider === "claude") {
    return [
      { id: "native", label: "Native CLI policy" },
      { id: "ask", label: "Ask before actions" },
      { id: "auto", label: "Auto accept edits" },
      { id: "full", label: "Full access" },
    ];
  }
  if (provider === "codex") {
    return [
      { id: "native", label: "Native CLI policy" },
      { id: "ask", label: "Ask before elevated actions" },
      { id: "full", label: "Full access" },
    ];
  }
  return [
    { id: "native", label: "Native CLI policy" },
    { id: "full", label: "Full access" },
  ];
}

export function normalizePermissionPreset(provider: ProviderId, value: unknown): PermissionPreset {
  const options = permissionOptionsFor(provider);
  return isPermissionPreset(value) && options.some((option) => option.id === value)
    ? value
    : defaultPermissionPreset(provider);
}

/**
 * Native CLI arguments are returned as an array for TerminalOptions.shellArgs.
 * They are never interpolated into a shell command string.
 */
export function buildLaunchSpec(
  provider: ProviderId,
  model: unknown,
  permission: unknown,
  resumeId?: string,
): LaunchSpec {
  const preset = normalizePermissionPreset(provider, permission);
  const args: string[] = [];
  if (isValidModel(model)) args.push("--model", model);

  if (resumeId && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(resumeId)) {
    if (provider === "claude" || provider === "copilot") args.push("--resume", resumeId);
    else args.push("resume", resumeId);
  }

  if (provider === "claude") {
    if (preset === "ask") args.push("--permission-mode", "default");
    if (preset === "auto") args.push("--permission-mode", "acceptEdits");
    if (preset === "full") args.push("--dangerously-skip-permissions");
  } else if (provider === "codex") {
    if (preset === "ask") args.push("--ask-for-approval", "on-request", "--sandbox", "workspace-write");
    if (preset === "full") args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (preset === "full") {
    args.push("--allow-all");
  }

  return { args, label: permissionOptionsFor(provider).find((option) => option.id === preset)?.label ?? "Native CLI policy" };
}

export function defaultModelsFor(provider: ProviderId): string[] {
  void provider;
  return [""];
}

export function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude Code" : provider === "codex" ? "Codex" : "GitHub Copilot";
}
