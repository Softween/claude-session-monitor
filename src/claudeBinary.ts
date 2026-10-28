/**
 * claudeBinary.ts — the absolute path of the `claude` CLI, resolved once at
 * activation, so a remote resume never starts whichever `claude` a terminal's
 * PATH would pick. No vscode import; the lookups are injectable for tests.
 */
import * as fs from "fs";
import * as path from "path";

/** Install locations tried when `which claude` finds nothing usable. */
export function claudeFallbacks(home: string): string[] {
  return [path.join(home, ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

/** True for an existing regular file (symlinks followed) this process may execute. */
export function isExecutableFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * The first line of `which claude` when it is an absolute path to an executable
 * file, else the first executable fallback, else undefined.
 */
export async function resolveClaudeBinary(o: {
  which: () => Promise<string | null>;
  home: string;
  isExecutable?: (p: string) => boolean;
}): Promise<string | undefined> {
  const isExecutable = o.isExecutable ?? isExecutableFile;
  let found = "";
  try {
    found = ((await o.which()) ?? "").split("\n")[0].trim();
  } catch {
    found = "";
  }
  if (found && path.isAbsolute(found) && isExecutable(found)) return found;
  return claudeFallbacks(o.home).find((p) => isExecutable(p));
}
