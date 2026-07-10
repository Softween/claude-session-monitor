/**
 * verify.ts — runs the pure core data layer against the user's REAL transcripts
 * so we can confirm title extraction, entrypoint filtering, "limited" detection,
 * and state resolution before packaging. Run via npm run verify.
 */
import {
  classifyLimit,
  collectSessions,
  countBuckets,
  findRecentTranscripts,
  parseTranscriptTail,
  humanizeAge,
  DEFAULT_ENTRYPOINTS,
} from "./core";

const now = Date.now() / 1000;

function section(t: string) {
  console.log("\n" + "=".repeat(72) + "\n" + t + "\n" + "=".repeat(72));
}

section("1) classifyLimit() on ground-truth strings");
for (const s of [
  "You've hit your session limit · resets 1:50pm (Europe/Istanbul)",
  "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
  "API Error: 529 Overloaded",
  "random assistant text",
]) {
  console.log(`  ${JSON.stringify(s.slice(0, 56))} -> ${JSON.stringify(classifyLimit(s, 429))}`);
}

section("2) Recent transcripts (24h) — entrypoint + convKind + limit");
const recent = findRecentTranscripts(24 * 3600 * 1000, 60, now);
console.log(`  found ${recent.length} transcripts (24h, observer dirs excluded)`);
const epCount: Record<string, number> = {};
for (const rt of recent) {
  const tx = parseTranscriptTail(rt.path);
  const ep = tx.entrypoint || "(yok)";
  epCount[ep] = (epCount[ep] || 0) + 1;
}
console.log(`  entrypoint distribution: ${JSON.stringify(epCount)}`);

section("3) collectSessions() — DEFAULT filter (claude-vscode + cli)");
const views = collectSessions({
  now,
  extraTranscripts: recent,
  maxAgeSec: 24 * 3600,
  hideEndedOlderThanSec: 24 * 3600,
  allowedEntrypoints: DEFAULT_ENTRYPOINTS,
});
console.log(`  buckets: ${JSON.stringify(countBuckets(views))}  (total ${views.length})\n`);
for (const v of views) {
  const age = humanizeAge(v.lastActivityMs ? now - v.lastActivityMs / 1000 : 0);
  console.log(
    `  [${v.bucket.padEnd(9)}] ${v.sub.padEnd(22)} ${age.padEnd(5)} ${(v.entrypoint || "?").padEnd(13)} ${JSON.stringify(v.title.slice(0, 42))} ${v.cwdLabel ?? ""}`,
  );
}

section("DONE");
