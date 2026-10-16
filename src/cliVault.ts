// Shared vault with ~/.claude/bin/claude-switch: one JSON file per account
// (<accountUuid>.json) in ~/.claude/state/claude-switch/vault/ (dir 0700, files 0600).
// The CLI keeper owns refreshing passive tokens; the extension only reads/seeds this vault.
// Pure helpers first (unit-tested), thin file I/O last. Token values are never logged.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { OAuthBlob } from "./rotation";

export const CLI_VAULT_DIR = path.join(os.homedir(), ".claude", "state", "claude-switch", "vault");
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

/** Vault file path for an account, or null when the uuid is not a plain uuid (no path escape). */
export function vaultFilePath(uuid: string, dir: string = CLI_VAULT_DIR): string | null {
  return UUID_RE.test(uuid) ? path.join(dir, `${uuid}.json`) : null;
}

/** The blob the extension seeds into the CLI vault from its own SecretStorage data. */
export function buildSeedBlob(own: OAuthBlob, oauthAccount: Record<string, unknown> | undefined, nowMs: number): CliVaultBlob {
  const email = typeof oauthAccount?.emailAddress === "string" ? oauthAccount.emailAddress : undefined;
  return { claudeAiOauth: own, oauthAccount: oauthAccount ?? {}, ...(email ? { email } : {}), savedAt: Math.floor(nowMs / 1000) };
}

/** Accounts whose CLI and own tokens are both expired: the keeper has to refresh them. */
export const keeperWaiting = new Set<string>();

export async function readCliVault(uuid: string, debug: (m: string) => void = () => {}, dir: string = CLI_VAULT_DIR): Promise<CliVaultBlob | null> {
  const file = vaultFilePath(uuid, dir);
  if (!file) return null;
  try {
    const v: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as CliVaultBlob;
    debug(`cli vault entry unreadable (acct ${uuid.slice(0, 8)})`);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code !== "ENOENT") debug(`cli vault read failed (acct ${uuid.slice(0, 8)}): ${String(code ?? "parse")}`);
  }
  return null;
}

export async function writeCliVault(
  uuid: string,
  blob: CliVaultBlob,
  debug: (m: string) => void = () => {},
  dir: string = CLI_VAULT_DIR,
): Promise<boolean> {
  const file = vaultFilePath(uuid, dir);
  if (!file) return false;
  const tmp = path.join(dir, `.${uuid}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(dir, 0o700);
    const fh = await fs.promises.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(JSON.stringify(blob), "utf8");
    } finally {
      await fh.close();
    }
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, file);
    return true;
  } catch (e) {
    debug(`cli vault write failed (acct ${uuid.slice(0, 8)}): ${String((e as { code?: unknown }).code ?? "error")}`);
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    return false;
  }
}
