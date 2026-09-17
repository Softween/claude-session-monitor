import type {
  ProviderHealth,
  ProviderUsageSnapshot,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 2_000;

const QUOTA_LABELS: Record<string, string> = {
  premium_interactions: "Premium interactions",
  chat: "Chat",
  completions: "Completions",
};

export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<unknown>;
  forceStop?(): Promise<void>;
  getAuthStatus?(): Promise<{ isAuthenticated: boolean }>;
  rpc: {
    account: {
      getQuota(params: Record<string, never>): Promise<unknown>;
    };
  };
}

export interface CopilotQuotaOptions {
  executable: string | undefined;
  trustedWorkspace?: boolean;
  now?: number;
  timeoutMs?: number;
  createClient?: (executable: string) => Promise<CopilotClientLike>;
}

export interface CopilotProviderSnapshot {
  usage: ProviderUsageSnapshot | null;
  health: ProviderHealth;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function quotaGauge(
  key: string,
  value: unknown,
): ProviderUsageSnapshot["gauges"][number] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.hasQuota === false) return undefined;
  const usedRequests = nonNegativeNumber(value.usedRequests);
  const entitlementRequests =
    typeof value.entitlementRequests === "number" && Number.isFinite(value.entitlementRequests)
      ? value.entitlementRequests
      : undefined;
  const remainingPercentage = nonNegativeNumber(value.remainingPercentage);
  if (
    usedRequests === undefined ||
    entitlementRequests === undefined ||
    remainingPercentage === undefined ||
    remainingPercentage > 100
  ) {
    return undefined;
  }

  const unlimited = entitlementRequests === -1 || value.isUnlimitedEntitlement === true;
  if ((!unlimited && entitlementRequests <= 0) || entitlementRequests < -1) return undefined;
  const pct = unlimited ? null : Math.max(0, Math.min(100, 100 - remainingPercentage));
  const baseLabel = QUOTA_LABELS[key] ?? humanizeQuotaKey(key);
  const label = unlimited ? `${baseLabel} (unlimited)` : baseLabel;
  return {
    key,
    label,
    pct,
    // The CLI currently returns resetDate at fetch time for some quotas, so it
    // is deliberately not presented as a reset promise.
    resetMs: null,
    usedRequests,
    entitlementRequests: unlimited ? -1 : entitlementRequests,
    unitLabel: value.tokenBasedBilling === true ? "credits" : "quota units",
  };
}

function humanizeQuotaKey(key: string): string {
  const label = key
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (character) => character.toUpperCase())
    .slice(0, 80);
  return label || "Other quota";
}

/**
 * Safely turns the documented Copilot account quota response into display data.
 * Only documented quota fields are consumed; invalid responses remain unknown.
 */
export function parseCopilotQuota(
  response: unknown,
  now = Date.now() / 1000,
): ProviderUsageSnapshot | null {
  if (!isRecord(response) || !isRecord(response.quotaSnapshots)) return null;
  const gauges = Object.entries(response.quotaSnapshots)
    .map(([key, value]) => quotaGauge(key, value))
    .filter((gauge): gauge is ProviderUsageSnapshot["gauges"][number] => !!gauge);
  if (!gauges.length) return null;
  return {
    provider: "copilot",
    label: "Copilot",
    ts: now,
    gauges,
  };
}

function timeoutAfter<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Copilot quota read timed out")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function stopClient(client: CopilotClientLike): Promise<void> {
  try {
    await timeoutAfter(client.stop(), STOP_TIMEOUT_MS);
  } catch {
    try {
      await timeoutAfter(client.forceStop?.() ?? Promise.resolve(), STOP_TIMEOUT_MS);
    } catch {
      // Shutdown is best-effort. Do not expose transport or auth details.
    }
  }
}

async function defaultCreateClient(executable: string): Promise<CopilotClientLike> {
  const sdk = await import("@github/copilot-sdk");
  return new sdk.CopilotClient({
    connection: sdk.RuntimeConnection.forStdio({ path: executable }),
    logLevel: "error",
  });
}

function unavailable(
  state: ProviderHealth["state"],
  message: string,
): CopilotProviderSnapshot {
  return {
    usage: null,
    health: { provider: "copilot", state, message, updatedAt: Date.now() / 1000 },
  };
}

async function quotaFailure(
  client: CopilotClientLike | undefined,
  started: boolean,
): Promise<CopilotProviderSnapshot> {
  try {
    const auth =
      started && client?.getAuthStatus
        ? await timeoutAfter(client.getAuthStatus(), 1_000)
        : undefined;
    if (auth?.isAuthenticated === false) {
      return unavailable("setup-required", "Copilot is not signed in. Sign in with the Copilot CLI to enable quota.");
    }
  } catch {
    // A failed auth-status check is not evidence of a missing login.
  }
  return unavailable("degraded", "Copilot quota unavailable; retry or check CLI compatibility.");
}

/**
 * Reads the current signed-in Copilot account's quota through the official SDK.
 * It never creates a model session or starts an authentication flow.
 */
export async function collectCopilotQuota(
  options: CopilotQuotaOptions,
): Promise<CopilotProviderSnapshot> {
  if (options.trustedWorkspace === false) {
    return unavailable("setup-required", "Copilot usage is available only in a trusted workspace.");
  }
  if (!options.executable) {
    return unavailable("setup-required", "Copilot CLI was not found. Set the Copilot executable in settings.");
  }

  let client: CopilotClientLike | undefined;
  let cancelled = false;
  let started = false;
  try {
    const createClient = options.createClient ?? defaultCreateClient;
    const createdClient = createClient(options.executable).then(async (created) => {
      // A client constructor can finish after the timeout. It still owns a
      // potential runtime process, so close it instead of leaving it behind.
      if (cancelled) await stopClient(created);
      return created;
    });
    client = await timeoutAfter(createdClient, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const response = await timeoutAfter(
      (async () => {
        await client!.start();
        started = true;
        if (cancelled) {
          // stop() before start settles cannot reliably stop every runtime;
          // repeat cleanup once start owns its child process.
          await stopClient(client!);
          return null;
        }
        return client!.rpc.account.getQuota({});
      })(),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (response === null) {
      return quotaFailure(client, started);
    }
    const completedAt = options.now ?? Date.now() / 1000;
    const usage = parseCopilotQuota(response, completedAt);
    if (!usage) {
      return unavailable("degraded", "Copilot quota unavailable; retry or check CLI compatibility.");
    }
    return {
      usage,
      health: { provider: "copilot", state: "ready", updatedAt: completedAt },
    };
  } catch {
    return quotaFailure(client, started);
  } finally {
    cancelled = true;
    if (client) await stopClient(client);
  }
}
