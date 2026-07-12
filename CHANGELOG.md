# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## 1.7.2

- Added: each session row now shows the model and reasoning effort it is running, e.g. `your turn · Opus 4 8 · xhigh · 1m · glossgo-be`. The model is read per-session from the newest assistant line in that session's transcript (so a session on Fable and one on Opus are told apart), and the effort is the global `effortLevel` from `~/.claude/settings.json`. Both also appear in the row tooltip (`model:` / `effort:` lines). Sessions with no model line yet simply omit the badge.

## 1.7.1

- Fixed: the "Claude: usage high" notification repeated on every poll (roughly once a minute) instead of firing once. The dedup key depended on a gauge's reset timestamp, which drifts a few hundred ms each poll, so the guard never matched. Dedup is now keyed on the gauge alone and re-arms only after usage drops 5% below the threshold (hysteresis).
- Hardened: the auto-resume settings (`resumePrompt`, `resumeAutoType`, `autoResumeAfterReset`) are now restricted in untrusted workspaces, so opening an untrusted folder can no longer make the extension type text into your editor. `resumePrompt` newlines are collapsed so a value can never encode extra Return keystrokes, and an auto-type sweep now asks for one explicit confirmation before it types anything (so keystrokes never go to an unexpected window).
- Hardened: the session-monitor hook validates the session id before using it as a filename (rejects path separators and traversal). Dev toolchain (vitest, esbuild) updated to clear all `npm audit` advisories. The extension ships with zero runtime dependencies.

## 1.7.0

- Removed the 7d x 24h activity heatmap from the usage panel — it took a lot of vertical space for little day-to-day value. The per-hour token sparkline and model breakdown remain.

## 1.6.2

- Manual "Refresh usage" button (in the Usage limits panel + a refresh icon in its title bar). It bypasses the poll throttle and the 429 backoff, and drops the cached keychain token — so after you log out / switch Claude accounts, one click re-reads the credential and re-fetches the real 5h/7d/per-model percentages immediately.
- The button spins while fetching and reports honestly if you are signed out ("re-login, then refresh") or offline.

## 1.6.1

- Fixed: the 5h/7d gauges disappeared because every open VS Code window polled the usage API independently and the endpoint answered HTTP 429 permanently. Polling is now single-flight across ALL windows via a shared snapshot file; a 429 triggers an exponential backoff (Retry-After honored, 60s-15m) that every window respects.
- Gauges now render instantly on startup from the last known snapshot with an honest "updated Xs ago" age, and the panel says when the API is in backoff instead of pretending data is missing.
- Default `usagePollSeconds` raised 10 -> 30 (fleet-wide effective rate is what matters).

## 1.6.0

- Burn-rate ETA: predicts when the 5h window fills at the current pace; red warning + dotted projection on the sparkline when it would fill BEFORE the reset.
- Auto-resume after reset (`autoResumeAfterReset`, off by default): when sessions are limited, one staggered resume sweep fires ~90s after the window resets.
- Per-session token accounting: the top 5h consumer gets a token-hog badge in the tree; every session tooltip shows its 5h token usage.
- Model breakdown (7d share per model, e.g. Fable vs Opus vs Haiku) with a rough cost estimate for publicly priced models (excl. cache reads).
- Activity heatmap (7 days x 24 hours, local time) in the usage panel.
- "Focus Next Needs-You" command cycles through limited/waiting/your-turn sessions (default Cmd+Alt+N / Ctrl+Alt+N).
- Right-click quick actions on a session: Copy Session ID, Reveal Working Folder, Kill Process (SIGTERM, with confirm).
- Stuck detection is now CPU-aware: a silent transcript with real CPU load is "still computing", not stuck.
- Idle RAM advisory (`idleRamWarnMb`, default 2000): warns at most hourly when idle sessions hold significant memory.
- Fixed: the usage sparkline was defined but never rendered; it now draws (fed by the extension's own history samples).

## 1.5.0

- General review pass. New: usage-threshold warning (`usageWarnPercent`, default 85%) — toast + native notification once per gauge per reset window, covers per-model gauges too.
- Status bar now shows the 5h usage percent when it crosses 70%, and the tooltip lists all gauges.
- The "Usage over time" sparkline now also works without a terminal status line: the extension appends its own official-usage samples to the history (throttled to 1/min).
- Keychain token is cached for 5 minutes (was: a `security` subprocess per poll) and invalidated on 401/403.
- csm-debug.log is now rotated at 1MB (was: unbounded growth).
- token-offsets.json is pruned when transcripts fall out of the 7-day window (was: unbounded growth).
- `pollIntervalMs` changes now apply live without reloading the window.
- Fixed a leftover Turkish status string ("bilinmiyor" -> "unknown").

## 1.4.0

- Usage limits now refresh every 10 seconds (configurable via `usagePollSeconds`, min 5s) instead of every 90s.
- Per-model scoped limits (e.g. "Weekly · Fable") are now parsed from the new `limits[]` array of the Anthropic usage API and shown as extra gauges.
- Fixed a percent-scale bug where a utilization of 1.0 (= 1%) could render as 100% used.
- Session titles in the tree are truncated at 32 chars so the state / CPU / RAM description stays readable; full title remains in the tooltip.
- Fixed the missing Activity Bar icon: `media/icon.svg` was excluded from the package by `.vscodeignore`.
- Guarded against overlapping usage fetches.

## [1.3.1]

### Changed

- Ended (closed) sessions are now hidden by default. Closing a session's tab removes
  it from the list instead of parking it under an "Ended" group. Set
  `claudeSessionMonitor.showEnded` to `true` to bring the old behavior back.

## [1.3.0]

### Added

- Raised core + view branch coverage to ~86% (60 tests total) with targeted edge
  cases (stalled/ended/maxAge resolution, rate vs session limit, no-cwd tooltips,
  unknown-entrypoint, candidate dedup, token-scanner truncation / no-trailing-newline
  / per-call budget / boundary backfill, corrupt-state tolerance).
- A `vscode`-mocked integration test for `extension.ts`: `activate()` wires the tree,
  webview, status bar and all 11 commands, and refresh / openSession / deactivate run
  without throwing (isolated to a temp home, no real keychain / ps / network).
- Extracted `parsePsOutput` into `src/view.ts` with its own test.

## [1.2.0]

### Added

- Expanded test suite to 41 tests (~92% statement / ~97% function coverage on the
  core + view logic). Extracted the pure UI helpers into `src/view.ts`
  (`groupOf`, `normPct`, `normResetMs`, `fmtMb`, `labelsMatch`, `parsePsOutput`) with
  their own tests, and made the IO functions dependency-injectable for testing.

### Fixed (from a second adversarial review)

- `scanTokenUsage` no longer drops a complete first usage line when a backfill window
  begins exactly on a line boundary.
- A non-error line written in the same second as a 429 no longer clears the detected
  limit, so the "Limited" state is preserved.

## [1.1.0]

### Added

- A vitest unit-test suite (22 tests) for the core data layer, and a CI step that
  runs typecheck + tests on every push.

### Fixed (from an adversarial review)

- **Token scanner**: bounded per-file reads (no out-of-memory on a large delta), the
  offset now always advances (no infinite re-read loop), and offsets advance by
  byte length so multi-byte UTF-8 no longer drifts/double-counts.
- **Resume sweep**: self-chained with `setTimeout` so a slow step can no longer
  overlap and type into the wrong tab; it re-verifies the active tab and that VS Code
  is frontmost immediately before typing.
- **Keychain read** is now async (`execFile`), so it no longer blocks the extension
  host for up to 5s every 90s.
- **Atomic writes** (temp + rename) for the token offsets/buckets and limits history,
  and `readJson` now rejects a truncated `null`/array so a partial write can't crash
  or double-count the scan.

## [1.0.1]

### Fixed

- Official usage gauges going stale ("updated Nh ago"): replaced the Node
  `https.request` call (which intermittently timed out in the extension host and
  threw an internal `reading 'req'` error on destroy) with the global `fetch` API and
  an abort timeout. Usage now refreshes reliably every ~90s.
- Hardened tree rendering with a per-item guard and added a debug log
  (`~/.claude/session-monitor/csm-debug.log`) for diagnosis.

## [1.0.0]

First public release.

### Added

- Activity Bar panel listing every interactive Claude Code session, grouped by live
  state: Limited / Waiting for you / Your turn / Working / Ended.
- Per-session CPU% and RAM, a total-load summary, and a 🔥 flag for CPU hogs.
- Official **Session (5h)** and **Weekly (7d)** usage gauges (% used, % left, reset
  countdown) via `api.anthropic.com/api/oauth/usage`, plus a rolling token-usage
  trend with an hourly chart.
- In-VS-Code toasts and native macOS notifications on limit/waiting transitions.
- Stuck-session alert for working sessions that go silent.
- Staggered **Resume All** that auto-types resume across sessions one per minute to
  avoid hitting the rate limit after an outage.
- Activity Bar badge, "needs-you only" filter, click-to-jump to a session's tab, and
  clear/remove of ended sessions.
- One-command hook installer (`scripts/install.sh`).
