# claude-session-monitor

## Never ask for a restart of the working window's extensions
Do not ask the user to run **Restart Extensions** or **Developer: Restart Extension Host** to activate a new build. Every Claude Code session's `claude` process is a child of the window's extension host, so a restart stops every session in the window, and the old Claude Code tabs stay on screen without a host: each shows "Claude Code stopped responding in this tab" when it is next selected, until Claude Code reopens its conversation in a new tab. On 2026-11-20 one such restart, asked for to activate 2.38.1, stopped about 20 sessions and replaced 18 tabs in the next half hour.

- An installed version takes effect at the next VS Code start. Say so and leave the timing to the user.
- If the user wants it active now anyway, recommend **Developer: Reload Window**, never Restart Extensions: a reload stops the sessions too, but their tabs come back clean as they are shown.
- To try a build live first, run it in a separate Extension Development Host window (`code --new-window --extensionDevelopmentPath="$PWD" <folder>`) and close that window when done.
- When the tests cannot run locally (for example for lack of memory), open a draft pull request to `main`: `.github/workflows/ci.yml` runs typecheck, tests, build and package on it.
