/**
 * remoteBridge.ts — vscode glue for the optional remote bridge. Off unless
 * `claudeSessionMonitor.remote.url` is set AND a token is stored (SecretStorage
 * key `csm.remote.token`). When on it pushes the panel's snapshot to
 * `<url>/fleet/ingest` (on change, >= 10 s apart, 2 min heartbeat) and long-polls
 * `<url>/fleet/commands` (one request ~every 25 s), running each command through
 * the extension's existing actions and posting its result.
 */
import { execFile } from "child_process";
import * as os from "os";
import * as vscode from "vscode";
import type { PeerSendResult } from "./peerSend";
import type { SessionView } from "./providers/types";
import {
  buildSnapshot,
  checkRemoteUrl,
  originMatches,
  parseStoredToken,
  nextBackoff,
  pressureLabel,
  sampleMachine,
  shouldPush,
  snapshotHash,
  type SnapshotAccountInput,
} from "./remote";

export const REMOTE_TOKEN_KEY = "csm.remote.token";
const POLL_WAIT_SEC = 25;
const POLL_TIMEOUT_MS = (POLL_WAIT_SEC + 10) * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const MIN_POLL_CYCLE_MS = 20_000; // an early empty answer never turns the long-poll into a busy loop
const PRESSURE_SAMPLE_MS = 30_000;

export interface FleetCommand {
  id: string;
  type: string;
  sessionId?: string | null;
  text?: string | null;
  account?: string | null;
  createdAt?: number;
}

export interface CommandOutcome { ok: boolean; message: string }

export type TypedResult = { ok: true; via?: "terminal" | "typed" } | { ok: false; reason: string; detail: string };

const TYPED_REASON: Record<string, string> = {
  "not-frontmost": "VS Code not frontmost (Mac locked or another app in front)",
  "tab-mismatch": "the session's tab could not be made active",
  accessibility: "macOS Accessibility permission missing for VS Code",
  aborted: "typing was interrupted",
  keystroke: "keystroke failed",
};

/**
 * Remote `send`: the uds-messaging inbox first (works without focus), then, when
 * that is not confirmed in the transcript (any failed result, `unconfirmed`
 * included, or a throw), type the text into that session's tab. The result names
 * the path that delivered it ("uds" / "typed") or why both failed.
 */
export async function deliverText(o: {
  uds: () => Promise<PeerSendResult>;
  typed: () => Promise<TypedResult>;
}): Promise<CommandOutcome> {
  let udsWhy: string;
  try {
    const r = await o.uds();
    if (r.ok) return { ok: true, message: `delivered via uds (${r.confirmed}, msg_id ${r.msgId})` };
    udsWhy = `${r.code}: ${r.error}`;
  } catch (e) {
    udsWhy = `error: ${String(e)}`;
  }
  let typed: TypedResult;
  try {
    typed = await o.typed();
  } catch (e) {
    typed = { ok: false, reason: "keystroke", detail: String(e) };
  }
  if (typed.ok) return { ok: true, message: `delivered via ${typed.via ?? "typed"} (uds ${udsWhy})` };
  const why = TYPED_REASON[typed.reason] ?? typed.reason;
  return { ok: false, message: `not delivered: uds ${udsWhy}; typed failed: ${why} (${typed.detail})` };
}

export interface RemoteBridgeDeps {
  log: (msg: string) => void;
  accounts: () => { accounts: SnapshotAccountInput[]; bestId: string | null };
  execute: (cmd: FleetCommand) => Promise<CommandOutcome>;
}

interface BridgeCfg { url: string; host: string; token: string }

class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`HTTP ${status}${body ? ": " + body.slice(0, 200) : ""}`);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

export class RemoteBridge implements vscode.Disposable {
  private cfg: BridgeCfg | undefined;
  private stop: AbortController | undefined;
  private lastHash = "";
  private lastPushTs = 0;
  private pushRetryAt = 0;
  private pushBackoff = 0;
  private pushInflight = false;
  private lastPollTs = 0;
  private lastError = "";
  private lastErrorTs = 0;
  private pressure: string | null = null;
  private lastPressureSample = 0;
  private restartSeq = 0;
  private warnedOrigin = ""; // url whose origin mismatch was already shown once

  private readonly userAgent: string;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly deps: RemoteBridgeDeps) {
    // Cloudflare answers 403 (error 1010) to generic fetch user agents.
    const version = (ctx.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";
    this.userAgent = `claude-session-monitor/${version}`;
  }

  get running(): boolean {
    return !!this.cfg;
  }

  /** (Re)read url + host + token; start when url and token are present, otherwise stay off. */
  async restart(): Promise<void> {
    const seq = ++this.restartSeq;
    this.halt();
    const rawUrl = remoteSetting("remote.url");
    const host = (remoteSetting("remote.host") || os.hostname()).slice(0, 64);
    const stored = parseStoredToken(await this.ctx.secrets.get(REMOTE_TOKEN_KEY));
    if (seq !== this.restartSeq) return; // a newer restart won
    if (!rawUrl || !stored) return;
    const checked = checkRemoteUrl(rawUrl);
    if ("error" in checked) {
      this.fail(checked.error);
      return;
    }
    const url = checked.url;
    if (!originMatches(stored.origin, url)) {
      // The token is bound to the origin it was entered for: a changed url never receives it.
      this.fail(`remote.url origin ${checked.origin} differs from the token's origin ${stored.origin}; bridge stays off`);
      if (this.warnedOrigin !== url) {
        this.warnedOrigin = url;
        vscode.window.showWarningMessage(
          `Agent Sessions: the remote bridge token was saved for ${stored.origin}, not ${checked.origin}. Run "Agent Sessions: Set remote bridge token" again to use it with the new URL.`,
        );
      }
      return;
    }
    this.cfg = { url, host, token: stored.token };
    this.stop = new AbortController();
    this.deps.log(`remote: bridge on (${url}, host ${host})`);
    void this.pollLoop(this.cfg, this.stop.signal);
  }

  /** Called from the extension's poll cycle once the rows are resolved. */
  onRows(rows: SessionView[]): void {
    const cfg = this.cfg;
    if (!cfg || this.pushInflight) return;
    const now = Date.now();
    if (now < this.pushRetryAt) return;
    this.samplePressure(now);
    let body;
    try {
      const { accounts, bestId } = this.deps.accounts();
      body = buildSnapshot({
        host: cfg.host,
        rows,
        accounts,
        bestAccountId: bestId,
        machine: sampleMachine(this.pressure, rows.length),
        now,
      });
    } catch (e) {
      this.fail("snapshot failed: " + String(e));
      return;
    }
    const hash = snapshotHash(body);
    if (!shouldPush({ changed: hash !== this.lastHash, lastPushTs: this.lastPushTs, now })) return;
    this.pushInflight = true;
    const signal = this.stop?.signal;
    this.request(cfg, "POST", "/fleet/ingest", body, REQUEST_TIMEOUT_MS, signal)
      .then(() => {
        if (this.cfg !== cfg) return;
        this.lastHash = hash;
        this.lastPushTs = Date.now();
        this.pushBackoff = 0;
        this.pushRetryAt = 0;
      })
      .catch((e) => {
        if (this.cfg !== cfg) return;
        this.pushBackoff = nextBackoff(this.pushBackoff);
        this.pushRetryAt = Date.now() + this.pushBackoff;
        this.fail(`push failed (retry in ${this.pushBackoff / 1000}s): ${String(e)}`);
      })
      .finally(() => {
        this.pushInflight = false;
      });
  }

  status(): string {
    const at = (ts: number) => (ts ? new Date(ts).toLocaleTimeString() : "never");
    if (!this.cfg) {
      return `Remote bridge is off (set claudeSessionMonitor.remote.url and run "Agent Sessions: Set remote bridge token").${
        this.lastError ? ` Last error: ${this.lastError}` : ""
      }`;
    }
    return [
      `Remote bridge on · host ${this.cfg.host}`,
      `last push ${at(this.lastPushTs)}`,
      `last poll ${at(this.lastPollTs)}`,
      this.lastError ? `last error (${at(this.lastErrorTs)}): ${this.lastError}` : "no errors",
    ].join(" · ");
  }

  dispose(): void {
    this.restartSeq++;
    this.halt();
  }

  private halt(): void {
    this.stop?.abort();
    this.stop = undefined;
    this.cfg = undefined;
    this.lastHash = "";
    this.lastPushTs = 0;
    this.pushRetryAt = 0;
    this.pushBackoff = 0;
  }

  private fail(msg: string): void {
    this.lastError = msg;
    this.lastErrorTs = Date.now();
    this.deps.log("remote: " + msg);
  }

  private samplePressure(now: number): void {
    if (process.platform !== "darwin" || now - this.lastPressureSample < PRESSURE_SAMPLE_MS) return;
    this.lastPressureSample = now;
    execFile("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { timeout: 2000 }, (err, stdout) => {
      const n = err ? NaN : Number(String(stdout).trim());
      this.pressure = pressureLabel(Number.isFinite(n) ? n : null);
    });
  }

  private async pollLoop(cfg: BridgeCfg, signal: AbortSignal): Promise<void> {
    let backoff = 0;
    while (!signal.aborted) {
      const started = Date.now();
      try {
        const data = (await this.request(
          cfg,
          "GET",
          `/fleet/commands?host=${encodeURIComponent(cfg.host)}&wait=${POLL_WAIT_SEC}`,
          undefined,
          POLL_TIMEOUT_MS,
          signal,
        )) as { commands?: FleetCommand[] } | undefined;
        if (signal.aborted) return;
        this.lastPollTs = Date.now();
        backoff = 0;
        const commands = Array.isArray(data?.commands) ? data!.commands : [];
        for (const cmd of commands) {
          if (signal.aborted) return;
          await this.runCommand(cfg, cmd, signal);
        }
        const elapsed = Date.now() - started;
        if (!commands.length && elapsed < MIN_POLL_CYCLE_MS) await sleep(MIN_POLL_CYCLE_MS - elapsed, signal);
      } catch (e) {
        if (signal.aborted) return;
        backoff = nextBackoff(backoff);
        this.fail(`command poll failed (retry in ${backoff / 1000}s): ${String(e)}`);
        await sleep(backoff, signal);
      }
    }
  }

  private async runCommand(cfg: BridgeCfg, cmd: FleetCommand, signal: AbortSignal): Promise<void> {
    if (!cmd || typeof cmd.id !== "string" || !cmd.id) return;
    let out: CommandOutcome;
    try {
      out = await this.deps.execute(cmd);
    } catch (e) {
      out = { ok: false, message: String(e) };
    }
    this.deps.log(`remote: command ${cmd.type} ${cmd.id.slice(0, 8)} -> ${out.ok ? "ok" : "failed"}: ${out.message}`);
    try {
      await this.request(
        cfg,
        "POST",
        `/fleet/commands/${encodeURIComponent(cmd.id)}/result`,
        { ok: out.ok, message: out.message.slice(0, 1000) },
        REQUEST_TIMEOUT_MS,
        signal,
      );
    } catch (e) {
      if (!signal.aborted) this.fail(`result post for ${cmd.id} failed: ${String(e)}`);
    }
  }

  /** One JSON request with a timeout; resolves the envelope's `data`, throws on HTTP or envelope errors. */
  private async request(
    cfg: BridgeCfg,
    method: "GET" | "POST",
    pathAndQuery: string,
    body: unknown,
    timeoutMs: number,
    outer?: AbortSignal,
  ): Promise<unknown> {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    outer?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(cfg.url + pathAndQuery, {
        method,
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          "User-Agent": this.userAgent,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text);
      let json: { success?: boolean; data?: unknown; error?: { message?: string } };
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error("response is not JSON");
      }
      if (json.success === false) throw new Error(json.error?.message ?? "request failed");
      return json.data;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * User (global) value only: url and host are application-scoped, and a workspace's
 * .vscode/settings.json must never redirect the bridge (and its bearer token).
 */
export function remoteSetting(key: "remote.url" | "remote.host"): string {
  const v = vscode.workspace.getConfiguration("claudeSessionMonitor").inspect<string>(key)?.globalValue;
  return typeof v === "string" ? v.trim() : "";
}

/** Register the bridge, its two commands and its lifecycle hooks; returns the bridge for the poll cycle. */
export function registerRemoteBridge(ctx: vscode.ExtensionContext, deps: RemoteBridgeDeps): RemoteBridge {
  const bridge = new RemoteBridge(ctx, deps);
  ctx.subscriptions.push(
    bridge,
    vscode.commands.registerCommand("claudeSessionMonitor.setRemoteToken", async () => {
      const v = await vscode.window.showInputBox({
        title: "Agent Sessions: remote bridge token",
        prompt: "Bearer token for the remote bridge, bound to the origin of the current remote.url. Leave empty to clear it.",
        password: true,
        ignoreFocusOut: true,
      });
      if (v === undefined) return;
      if (v.trim()) {
        const checked = checkRemoteUrl(remoteSetting("remote.url"));
        if (!remoteSetting("remote.url") || "error" in checked) {
          vscode.window.showErrorMessage(
            `Agent Sessions: set claudeSessionMonitor.remote.url (user settings) first; the token is bound to its origin.${
              "error" in checked && remoteSetting("remote.url") ? " " + checked.error : ""
            }`,
          );
          return;
        }
        await ctx.secrets.store(REMOTE_TOKEN_KEY, JSON.stringify({ origin: checked.origin, token: v.trim() }));
        vscode.window.showInformationMessage(`Agent Sessions: remote bridge token saved for ${checked.origin}.`);
      } else {
        await ctx.secrets.delete(REMOTE_TOKEN_KEY);
        vscode.window.showInformationMessage("Agent Sessions: remote bridge token cleared.");
      }
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.remoteStatus", () => {
      vscode.window.showInformationMessage(bridge.status());
    }),
    ctx.secrets.onDidChange((e) => {
      if (e.key === REMOTE_TOKEN_KEY) void bridge.restart();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSessionMonitor.remote")) void bridge.restart();
    }),
  );
  void bridge.restart();
  return bridge;
}
