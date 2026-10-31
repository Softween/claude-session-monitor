/**
 * resumeRegistry.ts — the terminals this window opened to resume a session
 * (`claude --resume <id>`, `codex resume <id>`), by session id. A second resume
 * reuses the live terminal instead of starting the session twice, and remote
 * send / kill reach a session whose hook record has no pid. Also the command
 * checks for such a pid. Pure (no vscode import), so vitest can load it.
 */

/** The part of a vscode.Terminal the registry reads. */
export interface ResumeTerminal {
  readonly processId: PromiseLike<number | undefined>;
  readonly exitStatus: unknown; // undefined while the terminal's process runs
}

interface Entry<T> {
  terminal: T;
  pid?: number; // cached once processId resolves
}

export class ResumeRegistry<T extends ResumeTerminal> {
  private readonly bySession = new Map<string, Entry<T>>();

  /** Remember `terminal` as the session's; its pid is cached once VS Code reports it. */
  register(sessionId: string, terminal: T): void {
    const entry: Entry<T> = { terminal };
    this.bySession.set(sessionId, entry);
    Promise.resolve(terminal.processId).then(
      (pid) => {
        if (pid) entry.pid = pid;
      },
      () => undefined,
    );
  }

  /** The session's registered terminal while its process runs; an exited one is dropped. */
  liveTerminalFor(sessionId: string): T | undefined {
    const entry = this.bySession.get(sessionId);
    if (!entry) return undefined;
    if (entry.terminal.exitStatus !== undefined) {
      this.bySession.delete(sessionId);
      return undefined;
    }
    return entry.terminal;
  }

  /** Session id -> pid of every live registered terminal whose pid is known. */
  livePids(): Map<string, number> {
    const pids = new Map<string, number>();
    for (const [id, entry] of [...this.bySession]) {
      if (entry.pid && this.liveTerminalFor(id)) pids.set(id, entry.pid);
    }
    return pids;
  }

  /** Forget a closed terminal (vscode.window.onDidCloseTerminal). */
  forget(terminal: T): void {
    for (const [id, entry] of [...this.bySession]) if (entry.terminal === terminal) this.bySession.delete(id);
  }

  /** The session's live terminal (`reused`), else the one `open()` creates, registered. */
  openOrReuse(sessionId: string, open: () => T): { terminal: T; reused: boolean } {
    const live = this.liveTerminalFor(sessionId);
    if (live) return { terminal: live, reused: true };
    const terminal = open();
    this.register(sessionId, terminal);
    return { terminal, reused: false };
  }
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/**
 * A `claude` CLI process (the rule scripts/hook.py uses for a terminal session):
 * the executable's basename is `claude`, or a `node*` executable runs a script
 * named `claude`. Case-sensitive, so the desktop app's `Claude` never matches,
 * and neither do `claude-switch` or other `claude-*` names.
 */
export function isClaudeCliCommand(command: string): boolean {
  const [first = "", second = ""] = command.trim().split(/\s+/);
  const exe = basename(first);
  return exe === "claude" || (exe.startsWith("node") && basename(second) === "claude");
}

/** The claude CLI resuming exactly `sessionId` (`claude --resume <sessionId>`). */
export function isClaudeResumeCommand(command: string, sessionId: string): boolean {
  const tokens = command.trim().split(/\s+/);
  const at = tokens.indexOf("--resume");
  return isClaudeCliCommand(command) && at >= 0 && tokens[at + 1] === sessionId;
}
