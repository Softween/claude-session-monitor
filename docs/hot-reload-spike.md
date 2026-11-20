# Hot reload spike: swapping the runtime inside a running extension host

Status: spike; the prototype is not committed.

## Verdict

**Go, on one condition: the loader keeps each runtime bundle out of V8's compilation cache.**

In an isolated VS Code 1.147.0 instance (Electron 43.8.9, Node 24.22.1, V8 15.0) the loader swapped
the runtime 41 times and rolled back one failed swap without restarting the extension host: v1 to
v2, v2 to v3 (which throws in `activate`) with an automatic rollback to v2, then 40 consecutive
swaps. The extension host pid stayed 14563 in `process.pid` and in `exthost.log`, which has a single
`Extension host with pid 14563 started` line for the whole run. After every swap the registered
command answered with the new runtime's version and the webview round trip was answered by the page
the new runtime rendered (1 to 13 ms). Every unloaded runtime was garbage-collected, and none of its
timers, watchers or listeners fired after it was unloaded.

| Pass bar | Result |
| --- | --- |
| Extension host pid unchanged | yes: 14563 from the first reading to the last, in `process.pid` and in `exthost.log` |
| Command and webview round trip work after each swap | yes: 45 of 45 readings |
| v3 throws in `activate`, automatic rollback to v2 | yes: 60.2 ms for the failed swap and the rollback together |
| heapUsed after swap 20 within 10% of swap 1, loader as specified | **no**: 52.38 to 85.14 MB (+62.5%, about 1.72 MB per swap) |
| The same with the compilation cache bypass | yes: 45.95 to 46.04 MB (+0.2%) |

The growth in the loader as specified is not a leaked runtime: V8's in-memory compilation cache
keeps the script of every bundle loaded. A last-resort GC, which also clears that cache, brought the
heap from 85.14 back to 45.95 MB. Loading the bundle with the cache switched off for the duration of
the `require` (`v8.setFlagsFromString("--no-compilation-cache")`, then `--compilation-cache`) kept
the next 20 swaps flat. Without one of the two, a 250 KB bundle costs about 1.7 MB of extension host
heap per swap that ordinary GCs do not reclaim.

## Question

Every release takes effect only after an extension-host restart or a window reload, and either one
stops every Claude Code session in the window: each `claude` process is a child of the extension
host. Most releases change runtime code only, not `package.json` contributions. Can the runtime be
swapped inside the running extension host, behind a loader that never changes?

## Prototype

Built and run outside the repository; described here so it can be rebuilt (see "Reproduce").

- **Loader extension.** Owns every `package.json` contribution: an activity bar container with two
  webview views, two commands and a custom editor that stands in for the restart guard. It registers
  the webview view provider and the custom editor provider once, at activation, and loads
  `runtime.js`. It never unloads itself.
- **Runtime bundle.** esbuild, CommonJS, minified, about 256 KB (the real `dist/extension.js` is
  about 248 KB), with 60,000 objects of module-level state standing in for caches (one loaded
  runtime is about 11 MB of heap). `vscode` is aliased to a shim that exports the API object the
  loader injects for this runtime generation, so the bundle contains no `require("vscode")` (the
  build fails if it does).
- **Injected API.** A fresh facade per runtime generation over the loader's own `vscode` namespaces
  (`commands`, `window`, `window.tabGroups`, `workspace`, ...). Every call that returns a disposable
  (commands, providers, event listeners, status bar items) is recorded in the generation's tracker;
  `createTerminal` is exempt because terminals outlive a runtime. Classes, enums and getters pass
  through. The runtime's `ExtensionContext` is a facade too: its own `subscriptions` array, the
  loader's `globalState`, `workspaceState` and `secrets` (wrapped so that `onDidChange` listeners
  are tracked).
- **Backstops for Node resources.** esbuild `inject` replaces the timer globals inside the bundle
  with versions that record every timer, and `fs` is aliased to a wrapper that records every
  `fs.watch` watcher. Unloading a generation clears both, even when the runtime never registered a
  cleanup.
- **View host.** The loader keeps the resolved `WebviewView`, owns its `onDidReceiveMessage`
  subscription and forwards messages to the current runtime. Each runtime gets a handle
  (`setHtml`, `postMessage`, `onMessage`, `onResolve`) that goes inert once another generation owns
  the view, so a late callback from an unloaded runtime cannot post or receive.
- **Swap.** Call the old runtime's `deactivate`, dispose its `subscriptions` and its tracker, drop
  its `require.cache` entries and its entry in the loader's `module.children`, then `require` and
  `activate` the new bundle. If loading or `activate` throws: dispose what the new bundle
  registered, then `require` and `activate` the previous file again.

The runtime uses, through the loader: a registered command (`hrs.hello` returns its version), the
webview view (a ping/pong round trip with the page the runtime rendered), `window.tabGroups` (tab
count, `onDidChangeTabs`), `context.secrets` (reads what the previous runtime stored, stores its
own), `context.globalState` (an activation counter), a 200 ms `setInterval` and an `fs.watch` on a
scratch directory. A runtime-owned webview view provider (`hrs.ctrlView`) is the control case.

## Measurement

Isolated instance: the installed VS Code 1.147.0 (Electron 43.8.9, Node 24.22.1, V8 15.0.245),
started with its own user data and extensions directories from a cleared environment, with the
loader as `--extensionDevelopmentPath` and the measurement as `--extensionTestsPath`, so the
measurement ran inside the extension host it measured. One launch, 128 s (see "Reproduce").

Sequence: open the views, open a `.hrsguard` file with the custom editor, spawn `/bin/sleep` from
the extension host as a stand-in for a `claude` session, wait 8 s, then: start (v1, embedded in the
loader folder); A: v1 to v2; B: v2 to v3 (throws); series 1 to 20 (each a separate build, staged
alternately outside and inside the extension folder); a last-resort GC; series 21 to 40 with the
compilation cache bypass on; a last-resort GC.

After every step: write a file into the watched directory, open and close a text tab, store a
secret, wait 1.5 s; run `hrs.hello` (command ok: it returned the version just activated) and
`hrs.ping` (webview ok: the page answered with that version); force four full GCs and read
`process.memoryUsage().heapUsed`; check the `WeakRef` to each unloaded runtime's module state;
compare the counters of unloaded runtimes before and after the events.

| # | step | staged | active | pid | exthost.log pid | heapUsed MB | command ok | webview ok | round trip ms | unloaded runtimes alive | stale events |
| ---: | --- | --- | --- | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| 0 | start v1 (embedded) | inside | v1#1 | 14563 | 14563 | 46.84 | yes | yes | 5 | 0 | 0 |
| 1 | A v1->v2 | outside | v2#2 | 14563 | 14563 | 48.62 | yes | yes | 1 | 0 | 0 |
| 2 | B v2->v3 (activate threw, rolled back to v2) | outside | v2#4 | 14563 | 14563 | 50.43 | yes | yes | 2 | 0 | 0 |
| 3 | series 1 | outside | s01#5 | 14563 | 14563 | 52.38 | yes | yes | 4 | 0 | 0 |
| 4 | series 2 | inside | s02#6 | 14563 | 14563 | 54.12 | yes | yes | 1 | 0 | 0 |
| 5 | series 3 | outside | s03#7 | 14563 | 14563 | 55.86 | yes | yes | 3 | 0 | 0 |
| 6 | series 4 | inside | s04#8 | 14563 | 14563 | 57.60 | yes | yes | 3 | 0 | 0 |
| 7 | series 5 | outside | s05#9 | 14563 | 14563 | 59.36 | yes | yes | 1 | 0 | 0 |
| 8 | series 6 | inside | s06#10 | 14563 | 14563 | 61.12 | yes | yes | 3 | 0 | 0 |
| 9 | series 7 | outside | s07#11 | 14563 | 14563 | 62.85 | yes | yes | 2 | 0 | 0 |
| 10 | series 8 | inside | s08#12 | 14563 | 14563 | 64.56 | yes | yes | 3 | 0 | 0 |
| 11 | series 9 | outside | s09#13 | 14563 | 14563 | 66.30 | yes | yes | 1 | 0 | 0 |
| 12 | series 10 | inside | s10#14 | 14563 | 14563 | 68.01 | yes | yes | 2 | 0 | 0 |
| 13 | series 11 | outside | s11#15 | 14563 | 14563 | 69.72 | yes | yes | 13 | 0 | 0 |
| 14 | series 12 | inside | s12#16 | 14563 | 14563 | 71.45 | yes | yes | 3 | 0 | 0 |
| 15 | series 13 | outside | s13#17 | 14563 | 14563 | 73.17 | yes | yes | 3 | 0 | 0 |
| 16 | series 14 | inside | s14#18 | 14563 | 14563 | 74.88 | yes | yes | 3 | 0 | 0 |
| 17 | series 15 | outside | s15#19 | 14563 | 14563 | 76.59 | yes | yes | 1 | 0 | 0 |
| 18 | series 16 | inside | s16#20 | 14563 | 14563 | 78.30 | yes | yes | 2 | 0 | 0 |
| 19 | series 17 | outside | s17#21 | 14563 | 14563 | 80.01 | yes | yes | 1 | 0 | 0 |
| 20 | series 18 | inside | s18#22 | 14563 | 14563 | 81.72 | yes | yes | 1 | 0 | 0 |
| 21 | series 19 | outside | s19#23 | 14563 | 14563 | 83.43 | yes | yes | 1 | 0 | 0 |
| 22 | series 20 | inside | s20#24 | 14563 | 14563 | 85.14 | yes | yes | 2 | 0 | 0 |
| 23 | after last-resort GC (20) | inside | s20#24 | 14563 | 14563 | 45.95 | yes | yes | 1 | 0 | 0 |
| 24 | series 21 | outside | s21#25 | 14563 | 14563 | 45.95 | yes | yes | 1 | 0 | 0 |
| 25 | series 22 | inside | s22#26 | 14563 | 14563 | 45.96 | yes | yes | 2 | 0 | 0 |
| 26 | series 23 | outside | s23#27 | 14563 | 14563 | 45.96 | yes | yes | 2 | 0 | 0 |
| 27 | series 24 | inside | s24#28 | 14563 | 14563 | 45.96 | yes | yes | 1 | 0 | 0 |
| 28 | series 25 | outside | s25#29 | 14563 | 14563 | 45.96 | yes | yes | 1 | 0 | 0 |
| 29 | series 26 | inside | s26#30 | 14563 | 14563 | 45.97 | yes | yes | 4 | 0 | 0 |
| 30 | series 27 | outside | s27#31 | 14563 | 14563 | 45.98 | yes | yes | 2 | 0 | 0 |
| 31 | series 28 | inside | s28#32 | 14563 | 14563 | 45.98 | yes | yes | 2 | 0 | 0 |
| 32 | series 29 | outside | s29#33 | 14563 | 14563 | 45.98 | yes | yes | 2 | 0 | 0 |
| 33 | series 30 | inside | s30#34 | 14563 | 14563 | 45.99 | yes | yes | 1 | 0 | 0 |
| 34 | series 31 | outside | s31#35 | 14563 | 14563 | 45.99 | yes | yes | 1 | 0 | 0 |
| 35 | series 32 | inside | s32#36 | 14563 | 14563 | 45.99 | yes | yes | 2 | 0 | 0 |
| 36 | series 33 | outside | s33#37 | 14563 | 14563 | 46.00 | yes | yes | 2 | 0 | 0 |
| 37 | series 34 | inside | s34#38 | 14563 | 14563 | 46.00 | yes | yes | 1 | 0 | 0 |
| 38 | series 35 | outside | s35#39 | 14563 | 14563 | 46.00 | yes | yes | 2 | 0 | 0 |
| 39 | series 36 | inside | s36#40 | 14563 | 14563 | 46.00 | yes | yes | 2 | 0 | 0 |
| 40 | series 37 | outside | s37#41 | 14563 | 14563 | 46.03 | yes | yes | 1 | 0 | 0 |
| 41 | series 38 | inside | s38#42 | 14563 | 14563 | 46.04 | yes | yes | 2 | 0 | 0 |
| 42 | series 39 | outside | s39#43 | 14563 | 14563 | 46.04 | yes | yes | 2 | 0 | 0 |
| 43 | series 40 | inside | s40#44 | 14563 | 14563 | 46.04 | yes | yes | 1 | 0 | 0 |
| 44 | after last-resort GC (40) | inside | s40#44 | 14563 | 14563 | 46.04 | yes | yes | 1 | 0 | 0 |

`pid` is `process.pid` read inside the extension host; `exthost.log pid` lists every
`Extension host with pid N started` line in the instance's `exthost.log` at that moment. `staged`:
where the bundle was loaded from (`inside`: under the loader's folder, `outside`: a sibling
directory). `unloaded runtimes alive`: unloaded runtimes whose module state survived the forced GCs.
`stale events`: timer ticks, fs events, tab events and secret change events that unloaded runtimes
received during the step.

Other readings:

- **Rollback.** v3 registered `hrs.hello`, started a 200 ms interval, an `fs.watch` and a
  `tabGroups.onDidChangeTabs` listener without registering any cleanup, then threw
  `v3: activation failed on purpose`. The loader disposed all four through its trackers, v2's
  `activate` registered `hrs.hello` again (it throws "command already exists" if the old one is
  still there), and nothing from v3 fired afterwards.
- **Disposal.** At every reading `process.getActiveResourcesInfo()` held one `Timeout` and one
  `FSEventWrap`: nothing accumulated across swaps. The current runtime's own counters moved at every
  reading, so the probes worked.
- **State through the loader.** Each runtime read the secret the previous one had stored; after the
  rollback v2 read its own value again. The `globalState` activation counter grew by one with each of
  the 43 activations that completed (v3 threw before reaching it), the rollback included.
- **Sessions.** The `/bin/sleep` child of the extension host (parent pid 14563) was alive after every
  step.
- **Restart guard stand-in.** The custom editor was resolved once; its panel and tab were still open
  after the last swap.
- **Runtime-owned webview provider (control).** `hrs.ctrlView` was resolved for v1, which was active
  when the view opened. For the 42 later runtimes that registered the same provider again (v3 threw
  before it), VS Code never called `resolveWebviewView` for the open view. The loader-owned view was
  resolved once and served every runtime.
- **Inside or outside the extension folder.** No difference: the 20 swaps from each location passed
  every check, with a median swap of 31.9 ms outside and 33.0 ms inside. A plain
  `require("vscode")` from a file inside the loader folder returned the loader's own API object;
  from a file outside it returned a different object, and
  `exthost.log` logged `Could not identify extension for 'vscode' require call from
  file:///.../probe-outside.js`. With the shim the location does not matter; a bundle that kept a
  direct `require("vscode")` would get an API bound to no extension when staged outside.
- **Swap time.** Deactivate, dispose, `require` and `activate`: median 33 ms (28 to 60 ms), not
  counting the page reload in the view.
- **Heap.** 46.84 MB before the first swap. Series 1 to 20: 52.38 to 85.14 MB. Last-resort GC:
  45.95 MB (63 ms). Series 21 to 40 with the bypass: 45.95 to 46.04 MB. Last-resort GC: 46.04 MB
  (43 ms). One loaded runtime is about 11.2 MB of heap (plain Node), so one leaked runtime per swap
  would show as steps of that size.

Plain Node 26 runs of the same bundles outside VS Code separate the two ways a runtime is kept:

| Loader variant, plain Node 26 | heapUsed |
| --- | --- |
| Drops the `require.cache` entry only | every runtime stays alive (20 of 20), about 11 MB per load |
| Also removes the runtime from the loader's `module.children` | about 1.15 MB per load (module evaluation only), 2.46 MB per swap with `activate` |
| Plus `--no-compilation-cache` around the `require` | flat: 14.4 to 14.6 MB over 40 loads; 15.85 to 15.95 MB over 20 swaps with `activate` |
| Plus a last-resort GC after each load instead | flat: 14.1 to 14.2 MB over 40 loads, 18 ms per GC |

Caveats:

- The `--disable-extension` flags for the built-in extensions had no effect: git, git-base, github,
  github-authentication, emmet, merge-conflict, debug-auto-launch, configuration-editing,
  json-language-features, typescript-language-features and the TypeScript chat features activated
  in the same extension host (`exthost.log`). The heap readings include them.
- `exthost.log` has one error from the measurement harness: its first `hrs.ping`, sent while the
  view was still loading, waited on a promise that the runtime replaced when the view resolved; the
  retry succeeded. The log also has one "webview without a content security policy" warning per
  swap (the spike's placeholder, control view and guard pages have no CSP); which page raised the
  per-swap warning was not traced.
- The instance did not stay in the background (see "Reproduce").

## What the loader must own in this extension

From `activate()` in `src/extension.ts` and the modules it starts:

| Part | Where | Swappable? |
| --- | --- | --- |
| Contributions and activation: `onStartupFinished`, the activity bar container, 2 webview views, 26 commands, 13 `view/title` and 1 command palette menu entries, 1 keybinding, 37 settings, the restart guard's custom editor | `package.json` | No. They belong to the installed extension; a release that adds or changes any of them needs a loader release and a VS Code start. A new command can still be registered and run by id; a new setting can be read with a default, without a schema. |
| Sessions and Usage limits views | `SessionsView`, `LimitsView` (`registerWebviewViewProvider`) | Provider registration: loader. Today each `resolveWebviewView` attaches an `onDidReceiveMessage` listener that is in no subscription list, so after a swap the old runtime's handlers would keep receiving the page's messages. The loader keeps the views, owns those listeners and replays the last payload when a runtime attaches. |
| Restart guard | `restartGuard.ts` (`registerCustomEditorProvider`, `GuardEditorProvider`) | Provider registration and the open guard editor: loader, so the veto holds during and after a swap. Its open/close logic can live in the runtime. |
| Commands | 24 in `activate()`, 2 in `registerRemoteBridge`, 1 in `activateRestartGuard` (27 registrations; `openSession` has no contribution) | Yes: registered through the injected API and disposed on swap. |
| Status bar item, event listeners (`onDidChangeConfiguration`, `onDidCloseTerminal`, `tabGroups.onDidChangeTabs`, `secrets.onDidChange`, `onDidChangeWindowState`) | `activate()`, `remoteBridge.ts`, `restartGuard.ts` | Yes: all are pushed to `ctx.subscriptions`. |
| Timers | `setInterval` poll, `throttle`/`debounce` timers, auto-resume and resume timers | Yes: each has a dispose entry in `ctx.subscriptions`. `TabWaker.dispose()` clears its timer. `ContinuityServer.dispose()` only sets a flag, so a pending step finishes after the swap. The restart guard's queued job (`untilPaused`, then `vscode.openWith`) is not cancelled by dispose. |
| fs watchers | `fs.watch` on the monitor dirs, the switch state dir and the projects dir (recursive) | Yes: each `close()` is in `ctx.subscriptions`. |
| Remote bridge | `remoteBridge.ts` long-poll loop | Yes: the bridge is in `ctx.subscriptions` and `dispose()` aborts the fetch. A remote command that is executing at swap time is not; the swap has to wait for it. |
| Child processes | Codex `app-server --stdio` (long-lived, a child of the extension host); detached `claude-switch` runs (`SwitchRunner`, never signalled); short `execFile` calls (`ps`, `security`, `osascript`, `sysctl`, `git` and others) | Codex client: its `dispose()` sends SIGTERM; the new runtime starts a new one. A running switch outlives the runtime, and the new runtime does not know it is busy. Short calls can call back into an unloaded runtime: every such callback needs a disposed check, or the swap waits for them. |
| Module-level state | `logCount`, `cachedCreds`, `identityCache`, `identityAt`, `claudeBinaryPath`/`claudeBinary`, `machineCache` (`remote.ts`), `resumeTerminals` (`ResumeRegistry`) | Caches are rebuilt by the new runtime. `resumeTerminals` maps resume terminals to sessions and is lost; the terminals keep running, so the mapping has to be handed over or rebuilt from `window.terminals`. |
| Version | `ctx.extension.packageJSON.version` (sent by the continuity heartbeat) | Behind a loader this is the loader's version; the runtime's version has to come from its own manifest. |

`deactivate()` is empty: cleanup today relies on VS Code disposing `ctx.subscriptions` when the
extension host stops. That list covers the registrations, timers and watchers above, but not the
webview message listeners, the guard's queued job, in-flight child process callbacks or the
continuity step in progress. The extension host exits right after, so none of that matters today;
in a swap all of it does.

## Risks for a production loader

Needed before the first live swap, most important first:

1. **Compilation cache.** Load each bundle with `--no-compilation-cache` set around the `require`,
   or run a last-resort GC after a swap. Both change V8 state in a host that every other extension
   shares, and Node documents changing V8 flags after startup as unsupported. Both worked here
   (Electron 43, V8 15.0); check again on every Electron major and keep the heap reading in the
   health check.
2. **Module bookkeeping.** `require()` also records the runtime in the loader's `module.children`;
   deleting the `require.cache` entry alone keeps every old runtime alive. Rollback `require`s the
   previous file again, so the previous bundle stays on disk until the new one has passed the
   health check.
3. **Views and the guard stay in the loader.** The two webview view providers and the restart
   guard's custom editor are registered by the loader, which forwards messages and replays the last
   payload when a runtime attaches. Pages need a token: in the plain Node dry run, the `ready`
   message of the page v3 had rendered reached v2 after v2 took over (the runtime now ignores pages
   of another version).
4. **What the trackers do not cover.** The facade tracks VS Code disposables and the bundle's
   timers and `fs.watch` watchers. It does not track child processes, sockets, `process.on`
   handlers, `setImmediate`, changes to globals or async work in flight. In this extension that is
   the Codex child process, `claude-switch` runs, `execFile` callbacks, remote commands being
   executed, the guard's queued job and a continuity step: swap only when no feature reports busy,
   and make late callbacks check a disposed flag.
5. **State that has to survive a swap.** The resume terminal mapping (`resumeTerminals`), a switch
   in progress and the last payload of each view: hand them over through the loader or rebuild them
   (`window.terminals` for the terminals).

Also needed:

- Contribution changes (commands, menus, settings, views, keybindings, activation events) still
  need a loader release and a VS Code start; the runtime has to work with an older `package.json`
  (commands registered without a contribution, settings read with a default).
- Stage runtimes in their own directory, not in the installed extension folder, which every update
  replaces; the location made no difference here. Load only a bundle whose checksum matches its
  manifest.
- Keep the bundle free of `require("vscode")` (a build check, as in the prototype).
- The runtime reports its own version; `ctx.extension.packageJSON.version` is the loader's.
- Not measured here: a runtime that uses child processes, sockets or the network across a swap;
  swaps in a host that also runs Claude Code and the other installed extensions; a webview with
  `retainContextWhenHidden`; more than 40 swaps in one host.

## Reproduce

The prototype is not committed. Rebuilding it takes these files in one scratch directory:

1. `src/runtime.mjs`: imports `vscode`, `fs` and a generated module of 6,000 small functions (code
   size close to the real bundle); exports `VERSION`, `probe` (plain counters), `ballastRef()`,
   `activate(context, host)` and `deactivate()`. A build-time flag makes one version register a
   command, a timer, a watcher and a tab listener without any cleanup and then throw in `activate`.
2. `src/shim-vscode.cjs` (`module.exports = globalThis[Symbol.for("hrs.inject")].api`),
   `src/shim-fs.cjs` (real `node:fs` with a tracked `watch`) and `src/inject-timers.mjs` (tracked
   `setTimeout`/`setInterval`/`clear*`).
3. A build script calling esbuild with `bundle`, `platform: "node"`, `format: "cjs"`, `minify`,
   `alias: { vscode: "./src/shim-vscode.cjs", fs: "./src/shim-fs.cjs" }`,
   `inject: ["./src/inject-timers.mjs"]` and `define` for the version; it writes `v1` into the
   loader (`loader/runtime/runtime.js`), `v2` and `v3` (throws) outside it, and `s01`..`s40`
   alternately outside and inside it (`loader/staged/<name>/runtime.js`), and fails if a bundle
   contains `require("vscode")`.
4. `loader/package.json` and `loader/loader.js` as described under "Prototype"; the loader returns
   `{ ready, swap, current, history, viewHost, guard, logUri, touchSecret, setBypassCompileCache }`
   from `activate`.
5. `loader/test/index.js` (the `--extensionTestsPath` module, inside the loader folder so that its
   own `require("vscode")` resolves to the loader's API) and `loader/test/driver.js`: open the view
   container, wait for the first round trip, open the guard file with the custom editor, spawn the
   stand-in child, then for every swap: write a file into the watched directory, open and close a
   text tab, store a secret, wait 1.5 s, run `hrs.hello` and `hrs.ping`, force four GCs
   (`require("v8").setFlagsFromString("--expose_gc"); const gc = require("vm").runInNewContext("gc");`)
   and record `process.memoryUsage()`, `process.getActiveResourcesInfo()`, the probes of every
   unloaded generation and the `WeakRef` to each unloaded generation's module state. Results go to a
   JSON file.
6. Launch, from a shell whose environment is cleared (`open` hands its own environment to the app,
   and a shell started from VS Code's extension host carries `ELECTRON_RUN_AS_NODE=1`, which
   makes the app run as plain Node and exit with `bad option: --user-data-dir`). The instance's
   `User/settings.json` turns off updates, telemetry, experiments, the startup editor, workspace
   trust, AI features and git:

   ```sh
   env -i HOME="$HOME" USER="$USER" PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR="$TMPDIR" \
     open -g -j -n -W -a "/Applications/Visual Studio Code.app" --args \
     --user-data-dir /tmp/hrs/ud --extensions-dir /tmp/hrs/ext --disable-extensions \
     --disable-extension vscode.git --disable-extension vscode.git-base \
     --disable-extension vscode.github --disable-extension vscode.merge-conflict \
     --disable-extension vscode.debug-auto-launch --disable-extension GitHub.copilot-chat \
     --disable-extension TypeScriptTeam.jsts-chat-features \
     --skip-welcome --skip-release-notes --disable-workspace-trust --disable-telemetry \
     --use-inmemory-secretstorage --use-mock-keychain \
     --extensionDevelopmentPath="$PWD/loader" --extensionTestsPath="$PWD/loader/test/index.js"
   ```

   `-g -j` asks for a hidden background launch, but it did not keep the instance in the
   background: it was the frontmost app from one second after launch until it quit (127 of 128
   one-second samples of `lsappinfo front`). Launch only after `ioreg -c IOHIDSystem` reports a
   HIDIdleTime of 2 minutes or more (205 s at this launch; no input arrived during the run), and
   keep it to one launch. The user data and extensions directories are short because macOS limits
   IPC socket paths to 103 characters. The `--disable-extension` flags name the built-ins that
   activate at startup; they had no effect in this version. The test run ends the instance;
   afterwards stop only processes whose command line contains `/tmp/hrs/ud`, then delete
   `/tmp/hrs`.
