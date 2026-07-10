#!/usr/bin/env bash
#
# Installs the Claude Session Monitor hook layer:
#   - copies hook.py + statusline.sh into ~/.claude/session-monitor/
#   - merges the 5 status hooks into ~/.claude/settings.json (idempotent, backed up)
#
# The hooks let the extension show "waiting for you" + per-session CPU/RAM.
# The official 5h/7d usage gauges work without any hook (the extension calls the
# usage API directly). statusline.sh is optional and only used as a fallback for
# terminal Claude users; this script does NOT wire it up automatically.
#
# Usage:  bash scripts/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/session-monitor"
mkdir -p "$DEST"
cp "$DIR/hook.py" "$DEST/hook.py"
cp "$DIR/statusline.sh" "$DEST/statusline.sh"
chmod +x "$DEST/statusline.sh"
echo "Copied hook.py + statusline.sh to $DEST"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 not found in PATH. Add the hooks manually (see README)."
  exit 1
fi

"$PY" - "$PY" "$DEST" <<'PYEOF'
import json, os, sys, shutil, time
py, dest = sys.argv[1], sys.argv[2]
settings = os.path.join(os.path.expanduser("~"), ".claude", "settings.json")
cfg = {}
if os.path.exists(settings):
    shutil.copy2(settings, settings + ".bak.csm." + str(int(time.time())))
    try:
        cfg = json.load(open(settings))
    except Exception:
        cfg = {}
hooks = cfg.setdefault("hooks", {})
hook = os.path.join(dest, "hook.py")
mark = "session-monitor/hook.py"

def cmd(ev):
    return {"type": "command", "command": f"{py} {hook} {ev}"}

def has(ev):
    for g in hooks.get(ev, []):
        for h in g.get("hooks", []):
            if mark in h.get("command", ""):
                return True
    return False

new = {
    "SessionStart": {"matcher": "startup|resume|clear|compact"},
    "UserPromptSubmit": {},
    "Stop": {},
    "Notification": {},
    "SessionEnd": {},
}
added = []
for ev, base in new.items():
    if has(ev):
        continue
    g = dict(base)
    g["hooks"] = [cmd(ev)]
    hooks.setdefault(ev, []).append(g)
    added.append(ev)

json.dump(cfg, open(settings, "w"), indent=2, ensure_ascii=False)
open(settings, "a").write("\n")
print("Merged hooks into", settings, "->", added or "(already present)")
PYEOF

echo "Done. Reload the VS Code window (Developer: Reload Window)."
