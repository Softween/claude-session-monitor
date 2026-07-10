#!/usr/bin/env python3
"""
Claude Code session-monitor hook.

Invoked by Claude Code hooks (SessionStart, UserPromptSubmit, Stop, Notification,
SessionEnd). Reads the hook's stdin JSON and writes a small per-session status
file to ~/.claude/session-monitor/<session_id>.json that the VS Code
"Claude Session Monitor" extension reads.

Contract (CRITICAL):
  - MUST be fast and side-effect free with respect to the session.
  - MUST write nothing to stdout (would be parsed as a hook decision).
  - MUST always exit 0 (a non-zero exit on Stop/UserPromptSubmit can block the
    turn). Every code path is wrapped so failure can never propagate.

Not hooked: PreToolUse (RTK rewrites Bash there) and PostToolUse (fires per tool;
we avoid the per-tool latency). Liveness + "limited" detection are derived by the
extension from the transcript instead.
"""
import sys
import os
import json
import time
import subprocess
from datetime import datetime, timezone


def find_session_pid():
    """Walk the process tree up from this hook to the Claude Code session
    worker process (its command contains the extension's resources path) so the
    extension can read that PID's CPU%/RAM. Best-effort; returns None on failure."""
    try:
        out = subprocess.run(
            ["ps", "-Ao", "pid=,ppid=,command="],
            capture_output=True, text=True, timeout=2,
        ).stdout
    except Exception:
        return None
    info = {}
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 2)
        if len(parts) < 2:
            continue
        try:
            pid = int(parts[0])
            ppid = int(parts[1])
        except Exception:
            continue
        info[pid] = (ppid, parts[2] if len(parts) > 2 else "")
    cur = os.getpid()
    for _ in range(12):
        entry = info.get(cur)
        if not entry:
            break
        ppid, cmd = entry
        if "anthropic.claude-code" in cmd and "resources" in cmd:
            return cur
        if ppid <= 1 or ppid == cur:
            break
        cur = ppid
    return None

# Map hook event -> coarse session state.
#   working : actively processing a turn
#   idle    : finished a turn / fresh session -> your turn (calm)
#   waiting : Claude needs you NOW (permission / idle-input notification)
#   ended   : session closed
EVENT_STATE = {
    "SessionStart": "idle",
    "UserPromptSubmit": "working",
    "Stop": "idle",
    "Notification": "waiting",
    "SessionEnd": "ended",
}


def main() -> None:
    event = sys.argv[1] if len(sys.argv) > 1 else "?"

    raw = ""
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""

    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    session_id = data.get("session_id") or "unknown"
    if session_id == "unknown":
        # Without a session id we cannot key the status file usefully.
        return

    # Skip claude-mem observer / SDK-subagent sessions: they are not user tabs
    # and the extension filters them anyway. Keeps the monitor dir clean.
    cwd = data.get("cwd") or ""
    if "observer-sessions" in cwd or ".claude-mem" in cwd:
        return

    mon_dir = os.path.join(os.path.expanduser("~"), ".claude", "session-monitor")
    try:
        os.makedirs(mon_dir, exist_ok=True)
    except Exception:
        return

    now = time.time()
    record = {
        "session_id": session_id,
        "state": EVENT_STATE.get(event, "unknown"),
        "event": event,
        "ts": now,  # epoch seconds, used by the extension for recency compare
        "iso": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "cwd": data.get("cwd"),
        "transcript_path": data.get("transcript_path"),
        "permission_mode": data.get("permission_mode"),
    }

    # Event-specific extras (kept small).
    if event == "Notification":
        msg = data.get("message")
        if isinstance(msg, str):
            record["message"] = msg[:300]
        record["notif_type"] = data.get("type")
    elif event == "UserPromptSubmit":
        prompt = data.get("prompt")
        if isinstance(prompt, str):
            record["prompt"] = prompt[:200]
    elif event == "SessionStart":
        record["source"] = data.get("source")
    elif event == "Stop":
        record["stop_reason"] = data.get("stop_reason")
    elif event == "SessionEnd":
        record["reason"] = data.get("reason")

    pid = find_session_pid()
    if pid:
        record["pid"] = pid

    tmp = os.path.join(mon_dir, ".{0}.tmp".format(session_id))
    final = os.path.join(mon_dir, "{0}.json".format(session_id))
    try:
        with open(tmp, "w") as fh:
            json.dump(record, fh)
        os.replace(tmp, final)  # atomic
    except Exception:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except Exception:
            pass
        return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Absolutely never fail the hook.
        pass
    sys.exit(0)
