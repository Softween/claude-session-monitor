const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const code = process.env.AGENT_HUB_CODE_CLI || (process.platform === 'darwin'
  ? '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
  : 'code');
const report = process.env.AGENT_HUB_SMOKE_REPORT || path.join(os.tmpdir(), `agent-hub-smoke-${Date.now()}.json`);
const userDataDir = process.env.AGENT_HUB_VSCODE_USER_DATA
  || path.join(os.tmpdir(), 'agent-hub-vscode-smoke');
const HOST_TIMEOUT_MS = 180_000;
const startedAt = Date.now();
const environment = { ...process.env, AGENT_HUB_SMOKE_REPORT: report };
// A test host needs its own main process, not the calling extension host's IPC.
for (const key of ['ELECTRON_RUN_AS_NODE', 'VSCODE_IPC_HOOK', 'VSCODE_ESM_ENTRYPOINT', 'VSCODE_PID']) delete environment[key];
fs.mkdirSync(userDataDir, { recursive: true });
const child = spawn(code, [
  '--new-window', '--wait', '--disable-extensions',
  `--user-data-dir=${userDataDir}`,
  `--extensionDevelopmentPath=${root}`,
  `--extensionTestsPath=${path.join(root, 'scripts/vscode-smoke.cjs')}`,
  root,
], { stdio: 'inherit', env: environment });

let finished = false;
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`VS Code smoke host exceeded ${HOST_TIMEOUT_MS / 1000}s and will be stopped.\n`);
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
}, HOST_TIMEOUT_MS);

function finish(exitCode) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (!fs.existsSync(report)) {
    process.stderr.write(
      timedOut
        ? `VS Code smoke host timed out without producing a report: ${report}\n`
        : `VS Code smoke host did not produce a report: ${report}\n`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    const checkedAt = Date.parse(result.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt < startedAt) {
      process.stderr.write(`VS Code smoke host did not produce a fresh report: ${report}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(JSON.stringify({ report, userDataDir, ...result }, null, 2) + '\n');
    process.exitCode = exitCode === 0 && !result.errors.length && !timedOut ? 0 : 1;
  } catch (error) {
    process.stderr.write(`VS Code smoke host wrote an unreadable report: ${error.message}\n`);
    process.exitCode = 1;
  }
}

child.on('error', error => {
  process.stderr.write(`VS Code smoke host failed: ${error.message}\n`);
  finish(1);
});
child.on('exit', finish);
