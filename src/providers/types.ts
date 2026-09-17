export type AgentProvider = "claude" | "codex";

export type SessionBucket = "limited" | "attention" | "working" | "ended" | "unknown";

export interface SessionCapabilities {
  focus: boolean;
  transcript: boolean;
  resume: boolean;
  kill: boolean;
  bulkInput: boolean;
}

export interface SessionHookStatus {
  session_id: string;
  provider?: AgentProvider;
  state: string;
  event?: string;
  ts: number;
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  message?: string;
  notif_type?: string;
  prompt?: string;
  source?: string;
  stop_reason?: string;
  reason?: string;
  model?: string;
  turn_id?: string;
  pid?: number;
}

export interface SessionView {
  /** Provider-qualified identity used by the webview and in-memory registries. */
  key: string;
  provider: AgentProvider;
  sessionId: string;
  title: string;
  bucket: SessionBucket;
  sub: string;
  detail: string;
  tooltip: string;
  capabilities: SessionCapabilities;
  cwd?: string;
  cwdLabel?: string;
  transcriptPath?: string;
  lastActivityMs: number;
  resetText?: string;
  permissionMode?: string;
  notifMessage?: string;
  entrypoint?: string;
  pid?: number;
  stale: boolean;
  model?: string;
  effort?: string;
  tokens?: number;
  tokenScope?: "rolling-5h" | "thread-total";
  matchLabels: string[];
}

export interface ProviderGauge {
  key: string;
  label: string;
  pct: number;
  resetMs: number | null;
}

export interface ProviderUsageSnapshot {
  provider: AgentProvider;
  label: string;
  ts: number;
  gauges: ProviderGauge[];
  sevenDayTokens?: number;
  lifetimeTokens?: number;
  note?: string;
  planType?: string; // e.g. "plus" | "pro" | "prolite" when the app-server reports it
}

export type ProviderHealthState = "loading" | "ready" | "setup-required" | "degraded";

export interface ProviderHealth {
  provider: AgentProvider;
  state: ProviderHealthState;
  message?: string;
  updatedAt?: number;
}

export function sessionKey(provider: AgentProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function providerLabel(provider: AgentProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

export function defaultCapabilities(
  provider: AgentProvider,
  values: Partial<SessionCapabilities> = {},
): SessionCapabilities {
  return {
    focus: true,
    transcript: false,
    resume: true,
    kill: false,
    bulkInput: provider === "claude",
    ...values,
  };
}
