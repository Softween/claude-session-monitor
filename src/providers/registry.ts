import type { AgentProvider, SessionView } from "./types";

const BUCKET_ORDER: Record<SessionView["bucket"], number> = {
  limited: 0,
  attention: 1,
  working: 2,
  ended: 3,
  unknown: 4,
};

export interface ProviderCounts {
  all: number;
  claude: number;
  codex: number;
  copilot: number;
}

export function mergeProviderSessions(...lists: ReadonlyArray<ReadonlyArray<SessionView>>): SessionView[] {
  const byKey = new Map<string, SessionView>();
  for (const list of lists) {
    for (const session of list) {
      const current = byKey.get(session.key);
      if (!current || session.lastActivityMs >= current.lastActivityMs) {
        byKey.set(session.key, session);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const bucket = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bucket !== 0) return bucket;
    return b.lastActivityMs - a.lastActivityMs;
  });
}

export function countProviders(views: ReadonlyArray<SessionView>): ProviderCounts {
  let claude = 0;
  let codex = 0;
  let copilot = 0;
  for (const view of views) {
    if (view.provider === "claude") claude++;
    else if (view.provider === "codex") codex++;
    else if (view.provider === "copilot") copilot++;
  }
  return { all: claude + codex + copilot, claude, codex, copilot };
}

export function filterProvider(
  views: ReadonlyArray<SessionView>,
  provider: AgentProvider | "all",
): SessionView[] {
  return provider === "all" ? [...views] : views.filter((view) => view.provider === provider);
}
