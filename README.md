<div align="center">

# Claude Session Monitor

**See every Claude Code session at a glance — which is working, which is waiting for you, which hit a limit — plus per-session CPU/RAM and your real 5h / 7d usage budget.**

[![Marketplace](https://img.shields.io/visual-studio-marketplace/v/softween.claude-code-session-monitor?label=Marketplace&color=3794ff)](https://marketplace.visualstudio.com/items?itemName=softween.claude-code-session-monitor)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/softween.claude-code-session-monitor?color=3fb950)](https://marketplace.visualstudio.com/items?itemName=softween.claude-code-session-monitor)
[![CI](https://github.com/Softween/claude-session-monitor/actions/workflows/ci.yml/badge.svg)](https://github.com/Softween/claude-session-monitor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<img src="https://raw.githubusercontent.com/Softween/claude-session-monitor/main/media/hero.png" alt="Claude Session Monitor panel" width="380">

</div>

## Why

When you run 10-15 Claude Code tabs at once, you lose track of which one is busy,
which finished and needs your input, and which quietly hit a rate limit. And you
can't see how much of your 5-hour / weekly budget is left until you get throttled.

Claude Session Monitor puts all of that in one Activity Bar panel, live.

## Features

- **Live session list, grouped by state** — Limited / Waiting for you / Your turn /
  Working / Ended. Titles match your tabs; updates in real time.
- **Per-session CPU% + RAM** — see exactly which session is hammering your machine,
  with a total at the top and a 🔥 on CPU hogs. *(macOS/Linux)*
- **Official usage budget** — real **Session (5h)** and **Weekly (7d)** gauges with
  fine-grained 20-segment bars, **% used**, **% left**, and a reset countdown, pulled
  from your own account. Plus a **usage-over-time chart** (gridlines + burn-rate
  projection) and a **token-usage trend** (rolling 5h / 7d) with an hourly chart.
  *(official gauges: macOS)*
- **Multiple accounts** — switch Claude Code logins and the panel remembers each
  account: click the account pills to flip between their gauges, see which login is
  active (green dot), and keep watching the other account's reset countdown while
  you work on this one. *(macOS; see Privacy)*
- **Per-session token spend** — every session row shows its 5h tokens and share of
  the machine total (`2.1M (12%)`), the top consumer gets a 💸, and the usage panel
  lists the top sessions with bars — so "which chat is eating my limit" has an answer.
- **Notifications** — in-VS-Code toasts and native macOS notifications the moment a
  session needs you or hits a limit (even when VS Code isn't focused).
- **Stuck-session alert** — flags a "working" session that has gone silent too long.
- **Staggered Resume All** — after an internet drop, resume every session
  automatically, spaced one per minute so you don't trip the rate limit by resuming
  all at once. Fully automated via keystrokes (no manual typing). *(macOS)*
- **Quality of life** — Activity Bar badge for sessions needing you, a "needs-you
  only" filter, jump to a session's tab on click, and one-click clear/remove of
  ended sessions.

## Install

### From the Marketplace

Search **"Claude Session Monitor"** in the Extensions view, or:

```bash
code --install-extension softween.claude-code-session-monitor
```

### Hook layer (one command)

The status list and per-session CPU/RAM use a tiny hook layer. Run once:

```bash
git clone https://github.com/Softween/claude-session-monitor.git
bash claude-session-monitor/scripts/install.sh
```

This copies `hook.py` into `~/.claude/session-monitor/` and merges five status hooks
(SessionStart / UserPromptSubmit / Stop / Notification / SessionEnd) into
`~/.claude/settings.json` (idempotent, with a backup). Reload the VS Code window.

> The official 5h/7d usage gauges need **no hook** — the extension reads them
> directly. Auto-resume needs a one-time macOS **Accessibility** permission for VS
> Code (System Settings > Privacy & Security > Accessibility).

## How it works

A pure, `vscode`-free data layer merges three sources per session:

1. **Hook status files** (`~/.claude/session-monitor/<id>.json`) for live state
   ("waiting for you" is only knowable here) and the session's worker PID (for CPU/RAM).
2. **Transcript tail** (`~/.claude/projects/.../<id>.jsonl`) for the title, newest
   conversational state, limit detection, and the token-usage trend. Only interactive
   sessions (`entrypoint = claude-vscode | cli`) are shown.
3. **Official account usage** from `api.anthropic.com/api/oauth/usage`, using your
   Claude OAuth token from the macOS keychain (`Claude Code-credentials`).

### Privacy

- No telemetry. Nothing is sent anywhere except a **read-only GET of your own account
  usage** to Anthropic (the same call the Claude app makes), and only on macOS.
- The keychain token is read locally to authorize that call and is never logged.
- **Multi-account**: with `trackAllAccounts` on (default), each login's access token
  is kept in **VS Code Secret Storage** (your OS keychain — same protection as the
  original) so the panel can keep refreshing the account you logged out of; account
  identity (uuid + email) lives in `~/.claude/session-monitor/accounts.json`. Tokens
  never touch plain files or logs. Disable the setting to stop this, and run
  **Claude Sessions: Forget Other Accounts** to delete anything already stored.
- CPU/RAM come from a local `ps`; auto-resume uses local `osascript` keystrokes.

## Configuration

All settings are under `claudeSessionMonitor.*`:

| Setting | Default | Description |
|---|---|---|
| `notifyOnWaiting` | `true` | Notify when a session starts waiting for you |
| `notifyOnLimited` | `true` | Notify when a session hits a limit |
| `notifyOnDone` | `false` | Notify when a session finishes its turn |
| `nativeNotifications` | `true` | Native macOS notification on limit/waiting |
| `stuckAlertMinutes` | `5` | Alert when a working session is silent this long (0 = off) |
| `cpuHogThreshold` | `60` | CPU% above which a session is flagged 🔥 |
| `resumeAutoType` | `true` | Auto-type resume + Enter (needs Accessibility) |
| `resumePrompt` | `"resume"` | Text typed during a resume sweep |
| `resumeStaggerSeconds` | `60` | Seconds between sessions in a resume sweep |
| `resourceSampleMs` | `3000` | CPU/RAM sampling interval |
| `pollIntervalMs` | `1500` | Status refresh interval |
| `recentScanMaxAgeHours` | `6` | Show sessions active within the last N hours |
| `hideEndedAfterMinutes` | `30` | Hide ended sessions after this long |
| `workspaceOnly` | `false` | Only show this workspace's sessions |
| `trackAllAccounts` | `true` | Remember each Claude login + refresh non-active accounts in the background |

## Platform support

| Feature | macOS | Linux | Windows |
|---|:---:|:---:|:---:|
| Session list + state + token usage | ✅ | ✅ | ✅ |
| Per-session CPU / RAM | ✅ | ✅ | ⚠️ |
| Official 5h / 7d usage gauges | ✅ | ➖ | ➖ |
| Native notifications + auto-resume | ✅ | ➖ | ➖ |

Cross-platform support for the macOS-only pieces is welcome via PRs.

## Development

```bash
npm install
npm run build      # esbuild bundle
npm run watch      # rebuild on change
npm run verify     # run the core data layer against your real transcripts
npm run package    # build a .vsix
```

## License

[MIT](LICENSE) © Softween
