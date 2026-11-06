/**
 * remoteCwds.ts — the folders a remote `newSession` may start Claude in (the
 * snapshot's `allowedCwds`) and the command's checks. Pure (no vscode import),
 * so vitest can load it.
 *
 * A folder is trusted when a VS Code window that trusted its workspace had it
 * open as a workspace folder in the last 7 days. The list holds those folders
 * plus the cwds of sessions seen in the last 7 days that are such a folder or
 * lie inside one (VS Code trust covers subfolders), newest first, each once,
 * at most 30. Anything else stays out.
 */
import * as path from "path";
import { sanitizeRemoteLine } from "./remoteInput";

export const ALLOWED_CWDS_MAX = 30;
export const SEEN_TTL_MS = 7 * 24 * 3600 * 1000;
export const SEEN_MAX = 200;
export const CWD_MAX_CHARS = 512; // the relay's cap
export const FIRST_MESSAGE_MAX_BYTES = 4096; // the relay's cap for `send` text

/** Folder path -> when it was last seen (epoch ms). */
export type SeenFolders = Record<string, number>;

const CONTROL = /[\u0000-\u001f\u007f-\u009f  ]/;

/**
 * An absolute, normalized POSIX path (no `.` / `..` segments, no trailing
 * slash), not the root, without control characters, at most 512 characters.
 */
export function isUsablePath(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 1 &&
    p.length <= CWD_MAX_CHARS &&
    path.posix.isAbsolute(p) &&
    path.posix.normalize(p) === p &&
    !p.endsWith("/") &&
    !CONTROL.test(p)
  );
}

/** True when `dir` is `root` or lies inside it (both usable paths). */
export function isInside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root + "/");
}

/**
 * `prev` (any stored value) with `seen` merged in: the newest time per path;
 * unusable paths, entries older than 7 days or from the future dropped; the
 * newest `cap` kept.
 */
export function mergeSeen(prev: unknown, seen: Iterable<readonly [string, number]>, now: number, cap = SEEN_MAX): SeenFolders {
  const out = new Map<string, number>();
  const add = (p: unknown, at: unknown) => {
    if (!isUsablePath(p) || typeof at !== "number" || !Number.isFinite(at)) return;
    if (now - at > SEEN_TTL_MS || at > now + 60_000) return;
    out.set(p, Math.max(out.get(p) ?? 0, at));
  };
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    for (const [p, at] of Object.entries(prev as Record<string, unknown>)) add(p, at);
  }
  for (const [p, at] of seen) add(p, at);
  return Object.fromEntries([...out].sort((a, b) => b[1] - a[1]).slice(0, cap));
}

/** `map` without the entries for `paths`. */
export function withoutPaths(map: SeenFolders, paths: readonly string[]): SeenFolders {
  return Object.fromEntries(Object.entries(map).filter(([p]) => !paths.includes(p)));
}

/**
 * The snapshot's allowedCwds: every trusted folder, plus each session cwd that
 * is a trusted folder or lies inside one, newest first, each path once, only
 * paths `exists` accepts (an existing directory), at most 30.
 */
export function allowedCwds(o: {
  trusted: SeenFolders;
  sessions: SeenFolders;
  now: number;
  exists: (p: string) => boolean;
}): string[] {
  const trusted = mergeSeen(o.trusted, [], o.now);
  const roots = Object.keys(trusted);
  const inTrusted = Object.entries(mergeSeen(o.sessions, [], o.now)).filter(([p]) => roots.some((r) => isInside(p, r)));
  const merged = mergeSeen(trusted, inTrusted, o.now);
  const out: string[] = [];
  for (const p of Object.keys(merged)) {
    if (out.length >= ALLOWED_CWDS_MAX) break;
    if (o.exists(p)) out.push(p);
  }
  return out;
}

export type NewSessionCheck = { ok: true; cwd: string; line: string | null } | { ok: false; message: string };

/**
 * A remote `newSession`'s fields: `cwd` must be exactly one of `allowed`; an
 * optional first message must stay within 4 KB and pass the send rules
 * (sanitizeRemoteLine: no control characters, no leading `!` `/` `#`).
 */
export function checkNewSession(cmd: { cwd?: unknown; text?: unknown }, allowed: readonly string[]): NewSessionCheck {
  const { cwd, text } = cmd;
  if (typeof cwd !== "string" || !allowed.includes(cwd)) return { ok: false, message: "folder not allowed on this Mac" };
  if (text === undefined || text === null || text === "") return { ok: true, cwd, line: null };
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > FIRST_MESSAGE_MAX_BYTES) {
    return { ok: false, message: "first message: rejected input" };
  }
  const s = sanitizeRemoteLine(text);
  return s.ok ? { ok: true, cwd, line: s.line } : { ok: false, message: `first message: ${s.reason}` };
}
