/**
 * benchRefresh.ts — the main-thread time of a refresh's reads over a fixture of
 * 300 transcripts (npm run bench). Run it on a quiet machine, not in CI: shared
 * runners make timing numbers flap. A refresh here reads what the extension's
 * refresh reads: the recent-transcript scan (every 25 s there), the session
 * list and the usage history. Each row gives the event loop's active time
 * (performance.eventLoopUtilization), the refresh's own count of its
 * synchronous slices (BusyClock, what the health file's p95 reports), the
 * longest stall a 1 ms timer saw (monitorEventLoopDelay) and the wall time.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { monitorEventLoopDelay, performance } from "perf_hooks";
import { findRecentTranscripts, readLimitsHistory, type RecentTranscript } from "./core";
import { BusyClock } from "./health";
import { SessionCollector } from "./sessionCollector";

const TRANSCRIPTS = 300;
const PROJECTS = 30;
const HOOKS = 60; // hook records for the newest transcripts, as open tabs leave them
const LINES = 120; // per transcript, ~500 bytes each
const CHANGED = 5; // transcripts and hook records written between two refreshes of a busy window
const RUNS = 30;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bench-"));
const projects = path.join(root, "projects");
const monitor = path.join(root, "session-monitor");
const history = path.join(monitor, "limits-history.jsonl");
const settings = path.join(root, "settings.json");
const now = Date.now() / 1000;
const iso = (sec: number): string => new Date(sec * 1000).toISOString();
const text = "x".repeat(400);

function line(n: number, ts: number): string {
  const entry =
    n % 2 === 0
      ? { type: "user", entrypoint: "claude-vscode", cwd: "/repo", message: { content: [{ type: "text", text }] }, timestamp: iso(ts) }
      : { type: "assistant", message: { model: "claude-opus-4-8", content: [{ type: "text", text }], stop_reason: "end_turn" }, timestamp: iso(ts) };
  return JSON.stringify(entry) + "\n";
}

function hook(sid: string, file: string, ts: number, state: string): void {
  fs.writeFileSync(path.join(monitor, `${sid}.json`), JSON.stringify({ session_id: sid, provider: "claude", state, ts, cwd: "/repo", transcript_path: file, pid: process.pid }));
}

/** The transcripts, newest first, with their session ids. */
function fixture(): Array<{ sid: string; file: string }> {
  fs.mkdirSync(monitor, { recursive: true });
  const out: Array<{ sid: string; file: string }> = [];
  for (let i = 0; i < TRANSCRIPTS; i++) {
    const dir = path.join(projects, `-repo-${i % PROJECTS}`);
    fs.mkdirSync(dir, { recursive: true });
    const sid = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    const file = path.join(dir, `${sid}.jsonl`);
    const last = now - i * 30;
    fs.writeFileSync(file, Array.from({ length: LINES }, (_, n) => line(n, last - (LINES - n))).join(""));
    fs.utimesSync(file, last, last);
    if (i < HOOKS) hook(sid, file, last, i % 3 === 0 ? "working" : "idle");
    out.push({ sid, file });
  }
  for (const f of ["accounts.json", "token-offsets.json", "token-buckets.json", "official-usage.json", "limits.json", "statusline-last-raw.json"]) {
    fs.writeFileSync(path.join(monitor, f), JSON.stringify({ v: 1, pad: "y".repeat(50_000) }));
  }
  fs.writeFileSync(history, Array.from({ length: 3000 }, (_, n) => JSON.stringify({ ts: now - (3000 - n) * 60, fh: n % 100, sd: n % 50, src: "ext" }) + "\n").join(""));
  fs.writeFileSync(settings, JSON.stringify({ effortLevel: "high" }));
  return out;
}

interface Sample {
  active: number;
  busy: number;
  stall: number;
  wall: number;
}

const collector = new SessionCollector({ monitorDir: monitor, settings });
let recent: RecentTranscript[] = [];

async function refresh(scan: boolean): Promise<Sample> {
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const elu = performance.eventLoopUtilization();
  const started = performance.now();
  const clock = new BusyClock();
  if (scan) recent = await clock.wait(findRecentTranscripts(6 * 3600 * 1000, 120, now, undefined, projects));
  await collector.collect({ now, extraTranscripts: recent, maxAgeSec: 6 * 3600, pidAlive: () => true }, clock);
  readLimitsHistory(240, history);
  const busy = clock.total();
  const wall = performance.now() - started;
  const active = performance.eventLoopUtilization(elu).active;
  await new Promise((resolve) => setTimeout(resolve, 3)); // the timer a long slice delayed fires and is recorded
  delay.disable();
  return { active, busy, stall: delay.max / 1e6, wall };
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

function row(name: string, samples: Sample[]): string {
  const at = (key: keyof Sample, q: number): string => {
    const sorted = samples.map((s) => s[key]).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)].toFixed(2);
  };
  const three = (key: keyof Sample): string => `${at(key, 0.5)} / ${at(key, 0.95)} / ${at(key, 1)}`;
  return `${name.padEnd(30)} ${String(samples.length).padStart(3)}  ${three("active").padEnd(22)} ${three("busy").padEnd(22)} ${at("stall", 1).padStart(8)}  ${at("wall", 0.5).padStart(8)}`;
}

async function main(): Promise<void> {
  const transcripts = fixture();
  console.log(`fixture: ${TRANSCRIPTS} transcripts in ${PROJECTS} project dirs, ${HOOKS} hook records, 6 state files, a 3000-point usage history; node ${process.version}`);
  console.log(`${"refresh".padEnd(30)}   n  ${"ELU active ms p50/p95/max".padEnd(22)} ${"BusyClock ms p50/p95/max".padEnd(22)} ${"stall max".padStart(8)}  ${"wall p50".padStart(8)}`);
  const cold = await refresh(true);
  console.log(row("first (scan, every parse)", [cold]));
  const series = async (scan: boolean, before?: (run: number) => void): Promise<Sample[]> => {
    const out: Sample[] = [];
    for (let run = 0; run < RUNS; run++) {
      before?.(run);
      await pause();
      out.push(await refresh(scan));
    }
    return out;
  };
  console.log(row("unchanged", await series(false)));
  console.log(row("unchanged, with the scan", await series(true)));
  const busyWindow = await series(false, (run) => {
    for (const { sid, file } of transcripts.slice(0, CHANGED)) {
      fs.appendFileSync(file, line(run, now + run));
      hook(sid, file, now + run, "working");
    }
  });
  console.log(row(`${CHANGED} transcripts + hooks changed`, busyWindow));
}

main()
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(root, { recursive: true, force: true }));
