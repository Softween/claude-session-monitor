/**
 * answers.ts — the bridge side of answering an AskUserQuestion from the phone. The
 * PermissionRequest hook (scripts/answer_hook.py) writes
 * ~/.claude/session-monitor/answers/<session>.waiting.json while it waits for the phone
 * (questions, its pid, a nonce, deadline); a row is `answerable` while that marker is live.
 * A remote `answer` command is checked against the marker and, when it fits, written as
 * <session>.answer.json (atomic, 0600, carrying the marker's nonce) for the hook to pick up.
 * Command answers are Turkish: the phone shows them as they are.
 */
import * as fs from "fs";
import * as path from "path";
import { MONITOR_DIR, pidAlive } from "./core";

export const ANSWERS_DIR = path.join(MONITOR_DIR, "answers");
export const FREE_TEXT_MAX = 500;
const DEADLINE_MARGIN_S = 2; // an answer this close to the deadline could reach the hook after it left
const SID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface MarkerQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: string[];
}

export interface WaitingMarker {
  sessionId: string;
  toolUseId: string | null;
  pid: number;
  nonce: string;
  started: number; // epoch s
  deadline: number; // epoch s
  questions: MarkerQuestion[];
}

export interface AnswerOutcome {
  ok: boolean;
  message: string;
}

const validSid = (sid: unknown): sid is string => typeof sid === "string" && SID_RE.test(sid) && sid !== "." && sid !== "..";

function parseQuestion(raw: unknown): MarkerQuestion | null {
  const q = raw as Partial<MarkerQuestion> | null;
  if (typeof q?.question !== "string" || !q.question || !Array.isArray(q.options)) return null;
  return {
    question: q.question,
    header: typeof q.header === "string" ? q.header : "",
    multiSelect: q.multiSelect === true,
    options: q.options.filter((o): o is string => typeof o === "string"),
  };
}

/** A marker file's content for `sessionId`, or null when it is not a well-formed marker for that session. */
export function parseMarker(raw: unknown, sessionId: string): WaitingMarker | null {
  const m = raw as Partial<WaitingMarker> | null;
  if (!m || m.sessionId !== sessionId || typeof m.nonce !== "string" || !m.nonce) return null;
  if (typeof m.pid !== "number" || typeof m.started !== "number" || typeof m.deadline !== "number") return null;
  const questions = Array.isArray(m.questions) ? m.questions.map(parseQuestion) : [];
  if (!questions.length || questions.some((q) => !q)) return null;
  return {
    sessionId,
    toolUseId: typeof m.toolUseId === "string" && m.toolUseId ? m.toolUseId : null,
    pid: m.pid,
    nonce: m.nonce,
    started: m.started,
    deadline: m.deadline,
    questions: questions as MarkerQuestion[],
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readMarker(sessionId: string, dir = ANSWERS_DIR): WaitingMarker | null {
  return validSid(sessionId) ? parseMarker(readJson(path.join(dir, `${sessionId}.waiting.json`)), sessionId) : null;
}

/** The hook behind the marker still runs and its deadline has not passed. */
export function isLive(m: WaitingMarker, nowSec: number, alive: (pid?: number) => boolean | undefined = pidAlive): boolean {
  return m.deadline - DEADLINE_MARGIN_S > nowSec && alive(m.pid) === true;
}

/** Live markers by session id: one directory read, then only the marker files. */
export function liveMarkers(
  nowSec: number,
  opts: { dir?: string; alive?: (pid?: number) => boolean | undefined } = {},
): Map<string, WaitingMarker> {
  const dir = opts.dir ?? ANSWERS_DIR;
  const out = new Map<string, WaitingMarker>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".waiting.json")) continue;
    const m = readMarker(name.slice(0, -".waiting.json".length), dir);
    if (m && isLive(m, nowSec, opts.alive)) out.set(m.sessionId, m);
  }
  return out;
}

const labelOf = (q: MarkerQuestion): string => q.header || (q.question.length > 40 ? q.question.slice(0, 39) + "…" : q.question);

// The phone's card comes from the chat tailer, which redacts every question text and label
// (tools/agent-fleet/chat_privacy.py placeholders) and caps them (chat_tailer.py QUESTION_MAX, LABEL_MAX).
const PLACEHOLDER_RE = /\[(?:redacted|email|phone|id|iban|card)\]/;
export const SHOWN_QUESTION_MAX = 500;
export const SHOWN_LABEL_MAX = 120;

/** `shown` is `original` as the tailer shows it: each placeholder stands for a redacted run, a capped text is a prefix. */
export function sameText(shown: string, original: string, cap: number): boolean {
  if (shown === original) return true;
  const capped = [...shown].length >= cap;
  if (!PLACEHOLDER_RE.test(shown) && !capped) return false;
  const body = shown
    .split(new RegExp(PLACEHOLDER_RE.source, "g"))
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]+?");
  return new RegExp(`^${body}${capped ? "" : "$"}`).test(original);
}

/** The one entry of `originals` that `shown` stands for (exact match first), else null. */
function resolveShown(shown: string, originals: string[], cap: number): string | null {
  if (originals.includes(shown)) return shown;
  const hits = originals.filter((o) => sameText(shown, o, cap));
  return hits.length === 1 ? hits[0] : null;
}

/** The answer as Claude Code writes it: an option label, labels joined with ", " (multi-select), else null (free text). */
function normalized(q: MarkerQuestion, value: string): string | null {
  const v = value.trim();
  const one = resolveShown(v, q.options, SHOWN_LABEL_MAX);
  if (one) return one;
  if (!q.multiSelect) return null;
  const parts = v.split(",").map((p) => resolveShown(p.trim(), q.options, SHOWN_LABEL_MAX));
  return parts.every((p) => p) ? parts.join(", ") : null;
}

/**
 * Every marker question answered with its option label(s) or a short free text ("Diğer"), keyed by
 * the question text as asked or as the tailer showed it; the answers keyed as asked, or the reason.
 */
export function checkAnswers(
  m: WaitingMarker,
  answers: unknown,
): { ok: true; answers: Record<string, string> } | { ok: false; reason: string } {
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, reason: "Cevaplar eksik" };
  const byQuestion = new Map<string, unknown>();
  const texts = m.questions.map((q) => q.question);
  for (const [key, value] of Object.entries(answers as Record<string, unknown>)) {
    const text = resolveShown(key, texts, SHOWN_QUESTION_MAX);
    if (!text || byQuestion.has(text)) return { ok: false, reason: "Soru Mac'teki soruyla eşleşmiyor; kartı yenileyip tekrar dene" };
    byQuestion.set(text, value);
  }
  const out: Record<string, string> = {};
  for (const q of m.questions) {
    const value = byQuestion.get(q.question);
    if (value === undefined) return { ok: false, reason: `"${labelOf(q)}" sorusu cevaplanmadı` };
    if (typeof value !== "string" || !value.trim()) return { ok: false, reason: `"${labelOf(q)}" için cevap boş` };
    const label = normalized(q, value);
    if (label) {
      out[q.question] = label;
      continue;
    }
    if (CONTROL_RE.test(value.trim())) return { ok: false, reason: `"${labelOf(q)}" cevabında satır sonu ya da kontrol karakteri olamaz` };
    if ([...value.trim()].length > FREE_TEXT_MAX) {
      return { ok: false, reason: `"${labelOf(q)}" için serbest cevap en fazla ${FREE_TEXT_MAX} karakter olabilir` };
    }
    out[q.question] = value.trim();
  }
  return { ok: true, answers: out };
}

/** Atomic 0600 write: a unique temp file in the same directory, then a rename. */
function writeAtomic(file: string, data: string): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    throw e;
  }
}

/**
 * A remote `answer {sessionId, toolUseId?, answers}`: refused unless a live marker waits for
 * exactly these questions (`askPending` = the bridge's own transcript read still sees the
 * question open); else written for the hook.
 */
export function submitAnswer(
  cmd: { sessionId?: unknown; toolUseId?: unknown; answers?: unknown },
  opts: { nowSec: number; askPending: boolean; dir?: string; alive?: (pid?: number) => boolean | undefined },
): AnswerOutcome {
  const dir = opts.dir ?? ANSWERS_DIR;
  if (!validSid(cmd.sessionId)) return { ok: false, message: "Geçersiz oturum kimliği" };
  const m = readMarker(cmd.sessionId, dir);
  if (!m || !isLive(m, opts.nowSec, opts.alive)) {
    return { ok: false, message: opts.askPending ? "Süre doldu; soruyu Mac'te cevapla" : "Mac'te cevaplandı" };
  }
  const staleCard = typeof cmd.toolUseId === "string" && cmd.toolUseId && m.toolUseId && cmd.toolUseId !== m.toolUseId;
  if (!opts.askPending || staleCard) return { ok: false, message: "Mac'te cevaplandı" };
  const checked = checkAnswers(m, cmd.answers);
  if (!checked.ok) return { ok: false, message: checked.reason };
  const file = path.join(dir, `${m.sessionId}.answer.json`);
  if ((readJson(file) as { nonce?: unknown } | null)?.nonce === m.nonce) return { ok: false, message: "Bu soruya zaten cevap iletildi" };
  try {
    writeAtomic(file, JSON.stringify({ v: 1, nonce: m.nonce, toolUseId: m.toolUseId, answers: checked.answers, writtenAt: opts.nowSec }));
  } catch (e) {
    return { ok: false, message: `Cevap yazılamadı: ${String(e)}` };
  }
  return { ok: true, message: "Cevap iletildi" };
}
