// Read-only feed from ~/.claude/bin/claude-switch: panel.json in the same state
// dir as the vault. Pure helpers (no vscode import) so they are unit-tested; the
// extension host renders the block and the webview only injects the HTML.
// claude-switch is an optional local CLI: every surface of it (this block, the
// badges, the shared vault, `use` and `tick`) is gated on switchInstalled().
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AccountInfo, AccountsFile } from "./core";

export const SWITCH_CLI = path.join(os.homedir(), ".claude", "bin", "claude-switch");
export const SWITCH_STATE_DIR = path.join(os.homedir(), ".claude", "state", "claude-switch");
export const SWITCH_PANEL_FILE = path.join(SWITCH_STATE_DIR, "panel.json");
export const PANEL_STALE_SEC = 600;
const MAX_EVENTS = 8;

/** True when the claude-switch CLI is installed (the one detection point for every claude-switch surface). */
export function switchInstalled(cli: string = SWITCH_CLI): boolean {
  return fs.existsSync(cli);
}

export interface PanelAccount {
  uuid?: string;
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

/** The panel only while the CLI is installed: a leftover panel.json alone never counts. */
export function installedPanel(cli: string = SWITCH_CLI, file: string = SWITCH_PANEL_FILE): SwitchPanel | null {
  return switchInstalled(cli) ? readPanel(file) : null;
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

/** True when a panel exists and is fresh enough for claude-switch to own switching. */
export function panelFresh(panel: SwitchPanel | null, nowMs: number): panel is SwitchPanel {
  return !!panel && panelAge(panel, nowMs) <= PANEL_STALE_SEC;
}

const ACTIVITY_KINDS = new Set(["switch", "restore", "needsLogin", "cleared", "error", "rollback", "paused", "resumed", "offline", "ratelimit"]);
const MUTED_KINDS = new Set(["offline", "ratelimit"]);

/** HTML for the claude-switch block (empty-state line when missing or stale). `activityOpen` is the persisted toggle (default collapsed). */
export function renderSwitchBlock(panel: SwitchPanel | null, nowMs: number, activityOpen = false): string {
  const age = panel ? panelAge(panel, nowMs) : null;
  if (!panel || age === null || age > PANEL_STALE_SEC) {
    const why = panel && age !== null ? `${ageText(age)} old` : "file missing";
    return `<div class="swblock" data-testid="csm-switch-block"><div class="swline sw-info">claude-switch: no data (${esc(why)})</div></div>`;
  }
  const rank = rankOf(panel, panel.active?.email);
  const parts = [`claude-switch`, panel.active?.email ?? "?", ...(rank !== undefined ? [`#${rank}`] : []), panel.paused ? "PAUSED" : "auto"];
  const events = [...(panel.events ?? [])]
    .filter((e) => ACTIVITY_KINDS.has(e.kind))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_EVENTS);
  let h = `<div class="swblock" data-testid="csm-switch-block"><div class="swline">${esc(parts.join(" · "))}</div>`;
  if (panel.nextHint) h += `<div class="swline sw-hint">next: ${esc(panel.nextHint)}</div>`;
  h += `<div class="swtoggle" role="button" tabindex="0" data-swtoggle="1" aria-expanded="${activityOpen}" data-testid="csm-switch-activity-toggle"><span class="chev">${activityOpen ? "▾" : "▸"}</span> Activity (${events.length})</div>`;
  h += `<div class="swevents" data-testid="csm-switch-activity"${activityOpen ? "" : " hidden"}>`;
  for (const e of events) {
    h += `<div class="swline ${cls(e.kind)}${MUTED_KINDS.has(e.kind) ? " sw-muted" : ""}"><span class="num">${hhmm(e.ts)}</span>  ${esc(e.text)}</div>`;
  }
  return h + "</div></div>";
}

export interface CardHeader {
  rank?: number;
  name: string;
  chip: "active" | "ready" | "exhausted" | "login";
  resetMs?: number; // exhausted: when the exhausting gauge(s) reset
  exhausted?: boolean; // active login that is also exhausted (the chip stays "active")
  loginNeeded?: boolean; // active login that claude-switch flags as needing a login (the chip stays "active")
  gauges?: HeaderGauge[];
}
export interface HeaderGauge { label: string; short: string; pct: number; hot: boolean }
interface HGauge { label: string; pct: number | null; resetMs: number | null }

/** Display names: email local part, plus the domain's first label when two local parts collide. */
export function displayNames(emails: string[]): string[] {
  const local = (e: string): string => e.split("@")[0] || e;
  const counts = new Map<string, number>();
  for (const e of emails) counts.set(local(e).toLowerCase(), (counts.get(local(e).toLowerCase()) ?? 0) + 1);
  return emails.map((e) => {
    const [l, d] = [local(e), e.split("@")[1]?.split(".")[0]];
    return (counts.get(l.toLowerCase()) ?? 0) > 1 && d ? `${l}@${d}` : l;
  });
}

/** The single most-used gauge (null when none has a percentage). */
export function worstGauge(gauges: HGauge[]): { label: string; pct: number } | undefined {
  let w: HGauge | undefined;
  for (const g of gauges) if (typeof g.pct === "number" && (!w || g.pct > (w.pct as number))) w = g;
  return w ? { label: w.label.replace(/\s*\((5h|7d)\)/, ""), pct: w.pct as number } : undefined;
}

/** All gauges with a percentage for the header line: session, weekly (all models), then scoped weeklies in arrival order. */
export function headerGauges(gauges: HGauge[]): HeaderGauge[] {
  const rank = (l: string): number => (/^Session/i.test(l) ? 0 : /^Weekly(?!\s*·)/i.test(l) ? 1 : 2);
  const named = (g: HGauge): HeaderGauge => {
    const scoped = g.label.match(/^Weekly\s*·\s*(.+)$/i);
    const label = scoped ? scoped[1].trim() : g.label.replace(/\s*\((5h|7d)\)/, "");
    const pct = g.pct as number;
    return { label, short: label.charAt(0).toUpperCase(), pct, hot: pct >= 90 };
  };
  return gauges
    .filter((g) => typeof g.pct === "number")
    .map((g, i) => ({ g, i, r: rank(g.label) }))
    .sort((x, y) => x.r - y.r || x.i - y.i)
    .map((x) => named(x.g));
}

/** Header chip: the active login is always "active" (adding login needed and an exhausted reset); others login needed > exhausted (a gauge at 100%) > ready. */
export function headerChip(
  a: { active: boolean; loginNeeded: boolean; gauges: HGauge[] },
): Pick<CardHeader, "chip" | "resetMs" | "exhausted" | "loginNeeded"> {
  const full = a.gauges.filter((g) => typeof g.pct === "number" && g.pct >= 100);
  const resets = full.map((g) => g.resetMs).filter((r): r is number => typeof r === "number");
  const reset = resets.length ? { resetMs: Math.max(...resets) } : {};
  if (a.active) return { chip: "active", ...(a.loginNeeded ? { loginNeeded: true } : {}), ...(full.length ? { exhausted: true, ...reset } : {}) };
  if (a.loginNeeded) return { chip: "login" };
  if (full.length) return { chip: "exhausted", ...reset };
  return { chip: "ready" };
}

/** Claude cards by claude-switch priority (rank, else priority order); unranked after, Codex last. Stable. */
export function orderCards<T extends { provider: string; label: string; email?: string }>(cards: T[], panel: SwitchPanel | null): T[] {
  const email = (c: T): string => c.email ?? c.label.replace(/^(Claude|Codex) · /, "");
  const key = (c: T): number => {
    if (c.provider !== "claude") return Infinity;
    const r = panel ? rankOf(panel, email(c)) : undefined;
    return r ?? 1e6;
  };
  return cards.map((c, i) => ({ c, i })).sort((x, y) => key(x.c) - key(y.c) || x.i - y.i).map((x) => x.c);
}

/** Add every panel account (uuid + email) missing from the registry; no tokens, active login untouched. */
export function mergePanelAccounts(f: AccountsFile, panel: SwitchPanel | null): AccountsFile {
  const add: AccountInfo[] = [];
  for (const a of panel?.accounts ?? []) {
    if (!a.uuid || !/^[0-9a-f-]{36}$/.test(a.uuid) || !a.email) continue;
    if (f.accounts.some((x) => x.id === a.uuid) || add.some((x) => x.id === a.uuid)) continue;
    add.push({ id: a.uuid, email: a.email, lastSeenTs: 0 });
  }
  return add.length ? { ...f, accounts: [...f.accounts, ...add] } : f;
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
