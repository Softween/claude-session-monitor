// Pure layout helpers for the Usage Limits panel: the active account is always
// a full card, the others collapse to a two-line row unless the user expanded
// them. No vscode import so it stays unit-testable.

export function layoutAccounts(
  accounts: { id: string; active?: boolean }[],
  expandedIds: string[],
): Array<{ id: string; mode: "full" | "compact" }> {
  return accounts.map((a) => ({
    id: a.id,
    mode: a.active || expandedIds.includes(a.id) ? "full" : "compact",
  }));
}

export function worstGauge(gauges: { key: string; pct: number }[]): { key: string; pct: number } | null {
  let worst: { key: string; pct: number } | null = null;
  for (const g of gauges) if (!worst || g.pct > worst.pct) worst = g;
  return worst;
}

export function gaugeShort(key: string): string {
  const k = key.toLowerCase();
  if (k.includes("fable")) return "F";
  if (k === "session") return "S";
  if (k === "weekly") return "W";
  return k.charAt(0).toUpperCase();
}

export function toggleExpanded(expandedIds: string[], id: string): string[] {
  return expandedIds.includes(id) ? expandedIds.filter((x) => x !== id) : [...expandedIds, id];
}
