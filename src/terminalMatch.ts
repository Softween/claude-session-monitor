/**
 * Pick the VS Code terminal that hosts a session, for remote `send` deliveries
 * that must not change focus. Pure: no vscode import, so vitest can load it.
 */
import { labelsMatchStrict } from "./view";

export interface TerminalCandidate {
  name: string;
  pid?: number;
}

/**
 * Index of the one label that strictly matches a candidate (labelsMatchStrict),
 * or -1 when none or several do: two tabs or terminals with the same (truncated)
 * title are ambiguous and never receive remote text. `rivals` are the other
 * sessions' title candidates; a label one of them matches too names more than
 * one session (e.g. two titles sharing their first 24 characters) and is -1 as
 * well, even when the other session's tab is in another window.
 */
export function pickUniqueLabel(labels: string[], candidates: string[], rivals: string[] = []): number {
  let hit = -1;
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label || !candidates.some((c) => labelsMatchStrict(label, c))) continue;
    if (hit >= 0) return -1;
    hit = i;
  }
  if (hit >= 0 && rivals.some((r) => labelsMatchStrict(labels[hit], r))) return -1;
  return hit;
}

/**
 * Index of the terminal to write into, or -1.
 * 1. A terminal whose shell pid is an ancestor of the session's process wins (exact).
 * 2. Else the one terminal whose name strictly matches a label candidate
 *    (pickUniqueLabel: several such terminals, or a name another session's
 *    title matches too, are ambiguous: -1).
 */
export function pickSessionTerminal(
  terminals: TerminalCandidate[],
  candidates: string[],
  ancestorPids: number[],
  rivals: string[] = [],
): number {
  const byPid = terminals.findIndex((t) => t.pid !== undefined && ancestorPids.includes(t.pid));
  if (byPid >= 0) return byPid;
  return pickUniqueLabel(terminals.map((t) => t.name), candidates, rivals);
}

/** Parse `ps -o ppid= -p <pid>` output into a parent pid, or null. */
export function parseParentPid(psOutput: string): number | null {
  const n = Number.parseInt(psOutput.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
