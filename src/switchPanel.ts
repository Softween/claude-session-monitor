// Read-only feed from ~/.claude/bin/claude-switch: panel.json in the same state
// dir as the vault. Pure helpers (no vscode import) so they are unit-tested; the
// extension host renders the block and the webview only injects the HTML.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const SWITCH_STATE_DIR = path.join(os.homedir(), ".claude", "state", "claude-switch");
export const SWITCH_PANEL_FILE = path.join(SWITCH_STATE_DIR, "panel.json");
export const PANEL_STALE_SEC = 600;
const MAX_EVENTS = 8;

export interface PanelAccount {
  email: string;
  rank?: number;
  needsLogin?: boolean;
  needsLoginReason?: string | null;
}
export interface PanelEvent { ts: number; kind: string; text: string }
export interface SwitchPanel {
  v: 1;
  ts: number;
  active?: { uuid?: string; email?: string };
  priority?: string[];
  paused?: boolean;
  breaker?: { open?: boolean; count?: number; max?: number };
  lastSwitch?: { from?: string; to?: string; ts?: number; reason?: string } | null;
  nextHint?: string;
  accounts?: PanelAccount[];
  events?: PanelEvent[];
}

/** Parsed panel, or null when missing, unparsable or not schema v1. */
export function readPanel(file: string = SWITCH_PANEL_FILE): SwitchPanel | null {
  try {
    const p = JSON.parse(fs.readFileSync(file, "utf8")) as SwitchPanel;
    return p && typeof p === "object" && p.v === 1 && typeof p.ts === "number" ? p : null;
  } catch {
    return null;
  }
}

/** Age of the panel in seconds (never negative). */
export function panelAge(panel: SwitchPanel, nowMs: number): number {
  return Math.max(0, Math.round(nowMs / 1000 - panel.ts));
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const cls = (k: string): string => `sw-${k.replace(/[^A-Za-z0-9_-]/g, "")}`;
const hhmm = (tsSec: number): string => {
  const d = new Date(tsSec * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const ageText = (sec: number): string => (sec < 90 ? `${sec}s` : `${Math.round(sec / 60)} min`);

function findAccount(panel: SwitchPanel, email: string): PanelAccount | undefined {
  return panel.accounts?.find((a) => a.email === email);
}

/** Priority rank of an email (accounts[].rank, else position in `priority`). */
function rankOf(panel: SwitchPanel, email: string | undefined): number | undefined {
  if (!email) return undefined;
  const r = findAccount(panel, email)?.rank;
  if (typeof r === "number") return r;
  const i = panel.priority?.indexOf(email) ?? -1;
  return i >= 0 ? i + 1 : undefined;
}

/** HTML for the claude-switch block (empty-state line when missing or stale). */
export function renderSwitchBlock(panel: SwitchPanel | null, nowMs: number): string {
  const age = panel ? panelAge(panel, nowMs) : null;
  if (!panel || age === null || age > PANEL_STALE_SEC) {
    const why = panel && age !== null ? `${ageText(age)} old` : "file missing";
    return `<div class="swblock" data-testid="csm-switch-block"><div class="swline sw-info">claude-switch: no data (${esc(why)})</div></div>`;
  }
  const email = panel.active?.email ?? "?";
  const rank = rankOf(panel, panel.active?.email);
  const parts = [
    `claude-switch`,
    `active ${email}`,
    ...(rank !== undefined ? [`priority #${rank}`] : []),
    panel.paused ? "PAUSED" : "auto",
    `breaker ${panel.breaker?.count ?? 0}/${panel.breaker?.max ?? 0}${panel.breaker?.open ? " OPEN" : ""}`,
  ];
  const ls = panel.lastSwitch;
  if (ls && typeof ls.ts === "number") {
    parts.push(`last: ${ls.from ?? "?"} → ${ls.to ?? "?"} (${ls.reason ?? "?"}, ${ageText(panelAge({ ...panel, ts: ls.ts }, nowMs))} ago)`);
  }
  let h = `<div class="swblock" data-testid="csm-switch-block"><div class="swline">${esc(parts.join(" · "))}</div>`;
  if (panel.nextHint) h += `<div class="swline sw-hint">next: ${esc(panel.nextHint)}</div>`;
  const events = [...(panel.events ?? [])].sort((a, b) => b.ts - a.ts).slice(0, MAX_EVENTS);
  for (const e of events) {
    h += `<div class="swline ${cls(e.kind)}"><span class="num">${hhmm(e.ts)}</span>  ${esc(e.text)}</div>`;
  }
  return h + "</div>";
}

/** Per-account decorations for the existing cards (empty when nothing to say). */
export function accountBadges(panel: SwitchPanel | null, email: string): { rank?: number; loginNeeded?: string } {
  if (!panel) return {};
  const out: { rank?: number; loginNeeded?: string } = {};
  const rank = rankOf(panel, email);
  if (rank !== undefined) out.rank = rank;
  const a = findAccount(panel, email);
  if (a?.needsLogin) out.loginNeeded = a.needsLoginReason ?? "unknown";
  return out;
}

/** Badges keyed by email for every account the panel knows. */
export function allBadges(panel: SwitchPanel | null): Record<string, { rank?: number; loginNeeded?: string }> {
  const emails = new Set<string>([...(panel?.priority ?? []), ...(panel?.accounts ?? []).map((a) => a.email)]);
  const out: Record<string, { rank?: number; loginNeeded?: string }> = {};
  for (const e of emails) out[e] = accountBadges(panel, e);
  return out;
}
