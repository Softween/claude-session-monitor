import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const INSTALL = path.resolve(process.cwd(), "scripts/install.sh");
const HOOK_MARK = "session-monitor/hook.py";
const EXPECTED_EVENTS = {
  claude: ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd"],
  codex: [
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "PermissionRequest",
    "SessionEnd",
  ],
} as const;

describe("scripts/install.sh security and idempotency", () => {
  let tmp: string;
  let fakeBin: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-install-"));
    fakeBin = path.join(tmp, "bin");
    fs.mkdirSync(fakeBin);
    const ps = path.join(fakeBin, "ps");
    fs.writeFileSync(ps, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(ps, 0o755);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function envFor(home: string): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
  }

  function runInstall(home: string) {
    return spawnSync("bash", [INSTALL], {
      cwd: process.cwd(),
      env: envFor(home),
      encoding: "utf8",
      timeout: 10_000,
    });
  }

  function configFile(home: string, provider: "claude" | "codex"): string {
    return provider === "claude"
      ? path.join(home, ".claude", "settings.json")
      : path.join(home, ".codex", "hooks.json");
  }

  function writeConfig(
    home: string,
    provider: "claude" | "codex",
    content: string,
  ): string {
    const file = configFile(home, provider);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  function readConfig(home: string, provider: "claude" | "codex"): any {
    return JSON.parse(fs.readFileSync(configFile(home, provider), "utf8"));
  }

  function hookCommand(config: any, event: string): string {
    const groups = config.hooks?.[event];
    expect(Array.isArray(groups)).toBe(true);
    const handlers = groups.flatMap((group: any) => group.hooks ?? []);
    const handler = handlers.find(
      (candidate: any) =>
        typeof candidate.command === "string" && candidate.command.includes(HOOK_MARK),
    );
    expect(handler).toBeDefined();
    return handler.command;
  }

  function backupFiles(home: string): string[] {
    const roots = [path.join(home, ".claude"), path.join(home, ".codex")];
    return roots.flatMap((root) => {
      try {
        return fs
          .readdirSync(root)
          .filter((name) => name.includes(".bak.asm."))
          .map((name) => path.join(root, name));
      } catch {
        return [];
      }
    });
  }

  function monitorSnapshot(home: string): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const provider of ["claude", "codex"] as const) {
      const dir = path.join(home, `.${provider}`, "session-monitor");
      snapshot[`${provider}:dirMode`] = fs.statSync(dir).mode & 0o777;
      snapshot[`${provider}:files`] = fs.readdirSync(dir).sort();
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        snapshot[`${provider}:${name}:mode`] = fs.statSync(file).mode & 0o777;
        snapshot[`${provider}:${name}:bytes`] = fs.readFileSync(file);
      }
    }
    return snapshot;
  }

  function seedInstalledFiles(home: string): void {
    for (const provider of ["claude", "codex"] as const) {
      const dir = path.join(home, `.${provider}`, "session-monitor");
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      const legacy = path.join(dir, "legacy.json");
      fs.writeFileSync(legacy, `${provider} legacy status\n`);
      fs.chmodSync(legacy, 0o644);
    }
    const claudeDir = path.join(home, ".claude", "session-monitor");
    fs.writeFileSync(path.join(claudeDir, "hook.py"), "old hook body\n");
    fs.chmodSync(path.join(claudeDir, "hook.py"), 0o644);
    fs.writeFileSync(path.join(claudeDir, "statusline.sh"), "old statusline body\n");
    fs.chmodSync(path.join(claudeDir, "statusline.sh"), 0o600);
  }

  it.each([
    {
      label: "malformed Claude JSON",
      claude: '{"hooks":',
      codex: '{\n  "sentinel": "codex",\n  "hooks": {}\n}\n',
    },
    {
      label: "structurally malformed Codex hooks",
      claude: '{\n  "sentinel": "claude",\n  "hooks": {}\n}\n',
      codex: '{\n  "sentinel": "codex",\n  "hooks": []\n}\n',
    },
  ])("fails closed for $label without modifying either config", ({ claude, codex }) => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    const claudeFile = writeConfig(home, "claude", claude);
    const codexFile = writeConfig(home, "codex", codex);
    const beforeClaude = fs.readFileSync(claudeFile);
    const beforeCodex = fs.readFileSync(codexFile);

    const result = runInstall(home);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Refusing to modify hook settings:");
    expect(fs.readFileSync(claudeFile)).toEqual(beforeClaude);
    expect(fs.readFileSync(codexFile)).toEqual(beforeCodex);
    expect(backupFiles(home)).toEqual([]);
  });

  it.each([
    {
      label: "non-object Claude handler",
      claude: JSON.stringify({
        hooks: { SessionStart: [{ hooks: ["not-an-object"] }] },
      }),
      codex: JSON.stringify({ hooks: {} }),
    },
    {
      label: "non-string Codex handler command",
      claude: JSON.stringify({ hooks: {} }),
      codex: JSON.stringify({
        hooks: {
          PermissionRequest: [
            { hooks: [{ type: "command", command: { executable: "python3" } }] },
          ],
        },
      }),
    },
  ])(
    "fails completely closed for a $label before touching installed files or modes",
    ({ claude, codex }) => {
      const home = path.join(tmp, "nested-malformed-home");
      fs.mkdirSync(home);
      const claudeFile = writeConfig(home, "claude", claude);
      const codexFile = writeConfig(home, "codex", codex);
      seedInstalledFiles(home);
      const beforeClaude = fs.readFileSync(claudeFile);
      const beforeCodex = fs.readFileSync(codexFile);
      const beforeMonitor = monitorSnapshot(home);

      const result = runInstall(home);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Refusing to modify hook settings:");
      expect(fs.readFileSync(claudeFile)).toEqual(beforeClaude);
      expect(fs.readFileSync(codexFile)).toEqual(beforeCodex);
      expect(monitorSnapshot(home)).toEqual(beforeMonitor);
      expect(backupFiles(home)).toEqual([]);
    },
  );

  it("quotes commands for a HOME containing spaces and apostrophes, and those commands execute", () => {
    const home = path.join(tmp, "home with spaces and 'quotes'");
    fs.mkdirSync(home);
    const installed = runInstall(home);
    expect(installed.status).toBe(0);

    const claudeCommand = hookCommand(readConfig(home, "claude"), "UserPromptSubmit");
    const codexCommand = hookCommand(readConfig(home, "codex"), "PermissionRequest");
    expect(claudeCommand).toContain(HOOK_MARK);
    expect(claudeCommand).toContain("'");
    expect(codexCommand).toContain("'");

    const claudeRun = spawnSync("/bin/sh", ["-c", claudeCommand], {
      input: JSON.stringify({
        session_id: "space-claude",
        transcript_path: path.join(home, ".claude", "projects", "space.jsonl"),
        prompt: "quoted command works",
      }),
      env: envFor(home),
      encoding: "utf8",
      timeout: 5000,
    });
    const codexRun = spawnSync("/bin/sh", ["-c", codexCommand], {
      input: JSON.stringify({
        session_id: "space-codex",
        provider: "codex",
        tool_name: "Bash",
      }),
      env: envFor(home),
      encoding: "utf8",
      timeout: 5000,
    });

    expect(claudeRun.status).toBe(0);
    expect(claudeRun.stdout).toBe("");
    expect(codexRun.status).toBe(0);
    expect(codexRun.stdout).toBe("");
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(home, ".claude", "session-monitor", "space-claude.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ provider: "claude", state: "working" });
    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(home, ".codex", "session-monitor", "space-codex.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ provider: "codex", state: "waiting" });
  });

  it("is idempotent on a second install and never duplicates provider hooks", () => {
    const home = path.join(tmp, "idempotent-home");
    fs.mkdirSync(home);
    writeConfig(
      home,
      "claude",
      JSON.stringify(
        {
          sentinel: "claude",
          hooks: {
            PreToolUse: [{ hooks: [{ type: "command", command: "existing-tool" }] }],
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeConfig(
      home,
      "codex",
      JSON.stringify(
        {
          sentinel: "codex",
          hooks: {
            PostToolUse: [{ hooks: [{ type: "command", command: "existing-tool" }] }],
          },
        },
        null,
        2,
      ) + "\n",
    );

    const first = runInstall(home);
    expect(first.status).toBe(0);
    const firstClaude = fs.readFileSync(configFile(home, "claude"));
    const firstCodex = fs.readFileSync(configFile(home, "codex"));
    const firstBackups = backupFiles(home).sort();

    const second = runInstall(home);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("(already present)");
    expect(fs.readFileSync(configFile(home, "claude"))).toEqual(firstClaude);
    expect(fs.readFileSync(configFile(home, "codex"))).toEqual(firstCodex);
    expect(backupFiles(home).sort()).toEqual(firstBackups);

    for (const provider of ["claude", "codex"] as const) {
      const config = readConfig(home, provider);
      expect(config.sentinel).toBe(provider);
      for (const event of EXPECTED_EVENTS[provider]) {
        const matching = config.hooks[event].flatMap((group: any) => group.hooks ?? []).filter(
          (handler: any) =>
            typeof handler.command === "string" && handler.command.includes(HOOK_MARK),
        );
        expect(matching, `${provider}.${event}`).toHaveLength(1);
        expect(matching[0].timeout, `${provider}.${event} timeout`).toBe(
          event === "SessionEnd" ? 3 : 5,
        );
      }
    }
  });

  it("migrates every existing ASM handler timeout and is idempotent on the second run", () => {
    const home = path.join(tmp, "timeout-migration-home");
    fs.mkdirSync(home);

    for (const provider of ["claude", "codex"] as const) {
      const hooks = Object.fromEntries(
        EXPECTED_EVENTS[provider].map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: `/usr/bin/python3 /old/session-monitor/hook.py ${event}`,
                  timeout: 99,
                },
                { type: "command", command: "unrelated-hook", timeout: 77 },
              ],
            },
            {
              hooks: [
                {
                  type: "command",
                  command: `/usr/bin/python3 '/another path/session-monitor/hook.py' ${event}`,
                },
              ],
            },
          ],
        ]),
      );
      writeConfig(
        home,
        provider,
        JSON.stringify({ sentinel: provider, hooks }, null, 2) + "\n",
      );
    }

    const first = runInstall(home);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("bounded timeout");
    for (const provider of ["claude", "codex"] as const) {
      const config = readConfig(home, provider);
      for (const event of EXPECTED_EVENTS[provider]) {
        const handlers = config.hooks[event].flatMap((group: any) => group.hooks ?? []);
        const asm = handlers.filter(
          (handler: any) =>
            typeof handler.command === "string" && handler.command.includes(HOOK_MARK),
        );
        expect(asm, `${provider}.${event} ASM handlers`).toHaveLength(2);
        expect(
          asm.every((handler: any) => handler.timeout === (event === "SessionEnd" ? 3 : 5)),
          `${provider}.${event} timeout migration`,
        ).toBe(true);
        expect(
          handlers.find((handler: any) => handler.command === "unrelated-hook")?.timeout,
        ).toBe(77);
      }
    }

    const firstClaude = fs.readFileSync(configFile(home, "claude"));
    const firstCodex = fs.readFileSync(configFile(home, "codex"));
    const firstBackups = backupFiles(home).sort();
    const second = runInstall(home);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("(already present)");
    expect(fs.readFileSync(configFile(home, "claude"))).toEqual(firstClaude);
    expect(fs.readFileSync(configFile(home, "codex"))).toEqual(firstCodex);
    expect(backupFiles(home).sort()).toEqual(firstBackups);
  });

  it("preserves symlink config paths while atomically replacing both targets", () => {
    const home = path.join(tmp, "symlink-home");
    const targets = path.join(tmp, "config targets");
    fs.mkdirSync(targets);
    const links: Record<"claude" | "codex", string> = {
      claude: configFile(home, "claude"),
      codex: configFile(home, "codex"),
    };
    const targetFiles: Record<"claude" | "codex", string> = {
      claude: path.join(targets, "claude-settings.json"),
      codex: path.join(targets, "codex-hooks.json"),
    };
    const beforeInodes: Partial<Record<"claude" | "codex", number>> = {};

    for (const provider of ["claude", "codex"] as const) {
      fs.mkdirSync(path.dirname(links[provider]), { recursive: true });
      fs.writeFileSync(
        targetFiles[provider],
        JSON.stringify({ sentinel: provider, hooks: {} }, null, 2) + "\n",
      );
      fs.chmodSync(targetFiles[provider], 0o640);
      beforeInodes[provider] = fs.statSync(targetFiles[provider]).ino;
      fs.symlinkSync(targetFiles[provider], links[provider]);
    }

    const result = runInstall(home);
    expect(result.status).toBe(0);

    for (const provider of ["claude", "codex"] as const) {
      expect(fs.lstatSync(links[provider]).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(links[provider])).toBe(
        fs.realpathSync(targetFiles[provider]),
      );
      expect(fs.statSync(targetFiles[provider]).ino).not.toBe(beforeInodes[provider]);
      expect(fs.statSync(targetFiles[provider]).mode & 0o777).toBe(0o640);
      const config = JSON.parse(fs.readFileSync(targetFiles[provider], "utf8"));
      expect(config.sentinel).toBe(provider);
      for (const event of EXPECTED_EVENTS[provider]) {
        const handlers = config.hooks[event].flatMap((group: any) => group.hooks ?? []);
        expect(
          handlers.some(
            (handler: any) =>
              typeof handler.command === "string" && handler.command.includes(HOOK_MARK),
          ),
          `${provider}.${event}`,
        ).toBe(true);
      }
    }
    expect(
      fs.readdirSync(targets).filter((name) => name.includes(".agent-session-monitor.")),
    ).toEqual([]);
  });

  it("locks down monitor directories, installed scripts, and legacy status files", () => {
    const home = path.join(tmp, "permissions-home");
    for (const provider of ["claude", "codex"] as const) {
      const dir = path.join(home, `.${provider}`, "session-monitor");
      fs.mkdirSync(dir, { recursive: true });
      fs.chmodSync(dir, 0o755);
      const legacy = path.join(dir, "legacy.json");
      fs.writeFileSync(legacy, "{}");
      fs.chmodSync(legacy, 0o644);
    }

    expect(runInstall(home).status).toBe(0);

    for (const provider of ["claude", "codex"] as const) {
      const dir = path.join(home, `.${provider}`, "session-monitor");
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, "legacy.json")).mode & 0o777).toBe(0o600);
    }
    expect(
      fs.statSync(path.join(home, ".claude", "session-monitor", "hook.py")).mode &
        0o777,
    ).toBe(0o600);
    expect(
      fs.statSync(path.join(home, ".claude", "session-monitor", "statusline.sh")).mode &
        0o777,
    ).toBe(0o700);
  });
});
