// Smoke test of the built bundle (`npm run build && npm run smoke`): loads
// dist/extension.js the way VS Code does, with a fake vscode
// (scripts/smoke-dist-fakes.mjs) behind a Module._load hook, a fresh temporary
// HOME, every child process stubbed and the network refused. It activates,
// resolves the webview views, lets TICKS refresh ticks reach the Sessions view,
// deactivates and disposes ctx.subscriptions. It fails when:
//  - loading, activate(), deactivate() or a subscription's dispose() throws
//  - an exception or promise rejection goes unhandled at any point
//  - the stage guard (src/safeStage.ts) logged a feature start or refresh stage that threw
//  - process resources (process.getActiveResourcesInfo) stay above the baseline
//    taken before loading, or a timer the bundle started is still pending
//  - the bundle read a vscode member the fake lacks
//  - package.json contributes a command the bundle did not register, or the
//    bundle registered one package.json does not contribute (INTERNAL_COMMANDS aside)
import Module, { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { childProcessStub, extensionContext, fakeVscode, fakeWebviewView } from "./smoke-dist-fakes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "extension.js");
/** Repo paths (and file URLs) in stack frames and log lines, relative to the repo. */
const short = (text) => text.replaceAll(`${pathToFileURL(ROOT).href}/`, "").replaceAll(ROOT + path.sep, "");
const TICKS = 3;
/** Every refresh posts an update to this view, so its updates show that the refreshes ran through. */
const SESSIONS_VIEW = "claudeSessionMonitor.view";
/** How long closing handles and in-flight callbacks get to finish after dispose. */
const SETTLE_MS = 2000;
/** Commands the extension registers on purpose without a package.json entry, with the reason. */
const INTERNAL_COMMANDS = new Map([
  ["claudeSessionMonitor.openSession", "the Sessions rows' open action; it needs a session row argument, so it has no palette entry"],
]);

// The harness waits with the real timers; the bundle gets the tracked ones (trackTimers).
const real = { setTimeout, setInterval, clearTimeout, clearInterval };
const sleep = (ms) => new Promise((resolve) => real.setTimeout(resolve, ms));

function describe(error) {
  if (!(error instanceof Error)) {
    try {
      return String(error);
    } catch {
      return typeof error;
    }
  }
  const frames = (error.stack ?? "").split("\n").slice(1, 4).map((l) => short(l.trim()));
  return `${error.name}: ${error.message}${frames.length ? ` (${frames.join(" < ")})` : ""}`;
}

/** A fresh HOME and TMPDIR: core.ts takes its directories from os.homedir() when the bundle loads. */
function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "csm-smoke-"));
  // ~/.claude/projects exists on a machine with Claude Code, so the projects watcher starts too.
  for (const dir of [".claude/projects", "tmp", "workspace"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  Object.assign(process.env, { HOME: home, USERPROFILE: home, TMPDIR: path.join(home, "tmp") });
  if (os.homedir() !== home) throw new Error(`os.homedir() is still ${os.homedir()}; refusing to load the bundle against real data`);
  return home;
}

function catchProcessErrors(errors) {
  process.on("uncaughtException", (error) => errors.push(`uncaught exception: ${describe(error)}`));
  process.on("unhandledRejection", (reason) => errors.push(`unhandled rejection: ${describe(reason)}`));
}

function resourceCounts() {
  const counts = new Map();
  for (const type of process.getActiveResourcesInfo()) counts.set(type, (counts.get(type) ?? 0) + 1);
  return counts;
}

function resourcesAbove(baseline) {
  return [...resourceCounts()]
    .filter(([type, n]) => n > (baseline.get(type) ?? 0))
    .map(([type, n]) => `${type} x${n - (baseline.get(type) ?? 0)}`);
}

/**
 * Replaces the global timer functions for the bundle. The returned map holds
 * every timer it started that has neither fired (setTimeout) nor been cleared,
 * unref'd ones included, which process.getActiveResourcesInfo does not list.
 */
function trackTimers() {
  const pending = new Map();
  const callSite = () => short((new Error().stack ?? "").split("\n")[3]?.trim() ?? "unknown");
  const start = (kind, set) =>
    function (callback, ms, ...args) {
      if (typeof callback !== "function") return set(callback, ms, ...args); // let Node reject it
      const site = callSite();
      const timer = set(
        (...a) => {
          if (kind === "setTimeout") pending.delete(timer);
          return callback(...a);
        },
        ms,
        ...args,
      );
      pending.set(timer, `${kind}(${ms ?? 0} ms) ${site}`);
      return timer;
    };
  const clear = (realClear) => (timer) => {
    pending.delete(timer);
    realClear(timer);
  };
  globalThis.setTimeout = start("setTimeout", real.setTimeout);
  globalThis.setInterval = start("setInterval", real.setInterval);
  globalThis.clearTimeout = clear(real.clearTimeout);
  globalThis.clearInterval = clear(real.clearInterval);
  return pending;
}

/** fetch fails as on a machine without network; the attempted URLs are recorded. */
function refuseNetwork(fetched) {
  globalThis.fetch = async (input) => {
    fetched.push(String(input?.url ?? input));
    throw new TypeError("fetch failed (no network in the smoke run)");
  };
}

/** require("vscode") and require("child_process") from the bundle get the fakes. */
function hookModuleLoad(fakes) {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const name = request.startsWith("node:") ? request.slice(5) : request;
    return Object.hasOwn(fakes, name) ? fakes[name] : load.call(this, request, parent, isMain);
  };
}

async function attempt(failures, what, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    failures.push(`${what} threw: ${describe(error)}`);
    return { ok: false };
  }
}

/**
 * Resolves every registered webview view, as VS Code does for an open panel,
 * then waits until the poll timer had time to fire TICKS times and the Sessions
 * view got at least TICKS updates (the resource sampler and the Codex poll post
 * updates too, so the updates alone do not count the ticks).
 */
async function runTicks(failures, rec, missing, pollMs) {
  const views = new Map();
  for (const [id, provider] of rec.webviewViews) {
    const fake = fakeWebviewView(id, missing);
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const resolved = await attempt(failures, `resolveWebviewView(${id})`, () => provider.resolveWebviewView(fake.view, { state: undefined }, token));
    if (resolved.ok) views.set(id, fake);
  }
  const sessions = views.get(SESSIONS_VIEW);
  if (!sessions) {
    failures.push(`no ${SESSIONS_VIEW} webview view to watch the refresh ticks on`);
    return "no refresh ticks";
  }
  const first = sessions.messages.length;
  const updates = () => sessions.messages.length - first;
  const started = Date.now();
  const ticksMs = TICKS * pollMs + 250;
  while ((updates() < TICKS || Date.now() - started < ticksMs) && Date.now() - started < ticksMs + 5000) await sleep(50);
  if (updates() < TICKS) failures.push(`the Sessions view got ${updates()} updates in ${TICKS} refresh ticks, at least ${TICKS} expected`);
  return `${TICKS} refresh ticks of ${pollMs} ms in ${Date.now() - started} ms, ${updates()} Sessions view updates`;
}

function disposeAll(failures, subscriptions) {
  for (const [i, subscription] of subscriptions.entries()) {
    try {
      subscription?.dispose?.();
    } catch (error) {
      failures.push(`ctx.subscriptions[${i}].dispose() threw: ${describe(error)}`);
    }
  }
}

/** Waits up to SETTLE_MS for the resources to drop to the baseline and the bundle's timers to end. */
async function settle(baseline, timers) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    await new Promise((resolve) => setImmediate(resolve));
    const extra = resourcesAbove(baseline);
    if ((!extra.length && !timers.size) || Date.now() >= deadline) return { extra, timers: [...timers.values()] };
    await sleep(25);
  }
}

/** The text files under `home` (the bundle's logs among them). */
function textFiles(home) {
  return fs
    .readdirSync(home, { recursive: true })
    .map((rel) => path.join(home, String(rel)))
    .filter((file) => {
      try {
        const stat = fs.statSync(file);
        return stat.isFile() && stat.size < 4 * 1024 * 1024;
      } catch {
        return false;
      }
    });
}

/** The lines the stage guard logged for a feature start or refresh stage that threw. */
function stageFailures(home) {
  return textFiles(home).flatMap((file) =>
    fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("stage failed:"))
      .map((line) => `logged: ${short(line.trim())}`),
  );
}

function commandParity(pkg, registered) {
  const declared = new Set([].concat(pkg.contributes?.commands ?? []).map((c) => c.command));
  const problems = [];
  for (const id of declared) {
    if (!registered.has(id)) problems.push(`package.json contributes the command ${id}, but the bundle registered no handler for it`);
  }
  for (const id of registered) {
    if (declared.has(id) || INTERNAL_COMMANDS.has(id)) continue;
    problems.push(
      `the bundle registered the command ${id}, which package.json does not contribute (add it to contributes.commands, or to INTERNAL_COMMANDS in scripts/smoke-dist.mjs when it is internal on purpose)`,
    );
  }
  for (const id of INTERNAL_COMMANDS.keys()) {
    if (declared.has(id)) problems.push(`${id} is in INTERNAL_COMMANDS but package.json contributes it; drop it from INTERNAL_COMMANDS`);
    else if (!registered.has(id)) problems.push(`${id} is in INTERNAL_COMMANDS but the bundle no longer registers it; drop it from INTERNAL_COMMANDS`);
  }
  return problems;
}

const tally = (items) =>
  [...items.reduce((m, item) => m.set(item, (m.get(item) ?? 0) + 1), new Map())].map(([item, n]) => `${item} x${n}`).join(", ") || "none";
const ghEscape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function report({ failures, rec, ticks, home }) {
  console.log(`smoke: ${ticks}, ${rec.registeredCommands.size} commands registered`);
  console.log(`smoke: stubbed child processes: ${tally(rec.spawned.map((file) => path.basename(String(file))))}`);
  console.log(`smoke: refused fetches: ${tally(rec.fetched.map((url) => (URL.canParse(url) ? new URL(url).host : url)))}`);
  if (rec.messages.length) console.log(`smoke: notifications shown: ${rec.messages.join(" | ")}`);
  if (!failures.length) {
    console.log("smoke: PASS");
    return;
  }
  for (const file of textFiles(home).filter((f) => f.endsWith(".log"))) {
    console.error(`smoke: last lines of ${path.relative(home, file)}:`);
    console.error(fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-30).join("\n"));
  }
  console.error(`smoke: FAIL (${failures.length})`);
  for (const failure of failures) {
    console.error(`  - ${failure}`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Bundle smoke test::${ghEscape(failure)}`);
  }
}

async function run(pkg, home) {
  const rec = { registeredCommands: new Set(), liveCommands: new Map(), webviewViews: new Map(), messages: [], spawned: [], fetched: [], errors: [] };
  const missing = new Set();
  const failures = [];
  catchProcessErrors(rec.errors);
  const baseline = resourceCounts();
  const timers = trackTimers();
  refuseNetwork(rec.fetched);
  const vscode = fakeVscode({ pkg, rec, missing, workspaceDir: path.join(home, "workspace") });
  hookModuleLoad({ vscode, child_process: childProcessStub(rec, missing) });
  const ctx = extensionContext({ root: ROOT, home, pkg, missing });
  const pollMs = Math.max(500, vscode.workspace.getConfiguration("claudeSessionMonitor").get("pollIntervalMs", 1500));

  const ext = await attempt(failures, "loading the bundle", () => createRequire(import.meta.url)(BUNDLE));
  const activated = ext.ok && (await attempt(failures, "activate()", () => ext.value.activate(ctx))).ok;
  const ticks = activated ? await runTicks(failures, rec, missing, pollMs) : "activation failed, no refresh ticks";
  if (ext.ok) await attempt(failures, "deactivate()", () => ext.value.deactivate?.());
  disposeAll(failures, ctx.subscriptions);
  const leftover = await settle(baseline, timers);

  failures.push(...rec.errors, ...stageFailures(home));
  if (missing.size) failures.push(`the bundle read vscode members the fake lacks (add them to scripts/smoke-dist-fakes.mjs): ${[...missing].join(", ")}`);
  if (leftover.extra.length) failures.push(`process resources above the baseline after dispose: ${leftover.extra.join(", ")}`);
  for (const timer of leftover.timers) failures.push(`timer still pending after dispose: ${timer}`);
  failures.push(...commandParity(pkg, rec.registeredCommands));
  report({ failures, rec, ticks, home });
  return failures.length ? 1 : 0;
}

async function main() {
  if (!fs.existsSync(BUNDLE)) {
    console.error(`smoke: ${path.relative(ROOT, BUNDLE)} is missing; run npm run build first`);
    return 1;
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const home = isolateHome();
  // Printing opens stdout and stderr, so their handles are part of the baseline.
  console.log(`smoke: loading ${path.relative(ROOT, BUNDLE)} with HOME=${home}`);
  console.error(`smoke: node ${process.version}`);
  try {
    return await run(pkg, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`smoke: harness error: ${describe(error)}`);
    process.exit(2);
  },
);
