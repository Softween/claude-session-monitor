/**
 * continuity.ts — this window's end of the continuity channel
 * (claudeSessionMonitor.continuityChannel, off by default).
 *
 * After a window restart a restored Claude Code tab gets its `claude` process only
 * once it is shown. The continuity daemon (launchd, in ~/.claude) decides which of
 * those dormant tabs are owed a resume, in which order and when, and writes requests
 * to ~/.claude/state/continuity/requests.json, each addressed to the workspace-storage
 * directory of the window holding the tab. ContinuityServer keeps this window's
 * requests in its own queue (read from the refresh cycle, never stored), makes the
 * session's existing tab active (the Claude Code tab whose label is the request's
 * title; a tab is never created), waits for the process, puts the tabs and focus
 * back, and reports in ext/<key>.json: a heartbeat every 15 s with the gate that
 * would hold the next show back, and the newest 50 results. At most two tries per
 * request; a request goes before a limit-stopped tab wake (wakeTabs.ts) and the two
 * never show tabs at the same time. Every show and every restore passes the automation
 * gate (automationGate.ts: tab automation, memory, the spawn budget shared with the
 * tab wakes), and turning the setting or tab automation off cancels a show's wait and
 * restore. Nothing is typed or sent into a session.
 *
 * No `vscode` import: extension.ts injects the editor side (ServerDeps).
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FIRST_SWEEP_MS, IDLE_MIN_MS, MIN_GAP_MS, POLL_MS, WAIT_LIVE_MS, type LiveSession } from "./wakeTabs";
import type { Hold, WakeGate } from "./automationGate";

export const CHANNEL_VERSION = 1;
export const REQUESTS_FILE = "requests.json";
const MAX_TRIES = 2; // per request id
const MAX_SERVED = 50; // results kept in the heartbeat
const MAX_DETAIL = 200; // characters of an error
const POLL_EVERY_MS = 10_000; // requests.json
const BEAT_EVERY_MS = 15_000;
const TYPING_MS = 2_000; // focused window and input this fresh: the user is typing, the tabs stay
const UNTITLED = "Claude Code"; // the tab label of a session without a title
const AMBIGUOUS = "ambiguous title";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESULTS: readonly string[] = ["opened", "no-process", "no-tab", "failed"];

/** A request this window may serve: show session `sid`'s tab, the Claude Code tab labelled `title`. */
export interface OpenRequest {
  id: string;
  sid: string;
  title: string;
}

/** opened: the session's process runs; no-process: none after the try, a second one follows; no-tab, failed: final. */
export type ServeResult = "opened" | "no-process" | "no-tab" | "failed";

export interface Served {
  sid: string;
  result: ServeResult;
  detail: string; // "already live", "ambiguous title", "tab already active", "no process", an error, or ""
  ts: number; // epoch seconds
}

/** Why the next show would wait right now: the user, or the automation gate (off: tab automation or the setting). */
export type Gate = "ok" | "user-active" | Hold["kind"];

/** The content of ext/<key>.json. */
export interface Heartbeat {
  v: number;
  storage: string;
  version: string;
  pid: number;
  ts: number;
  enabled: true;
  gate: Gate;
  served: Record<string, Served>;
}

/** A tab of this window; G and T are the editor's tab group and tab. */
export interface TabRef<G, T> {
  group: G;
  tab: T;
  label: string;
  claude: boolean; // a Claude Code panel (webview view type claudeVSCodePanel)
  active: boolean; // its group's active tab
}

export type TabPlan<G, T> =
  | { kind: "none"; detail: string } // no Claude Code tab carries the title ("untitled": not exactly one carries the default label)
  | { kind: "active"; ambiguous: boolean } // each one is already its group's active tab
  | { kind: "reveal"; ref: TabRef<G, T>; ambiguous: boolean };

/** Taken before a show: what to put back afterwards. */
export interface RevealMemo<G, T> {
  activeGroup: G; // the active group
  group: G; // the shown tab's group
  groupTab: T | undefined; // that group's active tab
  tab: T; // the shown tab
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const epochSec = (ms: number): number => Math.floor(ms / 1000);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The channel's folder, ~/.claude/state/continuity. */
export function continuityDir(home: string = os.homedir()): string {
  return path.join(home, ".claude", "state", "continuity");
}

/** This window's workspace-storage directory: the parent of the extension's storageUri; undefined without one (no folder open). */
export function storageDir(storagePath: string | undefined): string | undefined {
  return storagePath ? path.dirname(storagePath) : undefined;
}

/** The heartbeat file's name: the first 16 hex characters of sha256(storage directory). */
export function storageKey(storage: string): string {
  return crypto.createHash("sha256").update(storage).digest("hex").slice(0, 16);
}

/** This window's key in the continuity heartbeat, the debug log and the health file: storageKey, or `empty-<pid>` without a storage directory. */
export function windowKey(storage: string | undefined, pid: number): string {
  return storage === undefined ? `empty-${pid}` : storageKey(storage);
}

/** The requests of requests.json this window may serve now, in the daemon's order. */
export function servable(raw: unknown, storage: string, nowMs: number, served: ReadonlyMap<string, Served>): OpenRequest[] {
  if (!isRecord(raw) || raw.v !== CHANNEL_VERSION || !Array.isArray(raw.requests)) return [];
  const out: OpenRequest[] = [];
  for (const r of raw.requests) {
    if (!isRecord(r) || r.action !== "open" || r.storage !== storage) continue;
    if (typeof r.id !== "string" || r.id === "" || typeof r.sid !== "string" || !UUID.test(r.sid)) continue;
    if (typeof r.title !== "string" || r.title === "") continue;
    if (typeof r.expires !== "number" || r.expires * 1000 <= nowMs) continue;
    const prev = served.get(r.id);
    if (prev && prev.result !== "no-process") continue; // answered for good
    out.push({ id: r.id, sid: r.sid, title: r.title });
  }
  return out;
}

/** The try a request is on: the second after a no-process result. */
export function tryOf(prev: Served | undefined): number {
  return prev?.result === "no-process" ? 2 : 1;
}

/** Why the next show would wait: the user, only while this window is focused and input is not idle (unreadable idle: focus alone), else what the automation gate holds. */
export function gateOf(focused: boolean, idleMs: number | undefined, held: Hold["kind"] | undefined): Gate {
  if (focused && !(idleMs !== undefined && idleMs >= IDLE_MIN_MS)) return "user-active";
  return held ?? "ok";
}

/**
 * The Claude Code tab to show for `title` on try `attempt`: equal label, tab order,
 * active ones skipped, one per try when several match. The default label of untitled
 * sessions counts only when exactly one tab carries it.
 */
export function pickTab<G, T>(tabs: ReadonlyArray<TabRef<G, T>>, title: string, attempt: number): TabPlan<G, T> {
  const matching = tabs.filter((t) => t.claude && t.label === title);
  if (title === UNTITLED && matching.length !== 1) return { kind: "none", detail: "untitled" };
  if (!matching.length) return { kind: "none", detail: "" };
  const ambiguous = matching.length > 1;
  const hidden = matching.filter((t) => !t.active);
  if (!hidden.length) return { kind: "active", ambiguous };
  return { kind: "reveal", ref: hidden[(attempt - 1) % hidden.length], ambiguous };
}

/** After the wait: the tab to put back in the shown tab's group and the group to focus; undefined when the user changed the active tab or group in between. */
export function restoreAfter<G, T>(m: RevealMemo<G, T>, activeGroup: G, groupTab: T | undefined): { tab: T | undefined; group: G } | undefined {
  if (activeGroup !== m.group || groupTab !== m.tab) return undefined;
  return { tab: m.groupTab, group: m.activeGroup };
}

/**
 * Focus `group` with the focus…EditorGroup command of its screen slot (viewColumn - 1:
 * those commands count groups as laid out on screen, while tabGroups.all is in creation
 * order) and confirm it became the active group; throws otherwise.
 */
export async function focusBySlot<G extends { viewColumn: number }>(
  group: G,
  commands: readonly string[],
  run: (command: string) => PromiseLike<unknown>,
  activeGroup: () => G,
): Promise<void> {
  const slot = group.viewColumn - 1;
  if (!(slot >= 0 && slot < commands.length)) throw new Error(`editor group ${group.viewColumn} cannot be focused`);
  await run(commands[slot]);
  if (activeGroup() !== group) throw new Error(`editor group ${group.viewColumn} did not become active`);
}

/** `served` with `id`'s entry as the newest; the oldest beyond 50 are dropped. */
export function withServed(served: ReadonlyMap<string, Served>, id: string, entry: Served): Map<string, Served> {
  const rest = [...served].filter(([k]) => k !== id);
  return new Map([...rest, [id, entry] as const].slice(-MAX_SERVED));
}

function isServed(v: unknown): v is Served {
  return isRecord(v) && typeof v.sid === "string" && RESULTS.includes(String(v.result)) && typeof v.detail === "string" && typeof v.ts === "number";
}

/** The results of a heartbeat this window wrote before (a window reload keeps them), oldest first. */
export function servedFrom(raw: unknown, storage: string): Map<string, Served> {
  if (!isRecord(raw) || raw.v !== CHANNEL_VERSION || raw.storage !== storage || !isRecord(raw.served)) return new Map();
  const entries = Object.entries(raw.served).filter((e): e is [string, Served] => isServed(e[1]));
  return new Map(entries.sort((a, b) => a[1].ts - b[1].ts).slice(-MAX_SERVED));
}

export function heartbeat(storage: string, version: string, pid: number, ts: number, gate: Gate, served: ReadonlyMap<string, Served>): Heartbeat {
  return { v: CHANNEL_VERSION, storage, version, pid, ts, enabled: true, gate, served: Object.fromEntries(served) };
}

/** No process after try `attempt`: another try follows, after the last one the request failed. */
function noProcess(attempt: number, detail: string): { result: ServeResult; detail: string } {
  return attempt < MAX_TRIES ? { result: "no-process", detail } : { result: "failed", detail: detail || "no process" };
}

/** A small file's text; undefined when it is missing or unreadable. */
export function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/** Atomic 0600 write: a unique temp file in the same folder (created 0700 when missing), then a rename. */
export function writeTextAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    throw e;
  }
}

/** What the server needs from the editor and the machine; G and T are the editor's tab group and tab. */
export interface ServerDeps<G, T> {
  enabled(): boolean; // the setting: off = nothing is read or written
  storage: string | undefined; // this window's workspace-storage directory; undefined without a folder
  version: string; // this extension's version
  pid: number; // this extension host
  dir: string; // continuityDir()
  now(): number; // epoch ms
  log(msg: string): void;
  read(file: string): string | undefined;
  write(file: string, text: string): void;
  liveSessions(): LiveSession[];
  windowFocused(): boolean;
  idleMs(): Promise<number | undefined>; // undefined: unreadable
  othersBusy(): boolean; // a limit-stopped tab wake (wakeTabs.ts) is running
  tabs(): Array<TabRef<G, T>>; // this window's tabs in tab order
  activeGroup(): G;
  activeTabOf(group: G): T | undefined;
  reveal(group: G, tab: T): Promise<void>; // make `tab` its group's active tab and focus the group
  focusGroup(group: G): Promise<void>;
  gate: WakeGate; // automationGate.ts, consulted right before a show and its restore
}

export class ContinuityServer<G, T> {
  private results = new Map<string, Served>();
  private queue: OpenRequest[] = [];
  private gate: Gate | undefined; // unknown until the first gate check
  private lastPollMs = -Infinity;
  private lastBeatMs = -Infinity;
  private lastStepMs = -Infinity;
  private begun = false;
  private running = false;
  private gating = false;
  private disposed = false;
  private writeError: string | undefined;
  private readonly firstStepAt: number; // like TabWaker's first pass: nothing is shown while the window starts

  constructor(private readonly deps: ServerDeps<G, T>) {
    this.firstStepAt = deps.now() + FIRST_SWEEP_MS;
  }

  /** Refresh cycle: a heartbeat every 15 s, requests.json every 10 s, one step at most every 10 s (the first 60 s after activation) while no tab wake runs. */
  observe(): void {
    if (!this.on()) return;
    const now = this.deps.now();
    if (!this.gating && now - this.lastBeatMs >= BEAT_EVERY_MS) {
      this.gating = true;
      void this.beat().then(
        () => {
          this.gating = false;
        },
        () => {
          this.gating = false;
        },
      );
    }
    if (now - this.lastPollMs >= POLL_EVERY_MS) this.poll();
    if (this.running || !this.queue.length || this.deps.othersBusy() || now < this.firstStepAt || now - this.lastStepMs < MIN_GAP_MS) return;
    void this.run();
  }

  /** A request is being served or waits: a limit-stopped tab wake lets it go first. */
  pending(): boolean {
    return this.running || (this.queue.length > 0 && this.on());
  }

  dispose(): void {
    this.disposed = true;
  }

  /** The setting is on and this window has a storage directory; the first time on, the last heartbeat's results come back. */
  private on(): boolean {
    if (this.disposed || !this.deps.enabled()) return false;
    if (!this.begun) this.begin();
    return this.deps.storage !== undefined;
  }

  private heartbeatFile(storage: string): string {
    return path.join(this.deps.dir, "ext", `${windowKey(storage, this.deps.pid)}.json`);
  }

  private begin(): void {
    this.begun = true;
    const storage = this.deps.storage;
    if (storage === undefined) {
      this.deps.log("continuity: channel off in this window (no folder open)");
      return;
    }
    this.results = servedFrom(parseJson(this.deps.read(this.heartbeatFile(storage))), storage);
    this.deps.log(`continuity: channel on key=${windowKey(storage, this.deps.pid)} pid=${this.deps.pid} served=${this.results.size}`);
  }

  /** This window's servable requests become the queue; a missing or unparsable file has none. */
  private poll(): void {
    this.lastPollMs = this.deps.now();
    const storage = this.deps.storage;
    if (storage === undefined) return;
    this.queue = servable(parseJson(this.deps.read(path.join(this.deps.dir, REQUESTS_FILE))), storage, this.lastPollMs, this.results);
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      await this.serve();
    } catch (e) {
      this.deps.log(`continuity: step failed: ${errText(e)}`);
    } finally {
      this.running = false;
      this.lastStepMs = this.deps.now(); // the next step 10 s after this one ends, once its tab restore has landed
    }
  }

  /** One step: answer the requests that need no tab shown, then one try for the first that does. */
  private async serve(): Promise<void> {
    this.poll();
    for (;;) {
      const req = this.queue[0];
      if (!req || !this.on()) return;
      const live = this.deps.liveSessions().find((s) => s.sessionId === req.sid);
      if (live) {
        this.record(req, { result: "opened", detail: "already live" }, ` pid=${live.pid}`);
        continue;
      }
      const attempt = tryOf(this.results.get(req.id));
      const plan = pickTab(this.deps.tabs(), req.title, attempt);
      if (plan.kind === "none") {
        this.record(req, { result: "no-tab", detail: plan.detail }, ""); // the tab was closed: nothing is opened
        continue;
      }
      if (plan.kind === "active") this.record(req, noProcess(attempt, plan.ambiguous ? AMBIGUOUS : "tab already active"), `, try ${attempt}/${MAX_TRIES}`);
      else await this.show(req, attempt);
      return;
    }
  }

  /** Try `attempt` of `req`: the gate, then make its tab active, wait for the process and put the tabs back. */
  private async show(req: OpenRequest, attempt: number): Promise<void> {
    if ((await this.beat(true)) !== "ok" || !(await this.userAway())) return; // postponed: the heartbeat names the gate
    const plan = pickTab(this.deps.tabs(), req.title, attempt); // the tabs may have changed meanwhile
    if (plan.kind !== "reveal" || !this.on()) return;
    const { group, tab } = plan.ref;
    const memo: RevealMemo<G, T> = { activeGroup: this.deps.activeGroup(), group, groupTab: this.deps.activeTabOf(group), tab };
    const signal = this.deps.gate.signal();
    const started = this.deps.now();
    this.deps.gate.spend();
    let error: string | undefined;
    try {
      await this.deps.reveal(group, tab);
    } catch (e) {
      error = errText(e);
    }
    const pid = error === undefined ? await this.waitLive(req.sid, started, signal) : undefined;
    if (signal.aborted && pid === undefined) {
      // No try used: the request is served again once the setting and tab automation are back on.
      this.deps.log(`continuity: ${req.sid.slice(0, 8)} cancelled (${errText(signal.reason)}), tabs left as they are, request ${req.id}`);
      return;
    }
    if (error === undefined) await this.restore(memo, signal); // after a failed show nothing else changes
    const note = ` after ${((this.deps.now() - started) / 1000).toFixed(1)}s${pid === undefined ? "" : ` pid=${pid}`}, try ${attempt}/${MAX_TRIES}`;
    const ambiguous = plan.ambiguous ? AMBIGUOUS : "";
    if (pid !== undefined) this.record(req, { result: "opened", detail: ambiguous }, note);
    else if (error !== undefined) this.record(req, { result: "failed", detail: error.slice(0, MAX_DETAIL) }, note);
    else this.record(req, noProcess(attempt, ambiguous), note);
  }

  private async waitLive(sid: string, since: number, signal: AbortSignal): Promise<number | undefined> {
    for (;;) {
      const hit = this.deps.liveSessions().find((s) => s.sessionId === sid);
      if (hit) return hit.pid;
      if (signal.aborted || this.deps.now() - since >= WAIT_LIVE_MS) return undefined;
      await sleep(POLL_MS);
    }
  }

  /** Right before a show: the window may have got focus; input not idle for 20 s is user-active (logged, in the heartbeat), no try used. */
  private async userAway(): Promise<boolean> {
    if (!this.deps.windowFocused()) return true;
    if (gateOf(true, await this.deps.idleMs(), undefined) === "ok") return true;
    this.setGate("user-active");
    return false;
  }

  /**
   * Put the shown tab's group back on its former tab and refocus the former group, unless the user moved meanwhile
   * or types in this window, the show was cancelled, or the gate holds right now (tab automation, the setting, memory).
   */
  private async restore(memo: RevealMemo<G, T>, signal: AbortSignal): Promise<void> {
    if (this.deps.windowFocused()) {
      const idle = await this.deps.idleMs();
      if (idle !== undefined && idle < TYPING_MS) {
        this.deps.log("continuity: tab restore skipped, the user is typing");
        return;
      }
    }
    const held = signal.aborted ? errText(signal.reason) : (await this.deps.gate.beforeRestore())?.reason;
    if (held !== undefined) {
      this.deps.log(`continuity: tab restore skipped (${held})`);
      return;
    }
    const back = restoreAfter(memo, this.deps.activeGroup(), this.deps.activeTabOf(memo.group));
    if (!back) return;
    try {
      if (back.tab !== undefined) await this.deps.reveal(memo.group, back.tab);
      if (back.group !== memo.group) await this.deps.focusGroup(back.group);
    } catch (e) {
      this.deps.log(`continuity: tab restore failed: ${errText(e)}`);
    }
  }

  /** The gate right now, then the heartbeat; `attempt`: a show follows, so a memory or budget hold backs the next try off. */
  private async beat(attempt = false): Promise<Gate> {
    const focused = this.deps.windowFocused();
    const idle = focused ? await this.deps.idleMs() : undefined;
    const held = attempt ? await this.deps.gate.admit() : await this.deps.gate.hold();
    const gate = gateOf(focused, idle, held?.kind);
    this.setGate(gate);
    return gate;
  }

  /** A gate change is logged; the heartbeat is written either way. */
  private setGate(gate: Gate): void {
    if (!this.on()) return;
    if (gate !== this.gate) this.deps.log(`continuity: gate ${gate}${this.gate ? ` (was ${this.gate})` : ""}`);
    this.gate = gate;
    this.write();
  }

  /** One result for `req`: kept (newest 50), logged, written at once (before the first gate check, with it). */
  private record(req: OpenRequest, r: { result: ServeResult; detail: string }, note: string): void {
    this.results = withServed(this.results, req.id, { sid: req.sid, ...r, ts: epochSec(this.deps.now()) });
    if (r.result !== "no-process") this.queue = this.queue.filter((q) => q.id !== req.id);
    this.deps.log(`continuity: ${req.sid.slice(0, 8)} ${r.result}${r.detail ? ` (${r.detail})` : ""}${note}, request ${req.id}`);
    this.write();
  }

  private write(): void {
    const storage = this.deps.storage;
    if (storage === undefined || this.gate === undefined || !this.on()) return;
    this.lastBeatMs = this.deps.now();
    const hb = heartbeat(storage, this.deps.version, this.deps.pid, epochSec(this.lastBeatMs), this.gate, this.results);
    try {
      this.deps.write(this.heartbeatFile(storage), JSON.stringify(hb));
      this.writeError = undefined;
    } catch (e) {
      const msg = errText(e);
      if (msg !== this.writeError) this.deps.log(`continuity: heartbeat not written: ${msg}`);
      this.writeError = msg;
    }
  }
}
