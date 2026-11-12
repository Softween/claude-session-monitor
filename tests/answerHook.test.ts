import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { submitAnswer } from "../src/answers";

const HOOK = path.resolve(process.cwd(), "scripts/answer_hook.py");
const FAST = ["--wait", "4", "--poll", "0.05"];

const question = (text: string, multiSelect = false) => ({
  question: text,
  header: "Fruit",
  multiSelect,
  options: [
    { label: "Apple", description: "red" },
    { label: "Banana", description: "yellow" },
  ],
});

// Each test spawns python3; pulse may pause children under memory pressure, so the budgets are generous.
describe("scripts/answer_hook.py", { timeout: 30_000 }, () => {
  let tmp: string;
  let mon: string;
  let answers: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-answer-hook-"));
    mon = path.join(tmp, ".claude", "session-monitor");
    answers = path.join(mon, "answers");
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const env = (entrypoint: string) => ({ ...process.env, HOME: tmp, CLAUDE_CODE_ENTRYPOINT: entrypoint });
  const logLines = () =>
    fs.existsSync(path.join(mon, "answer-hook.log"))
      ? fs.readFileSync(path.join(mon, "answer-hook.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  function runSync(input: string, entrypoint = "claude-vscode", args: string[] = FAST) {
    const started = Date.now();
    const result = spawnSync("python3", [HOOK, ...args], { input, encoding: "utf8", env: env(entrypoint), timeout: 15_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    return Date.now() - started;
  }

  /** A transcript whose newest line asks `questions`, written now. */
  function transcript(sid: string, questions: unknown[]): string {
    const file = path.join(tmp, `${sid}.jsonl`);
    const line = {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: [{ type: "tool_use", id: "toolu_q1", name: "AskUserQuestion", input: { questions } }] },
    };
    fs.writeFileSync(file, JSON.stringify(line) + "\n");
    return file;
  }

  const permissionRequest = (sid: string, questions: unknown[], tx?: string) =>
    JSON.stringify({
      session_id: sid,
      hook_event_name: "PermissionRequest",
      tool_name: "AskUserQuestion",
      permission_mode: "bypassPermissions",
      transcript_path: tx ?? transcript(sid, questions),
      tool_input: { questions },
    });

  function start(input: string, entrypoint = "claude-vscode", args: string[] = FAST) {
    const child = spawn("python3", [HOOK, ...args], { env: env(entrypoint), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on("close", (code) => resolve({ code, stdout })));
    child.stdin.end(input);
    return { child, done };
  }

  async function waitFor<T>(probe: () => T | undefined | null | false, ms = 15_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = probe();
      if (v) return v;
      if (Date.now() > until) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const markerFile = (sid: string) => path.join(answers, `${sid}.waiting.json`);
  const readMarkerFile = (sid: string) =>
    fs.existsSync(markerFile(sid)) ? (JSON.parse(fs.readFileSync(markerFile(sid), "utf8")) as Record<string, unknown>) : null;

  it("logs every call (0600) with ids, counts and a hash, never the question text", () => {
    const q = [question("Which fruit, ayse@example.com?"), question("Second?")];
    runSync(JSON.stringify({ session_id: "s-1", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_use_id: "toolu_1", permission_mode: "bypassPermissions", tool_input: { questions: q } }));
    runSync(permissionRequest("s-1", q), "cli");
    expect(fs.statSync(path.join(mon, "answer-hook.log")).mode & 0o777).toBe(0o600);
    const [pre, perm] = logLines();
    expect(pre).toMatchObject({ event: "PreToolUse", tool: "AskUserQuestion", session_id: "s-1", tool_use_id: "toolu_1", permission_mode: "bypassPermissions", entrypoint: "claude-vscode", questions: 2 });
    expect(perm).toMatchObject({ event: "PermissionRequest", tool_use_id: null, entrypoint: "cli", questions: 2 });
    expect(pre.qhash).toMatch(/^[0-9a-f]{12}$/);
    expect(perm.qhash).toBe(pre.qhash);
    const raw = fs.readFileSync(path.join(mon, "answer-hook.log"), "utf8");
    expect(raw).not.toContain("example.com");
    expect(raw).not.toContain("Apple");
  });

  it("never waits on PreToolUse, in a cli session, for another tool or with answers/off", () => {
    const q = [question("Which fruit?")];
    expect(runSync(JSON.stringify({ session_id: "s-pre", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: q } }))).toBeLessThan(2000);
    expect(runSync(permissionRequest("s-cli", q), "cli")).toBeLessThan(2000);
    expect(runSync(JSON.stringify({ session_id: "s-bash", hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }))).toBeLessThan(2000);
    fs.mkdirSync(answers, { recursive: true });
    fs.writeFileSync(path.join(answers, "off"), "");
    expect(runSync(permissionRequest("s-off", q))).toBeLessThan(2000);
    expect(fs.readdirSync(answers)).toEqual(["off"]);
  });

  it("fails open: bad input or an unwritable log exit 0 with nothing on stdout", () => {
    runSync("{not json");
    runSync("");
    runSync(JSON.stringify(["a list"]));
    runSync(permissionRequest("../escape", [question("Q?")]));
    expect(fs.existsSync(answers)).toBe(false);
    fs.rmSync(path.join(mon, "answer-hook.log"));
    fs.mkdirSync(path.join(mon, "answer-hook.log")); // a directory where the log file should be
    runSync(JSON.stringify({ session_id: "s-2", hook_event_name: "PreToolUse", tool_input: {} }));
  });

  it("waits with a 0600 marker and returns the phone's answer as the allow decision", async () => {
    const q = [question("Which fruit?"), question("Which toppings?", true)];
    const input = permissionRequest("s-ok", q);
    const { done } = start(input);
    const marker = await waitFor(() => readMarkerFile("s-ok"));
    expect(fs.statSync(answers).mode & 0o777).toBe(0o700);
    expect(fs.statSync(markerFile("s-ok")).mode & 0o777).toBe(0o600);
    expect(marker).toMatchObject({
      v: 1,
      sessionId: "s-ok",
      toolUseId: "toolu_q1",
      questions: [
        { question: "Which fruit?", header: "Fruit", multiSelect: false, options: ["Apple", "Banana"] },
        { question: "Which toppings?", header: "Fruit", multiSelect: true, options: ["Apple", "Banana"] },
      ],
    });
    expect(marker.deadline).toBe((marker.started as number) + 4);
    const out = submitAnswer(
      { sessionId: "s-ok", toolUseId: "toolu_q1", answers: { "Which fruit?": "Banana", "Which toppings?": "Apple,Banana" } },
      { nowSec: Date.now() / 1000, askPending: true, dir: answers },
    );
    expect(out).toEqual({ ok: true, message: "Cevap iletildi" });
    const { code, stdout } = await done;
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: { questions: q, answers: { "Which fruit?": "Banana", "Which toppings?": "Apple, Banana" } },
        },
      },
    });
    expect(fs.readdirSync(answers)).toEqual([]);
    expect(logLines().map((l) => l.phase).filter(Boolean)).toEqual(["waiting", "answered"]);
  });

  it("leaves silently once the transcript shows the desk's answer, and ignores answers not for its marker", async () => {
    const q = [question("Which fruit?")];
    const tx = transcript("s-desk", q);
    const { done } = start(permissionRequest("s-desk", q, tx));
    await waitFor(() => readMarkerFile("s-desk"));
    fs.writeFileSync(path.join(answers, "s-desk.answer.json"), JSON.stringify({ nonce: "not-this-one", answers: { "Which fruit?": "Apple" } }));
    await waitFor(() => !fs.existsSync(path.join(answers, "s-desk.answer.json")));
    expect(readMarkerFile("s-desk")).not.toBeNull(); // still waiting
    const result = { type: "user", timestamp: new Date().toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "toolu_q1", content: "answered" }] } };
    fs.appendFileSync(tx, JSON.stringify(result) + "\n");
    const { code, stdout } = await done;
    expect([code, stdout]).toEqual([0, ""]);
    expect(fs.readdirSync(answers)).toEqual([]);
    expect(logLines().map((l) => l.phase).filter(Boolean)).toEqual(["waiting", "desk"]);
  });

  it("gives up silently at the deadline and removes its marker on SIGTERM", async () => {
    const q = [question("Which fruit?")];
    const late = start(permissionRequest("s-late", q), "sdk-ts", ["--wait", "2", "--poll", "0.05"]);
    await waitFor(() => readMarkerFile("s-late"));
    expect(await late.done).toEqual({ code: 0, stdout: "" });
    expect(readMarkerFile("s-late")).toBeNull();
    const killed = start(permissionRequest("s-kill", q));
    await waitFor(() => readMarkerFile("s-kill"));
    killed.child.kill("SIGTERM");
    expect(await killed.done).toEqual({ code: 0, stdout: "" });
    expect(readMarkerFile("s-kill")).toBeNull();
    expect(logLines().map((l) => l.phase).filter(Boolean)).toEqual(["waiting", "timeout", "waiting", "signal"]);
  });
});
