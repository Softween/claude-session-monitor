import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const HOOK = path.resolve(process.cwd(), "scripts/hook.py");

describe("scripts/hook.py provider routing", () => {
  let tmp: string;
  let hookEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-hook-"));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin);
    const ps = path.join(bin, "ps");
    fs.writeFileSync(ps, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(ps, 0o755);
    hookEnv = {
      ...process.env,
      HOME: tmp,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function run(payload: unknown, event?: string) {
    const result = spawnSync("python3", event ? [HOOK, event] : [HOOK], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      env: hookEnv,
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    return result;
  }

  function read(provider: "claude" | "codex", id: string): Record<string, unknown> {
    return JSON.parse(
      fs.readFileSync(path.join(tmp, `.${provider}`, "session-monitor", `${id}.json`), "utf8"),
    ) as Record<string, unknown>;
  }

  it("defaults a Claude prompt event to the Claude monitor and keeps the bounded prompt", () => {
    const prompt = "x".repeat(250);
    run(
      {
        session_id: "claude-session",
        cwd: "/workspace",
        transcript_path: `${tmp}/.claude/projects/session.jsonl`,
        prompt,
      },
      "UserPromptSubmit",
    );

    const record = read("claude", "claude-session");
    expect(record).toMatchObject({
      session_id: "claude-session",
      provider: "claude",
      event: "UserPromptSubmit",
      state: "working",
      cwd: "/workspace",
    });
    expect(record.prompt).toBe(prompt.slice(0, 200));
    expect(fs.existsSync(path.join(tmp, ".codex", "session-monitor"))).toBe(false);
  });

  it("infers Codex from its transcript and maps PermissionRequest to waiting", () => {
    run(
      {
        session_id: "codex-session",
        cwd: "/workspace",
        transcript_path: `${tmp}/.codex/sessions/rollout.jsonl`,
        model: "gpt-5.6-sol",
        turn_id: "turn-1",
        tool_name: "Bash",
        prompt: "must not be persisted for Codex",
      },
      "PermissionRequest",
    );

    expect(read("codex", "codex-session")).toMatchObject({
      session_id: "codex-session",
      provider: "codex",
      event: "PermissionRequest",
      state: "waiting",
      message: "permission: Bash",
      model: "gpt-5.6-sol",
      turn_id: "turn-1",
    });
    expect(read("codex", "codex-session")).not.toHaveProperty("prompt");
  });

  it("uses hook_event_name when no argv event is provided and recognizes Codex model metadata", () => {
    run({
      session_id: "codex-payload-event",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6-terra",
      turn_id: "turn-2",
      prompt: "private Codex prompt",
    });

    const record = read("codex", "codex-payload-event");
    expect(record).toMatchObject({
      provider: "codex",
      event: "UserPromptSubmit",
      state: "working",
      model: "gpt-5.6-terra",
      turn_id: "turn-2",
    });
    expect(record).not.toHaveProperty("prompt");
  });

  it("always exits zero and refuses path-traversal session ids", () => {
    run({ session_id: "../escape", provider: "codex" }, "SessionStart");
    expect(fs.existsSync(path.join(tmp, "escape.json"))).toBe(false);

    const invalid = spawnSync("python3", [HOOK, "SessionStart"], {
      input: "{invalid",
      encoding: "utf8",
      env: hookEnv,
      timeout: 5000,
    });
    expect(invalid.status).toBe(0);
    expect(invalid.stdout).toBe("");
  });

  it("creates provider monitor directories as 0700 and status/lock files as 0600", () => {
    for (const provider of ["claude", "codex"] as const) {
      const dir = path.join(tmp, `.${provider}`, "session-monitor");
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      run(
        {
          session_id: `${provider}-permissions`,
          provider,
          cwd: "/workspace",
        },
        "SessionStart",
      );

      const status = path.join(dir, `${provider}-permissions.json`);
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(status).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(dir, ".write.lock")).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    }
  });

  it("persists SessionEnd without waiting for a slow process-tree scan", () => {
    const ps = path.join(tmp, "bin", "ps");
    fs.writeFileSync(ps, "#!/bin/sh\nsleep 3\nexit 0\n");
    fs.chmodSync(ps, 0o755);

    const started = Date.now();
    run(
      {
        session_id: "fast-session-end",
        provider: "codex",
        reason: "closed",
      },
      "SessionEnd",
    );
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(1500);
    expect(read("codex", "fast-session-end")).toMatchObject({
      event: "SessionEnd",
      state: "ended",
      reason: "closed",
    });
    expect(read("codex", "fast-session-end")).not.toHaveProperty("pid");
  });

  it(
    "keeps concurrent writes to one session valid and leaves no temporary files",
    async () => {
      const dir = path.join(tmp, ".codex", "session-monitor");
      const events = [
        "SessionStart",
        "UserPromptSubmit",
        "Stop",
        "PermissionRequest",
        "SessionEnd",
      ];

      const runConcurrent = (
        event: string,
        index: number,
      ): Promise<{ stdout: string; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn("python3", [HOOK, event], {
            env: hookEnv,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8");
          child.stderr.setEncoding("utf8");
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("close", (code) => {
            if (code !== 0) {
              reject(new Error(`hook exited ${code}: ${stderr}`));
              return;
            }
            resolve({ stdout, stderr });
          });
          child.stdin.end(
            JSON.stringify({
              session_id: "concurrent-session",
              provider: "codex",
              cwd: "/workspace",
              model: `gpt-test-${index}`,
              turn_id: `turn-${index}`,
              tool_name: "Bash",
            }),
          );
        });

      for (let round = 0; round < 3; round++) {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, index) =>
            runConcurrent(events[index % events.length], round * 12 + index),
          ),
        );
        expect(results.every((result) => result.stdout === "")).toBe(true);

        const final = path.join(dir, "concurrent-session.json");
        const parsed = JSON.parse(fs.readFileSync(final, "utf8")) as Record<string, unknown>;
        expect(parsed).toMatchObject({
          session_id: "concurrent-session",
          provider: "codex",
        });
        expect(typeof parsed.ts).toBe("number");
        expect(fs.statSync(final).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      }
    },
    15_000,
  );
});
