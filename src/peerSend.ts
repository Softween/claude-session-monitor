/**
 * peerSend.ts — deliver a text message into a running local Claude Code session
 * over its "uds-messaging" Unix-domain socket, the way the built-in SendMessage
 * tool does. TypeScript port of ~/.claude/bin/cc-peer-send.py (wire format and
 * evidence in PROTOCOL.md next to it). Node stdlib only, no vscode import.
 *
 * Framing: newline-delimited JSON, one connection per message, auth line then the
 * message line. The receiver never writes back; it closes the connection once it
 * has read the frame (and destroys it on a refused one), so "inbox-accepted" is
 * the strongest in-band signal there is. `waitTranscriptMs` polls the recipient's
 * transcript for the msg_id, the only true end-to-end proof.
 *
 * Difference from the Python tool: Node's `net` cannot read LOCAL_PEERPID /
 * LOCAL_PEERCRED, so the connected endpoint's pid is not verified; instead the
 * socket file must be owned by this uid and the record's procStart must match the
 * live pid (recycled-pid guard), as in the Python tool.
 */
import { execFile } from "child_process";
import { createHash, randomUUID } from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

export const TAG = "cross-session-message";
export const MAX_LINE = 1048576; // uJe @160972491

export type PeerSendCode = "usage" | "target" | "auth" | "endpoint" | "transport" | "unconfirmed";

export interface PeerSendOk {
  ok: true;
  pid: number;
  sessionId: string | null;
  socket: string;
  msgId: string;
  rawResponse: string;
  confirmed: "inbox-accepted" | "in-transcript";
  transcript?: string;
}
export interface PeerSendErr { ok: false; code: PeerSendCode; error: string; msgId?: string }
export type PeerSendResult = PeerSendOk | PeerSendErr;

export interface SessionRecord {
  pid: number;
  sessionId?: string;
  name?: string;
  messagingSocketPath?: string;
  procStart?: string;
}

export interface SendOptions {
  pid?: number;
  sessionId?: string; // a prefix is enough when unambiguous
  text: string;
  timeoutMs?: number;
  name?: string; // sender name shown to the recipient
  fromMode?: "bypass" | "prompting"; // only when TRUE of the sender (PROTOCOL.md)
  priority?: "now" | "next" | "later";
  waitTranscriptMs?: number;
  sessionsDir?: string;
  projectsDir?: string;
  authGraceMs?: number; // wait for an early close after the auth line (300 ms)
}

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions");
const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

// Unicode format / control / separator classes stripped from a sender name (gA()).
const NAME_STRIP = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u0600-\\u0605\\u061c\\u06dd\\u070f" +
    "\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064" +
    "\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]",
  "g",
);

const fail = (code: PeerSendCode, error: string, msgId?: string): PeerSendErr => ({ ok: false, code, error, msgId });

// ---------------------------------------------------------------- envelope ---

/** x2e()/Sue(): `<cross-session-message [from-name=".."] [from-mode=".."]>NL body NL </..>`. */
export function buildContent(text: string, name?: string, fromMode?: string): string {
  const attrs: string[] = [];
  if (name) {
    let clean = name.replace(/["<>]/g, "").replace(NAME_STRIP, "").trim();
    if ([...clean].length > 64) clean = [...clean].slice(0, 64).join("") + "…";
    if (clean) attrs.push(`from-name="${clean}"`);
  }
  if (fromMode) attrs.push(`from-mode="${fromMode}"`);
  const head = `<${TAG}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  // Qxe(): neutralise anything that could close the wrapper early.
  const body = text.replace(new RegExp(`<(?=\\s*/\\s*${TAG})`, "gi"), "<\\");
  return `${head}\n${body}\n</${TAG}>`;
}

export interface Frames { msgId: string; authLine: string; msgLine: string }

export function buildFrames(
  text: string,
  token: string,
  o: { name?: string; fromMode?: string; priority?: string; msgId?: string } = {},
): Frames {
  const msgId = o.msgId ?? randomUUID();
  const env = {
    msgV: 1,
    msg_id: msgId,
    type: "user",
    message: { role: "user", content: buildContent(text, o.name, o.fromMode) },
    priority: o.priority ?? "next",
  };
  return {
    msgId,
    authLine: JSON.stringify({ type: "auth", token }) + "\n",
    msgLine: JSON.stringify(env) + "\n",
  };
}

// ---------------------------------------------------------------- registry ---

export function loadRecords(dir: string = DEFAULT_SESSIONS_DIR): SessionRecord[] {
  const out: SessionRecord[] = [];
  for (const n of fs.readdirSync(dir).sort()) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
      if (rec && typeof rec === "object" && Number.isInteger(rec.pid)) out.push(rec as SessionRecord);
    } catch {
      /* skip unreadable record */
    }
  }
  return out;
}

export function resolveTarget(recs: SessionRecord[], pid?: number, sessionId?: string): SessionRecord | PeerSendErr {
  if (pid !== undefined) {
    const hit = recs.find((r) => r.pid === pid);
    if (!hit) return fail("target", `no session record ~/.claude/sessions/${pid}.json`);
    // With both given the process must run that very session: a recycled pid or a
    // new conversation in the same process never receives another session's text.
    if (sessionId && hit.sessionId !== sessionId) {
      return fail("target", `pid ${pid} runs session ${hit.sessionId ?? "(unknown)"}, not ${sessionId}`);
    }
    return hit;
  }
  const pref = sessionId ?? "";
  if (!pref) return fail("usage", "a pid or sessionId is required");
  const exact = recs.filter((r) => r.sessionId === pref);
  const hits = exact.length ? exact : recs.filter((r) => String(r.sessionId ?? "").startsWith(pref));
  if (!hits.length) return fail("target", `no session record with sessionId starting "${pref}"`);
  if (hits.length > 1) {
    return fail(
      "target",
      `sessionId prefix "${pref}" is ambiguous: ` + hits.map((r) => `${r.sessionId}(pid ${r.pid})`).join(", "),
    );
  }
  return hits[0];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The binary's own probe (wae): LC_ALL=C TZ=UTC ps -o lstart= -p <pid>. */
export function procStart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });
}

// -------------------------------------------------------------------- auth ---

/** Mirror Eur(): the key file is `<ownerpid>.<sha256(socketPath)>.key` in the sessions dir. */
export async function readPeerToken(
  sockPath: string,
  targetPid: number,
  dir: string = DEFAULT_SESSIONS_DIR,
): Promise<{ token: string; keyFile: string } | PeerSendErr> {
  const h = createHash("sha256").update(sockPath).digest("hex");
  const cands = fs.readdirSync(dir).filter((n) => n.endsWith(`.${h}.key`)).sort();
  if (!cands.length) {
    return fail(
      "auth",
      `no inbox auth key registered for ${sockPath} (expected ~/.claude/sessions/<pid>.${h}.key) - refusing to send to an unvouched socket`,
    );
  }
  let best: { rank: number; token: string; file: string } | undefined;
  for (const n of cands) {
    const m = /^(\d+)\.[0-9a-f]{64}\.key$/.exec(n);
    if (!m) continue;
    const owner = Number(m[1]);
    const file = path.join(dir, n);
    let key: { peerToken?: unknown; procStart?: unknown };
    try {
      key = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (typeof key.peerToken !== "string" || !key.peerToken) continue;
    let rank = 0;
    if (pidAlive(owner)) {
      const live = typeof key.procStart === "string" && key.procStart ? await procStart(owner) : null;
      rank = live && live === key.procStart ? 2 : 1;
    }
    if (owner === targetPid) rank += 3;
    if (!best || rank > best.rank) best = { rank, token: key.peerToken, file };
  }
  if (!best) return fail("auth", `inbox auth key for ${sockPath} is unreadable or malformed`);
  if (best.rank === 0) return fail("auth", `inbox auth key ${best.file} belongs to a dead owner - refusing to send`);
  return { token: best.token, keyFile: best.file };
}

// ------------------------------------------------------------------ socket ---

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Write the two lines over one connection and wait for the receiver to close it.
 * An EOF right after the auth line means the auth frame was refused; any bytes
 * before the final EOF are returned as the raw response (normally empty).
 */
export function writeFrames(
  sockPath: string,
  frames: Frames,
  timeoutMs: number,
  authGraceMs = 300,
): Promise<{ ok: true; raw: string } | PeerSendErr> {
  return new Promise((resolve) => {
    let phase: "connect" | "auth" | "message" | "drain" = "connect";
    let raw = Buffer.alloc(0);
    let settled = false;
    const sock = net.createConnection({ path: sockPath, allowHalfOpen: true });
    const finish = (r: { ok: true; raw: string } | PeerSendErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(
      () => finish(fail("transport", `receiver never closed the connection (raw bytes so far: ${JSON.stringify(raw.toString())})`)),
      timeoutMs,
    );
    sock.on("error", (e) => {
      if (phase === "connect") finish(fail("transport", `cannot connect to ${sockPath}: ${e.message}`));
      else if (phase === "auth") finish(fail("auth", `receiver dropped the connection after the auth line: ${e.message}`));
      else finish(fail("transport", `connection reset after the message line: ${e.message} (raw bytes: ${JSON.stringify(raw.toString())})`));
    });
    sock.on("data", (chunk: Buffer) => {
      if (phase === "auth") {
        finish(fail("transport", `unexpected reply to the auth line: ${JSON.stringify(chunk.toString())}`));
        return;
      }
      raw = Buffer.concat([raw, chunk]);
    });
    sock.on("end", () => {
      if (phase === "auth") {
        finish(fail("auth", "receiver closed the connection right after the auth line - the auth frame was refused"));
      } else if (phase === "drain") {
        finish({ ok: true, raw: raw.toString("utf8") });
      } else {
        finish(fail("transport", "receiver closed the connection before the message was written"));
      }
    });
    sock.on("connect", async () => {
      phase = "auth";
      sock.write(frames.authLine);
      await delay(authGraceMs);
      if (settled) return;
      phase = "message";
      sock.write(frames.msgLine);
      await delay(150); // macOS client parity (Ve = 150 ms)
      if (settled) return;
      phase = "drain";
      sock.end(); // shutdown(SHUT_WR); keep reading until the receiver closes
    });
  });
}

// ------------------------------------------------------- delivery evidence ---

function transcriptPath(sessionId: string | undefined, projectsDir: string): string | null {
  if (!sessionId) return null;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

/** Poll the transcript tail (last 256 KB) for a line whose origin.msg_id is ours. */
export async function waitTranscript(file: string, msgId: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  let start = 0;
  try {
    start = Math.max(0, fs.statSync(file).size - 262144);
  } catch {
    /* read from 0 */
  }
  for (;;) {
    try {
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.max(0, size - start));
        fs.readSync(fd, buf, 0, buf.length, start);
        for (const line of buf.toString("utf8").split("\n")) {
          if (!line.includes(msgId)) continue;
          try {
            const j = JSON.parse(line);
            if (j?.origin && j.origin.msg_id === msgId) return true;
          } catch {
            /* partial line */
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* transcript briefly unreadable */
    }
    if (Date.now() >= deadline) return false;
    await delay(1000);
  }
}

// -------------------------------------------------------------------- main ---

export async function sendToSession(o: SendOptions): Promise<PeerSendResult> {
  if (!o.text) return fail("usage", "text must not be empty");
  const sessionsDir = o.sessionsDir ?? DEFAULT_SESSIONS_DIR;
  const timeoutMs = o.timeoutMs ?? 5000;
  let recs: SessionRecord[];
  try {
    recs = loadRecords(sessionsDir);
  } catch (e) {
    return fail("target", `session registry unreadable (${sessionsDir}): ${String(e)}`);
  }
  const rec = resolveTarget(recs, o.pid, o.sessionId);
  if ("ok" in rec) return rec;
  const pid = rec.pid;
  const sock = rec.messagingSocketPath;
  if (!sock) return fail("target", `session ${rec.sessionId} (pid ${pid}) has no messagingSocketPath - it is not running a cross-session inbox`);
  let st: fs.Stats;
  try {
    st = fs.statSync(sock);
  } catch {
    return fail("target", `socket ${sock} does not exist (session gone?)`);
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return fail("endpoint", `socket ${sock} is owned by uid ${st.uid}, not ours`);
  }
  if (!pidAlive(pid)) return fail("target", `pid ${pid} is not running - stale session record`);
  if (rec.procStart) {
    const live = await procStart(pid);
    if (live && live !== rec.procStart) {
      return fail("target", `pid ${pid} start time is "${live}" but the session record says "${rec.procStart}" - recycled pid, refusing to send`);
    }
  }
  let auth: { token: string; keyFile: string } | PeerSendErr;
  try {
    auth = await readPeerToken(sock, pid, sessionsDir);
  } catch (e) {
    return fail("auth", `inbox auth key lookup failed: ${String(e)}`);
  }
  if ("ok" in auth) return auth;
  const frames = buildFrames(o.text, auth.token, { name: o.name ?? "agent-fleet", fromMode: o.fromMode, priority: o.priority });
  if (Buffer.byteLength(frames.msgLine) > MAX_LINE) {
    return fail("usage", `message line is ${Buffer.byteLength(frames.msgLine)} bytes, over the receiver's ${MAX_LINE} byte limit`);
  }
  const w = await writeFrames(sock, frames, timeoutMs, o.authGraceMs);
  if (!w.ok) return { ...w, msgId: frames.msgId };
  const res: PeerSendOk = {
    ok: true,
    pid,
    sessionId: rec.sessionId ?? null,
    socket: sock,
    msgId: frames.msgId,
    rawResponse: w.raw,
    confirmed: "inbox-accepted",
  };
  if (o.waitTranscriptMs && o.waitTranscriptMs > 0) {
    const tpath = transcriptPath(rec.sessionId, o.projectsDir ?? DEFAULT_PROJECTS_DIR);
    if (!tpath) return fail("unconfirmed", `frame accepted by the inbox (msg_id ${frames.msgId}) but the recipient's transcript could not be located`, frames.msgId);
    if (!(await waitTranscript(tpath, frames.msgId, o.waitTranscriptMs))) {
      return fail(
        "unconfirmed",
        `frame accepted by the inbox (msg_id ${frames.msgId}) but it did not reach the conversation within ${Math.round(o.waitTranscriptMs / 1000)}s (queued behind the current turn, or held for approval)`,
        frames.msgId,
      );
    }
    res.confirmed = "in-transcript";
    res.transcript = tpath;
  }
  return res;
}
