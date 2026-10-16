// Shared vault with ~/.claude/bin/claude-switch: one macOS keychain generic
// password per account (service "claude-switch", account = accountUuid). The CLI
// keeper owns refreshing passive tokens; the extension only reads/seeds this vault.
// Pure helpers first (unit-tested), thin `security` I/O last. Token values are
// never logged and never placed on argv.

import { execFile, spawn } from "child_process";
import type { OAuthBlob } from "./rotation";

export const CLI_VAULT_SERVICE = "claude-switch";
const UUID_RE = /^[0-9a-f-]{36}$/;

export interface CliVaultBlob {
  claudeAiOauth?: OAuthBlob;
  oauthAccount?: Record<string, unknown>;
  email?: string;
  savedAt?: number; // epoch seconds
  [k: string]: unknown;
}

export type PassiveSource = "use-cli" | "use-own-and-seed" | "use-own";

/** Which token pair a passive account's usage poll should use. */
export function decidePassiveSource(own: OAuthBlob | null | undefined, cli: OAuthBlob | null | undefined): PassiveSource {
  if (!cli) return own ? "use-own-and-seed" : "use-own";
  if (!own) return "use-cli";
  const cliExp = typeof cli.expiresAt === "number" ? cli.expiresAt : 0;
  const ownExp = typeof own.expiresAt === "number" ? own.expiresAt : 0;
  if (cliExp >= ownExp) return "use-cli";
  return own.refreshToken !== cli.refreshToken ? "use-own-and-seed" : "use-own";
}

/** Seed the CLI vault once per distinct refresh token (never loop-write the same one). */
export function shouldSeed(lastSeededRefreshToken: string | undefined, refreshToken: string | undefined): boolean {
  return !!refreshToken && lastSeededRefreshToken !== refreshToken;
}

/** `security -w` prints the password as text, or as hex when it is not plain printable text. */
export function decodeSecurityOutput(out: string): string {
  const s = out.trim();
  if (s.startsWith("{")) return s;
  if (s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) return Buffer.from(s, "hex").toString("utf8");
  return s;
}

export function parseCliVaultOutput(out: string): CliVaultBlob | null {
  try {
    const v: unknown = JSON.parse(decodeSecurityOutput(out));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as CliVaultBlob) : null;
  } catch {
    return null;
  }
}

/** The single stdin line for `security -i`; the JSON travels hex-encoded, never on argv. */
export function buildAddCommand(uuid: string, blob: CliVaultBlob): string {
  if (!UUID_RE.test(uuid)) throw new Error("invalid account uuid");
  const hex = Buffer.from(JSON.stringify(blob), "utf8").toString("hex");
  return `add-generic-password -U -a "${uuid}" -s "${CLI_VAULT_SERVICE}" -X ${hex}\n`;
}

/** The blob the extension seeds into the CLI vault from its own SecretStorage data. */
export function buildSeedBlob(own: OAuthBlob, oauthAccount: Record<string, unknown> | undefined, nowMs: number): CliVaultBlob {
  const email = typeof oauthAccount?.emailAddress === "string" ? oauthAccount.emailAddress : undefined;
  return { claudeAiOauth: own, oauthAccount: oauthAccount ?? {}, ...(email ? { email } : {}), savedAt: Math.floor(nowMs / 1000) };
}

/** Accounts whose CLI and own tokens are both expired: the keeper has to refresh them. */
export const keeperWaiting = new Set<string>();

export function readCliVault(uuid: string, debug: (m: string) => void = () => {}): Promise<CliVaultBlob | null> {
  if (!UUID_RE.test(uuid)) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(
      "security",
      ["find-generic-password", "-s", CLI_VAULT_SERVICE, "-a", uuid, "-w"],
      { encoding: "utf8", timeout: 8000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          const code: unknown = (err as { code?: unknown }).code;
          if (code !== 44) debug(`cli vault read failed (acct ${uuid.slice(0, 8)}): code ${String(code)}`);
          resolve(null);
          return;
        }
        const blob = parseCliVaultOutput(String(stdout));
        if (!blob) debug(`cli vault entry unreadable (acct ${uuid.slice(0, 8)})`);
        resolve(blob);
      },
    );
  });
}

export function writeCliVault(uuid: string, blob: CliVaultBlob, debug: (m: string) => void = () => {}): Promise<boolean> {
  let line: string;
  try {
    line = buildAddCommand(uuid, blob);
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    try {
      const p = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
      const timer = setTimeout(() => p.kill(), 8000);
      p.on("error", () => {
        clearTimeout(timer);
        debug(`cli vault write failed (acct ${uuid.slice(0, 8)}): spawn`);
        resolve(false);
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) debug(`cli vault write failed (acct ${uuid.slice(0, 8)}): exit ${String(code)}`);
        resolve(code === 0);
      });
      p.stdin.on("error", () => {});
      p.stdin.end(line);
    } catch {
      resolve(false);
    }
  });
}
