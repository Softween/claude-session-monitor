// Types text into the Claude Code prompt input with macOS System Events
// keystrokes, in chunks, and re-checks the target before every chunk and before
// Return. A click into the integrated terminal, an editor or another app while
// it types costs at most one chunk (no Return), never a command run in a shell.
// When the first check finds the keyboard focus off the prompt input, the
// caller's refocus step (promptFocus.ts) may run once before it checks again.
// No vscode import: the focus reader, the keystroke runs and the clock are
// injected, so every abort path is unit-tested.
import { execFile } from "child_process";

/** Most characters typed per keystroke run: what a click elsewhere can receive before the next check stops typing. */
export const CHUNK_CHARS = 200;

/** Bundle identifiers keystrokes may land in. */
export const VSCODE_BUNDLE_IDS = ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"];

/**
 * The Claude Code prompt input as macOS accessibility reports it. Identified on
 * the development Mac (Claude Code 2.1.327, VS Code's accessibility tree read
 * with System Events): the webview's `<div contenteditable role="textbox"
 * aria-multiline="true" aria-label="Message input">` is an AXTextArea whose
 * AXDescription is "Message input" (role description "text entry area"). Other
 * text areas differ by description: VS Code's editors have an empty one (role
 * description "editor"), the integrated terminal's input is labelled
 * "Terminal <n>, <shell>…", the permission prompt's reply box "Tell Claude what to
 * do instead".
 */
export const PROMPT_INPUT = { role: "AXTextArea", description: "Message input" } as const;

/** What has the keyboard focus: the frontmost app's bundle id and, inside VS Code, the focused element. */
export interface FocusedElement {
  app: string;
  role: string;
  description: string;
}

export type FocusRead = { ok: true; focus: FocusedElement } | { ok: false; err: string };
export type KeystrokeRun = { ok: true } | { ok: false; err: string; notFrontmost?: boolean };

export interface KeystrokeDeps {
  readFocus(): Promise<FocusRead>;
  /** Types `text` (no Return) unless another app is frontmost. */
  keystroke(text: string): Promise<KeystrokeRun>;
  pressReturn(): Promise<KeystrokeRun>;
  sleep(ms: number): Promise<void>;
}

export interface TypeTarget {
  /** Pause between the last chunk and Return: a slash command pops an autocomplete widget first. */
  submitDelayMs: number;
  /** The caller still wants it typed (a sweep not stopped, the extension not disposed). */
  alive(): boolean;
  /** This VS Code window has the OS focus. */
  windowFocused(): boolean;
  /** The session's tab is the active one. */
  tabActive(): boolean;
  /**
   * Tried once, when the first check finds the keyboard focus off the prompt
   * input: puts it there and resolves undefined, or resolves why it may not run.
   */
  refocus?(): Promise<string | undefined>;
}

/**
 * Why nothing more was typed. `interrupted`: a check failed after text went out,
 * so Return was not pressed and the text sits in whatever had the focus; like a
 * failed `keystroke` it is final. Every other reason typed nothing.
 */
export type TypeFailReason = "aborted" | "not-frontmost" | "tab-mismatch" | "not-prompt" | "accessibility" | "keystroke" | "interrupted";
/** `refocused`: the target's refocus step ran before the first chunk. */
export type TypeResult = { ok: true; refocused?: true } | { ok: false; reason: TypeFailReason; detail: string; refocused?: true };

/** True when nothing was typed, so a remote command may try its next delivery path. */
export function nothingTyped(reason: TypeFailReason): boolean {
  return reason !== "keystroke" && reason !== "interrupted";
}

export function isPromptInput(f: FocusedElement): boolean {
  return f.role === PROMPT_INPUT.role && f.description === PROMPT_INPUT.description;
}

/** `text` cut into chunks of at most `size` characters, never inside a surrogate pair. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(""));
  return out;
}

export function isAccessibilityError(err: string): boolean {
  return /not allowed|assistive|accessibility|-1743|-25211|not permitted/i.test(err);
}

/**
 * Types `text` + Return into the Claude Code prompt input. Before every chunk
 * and before Return it reads the focused element and goes on only while the
 * caller still wants it, this window is focused, the session's tab is active,
 * VS Code is frontmost and the Claude Code prompt input has the focus. Only the
 * first check may run `target.refocus` (once) and check again.
 */
export async function typeIntoPrompt(text: string, target: TypeTarget, deps: KeystrokeDeps = osascriptKeystrokes): Promise<TypeResult> {
  const total = Array.from(text).length;
  let sent = 0;
  const fail = (reason: TypeFailReason, detail: string): TypeResult =>
    sent === 0
      ? { ok: false, reason, detail }
      : {
          ok: false,
          reason: reason === "keystroke" ? "keystroke" : "interrupted",
          detail: `${detail} (after ${sent} of ${total} characters; Return not pressed)`,
        };
  const check = async (): Promise<TypeResult | null> => {
    if (!target.alive()) return fail("aborted", "stopped");
    const r = await deps.readFocus();
    if (!target.alive()) return fail("aborted", "stopped");
    if (!target.windowFocused()) return fail("not-frontmost", "this VS Code window is not focused");
    if (!target.tabActive()) return fail("tab-mismatch", "the session's tab is not the active tab");
    if (!r.ok) return fail(isAccessibilityError(r.err) ? "accessibility" : "keystroke", r.err);
    if (!VSCODE_BUNDLE_IDS.includes(r.focus.app)) return fail("not-frontmost", `frontmost app is ${r.focus.app || "unknown"}`);
    if (!isPromptInput(r.focus)) {
      return fail("not-prompt", `the keyboard focus is on ${r.focus.role || "no element"} "${r.focus.description}", not the Claude prompt input`);
    }
    return null;
  };
  const ran = (k: KeystrokeRun): TypeResult | null => {
    if (k.ok) return null;
    if (k.notFrontmost) return fail("not-frontmost", k.err);
    return fail(sent === 0 && isAccessibilityError(k.err) ? "accessibility" : "keystroke", k.err || "keystroke failed");
  };
  let first = true;
  let refocused = false;
  const checkFirst = async (): Promise<TypeResult | null> => {
    const stop = await check();
    if (!first) return stop;
    first = false;
    if (!target.refocus || stop?.ok !== false || stop.reason !== "not-prompt") return stop;
    const refused = await target.refocus();
    if (refused !== undefined) return { ...stop, detail: `${stop.detail}; ${refused}` };
    refocused = true;
    return check();
  };
  const tagged = (r: TypeResult): TypeResult => (refocused ? { ...r, refocused: true } : r);
  for (const part of chunkText(text)) {
    const stop = (await checkFirst()) ?? ran(await deps.keystroke(part));
    if (stop) return tagged(stop);
    sent += Array.from(part).length;
  }
  await deps.sleep(target.submitDelayMs);
  return tagged((await checkFirst()) ?? ran(await deps.pressReturn()) ?? { ok: true });
}

function appleStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const VSCODE_APPS = `{${VSCODE_BUNDLE_IDS.map(appleStr).join(", ")}}`;

function osascript(lines: string[], timeout: number): Promise<{ ok: true; out: string } | { ok: false; err: string }> {
  return new Promise((resolve) => {
    const args: string[] = [];
    for (const l of lines) args.push("-e", l);
    execFile("osascript", args, { timeout }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, err: String(stderr || err) });
      else resolve({ ok: true, out: String(stdout ?? "").replace(/\n$/, "") });
    });
  });
}

/** One keystroke run (`keystroke "<text>"` or `key code 36`) that first checks the frontmost app. */
async function keystrokeRun(action: string, timeout: number): Promise<KeystrokeRun> {
  const r = await osascript(
    [
      'tell application "System Events"',
      "try",
      "set b to bundle identifier of first process whose frontmost is true",
      "on error",
      'set b to ""',
      "end try",
      `if b is not in ${VSCODE_APPS} then return "not-frontmost"`,
      action,
      "end tell",
      'return "typed"',
    ],
    timeout,
  );
  if (!r.ok) return { ok: false, err: r.err };
  if (r.out.trim() === "typed") return { ok: true };
  return { ok: false, notFrontmost: true, err: `frontmost app is not VS Code (${r.out.trim() || "no answer"})` };
}

/** The real runs: System Events through osascript (macOS Accessibility permission for VS Code). */
export const osascriptKeystrokes: KeystrokeDeps = {
  readFocus: async () => {
    const r = await osascript(
      [
        'tell application "System Events"',
        'set b to ""',
        "try",
        "set p to first process whose frontmost is true",
        "set b to bundle identifier of p",
        "end try",
        `if b is not in ${VSCODE_APPS} then return b`,
        'set f to value of attribute "AXFocusedUIElement" of p',
        'set r to ""',
        'set d to ""',
        "try",
        'set r to (value of attribute "AXRole" of f) as text',
        "end try",
        "try",
        'set d to (value of attribute "AXDescription" of f) as text',
        "end try",
        "return b & linefeed & r & linefeed & d",
        "end tell",
      ],
      4000,
    );
    if (!r.ok) return { ok: false, err: r.err };
    const [app = "", role = "", ...rest] = r.out.split("\n");
    return { ok: true, focus: { app: app.trim(), role: role.trim(), description: rest.join("\n") } };
  },
  // A long chunk takes a while to type; never cut it off halfway.
  keystroke: (text) => keystrokeRun(`keystroke ${appleStr(text)}`, Math.max(8000, 4000 + text.length * 15)),
  pressReturn: () => keystrokeRun("key code 36", 8000),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
