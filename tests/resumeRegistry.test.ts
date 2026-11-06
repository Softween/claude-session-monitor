import { describe, expect, it, vi } from "vitest";

import { ResumeRegistry, isClaudeCliCommand, isClaudeResumeCommand, isClaudeSessionCommand } from "../src/resumeRegistry";

const terminal = (pid?: number) => ({ processId: Promise.resolve(pid), exitStatus: undefined as unknown });
type FakeTerminal = ReturnType<typeof terminal>;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("ResumeRegistry", () => {
  it("a second resume while the registered terminal is live never opens another; after it closes it does", () => {
    const registry = new ResumeRegistry<FakeTerminal>();
    const open = vi.fn(() => terminal(101));
    const first = registry.openOrReuse("s1", open);
    expect(first.reused).toBe(false);
    expect(registry.openOrReuse("s1", open)).toEqual({ terminal: first.terminal, reused: true });
    expect(open).toHaveBeenCalledTimes(1);

    registry.forget(first.terminal); // onDidCloseTerminal
    expect(registry.liveTerminalFor("s1")).toBeUndefined();
    expect(registry.openOrReuse("s1", open).reused).toBe(false);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("drops a terminal once its process has exited", () => {
    const registry = new ResumeRegistry<FakeTerminal>();
    const t = terminal(102);
    registry.register("s2", t);
    expect(registry.liveTerminalFor("s2")).toBe(t);
    t.exitStatus = { code: 0 };
    expect(registry.liveTerminalFor("s2")).toBeUndefined();
    expect(registry.openOrReuse("s2", () => terminal(103)).reused).toBe(false);
  });

  it("forgetting one session's terminal leaves the others alone", () => {
    const registry = new ResumeRegistry<FakeTerminal>();
    const a = terminal(104);
    const b = terminal(105);
    registry.register("a", a);
    registry.register("b", b);
    registry.forget(a);
    expect(registry.liveTerminalFor("a")).toBeUndefined();
    expect(registry.liveTerminalFor("b")).toBe(b);
  });

  it("lists the pid of every live terminal once VS Code reports it", async () => {
    const registry = new ResumeRegistry<FakeTerminal>();
    const exited = terminal(202);
    registry.register("live", terminal(201));
    registry.register("exited", exited);
    registry.register("no-pid", terminal(undefined));
    exited.exitStatus = { code: 1 };
    await flush();
    expect([...registry.livePids()]).toEqual([["live", 201]]);
  });
});

describe("isClaudeCliCommand", () => {
  it("accepts the claude executable at any path and node running a script named claude", () => {
    expect(isClaudeCliCommand("/Users/u/.local/bin/claude --resume s")).toBe(true);
    expect(isClaudeCliCommand("claude")).toBe(true); // node's process.title hides the arguments
    expect(isClaudeCliCommand("node /Users/u/.npm-global/bin/claude --resume s")).toBe(true);
    expect(isClaudeCliCommand("/opt/homebrew/bin/node22 /x/claude")).toBe(true);
  });

  it("rejects claude-switch, other claude-* names, the desktop app and other processes", () => {
    for (const command of [
      "/Users/u/.claude/bin/claude-switch run",
      "claude-mem worker",
      "node /x/claude-switch",
      "/Applications/Claude.app/Contents/MacOS/Claude",
      "python3 claude",
      "/bin/zsh -c claude",
      "",
    ]) {
      expect(isClaudeCliCommand(command)).toBe(false);
    }
  });
});

describe("isClaudeResumeCommand", () => {
  it("requires the claude CLI with --resume followed by exactly the session id", () => {
    expect(isClaudeResumeCommand("/Users/u/.local/bin/claude --resume abc-1", "abc-1")).toBe(true);
    expect(isClaudeResumeCommand("node /x/claude --resume abc-1 --verbose", "abc-1")).toBe(true);
    expect(isClaudeResumeCommand("/Users/u/.local/bin/claude --resume abc-12", "abc-1")).toBe(false);
    expect(isClaudeResumeCommand("/Users/u/.local/bin/claude --resume", "abc-1")).toBe(false);
    expect(isClaudeResumeCommand("claude", "abc-1")).toBe(false);
    expect(isClaudeResumeCommand("/x/claude-switch --resume abc-1", "abc-1")).toBe(false);
  });
});

describe("isClaudeSessionCommand", () => {
  it("accepts the claude CLI resuming or starting exactly the session id", () => {
    expect(isClaudeSessionCommand("/Users/u/.local/bin/claude --resume abc-1", "abc-1")).toBe(true);
    expect(isClaudeSessionCommand("/Users/u/.local/bin/claude --session-id abc-1", "abc-1")).toBe(true);
    expect(isClaudeSessionCommand("node /x/claude --session-id abc-1 --verbose", "abc-1")).toBe(true);
  });

  it("rejects another id, a missing id, other programs and a bare claude", () => {
    expect(isClaudeSessionCommand("/Users/u/.local/bin/claude --session-id abc-12", "abc-1")).toBe(false);
    expect(isClaudeSessionCommand("/Users/u/.local/bin/claude --session-id", "abc-1")).toBe(false);
    expect(isClaudeSessionCommand("/x/claude-switch --session-id abc-1", "abc-1")).toBe(false);
    expect(isClaudeSessionCommand("python3 claude --session-id abc-1", "abc-1")).toBe(false);
    expect(isClaudeSessionCommand("claude", "abc-1")).toBe(false);
  });
});
