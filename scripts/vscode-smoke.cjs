/* Run inside a real VS Code extension test host. Never sends a model prompt. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vscode = require('vscode');

const TRUST_TIMEOUT_MS = 90_000;

async function requireWorkspaceTrust(report) {
  if (vscode.workspace.isTrusted) return;
  report.checks.push('Workspace is untrusted; opened Workspace Trust management for manual approval');
  const granted = new Promise((resolve, reject) => {
    const listener = vscode.workspace.onDidGrantWorkspaceTrust(() => {
      clearTimeout(timeout);
      listener.dispose();
      resolve();
    });
    const timeout = setTimeout(() => {
      listener.dispose();
      reject(new Error('Workspace Trust was not granted within 90 seconds. Approve the source checkout in the Workspace Trust view, then rerun.'));
    }, TRUST_TIMEOUT_MS);
  });
  await vscode.commands.executeCommand('workbench.trust.manage');
  await granted;
  assert.equal(vscode.workspace.isTrusted, true, 'Workspace Trust approval did not make the source checkout trusted');
  report.checks.push('Workspace Trust was granted manually');
}

async function run() {
  const report = { checkedAt: new Date().toISOString(), checks: [], errors: [] };
  const created = new Set();
  const listener = vscode.window.onDidOpenTerminal(terminal => created.add(terminal));
  try {
    const extension = vscode.extensions.getExtension('softween.claude-code-session-monitor');
    assert.ok(extension, 'Packaged extension is discoverable');
    await extension.activate();
    assert.equal(extension.isActive, true);
    assert.equal(extension.packageJSON.version, '3.0.0');
    report.checks.push('3.0.0 extension activated in real VS Code');
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of ['open', 'selectProvider', 'start', 'newSession', 'configure', 'nativeSettings', 'login', 'resume']) {
      assert.ok(commands.has(`agentHub.${command}`), `Command registered: ${command}`);
    }
    await vscode.commands.executeCommand('agentHub.open');
    report.checks.push('Workbench view opened and all eight commands registered');
    await requireWorkspaceTrust(report);
    for (const provider of ['codex', 'copilot']) {
      await vscode.commands.executeCommand('agentHub.selectProvider', provider);
      const before = vscode.window.terminals.length;
      await vscode.commands.executeCommand('agentHub.start');
      assert.equal(vscode.window.terminals.length, before + 1, `${provider} starts a terminal`);
      const terminal = vscode.window.terminals.at(-1);
      assert.ok(terminal);
      assert.ok(await terminal.processId, `${provider} native process started`);
      await vscode.commands.executeCommand('agentHub.start');
      assert.equal(vscode.window.terminals.length, before + 1, `${provider} reuses terminal`);
      await vscode.commands.executeCommand('agentHub.newSession');
      assert.equal(vscode.window.terminals.length, before + 2, `${provider} new conversation preserves old terminal`);
      report.checks.push(`${provider}: process start, terminal reuse, separate new session`);
    }
    await vscode.commands.executeCommand('agentHub.selectProvider', 'claude');
    report.checks.push('Claude selection restored; no model prompts sent');
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    listener.dispose();
    for (const terminal of created) terminal.dispose();
    if (process.env.AGENT_HUB_SMOKE_REPORT) {
      await fs.writeFile(process.env.AGENT_HUB_SMOKE_REPORT, JSON.stringify(report, null, 2));
    }
  }
}

module.exports = { run };
