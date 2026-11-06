/**
 * remoteNewSession.ts: the remote `newSession` command: a new `claude` (its
 * absolute path, `--session-id <new uuid>`) in a background VS Code terminal in
 * an allowed folder (remoteCwds.ts), registered like a resumed session so later
 * send / kill reach it, and its optional first message written into that
 * terminal only after the session has started. No vscode import: the terminal
 * and the clock come in through `NewSessionDeps`, so vitest can load it.
 */
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { CommandOutcome, FleetCommand } from "./remoteBridge";
import { checkNewSession } from "./remoteCwds";

/** Claude has this long to start (its SessionStart hook record appears) before the terminal is closed. */
export const READY_TIMEOUT_MS = 35_000;
/** Pause between the session start and the first message, so the prompt is drawn. */
export const SETTLE_MS = 2_000;
/** How long the first message gets to reach the transcript before the answer says "not in the transcript yet". */
export const FIRST_MESSAGE_SEEN_MS = 15_000;
const POLL_MS = 500;

/** The part of a vscode.Terminal this command uses. */
export interface SessionTerminal {
  readonly exitStatus: unknown; // undefined while the terminal's process runs
  sendText(text: string, addNewLine?: boolean): void;
  dispose(): void;
}

export interface TerminalSpec {
  name: string;
  cwd: string;
  shellPath: string;
  shellArgs: string[];
}

export interface NewSessionDeps<T extends SessionTerminal> {
  /** the folders the snapshot offers, computed now */
  allowed: () => string[];
  /** absolute path of the claude CLI (claudeBinary.ts), undefined when none was found */
  claudeBinary: () => Promise<string | undefined>;
  /** creates the terminal without showing it */
  open: (spec: TerminalSpec) => T;
  /** remembers the terminal as the session's (resumeRegistry.ts) */
  register: (sessionId: string, terminal: T) => void;
  /** where hook.py writes `<session id>.json` */
  monitorDir: string;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  newId?: () => string;
}

type Started = { ok: true; transcriptPath: string | null } | { ok: false; reason: string };

/** The session's hook record (hook.py writes it at SessionStart, after the folder trust question), or null. */
export function readStartRecord(file: string, sessionId: string): { transcriptPath: string | null } | null {
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { session_id?: unknown; transcript_path?: unknown };
    if (rec?.session_id !== sessionId) return null;
    return { transcriptPath: typeof rec.transcript_path === "string" && rec.transcript_path ? rec.transcript_path : null };
  } catch {
    return null;
  }
}

function sizeOf(file: string | null): number {
  if (!file) return 0;
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

async function waitForStart<T extends SessionTerminal>(sessionId: string, term: T, d: NewSessionDeps<T>): Promise<Started> {
  const now = d.now ?? Date.now;
  const file = path.join(d.monitorDir, `${sessionId}.json`);
  const started = now();
  while (now() - started < READY_TIMEOUT_MS) {
    if (term.exitStatus !== undefined) return { ok: false, reason: "claude exited" };
    const rec = readStartRecord(file, sessionId);
    if (rec) return { ok: true, transcriptPath: rec.transcriptPath };
    await d.sleep(POLL_MS);
  }
  return { ok: false, reason: `no session start within ${READY_TIMEOUT_MS / 1000} s (a question may be waiting in the terminal)` };
}

/** Writes the first message, then waits until the transcript grows; "written" when it does not within 15 s. */
async function writeFirstMessage<T extends SessionTerminal>(
  term: T,
  line: string,
  transcriptPath: string | null,
  d: NewSessionDeps<T>,
): Promise<"delivered" | "written" | Error> {
  const now = d.now ?? Date.now;
  const before = sizeOf(transcriptPath);
  try {
    term.sendText(line + "\r", false);
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
  const started = now();
  while (transcriptPath && now() - started < FIRST_MESSAGE_SEEN_MS) {
    if (sizeOf(transcriptPath) > before) return "delivered";
    await d.sleep(POLL_MS);
  }
  return "written";
}

/**
 * Runs one remote `newSession`. Refused, with nothing opened, when the folder is
 * not exactly an allowed one, the first message breaks the send rules, or no
 * claude executable is known. A session that does not start within 35 s gets
 * its terminal closed. The answer names the new session id and the folder.
 */
export async function startNewSession<T extends SessionTerminal>(cmd: FleetCommand, d: NewSessionDeps<T>): Promise<CommandOutcome> {
  const checked = checkNewSession(cmd, d.allowed());
  if (!checked.ok) return { ok: false, message: checked.message };
  const bin = await d.claudeBinary();
  if (!bin) return { ok: false, message: "claude executable not found on this Mac; new session refused" };
  const sessionId = (d.newId ?? randomUUID)();
  const folder = path.basename(checked.cwd);
  const term = d.open({ name: `Claude · ${folder.slice(0, 32)}`, cwd: checked.cwd, shellPath: bin, shellArgs: ["--session-id", sessionId] });
  d.register(sessionId, term);
  const started = await waitForStart(sessionId, term, d);
  if (!started.ok) {
    term.dispose();
    return { ok: false, message: `new session in ${folder} did not start: ${started.reason}; terminal closed` };
  }
  await d.sleep(SETTLE_MS);
  if (term.exitStatus !== undefined) return { ok: false, message: `new session ${sessionId} in ${folder} exited right after it started` };
  const opened = `new session ${sessionId} started in ${folder}`;
  if (!checked.line) return { ok: true, message: opened };
  const first = await writeFirstMessage(term, checked.line, started.transcriptPath, d);
  if (first instanceof Error) return { ok: false, message: `${opened}; first message not written: ${first.message}` };
  return { ok: true, message: first === "delivered" ? `${opened}; first message delivered` : `${opened}; first message written, not in the transcript yet` };
}
