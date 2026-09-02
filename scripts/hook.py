#!/usr/bin/env python3
"""
Claude Code + Codex session-monitor hook.

Invoked by lifecycle hooks and writes a small provider-scoped status file:
  - Claude: ~/.claude/session-monitor/<session_id>.json
  - Codex:  ~/.codex/session-monitor/<session_id>.json

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
import re
import json
import time
import subprocess
import tempfile
from datetime import datetime, timezone

try:
    import fcntl
except ImportError:  # Windows: unique temp files still prevent corrupt JSON.
    fcntl = None


def find_session_pid(provider):
    """Find a dedicated session process. Shared Codex app-server processes are
    intentionally excluded because attributing their CPU/RAM to every thread
    would multiply the totals."""
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
        low = cmd.lower()
        if provider == "claude":
            if "anthropic.claude-code" in low and "resources" in low:
                return cur
        elif provider == "codex":
            if "app-server" in low:
                return None
            first = low.split(None, 1)[0] if low else ""
            if os.path.basename(first) == "codex":
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
    "PermissionRequest": "waiting",
    "SessionEnd": "ended",
}


def detect_provider(data):
    explicit = data.get("provider")
    if explicit in ("claude", "codex"):
        return explicit
    transcript = data.get("transcript_path")
    if isinstance(transcript, str):
        normalized = transcript.replace("\\", "/")
        if "/.codex/" in normalized:
            return "codex"
        if "/.claude/" in normalized:
            return "claude"
    # `model` is a documented Codex-specific hook extension.
    if isinstance(data.get("model"), str) and data.get("hook_event_name"):
        return "codex"
    return "claude"


def main() -> None:
    raw = ""
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""

    try:
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        data = {}

    event = sys.argv[1] if len(sys.argv) > 1 else data.get("hook_event_name") or "?"
    provider = detect_provider(data)
    session_id = data.get("session_id") or "unknown"
    if session_id == "unknown":
        # Without a session id we cannot key the status file usefully.
        return

    # session_id becomes a filename below; reject anything that could escape the
    # monitor directory (path traversal / separators). Real ids are UUIDs.
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", session_id) or session_id in (".", ".."):
        return

    # Skip claude-mem observer / SDK-subagent sessions: they are not user tabs
    # and the extension filters them anyway. Keeps the monitor dir clean.
    cwd = data.get("cwd") or ""
    if "observer-sessions" in cwd or ".claude-mem" in cwd:
        return

    mon_dir = os.path.join(os.path.expanduser("~"), "." + provider, "session-monitor")
    try:
        os.makedirs(mon_dir, mode=0o700, exist_ok=True)
        os.chmod(mon_dir, 0o700)
    except Exception:
        return

    now = time.time()
    record = {
        "session_id": session_id,
        "provider": provider,
        "state": EVENT_STATE.get(event, "unknown"),
        "event": event,
        "ts": now,  # epoch seconds, used by the extension for recency compare
        "iso": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "cwd": data.get("cwd"),
        "transcript_path": data.get("transcript_path"),
        "permission_mode": data.get("permission_mode"),
    }
    if provider == "codex":
        record["model"] = data.get("model")
        record["turn_id"] = data.get("turn_id")

    # Event-specific extras (kept small).
    if event == "Notification":
        msg = data.get("message")
        if isinstance(msg, str):
            record["message"] = msg[:300]
        record["notif_type"] = data.get("type")
    elif event == "PermissionRequest":
        tool = data.get("tool_name")
        if isinstance(tool, str):
            record["message"] = "permission: " + tool[:100]
    elif event == "UserPromptSubmit":
        prompt = data.get("prompt")
        if provider == "claude" and isinstance(prompt, str):
            record["prompt"] = prompt[:200]
    elif event == "SessionStart":
        record["source"] = data.get("source")
    elif event == "Stop":
        record["stop_reason"] = data.get("stop_reason")
    elif event == "SessionEnd":
        record["reason"] = data.get("reason")

    # SessionEnd has no actionable process left (ended rows cannot be killed)
    # and is the most important state to persist before the runner's short
    # timeout. Avoid the up-to-2s process-tree scan on this path.
    pid = None if event == "SessionEnd" else find_session_pid(provider)
    if pid:
        record["pid"] = pid

    final = os.path.join(mon_dir, "{0}.json".format(session_id))
    tmp = None
    try:
        # mkstemp is unique and 0600, so concurrent hook invocations cannot
        # interleave through the old shared ".<session>.tmp" pathname.
        fd, tmp = tempfile.mkstemp(
            prefix=".{0}.".format(session_id),
            suffix=".tmp",
            dir=mon_dir,
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(record, fh)
            fh.flush()
            os.fsync(fh.fileno())

        # Serialize the tiny compare-and-replace section. This prevents an older
        # event that finishes late from overwriting a newer state. fcntl is
        # available on macOS/Linux; Windows still gets unique atomic writes.
        lock_path = os.path.join(mon_dir, ".write.lock")
        lock_fd = os.open(
            lock_path,
            os.O_CREAT | os.O_RDWR,
            0o600,
        )
        try:
            os.fchmod(lock_fd, 0o600)
        except (AttributeError, OSError):
            pass
        with os.fdopen(lock_fd, "a+") as lock:
            if fcntl is not None:
                deadline = time.monotonic() + 1.0
                while True:
                    try:
                        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise TimeoutError("status write lock timed out")
                        time.sleep(0.01)
            existing_ts = 0
            try:
                with open(final, encoding="utf-8") as current:
                    existing = json.load(current)
                if isinstance(existing, dict):
                    existing_ts = float(existing.get("ts") or 0)
            except Exception:
                existing_ts = 0
            if existing_ts <= now:
                os.replace(tmp, final)
                tmp = None
                os.chmod(final, 0o600)
            if fcntl is not None:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except Exception:
        pass
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except Exception:
                pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Absolutely never fail the hook.
        pass
    sys.exit(0)
