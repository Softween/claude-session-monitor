#!/usr/bin/env python3
"""
AskUserQuestion hook of the session monitor: answer a question from the phone (Agent Fleet E3.3).

Registered with the matcher `AskUserQuestion` for PreToolUse (log only, timeout 5) and
PermissionRequest (timeout 610). Every call appends one JSON line to
~/.claude/session-monitor/answer-hook.log (0600, rotated to .1 past 1 MB): the event, session,
tool_use_id, permission mode, entrypoint, question count and a short hash of the question text,
never the text. Answer-mode steps add a line with `phase`.

ANSWER mode runs for PermissionRequest only, and only in a canUseTool host
(CLAUDE_CODE_ENTRYPOINT claude-vscode or sdk-*), where the desk dialog stays open next to the
hook and whichever answers first applies:
  1. writes ~/.claude/session-monitor/answers/<session_id>.waiting.json (0600, dir 0700): the
     questions (text, header, option labels, multiSelect), the hook's pid, a nonce, the tool
     use id once the transcript shows it, started and deadline = started + 600 s
  2. about every second reads <session_id>.answer.json; one with the marker's nonce and an
     answer for every question text makes it print the allow decision with updatedInput
     {questions (as asked), answers}, remove both files and exit
  3. the question's tool_result in the transcript (answered at the desk), the deadline, a
     signal, or a marker that is no longer its own: removes its marker, exits 0 silently
A `cli` session (its terminal may hold the dialog for the hook), any other event or tool, or
answers/off present: log only.

Contract: fail open everywhere (any error = exit 0 without output; the dialog decides);
nothing on stdout but the one decision; stdlib only.
"""
import datetime
import hashlib
import json
import os
import re
import secrets
import signal
import sys
import tempfile
import time

START = time.monotonic()
LOG_MAX = 1024 * 1024
WAIT_S, POLL_S = 600, 1.0  # --wait / --poll override them (tests)
SID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,128}$")
TAIL_BYTES = 512 * 1024
RECENT_S = 300  # an AskUserQuestion written longer before the hook started is an earlier question
ANSWER_MAX = 2000
CONTROL = re.compile(r"[\x00-\x1f\x7f]")


def monitor_dir():
    return os.path.join(os.path.expanduser("~"), ".claude", "session-monitor")


def record(data, **extra):
    """The log line for one hook call or answer step; only ids, counts and a hash of the question text."""
    tool_input = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else {}
    questions = tool_input.get("questions") if isinstance(tool_input.get("questions"), list) else []
    texts = [str(q.get("question") or "") for q in questions if isinstance(q, dict)]
    now = time.time()
    line = {
        "ts": round(now, 3),
        "iso": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(now)) + ".%03dZ" % int(now % 1 * 1000),
        "event": data.get("hook_event_name") or "?",
        "tool": data.get("tool_name"),
        "session_id": data.get("session_id"),
        "tool_use_id": data.get("tool_use_id"),
        "permission_mode": data.get("permission_mode"),
        "entrypoint": os.environ.get("CLAUDE_CODE_ENTRYPOINT"),
        "questions": len(texts),
        "qhash": hashlib.sha1("\n".join(texts).encode("utf-8", "replace")).hexdigest()[:12] if texts else None,
        "ppid": os.getppid(),
    }
    line.update(extra)
    line["ms"] = round((time.monotonic() - START) * 1000, 1)
    return line


def append(line):
    path = os.path.join(monitor_dir(), "answer-hook.log")
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


def log(data, **extra):
    try:
        append(record(data, **extra))
    except Exception:
        pass


def read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json(path, obj):
    """Atomic 0600 write (mkstemp in the same directory, then rename)."""
    fd, tmp = tempfile.mkstemp(prefix=".", suffix=".tmp", dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except BaseException:
        remove(tmp)
        raise


def remove(path):
    try:
        os.unlink(path)
    except OSError:
        pass


def questions_of(tool_input):
    """[{question, header, multiSelect, options: [labels]}] of an AskUserQuestion input; [] when malformed."""
    raw = tool_input.get("questions") if isinstance(tool_input, dict) else None
    out = []
    for q in raw if isinstance(raw, list) else []:
        if not isinstance(q, dict) or not isinstance(q.get("question"), str) or not q["question"]:
            return []
        options = q.get("options") if isinstance(q.get("options"), list) else []
        out.append({
            "question": q["question"],
            "header": str(q.get("header") or ""),
            "multiSelect": q.get("multiSelect") is True,
            "options": [o["label"] for o in options if isinstance(o, dict) and isinstance(o.get("label"), str)],
        })
    return out


def epoch(iso):
    try:
        return datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


class Transcript:
    """Follows the transcript: the current question's tool_use id (the newest AskUserQuestion with these
    question texts written at most RECENT_S before the hook started) and whether its tool_result came."""

    def __init__(self, path, texts, started):
        self.path, self.texts, self.since = path, texts, started - RECENT_S
        self.offset, self.tid, self.answered = None, None, False

    def poll(self):
        """Read what was appended since the last poll (the last 512 KB the first time), whole lines only."""
        try:
            size = os.path.getsize(self.path)
            fresh = self.offset is None or size < self.offset
            start = max(0, size - TAIL_BYTES) if fresh else self.offset
            with open(self.path, "rb") as f:
                f.seek(start)
                chunk = f.read(size - start)
        except (OSError, TypeError, ValueError):
            return
        complete = chunk[: chunk.rfind(b"\n") + 1]
        self.offset = start + len(complete)
        lines = complete.split(b"\n")
        for raw in lines[1:] if fresh and start > 0 else lines:
            if b"AskUserQuestion" in raw or b"tool_result" in raw:
                self.line(raw)

    def line(self, raw):
        try:
            d = json.loads(raw)
        except ValueError:
            return
        msg = d.get("message") if isinstance(d, dict) and isinstance(d.get("message"), dict) else {}
        blocks = [b for b in msg.get("content") or [] if isinstance(b, dict)] if isinstance(msg.get("content"), list) else []
        if d.get("type") == "assistant" and epoch(d.get("timestamp")) >= self.since:
            for b in blocks:
                if b.get("type") == "tool_use" and b.get("name") == "AskUserQuestion" and \
                        [q["question"] for q in questions_of(b.get("input"))] == self.texts:
                    self.tid, self.answered = b.get("id"), False
        elif d.get("type") == "user" and self.tid:
            if any(b.get("type") == "tool_result" and b.get("tool_use_id") == self.tid for b in blocks):
                self.answered = True


def accepted(answer, marker):
    """The answers of an answer file written for this marker (its nonce, every question text, short
    plain strings), else None."""
    if not isinstance(answer, dict) or answer.get("nonce") != marker["nonce"]:
        return None
    answers = answer.get("answers")
    texts = {q["question"] for q in marker["questions"]}
    if not isinstance(answers, dict) or set(answers) != texts:
        return None
    for value in answers.values():
        if not isinstance(value, str) or not value.strip() or len(value) > ANSWER_MAX or CONTROL.search(value):
            return None
    return answers


class Waiter:
    """One PermissionRequest waiting for the phone (see the module docstring)."""

    def __init__(self, data, adir, wait, poll):
        sid, questions = data["session_id"], questions_of(data.get("tool_input"))
        self.data, self.poll_s = data, poll
        self.marker_path = os.path.join(adir, sid + ".waiting.json")
        self.answer_path = os.path.join(adir, sid + ".answer.json")
        started = int(time.time())
        self.marker = {"v": 1, "sessionId": sid, "toolUseId": None, "pid": os.getpid(), "nonce": secrets.token_hex(8),
                       "started": started, "deadline": started + int(wait), "questions": questions}
        self.tx = Transcript(data.get("transcript_path"), [q["question"] for q in questions], started)

    def mine(self):
        current = read_json(self.marker_path)
        return isinstance(current, dict) and current.get("nonce") == self.marker["nonce"]

    def close(self, phase):
        """Remove the marker if it is still ours, log the outcome."""
        if self.mine():
            remove(self.marker_path)
        log(self.data, phase=phase)

    def run(self):
        self.tx.poll()
        self.marker["toolUseId"] = self.tx.tid
        remove(self.answer_path)  # an answer left from an earlier question is not for this one
        write_json(self.marker_path, self.marker)
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(sig, lambda *_: (self.close("signal"), os._exit(0)))
        log(self.data, phase="waiting", deadline=self.marker["deadline"])
        while time.time() < self.marker["deadline"]:
            time.sleep(self.poll_s)
            if not self.mine():
                log(self.data, phase="superseded")
                return
            self.tx.poll()
            if self.tx.answered:
                return self.close("desk")
            if self.tx.tid and self.tx.tid != self.marker["toolUseId"]:
                self.marker["toolUseId"] = self.tx.tid
                write_json(self.marker_path, self.marker)
            if self.answered():
                return
        self.close("timeout")

    def answered(self):
        """True once an answer file decided this question (printed, or the desk was faster)."""
        if not os.path.exists(self.answer_path):
            return False
        answers = accepted(read_json(self.answer_path), self.marker)
        if answers is None:
            remove(self.answer_path)  # not for this question, or malformed: the bridge may write a new one
            return False
        self.tx.poll()
        if not self.tx.answered:
            updated = dict(self.data["tool_input"])
            updated["answers"] = answers
            sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {
                "behavior": "allow", "updatedInput": updated}}}))
            sys.stdout.flush()
        remove(self.answer_path)
        self.close("desk" if self.tx.answered else "answered")
        return True


def knobs(argv):
    """--wait <s> and --poll <s> (tests); the defaults are 600 and 1."""
    opts = {"--wait": float(WAIT_S), "--poll": POLL_S}
    for flag, value in zip(argv, argv[1:]):
        if flag in opts:
            opts[flag] = float(value)
    return opts["--wait"], opts["--poll"]


def main():
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    if not isinstance(data, dict) or not data:
        return
    log(data)
    entrypoint = os.environ.get("CLAUDE_CODE_ENTRYPOINT") or ""
    sid = data.get("session_id")
    if data.get("hook_event_name") != "PermissionRequest" or data.get("tool_name") != "AskUserQuestion":
        return
    if not (entrypoint == "claude-vscode" or entrypoint.startswith("sdk-")):
        return
    if not isinstance(sid, str) or not SID_RE.match(sid) or sid in (".", "..") or not questions_of(data.get("tool_input")):
        return
    adir = os.path.join(monitor_dir(), "answers")
    if os.path.exists(os.path.join(adir, "off")):
        return
    os.makedirs(adir, mode=0o700, exist_ok=True)
    os.chmod(adir, 0o700)
    wait, poll = knobs(sys.argv[1:])
    waiter = Waiter(data, adir, wait, poll)
    try:
        waiter.run()
    except Exception:
        waiter.close("error")  # fail open: no decision, the marker goes, the dialog decides


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Fail open: never block, never answer, never fail the tool call.
        pass
    sys.exit(0)
