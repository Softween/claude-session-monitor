// Pure helper for the Usage Limits grid: which table column a gauge belongs to.
// No vscode import so it stays unit-testable.

export type GaugeColumn = "session" | "weekly" | "fable";

export function gaugeColumn(key: string): GaugeColumn | null {
  const k = key.toLowerCase();
  if (k.includes("fable")) return "fable";
  if (k === "session" || k === "5h" || k.includes("primary")) return "session";
  if (k === "weekly" || k === "7d" || k.includes("secondary")) return "weekly";
  return null;
}
