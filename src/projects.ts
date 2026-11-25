/**
 * Project tags for the Agent Sessions list. Most sessions share one workspace
 * folder, so the cwd alone rarely tells which project a session works on.
 * Each session is tagged with the first configured project whose pattern
 * matches, looked up in order:
 *   1. the cwd,
 *   2. the session title (only when it names exactly one project),
 *   3. the paths and commands of its recent tool calls (most hits wins,
 *      a tie goes to the most recent hit),
 *   4. the last prompt.
 * Patterns are case-insensitive substrings; list a more specific project
 * first when its pattern contains another's (getfund's "glossgo-fund" before
 * glossgo's "glossgo").
 */

export interface ProjectRule {
  name: string;
  patterns: string[];
}

export interface ProjectInput {
  cwd?: string;
  title?: string;
  prompt?: string;
  /** Paths and commands of recent tool calls, oldest first. */
  refs?: readonly string[];
}

/** The `other` filter key: sessions no rule matched. */
export const OTHER_PROJECT = "other";

/** Valid rules from the raw setting value; anything malformed is dropped. */
export function readProjectRules(raw: unknown): ProjectRule[] {
  if (!Array.isArray(raw)) return [];
  const rules: ProjectRule[] = [];
  for (const r of raw) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    const patterns = Array.isArray(r?.patterns)
      ? r.patterns.filter((p: unknown): p is string => typeof p === "string" && !!p.trim()).map((p: string) => p.trim().toLowerCase())
      : [];
    if (name && name !== OTHER_PROJECT && patterns.length && !rules.some((x) => x.name === name)) rules.push({ name, patterns });
  }
  return rules;
}

function firstMatch(rules: readonly ProjectRule[], text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  return rules.find((r) => r.patterns.some((p) => t.includes(p)))?.name;
}

/** Every project the text names, in rule order (text a rule matched is not matched again by a later rule). */
function allMatches(rules: readonly ProjectRule[], text: string | undefined): string[] {
  if (!text) return [];
  let t = text.toLowerCase();
  const hits: string[] = [];
  for (const r of rules) {
    let hit = false;
    for (const p of r.patterns) {
      if (!t.includes(p)) continue;
      hit = true;
      t = t.split(p).join(" ");
    }
    if (hit) hits.push(r.name);
  }
  return hits;
}

function fromRefs(rules: readonly ProjectRule[], refs: readonly string[] | undefined): string | undefined {
  if (!refs?.length) return undefined;
  const score = new Map<string, { n: number; last: number }>();
  refs.forEach((ref, i) => {
    const name = firstMatch(rules, ref);
    if (!name) return;
    const s = score.get(name) ?? { n: 0, last: -1 };
    score.set(name, { n: s.n + 1, last: i });
  });
  let best: string | undefined;
  let bestScore = { n: 0, last: -1 };
  for (const [name, s] of score) {
    if (s.n > bestScore.n || (s.n === bestScore.n && s.last > bestScore.last)) {
      best = name;
      bestScore = s;
    }
  }
  return best;
}

/** The session's project name, or undefined when no rule matches. */
export function projectOf(rules: readonly ProjectRule[], s: ProjectInput): string | undefined {
  if (!rules.length) return undefined;
  const byCwd = firstMatch(rules, s.cwd);
  if (byCwd) return byCwd;
  const inTitle = allMatches(rules, s.title);
  if (inTitle.length === 1) return inTitle[0];
  return fromRefs(rules, s.refs) ?? inTitle[0] ?? firstMatch(rules, s.prompt);
}
