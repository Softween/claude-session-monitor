import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import {
  defaultCapabilities,
  providerLabel,
  sessionKey,
  type ProviderGauge,
  type ProviderHealth,
  type ProviderUsageSnapshot,
  type SessionHookStatus,
  type SessionView,
} from "./types";

export const CODEX_MONITOR_DIR = path.join(os.homedir(), ".codex", "session-monitor");
const LEGACY_CLAUDE_MONITOR_DIR = path.join(os.homedir(), ".claude", "session-monitor");
const CODEX_HOOKS_FILE = path.join(os.homedir(), ".codex", "hooks.json");
const STALE_SECONDS = 120;

export interface CodexThreadStatus {
  type: "notLoaded" | "idle" | "systemError" | "active";
  activeFlags?: Array<"waitingOnApproval" | "waitingOnUserInput" | string>;
}

export interface CodexThread {
  id: string;
  sessionId?: string;
  preview?: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number | null;
  status: CodexThreadStatus;
  path?: string | null;
  cwd?: string;
  source?: string | Record<string, unknown>;
  name?: string | null;
}

interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
}

interface CodexHookMetadata {
  eventName?: string;
  command?: string | null;
  enabled?: boolean;
  trustStatus?: "managed" | "untrusted" | "trusted" | "modified" | string;
}

interface HooksListResponse {
  data: Array<{ hooks?: CodexHookMetadata[] }>;
}

export interface CodexHookAssessment {
  ready: boolean;
  missing: string[];
  needsReview: string[];
}

interface RpcError {
  code?: number;
  message?: string;
}

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: RpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CodexRefreshOptions {
  now: number;
  maxAgeSec: number;
  hideEndedOlderThanSec: number;
  showEnded: boolean;
  workspaceCwd?: string;
}

export interface CodexProviderSnapshot {
  sessions: SessionView[];
  usage: ProviderUsageSnapshot | null;
  health: ProviderHealth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

function cleanLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.replace(/\s+/g, " ").trim();
  if (!label || label.startsWith("<")) return undefined;
  return label.slice(0, 300);
}

function sourceName(source: CodexThread["source"]): string {
  if (typeof source === "string") return source;
  if (!isRecord(source)) return "codex";
  if (typeof source.custom === "string") return source.custom;
  if (source.subAgent || source.subagent) return "subagent";
  return "codex";
}

function humanizeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

function readStatusDirectory(
  dir: string,
  map: Map<string, SessionHookStatus>,
  legacyCodexOnly: boolean,
): void {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as SessionHookStatus;
      if (!parsed || typeof parsed.session_id !== "string" || typeof parsed.ts !== "number") continue;
      const transcript = typeof parsed.transcript_path === "string" ? parsed.transcript_path : "";
      const isCodex = parsed.provider === "codex" || /[/\\]\.codex[/\\]/.test(transcript);
      if (legacyCodexOnly && !isCodex) continue;
      if (!legacyCodexOnly && parsed.provider && parsed.provider !== "codex") continue;
      const current = map.get(parsed.session_id);
      if (!current || parsed.ts >= current.ts) {
        map.set(parsed.session_id, { ...parsed, provider: "codex" });
      }
    } catch {
      // A hook can be replacing the file while this poll runs.
    }
  }
}

/**
 * Read Codex-native hook state, plus legacy Codex records that older installs
 * accidentally wrote into the Claude monitor directory.
 */
export function readCodexHookStatuses(
  codexDir = CODEX_MONITOR_DIR,
  legacyClaudeDir = LEGACY_CLAUDE_MONITOR_DIR,
): Map<string, SessionHookStatus> {
  const map = new Map<string, SessionHookStatus>();
  readStatusDirectory(codexDir, map, false);
  if (legacyClaudeDir !== codexDir) readStatusDirectory(legacyClaudeDir, map, true);
  return map;
}

const REQUIRED_CODEX_HOOKS = [
  "sessionStart",
  "userPromptSubmit",
  "stop",
  "permissionRequest",
  "sessionEnd",
] as const;

function isSessionMonitorHookCommand(command: unknown): command is string {
  return (
    typeof command === "string" &&
    /session-monitor[/\\]hook\.py(?:['"])?(?:\s|$)/.test(command)
  );
}

export function codexHooksConfigured(file = CODEX_HOOKS_FILE): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!isRecord(parsed)) return false;
    const hooks = parsed.hooks;
    if (!isRecord(hooks)) return false;
    const required = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest", "SessionEnd"];
    return required.every((event) => {
      const groups = hooks[event];
      if (!Array.isArray(groups)) return false;
      return groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (hook) =>
              isRecord(hook) &&
              isSessionMonitorHookCommand(hook.command),
          ),
      );
    });
  } catch {
    return false;
  }
}

export function assessCodexHooks(response: unknown): CodexHookAssessment {
  if (!isRecord(response) || !Array.isArray(response.data)) {
    return { ready: false, missing: [...REQUIRED_CODEX_HOOKS], needsReview: [] };
  }
  const hooks: CodexHookMetadata[] = [];
  for (const entry of response.data) {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) continue;
    hooks.push(...(entry.hooks.filter(isRecord) as CodexHookMetadata[]));
  }
  const missing: string[] = [];
  const needsReview: string[] = [];
  for (const event of REQUIRED_CODEX_HOOKS) {
    const matching = hooks.filter(
      (hook) => hook.eventName === event && isSessionMonitorHookCommand(hook.command),
    );
    const trusted = matching.some(
      (hook) =>
        hook.enabled === true &&
        (hook.trustStatus === "trusted" || hook.trustStatus === "managed"),
    );
    if (trusted) continue;
    if (
      matching.some(
        (hook) =>
          hook.enabled === true &&
          (hook.trustStatus === "untrusted" || hook.trustStatus === "modified"),
      )
    ) {
      needsReview.push(event);
    } else {
      missing.push(event);
    }
  }
  return { ready: missing.length === 0 && needsReview.length === 0, missing, needsReview };
}

function hookHealth(
  hookList: PromiseSettledResult<unknown>,
  now: number,
): ProviderHealth {
  if (hookList.status === "fulfilled") {
    const assessment = assessCodexHooks(hookList.value);
    if (assessment.ready) return { provider: "codex", state: "ready", updatedAt: now };
    if (assessment.needsReview.length) {
      return {
        provider: "codex",
        state: "setup-required",
        message: "Codex lifecycle hooks need trust review. Open Codex and run /hooks.",
        updatedAt: now,
      };
    }
    return {
      provider: "codex",
      state: "setup-required",
      message:
        "Codex lifecycle hooks are incomplete. Run scripts/install.sh, then review them with /hooks.",
      updatedAt: now,
    };
  }
  return {
    provider: "codex",
    state: "setup-required",
    message: codexHooksConfigured()
      ? "Codex hooks are configured, but trust status is unavailable. Review them with /hooks."
      : "Run scripts/install.sh and review the Codex lifecycle hooks with /hooks for live state.",
    updatedAt: now,
  };
}

function synthesizeThread(hook: SessionHookStatus): CodexThread {
  const status: CodexThreadStatus =
    hook.state === "working"
      ? { type: "active" }
      : hook.state === "waiting"
        ? { type: "active", activeFlags: ["waitingOnApproval"] }
        : { type: "notLoaded" };
  return {
    id: hook.session_id,
    sessionId: hook.session_id,
    preview: hook.prompt,
    createdAt: hook.ts,
    updatedAt: hook.ts,
    status,
    path: hook.transcript_path,
    cwd: hook.cwd,
    source: "cli",
  };
}

function resolveState(
  thread: CodexThread,
  hook: SessionHookStatus | undefined,
  now: number,
): Pick<SessionView, "bucket" | "sub" | "stale"> {
  const hookResult = (status: SessionHookStatus) => {
    if (status.state === "waiting") {
      return { bucket: "attention", sub: "waiting for you", stale: false } as const;
    }
    if (status.state === "working") {
      const stale = now - Math.max(thread.updatedAt, status.ts) > STALE_SECONDS;
      return {
        bucket: "working",
        sub: stale ? "working (stalled?)" : "working",
        stale,
      } as const;
    }
    if (status.state === "idle") {
      return { bucket: "attention", sub: "your turn", stale: false } as const;
    }
    if (status.state === "ended") {
      return { bucket: "ended", sub: "ended", stale: false } as const;
    }
    return undefined;
  };

  // Hook events are exact lifecycle signals, while thread/list can briefly
  // retain the preceding app-server state. Prefer a hook that is at least as
  // recent as the thread observation. `notLoaded` carries no live state, so any
  // known hook remains the authority there. Permission timestamps get a small
  // tolerance because the same approval can advance thread metadata by a
  // second before its waiting flag clears.
  const hookIsCurrent =
    !!hook &&
    (thread.status.type === "notLoaded" ||
      (hook.state === "waiting"
        ? hook.ts + 2 >= thread.updatedAt
        : hook.ts >= thread.updatedAt));
  if (hook && hookIsCurrent) {
    const exact = hookResult(hook);
    if (exact) return exact;
  }

  if (thread.status.type === "active") {
    const flags = thread.status.activeFlags ?? [];
    if (flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput")) {
      return { bucket: "attention", sub: "waiting for you", stale: false };
    }
    return {
      bucket: "working",
      sub: now - Math.max(thread.updatedAt, hook?.ts ?? 0) > STALE_SECONDS ? "working (stalled?)" : "working",
      stale: now - Math.max(thread.updatedAt, hook?.ts ?? 0) > STALE_SECONDS,
    };
  }
  if (thread.status.type === "idle") return { bucket: "attention", sub: "your turn", stale: false };
  if (thread.status.type === "systemError") {
    return { bucket: "attention", sub: "Codex error", stale: false };
  }
  if (hook) {
    const fallback = hookResult(hook);
    if (fallback) return fallback;
  }
  // `notLoaded` only means this app-server process has not loaded the thread;
  // it does not prove that another Codex CLI/VS Code instance is closed.
  // Keep recent metadata visible with an honest unknown state until hooks
  // provide an exact idle/working/waiting/ended lifecycle signal.
  return { bucket: "unknown", sub: "live state unavailable", stale: false };
}

export function mapCodexThreads(
  threads: ReadonlyArray<CodexThread>,
  hooks: ReadonlyMap<string, SessionHookStatus>,
  opts: CodexRefreshOptions,
): SessionView[] {
  const byId = new Map<string, CodexThread>();
  for (const thread of threads) byId.set(thread.id, thread);
  for (const [id, hook] of hooks) {
    if (!byId.has(id)) byId.set(id, synthesizeThread(hook));
  }

  const views: SessionView[] = [];
  for (const thread of byId.values()) {
    const id = thread.id;
    const hook = hooks.get(id);
    const state = resolveState(thread, hook, opts.now);
    const lastActivity = Math.max(thread.recencyAt ?? 0, thread.updatedAt, hook?.ts ?? 0);
    const age = lastActivity ? opts.now - lastActivity : Infinity;
    if (opts.workspaceCwd && (hook?.cwd || thread.cwd) !== opts.workspaceCwd) continue;
    if (state.bucket === "ended" && !opts.showEnded) continue;
    if (state.bucket === "ended" && age > opts.hideEndedOlderThanSec) continue;
    if (age > opts.maxAgeSec) continue;

    const title =
      cleanLabel(thread.name) ||
      cleanLabel(thread.preview) ||
      cleanLabel(hook?.prompt) ||
      `session ${id.slice(0, 8)}`;
    const matchLabels = Array.from(
      new Set(
        [cleanLabel(thread.name), cleanLabel(thread.preview), cleanLabel(hook?.prompt), title].filter(
          (value): value is string => !!value,
        ),
      ),
    );
    const cwd = hook?.cwd || thread.cwd;
    const cwdLabel = cwd ? path.basename(cwd) : undefined;
    const transcriptPath = hook?.transcript_path || thread.path || undefined;
    const entrypoint = sourceName(thread.source);
    const ageLabel = lastActivity ? humanizeAge(age) : "";
    const detail = [ageLabel, cwdLabel].filter(Boolean).join(" · ");
    const model = cleanLabel(hook?.model);
    const tooltip = [
      title,
      "provider: Codex",
      `status: ${state.sub}`,
      model ? `model: ${model}` : "",
      cwd ? `cwd: ${cwd}` : "",
      `source: ${entrypoint}`,
      hook?.permission_mode ? `mode: ${hook.permission_mode}` : "",
      lastActivity ? `last activity: ${ageLabel} ago` : "",
      `id: ${id}`,
    ]
      .filter(Boolean)
      .join("\n");
    views.push({
      key: sessionKey("codex", id),
      provider: "codex",
      sessionId: id,
      title,
      bucket: state.bucket,
      sub: state.sub,
      detail,
      tooltip,
      capabilities: defaultCapabilities("codex", {
        transcript: !!transcriptPath,
        // A hook PID is useful for resource sampling, but Codex processes do
        // not expose a stable per-thread process identity for safe termination.
        kill: false,
        bulkInput: false,
      }),
      cwd,
      cwdLabel,
      transcriptPath,
      lastActivityMs: lastActivity * 1000,
      permissionMode: hook?.permission_mode,
      notifMessage: hook?.message,
      entrypoint,
      pid: hook?.pid,
      stale: state.stale,
      model,
      matchLabels,
    });
  }
  return views.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

function durationLabel(minutes: number | undefined, fallback: string): string {
  if (minutes === 300) return "Session (5h)";
  if (minutes === 10_080) return "Weekly (7d)";
  if (!minutes) return fallback;
  if (minutes % 1440 === 0) return `${fallback} (${minutes / 1440}d)`;
  if (minutes % 60 === 0) return `${fallback} (${minutes / 60}h)`;
  return `${fallback} (${minutes}m)`;
}

function rateLimitSnapshots(response: unknown): Array<Record<string, unknown>> {
  if (!isRecord(response)) return [];
  const byId = response.rateLimitsByLimitId;
  if (isRecord(byId)) {
    const snapshots = Object.values(byId).filter(isRecord);
    if (snapshots.length) return snapshots;
  }
  return isRecord(response.rateLimits) ? [response.rateLimits] : [];
}

/** Plan type ("plus" | "pro" | "prolite"…) when the rate-limit response carries it. */
function readPlanType(response: unknown): string | undefined {
  if (!isRecord(response)) return undefined;
  const direct = response.planType ?? response.plan_type;
  if (typeof direct === "string" && direct) return direct;
  for (const snap of rateLimitSnapshots(response)) {
    const v = snap.planType ?? snap.plan_type;
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

export function parseCodexUsage(
  rateLimitResponse: unknown,
  accountUsageResponse: unknown,
  now = Date.now() / 1000,
): ProviderUsageSnapshot | null {
  const gauges: ProviderGauge[] = [];
  const seen = new Set<string>();
  for (const snapshot of rateLimitSnapshots(rateLimitResponse)) {
    const limitId = cleanLabel(snapshot.limitId) ?? "codex";
    const limitName = cleanLabel(snapshot.limitName) ?? "Codex";
    for (const slot of ["primary", "secondary"] as const) {
      const window = snapshot[slot];
      if (!isRecord(window)) continue;
      const pct = safeNumber(window.usedPercent);
      if (pct == null) continue;
      const minutes = safeNumber(window.windowDurationMins);
      const reset = safeNumber(window.resetsAt);
      const key = `${limitId}-${slot}-${minutes ?? "window"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      gauges.push({
        key,
        label: durationLabel(minutes, slot === "primary" ? limitName : `${limitName} secondary`),
        pct: Math.min(100, pct),
        resetMs: reset == null ? null : reset * 1000,
      });
    }
  }

  let lifetimeTokens: number | undefined;
  let sevenDayTokens: number | undefined;
  if (isRecord(accountUsageResponse)) {
    const summary = accountUsageResponse.summary;
    if (isRecord(summary)) lifetimeTokens = safeNumber(summary.lifetimeTokens);
    const buckets = accountUsageResponse.dailyUsageBuckets;
    if (Array.isArray(buckets)) {
      const nowMs = now * 1000;
      const cutoffMs = (Math.floor(now / 86_400) - 6) * 86_400_000;
      const latest = buckets
        .filter(isRecord)
        .map((bucket) => ({
          date: typeof bucket.startDate === "string" ? Date.parse(bucket.startDate) : NaN,
          tokens: safeNumber(bucket.tokens) ?? 0,
        }))
        .filter(
          (bucket) =>
            Number.isFinite(bucket.date) && bucket.date >= cutoffMs && bucket.date <= nowMs,
        );
      if (latest.length) sevenDayTokens = latest.reduce((sum, bucket) => sum + bucket.tokens, 0);
    }
  }
  if (!gauges.length && lifetimeTokens == null && sevenDayTokens == null) return null;
  const planType = readPlanType(rateLimitResponse);
  return {
    provider: "codex",
    label: providerLabel("codex"),
    ts: now,
    gauges,
    sevenDayTokens,
    lifetimeTokens,
    ...(planType ? { planType } : {}),
  };
}

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not found|spawn .*codex/i.test(raw)) {
    return "Codex CLI not found. Install Codex or set the Codex executable in Settings.";
  }
  return `Codex app-server unavailable: ${raw.replace(os.homedir(), "~").slice(0, 180)}`;
}

export class CodexAppServerClient {
  private proc?: ChildProcessWithoutNullStreams;
  private lines?: readline.Interface;
  private ready?: Promise<void>;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private disposed = false;
  private lastGood?: CodexProviderSnapshot;

  constructor(
    private readonly executable = "codex",
    private readonly requestTimeoutMs = 10_000,
  ) {}

  async refresh(opts: CodexRefreshOptions): Promise<CodexProviderSnapshot> {
    try {
      const threads = await this.listThreads(opts);
      const [rateLimits, accountUsage, hooksList] = await Promise.allSettled([
        this.request("account/rateLimits/read"),
        this.request("account/usage/read"),
        this.request("hooks/list", { cwds: opts.workspaceCwd ? [opts.workspaceCwd] : [] }),
      ]);
      const hooks = readCodexHookStatuses();
      const sessions = mapCodexThreads(threads, hooks, opts);
      const usage = parseCodexUsage(
        rateLimits.status === "fulfilled" ? rateLimits.value : null,
        accountUsage.status === "fulfilled" ? accountUsage.value : null,
        opts.now,
      );
      const usageFailures = [rateLimits, accountUsage].filter((result) => result.status === "rejected").length;
      if (usage && usageFailures) {
        usage.note = "Some Codex account usage fields are temporarily unavailable.";
      }
      const health = hookHealth(hooksList, opts.now);
      const snapshot = { sessions, usage, health };
      this.lastGood = snapshot;
      return snapshot;
    } catch (error) {
      return {
        sessions: this.lastGood?.sessions ?? [],
        usage: this.lastGood?.usage ?? null,
        health: {
          provider: "codex",
          state: "degraded",
          message: safeErrorMessage(error),
          updatedAt: opts.now,
        },
      };
    }
  }

  dispose(): void {
    this.disposed = true;
    this.rejectPending(new Error("Codex app-server client disposed"));
    this.lines?.close();
    this.lines = undefined;
    this.proc?.kill("SIGTERM");
    this.proc = undefined;
    this.ready = undefined;
  }

  private async listThreads(opts: CodexRefreshOptions): Promise<CodexThread[]> {
    const threads: CodexThread[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page++) {
      const response: ThreadListResponse = await this.request<ThreadListResponse>("thread/list", {
        cursor,
        limit: 200,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: ["cli", "vscode", "appServer"],
        archived: false,
        cwd: opts.workspaceCwd,
        useStateDbOnly: true,
      });
      if (!isRecord(response) || !Array.isArray(response.data)) {
        throw new Error("thread/list returned an unexpected response");
      }
      threads.push(...(response.data as CodexThread[]));
      cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
      if (!cursor) break;
      const oldest = threads[threads.length - 1]?.updatedAt ?? opts.now;
      if (oldest < opts.now - opts.maxAgeSec) break;
    }
    return threads;
  }

  private async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    await this.ensureReady();
    return this.rawRequest<T>(method, params);
  }

  private ensureReady(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Codex app-server client disposed"));
    if (this.ready) return this.ready;
    this.ready = this.launch().catch((error) => {
      this.ready = undefined;
      this.proc?.kill("SIGTERM");
      this.proc = undefined;
      throw error;
    });
    return this.ready;
  }

  private async launch(): Promise<void> {
    const proc = spawn(this.executable, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.proc = proc;
    proc.stderr.on("data", () => {
      // Drain stderr without persisting auth, paths, or transcript diagnostics.
    });
    this.lines = readline.createInterface({ input: proc.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    proc.once("error", (error) => this.handleProcessFailure(error));
    proc.once("exit", (code, signal) => {
      this.handleProcessFailure(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    });
    await this.rawRequest("initialize", {
      clientInfo: {
        name: "softween_agent_session_monitor",
        title: "Agent Session Monitor",
        version: "2.0.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.write({ method: "initialized" });
  }

  private rawRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private write(message: Record<string, unknown>): void {
    if (!this.proc?.stdin.writable) throw new Error("Codex app-server is not writable");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || `Codex RPC error ${message.error.code ?? ""}`.trim()));
    } else {
      pending.resolve(message.result);
    }
  }

  private handleProcessFailure(error: Error): void {
    this.lines?.close();
    this.lines = undefined;
    this.proc = undefined;
    this.ready = undefined;
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
