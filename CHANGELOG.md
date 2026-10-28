# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## 2.24.0
- **Remote `send` takes exactly one delivery path.** The text is written into the session's VS Code terminal when one is found. Otherwise, when this VS Code window is focused (VS Code is never brought to the front) and the session's tab is the window's one tab matching its title, that tab is made active and the text is typed into it, provided VS Code is still the frontmost app at the keystroke (checked in the same osascript run). Otherwise it goes to the session's inbox. The first path that applies ends the command, so nothing is typed after the inbox accepted a message: an inbox frame the session has not shown yet answers `delivered via inbox (pending in the session)`. A `send` for a session that is not in this Mac's list answers `session not found`, and the inbox is addressed by the session's pid and exact id.
- **Strict remote targets.** A remote command finds a terminal by its process tree, or by a name that matches the session title, and a tab by its label the same way: equal (case and spacing aside, 8+ characters), or the label Claude Code makes from a long title (titles over 25 characters show their first 24 + `…`, so `Getfund.space affiliate modeli` is `Getfund.space affiliate …`); a label ending in `...` matches a longer title starting with its 8+ character stem. A shorter title that merely starts like the label never matches, and when two tabs or terminals match, or another listed session's title matches the same label, nothing is written or typed. Clicking a row in the panel and the Resume All / Set Model / Set Effort sweeps keep the tolerant matching.
- **Rejected inputs.** Before text is written into a terminal or typed into a tab, line breaks become spaces; text with control characters, a leading `!`, `/` or `#`, or more than 2000 characters is refused with `rejected input`. The inbox still wraps the text as a cross-session message.
- **No prompts, expiry and a time limit for remote commands.** A remote `resume` of a running session with no terminal or tab in this window answers `no tab for this session in this window` instead of opening the "no open tab" prompt. A command older than 2 minutes answers `expired` without running, and one that runs past 60 s answers `timed out`. `resumeAll` still asks for confirmation on this Mac.
- **New settings** (user settings only, like `remote.url`): `remote.acceptCommands` (default on); off keeps uploading the snapshot but answers every command with `remote commands disabled on this Mac`. `remote.typeFallback` (default on); off never types into a tab.
- **Redacted uploads.** Session titles, last lines and closing lines sent to the relay have API keys and tokens (`sk-ant-`, `ghp_`, `xoxb-`, `AKIA`), private-key headers and 40+ character hex or mixed base64 runs replaced with `[redacted]`.
- **Relay hygiene.** Relay answers that redirect or exceed 256 KB are refused and at most 20 commands are taken per poll. Resume in Terminal and remote resume start `claude` by its absolute path (resolved once with `which claude`, then `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`); a remote resume of an exited session is refused when none is found. The process-tree and free-memory lookups no longer block the extension host.

## 2.23.5
- **Remote `resume` never duplicates a running session.** The terminal match now counts the session's own process (terminals started with `claude --resume` report that pid), and when a running session has no addressable terminal (the Claude Code extension's own tab) the word `resume` is typed into that tab instead of starting a second `claude --resume`. Only a session whose process has exited is reopened in the background.

## 2.23.4
- **Remote `resume` no longer opens duplicate terminals.** A session that is already open gets the word `resume` written into its own terminal (terminal API, no tab switch, no focus change). Only a session without a terminal is reopened with `claude --resume`, and that terminal is created in the background instead of being brought to the front. Three taps on the phone used to open three terminals and switch the panel each time.

## 2.23.3
- **Remote `send` no longer steals focus.** The text is written into the VS Code terminal that hosts the session through the terminal API (process-tree match first, unique tab label second), so the active tab and the keyboard focus stay where you are. The old jump-to-tab keystroke path remains the fallback when no terminal can be identified; the relay result says `delivered via terminal` or `delivered via typed`.

## 2.23.2
- **Remote bridge reports macOS free memory from `memory_pressure`** (its system-wide free percentage of total memory) instead of `os.freemem()`, which counts only the kernel's free pages; those stay near zero on a busy Mac, so the remote view showed RAM as 100 % used. If `memory_pressure` fails, free + inactive + speculative + purgeable pages from `vm_stat` are used, then `os.freemem()`; other platforms keep `os.freemem()`. The machine sample is now taken at most once per 15 s instead of on every panel refresh.

## 2.23.1
- **Effort label follows Claude Code.** Each row now shows the effort the session sends on its next request. A `CLAUDE_CODE_EFFORT_LEVEL` in the `env` block of the Claude Code user settings overrides every session's own `/effort` pick (`unset` and `auto` show as `auto`); without it the transcript's last effort wins, then `modelSettings.<model>.effortLevel`, then the top-level `effortLevel`. `maxEffortLevel` (per model, else top-level) caps the result. Before, an idle session kept showing its last turn's effort or the top-level `effortLevel`, so a settings change looked unapplied until the session's next turn.

## 2.23.0
- **Remote bridge (optional, off by default).** New settings `remote.url` and `remote.host` and commands **Agent Sessions: Set remote bridge token** (Secret Storage) and **Agent Sessions: Remote bridge status**. With a URL and a token set, the extension pushes a snapshot of the panel to `<url>/fleet/ingest` when it changes (at most every 10 s, heartbeat every 2 min) and long-polls `<url>/fleet/commands` for `resume`, `kill`, `resumeAll`, `switchAccount` and `send`, posting each result back. `send` delivers text into a running Claude Code session over its local `uds-messaging` socket. Network errors back off from 2 s to 60 s; without a URL nothing runs. `remote.url` and `remote.host` are user-level only (workspace values are ignored and restricted in untrusted workspaces), the URL must be https (http only for localhost), and the token is bound to the URL's origin. A remote `send` that the inbox does not confirm within 15 s is typed into that session's tab instead.

## 2.22.0
First Marketplace release since 2.6.0. In short, what 2.7.0 to 2.21.1 added, plus this release's changes:

- **Multiple Claude accounts (macOS).** Every Claude Code login is remembered (its tokens in VS Code Secret Storage), inactive accounts keep their tokens and usage fresh in the background, and you can switch with **Agent Sessions: Switch Claude account**, **Switch to Claude account with most headroom**, or from the Usage limits panel. `autoRotate` (off by default) switches automatically at `rotateAtPercent`.
- **Usage limits view.** One card per account with a bar per gauge, every gauge listed in the account header, the active account always marked (and named in the status bar once 2+ accounts are known), Team and Enterprise plan labels. Token totals and the per-model share are behind the new `showTokenStats` setting (off by default).
- **More accurate data.** Each session shows its own reasoning effort, a usage API 429 waits for the server's Retry-After instead of growing, usage snapshots record the account they belong to, empty hook records left behind by account switches are hidden, and files shared across VS Code windows are written through unique temp files.
- New setting `closingStatusMarkers` (default off). When on, a Your turn row whose final reply ends with a line starting with ✅, ⏳ or 🟡 shows that marker instead of the dot, and the tooltip gains a `closing:` line (the 2.20.0 behavior). When off, rows, tooltips and `npm run verify` show no closing status, so an ordinary reply that ends in "✅ All tests pass" no longer reads as done.
- The `claude-switch` integration (status block, priority and login-needed badges, `Use this account`, its shared file vault, `tick --fresh` on refresh) is active only when `~/.claude/bin/claude-switch` exists. Without it the extension never runs it, never reads or creates `~/.claude/state/claude-switch/`, refreshes inactive accounts' tokens itself, and the Usage limits view shows no claude-switch block, `no data` line or badges.

## 2.21.1
- The status bar no longer drops the active account's name every few seconds, and after a switch whose first usage fetch got a 429 it no longer shows the previous login's 5h gauge again: the resource sampler's redraws (every 3 s) now show the same account and usage as the panel instead of the last live poll.
- The active card shows the newer of its own live poll and a background fetch for that account. An account switched back to after its 5h reset showed `active · exhausted` at 100% from before the switch until its live poll got past the usage API's backoff, and the older live poll also overwrote the newer background result.
- `Use this account` can no longer stay on `Switching…` with every Use button disabled until a reload: when `claude-switch` cannot be started (E2BIG, ENOMEM) the error shows at once, and the host gives up a `claude-switch use` that has not exited within 90 s.
- A usage snapshot written by a 2.20.x or older window (no account tag) counts for the active account only when that account's own snapshot holds the same fetch. When another path (the 30 s registry reload, a usage fetch, a login capture, a switch) moved the active account first, the previous login's gauges could show as the new one's, and at startup the registry alone decided. The time of the last account change is now recorded wherever it changes.
- Shared files (`accounts.json`, the usage snapshots) are written through a temp file unique to each write instead of one fixed `.tmp`, and a window that follows a switch another window already recorded no longer rewrites `accounts.json`. With every window rewriting the registry within a tick of a switch, one window could truncate the temp file another was renaming, and a window reading the briefly empty file could save a registry with only the active account.
- The active card keeps claude-switch's login-needed state: `active · login needed` (red) instead of a plain `active`.
- Auto-resume after a reset schedules from the active account's own 5h gauge, not from the last live poll, which could be the previous login's.

## 2.21.0
- The active Claude account is always marked. Its Usage Limits card shows `active` with the green dot even when it is exhausted (`active · exhausted · 2h`) and never offers `Use this account`; with 2+ accounts the status bar names it with its 5h gauge (`ana 12%`, tooltip `Claude account: …`). The active login now follows `~/.claude.json` (a stat every tick, parsed on change) and claude-switch's `panel.json`, the fresher of the two winning. Before, only a successful usage fetch or a changed vault token moved it, so after a claude-switch switch (a token the extension had already vaulted, which the usage API answers with 429) the previous account stayed active until a manual refresh.
- The active card and the status bar only show usage fetched for that account: right after a switch they show the new account's last background fetch, not the previous login's gauges. The shared usage snapshot records the account it belongs to.
- `Use this account` turns into a disabled `Switching…` while `claude-switch use` runs (the other Use buttons are disabled meanwhile). When the command exits the active login is re-resolved and the panel re-rendered at once, with `Switched to <email>` or the CLI's error text in the panel. The debug log records `use: <email> <ms>ms (cli <ms>ms, …)` from click to re-render.
- The VSIX no longer ships the repo's `.claude/` folder.

## 2.20.2
- A usage API 429 now waits for the server's Retry-After (60 s when it sends none, at most 15 min) instead of doubling on every repeat. The endpoint throttles only the active account's token, which every running Claude CLI polls too, and the throttle is short, so the doubling left the active account's gauges showing "usage API rate-limited" for up to 15 minutes.

## 2.20.1
- The effort column shows each session's real reasoning effort, read from the `effort` field Claude Code stamps on every assistant turn, so a session switched to `max` (or running at a per-model `modelSettings` level) no longer shows the global `effortLevel` from `~/.claude/settings.json`. That setting remains the fallback for sessions with no reply yet. The meta strip shows effort only when every session agrees.

## 2.20.0
- Rows in the Your turn group show the session's closing status instead of the blue dot: ✅ done and safe to close, ⏳ waiting on a background job, 🟡 needs your decision. It is read from the last line of the final assistant message; rows without one keep the dot. The tooltip gains a `closing:` line.

## 2.19.0
- Phantom hook records are hidden and cleaned up: the burst of one-per-tab `SessionStart`/`SessionEnd` records an account switch leaves behind (no transcript, dead pid or past a 10 min grace) no longer shows as empty "your turn" rows.
- The Usage Limits refresh button also runs `claude-switch tick --fresh` (when the CLI is installed) so pressing it lets claude-switch decide on a switch.

## 2.18.0
- Every account header now lists all of its limits as plain text on the right (`Session 27% · Weekly 71% · Fable 100%`): session, weekly, then model-scoped weeklies, percentages from 90% in red. Below ~360 px of header width the labels shorten to `S · W · F`. Missing gauges are omitted; the status chip and expanded body are unchanged.

## 2.17.0
- New setting `claudeSessionMonitor.showTokenStats` (default off): the `Tokens, all logins` row and the `Models, 7d share` block at the bottom of Usage Limits are hidden unless enabled, and the per-model share is not computed while it is off. Takes effect without a reload.
- Compact layout for 8+ accounts: a collapsed account card is one 25 px line including its separator, the claude-switch block is tighter, and long names end in an ellipsis. Expanded cards keep the long thin 4 px bars.

## 2.16.0
- Usage Limits view simplified. The claude-switch block is now two lines (`claude-switch · <email> · #<rank> · auto|PAUSED`, then `next: ...`) plus a collapsed `Activity (n)` row that opens the last 8 meaningful events (switch, restore, login, error, rollback, pause/resume, offline, rate limit); state is remembered per workspace.
- Account cards are ordered by claude-switch priority (Codex last) and collapse to one header line: `#rank name`, a status chip (`active`, `ready`, `exhausted · time to reset`, `login needed`) and the worst gauge. The active account starts expanded, the rest collapsed; the choice is remembered per account.
- No accidental switching: clicking a name no longer switches and `Rotate` is gone while claude-switch data is fresh. An expanded non-active card has a `Use this account` link that runs `claude-switch use <email>`. Without fresh data the old behaviour is unchanged.
- Every account claude-switch knows is added to the extension registry (identity only, no token) so its gauges appear through the existing vault polling.

## 2.15.0
- Usage Limits view: a thin `claude-switch` block above the first account card, fed by `~/.claude/state/claude-switch/panel.json`. One status line (active account, priority rank, auto/PAUSED, breaker count, last switch with age), a `next:` hint line and up to 8 recent events as `HH:MM  text`. Shows `claude-switch: no data (...)` when the file is missing or older than 10 minutes. Account cards gain a `#n` priority badge and a `login needed (reason)` note. Re-read on every refresh and on a debounced (1 s) change of the state directory. No secrets are read or shown.

## 2.14.0
- The shared claude-switch vault is now a file vault: `~/.claude/state/claude-switch/vault/<accountUuid>.json` (directory 0700, files 0600, written via temp file + rename). The keychain vault caused macOS password prompts and had a 4 KB write limit; the extension no longer calls `security` for it.

## 2.13.0
- Passive-account tokens now come from the claude-switch keychain vault (service `claude-switch`); the extension no longer refreshes them itself when that vault has the account, and seeds it once per refresh token otherwise. Both tokens expired shows "waiting for claude-switch keeper".

## 2.12.0
- Back to the original card layout: one row per gauge with the long bar, percent and reset time; cards are tighter so eight accounts still fit.

## 2.11.1
- Grid bars back to the thin 2.10 style (4 px, plain fill, red only at 90%+); the rest of the 2.11.0 layout stays.

## 2.11.0

- Usage Limits grid redesign: name on its own line with plan and badges beneath, 6px bars with pressure colours, full-width active-row highlight with a green accent, narrow-panel header and column rules.
- Regression test runs the real webview script in a vm so a missing function can no longer ship unnoticed.

## 2.9.2

- Usage Limits: Team and Enterprise logins are labelled "Team" / "Enterprise" instead of "$100 Max". Their seats carry a Max-style `rateLimitTier`, so the plan now comes from `subscriptionType` for those plans.

## 2.10.1
- Fix: the Usage Limits grid never rendered (its render helpers were missing from the webview script), leaving the panel on "Waiting for usage-limit data".

## 2.10.0

### Changed

- Usage Limits: one account grid (Account, Session, Weekly, Fable) replaces per-account cards: bar, used % and reset countdown per cell, active row highlighted, notes for the active account below the grid, others in a warning tooltip.
- Removed the 2.9 expand/collapse rows and their stored state.

## 2.9.1

- Usage Limits: compact account rows show each window's reset countdown; gauges wrap to their own line on a narrow sidebar.

## 2.9.0

### Changed

- Usage Limits: non-active Claude accounts collapse to a two-line row (name, worst window %, one thin bar per window); click the row or its chevron to expand, state is kept per workspace. The active account stays a full card.

## 2.8.0

### Fixed

- Every `claude /login` is vaulted within seconds, independent of the usage API and its 429 backoff: a stat of `~/.claude.json` per tick, a fresh keychain read on change or every 60 s, stored once the same account + token pair holds for 3 s (30 s before a token is moved from another account's vault entry).
- Background token refresh separates a revoked grant from a transient failure: 429/5xx/network/`invalid_client` retry after 10 minutes; `invalid_grant` (unless another window already rotated the token) marks the account "token revoked — log in with Claude Code once" until its vault holds a newer token.
- Vault writes are awaited and a failed store is retried on the next tick; refresh failures log the HTTP status and a short token-free body snippet.

## 2.7.0

### Added

- Account rotation (macOS): every Claude login seen as the active one is vaulted in
  VS Code Secret Storage (full OAuth block + identity). Inactive accounts are kept
  alive by refreshing their tokens in the background (the active login is never
  refreshed, Claude Code owns it).
- Commands **Agent Sessions: Switch Claude account** and **Switch to Claude account
  with most headroom**; clicking an account name in the Usage limits panel switches
  to it, the account with the most headroom is marked with a star, and a "Rotate"
  button switches to it directly.
- Settings `autoRotate` (default off) and `rotateAtPercent` (default 90): switch
  automatically when the active account is nearly spent and another has 20+ points
  more headroom, at most once per 10 minutes.
- Only Claude Code's own login is switched (keychain `claudeAiOauth` and
  `~/.claude.json` `oauthAccount`); "Forget other accounts" also deletes the vaulted tokens.

## 2.6.0

### Changed

- The usage view is the main event: the Sessions view now asks for a third of the
  sidebar (`initialSize` 1 vs 3) and its rows are back to one line (dot · title with
  model and folder muted inline · tokens · age), so the live list stays short.
  VS Code remembers a sidebar you already resized, so drag the divider once if
  the old split sticks.
- Usage view: bars are back. Each window is one row (label · 4px monochrome bar ·
  used% · reset countdown); the bar is foreground at half opacity and turns red only
  from 90%, used% goes amber from 70%. Accounts are separated by a hairline rule
  instead of colored rules or rings.

## 2.5.0

### Changed

- Usage view: the 2.4.0 rings are gone after one day. They read badly under real
  VS Code themes (charts colors vary widely) and stacked three color systems on
  one card. Each account card now states one thing: the window that binds you
  (highest used%) as a large figure with its label and reset countdown, and the
  other windows as a single muted line beneath ("Session 2% · Fable 84%"). Color
  is pressure only: amber from 70%, red from 90%, plain text below that.

## 2.4.0

### Changed

- Usage view: every account card now carries an Apple Health style ring stack on
  the left, one ring per rate-limit window (outer = session, then weekly, then
  the per-model weekly window). Each ring keeps a fixed hue (session blue, weekly
  green, per-model purple) so the rings stay distinguishable, and turns red only
  once that window is at 90% or more. The text rows on the right keep the exact
  percentage (still green/yellow/red by pressure) and the reset countdown; a
  fourth window shows as a text row only. The hairline meters and the colored
  left rule are gone, the rings are the card's single accent.

## 2.3.0

### Changed

- Sessions view redesigned for calm: the eleven-column table is gone. Each session
  is two lines (state dot · title · age, then model · effort · folder with 5h tokens
  and share on the right) and the hairline share bar now runs the full row width.
  CPU and memory appear on a row only when they matter (CPU above the hog threshold,
  memory ≥ 1 GB); everything else stays in the tooltip. Ended and Unknown groups fold
  to a single line by default (state persists), so the long Codex tail no longer
  pushes the live sessions off screen. The filter pills and machine totals share
  one top strip.
- Usage view: provider badges, plan pills and the fetch age are replaced by a quiet
  "name · plan" header (age only shows once data is older than 10 minutes). Reset
  countdowns sit in their own column, the burn-rate line appears only when the
  window would fill before its own reset, and gauge labels drop the "(5h)/(7d)"
  parentheticals.

### Removed

- Usage view: the "Sessions (5h tokens)" section (it duplicated the token column
  of the session list) and the per-provider "7d · lifetime" token line. The
  5h/7d token total survives as one footer line; "Models (7d share)" stays, folded.

## 2.2.0

### Added

- Plan chip on every usage card ("$200 Max", "$100 Pro Lite"…). Derived from the
  Claude keychain `rateLimitTier` / Codex `planType`, overridable per account with
  the new `claudeSessionMonitor.planLabels` setting (keyed by email, `claude` or `codex`).

## 2.1.1

### Changed

- Usage cards: provider badge (CLD / CDX) and account name in the header, a
  2px hairline meter under every gauge (same geometry as the session table's
  token-share line), and a left rule colored by the card's worst gauge.

## 2.1.0

### Changed

- Usage view shows every Claude login and Codex at the same time, one compact
  card per account, instead of provider tabs and account pills. The segment bars
  were dropped so all accounts fit on screen; used% is colored by pressure.
- Sessions are always ordered by token spend (descending) inside each group;
  ties fall back to the most recent activity.

### Removed

- The account pin (clicking an account pill) — every account is visible now, so
  the panel always follows the active login for burn-rate and history.

## 2.0.0

### Added

- Codex as a first-class provider beside Claude Code. The extension uses the
  official local `codex app-server --stdio` interface for thread state, rate limits,
  and account usage rather than scraping Codex's state database.
- Provider-qualified session identities, provider badges, All / Claude / Codex
  filtering, and provider health messages in the existing Sessions and Usage views.
- A shared provider hook layer. Claude lifecycle records stay under
  `~/.claude/session-monitor/`; Codex lifecycle records use
  `~/.codex/session-monitor/`. The installer now merges both hook configurations
  with backups and asks users to review added or modified Codex hooks via `/hooks`.
- `Agent Sessions: Switch Provider`
  (`claudeSessionMonitor.toggleProvider`) and provider-aware
  `Agent Sessions: Resume Session in Terminal`
  (`claudeSessionMonitor.resumeSession`) commands.
- `claudeSessionMonitor.enableClaude`, `claudeSessionMonitor.enableCodex`,
  `claudeSessionMonitor.codexExecutable`, and
  `claudeSessionMonitor.codexPollSeconds` settings.

### Changed

- Product name is now **Agent Session Monitor: Claude + Codex**.
- Usage presentation is provider-aware. Claude keeps its measured transcript
  5h/session breakdown and Anthropic gauges; Codex shows only the official
  account/rate-limit data returned by its app-server.
- Claude bulk resume/model/effort sweeps remain explicitly Claude-only. Individual
  resume actions route through the selected session's provider.

### Security and compatibility

- Added or modified Codex hooks are not assumed trusted. Users must inspect and
  approve the expected local lifecycle command with `/hooks`; command strings are
  preserved, but bounded timeout migration can still require trust to be reviewed
  again.
- Hook state is written through unique, locked atomic files with private
  `0700`/`0600` permissions. The installer validates both provider configs before
  changing either one, refuses malformed JSON, quotes command paths, and atomically
  replaces valid settings while keeping a backup.
- Codex per-session token usage is left unavailable because the current official
  interface does not expose a trustworthy value. No estimate is presented as a
  measurement.
- The package name, publisher, Marketplace extension id, and all existing
  `claudeSessionMonitor.*` command/config/view ids are unchanged, so 1.x installs,
  settings, and keybindings upgrade in place.

## 1.10.2

- Added `shortTitle` to every command, so the view's "…" overflow menu shows compact labels ("Set Effort (All)…") instead of the full "Claude Sessions: Set Effort for All Sessions…" strings that got clipped at narrow menu widths. The Command Palette keeps the full prefixed titles.

## 1.10.1

- The v3 bucket-store wipe now also drops the stale byte offsets, so instead of every token total restarting from zero, the recent window (last 4MB per transcript) is re-counted with requestId dedup over the next few scan ticks (~7 minutes to fully rebuild on a busy machine). Verified against real data: rebuilt 5h total matches the independent deduped ground-truth recompute.

## 1.10.0

- **Fixed jump-to-session opening the transcript instead of the tab.** Two bugs compounded: tab labels can carry a literal newline (icon glyph stacked over the title), which the label normalizer didn't collapse before comparing; and the session title sometimes fell back to a machine-generated blob (`<task-notification>...`) that could never match any tab. Titles are now sanitized (whitespace-collapsed, `<...>` blobs rejected) through the whole `tx.title || hook.prompt || tx.lastPrompt` chain, the transcript's `ai-title` record is recovered from the head of very long transcripts (the tail-only read used to lose it), and matching now tries every cleaned title candidate, not just the one that won. When no tab still matches, you get a prompt (Open Transcript / Resume in Terminal / Copy ID) instead of the transcript opening silently.
- **New: "Set Model for All Sessions…" and "Set Effort for All Sessions…"** commands, reusing the Resume All sweep engine (same staggered timing, accessibility-error handling, and frontmost/active-tab safety checks) to type `/model <choice>` or `/effort <level>` into every open session. Effort also updates the global `effortLevel` in `~/.claude/settings.json` so it sticks for new sessions too. New `commandStaggerSeconds` setting (default 8s) controls the pace, separate from the (much slower) resume stagger.
- **Fixed token counts inflated ~2-3x.** Claude Code writes one API turn as multiple consecutive transcript lines (one per content block) and stamps the identical `usage` object on each; the scanner summed every line. Turns are now deduped by `requestId` (fallback `message.id`), with the dedup key persisted per file in `token-offsets.json` so it survives incremental scans. The bucket store version was bumped to v3 — old inflated buckets are wiped so 5H TOK / Tokens 5h·7d start honest instead of mixing old inflated data with correct new data.
- **Fixed CPU/MEM only measuring the top-level `claude` pid.** Each session spawns ~14 MCP-server children plus tool subprocesses (measured: 391MB shown vs 963MB real). One system-wide `ps -axo pid=,ppid=,pcpu=,rss=` snapshot per tick now feeds a ppid-tree walk (`subtreeTotals`) that sums each session's whole process subtree.
- **Cost estimate now bills cache-read tokens** (~10% of input price) — previously omitted entirely even though cache reads dominate token volume. Cache reads stay excluded from the headline 5H TOK number, which tracks what counts toward rate limits.

## 1.9.5

- Removed the "Usage over time" line chart. The gauges answer "where am I now", the burn-rate line under the 5h gauge answers "when do I run out" (it still works — the history series is kept and the projection is computed from it), and the chart answered neither well enough to earn its space. The panel is now: gauges + burn line + one token line + collapsible Sessions/Models.

## 1.9.4

- Compact gauges: each 5h/7d/per-model gauge is two lines now — the used % and the reset countdown sit on the label line, and the separate "% left" line (which just restated 100-used) is gone. The in-panel "Refresh usage" button was removed too; the ⟳ icon in the view title bar does the same job. Together with tighter spacing this cuts the always-visible part of the usage panel by roughly a third.

## 1.9.3

- Each session row shows its reasoning effort again, in a dedicated `eff` column next to the model (user preference; 1.7.3 had folded it into the header). The meta strip keeps the value for narrow panels where the column is hidden. Effort is still sourced from the global `effortLevel` setting — transcripts carry no per-session effort — so rows differ only after the setting changes between sessions.

## 1.9.2

- The usage panel now folds: "Usage over time", "Sessions (5h tokens)" and "Models (7d share)" are collapsible sections (click the header; state is remembered). Models starts collapsed, and a collapsed header shows its key figure inline (top session / top model). Token usage shrank to a single "Tokens · 5h X · 7d Y" line. Net effect: the panel fits in well under half the sidebar by default, and one click per section takes it down to headers only.

## 1.9.1

- Removed the 48h hourly token bar chart from the usage panel — it took vertical space without informing any decision (same reasoning as the 1.7.0 heatmap removal). The Last 5h / Last 7d totals stay.

## 1.9.0

- **The session list is a real table now.** The Sessions view moved from a native tree to a data grid: fixed column tracks (state · session · 5h tok · % · model · dir · age · cpu · mem), all numerics in the editor's monospace with tabular figures and right alignment — values update strictly in place, nothing dances. Each row's token cell carries a hairline bar showing that chat's share of the machine's 5h total (the top consumer's bar is highlighted), CPU hogs tint red, stalled workers get a warning ring on their state dot, and low-priority columns collapse first on narrow panels.
- Row interactions: click (or Enter) jumps to the session's tab; hover shows per-row actions (open transcript, kill process, remove ended). The needs-you Activity Bar badge and all title-bar buttons (Resume All, filters, Clear Ended) work as before.
- Removed: the figure-space padding workaround from 1.8.1 (superseded by real columns) and the tree-only right-click menu (replaced by in-row actions).

## 1.8.1

- Stable session rows: every number in a row (5h tokens, share %, age, CPU%, RAM) is now padded to a fixed width with figure spaces, and the fastest-changing segment (CPU/RAM) moved to the end of the row — values update in place instead of making the whole row jump around. The panel header's total-load numbers got the same treatment.

## 1.8.0

- **Multiple Claude accounts.** Switch Claude Code logins once and the panel remembers both accounts:
  - Clickable account pills at the top of the Usage limits view show each account (green dot = active login); click to flip the gauges, history chart, and burn-rate projection to that account.
  - The non-active account keeps refreshing in the background with its stored token (slower cadence, shared across windows); when that token expires, the pill shows ⚠ and the panel keeps last-known data with an honest note — its reset countdown still ticks.
  - Access tokens live in VS Code Secret Storage (your OS keychain), identity in `~/.claude/session-monitor/accounts.json`; per-account history/snapshots are kept separate. Disable via `claudeSessionMonitor.trackAllAccounts` (untrusted-workspace restricted); a new **Claude Sessions: Forget Other Accounts** command deletes stored tokens.
  - The terminal statusline now tags its history samples with the account uuid so charts stay correctly attributed after a login switch (re-run `scripts/install.sh` to pick up the updated `statusline.sh`).
- **Per-session token visibility.** Each session row now shows its 5h token spend and share of the machine total (`💸 2.1M (12%)` on the top consumer), and the Usage limits view gains a **Sessions (5h tokens)** breakdown with bars — so it is finally obvious which chat is eating the limit.
- **Finer usage gauges.** The 5h/7d bars went from 10 coarse blocks to 20 segments with fractional fill (single-percent resolution), and sub-10% values show one decimal.
- **Better usage chart.** Gridlines at 25/50/75%, a soft area fill under the 5h line, a data time-span label, and friendlier "updated Xm ago" ages.

## 1.7.4

- Tuned the row layout for narrow side panels, where long rows were cut off before the model was visible:
  - The per-row status word is dropped when it just restates the group header (every row under "Your turn" no longer repeats "your turn", every row under "Working" no longer repeats "working"). Informative statuses (`working (stalled?)`, `session limit`, `rate limited`, `API error`) are still shown.
  - The model is now first in the row description, so it survives a right-edge truncation: `resume · Opus 4.8 · 10m · glossgo-be · CPU 5% · 375MB`.
  - Session titles are truncated a bit shorter (24 chars) to leave room for the description; the full title stays in the tooltip.

## 1.7.3

- Refined the model/effort display added in 1.7.2:
  - Each row now shows only the **model** (which varies per session), formatted as e.g. `Opus 4.8` / `Haiku 4.5` / `Fable 5` instead of `Opus 4 8`.
  - The reasoning **effort** is a single global setting shared by every session, so it is now shown once in the view header (`total load: … · effort xhigh`) rather than repeated identically on every row. Both still appear in each row's tooltip.
  - Placeholder `<synthetic>` models are ignored: Claude Code stamps that on locally-injected lines (API-error notices, "out of credits"), so a row now keeps showing its last real model instead of `<synthetic>`.

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
