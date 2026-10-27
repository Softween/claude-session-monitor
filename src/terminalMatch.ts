/**
 * Pick the VS Code terminal that hosts a session, for remote `send` deliveries
 * that must not change focus. Pure: no vscode import, so vitest can load it.
 */
export interface TerminalCandidate {
  name: string;
  pid?: number;
}

/**
 * Index of the terminal to write into, or -1.
 * 1. A terminal whose shell pid is an ancestor of the session's process wins (exact).
 * 2. Else the one terminal whose name matches a label candidate.
 * 3. Several name matches are ambiguous: never guess, return -1.
 */
export function pickSessionTerminal(
  terminals: TerminalCandidate[],
  candidates: string[],
  ancestorPids: number[],
  labelsMatch: (a: string, b: string) => boolean,
): number {
  const byPid = terminals.findIndex((t) => t.pid !== undefined && ancestorPids.includes(t.pid));
  if (byPid >= 0) return byPid;
  const byName: number[] = [];
  terminals.forEach((t, i) => {
    if (t.name && candidates.some((c) => labelsMatch(t.name, c))) byName.push(i);
  });
  return byName.length === 1 ? byName[0] : -1;
}

/** Parse `ps -o ppid= -p <pid>` output into a parent pid, or null. */
export function parseParentPid(psOutput: string): number | null {
  const n = Number.parseInt(psOutput.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
