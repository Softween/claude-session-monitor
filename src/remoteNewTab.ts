/**
 * remoteNewTab.ts: the remote `newSession` in a Claude Code editor tab of this
 * window (Bilal 2026-11-24: a phone's new session belongs in a tab, not a
 * terminal). Claude Code opens the tab with the first message already in its
 * input (`claude-vscode.editor.open`'s initial prompt only fills the input), its
 * `claude` process starts at once as a child of this extension host, and that
 * new process names the session id the phone needs. Enter is then pressed with
 * keystrokes (keystrokeTyping.ts rules) until the transcript shows the message.
 * No vscode import: the tab, the process list and the keystroke come in through
 * `NewTabDeps`, so vitest can load it.
 */
import * as path from "path";
import type { CommandOutcome, FleetCommand } from "./remoteBridge";
import { checkNewSession } from "./remoteCwds";
import { POLL_MS, READY_TIMEOUT_MS, SETTLE_MS, enterUntilSeen, firstMessageOutcome, readStartRecord } from "./remoteNewSession";

export interface NewTabDeps {
  /** the folders the snapshot offers, computed now */
  allowed: () => string[];
  /** the session ids of this window's Claude Code tabs (wakeTabs.ts ownSessions), undefined when ps failed */
  ownSessions: () => Promise<string[] | undefined>;
  /** opens a new Claude Code tab in this window, `prompt` in its input (not sent) */
  open: (prompt: string | undefined) => Promise<void>;
  /** presses Enter in the new tab's prompt input: undefined once pressed, else why not */
  pressEnter: () => Promise<string | undefined>;
  /** where hook.py writes `<session id>.json` */
  monitorDir: string;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}

type Found = { ok: true; sessionId: string; transcriptPath: string | null } | { ok: false; reason: string };

/** Waits for the one new session of this window and its start record. */
async function waitForNewSession(before: ReadonlySet<string>, d: NewTabDeps): Promise<Found> {
  const now = d.now ?? Date.now;
  const started = now();
  while (now() - started < READY_TIMEOUT_MS) {
    await d.sleep(POLL_MS);
    const fresh = ((await d.ownSessions()) ?? []).filter((id) => !before.has(id));
    if (fresh.length > 1) return { ok: false, reason: `${fresh.length} new sessions appeared at once` };
    if (fresh.length === 1) {
      const rec = readStartRecord(path.join(d.monitorDir, `${fresh[0]}.json`), fresh[0]);
      if (rec) return { ok: true, sessionId: fresh[0], transcriptPath: rec.transcriptPath };
    }
  }
  return { ok: false, reason: `no session start within ${READY_TIMEOUT_MS / 1000} s` };
}

/**
 * Runs one remote `newSession` in a Claude Code tab. Refused, with nothing
 * opened, when the folder is not exactly an allowed one or the first message
 * breaks the send rules. The answer names the new session id and the folder,
 * in the form the hub reads ("new session <id> started ...").
 */
export async function startNewTab(cmd: FleetCommand, d: NewTabDeps): Promise<CommandOutcome> {
  const checked = checkNewSession(cmd, d.allowed());
  if (!checked.ok) return { ok: false, message: checked.message };
  const folder = path.basename(checked.cwd);
  const before = await d.ownSessions();
  if (!before) return { ok: false, message: "could not list this window's Claude sessions (ps failed); new session refused" };
  try {
    await d.open(checked.line ?? undefined);
  } catch (e) {
    return { ok: false, message: `Claude Code could not open a tab: ${e instanceof Error ? e.message : String(e)}` };
  }
  const found = await waitForNewSession(new Set(before), d);
  if (!found.ok) return { ok: false, message: `new tab in ${folder} opened but its session was not found: ${found.reason}` };
  const opened = `new session ${found.sessionId} started in ${folder} in a Claude Code tab`;
  if (!checked.line) return { ok: true, message: opened };
  await d.sleep(SETTLE_MS);
  const first = await enterUntilSeen(d.pressEnter, found.transcriptPath, d);
  if (first.result === "stopped" && first.presses === 0) {
    return { ok: true, message: `${opened}; first message is in the tab's input, not sent: ${first.reason}` };
  }
  return firstMessageOutcome(opened, first, "typed");
}
