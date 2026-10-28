/**
 * remoteInput.ts — the check a remote text passes before it is written into a
 * session's terminal or typed into its Claude tab. Pure (no vscode import), so
 * vitest can load it. The uds inbox path wraps the text itself and skips this.
 */

export const REMOTE_LINE_MAX = 2000;

export type SanitizedLine = { ok: true; line: string } | { ok: false; reason: "rejected input" };

// C0 / C1 control characters and the Unicode line and paragraph separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * One line to write or type, or a rejection. Line breaks collapse to one space
 * and the ends are trimmed; then an empty line, any control character, a leading
 * `!` (shell / bash mode), `/` (slash command) or `#` (memory), or more than
 * 2000 characters is rejected.
 */
export function sanitizeRemoteLine(text: string): SanitizedLine {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  if (!line || line.length > REMOTE_LINE_MAX || CONTROL.test(line) || /^[!/#]/.test(line)) {
    return { ok: false, reason: "rejected input" };
  }
  return { ok: true, line };
}
