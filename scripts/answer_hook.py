#!/usr/bin/env python3
"""
AskUserQuestion hook of the session monitor, LOG-ONLY mode (Agent Fleet spike E1.2).

Registered for PreToolUse and PermissionRequest with the matcher `AskUserQuestion`.
Each call appends one JSON line to ~/.claude/session-monitor/answer-hook.log (0600,
rotated to answer-hook.log.1 past 1 MB): when the event fired, which event, the
session, the tool_use_id (PreToolUse only; PermissionRequest carries none), the
permission mode, the entrypoint, how many questions and a short hash of their
text. No question, option or answer text is logged.

Contract (CRITICAL):
  - MUST write nothing to stdout: a silent hook leaves the call to the normal
    flow (PreToolUse proceeds, PermissionRequest falls back to the dialog).
  - MUST always exit 0 and return within 50 ms; every failure is swallowed.
  - stdlib only.
"""
import hashlib
import json
import os
import sys
import time

START = time.monotonic()
LOG_MAX = 1024 * 1024


def log_path():
    return os.path.join(os.path.expanduser("~"), ".claude", "session-monitor", "answer-hook.log")


def record(data):
    """The log line for one hook call; only ids, counts and a hash of the question text."""
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    questions = tool_input.get("questions") if isinstance(tool_input.get("questions"), list) else []
    texts = [str(q.get("question") or "") for q in questions if isinstance(q, dict)]
    now = time.time()
    line = {
        "ts": round(now, 3),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % int(now % 1 * 1000),
        "event": data.get("hook_event_name") or (sys.argv[1] if len(sys.argv) > 1 else "?"),
        "tool": data.get("tool_name"),
        "session_id": data.get("session_id"),
        "tool_use_id": data.get("tool_use_id"),
        "permission_mode": data.get("permission_mode"),
        "entrypoint": os.environ.get("CLAUDE_CODE_ENTRYPOINT"),
        "questions": len(texts),
        "qhash": hashlib.sha1("\n".join(texts).encode("utf-8", "replace")).hexdigest()[:12] if texts else None,
        "ppid": os.getppid(),
    }
    line["ms"] = round((time.monotonic() - START) * 1000, 1)
    return line


def append(line):
    path = log_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    try:
        if os.path.getsize(path) > LOG_MAX:
            os.replace(path, path + ".1")
    except OSError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, (json.dumps(line, separators=(",", ":")) + "\n").encode("utf-8"))
    finally:
        os.close(fd)


def main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    if isinstance(data, dict) and data:
        append(record(data))


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Fail open: never block, never answer, never fail the tool call.
        pass
    sys.exit(0)
