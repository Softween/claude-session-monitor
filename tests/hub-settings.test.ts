import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({ window: {}, commands: {}, Uri: {} }));
import { knownSettingsTargets } from "../src/hub/settings";

describe("Agent Hub native settings boundaries", () => {
  it("lists supported global, project, instructions, MCP, and skills paths", () => {
    const targets = knownSettingsTargets("/Users/example", "/repo");
    const paths = targets.map((target) => target.path);
    expect(paths).toContain("/Users/example/.claude/settings.json");
    expect(paths).toContain("/repo/.claude/settings.local.json");
    expect(paths).toContain("/Users/example/.codex/config.toml");
    expect(paths).toContain("/repo/AGENTS.md");
    expect(paths).toContain("/Users/example/.copilot/settings.json");
  });

  it("only opens legacy Copilot configuration after an explicit, credential-warning selection", () => {
    const targets = knownSettingsTargets("/Users/example", "/repo");
    expect(targets.find((target) => target.path === "/Users/example/.copilot/config.json")?.label).toContain(
      "may contain credentials",
    );
    expect(targets.map((target) => target.path)).not.toContain("/Users/example/.copilot/credentials.json");
    expect(targets.map((target) => target.path)).not.toContain("/Users/example/.copilot/auth.json");
  });
});
