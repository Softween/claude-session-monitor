// Which path an account switch takes. With the claude-switch CLI installed it
// owns switching: its `use` takes its run lock, and it rotates on its own, so a
// remote switch starts `claude-switch use` and the extension's auto-rotate stays
// off. Without it, the extension's own switch (rotation.ts performSwitch) runs
// under an O_EXCL lock file that every VS Code window shares. No vscode import:
// unit-tested with fakes.
import * as fs from "fs";
import * as path from "path";
import { pidAlive } from "./core";
import { pickBestAccount, type RotationAccount } from "./rotation";
import { panelAge, type SwitchPanel } from "./switchPanel";

/** Oldest panel.json a remote switch trusts to say which accounts claude-switch knows now. */
export const REMOTE_PANEL_MAX_AGE_SEC = 300;

/** A lock older than this is taken over even while its pid looks alive (the pid may have been reused). */
export const SWITCH_LOCK_STALE_MS = 5 * 60_000;

export interface SwitchTarget extends RotationAccount {
  email: string;
  active: boolean;
}

export interface RemoteSwitchDeps {
  accounts(): SwitchTarget[];
  switchInstalled(): boolean;
  readPanel(): SwitchPanel | null;
  nowMs(): number;
  /** A switch this window started is still running. */
  busy(): boolean;
  /** Starts `claude-switch use <email>` the way the panel's Use button does; null once started, else why it did not start. */
  startUse(email: string): string | null;
  /** The extension's own switch; true when the target is the active login afterwards. */
  switchDirect(id: string): Promise<boolean>;
}

/**
 * The remote `switchAccount` (an email, an account id or "best"). With
 * claude-switch installed it only starts `claude-switch use`, and only when
 * panel.json is at most 5 minutes old and lists the target; it answers at once
 * ("started"), since a `use` can outlast the relay's 60 s command timeout, and
 * the account list in the next snapshots shows the result.
 */
export async function remoteSwitch(account: string, deps: RemoteSwitchDeps): Promise<{ ok: boolean; message: string }> {
  if (deps.busy()) return { ok: false, message: "an account switch is already running" };
  const views = deps.accounts();
  const want = account.trim().toLowerCase();
  const target =
    want === "best" ? pickBestAccount(views) : views.find((a) => a.id.toLowerCase() === want || a.email.toLowerCase() === want);
  if (!target) return { ok: false, message: want === "best" ? "no other account with usage data" : `unknown account ${account}` };
  if (target.active) return { ok: true, message: `already on ${target.email}` };
  if (!deps.switchInstalled()) {
    return (await deps.switchDirect(target.id))
      ? { ok: true, message: `switched to ${target.email}` }
      : { ok: false, message: `switch to ${target.email} did not complete` };
  }
  const panel = deps.readPanel();
  if (!panel) return { ok: false, message: "claude-switch is installed but its panel.json is missing or unreadable; not switching" };
  const age = panelAge(panel, deps.nowMs());
  if (age > REMOTE_PANEL_MAX_AGE_SEC) return { ok: false, message: `claude-switch's panel.json is ${age} s old (over 5 min); not switching` };
  const listed = (panel.accounts ?? []).find((a) => a.email.toLowerCase() === target.email.toLowerCase());
  if (!listed) return { ok: false, message: `claude-switch does not list ${target.email}; not switching` };
  const notStarted = deps.startUse(listed.email);
  if (notStarted) return { ok: false, message: notStarted };
  return { ok: true, message: `started: claude-switch use ${listed.email}; the account list shows the result when it finishes` };
}

/** The extension's auto-rotate runs only when it is turned on and claude-switch, which rotates by itself, is not installed. */
export function autoRotateOn(setting: boolean, switchInstalled: boolean): boolean {
  return setting && !switchInstalled;
}

export interface LockDeps {
  pid: number;
  nowMs(): number;
  alive(pid: number): boolean;
}

const systemLock: LockDeps = { pid: process.pid, nowMs: () => Date.now(), alive: (pid) => pidAlive(pid) !== false };

/** A held lock is stale when its holder is gone, it is too old, or it stayed half-written (a holder that died at once). */
function lockStale(raw: string, mtimeMs: number, deps: LockDeps): boolean {
  const [pidText, atText] = raw.split(" ");
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return deps.nowMs() - mtimeMs > 10_000;
  return !deps.alive(pid) || deps.nowMs() - at > SWITCH_LOCK_STALE_MS;
}

/**
 * Takes the account-switch lock: `file`, created with O_EXCL (mode 0600), holds
 * "<pid> <ms> <nonce>". Returns its release, or null while another live switch
 * holds it. A stale lock (see lockStale) is taken over. The release removes the
 * file only while it still holds this taker's line.
 */
export function acquireSwitchLock(file: string, deps: LockDeps = systemLock): (() => void) | null {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const mine = `${deps.pid} ${deps.nowMs()} ${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (fs.readFileSync(file, "utf8") === mine) fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held: string;
    let mtimeMs: number;
    try {
      held = fs.readFileSync(file, "utf8");
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      continue; // released in between: try again
    }
    if (!lockStale(held, mtimeMs, deps)) return null;
    try {
      if (fs.readFileSync(file, "utf8") === held) fs.unlinkSync(file);
    } catch {
      /* someone else took it over first */
    }
  }
  return null;
}
