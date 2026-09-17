import { describe, expect, it } from "vitest";
import {
  buildLaunchSpec,
  defaultPermissionPreset,
  isValidModel,
  permissionOptionsFor,
} from "../src/hub/model";

describe("Agent Hub launch specifications", () => {
  it("passes Claude model and accept-edits policy as isolated CLI arguments", () => {
    expect(buildLaunchSpec("claude", "sonnet", "auto")).toEqual({
      args: ["--model", "sonnet", "--permission-mode", "acceptEdits"],
      label: "Auto accept edits",
    });
  });

  it("uses Codex's documented on-request workspace-write arguments", () => {
    expect(buildLaunchSpec("codex", "gpt-5.2-codex", "ask")).toEqual({
      args: ["--model", "gpt-5.2-codex", "--ask-for-approval", "on-request", "--sandbox", "workspace-write"],
      label: "Ask before elevated actions",
    });
  });

  it("only adds the explicit full-access flags selected by the user", () => {
    expect(buildLaunchSpec("copilot", undefined, "full")).toEqual({
      args: ["--allow-all"],
      label: "Full access",
    });
    expect(buildLaunchSpec("claude", undefined, "full").args).toContain(
      "--dangerously-skip-permissions",
    );
  });

  it("uses Copilot's --resume flag instead of treating resume as a subcommand", () => {
    expect(buildLaunchSpec("copilot", undefined, "native", "session-123").args).toEqual([
      "--resume",
      "session-123",
    ]);
  });

  it("rejects model values that could be mistaken for command options", () => {
    expect(isValidModel("gpt-5.2-codex")).toBe(true);
    expect(isValidModel("--dangerously-skip-permissions")).toBe(false);
    expect(isValidModel("sonnet;rm -rf /")).toBe(false);
    expect(buildLaunchSpec("claude", "--dangerously-skip-permissions", "native").args).toEqual([]);
  });

  it("keeps ambiguous automatic modes out of providers that do not have one", () => {
    expect(permissionOptionsFor("codex").map((option) => option.id)).not.toContain("auto");
    expect(defaultPermissionPreset("claude")).toBe("native");
    expect(defaultPermissionPreset("codex")).toBe("native");
  });
});
