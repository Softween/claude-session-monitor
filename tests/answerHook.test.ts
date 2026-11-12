import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve(process.cwd(), "scripts/answer_hook.py");

describe("scripts/answer_hook.py (log-only)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-answer-hook-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(input: string, env: Record<string, string> = {}) {
    const result = spawnSync("python3", [HOOK], {
      input,
      encoding: "utf8",
      env: { ...process.env, HOME: tmp, CLAUDE_CODE_ENTRYPOINT: "claude-vscode", ...env },
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    return result;
  }

  const logFile = () => path.join(tmp, ".claude", "session-monitor", "answer-hook.log");
  const lines = () => fs.readFileSync(logFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  const question = (text: string) => ({
    question: text,
    header: "Fruit",
    multiSelect: false,
    options: [
      { label: "Apple", description: "red" },
      { label: "Banana", description: "yellow" },
    ],
  });

  it("appends one 0600 line per call with ids, counts and a hash, never the question text", () => {
    run(
      JSON.stringify({
        session_id: "s-1",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "toolu_1",
        permission_mode: "bypassPermissions",
        tool_input: { questions: [question("Which fruit, ayse@example.com?"), question("Second?")] },
      }),
    );
    run(
      JSON.stringify({
        session_id: "s-1",
        hook_event_name: "PermissionRequest",
        tool_name: "AskUserQuestion",
        permission_mode: "bypassPermissions",
        tool_input: { questions: [question("Which fruit, ayse@example.com?"), question("Second?")] },
      }),
    );
    expect(fs.statSync(logFile()).mode & 0o777).toBe(0o600);
    const [pre, perm] = lines();
    expect(pre).toMatchObject({
      event: "PreToolUse",
      tool: "AskUserQuestion",
      session_id: "s-1",
      tool_use_id: "toolu_1",
      permission_mode: "bypassPermissions",
      entrypoint: "claude-vscode",
      questions: 2,
    });
    expect(perm).toMatchObject({ event: "PermissionRequest", tool_use_id: null, questions: 2 });
    expect(pre.qhash).toMatch(/^[0-9a-f]{12}$/);
    expect(perm.qhash).toBe(pre.qhash);
    expect(typeof pre.ts).toBe("number");
    const raw = fs.readFileSync(logFile(), "utf8");
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("Apple");
  });

  it("fails open: bad input, an unwritable log or no input exit 0 with nothing on stdout", () => {
    run("{not json");
    run("");
    run(JSON.stringify(["a list"]));
    expect(fs.existsSync(logFile())).toBe(false);
    fs.mkdirSync(path.join(tmp, ".claude", "session-monitor"), { recursive: true });
    fs.mkdirSync(logFile()); // a directory where the log file should be
    run(JSON.stringify({ session_id: "s-2", hook_event_name: "PreToolUse", tool_input: {} }));
  });
});
