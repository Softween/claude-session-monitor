// Which Claude account is the active login, whose usage the active card and the
// status bar show, and what the panel says after `claude-switch use`. Pure
// helpers (no vscode import) so they are unit-tested.
import type { AccountsFile } from "./core";
import { displayNames, panelFresh, type SwitchPanel } from "./switchPanel";

/** One observation of the active login, stamped with the time its source was written. */
export interface ActiveCandidate {
  id: string; // Anthropic account UUID
  email: string;
  atMs: number; // ~/.claude.json mtime, or panel.json ts
  source: "claude.json" | "panel.json";
}

const UUID_RE = /^[0-9a-f-]{36}$/;

/** The active login of a fresh claude-switch panel (undefined when stale, missing or without a valid uuid and email). */
export function panelActive(panel: SwitchPanel | null, nowMs: number): ActiveCandidate | undefined {
  if (!panelFresh(panel, nowMs)) return undefined;
  const a = panel.active;
  if (!a || typeof a.uuid !== "string" || !UUID_RE.test(a.uuid) || typeof a.email !== "string" || !a.email) return undefined;
  return { id: a.uuid, email: a.email, atMs: panel.ts * 1000, source: "panel.json" };
}

/** The fresher observation wins; a tie keeps ~/.claude.json (claude-switch builds its panel from that file). */
export function pickActive(own: ActiveCandidate | undefined, panel: ActiveCandidate | undefined): ActiveCandidate | undefined {
  if (!own || !panel) return own ?? panel;
  return panel.atMs > own.atMs ? panel : own;
}

/** A NEW registry with `acct` as the active login: an unknown account is added (identity only), token metadata and needsLogin stay. */
export function markActive(f: AccountsFile, acct: { id: string; email: string }, nowSec: number): AccountsFile {
  const known = f.accounts.some((a) => a.id === acct.id);
  const accounts = known
    ? f.accounts.map((a) => (a.id === acct.id ? { ...a, email: acct.email, lastSeenTs: nowSec } : a))
    : [{ id: acct.id, email: acct.email, lastSeenTs: nowSec }, ...f.accounts];
  return { ...f, accounts: accounts.sort((a, b) => b.lastSeenTs - a.lastSeenTs), activeId: acct.id };
}

/**
 * Account a shared usage snapshot belongs to: its `acct` tag, else (a file
 * written before 2.21.0) the active login when it was fetched after this
 * window last saw the account change, else unknown.
 */
export function snapshotAccount(snap: { ts: number; acct?: string }, activeId: string | null, activeChangedAtMs: number): string | null {
  if (snap.acct) return snap.acct;
  return snap.ts * 1000 >= activeChangedAtMs ? activeId : null;
}

/** Usage of the active login: the live poll only when it was fetched for that account, else the account's last background fetch. */
export function usageForActive<U>(
  activeId: string | null,
  live: { usage: U | null; acct: string | null },
  perAccount: ReadonlyMap<string, { usage: U | null }>,
): U | null {
  if (!activeId || live.acct === activeId) return live.usage;
  return perAccount.get(activeId)?.usage ?? null;
}

/** Name of the active login as its card header shows it: the local part, plus the domain when two local parts collide. */
export function activeName(activeEmail: string, emails: string[]): string {
  const all = emails.includes(activeEmail) ? emails : [...emails, activeEmail];
  return displayNames(all)[all.indexOf(activeEmail)];
}

/** Start of the click-to-render measurement: the webview's click time when plausible (same clock, under 60 s old), else receipt. */
export function useStartMs(clickedAt: unknown, receivedMs: number): number {
  return typeof clickedAt === "number" && clickedAt <= receivedMs && receivedMs - clickedAt < 60_000 ? clickedAt : receivedMs;
}

export interface UseOutcome {
  ok: boolean;
  text: string;
}

/** What `claude-switch use` reported: its last non-empty output line (stderr first on failure), at most 200 characters. */
export function useOutcome(err: { message?: string; killed?: boolean } | null, stdout: string, stderr: string): UseOutcome {
  const lastLine = (s: string): string =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? "";
  if (!err) return { ok: true, text: (lastLine(stdout) || "done").slice(0, 200) };
  if (err.killed) return { ok: false, text: "claude-switch use timed out" };
  return { ok: false, text: (lastLine(stderr) || lastLine(stdout) || lastLine(err.message ?? "") || "claude-switch use failed").slice(0, 200) };
}
