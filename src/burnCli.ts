// Terminal view of the limit burn ranking, for when the sidebar view is not
// loaded yet: `npm run burn -- [--window 5m|15m|1h|5h] [--interval 5] [--once] [--json]`.
// Same data path as the "Limit burn" view: transcripts -> BurnTracker -> buildBurnPayload.

import * as path from "path";
import { calibrate } from "./burn";
import {
  BURN_WINDOWS,
  DEFAULT_BURN_WINDOW_MS,
  buildBurnPayload,
  gaugeSamplesFromHistory,
  resolveScale,
  type BurnPayload,
} from "./burnPayload";
import { BurnTracker } from "./burnTracker";
import { PROJECTS_DIR, readLimitsHistory } from "./core";

const HORIZON_MS = 5.5 * 3_600_000;
const FRESH_GAUGE_MS = 600_000; // a 5h reading older than this is not used for the "full in" estimate
const CLEAR = "\x1b[2J\x1b[H";

export interface BurnCliArgs {
  windowMs: number;
  intervalSec: number;
  once: boolean;
  json: boolean;
}

export function parseBurnArgs(argv: readonly string[]): BurnCliArgs {
  const valueOf = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const interval = Number(valueOf("--interval"));
  const json = argv.includes("--json");
  return {
    windowMs: BURN_WINDOWS.find((w) => w.label === valueOf("--window"))?.ms ?? DEFAULT_BURN_WINDOW_MS,
    intervalSec: Number.isFinite(interval) && interval >= 1 ? interval : 5,
    once: json || argv.includes("--once"),
    json,
  };
}

const clip = (line: string, width: number): string =>
  line.length > width ? line.slice(0, Math.max(0, width - 1)) + "…" : line;

/** The payload as terminal lines, each clipped to `width` columns. */
export function burnTable(p: BurnPayload, width: number): string[] {
  const label = p.windows.find((w) => w.ms === p.windowMs)?.label ?? `${Math.round(p.windowMs / 60_000)} min`;
  const head = [`Limit burn · last ${label} · ${p.headline}`, p.note, ""];
  if (!p.rows.length) return [...head, p.empty].map((line) => clip(line, width));
  const rows = p.rows.map(
    (r) =>
      `${String(r.rank).padStart(2)} ${r.live ? "●" : "○"} ${`${r.sharePct.toFixed(1)}%`.padStart(6)} ${r.rate.padStart(9)} ${r.used.padStart(8)}  ${r.title} · ${r.meta}`,
  );
  const more = p.more > 0 ? [`     + ${p.more} more session${p.more === 1 ? "" : "s"}`] : [];
  return [...head, " #    share       now     used  session", ...rows, ...more].map((line) => clip(line, width));
}

type Rates = Readonly<Record<string, number>>;

async function cycle(tracker: BurnTracker, windowMs: number, rates: Rates): Promise<{ payload: BurnPayload; rates: Rates }> {
  await tracker.refresh();
  const nowMs = Date.now();
  const samples = gaugeSamplesFromHistory(readLimitsHistory(240));
  const latest = samples.length ? samples[samples.length - 1] : null;
  const fresh = calibrate(samples, tracker.records(), { sinceTs: nowMs - HORIZON_MS });
  const resolved = resolveScale(fresh, latest?.acct ?? null, rates);
  const payload = buildBurnPayload({
    summary: tracker.summary(windowMs),
    scale: resolved.scale,
    sessionPct: latest && nowMs - latest.ts <= FRESH_GAUGE_MS ? latest.pct : null,
    nowMs,
    lookup: (id) => {
      const dir = path.basename(tracker.cwdOf(id) ?? "");
      return { title: tracker.titleOf(id) ?? `${dir || "session"} ${id.slice(0, 8)}`, openId: "", ended: false };
    },
  });
  return { payload, rates: resolved.cache };
}

async function main(): Promise<void> {
  const args = parseBurnArgs(process.argv.slice(2));
  const tracker = new BurnTracker({ projectsDir: PROJECTS_DIR, horizonMs: HORIZON_MS });
  const width = (): number => process.stdout.columns || 120;
  let rates: Rates = {};
  if (args.once) {
    const { payload } = await cycle(tracker, args.windowMs, rates);
    process.stdout.write((args.json ? JSON.stringify(payload) : burnTable(payload, width()).join("\n")) + "\n");
    return;
  }
  process.on("SIGINT", () => process.exit(0));
  for (;;) {
    const next = await cycle(tracker, args.windowMs, rates);
    rates = next.rates;
    process.stdout.write(CLEAR + burnTable(next.payload, width()).join("\n") + "\n");
    await new Promise((resolve) => setTimeout(resolve, args.intervalSec * 1000));
  }
}

if (require.main === module) void main();
