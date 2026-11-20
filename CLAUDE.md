# claude-session-monitor

## 🔴 Never ask for a restart of the working window's extensions
Do not ask Bilal to run **Restart Extensions** or **Developer: Restart Extension Host** to activate a new build, and do not ask for **Developer: Reload Window** either. Every Claude Code session's `claude` process is a child of the window's extension host, so each of them stops every session in the window. A restart of extensions is the worse one: the old Claude Code tabs stay on screen without a host, and each shows "Claude Code stopped responding in this tab" when it is next selected, until Claude Code reopens its conversation in a new tab. That happened on 2026-11-20 at 02:52 after a session asked for it to activate 2.38.1 (about 20 sessions stopped, 18 tabs replaced in the next half hour).

- An installed version takes effect at the next VS Code start. Say that it is installed and inactive until then; nothing more.
- To try a build live before that, run it in a separate Extension Development Host window (`code --new-window --extensionDevelopmentPath="$PWD" <folder>`; check `~/.claude/bin/pulse status` first, a window costs memory) and close that window when done.
- Heavy commands (vitest, tsc, esbuild) go through the bq build queue. When it refuses for memory, open a draft pull request to `main`: `.github/workflows/ci.yml` runs typecheck, tests, build and package on it.
