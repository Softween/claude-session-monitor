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

  // A fake `ps`: the hook itself (the script's $PPID is the python process) under
  // `parent`, under a login shell.
  function fakePs(parent: string): void {
    const ps = path.join(tmp, "bin", "ps");
    fs.writeFileSync(ps, `#!/bin/sh\necho "$PPID 4242 python3 hook.py"\necho "4242 4241 ${parent}"\necho "4241 1 -zsh"\n`);
    fs.chmodSync(ps, 0o755);
  }

  it("records the pid of a claude started from a terminal: the executable at any path, or node running it", () => {
    const parents = ["/Users/u/.local/bin/claude --resume s0", "node /Users/u/.npm-global/bin/claude --resume s1", "claude"];
    parents.forEach((parent, i) => {
      fakePs(parent);
      run({ session_id: `terminal-${i}`, cwd: "/workspace", transcript_path: `${tmp}/.claude/projects/t.jsonl`, source: "resume" }, "SessionStart");
      expect(read("claude", `terminal-${i}`)).toMatchObject({ state: "idle", source: "resume", pid: 4242 });
    });
  });

  it("never takes claude-switch, other claude-* names or the desktop app for the Claude session process", () => {
    const parents = ["/Users/u/.claude/bin/claude-switch run", "node /Users/u/bin/claude-mem worker", "/Applications/Claude.app/Contents/MacOS/Claude"];
    parents.forEach((parent, i) => {
      fakePs(parent);
      run({ session_id: `other-${i}`, cwd: "/workspace", transcript_path: `${tmp}/.claude/projects/o.jsonl` }, "Stop");
      expect(read("claude", `other-${i}`)).not.toHaveProperty("pid");
    });
  });

  it(
    "records nothing for the `claude auth status` probe on any event, and still records a claude session with its pid",
    () => {
      const probes = [
        "/path/native-binary/claude auth status --json",
        "/Users/u/.vscode/extensions/anthropic.claude-code-2.1.314-darwin-arm64/resources/native-binary/claude auth status --json",
        "node /Users/u/.npm-global/bin/claude auth status",
      ];
      probes.forEach((parent, i) => {
        fakePs(parent);
        for (const event of ["SessionStart", "SessionEnd"]) {
          run({ session_id: `probe-${i}`, cwd: "/workspace", transcript_path: `${tmp}/.claude/projects/p.jsonl`, source: "startup" }, event);
        }
      });
      expect(fs.existsSync(path.join(tmp, ".claude", "session-monitor"))).toBe(false);

      // Only options may follow `auth status`: a prompt starting with those words is a session.
      const sessions = ["/path/native-binary/claude --output-format stream-json --verbose --input-format stream-json", "claude", "claude auth status page is blank"];
      sessions.forEach((parent, i) => {
        fakePs(parent);
        run({ session_id: `session-${i}`, cwd: "/workspace", transcript_path: `${tmp}/.claude/projects/s.jsonl`, source: "startup" }, "SessionStart");
        expect(read("claude", `session-${i}`)).toMatchObject({ event: "SessionStart", source: "startup", pid: 4242 });
      });
    },
    15_000,
  );

  it("scans on a Claude SessionEnd only when the session has no record yet, and never records a pid there", () => {
    fakePs("claude");
    run({ session_id: "unrecorded", cwd: "/workspace", reason: "other" }, "SessionEnd");
    expect(read("claude", "unrecorded")).toMatchObject({ event: "SessionEnd", state: "ended" });
    expect(read("claude", "unrecorded")).not.toHaveProperty("pid");

    run({ session_id: "recorded", cwd: "/workspace" }, "SessionStart");
    expect(read("claude", "recorded")).toMatchObject({ pid: 4242 });
    const ps = path.join(tmp, "bin", "ps");
    fs.writeFileSync(ps, "#!/bin/sh\nsleep 3\nexit 0\n");
    fs.chmodSync(ps, 0o755);
    const started = Date.now();
    run({ session_id: "recorded", cwd: "/workspace", reason: "other" }, "SessionEnd");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(read("claude", "recorded")).toMatchObject({ event: "SessionEnd", state: "ended", reason: "other" });
    expect(read("claude", "recorded")).not.toHaveProperty("pid");
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
