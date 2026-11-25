/**
 * The refresh loop's Claude session list (collectSessions) with its reads off
 * the extension host's main thread: hook records, transcript stats and
 * settings.json come through fs.promises, a hook record is read again only
 * when it changed (readHookStatuses), and a transcript is parsed only when its
 * stat changed, then just its new bytes (parseTranscriptTail), with a turn of
 * the event loop between parses every SLICE_MS (a window's first refresh parses
 * them all). The caller runs one collection at a time
 * (refreshGate.singleFlight). No vscode import.
 */
import * as fs from "fs";
import { performance } from "perf_hooks";
import {
  MONITOR_DIR,
  SETTINGS_FILE,
  collectSessions,
  parseEffortSettings,
  parseTranscriptTail,
  readHookStatuses,
  sessionCandidates,
  type CollectOpts,
  type HookCache,
  type SessionView,
  type TxInfo,
} from "./core";
import { BusyClock } from "./health";

const SLICE_MS = 8;

/** collectSessions' options, less the state and reads the collector owns. */
export type CollectInput = Omit<CollectOpts, "hookStatuses" | "txCache" | "effortSettings" | "readTx" | "exists">;

export interface CollectorFiles {
  monitorDir: string;
  settings: string;
}

export class SessionCollector {
  private readonly txCache = new Map<string, TxInfo>();
  private readonly hookCache: HookCache = new Map();

  constructor(private readonly files: CollectorFiles = { monitorDir: MONITOR_DIR, settings: SETTINGS_FILE }) {}

  /** The sessions to show. Every await goes through `clock`, so it counts the main-thread time. */
  async collect(opts: CollectInput, clock = new BusyClock()): Promise<SessionView[]> {
    const [hooks, settings] = await clock.wait(
      Promise.all([readHookStatuses(this.files.monitorDir, this.hookCache), fs.promises.readFile(this.files.settings, "utf8").catch(() => "")]),
    );
    const paths = [...new Set(sessionCandidates(hooks, opts.extraTranscripts).values())].filter((p): p is string => !!p);
    const stats = new Map(await clock.wait(Promise.all(paths.map(async (p) => [p, await fs.promises.stat(p).catch(() => null)] as const))));
    let slice = performance.now();
    for (const [p, st] of stats) {
      const prev = this.txCache.get(p);
      if (!st || (prev && prev.mtimeMs === st.mtimeMs && prev.sizeBytes === st.size)) continue;
      try {
        this.txCache.set(p, parseTranscriptTail(p, prev, st));
      } catch {
        continue; // collectSessions parses it again and reports the error for its session alone
      }
      if (performance.now() - slice >= SLICE_MS) {
        await clock.wait(new Promise<void>((resolve) => setImmediate(resolve)));
        slice = performance.now();
      }
    }
    return collectSessions({
      ...opts,
      hookStatuses: hooks,
      txCache: this.txCache,
      effortSettings: parseEffortSettings(settings),
      readTx: (p, prev) => parseTranscriptTail(p, prev, stats.get(p) ?? null),
      exists: (p) => !!stats.get(p),
    });
  }

  /** Forgets the parsed transcripts, so the next collection parses each one again. */
  forget(): void {
    this.txCache.clear();
  }
}
