#!/usr/bin/env bash
#
# Installs the Agent Session Monitor hook layer:
#   - copies hook.py + statusline.sh into ~/.claude/session-monitor/
#   - merges Claude hooks into ~/.claude/settings.json
#   - merges Codex hooks into ~/.codex/hooks.json
#
# Existing hook command strings are preserved. Bounded timeout migration can
# still change Codex's hook-definition hash, so every hook reported as added or
# modified must be reviewed in Codex via /hooks after installation.
#
# Usage:  bash scripts/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HOME/.claude/session-monitor"
CODEX_DEST="$HOME/.codex/session-monitor"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  echo "python3 not found in PATH. Add the hooks manually (see README)."
  exit 1
fi

"$PY" - "$DIR" "$PY" "$DEST" "$CODEX_DEST" <<'PYEOF'
import json, os, shlex, sys, shutil, tempfile, time
source_dir, py, dest, codex_dest = sys.argv[1:5]
stamp = str(time.time_ns())
mark = "session-monitor/hook.py"

def load(file):
    if not os.path.exists(file):
        return {}
    try:
        with open(file, encoding="utf-8") as fh:
            value = json.load(fh)
    except Exception as exc:
        raise ValueError(f"{file} is not valid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"{file} must contain a JSON object")
    hooks = value.get("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError(f"{file}: hooks must be a JSON object")
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            raise ValueError(f"{file}: hooks.{event} must be an array")
        for group in groups:
            if not isinstance(group, dict) or not isinstance(group.get("hooks", []), list):
                raise ValueError(f"{file}: hooks.{event} contains an invalid hook group")
            for handler in group.get("hooks", []):
                if not isinstance(handler, dict):
                    raise ValueError(f"{file}: hooks.{event} contains an invalid handler")
                if "command" in handler and not isinstance(handler["command"], str):
                    raise ValueError(f"{file}: hooks.{event} handler command must be a string")
    return value

def cmd(ev):
    command = " ".join(shlex.quote(part) for part in (py, hook, ev))
    return {"type": "command", "command": command}

def matching(hooks, ev):
    out = []
    for g in hooks.get(ev, []):
        for h in g.get("hooks", []):
            if mark in h.get("command", ""):
                out.append(h)
    return out

def install_file(source, target, mode):
    """Atomically install a private file without following a target symlink."""
    target_dir = os.path.dirname(target)
    fd, tmp = tempfile.mkstemp(
        prefix=".agent-session-monitor-install.",
        suffix=".tmp",
        dir=target_dir,
    )
    try:
        with open(source, "rb") as src, os.fdopen(fd, "wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, target)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def merge(file, cfg, wanted):
    hooks = cfg.setdefault("hooks", {})
    added = []
    timeout_updates = []
    for ev, base in wanted.items():
        desired_timeout = 3 if ev == "SessionEnd" else 5
        handlers = matching(hooks, ev)
        if handlers:
            for handler in handlers:
                if handler.get("timeout") != desired_timeout:
                    handler["timeout"] = desired_timeout
                    timeout_updates.append(ev)
        else:
            group = dict(base)
            handler = cmd(ev)
            handler["timeout"] = desired_timeout
            group["hooks"] = [handler]
            hooks.setdefault(ev, []).append(group)
            added.append(ev)
    if added or timeout_updates:
        target = os.path.realpath(file) if os.path.islink(file) else file
        if os.path.exists(file):
            shutil.copy2(target, file + ".bak.asm." + stamp)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".agent-session-monitor.", suffix=".tmp", dir=os.path.dirname(target))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(cfg, fh, indent=2, ensure_ascii=False)
                fh.write("\n")
                fh.flush()
                os.fsync(fh.fileno())
            if os.path.exists(target):
                os.chmod(tmp, os.stat(target).st_mode & 0o777)
            os.replace(tmp, target)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    changes = []
    if added:
        changes.append("added " + ", ".join(added))
    if timeout_updates:
        changes.append("bounded timeout " + ", ".join(sorted(set(timeout_updates))))
    print("Merged hooks into", file, "->", "; ".join(changes) or "(already present)")

hook = os.path.join(dest, "hook.py")
claude = {
    "SessionStart": {"matcher": "startup|resume|clear|compact"},
    "UserPromptSubmit": {},
    "Stop": {},
    "Notification": {},
    "SessionEnd": {},
}
codex = {
    "SessionStart": {"matcher": "startup|resume|clear|compact"},
    "UserPromptSubmit": {},
    "Stop": {},
    "PermissionRequest": {},
    "SessionEnd": {},
}
home = os.path.expanduser("~")
claude_file = os.path.join(home, ".claude", "settings.json")
codex_file = os.path.join(home, ".codex", "hooks.json")

# Validate every target before changing either one. A malformed config is user
# data that must be repaired manually; never replace it with a hooks-only file.
try:
    claude_cfg = load(claude_file)
    codex_cfg = load(codex_file)
except ValueError as exc:
    print("Refusing to modify hook settings:", exc, file=sys.stderr)
    sys.exit(2)

# Only after both configs pass validation do we mutate the installed scripts or
# permissions. This keeps malformed user configuration completely fail-closed.
for monitor_dir in (dest, codex_dest):
    os.makedirs(monitor_dir, mode=0o700, exist_ok=True)
    os.chmod(monitor_dir, 0o700)
    for name in os.listdir(monitor_dir):
        status_file = os.path.join(monitor_dir, name)
        # Keep every monitor-owned data/debug file private. Avoid following an
        # unexpected symlink; hook.py/statusline.sh are replaced atomically below.
        if os.path.isfile(status_file) and not os.path.islink(status_file):
            os.chmod(status_file, 0o600)
install_file(os.path.join(source_dir, "hook.py"), hook, 0o600)
install_file(os.path.join(source_dir, "statusline.sh"), os.path.join(dest, "statusline.sh"), 0o700)
print("Copied hook.py + statusline.sh to", dest)

merge(claude_file, claude_cfg, claude)
merge(codex_file, codex_cfg, codex)
PYEOF

echo "Done. In Codex, run /hooks and review every Agent Session Monitor hook shown as added or modified. Then reload VS Code."
