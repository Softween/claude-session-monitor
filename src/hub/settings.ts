import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

export interface SettingsTarget {
  label: string;
  description: string;
  path: string;
  targetKind: "file" | "folder";
}

export function codexHome(home = os.homedir(), configured = process.env.CODEX_HOME): string {
  return configured && path.isAbsolute(configured) ? configured : path.join(home, ".codex");
}

/** Known configuration and instruction locations only. Credential files stay private. */
export function knownSettingsTargets(home = os.homedir(), workspace?: string): SettingsTarget[] {
  const codex = codexHome(home);
  const global: SettingsTarget[] = [
    { label: "Claude global settings", description: "~/.claude/settings.json", path: path.join(home, ".claude", "settings.json"), targetKind: "file" },
    { label: "Claude instructions", description: "~/.claude/CLAUDE.md", path: path.join(home, ".claude", "CLAUDE.md"), targetKind: "file" },
    { label: "Claude skills", description: "~/.claude/skills", path: path.join(home, ".claude", "skills"), targetKind: "folder" },
    { label: "Claude hooks", description: "~/.claude/hooks", path: path.join(home, ".claude", "hooks"), targetKind: "folder" },
    { label: "Codex global settings", description: "config.toml", path: path.join(codex, "config.toml"), targetKind: "file" },
    { label: "Codex instructions", description: "AGENTS.md", path: path.join(codex, "AGENTS.md"), targetKind: "file" },
    { label: "Codex skills", description: "skills folder", path: path.join(codex, "skills"), targetKind: "folder" },
    { label: "Copilot global settings", description: "~/.copilot/settings.json", path: path.join(home, ".copilot", "settings.json"), targetKind: "file" },
    {
      label: "Copilot legacy configuration (may contain credentials)",
      description: "~/.copilot/config.json — opened locally only after you select it",
      path: path.join(home, ".copilot", "config.json"),
      targetKind: "file",
    },
  ];
  if (!workspace) return global;
  return [
    ...global,
    { label: "Claude project settings", description: ".claude/settings.json", path: path.join(workspace, ".claude", "settings.json"), targetKind: "file" },
    { label: "Claude local settings", description: ".claude/settings.local.json", path: path.join(workspace, ".claude", "settings.local.json"), targetKind: "file" },
    { label: "Claude project MCP", description: ".mcp.json", path: path.join(workspace, ".mcp.json"), targetKind: "file" },
    { label: "Claude project instructions", description: "CLAUDE.md", path: path.join(workspace, "CLAUDE.md"), targetKind: "file" },
    { label: "Claude project hooks", description: ".claude/hooks", path: path.join(workspace, ".claude", "hooks"), targetKind: "folder" },
    { label: "Codex project settings", description: ".codex/config.toml", path: path.join(workspace, ".codex", "config.toml"), targetKind: "file" },
    { label: "Codex project instructions", description: "AGENTS.md", path: path.join(workspace, "AGENTS.md"), targetKind: "file" },
    { label: "Copilot project settings", description: ".github/copilot/settings.json", path: path.join(workspace, ".github", "copilot", "settings.json"), targetKind: "file" },
    { label: "Copilot local settings", description: ".github/copilot/settings.local.json", path: path.join(workspace, ".github", "copilot", "settings.local.json"), targetKind: "file" },
    { label: "Copilot instructions", description: ".github/copilot-instructions.md", path: path.join(workspace, ".github", "copilot-instructions.md"), targetKind: "file" },
    { label: "Copilot skills", description: ".github/skills", path: path.join(workspace, ".github", "skills"), targetKind: "folder" },
    { label: "Copilot project MCP", description: ".vscode/mcp.json", path: path.join(workspace, ".vscode", "mcp.json"), targetKind: "file" },
  ];
}

export async function openKnownSettings(home: string, workspace?: string): Promise<void> {
  const picked = await vscode.window.showQuickPick(knownSettingsTargets(home, workspace), {
    placeHolder: "Open agent settings, instructions, MCP, or skills",
  });
  if (!picked) return;
  if (!fs.existsSync(picked.path)) {
    vscode.window.showInformationMessage(`${picked.description} does not exist yet.`);
    return;
  }
  const uri = vscode.Uri.file(picked.path);
  try {
    if (picked.targetKind === "folder") {
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    }
    await vscode.commands.executeCommand("vscode.open", uri);
  } catch {
    vscode.window.showInformationMessage(`Could not open ${picked.description}.`);
  }
}
