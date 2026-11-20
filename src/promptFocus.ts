/**
 * promptFocus.ts — the keyboard focus on a Claude Code tab's prompt input before
 * the typing sweep or remote typing types into it (keystrokeTyping.ts).
 *
 * The tab is shown by its index (tabFocus.ts); typing waits up to 1 s until it is
 * the active tab of the active group, then reads the focused element. When the
 * focus is not on the prompt input, Claude Code's focus command runs once, and
 * only while the active editor is that Claude panel, no text editor is active and
 * no other Claude panel is visible. Each attempt logs which way it went.
 *
 * What the command does (Claude Code 2.1.327, extension.js): it turns the active
 * text editor's selection into an @-mention ("" without one) and hands it to every
 * visible chat view, which focuses its prompt input and inserts the mention unless
 * it is empty; each of those panel tabs is revealed. Only with no chat view
 * visible does it reveal the last one or open the last session in a new tab. With
 * the target panel the active editor a chat view is visible, so nothing opens;
 * with no text editor active the mention is empty, so nothing is inserted; with no
 * other Claude panel visible no other tab is revealed. A visible Claude sidebar
 * cannot be seen from here: like every chat view it retries focusing its input
 * for 1.6 s (webview/index.js, 300, 800 and 1600 ms), so the typing waits that
 * out and focuses the target panel's group again before it reads the focus.
 *
 * No `vscode` import: extension.ts passes the editor state in.
 */
import { nothingTyped, type TypeResult } from "./keystrokeTyping";

export const FOCUS_COMMAND = "claude-vscode.focus";
export const FOCUS_SETTLE_MS = 2_000; // after the focus command: past the chat views' focus retries (up to 1.6 s after delivery)
export const SHOW_WAIT_MS = 1_000; // for a shown tab to become the active tab of the active group
const SHOW_POLL_MS = 50;

/** The editor around the typing target right before Claude Code's focus command would run. */
export interface FocusScene {
  targetActive: boolean; // the target tab is the active tab of the active group
  claudePanel: boolean; // the active tab is a Claude Code panel (webview view type claudeVSCodePanel)
  textEditor: boolean; // a text editor is active: its selection would become an @-mention
  otherClaudePanels: number; // Claude Code panels visible in other groups: the command reveals each
}

/** Why Claude Code's focus command may not run now, or undefined. */
export function focusCommandBlocker(scene: FocusScene): string | undefined {
  if (!scene.targetActive || !scene.claudePanel) return "the target Claude panel is not the active editor";
  if (scene.textEditor) return "a text editor is active";
  if (scene.otherClaudePanels > 0) return "another Claude panel is visible";
  return undefined;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `active` every 50 ms for up to 1 s: true once the shown tab is the active tab of the active group. */
export async function waitForActive(active: () => boolean, sleep = realSleep, now: () => number = Date.now): Promise<boolean> {
  const until = now() + SHOW_WAIT_MS;
  while (!active()) {
    if (now() >= until) return false;
    await sleep(SHOW_POLL_MS);
  }
  return true;
}

/** The log line of one typing attempt: how the prompt input got the keyboard focus, or why typing stopped. */
export function typingLine(label: string, r: TypeResult): string {
  const after = r.refocused ? ` after ${FOCUS_COMMAND}` : "";
  if (r.ok) return `typing ${label}: ${r.refocused ? `prompt focused${after}` : "prompt already focused"}`;
  return `typing ${label}: ${nothingTyped(r.reason) ? "skipped" : "stopped"}${after} (${r.reason}: ${r.detail})`;
}
