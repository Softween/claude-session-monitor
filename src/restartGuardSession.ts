/**
 * restartGuardSession.ts: the restart guard's `hidden` style
 * (claudeSessionMonitor.restartGuardStyle): a debug session that runs nothing.
 *
 * VS Code vetoes stopping the extension host while any debug session runs ("A
 * debug session is still running that would terminate."), so a restart of
 * extensions asks first, as it does for the guard tab. The session's adapter
 * lives in this extension host and answers every request without running
 * anything. Its toolbar, status bar colour and Run and Debug view are
 * suppressed; the Run and Debug icon's `1` badge, that view's debugging panes
 * in place of its start page, the status bar's debug item
 * (debug.showInStatusBar) and F5 not starting a debug run while it runs remain.
 * A restart the user confirms ends the session with VS Code's "Extension host
 * shut down" error notice; the next activation starts it again.
 */
import * as vscode from "vscode";

export const GUARD_DEBUG_TYPE = "claude-restart-guard";
export const GUARD_SESSION_NAME = "Claude restart guard";
export const GUARD_DEBUG_CONFIG: vscode.DebugConfiguration = {
  type: GUARD_DEBUG_TYPE,
  request: "attach",
  name: GUARD_SESSION_NAME,
  internalConsoleOptions: "neverOpen",
};
export const GUARD_DEBUG_OPTIONS: vscode.DebugSessionOptions = {
  suppressDebugToolbar: true,
  suppressDebugStatusbar: true,
  suppressDebugView: true,
  suppressSaveBeforeStart: true,
};
export const QUICK_END_MS = 5_000; // a session that ends this soon after it started ended quickly
export const QUICK_ENDS_MAX = 3; // this many quick ends in a row stop the restarts

/** The fields of a Debug Adapter Protocol message the adapter reads. */
interface DapMessage {
  type?: string;
  seq?: number;
  command?: string;
}

/** A debug adapter that answers every request with success and runs nothing. */
export class GuardDebugAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private seq = 1;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DapMessage;
    if (msg.type !== "request") return;
    const ok = (body?: object): void => this.send({ type: "response", request_seq: msg.seq, command: msg.command, success: true, body });
    if (msg.command === "initialize") {
      ok({ supportsConfigurationDoneRequest: true });
      this.send({ type: "event", event: "initialized" });
    } else if (msg.command === "threads") ok({ threads: [] });
    else if (msg.command === "disconnect" || msg.command === "terminate") {
      ok();
      this.send({ type: "event", event: "terminated" });
    } else ok();
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private send(message: object): void {
    this.emitter.fire({ seq: this.seq++, ...message });
  }
}

/**
 * Starts and stops the guard's debug session and tracks every session of its
 * type. `ended` hears about a guard session that ended without this module
 * stopping it, once no other guard session runs; `runaway` is true when it was
 * the third in a row to end within 5 s of starting.
 */
export class GuardSession {
  private readonly sessions = new Map<string, { session: vscode.DebugSession; startedAt: number }>();
  private readonly stoppedIds = new Set<string>(); // sessions stop() ended: their end is not reported
  private quickEnds = 0;

  constructor(
    subscriptions: vscode.Disposable[],
    private readonly ended: (runaway: boolean) => void,
    private readonly now: () => number = Date.now,
  ) {
    subscriptions.push(
      vscode.debug.registerDebugAdapterDescriptorFactory(GUARD_DEBUG_TYPE, {
        createDebugAdapterDescriptor: () => new vscode.DebugAdapterInlineImplementation(new GuardDebugAdapter()),
      }),
      vscode.debug.onDidStartDebugSession((s) => this.started(s)),
      vscode.debug.onDidTerminateDebugSession((s) => this.terminated(s)),
    );
  }

  /** True while a guard session runs: VS Code then asks before it stops the extension host. */
  get running(): boolean {
    return this.sessions.size > 0;
  }

  /** Starts a guard session; resolves undefined once it runs, or why it did not start. */
  async start(): Promise<string | undefined> {
    try {
      const ok = await vscode.debug.startDebugging(undefined, GUARD_DEBUG_CONFIG, GUARD_DEBUG_OPTIONS);
      return ok ? undefined : "startDebugging returned false";
    } catch (e: unknown) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /** Stops every guard session; resolves how many it stopped. */
  async stop(): Promise<number> {
    const list = [...this.sessions.values()].map((x) => x.session);
    this.sessions.clear();
    for (const s of list) {
      this.stoppedIds.add(s.id);
      await vscode.debug.stopDebugging(s);
    }
    return list.length;
  }

  /** Forgets the quick ends so far (a setting changed). */
  resetRunaway(): void {
    this.quickEnds = 0;
  }

  private started(s: vscode.DebugSession): void {
    if (s.type === GUARD_DEBUG_TYPE) this.sessions.set(s.id, { session: s, startedAt: this.now() });
  }

  private terminated(s: vscode.DebugSession): void {
    if (s.type !== GUARD_DEBUG_TYPE || this.stoppedIds.delete(s.id)) return;
    const entry = this.sessions.get(s.id);
    if (!entry) return;
    this.sessions.delete(s.id);
    this.quickEnds = this.now() - entry.startedAt < QUICK_END_MS ? this.quickEnds + 1 : 0;
    if (!this.sessions.size) this.ended(this.quickEnds >= QUICK_ENDS_MAX);
  }
}
