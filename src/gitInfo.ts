/**
 * gitInfo.ts — the remote snapshot's per-session `git` field: branch and changed-file
 * count of the session's cwd (`git status`, cached 30 s) and, for a branch other than
 * main / master / develop, its pull request with the checks rollup (`gh pr view --json`,
 * cached 3 min, at most 10 gh calls a minute). get() never waits: it answers from the
 * cache and queues a refresh; one git or gh process runs at a time. Any failure caches
 * null (no repo or no git: git null; no gh, no PR or a gh error: pr null).
 */
import { execFile } from "child_process";

export interface FleetPr {
  number: number;
  state: "open" | "merged" | "closed";
  url: string;
  checks: "pass" | "fail" | "pending" | null;
}

export interface FleetGit {
  branch: string;
  dirty: number;
  pr: FleetPr | null;
}

export const GIT_TTL_MS = 30_000;
export const PR_TTL_MS = 180_000;
export const GH_MAX_PER_MIN = 10;
const CACHE_MAX = 500;
const DEFAULT_BRANCHES = new Set(["main", "master", "develop"]);
// No index.lock (a status never blocks a commit in the same repo), no prompts, no update checks.
const QUIET_ENV = { GIT_OPTIONAL_LOCKS: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/** stdout of `cmd args` run in `cwd`, or null on any failure or past `timeoutMs`. */
export type CwdRunner = (cmd: string, args: string[], cwd: string, timeoutMs: number) => Promise<string | null>;

export const runIn: CwdRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024, env: { ...process.env, ...QUIET_ENV } },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });

/** `git status --porcelain=v2 --branch` -> branch ("(detached)" on a detached HEAD) and changed paths; null without a branch header. */
export function parseGitStatus(out: string): { branch: string; dirty: number } | null {
  let branch: string | null = null;
  let dirty = 0;
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length).trim() || null;
    else if (line && !line.startsWith("#")) dirty++;
  }
  return branch ? { branch, dirty } : null;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "STALE"]);

/** gh's statusCheckRollup -> fail (any failed), pending (any not finished), pass, or null without checks. */
export function rollupChecks(rollup: unknown): FleetPr["checks"] {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  let pending = false;
  for (const raw of rollup) {
    const c = (raw ?? {}) as Record<string, unknown>;
    // A CheckRun answers with its conclusion once COMPLETED; a StatusContext with its state.
    const verdict = String((c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? c.conclusion : c.status) ?? "");
    if (FAILED.has(verdict.toUpperCase())) return "fail";
    if (!PASSED.has(verdict.toUpperCase())) pending = true;
  }
  return pending ? "pending" : "pass";
}

/** `gh pr view --json number,state,url,statusCheckRollup` -> FleetPr; null when it does not parse. */
export function parsePr(out: string): FleetPr | null {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(out) as Record<string, unknown>;
  } catch {
    return null;
  }
  const state = String(j?.state ?? "").toLowerCase();
  if (typeof j?.number !== "number" || typeof j.url !== "string" || !["open", "merged", "closed"].includes(state)) return null;
  return { number: j.number, state: state as FleetPr["state"], url: j.url, checks: rollupChecks(j.statusCheckRollup) };
}

interface Cached<T> {
  at: number;
  value: T;
}

function remember<T>(map: Map<string, Cached<T>>, key: string, entry: Cached<T>): void {
  map.delete(key); // re-insert, so the oldest entry is the first one dropped
  map.set(key, entry);
  while (map.size > CACHE_MAX) map.delete(map.keys().next().value as string);
}

export class GitInfo {
  private readonly status = new Map<string, Cached<{ branch: string; dirty: number } | null>>();
  private readonly prs = new Map<string, Cached<FleetPr | null>>();
  private readonly queued = new Set<string>();
  private readonly pending: string[] = [];
  private ghCalls: number[] = [];
  private draining = false;
  private drained: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: CwdRunner = runIn,
    private readonly now: () => number = Date.now,
  ) {}

  /** What the cache knows about `cwd` (null until git first answered); a stale entry queues a refresh. */
  get(cwd: string | null | undefined): FleetGit | null {
    if (!cwd) return null;
    const now = this.now();
    const st = this.status.get(cwd);
    if (!st || now - st.at >= GIT_TTL_MS) this.enqueue(["git", cwd]);
    const s = st?.value;
    if (!s) return null;
    if (DEFAULT_BRANCHES.has(s.branch) || s.branch === "(detached)") return { ...s, pr: null };
    const pr = this.prs.get(`${cwd}\0${s.branch}`);
    if (!pr || now - pr.at >= PR_TTL_MS) this.enqueue(["gh", cwd, s.branch]);
    return { ...s, pr: pr?.value ?? null };
  }

  /** Resolves once the refreshes queued so far ran (tests). */
  idle(): Promise<void> {
    return this.drained;
  }

  private enqueue(job: string[]): void {
    const key = job.join("\0");
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.pending.push(key);
    if (!this.draining) this.drained = this.drain();
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length) {
        const key = this.pending.shift() as string;
        const [kind, cwd, branch] = key.split("\0");
        try {
          if (kind === "git") await this.refreshStatus(cwd);
          else await this.refreshPr(cwd, branch);
        } finally {
          this.queued.delete(key);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private async refreshStatus(cwd: string): Promise<void> {
    const out = await this.run("git", ["status", "--porcelain=v2", "--branch"], cwd, 5_000);
    remember(this.status, cwd, { at: this.now(), value: out === null ? null : parseGitStatus(out) });
  }

  private async refreshPr(cwd: string, branch: string): Promise<void> {
    const now = this.now();
    this.ghCalls = this.ghCalls.filter((t) => now - t < 60_000);
    if (this.ghCalls.length >= GH_MAX_PER_MIN) return; // over the budget: a later get() asks again
    this.ghCalls.push(now);
    const out = await this.run("gh", ["pr", "view", branch, "--json", "number,state,url,statusCheckRollup"], cwd, 15_000);
    remember(this.prs, `${cwd}\0${branch}`, { at: this.now(), value: out === null ? null : parsePr(out) });
  }
}
