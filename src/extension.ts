/**
 * extension.ts - VS Code UI for the Claude Session Monitor (v0.3).
 *
 * Activity Bar sidebar with two views:
 *  - a tree of all interactive Claude Code sessions grouped by live state
 *    (limited / waiting / your-turn / working / ended), each row showing
 *    CPU% + RAM, with an Activity Bar badge, toasts + native macOS
 *    notifications, a live limit-reset countdown, a stuck-session alert,
 *    a "needs-you only" filter, and click -> best-effort jump to that tab.
 *  - a webview charting the account usage limits (5-hour / 7-day) as gauges
 *    with reset countdowns plus a usage sparkline.
 *
 * Session state comes from core.ts (hook status files + transcript tails).
 * Usage-limit data comes from limits.json (written by statusline.sh).
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import { execFile } from "child_process";
import {
  collectSessions,
  countBuckets,
  findRecentTranscripts,
  cleanupMonitorFiles,
  cleanupEndedMonitorFiles,
  readLimits,
  readLimitsHistory,
  appendLimitsHistory,
  pruneLimitsHistory,
  parseResetToEpoch,
  scanTokenUsage,
  humanizeAge,
  readOfficialSnapshot,
  writeOfficialSnapshot,
  MONITOR_DIR,
  PROJECTS_DIR,
  DEFAULT_ENTRYPOINTS,
  type SessionView,
  type RecentTranscript,
  type TxInfo,
  type TokenUsage,
} from "./core";
import {
  GROUPS,
  GROUP_INDEX,
  NEEDS_YOU,
  groupOf,
  normPct,
  normResetMs,
  clampPct,
  fmtMb,
  labelsMatch,
  parsePsOutput,
  parseOfficialGauges,
  truncateTitle,
  computeBurnEta,
  estimateCostUsd,
  shortModelName,
  fmtTokensCompact,
  nextUsageBackoffSec,
  type BurnEta,
  type GroupKey,
  type GroupMeta,
  type OfficialGauge,
} from "./view";

/** Append a line to ~/.claude/session-monitor/csm-debug.log (best-effort, for diagnosis). */
const LOG_FILE = `${MONITOR_DIR}/csm-debug.log`;
let logCount = 0;

function rotateLog(): void {
  try {
    if (fs.statSync(LOG_FILE).size > 1024 * 1024) {
      const buf = fs.readFileSync(LOG_FILE);
      fs.writeFileSync(LOG_FILE, buf.subarray(buf.length - 128 * 1024));
    }
  } catch {
    /* no log yet */
  }
}

function log(msg: string): void {
  try {
    if (logCount++ % 1000 === 0) rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

const RES_FRESH_SEC = 12;

interface ResStat {
  cpu: number;
  rssMb: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

type Node =
  | { kind: "group"; group: GroupMeta; count: number }
  | { kind: "session"; view: SessionView };

class SessionTree implements vscode.TreeDataProvider<Node> {
  private _onDidChange = new vscode.EventEmitter<Node | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private grouped = new Map<GroupKey, SessionView[]>();
  private tokenHogId: string | null = null;
  private tok5h: Record<string, number> = {};

  constructor(
    private readonly res: Map<number, ResStat>,
    private readonly hogThreshold: () => number,
  ) {}

  setTokenInfo(hogId: string | null, tok5h: Record<string, number>): void {
    this.tokenHogId = hogId;
    this.tok5h = tok5h;
  }

  setData(views: SessionView[]): void {
    const g = new Map<GroupKey, SessionView[]>();
    for (const v of views) {
      const k = groupOf(v);
      const arr = g.get(k) ?? [];
      arr.push(v);
      g.set(k, arr);
    }
    this.grouped = g;
    this._onDidChange.fire();
  }

  rerender(): void {
    this._onDidChange.fire();
  }

  private resOf(view: SessionView): ResStat | undefined {
    if (!view.pid) return undefined;
    const r = this.res.get(view.pid);
    if (!r) return undefined;
    if (Date.now() / 1000 - r.ts > RES_FRESH_SEC) return undefined;
    return r;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "group") {
      const item = new vscode.TreeItem(
        `${node.group.label} (${node.count})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(node.group.icon, new vscode.ThemeColor(node.group.color));
      item.contextValue = "group";
      return item;
    }
    const v = node.view;
    try {
      // Fixed-width label: long titles are cut so the state/CPU/RAM description
      // after them stays visible; the tooltip carries the full title.
      const item = new vscode.TreeItem(truncateTitle(v.title), vscode.TreeItemCollapsibleState.None);

      const res = this.resOf(v);
      const segs = [v.sub];
      if (v.detail) segs.push(v.detail);
      if (res) {
        const hog = res.cpu >= this.hogThreshold();
        segs.push(`${hog ? "🔥" : ""}CPU ${Math.round(res.cpu)}% · ${res.rssMb}MB`);
      }
      if (v.sessionId === this.tokenHogId) segs.push("💸");
      item.description = segs.join(" · ");

      const resTip = res ? `\nCPU: ${Math.round(res.cpu)}%  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
      const tok = this.tok5h[v.sessionId];
      const tokTip = tok
        ? `\ntokens (5h): ${fmtTokensCompact(tok)}${v.sessionId === this.tokenHogId ? "  💸 top consumer" : ""}`
        : "";
      item.tooltip = v.tooltip + resTip + tokTip;
      item.contextValue = groupOf(v) === "ended" ? "session-ended" : "session";
      const g = GROUPS[GROUP_INDEX[groupOf(v)]];
      item.iconPath = new vscode.ThemeIcon(
        groupOf(v) === "working" && v.stale ? "warning" : g.icon,
        new vscode.ThemeColor(g.color),
      );
      item.command = {
        command: "claudeSessionMonitor.openSession",
        title: "Open",
        arguments: [v],
      };
      return item;
    } catch (e) {
      log("getTreeItem error: " + String(e));
      const fb = new vscode.TreeItem(v.title || v.sessionId, vscode.TreeItemCollapsibleState.None);
      fb.contextValue = "session";
      return fb;
    }
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const out: Node[] = [];
      for (const meta of GROUPS) {
        const arr = this.grouped.get(meta.key);
        if (arr && arr.length) out.push({ kind: "group", group: meta, count: arr.length });
      }
      return out;
    }
    if (node.kind === "group") {
      return (this.grouped.get(node.group.key) ?? []).map((view) => ({ kind: "session", view }));
    }
    return [];
  }
}

// ---------------------------------------------------------------------------
// Usage-limits webview
// ---------------------------------------------------------------------------

interface Gauge {
  key: string;
  label: string;
  pct: number | null;
  resetMs: number | null;
}

interface LimitedHit {
  title: string;
  sub: string;
  resetText?: string;
  resetMs: number | null;
}

interface ModelRow {
  name: string;
  tokens: number;
  pct: number;
  cost: number | null; // null = model not publicly priced
}

interface LimitsPayload {
  type: "update";
  ts: number | null;
  model: string | null;
  official: boolean; // true only when real 5h/7d gauges are available (terminal status line)
  gauges: Gauge[];
  history: { t: number; fh: number | null; sd: number | null }[];
  limited: LimitedHit[]; // reactive: sessions that actually hit a limit (from transcripts)
  tokens: TokenUsage | null; // rolling 5h / 7d token usage (proxy for limit pressure)
  eta: BurnEta | null; // burn-rate projection for the 5h window
  models: ModelRow[]; // 7d token share per model (+ rough cost where priced)
  usageNote: string | null; // honest status when the usage API is degraded
}

// ---------------------------------------------------------------------------
// Official account usage (5h / 7d) via api.anthropic.com/api/oauth/usage.
// Same source the "Claude Usage Bar" extension uses: the OAuth token from the
// macOS keychain item "Claude Code-credentials". Read-only GET of your own
// account usage; no data leaves to anywhere but Anthropic's usage endpoint.
// ---------------------------------------------------------------------------

interface OfficialUsage {
  gauges: OfficialGauge[];
  ts: number;
}

// The keychain read spawns a `security` subprocess; with a 10s usage poll that
// would be constant churn, so the token is cached and invalidated on 401/403.
const TOKEN_TTL_SEC = 300;
let cachedToken: { value: string; ts: number } | undefined;

async function readClaudeTokenCached(): Promise<string | undefined> {
  if (cachedToken && Date.now() / 1000 - cachedToken.ts < TOKEN_TTL_SEC) return cachedToken.value;
  const t = await readClaudeToken();
  if (t) cachedToken = { value: t, ts: Date.now() / 1000 };
  return t;
}

function readClaudeToken(): Promise<string | undefined> {
  if (process.platform !== "darwin") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const user = process.env.USER || os.userInfo().username || "";
    execFile(
      "security",
      ["find-generic-password", "-a", user, "-w", "-s", "Claude Code-credentials"],
      { encoding: "utf8", timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        try {
          const creds = JSON.parse(String(stdout).trim());
          resolve(creds?.claudeAiOauth?.accessToken);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

type UsageFetch =
  | { ok: true; usage: OfficialUsage }
  | { ok: false; status?: number; retryAfterSec?: number };

async function fetchOfficialUsage(): Promise<UsageFetch> {
  const token = await readClaudeTokenCached();
  if (!token) {
    log("usage: no keychain token");
    return { ok: false };
  }
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) cachedToken = undefined; // token rotated -> re-read keychain
      log(`usage: HTTP ${res.status}`);
      const ra = parseInt(res.headers.get("retry-after") ?? "", 10);
      return { ok: false, status: res.status, retryAfterSec: Number.isFinite(ra) ? ra : undefined };
    }
    const p: unknown = await res.json();
    const gauges = parseOfficialGauges(p);
    if (!gauges.length) {
      log("usage: no gauges in payload");
      return { ok: false };
    }
    return { ok: true, usage: { gauges, ts: Date.now() / 1000 } };
  } catch (e) {
    log("usage: fetch error " + String(e));
    return { ok: false };
  }
}

function buildLimitsPayload(
  views: SessionView[],
  tokens: TokenUsage | null,
  officialUsage: OfficialUsage | null,
  usageNote: string | null = null,
): LimitsPayload {
  const now = Date.now() / 1000;
  const gauges: Gauge[] = [];
  let model: string | null = null;
  let ts: number | null = null;

  if (officialUsage && officialUsage.gauges.length) {
    ts = officialUsage.ts;
    for (const g of officialUsage.gauges) gauges.push({ key: g.key, label: g.label, pct: g.pct, resetMs: g.resetMs });
  } else {
    // Fallback: limits.json written by a terminal status line (if present).
    const lim = readLimits();
    if (lim) {
      ts = lim.ts ?? null;
      model = lim.model ?? null;
      gauges.push({ key: "5h", label: "Session (5h)", pct: normPct(lim.fh), resetMs: normResetMs(lim.fh_reset) });
      gauges.push({ key: "7d", label: "Weekly (7d)", pct: normPct(lim.sd), resetMs: normResetMs(lim.sd_reset) });
      if (lim.sds != null)
        gauges.push({ key: "7d-sonnet", label: "Weekly · Sonnet", pct: normPct(lim.sds), resetMs: normResetMs(lim.sds_reset) });
    }
  }

  const official = gauges.some((g) => g.pct != null);
  // Extension-written points are always percent scale; statusline points may be 0-1.
  const history = readLimitsHistory(240).map((p) => ({
    t: typeof p.ts === "number" ? p.ts * 1000 : 0,
    fh: p.src === "ext" ? clampPct(p.fh) : normPct(p.fh),
    sd: p.src === "ext" ? clampPct(p.sd) : normPct(p.sd),
  }));
  const limited: LimitedHit[] = views
    .filter((v) => v.bucket === "limited")
    .map((v) => {
      const e = v.resetText ? parseResetToEpoch(v.resetText, now) : undefined;
      return { title: v.title, sub: v.sub, resetText: v.resetText, resetMs: e ? e * 1000 : null };
    });

  const g5 = gauges.find((g) => g.key === "session" || g.key === "5h");
  const eta = computeBurnEta(history, g5?.pct ?? null, g5?.resetMs ?? null, Date.now());

  let models: ModelRow[] = [];
  if (tokens?.byModel7d) {
    const entries = Object.entries(tokens.byModel7d).sort((a, b) => b[1].tokens - a[1].tokens);
    const total = entries.reduce((s, [, m]) => s + m.tokens, 0) || 1;
    models = entries.slice(0, 6).map(([id, m]) => ({
      name: shortModelName(id),
      tokens: m.tokens,
      pct: Math.round((m.tokens / total) * 100),
      cost: estimateCostUsd(m, id),
    }));
  }

  return {
    type: "update",
    ts,
    model,
    official,
    gauges,
    history,
    limited,
    tokens,
    eta,
    models,
    usageNote,
  };
}

class LimitsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: LimitsPayload;

  constructor(private readonly onRefresh: () => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = limitsHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === "refresh") this.onRefresh();
    });
    if (this.pending) view.webview.postMessage(this.pending);
  }

  update(payload: LimitsPayload): void {
    this.pending = payload;
    this.view?.webview.postMessage(payload);
  }
}

function nonceStr(): string {
  return (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 24);
}

function limitsHtml(): string {
  const nonce = nonceStr();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 10px; }
  .empty { opacity: .65; padding: 6px 0; }
  .gauge { margin: 0 0 10px 0; }
  .grow { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:3px; }
  .glabel { font-weight:600; }
  .gpct { font-variant-numeric: tabular-nums; }
  .greset { opacity:.7; font-size:11px; }
  .bar { height:8px; border-radius:4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.18)); overflow:hidden; }
  .fill { height:100%; border-radius:4px; transition: width .4s ease; }
  .segs { display:flex; gap:3px; margin:3px 0; }
  .seg { flex:1; height:9px; border-radius:2px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.2)); }
  .spark { margin-top:8px; }
  .spark h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .legend { font-size:11px; opacity:.7; display:flex; gap:12px; margin-top:2px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  svg { width:100%; height:48px; display:block; }
  .foot { margin-top:8px; font-size:11px; opacity:.55; }
  .sec { margin-top:10px; }
  .sec h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .hit { padding:4px 0; border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.2)); }
  .hitt { font-weight:600; }
  .note { margin-top:10px; font-size:11px; opacity:.6; line-height:1.4; }
  .eta { font-size:11px; margin:-6px 0 10px 0; opacity:.85; }
  .eta.bad { color: var(--vscode-charts-red, #f14c4c); opacity:1; }
  .mrow { display:flex; align-items:center; gap:6px; margin:3px 0; }
  .mname { width:84px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mbar { flex:1; height:7px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.18)); overflow:hidden; }
  .mfill { height:100%; border-radius:3px; }
  .mval { font-size:10px; font-variant-numeric: tabular-nums; opacity:.75; white-space:nowrap; }
  .topbar { display:flex; justify-content:flex-end; margin:0 0 6px 0; }
  .refresh { display:inline-flex; align-items:center; gap:5px; cursor:pointer; font-size:11px;
    padding:3px 9px; border-radius:4px; border:1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(127,127,127,.16));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); user-select:none; }
  .refresh:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(127,127,127,.28)); }
  .refresh.spin .ic { animation: sp 1s linear infinite; }
  .ic { display:inline-block; }
  @keyframes sp { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="topbar"><span id="refreshBtn" class="refresh" title="Re-fetch usage from Anthropic now (use after switching Claude accounts)"><span class="ic">⟳</span> Refresh usage</span></div>
  <div id="root"><div class="empty">Waiting for usage-limit data… (reload the window once so the status line starts reporting)</div></div>
<script nonce="${nonce}">
const C_OK = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-green') || '#4caf50';
const C_WARN = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-yellow') || '#e6b800';
const C_BAD = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-red') || '#f14c4c';
const C_BLUE = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-blue') || '#3794ff';
let last = null;

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function color(p){ if(p==null) return 'gray'; if(p>=90) return C_BAD; if(p>=70) return C_WARN; return C_OK; }
function fmtLeft(ms){
  if(ms==null) return '';
  let s = Math.round((ms - Date.now())/1000);
  if(s<=0) return 'resets now';
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  if(d>0) return 'resets in '+d+'d '+h+'h';
  if(h>0) return 'resets in '+h+'h '+m+'m';
  if(m>0) return 'resets in '+m+'m';
  return 'resets in <1m';
}
function spark(history, eta){
  const pts = (history||[]).filter(p=>p.fh!=null || p.sd!=null);
  if(pts.length < 2) return '';
  const W=300, H=48, n=pts.length;
  // History points arrive ~1/min, so index ~= minutes; when a projection is
  // shown, the last 15% of the width is reserved for it.
  const spanW = eta ? W*0.85 : W;
  const x = i => (i/(n-1))*spanW;
  const y = v => H - (Math.max(0,Math.min(100,v))/100)*(H-4) - 2;
  const line = (key,col) => {
    let d='', started=false;
    pts.forEach((p,i)=>{ const v=p[key]; if(v==null) return; d += (started?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)+' '; started=true; });
    return d ? '<polyline fill="none" stroke="'+col+'" stroke-width="1.5" points="'+d.replace(/[ML]/g,' ').trim()+'"/>' : '';
  };
  let proj='';
  if(eta){
    const fhPts = pts.filter(p=>p.fh!=null);
    if(fhPts.length){
      const lastFh = fhPts[fhPts.length-1].fh;
      // Continue the observed slope: perHour/60 percent points per minute-step.
      const stepPct = eta.perHour/60;
      const stepPx = spanW/Math.max(1,n-1);
      let px = spanW, pv = lastFh, d = 'M'+px.toFixed(1)+','+y(pv).toFixed(1)+' ';
      while(px < W && pv < 100){ px += stepPx; pv += stepPct; d += 'L'+Math.min(px,W).toFixed(1)+','+y(Math.min(pv,100)).toFixed(1)+' '; }
      proj = '<polyline fill="none" stroke="'+(eta.beforeReset?C_BAD:C_BLUE)+'" stroke-width="1.5" stroke-dasharray="3,3" points="'+d.replace(/[ML]/g,' ').trim()+'"/>';
    }
  }
  return '<div class="spark"><h4>Usage over time</h4><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'
    + line('fh', C_BLUE) + line('sd', C_WARN) + proj
    + '</svg><div class="legend"><span><span class="dot" style="background:'+C_BLUE+'"></span>5-hour</span>'
    + '<span><span class="dot" style="background:'+C_WARN+'"></span>7-day</span>'
    + (eta ? '<span>┄ projected</span>' : '')
    + '</div></div>';
}
function fmtDur(ms){
  if(ms==null || ms<=0) return 'now';
  const s=Math.round(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if(h>0) return h+'h '+m+'m';
  if(m>0) return m+'m';
  return '<1m';
}
function etaLine(eta){
  if(!eta) return '';
  const cls = eta.beforeReset ? 'eta bad' : 'eta';
  const tail = eta.beforeReset ? ' — before reset ⚠️' : ' (after reset, safe)';
  return '<div class="'+cls+'">at this rate (+'+eta.perHour.toFixed(1)+'%/h): full in '+fmtDur(eta.fullAtMs-Date.now())+tail+'</div>';
}
function modelSection(models){
  if(!models || !models.length) return '';
  let h='<div class="sec"><h4>Models (7d share)</h4>';
  let total=0, priced=true;
  for(const m of models){
    h += '<div class="mrow"><span class="mname" title="'+esc(m.name)+'">'+esc(m.name)+'</span>'
      + '<span class="mbar"><span class="mfill" style="width:'+Math.max(2,m.pct)+'%;background:'+C_BLUE+'"></span></span>'
      + '<span class="mval">'+m.pct+'% · '+fmtTokens(m.tokens)+(m.cost!=null?(' · ≈$'+m.cost.toFixed(2)):'')+'</span></div>';
    if(m.cost!=null) total+=m.cost; else priced=false;
  }
  if(total>0) h += '<div class="legend"><span>≈$'+total.toFixed(2)+' total'+(priced?'':' (priced models only)')+' · rough, excl. cache reads</span></div>';
  h += '</div>';
  return h;
}
function fmtTokens(n){
  if(n==null) return '0';
  if(n<1000) return ''+Math.round(n);
  if(n<1e6) return (n/1e3).toFixed(n<1e4?1:0)+'K';
  return (n/1e6).toFixed(2)+'M';
}
function tokenSection(t){
  if(!t) return '';
  const hrs = t.hourly||[];
  const max = Math.max(1, ...hrs.map(h=>h.tokens||0));
  const W=300,H=40,n=hrs.length||1, bw=W/n;
  let bars='';
  hrs.forEach((h,i)=>{ const bh=(h.tokens/max)*(H-2); bars+='<rect x="'+(i*bw).toFixed(1)+'" y="'+(H-bh).toFixed(1)+'" width="'+(bw*0.8).toFixed(1)+'" height="'+Math.max(0,bh).toFixed(1)+'" fill="'+C_BLUE+'"/>'; });
  return '<div class="sec"><h4>Token usage (in + out + cache-write)</h4>'
    + '<div class="grow"><span class="glabel">Last 5h</span><span class="gpct">'+fmtTokens(t.fiveHour)+'</span></div>'
    + '<div class="grow"><span class="glabel">Last 7d</span><span class="gpct">'+fmtTokens(t.sevenDay)+'</span></div>'
    + '<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+bars+'</svg>'
    + '<div class="legend"><span>hourly, last 48h</span></div></div>';
}
function render(){
  const root = document.getElementById('root');
  if(!last){ return; }
  let h='';
  // Official 5h / 7d gauges: only present when a terminal status line feeds limits.json.
  if(last.official){
    for(const g of last.gauges){
      const p = g.pct;
      const used = p==null ? 0 : Math.round(p);
      const left = p==null ? 100 : Math.max(0, 100 - used);
      const filled = p==null ? 0 : Math.max(0, Math.min(10, Math.round(p/10)));
      let segs='';
      for(let i=0;i<10;i++) segs += '<div class="seg" style="'+(i<filled?('background:'+color(p)):'')+'"></div>';
      h += '<div class="gauge"><div class="grow"><span class="glabel">'+esc(g.label)+'</span>'
         + '<span class="gpct">'+used+'% used</span></div>'
         + '<div class="segs">'+segs+'</div>'
         + '<div class="greset"><b>'+left+'% left</b>'+(g.resetMs?(' · '+fmtLeft(g.resetMs)):'')+'</div></div>';
      if((g.key==='session'||g.key==='5h')) h += etaLine(last.eta);
    }
    if(last.ts){
      const age = Math.round(Date.now()/1000 - last.ts);
      h += '<div class="foot">official account usage · updated '+age+'s ago</div>';
    }
  }
  h += spark(last.history, last.eta);
  // Token usage (real proxy; always shown when available).
  h += tokenSection(last.tokens);
  h += modelSection(last.models);
  // Reactive limit hits: always real, derived from session transcripts (429).
  if(last.limited && last.limited.length){
    h += '<div class="sec"><h4>Active limit hits</h4>';
    for(const l of last.limited){
      const reset = l.resetMs ? (' · '+fmtLeft(l.resetMs)) : (l.resetText? (' · resets '+esc(l.resetText)) : '');
      h += '<div class="hit"><span class="hitt">'+esc(l.title)+'</span> <span class="greset">'+esc(l.sub)+reset+'</span></div>';
    }
    h += '</div>';
  }
  // Honest status when the usage API is degraded (rate-limit backoff etc.).
  if(last.usageNote){
    h += '<div class="note">'+esc(last.usageNote)+'</div>';
  }
  // Honest note when the official live gauges are unavailable (VS Code app mode).
  if(!last.official && !last.usageNote){
    h += '<div class="note">Official 5h / 7d usage unavailable (needs macOS keychain access to "Claude Code-credentials" + network). The token-usage proxy below still works; sessions also appear under "Active limit hits" the moment they hit a limit.</div>';
  }
  root.innerHTML = h;
}
const vscodeApi = acquireVsCodeApi();
const refreshBtn = document.getElementById('refreshBtn');
let spinDeadline = 0;
function stopSpinIfDone(){
  // Spin while the manual fetch is in flight ("refreshing…" note), then stop;
  // also a hard 8s deadline so a hung fetch can't spin forever.
  const refreshing = last && typeof last.usageNote === 'string' && last.usageNote.indexOf('refreshing') === 0;
  if(!refreshing || Date.now() > spinDeadline) refreshBtn.classList.remove('spin');
}
refreshBtn.addEventListener('click', () => {
  vscodeApi.postMessage({ type: 'refresh' });
  refreshBtn.classList.add('spin');
  spinDeadline = Date.now() + 8000;
});
window.addEventListener('message', e => {
  if(e.data && e.data.type==='update'){ last = e.data; stopSpinIfDone(); render(); }
});
setInterval(() => { stopSpinIfDone(); render(); }, 1000); // keep countdowns live
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(ctx: vscode.ExtensionContext): void {
  const cfg = () => vscode.workspace.getConfiguration("claudeSessionMonitor");
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const resourceCache = new Map<number, ResStat>();
  const tree = new SessionTree(resourceCache, () => cfg().get<number>("cpuHogThreshold", 60));
  const treeView = vscode.window.createTreeView("claudeSessionMonitor.view", {
    treeDataProvider: tree,
    showCollapseAll: false,
  });
  ctx.subscriptions.push(treeView);

  const limitsView = new LimitsView(() => vscode.commands.executeCommand("claudeSessionMonitor.refreshUsage"));
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.limits", limitsView),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "claudeSessionMonitor.focus";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  const txCache = new Map<string, TxInfo>();
  const lastSeen = new Map<string, GroupKey>();
  const stuckNotified = new Set<string>();
  let recentCache: RecentTranscript[] = [];
  let lastViews: SessionView[] = [];
  let lastRecentScan = 0;
  let lastCleanup = 0;
  let lastResourceSample = 0;
  let lastTokenScan = 0;
  let lastSessLog = 0;
  let tokenUsage: TokenUsage | null = null;
  let officialUsage: OfficialUsage | null = null;
  let usageNote: string | null = null;
  let lastUsageCheck = 0;
  let usageFetchInflight = false;

  // Boot from the shared snapshot so gauges render immediately (with an honest
  // "updated Xs ago" age) even before the first live fetch succeeds.
  const bootSnap = readOfficialSnapshot();
  if (bootSnap?.gauges.length && bootSnap.ts) officialUsage = { gauges: bootSnap.gauges, ts: bootSnap.ts };
  let firstPaintDone = false;
  let needsYouOnly = false;
  let workspaceOnlyOverride: boolean | undefined;
  const dismissed = new Set<string>();
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeActive = false;
  let autoResumeTimer: ReturnType<typeof setTimeout> | undefined;
  let autoResumeAt = 0;
  let lastIdleRamWarn = 0;
  let focusCursor = "";

  // Auto-resume: when sessions are limited (or the 5h window is pinned at 99%+),
  // schedule one staggered resume sweep for just after the window resets.
  function clearAutoResume(): void {
    if (autoResumeTimer) clearTimeout(autoResumeTimer);
    autoResumeTimer = undefined;
    autoResumeAt = 0;
  }

  function maybeScheduleAutoResume(views: SessionView[]): void {
    if (!cfg().get<boolean>("autoResumeAfterReset", false)) {
      clearAutoResume();
      return;
    }
    const nowMs = Date.now();
    const g5 = officialUsage?.gauges.find((g) => g.key === "session");
    let target = 0;
    const limitedViews = views.filter((v) => groupOf(v) === "limited");
    if (limitedViews.length) {
      for (const v of limitedViews) {
        const e = v.resetText ? parseResetToEpoch(v.resetText, nowMs / 1000) : undefined;
        if (e) target = target ? Math.min(target, e * 1000) : e * 1000;
      }
      if (!target && g5?.resetMs) target = g5.resetMs;
    } else if (g5 && g5.pct >= 99 && g5.resetMs) {
      target = g5.resetMs;
    }
    if (!target || target < nowMs - 10 * 60_000) {
      clearAutoResume();
      return;
    }
    const fireAt = target + 90_000; // buffer so the limit has actually cleared
    if (autoResumeTimer && Math.abs(fireAt - autoResumeAt) < 120_000) return; // close enough, keep it
    clearAutoResume();
    autoResumeAt = fireAt;
    const delay = Math.max(5_000, fireAt - nowMs);
    log(`auto-resume scheduled in ${Math.round(delay / 1000)}s`);
    autoResumeTimer = setTimeout(() => {
      autoResumeTimer = undefined;
      autoResumeAt = 0;
      if (!cfg().get<boolean>("autoResumeAfterReset", false) || resumeActive) return;
      vscode.window.showInformationMessage("Claude Sessions: limit reset — starting auto resume sweep.");
      vscode.commands.executeCommand("claudeSessionMonitor.resumeAll");
    }, delay);
  }

  // Notify once when a gauge crosses the warn threshold, then re-arm only after
  // it drops 5% below it (hysteresis). Dedup is keyed on the gauge key ALONE:
  // g.resetMs drifts by a few hundred ms every poll, so keying the dedup on it
  // meant the guard never matched and the extension re-notified on every poll.
  const usageWarnedWindow = new Map<string, number>();
  function checkUsageWarn(u: OfficialUsage): void {
    const warnPct = cfg().get<number>("usageWarnPercent", 85);
    if (warnPct <= 0) return;
    for (const g of u.gauges) {
      const windowId = g.resetMs ?? 0;
      if (g.pct >= warnPct) {
        if (usageWarnedWindow.has(g.key)) continue;
        usageWarnedWindow.set(g.key, windowId);
        const left = g.resetMs ? ` · resets in ${humanizeAge(Math.max(0, (g.resetMs - Date.now()) / 1000))}` : "";
        const msg = `${g.label} at ${Math.round(g.pct)}%${left}`;
        vscode.window.showWarningMessage(`⚠️ Claude usage: ${msg}`, "Show").then((ch) => {
          if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
        });
        nativeNotify(cfg(), "Claude: usage high", msg);
      } else if (g.pct < warnPct - 5) {
        usageWarnedWindow.delete(g.key); // dropped 5% below threshold -> re-arm one notification
      }
    }
  }

  const stopResume = (msg?: string) => {
    resumeActive = false;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = undefined;
    }
    if (msg) vscode.window.showInformationMessage(msg);
  };

  /**
   * Fetch official usage, coordinated across ALL VS Code windows through the
   * shared snapshot file: adopt fresher results other windows fetched, and
   * fetch ourselves only when the snapshot is stale AND nobody else just tried
   * AND the shared 429 backoff has expired — so the whole fleet stays at ~one
   * request per usagePollSeconds no matter how many windows are open.
   *
   * `force` (manual refresh) bypasses freshness/attempt/backoff throttles and
   * drops the cached keychain token, so switching Claude accounts is picked up
   * immediately.
   */
  async function pollUsage(force: boolean): Promise<void> {
    if (usageFetchInflight) return;
    const now = Date.now() / 1000;
    const usageEverySec = Math.max(5, cfg().get<number>("usagePollSeconds", 30));
    const snap = readOfficialSnapshot();
    if (!force && snap?.gauges.length && snap.ts && (!officialUsage || snap.ts > officialUsage.ts)) {
      officialUsage = { gauges: snap.gauges, ts: snap.ts }; // another window fetched it
    }
    const inBackoff = !force && !!snap?.backoffUntil && now < snap.backoffUntil;
    if (inBackoff) {
      usageNote = `usage API rate-limited — retrying in ${humanizeAge(Math.max(1, (snap!.backoffUntil as number) - now))}, showing last known data`;
    } else if (usageNote?.startsWith("usage API rate-limited")) {
      usageNote = null;
    }
    if (force) {
      cachedToken = undefined; // re-read keychain: the account may have changed
      usageNote = "refreshing usage from Anthropic…";
    }
    const fresh = !force && !!snap && now - snap.ts < usageEverySec;
    const attempted = !force && !!snap?.attemptTs && now - snap.attemptTs < Math.min(30, usageEverySec);
    if (fresh || inBackoff || attempted) {
      if (force) pushUsagePayload();
      return;
    }

    usageFetchInflight = true;
    writeOfficialSnapshot({ ...(snap ?? { gauges: [], ts: 0 }), attemptTs: now });
    if (force) pushUsagePayload(); // show the "refreshing…" note right away
    try {
      const r = await fetchOfficialUsage();
      const nowSec = Date.now() / 1000;
      const cur = readOfficialSnapshot() ?? { gauges: [], ts: 0 };
      if (r.ok) {
        officialUsage = r.usage;
        usageNote = null;
        writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: nowSec }); // clears backoff
        log(`usage ok${force ? " (manual)" : ""}: ${r.usage.gauges.map((g) => `${g.key}=${Math.round(g.pct)}`).join(" ")}`);
        const g5 = r.usage.gauges.find((g) => g.key === "session");
        const g7 = r.usage.gauges.find((g) => g.key === "weekly");
        appendLimitsHistory({
          src: "ext",
          fh: g5?.pct ?? null,
          fh_reset: g5?.resetMs ?? null,
          sd: g7?.pct ?? null,
          sd_reset: g7?.resetMs ?? null,
          ts: nowSec,
        });
        checkUsageWarn(r.usage);
      } else if (r.status === 429) {
        const b = nextUsageBackoffSec(cur.backoffSec, r.retryAfterSec);
        writeOfficialSnapshot({ ...cur, attemptTs: nowSec, backoffUntil: nowSec + b, backoffSec: b });
        usageNote = "usage API rate-limited — backing off, showing last known data";
        log(`usage backoff ${b}s`);
      } else if (force) {
        // Manual refresh with no token / network / gauges: say so honestly.
        usageNote =
          r.status === 401 || r.status === 403
            ? "not signed in to Claude Code, or the token is invalid (re-login, then refresh)"
            : "could not reach the usage API — check network, then refresh";
      }
    } catch (e) {
      log("usage rejected: " + String(e));
    } finally {
      usageFetchInflight = false;
    }
    pushUsagePayload();
  }

  function pushUsagePayload(): void {
    try {
      limitsView.update(buildLimitsPayload(lastViews, tokenUsage, officialUsage, usageNote));
      updateStatusBar(statusBar, lastViews, resourceCache, officialUsage);
    } catch {
      /* ignore */
    }
  }

  function refresh(): void {
    const now = Date.now() / 1000;
    const c = cfg();

    const maxAgeHours = c.get<number>("recentScanMaxAgeHours", 6);
    if (now - lastRecentScan > 25) {
      try {
        recentCache = findRecentTranscripts(maxAgeHours * 3600 * 1000, 120, now);
      } catch {
        /* ignore */
      }
      lastRecentScan = now;
    }

    if (now - lastCleanup > 600) {
      try {
        cleanupMonitorFiles(12 * 3600 * 1000, now);
        pruneLimitsHistory(3000);
      } catch {
        /* ignore */
      }
      lastCleanup = now;
    }

    if (now - lastTokenScan > 60) {
      lastTokenScan = now;
      try {
        const tx7 = findRecentTranscripts(7 * 86400 * 1000, 400, now);
        tokenUsage = scanTokenUsage(tx7, now);
      } catch {
        /* ignore */
      }
    }

    // Official usage poll — coordinated across ALL VS Code windows through the
    // shared snapshot file (see pollUsage).
    if (now - lastUsageCheck > 5) {
      lastUsageCheck = now;
      void pollUsage(false);
    }

    const wsOnly =
      workspaceOnlyOverride !== undefined ? workspaceOnlyOverride : c.get<boolean>("workspaceOnly", false);

    let views: SessionView[];
    try {
      views = collectSessions({
        now,
        extraTranscripts: recentCache,
        txCache,
        allowedEntrypoints: DEFAULT_ENTRYPOINTS,
        maxAgeSec: maxAgeHours * 3600,
        hideEndedOlderThanSec: c.get<number>("hideEndedAfterMinutes", 30) * 60,
        workspaceCwd: wsOnly ? workspaceCwd() : undefined,
        showEnded: c.get<boolean>("showEnded", false),
      });
    } catch {
      views = [];
    }

    for (const v of views) if (dismissed.has(v.sessionId) && groupOf(v) !== "ended") dismissed.delete(v.sessionId);
    if (dismissed.size) views = views.filter((v) => !dismissed.has(v.sessionId));
    if (needsYouOnly) views = views.filter((v) => NEEDS_YOU.includes(groupOf(v)));
    lastViews = views;

    if (now - lastSessLog > 20) {
      lastSessLog = now;
      log(`sessions=${views.length} ${JSON.stringify(countBuckets(views))} dismissed=${dismissed.size} needsYouOnly=${needsYouOnly}`);
    }

    // Token hog: the biggest 5h consumer, only when it is a meaningful share.
    let hogId: string | null = null;
    if (tokenUsage?.bySession5h) {
      const top = Object.entries(tokenUsage.bySession5h).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 200_000 && top[1] >= tokenUsage.fiveHour * 0.25) hogId = top[0];
    }
    tree.setTokenInfo(hogId, tokenUsage?.bySession5h ?? {});

    tree.setData(views);
    updateStatusBar(statusBar, views, resourceCache, officialUsage);
    updateAux(treeView, views, resourceCache, needsYouOnly);
    try {
      limitsView.update(buildLimitsPayload(views, tokenUsage, officialUsage, usageNote));
    } catch {
      /* ignore */
    }

    maybeScheduleAutoResume(views);

    // Idle RAM advisory: waiting/your-turn sessions silent >1h holding real memory.
    const idleThr = c.get<number>("idleRamWarnMb", 2000);
    if (idleThr > 0 && now - lastIdleRamWarn > 3600) {
      let rss = 0;
      let cnt = 0;
      for (const v of views) {
        const g = groupOf(v);
        if ((g === "done" || g === "waiting") && now - v.lastActivityMs / 1000 > 3600) {
          const r = freshRes(v, resourceCache);
          if (r) {
            rss += r.rssMb;
            cnt++;
          }
        }
      }
      if (cnt >= 2 && rss >= idleThr) {
        lastIdleRamWarn = now;
        vscode.window
          .showInformationMessage(
            `Claude Sessions: ${cnt} idle session(s) holding ${fmtMb(rss)} RAM — consider closing finished tabs.`,
            "Show",
          )
          .then((ch) => {
            if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
      }
    }

    detectTransitions(views, lastSeen, firstPaintDone, c);
    if (firstPaintDone) checkStuck(views, stuckNotified, c, resourceCache);
    firstPaintDone = true;

    if (now - lastResourceSample > Math.max(1000, c.get<number>("resourceSampleMs", 3000)) / 1000) {
      lastResourceSample = now;
      const pids = views.map((v) => v.pid).filter((p): p is number => !!p);
      sampleResources(pids, resourceCache, () => {
        updateStatusBar(statusBar, lastViews, resourceCache, officialUsage);
        updateAux(treeView, lastViews, resourceCache, needsYouOnly);
        tree.rerender();
      });
    }
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand("claudeSessionMonitor.refresh", refresh),
    vscode.commands.registerCommand("claudeSessionMonitor.focus", () =>
      vscode.commands.executeCommand("workbench.view.extension.claudeSessionMonitor"),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleWorkspaceOnly", () => {
      const current =
        workspaceOnlyOverride !== undefined
          ? workspaceOnlyOverride
          : cfg().get<boolean>("workspaceOnly", false);
      workspaceOnlyOverride = !current;
      vscode.window.showInformationMessage(
        workspaceOnlyOverride
          ? "Claude Sessions: this workspace only."
          : "Claude Sessions: all workspaces.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleNeedsYouOnly", () => {
      needsYouOnly = !needsYouOnly;
      vscode.window.showInformationMessage(
        needsYouOnly ? "Claude Sessions: needs-you only." : "Claude Sessions: all sessions.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.clearEnded", () => {
      const now = Date.now() / 1000;
      for (const v of lastViews) if (groupOf(v) === "ended") dismissed.add(v.sessionId);
      const removed = cleanupEndedMonitorFiles(now);
      vscode.window.showInformationMessage(`Claude Sessions: cleared ${removed} ended session(s).`);
      txCache.clear();
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.removeSession", (v?: SessionView) => {
      if (!v?.sessionId) return;
      dismissed.add(v.sessionId);
      try {
        fs.unlinkSync(`${MONITOR_DIR}/${v.sessionId}.json`);
      } catch {
        /* may not exist */
      }
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.dumpTabs", () => {
      const total = dumpTabsTo(`${MONITOR_DIR}/tabs-debug.json`);
      vscode.window.showInformationMessage(
        `Claude Sessions: wrote ${total} tabs to ~/.claude/session-monitor/tabs-debug.json`,
      );
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.stopResumeAll", () =>
      stopResume("Claude Sessions: resume sweep stopped."),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.resumeAll", () => {
      const queue = lastViews.filter((v) => groupOf(v) !== "ended");
      if (!queue.length) {
        vscode.window.showInformationMessage("Claude Sessions: no open sessions to resume.");
        return;
      }
      stopResume();
      const c = cfg();
      const stagger = Math.max(5, c.get<number>("resumeStaggerSeconds", 60));
      const auto = c.get<boolean>("resumeAutoType", true);
      // Collapse newlines so a single resumePrompt value can never encode more
      // than one Return keystroke (osascript `keystroke` submits on each \n).
      const prompt = c.get<string>("resumePrompt", "resume").replace(/[\r\n]+/g, " ").slice(0, 500);
      let i = 0;
      let typed = 0;
      let skipped = 0;
      resumeActive = true;

      // Self-chaining: each step is fully awaited before the next is scheduled, so
      // a slow step (jump + osascript) can never overlap another and type twice.
      const runOne = async () => {
        if (!resumeActive) return;
        if (i >= queue.length) {
          stopResume(
            auto
              ? `Claude Sessions: resume done · typed ${typed}, skipped ${skipped}.`
              : `Claude Sessions: resume done (${queue.length}).`,
          );
          return;
        }
        const v = queue[i++];
        try {
          await jumpToSession(v);
          await sleep(500);
          if (!resumeActive) return;

          if (!auto) {
            try {
              await vscode.commands.executeCommand("claude-vscode.focus");
            } catch {
              /* ignore */
            }
            vscode.window
              .showInformationMessage(`Resume ${i}/${queue.length}: "${truncate(v.title, 40)}" · press Enter`, "Stop")
              .then((x) => {
                if (x === "Stop") stopResume("Claude Sessions: resume sweep stopped.");
              });
          } else {
            await activateEditorApp();
            await sleep(150);
            try {
              await vscode.commands.executeCommand("claude-vscode.focus");
            } catch {
              /* ignore */
            }
            await sleep(220);
            if (!resumeActive) return;
            // Re-verify immediately before typing: correct tab active AND VS Code frontmost.
            const a = activeTabLabel();
            const front = await isEditorFrontmost();
            if (!resumeActive) return;
            if (!front || !a || !labelsMatch(a, v.title)) {
              skipped++;
              log(`resume skip "${truncate(v.title, 40)}": front=${front} active=${a ?? "?"}`);
            } else {
              const r = await typeAndSubmit(prompt);
              if (!r.ok) {
                if (/not allowed|assistive|accessibility|-1743|-25211|not permitted/i.test(r.err || "")) {
                  stopResume();
                  vscode.window
                    .showErrorMessage(
                      'Auto-resume needs Accessibility permission. Enable "Visual Studio Code" in System Settings > Privacy & Security > Accessibility, then run Resume All again.',
                      "Open Settings",
                    )
                    .then((x) => {
                      if (x === "Open Settings")
                        execFile(
                          "open",
                          ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"],
                          () => {},
                        );
                    });
                  return; // stop the sweep entirely
                }
                skipped++;
              } else {
                typed++;
              }
            }
          }
        } catch (e) {
          log("resume step error: " + String(e));
        }
        if (resumeActive) resumeTimer = setTimeout(runOne, stagger * 1000);
      };

      vscode.window.showInformationMessage(
        auto
          ? `Claude Sessions: auto-resuming ${queue.length} sessions, one every ${stagger}s (typing "${prompt}" + Enter). Leave VS Code frontmost.`
          : `Claude Sessions: resuming ${queue.length} sessions, one every ${stagger}s. Press Enter in each.`,
      );
      void runOne();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.openTranscript", (arg?: SessionView | Node) =>
      openTranscript(arg),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.openSession", (v: SessionView) =>
      jumpToSession(v),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.refreshUsage", async () => {
      vscode.window.setStatusBarMessage("Claude Sessions: refreshing usage…", 2500);
      await pollUsage(true);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.focusNextNeedsYou", () => {
      const order: Record<string, number> = { limited: 0, waiting: 1, done: 2 };
      const cand = lastViews
        .filter((v) => NEEDS_YOU.includes(groupOf(v)))
        .sort(
          (a, b) =>
            (order[groupOf(a)] ?? 9) - (order[groupOf(b)] ?? 9) || a.lastActivityMs - b.lastActivityMs,
        );
      if (!cand.length) {
        vscode.window.setStatusBarMessage("Claude Sessions: nothing needs you 🎉", 3000);
        return;
      }
      const idx = cand.findIndex((v) => v.sessionId === focusCursor);
      const next = cand[(idx + 1) % cand.length];
      focusCursor = next.sessionId;
      void jumpToSession(next);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.copySessionId", (arg?: SessionView | Node) => {
      const v = asView(arg);
      if (!v) return;
      vscode.env.clipboard.writeText(v.sessionId);
      vscode.window.setStatusBarMessage(`Copied session id ${v.sessionId.slice(0, 8)}…`, 3000);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.revealCwd", (arg?: SessionView | Node) => {
      const v = asView(arg);
      if (!v?.cwd) {
        vscode.window.showWarningMessage("No working folder known for this session.");
        return;
      }
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(v.cwd));
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.killProcess", async (arg?: SessionView | Node) => {
      const v = asView(arg);
      if (!v?.pid) {
        vscode.window.showWarningMessage("No process id known for this session.");
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `Send SIGTERM to "${truncate(v.title, 40)}" (pid ${v.pid})?`,
        { modal: true },
        "Kill",
      );
      if (pick !== "Kill") return;
      try {
        process.kill(v.pid, "SIGTERM");
        vscode.window.showInformationMessage(`Sent SIGTERM to pid ${v.pid}.`);
      } catch (e) {
        vscode.window.showErrorMessage("Kill failed: " + String(e));
      }
      refresh();
    }),
    { dispose: () => stopResume() },
    { dispose: () => clearAutoResume() },
  );

  const debouncedRefresh = debounce(refresh, 200);
  try {
    fs.mkdirSync(MONITOR_DIR, { recursive: true });
    const w = fs.watch(MONITOR_DIR, debouncedRefresh);
    w.on("error", () => {});
    ctx.subscriptions.push({ dispose: () => w.close() });
  } catch {
    /* polling still covers it */
  }
  try {
    const w2 = fs.watch(PROJECTS_DIR, { recursive: true }, debouncedRefresh);
    w2.on("error", () => {});
    ctx.subscriptions.push({ dispose: () => w2.close() });
  } catch {
    /* recursive watch unsupported here; polling covers it */
  }

  const pollMs = Math.max(500, cfg().get<number>("pollIntervalMs", 1500));
  let pollTimer = setInterval(refresh, pollMs);
  ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSessionMonitor.pollIntervalMs")) {
        clearInterval(pollTimer);
        pollTimer = setInterval(refresh, Math.max(500, cfg().get<number>("pollIntervalMs", 1500)));
      }
    }),
  );

  // One-shot tab dump a few seconds after startup so jump matching can be diagnosed.
  const dumpTimer = setTimeout(() => {
    try {
      dumpTabsTo(`${MONITOR_DIR}/tabs-debug.json`);
    } catch {
      /* ignore */
    }
  }, 5000);
  ctx.subscriptions.push({ dispose: () => clearTimeout(dumpTimer) });

  refresh();
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Resource sampling
// ---------------------------------------------------------------------------

function sampleResources(pids: number[], cache: Map<number, ResStat>, done: () => void): void {
  if (!pids.length) {
    done();
    return;
  }
  const list = [...new Set(pids)].join(",");
  execFile("ps", ["-o", "pid=,pcpu=,rss=", "-p", list], { timeout: 4000 }, (err, stdout) => {
    const now = Date.now() / 1000;
    if (!err && stdout) {
      for (const r of parsePsOutput(String(stdout))) {
        cache.set(r.pid, { cpu: r.cpu, rssMb: r.rssMb, ts: now });
      }
    }
    for (const [pid, v] of cache) if (now - v.ts > 60) cache.delete(pid);
    done();
  });
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function freshRes(view: SessionView, cache: Map<number, ResStat>): ResStat | undefined {
  if (!view.pid) return undefined;
  const r = cache.get(view.pid);
  if (!r || Date.now() / 1000 - r.ts > RES_FRESH_SEC) return undefined;
  return r;
}

function updateStatusBar(
  item: vscode.StatusBarItem,
  views: SessionView[],
  cache: Map<number, ResStat>,
  usage: OfficialUsage | null,
): void {
  const counts = countBuckets(views);
  let waiting = 0;
  let done = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "waiting") waiting++;
    else if (g === "done") done++;
  }
  const segs: string[] = [];
  if (counts.working) segs.push(`$(sync) ${counts.working}`);
  if (waiting) segs.push(`$(bell-dot) ${waiting}`);
  if (done) segs.push(`$(comment) ${done}`);
  if (counts.limited) segs.push(`$(error) ${counts.limited}`);

  // Surface 5h usage in the bar once it is worth watching (>= 70%).
  const g5 = usage?.gauges.find((g) => g.key === "session");
  if (g5 && g5.pct >= 70) segs.push(`$(dashboard) ${Math.round(g5.pct)}%`);

  item.text = segs.length ? `$(pulse) ${segs.join("  ")}` : "$(pulse) Claude: no sessions";

  let totalCpu = 0;
  let totalRss = 0;
  for (const v of views) {
    const r = freshRes(v, cache);
    if (r) {
      totalCpu += r.cpu;
      totalRss += r.rssMb;
    }
  }
  const resLine = totalRss ? `\ntotal: CPU ${Math.round(totalCpu)}% · ${fmtMb(totalRss)}` : "";
  const usageLine = usage?.gauges.length
    ? `\nusage: ${usage.gauges.map((g) => `${g.label} ${Math.round(g.pct)}%`).join(" · ")}`
    : "";
  item.tooltip = `Claude sessions\nworking: ${counts.working}\nwaiting: ${waiting}\nyour turn: ${done}\nlimited: ${counts.limited}${resLine}${usageLine}\n(click to open the panel)`;

  if (counts.limited > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else if (waiting > 0) {
    item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  } else {
    item.backgroundColor = undefined;
  }
}

function updateAux(
  treeView: vscode.TreeView<Node>,
  views: SessionView[],
  cache: Map<number, ResStat>,
  needsYouOnly: boolean,
): void {
  let limited = 0;
  let waiting = 0;
  let totalCpu = 0;
  let totalRss = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "limited") limited++;
    else if (g === "waiting") waiting++;
    const r = freshRes(v, cache);
    if (r) {
      totalCpu += r.cpu;
      totalRss += r.rssMb;
    }
  }
  const badge = limited + waiting;
  treeView.badge = badge
    ? { value: badge, tooltip: `${badge} session(s) waiting / limited` }
    : undefined;

  const filt = needsYouOnly ? "[needs-you only] " : "";
  treeView.message = totalRss
    ? `${filt}total load: CPU ${Math.round(totalCpu)}% · ${fmtMb(totalRss)}`
    : filt || undefined;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function detectTransitions(
  views: SessionView[],
  lastSeen: Map<string, GroupKey>,
  firstPaintDone: boolean,
  c: vscode.WorkspaceConfiguration,
): void {
  const notifyWaiting = c.get<boolean>("notifyOnWaiting", true);
  const notifyLimited = c.get<boolean>("notifyOnLimited", true);
  const notifyDone = c.get<boolean>("notifyOnDone", false);

  const present = new Set<string>();
  for (const v of views) {
    present.add(v.sessionId);
    const g = groupOf(v);
    const prev = lastSeen.get(v.sessionId);
    lastSeen.set(v.sessionId, g);

    if (!firstPaintDone) continue;
    if (prev === g) continue;

    if (g === "limited" && notifyLimited) {
      const reset = v.resetText ? ` (reset ${v.resetText})` : "";
      toast("error", `🔴 Limited: "${truncate(v.title, 48)}" · ${v.sub}${reset}`, v);
      nativeNotify(c, "Claude: limited", `${truncate(v.title, 48)} · ${v.sub}${reset}`);
    } else if (g === "waiting" && notifyWaiting) {
      const msg = v.notifMessage ? ` · ${truncate(v.notifMessage, 60)}` : "";
      toast("warn", `🟡 Waiting: "${truncate(v.title, 48)}"${msg}`, v);
      nativeNotify(c, "Claude: waiting for you", `${truncate(v.title, 48)}${msg}`);
    } else if (g === "done" && notifyDone) {
      toast("info", `🔵 Your turn: "${truncate(v.title, 48)}"`, v);
    }
  }
  for (const id of [...lastSeen.keys()]) if (!present.has(id)) lastSeen.delete(id);
}

function checkStuck(
  views: SessionView[],
  stuckNotified: Set<string>,
  c: vscode.WorkspaceConfiguration,
  cache: Map<number, ResStat>,
): void {
  const mins = c.get<number>("stuckAlertMinutes", 5);
  if (mins <= 0) return;
  const now = Date.now() / 1000;
  const present = new Set<string>();
  for (const v of views) {
    present.add(v.sessionId);
    if (groupOf(v) === "working") {
      // A silent transcript with real CPU load means "still computing", not stuck.
      const r = freshRes(v, cache);
      const cpuBusy = !!r && r.cpu >= 5;
      const age = v.lastActivityMs ? now - v.lastActivityMs / 1000 : 0;
      if (age > mins * 60 && !cpuBusy) {
        if (!stuckNotified.has(v.sessionId)) {
          stuckNotified.add(v.sessionId);
          const msg = `${truncate(v.title, 48)} · ${Math.round(age / 60)}m silent`;
          vscode.window.showWarningMessage(`⚠️ Possibly stuck: ${msg}`, "Show").then((ch) => {
            if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
          nativeNotify(c, "Claude: possibly stuck", msg);
        }
      } else {
        stuckNotified.delete(v.sessionId);
      }
    } else {
      stuckNotified.delete(v.sessionId);
    }
  }
  for (const id of [...stuckNotified]) if (!present.has(id)) stuckNotified.delete(id);
}

function toast(level: "error" | "warn" | "info", message: string, v: SessionView): void {
  const fn =
    level === "error"
      ? vscode.window.showErrorMessage
      : level === "warn"
        ? vscode.window.showWarningMessage
        : vscode.window.showInformationMessage;
  fn(message, "Show", "Transcript").then((choice) => {
    if (choice === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
    else if (choice === "Transcript") openTranscript(v);
  });
}

function nativeNotify(c: vscode.WorkspaceConfiguration, title: string, message: string): void {
  if (!c.get<boolean>("nativeNotifications", true)) return;
  if (process.platform !== "darwin") return;
  const esc = (s: string) => s.replace(/["\\]/g, " ").replace(/[\r\n]+/g, " ").slice(0, 200);
  const script = `display notification "${esc(message)}" with title "${esc(title)}" sound name "Glass"`;
  execFile("osascript", ["-e", script], { timeout: 4000 }, () => {});
}

// ---------------------------------------------------------------------------
// Click actions
// ---------------------------------------------------------------------------

const FOCUS_GROUP_CMDS = [
  "workbench.action.focusFirstEditorGroup",
  "workbench.action.focusSecondEditorGroup",
  "workbench.action.focusThirdEditorGroup",
  "workbench.action.focusFourthEditorGroup",
  "workbench.action.focusFifthEditorGroup",
  "workbench.action.focusSixthEditorGroup",
  "workbench.action.focusSeventhEditorGroup",
  "workbench.action.focusEighthEditorGroup",
];

function writeTabDebug(dbg: unknown): void {
  try {
    fs.writeFileSync(MONITOR_DIR + "/tabs-debug.json", JSON.stringify(dbg, null, 2));
  } catch {
    /* ignore */
  }
}

async function jumpToSession(v: SessionView): Promise<void> {
  const dbg: any = { ts: new Date().toISOString(), title: v.title, groups: [], matched: null, action: null, error: null };
  try {
    const groups = vscode.window.tabGroups.all;
    groups.forEach((g, gi) => {
      dbg.groups.push({
        groupIndex: gi,
        active: g.isActive,
        tabs: g.tabs.map((t, ti) => ({
          i: ti,
          label: t.label,
          active: t.isActive,
          kind: (t.input && (t.input as any).constructor && (t.input as any).constructor.name) || typeof t.input,
        })),
      });
    });

    for (let gi = 0; gi < groups.length; gi++) {
      const tabs = groups[gi].tabs;
      const ti = tabs.findIndex((t) => t.label && labelsMatch(t.label, v.title));
      if (ti >= 0) {
        dbg.matched = { groupIndex: gi, tabIndex: ti, label: tabs[ti].label };
        if (gi < FOCUS_GROUP_CMDS.length) {
          await vscode.commands.executeCommand(FOCUS_GROUP_CMDS[gi]);
        }
        if (ti < 9) {
          await vscode.commands.executeCommand(`workbench.action.openEditorAtIndex${ti + 1}`);
          dbg.action = "openEditorAtIndex" + (ti + 1);
        } else {
          // beyond index 9 there is no direct command: jump to the first tab and step.
          await vscode.commands.executeCommand("workbench.action.openEditorAtIndex1");
          for (let k = 0; k < ti; k++) {
            await vscode.commands.executeCommand("workbench.action.nextEditorInGroup");
          }
          dbg.action = "step-to-" + ti;
        }
        writeTabDebug(dbg);
        return;
      }
    }
    dbg.action = "no-match -> transcript";
  } catch (e) {
    dbg.error = String(e);
  }
  writeTabDebug(dbg);
  openTranscript(v);
}

/** Normalize a command argument that may be a tree Node or a bare SessionView. */
function asView(arg?: SessionView | Node): SessionView | undefined {
  if (!arg) return undefined;
  if ((arg as Node).kind === "session") return (arg as { view: SessionView }).view;
  if ((arg as SessionView).sessionId) return arg as SessionView;
  return undefined;
}

function openTranscript(arg?: SessionView | Node): void {
  let p: string | undefined;
  if (arg && (arg as Node).kind === "session") p = (arg as { view: SessionView }).view.transcriptPath;
  else if (arg && (arg as SessionView).transcriptPath) p = (arg as SessionView).transcriptPath;
  if (!p) {
    vscode.window.showWarningMessage("No transcript path for this session.");
    return;
  }
  vscode.workspace.openTextDocument(vscode.Uri.file(p)).then(
    (doc) => vscode.window.showTextDocument(doc, { preview: true }),
    () => vscode.window.showWarningMessage("Could not open transcript: " + p),
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function debounce(fn: () => void, ms: number): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (t) clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

// --- OS-level keystroke helpers (macOS) for fully-automated resume ----------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function activeTabLabel(): string | undefined {
  return vscode.window.tabGroups.activeTabGroup?.activeTab?.label;
}

function activateEditorApp(): Promise<void> {
  return new Promise((res) => {
    execFile("osascript", ["-e", 'tell application "Visual Studio Code" to activate'], { timeout: 4000 }, () => res());
  });
}

/** True if VS Code (Electron) is the frontmost app, so keystrokes will land in it. */
function isEditorFrontmost(): Promise<boolean> {
  if (process.platform !== "darwin") return Promise.resolve(true);
  return new Promise((res) => {
    execFile(
      "osascript",
      ["-e", 'tell application "System Events" to name of first process whose frontmost is true'],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          res(false);
          return;
        }
        const n = String(stdout).trim().toLowerCase();
        res(n.includes("code") || n.includes("electron") || n.includes("visual studio"));
      },
    );
  });
}

function appleStr(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Types `text` into the focused element and presses Return, via System Events. */
function typeAndSubmit(text: string): Promise<{ ok: boolean; err?: string }> {
  return new Promise((res) => {
    const lines = ['tell application "System Events"', `keystroke ${appleStr(text)}`, "delay 0.15", "key code 36", "end tell"];
    const args: string[] = [];
    for (const l of lines) args.push("-e", l);
    execFile("osascript", args, { timeout: 8000 }, (err, _o, stderr) => {
      if (err) res({ ok: false, err: String(stderr || err) });
      else res({ ok: true });
    });
  });
}

function dumpTabsTo(file: string): number {
  const dbg: any = { ts: new Date().toISOString(), groups: [] };
  vscode.window.tabGroups.all.forEach((g, gi) => {
    dbg.groups.push({
      groupIndex: gi,
      active: g.isActive,
      tabs: g.tabs.map((t, ti) => ({
        i: ti,
        label: t.label,
        active: t.isActive,
        kind: (t.input && (t.input as any).constructor && (t.input as any).constructor.name) || typeof t.input,
        viewType: (t.input as any)?.viewType,
      })),
    });
  });
  try {
    fs.writeFileSync(file, JSON.stringify(dbg, null, 2));
  } catch {
    /* ignore */
  }
  return dbg.groups.reduce((n: number, g: any) => n + g.tabs.length, 0);
}
