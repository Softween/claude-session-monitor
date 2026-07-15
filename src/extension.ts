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
  formatReset,
  scanTokenUsage,
  humanizeAge,
  readOfficialSnapshot,
  writeOfficialSnapshot,
  officialUsageFileFor,
  readAccountsFile,
  upsertActiveAccount,
  writeAccountsFile,
  MONITOR_DIR,
  PROJECTS_DIR,
  DEFAULT_ENTRYPOINTS,
  type AccountsFile,
  type SessionView,
  type RecentTranscript,
  type TxInfo,
  type TokenUsage,
} from "./core";
import {
  GROUPS,
  NEEDS_YOU,
  groupOf,
  normPct,
  normResetMs,
  clampPct,
  fmtMb,
  labelsMatch,
  parsePsOutput,
  parseOfficialGauges,
  isRedundantSub,
  computeBurnEta,
  estimateCostUsd,
  shortModelName,
  shortEffort,
  fmtTokensCompact,
  nextUsageBackoffSec,
  accountPillLabels,
  filterHistoryForAccount,
  topSessionRows,
  type AccountView,
  type SessionTokenRow,
  type BurnEta,
  type GroupKey,
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
// Sessions table webview
//
// The session list is a real data grid instead of a TreeView: TreeItems can
// only render one free-flowing description string, so every value change made
// the row reflow. Here each column is a fixed grid track, all numerics render
// in the editor's monospace with tabular figures, and the fastest-changing
// columns sit on the right — values update strictly in place.
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  title: string;
  sub: string; // extra status ("" when it just restates the group)
  reset: string; // formatted limit reset ("" when none)
  tokens: string; // compact 5h tokens ("" below the 10k floor)
  share: number; // 0-100 share of this machine's 5h token total
  hog: boolean; // top 5h token consumer
  model: string;
  effort: string; // reasoning effort ("" when unknown)
  lastMs: number; // last activity epoch ms — age ticks client-side
  dir: string;
  cpu: number | null;
  rssMb: number | null;
  cpuHog: boolean;
  stale: boolean; // "working" but silent — warning tint on the state dot
  ended: boolean;
  tip: string; // full tooltip (title, status, model, cwd, id, ...)
}

interface SessionsPayload {
  type: "update";
  groups: { key: GroupKey; label: string; count: number; rows: SessionRow[] }[];
  totalCpu: number | null;
  totalRss: number | null;
  effort: string; // "" when unknown
  filter: string; // active list filter label, "" when none
}

class SessionsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: SessionsPayload;

  constructor(private readonly onAction: (action: string, sessionId: string) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sessionsHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m && typeof m.type === "string" && typeof m.id === "string") this.onAction(m.type, m.id);
    });
    if (this.pending) view.webview.postMessage(this.pending);
  }

  update(payload: SessionsPayload): void {
    this.pending = payload;
    this.view?.webview.postMessage(payload);
  }

  setBadge(value: number, tooltip: string): void {
    if (this.view) this.view.badge = value > 0 ? { value, tooltip } : undefined;
  }
}

function sessionsHtml(): string {
  const nonce = nonceStr();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 0; margin: 0; }
  .num { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  /* Column tracks — the single source of the table geometry. Order:
     dot · title · 5h tok · share · model · eff · dir · age · cpu · mem · actions */
  :root { --cols: 14px minmax(40px,1fr) 62px 34px 60px 34px 56px 30px 36px 46px 36px; }
  @media (max-width: 503px) { :root { --cols: 14px minmax(40px,1fr) 62px 34px 60px 34px 30px 36px 46px 36px; } .c-dir { display:none; } }
  @media (max-width: 443px) { :root { --cols: 14px minmax(40px,1fr) 62px 34px 30px 36px 46px 36px; } .c-dir,.c-model,.c-eff { display:none; } }
  @media (max-width: 349px) { :root { --cols: 14px minmax(40px,1fr) 62px 30px 36px 36px; } .c-dir,.c-model,.c-eff,.c-pct,.c-ram { display:none; } }
  .meta { display:flex; gap:12px; padding:5px 10px 3px; font-size:10px;
    color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; }
  .meta b { font-weight:600; color: var(--vscode-foreground); }
  .thead { position: sticky; top: 0; z-index: 2; display:grid; grid-template-columns: var(--cols);
    gap: 0 6px; align-items:baseline; padding: 3px 10px; font-size: 9px; font-weight:600;
    text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25)); }
  .thead .num { font-family: inherit; font-size: 9px; }
  .ghead { display:flex; align-items:center; gap:6px; padding: 7px 10px 2px; font-size:10px;
    font-weight:700; text-transform: uppercase; letter-spacing:.06em; }
  .gdot { width:8px; height:8px; border-radius:50%; flex:none; }
  .gcount { font-weight:400; opacity:.6; }
  .row { display:grid; grid-template-columns: var(--cols); gap: 0 6px; align-items:center;
    padding: 3px 10px; cursor: pointer; border-radius: 3px; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
  .row:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
  .row.ended { opacity: .55; }
  .dot { width:7px; height:7px; border-radius:50%; }
  .dot.stale { box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-yellow, #e6b800) 35%, transparent); }
  .c-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sub { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .c-model, .c-eff, .c-dir { overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-size:11px; color: var(--vscode-descriptionForeground); }
  /* Signature: the token cell carries a hairline bar = this chat's share of the
     machine's 5h total, so "who is eating the limit" reads as geometry. */
  .c-tok { position: relative; padding-bottom: 3px; }
  .tokbar { position:absolute; left:0; bottom:0; height:2px; border-radius:1px;
    background: var(--vscode-charts-blue, #3794ff); opacity:.45; }
  .tokbar.hog { background: var(--vscode-charts-yellow, #e6b800); opacity:.9; }
  .c-cpu.hot { color: var(--vscode-charts-red, #f14c4c); font-weight:600; }
  .c-act { display:flex; gap:2px; justify-content:flex-end; visibility:hidden; }
  .row:hover .c-act, .row:focus-within .c-act { visibility:visible; }
  .act { border:0; background:transparent; color: var(--vscode-descriptionForeground);
    cursor:pointer; font-size:11px; line-height:1; padding:2px 3px; border-radius:3px; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25));
    color: var(--vscode-foreground); }
  .empty { padding: 14px 12px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  @media (prefers-reduced-motion: no-preference) { .tokbar { transition: width .5s ease; } }
</style>
</head>
<body>
  <div id="root"><div class="empty">No Claude Code sessions in the last few hours. Start one in a terminal or the Claude panel and it appears here live.</div></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const GCOLOR = {
  limited: 'var(--vscode-charts-red, #f14c4c)',
  waiting: 'var(--vscode-charts-yellow, #e6b800)',
  done: 'var(--vscode-charts-blue, #3794ff)',
  working: 'var(--vscode-charts-green, #4caf50)',
  ended: 'var(--vscode-disabledForeground, #888)',
  unknown: 'var(--vscode-disabledForeground, #888)'
};
let last = null;
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function fmtAge(ms){
  if(!ms) return '';
  const s = Math.max(0, Math.round((Date.now()-ms)/1000));
  if(s<60) return s+'s';
  if(s<3600) return Math.floor(s/60)+'m';
  if(s<172800) return Math.floor(s/3600)+'h';
  return Math.floor(s/86400)+'d';
}
function render(){
  if(!last) return;
  const root = document.getElementById('root');
  let h = '';
  const metaBits = [];
  if(last.totalCpu != null) metaBits.push('CPU <b class="num">'+last.totalCpu+'%</b>');
  if(last.totalRss != null) metaBits.push('<b class="num">'+esc(fmtMb(last.totalRss))+'</b>');
  if(last.effort) metaBits.push('effort '+esc(last.effort));
  if(last.filter) metaBits.push('⧩ '+esc(last.filter));
  if(metaBits.length) h += '<div class="meta"><span>'+metaBits.join('</span><span>')+'</span></div>';
  if(!last.groups.length){
    h += '<div class="empty">No Claude Code sessions in the last few hours. Start one in a terminal or the Claude panel and it appears here live.</div>';
    root.innerHTML = h;
    return;
  }
  h += '<div class="thead"><span></span><span>session</span><span class="num">5h tok</span>'
    + '<span class="num c-pct">%</span><span class="c-model">model</span><span class="c-eff">eff</span><span class="c-dir">dir</span>'
    + '<span class="num">age</span><span class="num">cpu</span><span class="num c-ram">mem</span><span></span></div>';
  for(const g of last.groups){
    h += '<div class="ghead"><span class="gdot" style="background:'+GCOLOR[g.key]+'"></span>'
      + esc(g.label)+' <span class="gcount">'+g.count+'</span></div>';
    for(const r of g.rows){
      const extra = [r.sub, r.reset ? ('reset '+r.reset) : ''].filter(Boolean).join(' · ');
      h += '<div class="row'+(r.ended?' ended':'')+'" tabindex="0" data-id="'+esc(r.id)+'" title="'+esc(r.tip)+'">'
        + '<span><span class="dot'+(r.stale?' stale':'')+'" style="background:'+GCOLOR[g.key]+'"></span></span>'
        + '<span class="c-title">'+esc(r.title)+(extra?' <span class="sub">· '+esc(extra)+'</span>':'')+'</span>'
        + '<span class="num c-tok">'+esc(r.tokens)
        +   (r.tokens?'<i class="tokbar'+(r.hog?' hog':'')+'" style="width:'+Math.min(100,Math.max(2,r.share))+'%"></i>':'')
        + '</span>'
        + '<span class="num c-pct">'+(r.tokens && r.share>=1 ? r.share+'%' : '')+'</span>'
        + '<span class="c-model" title="'+esc(r.model)+'">'+esc(r.model)+'</span>'
        + '<span class="c-eff" title="reasoning effort">'+esc(r.effort)+'</span>'
        + '<span class="c-dir" title="'+esc(r.dir)+'">'+esc(r.dir)+'</span>'
        + '<span class="num">'+fmtAge(r.lastMs)+'</span>'
        + '<span class="num c-cpu'+(r.cpuHog?' hot':'')+'">'+(r.cpu!=null?r.cpu+'%':'')+'</span>'
        + '<span class="num c-ram">'+(r.rssMb!=null?esc(fmtMb(r.rssMb)):'')+'</span>'
        + '<span class="c-act">'
        +   '<button class="act" data-act="transcript" title="Open transcript">▤</button>'
        +   (r.ended
              ? '<button class="act" data-act="remove" title="Remove from list">✕</button>'
              : '<button class="act" data-act="kill" title="Kill process (SIGTERM)">⊘</button>')
        + '</span>'
        + '</div>';
    }
  }
  root.innerHTML = h;
}
function fmtMb(mb){ return mb >= 1024 ? (mb/1024).toFixed(1)+'GB' : mb+'MB'; }
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget && !(el.classList && (el.classList.contains('act') || el.classList.contains('row')))) el = el.parentElement;
  if(!el || el === ev.currentTarget) return;
  if(el.classList.contains('act')){
    const row = el.closest('.row');
    if(row) vscodeApi.postMessage({ type: el.dataset.act, id: row.dataset.id });
    ev.stopPropagation();
    return;
  }
  vscodeApi.postMessage({ type: 'open', id: el.dataset.id });
});
document.getElementById('root').addEventListener('keydown', (ev) => {
  if(ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target && ev.target.classList && ev.target.classList.contains('row') ? ev.target : null;
  if(row){ vscodeApi.postMessage({ type: 'open', id: row.dataset.id }); ev.preventDefault(); }
});
window.addEventListener('message', e => { if(e.data && e.data.type === 'update'){ last = e.data; render(); } });
setInterval(render, 1000); // ages tick client-side between payloads
</script>
</body>
</html>`;
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
  sessions: SessionTokenRow[]; // top 5h token consumers per session (this machine)
  accounts: AccountView[]; // account switcher pills ([] until 2+ accounts are known)
  accountNote: string | null; // honesty note when a non-active account is displayed
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

interface ClaudeCredentials {
  token: string;
  expiresAt?: number; // epoch ms the access token expires (from the keychain payload)
}

// The keychain read spawns a `security` subprocess; with a 10s usage poll that
// would be constant churn, so the credentials are cached and invalidated on 401/403.
const TOKEN_TTL_SEC = 300;
let cachedCreds: { creds: ClaudeCredentials; ts: number } | undefined;

async function readClaudeCredentialsCached(): Promise<ClaudeCredentials | undefined> {
  if (cachedCreds && Date.now() / 1000 - cachedCreds.ts < TOKEN_TTL_SEC) return cachedCreds.creds;
  const c = await readClaudeCredentials();
  if (c) cachedCreds = { creds: c, ts: Date.now() / 1000 };
  return c;
}

function readClaudeCredentials(): Promise<ClaudeCredentials | undefined> {
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
          const oauth = JSON.parse(String(stdout).trim())?.claudeAiOauth;
          const token = oauth?.accessToken;
          if (!token || typeof token !== "string") {
            resolve(undefined);
            return;
          }
          resolve({ token, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined });
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

// Which account is the active login? Claude Code writes it to ~/.claude.json
// (oauthAccount) together with the keychain token, so parsing that once per
// distinct token is enough — the file can be multi-MB, so never parse per poll.
interface ActiveIdentity {
  id: string;
  email: string;
}

let identityCache: { token: string; identity: ActiveIdentity | undefined } | undefined;

async function readActiveIdentity(token: string): Promise<ActiveIdentity | undefined> {
  if (identityCache?.token === token) return identityCache.identity;
  let identity: ActiveIdentity | undefined;
  try {
    const raw = await fs.promises.readFile(`${os.homedir()}/.claude.json`, "utf8");
    const oa = JSON.parse(raw)?.oauthAccount;
    if (oa && typeof oa.accountUuid === "string" && oa.accountUuid && typeof oa.emailAddress === "string") {
      identity = { id: oa.accountUuid, email: oa.emailAddress };
    }
  } catch {
    /* missing or unparsable — identity stays unknown */
  }
  identityCache = { token, identity };
  return identity;
}

type UsageFetch =
  | { ok: true; usage: OfficialUsage }
  | { ok: false; status?: number; retryAfterSec?: number };

async function fetchOfficialUsage(token: string): Promise<UsageFetch> {
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

/** Which account the payload should describe, plus the pills to render. */
interface AccountCtx {
  accounts: AccountView[]; // [] when fewer than 2 accounts are known
  selectedId: string | null;
  activeId: string | null;
  selectedStale: boolean;
}

function buildLimitsPayload(
  views: SessionView[],
  tokens: TokenUsage | null,
  officialUsage: OfficialUsage | null, // usage of the SELECTED account
  usageNote: string | null = null,
  acctCtx: AccountCtx | null = null,
): LimitsPayload {
  const now = Date.now() / 1000;
  const gauges: Gauge[] = [];
  let model: string | null = null;
  let ts: number | null = null;
  const selectedIsActive = !acctCtx || acctCtx.selectedId === acctCtx.activeId;

  if (officialUsage && officialUsage.gauges.length) {
    ts = officialUsage.ts;
    for (const g of officialUsage.gauges) gauges.push({ key: g.key, label: g.label, pct: g.pct, resetMs: g.resetMs });
  } else if (selectedIsActive) {
    // Fallback: limits.json written by a terminal status line (if present).
    // It always describes the active login, so never use it for another account.
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
  const history = filterHistoryForAccount(readLimitsHistory(240), acctCtx?.selectedId ?? null, selectedIsActive).map(
    (p) => ({
      t: typeof p.ts === "number" ? p.ts * 1000 : 0,
      fh: p.src === "ext" ? clampPct(p.fh) : normPct(p.fh),
      sd: p.src === "ext" ? clampPct(p.sd) : normPct(p.sd),
    }),
  );
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

  let sessions: SessionTokenRow[] = [];
  if (tokens?.bySession5h) {
    const titles = new Map(views.map((v) => [v.sessionId, v.title]));
    sessions = topSessionRows(tokens.bySession5h, titles, tokens.fiveHour);
  }

  let accountNote: string | null = null;
  if (acctCtx && !selectedIsActive) {
    if (acctCtx.selectedStale) {
      accountNote =
        "this account is not the active login and its stored token has expired — showing last-known data; log in with Claude Code once to refresh";
    } else if (!official) {
      accountNote = "no usage data captured for this account yet — it appears after its first background fetch";
    } else {
      accountNote = "not the active login — refreshed in the background with its stored token";
    }
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
    sessions,
    accounts: acctCtx?.accounts ?? [],
    accountNote,
    // API-status notes describe the ACTIVE login's fetch loop; suppress them
    // while another account is displayed so they cannot be misattributed.
    usageNote: selectedIsActive ? usageNote : null,
  };
}

class LimitsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: LimitsPayload;

  constructor(
    private readonly onRefresh: () => void,
    private readonly onSelectAccount: (id: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = limitsHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === "refresh") this.onRefresh();
      else if (m && m.type === "selectAccount" && typeof m.id === "string") this.onSelectAccount(m.id);
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
  .segs { display:flex; gap:2px; margin:3px 0; }
  .seg { flex:1; height:10px; border-radius:2px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.2)); }
  .accts { display:flex; flex-wrap:wrap; gap:5px; margin:0 0 10px 0; }
  .pill { display:inline-flex; align-items:center; gap:5px; max-width:100%; overflow:hidden; white-space:nowrap;
    padding:2px 9px; border-radius:999px; cursor:pointer; font-size:11px; user-select:none;
    border:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.35));
    background:transparent; color:var(--vscode-foreground); opacity:.72; }
  .pill:hover { opacity:1; }
  .pill.sel { background: var(--vscode-badge-background, rgba(127,127,127,.25));
    color: var(--vscode-badge-foreground, var(--vscode-foreground)); opacity:1; border-color:transparent; font-weight:600; }
  .adot { width:7px; height:7px; border-radius:50%; background:var(--vscode-charts-green,#4caf50); flex:none; }
  .spark { margin-top:8px; }
  .spark h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .legend { font-size:11px; opacity:.7; display:flex; gap:12px; margin-top:2px; flex-wrap:wrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  svg { width:100%; display:block; }
  .spark svg { height:56px; }
  .foot { margin-top:8px; font-size:11px; opacity:.55; }
  .sec { margin-top:8px; }
  .sec h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .sech { display:flex; align-items:baseline; gap:6px; cursor:pointer; user-select:none; padding:1px 0; }
  .sech h4 { margin:0; }
  .sech:hover h4 { opacity:1; }
  .chev { font-size:9px; opacity:.55; width:9px; flex:none; }
  .hint { font-size:10px; opacity:.5; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:55%; font-weight:400; }
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
const vscodeApi = acquireVsCodeApi();
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
  const W=300, H=56, n=pts.length;
  // History points arrive ~1/min, so index ~= minutes; when a projection is
  // shown, the last 15% of the width is reserved for it.
  const spanW = eta ? W*0.85 : W;
  const x = i => (i/(n-1))*spanW;
  const y = v => H - (Math.max(0,Math.min(100,v))/100)*(H-4) - 2;
  let grid='';
  for(const gv of [25,50,75]) grid += '<line x1="0" y1="'+y(gv).toFixed(1)+'" x2="'+W+'" y2="'+y(gv).toFixed(1)+'" stroke="rgba(127,127,127,.18)" stroke-width="1" stroke-dasharray="2,4"/>';
  const line = (key,col) => {
    let d='', started=false;
    pts.forEach((p,i)=>{ const v=p[key]; if(v==null) return; d += (started?'L':'M')+x(i).toFixed(1)+','+y(v).toFixed(1)+' '; started=true; });
    return d ? '<polyline fill="none" stroke="'+col+'" stroke-width="1.5" points="'+d.replace(/[ML]/g,' ').trim()+'"/>' : '';
  };
  // Soft area fill under the 5h line so the busy periods read at a glance.
  const fhIdx = [];
  pts.forEach((p,i)=>{ if(p.fh!=null) fhIdx.push(i); });
  let area='';
  if(fhIdx.length > 1){
    let d = 'M'+x(fhIdx[0]).toFixed(1)+','+y(pts[fhIdx[0]].fh).toFixed(1);
    for(const i of fhIdx.slice(1)) d += ' L'+x(i).toFixed(1)+','+y(pts[i].fh).toFixed(1);
    d += ' L'+x(fhIdx[fhIdx.length-1]).toFixed(1)+','+H+' L'+x(fhIdx[0]).toFixed(1)+','+H+' Z';
    area = '<path d="'+d+'" fill="'+C_BLUE+'" opacity="0.10"/>';
  }
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
  const spanH = (pts[n-1].t - pts[0].t)/3600e3;
  const spanLabel = spanH >= 0.1 ? ('last '+(spanH<10?spanH.toFixed(1):Math.round(spanH))+'h') : '';
  return '<div class="spark"><svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'
    + grid + area + line('fh', C_BLUE) + line('sd', C_WARN) + proj
    + '</svg><div class="legend"><span><span class="dot" style="background:'+C_BLUE+'"></span>5-hour</span>'
    + '<span><span class="dot" style="background:'+C_WARN+'"></span>7-day</span>'
    + (eta ? '<span>┄ projected</span>' : '')
    + (spanLabel ? '<span>'+spanLabel+'</span>' : '')
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
function fmtAge(s){
  if(s<90) return s+'s';
  if(s<5400) return Math.round(s/60)+'m';
  if(s<172800) return (s/3600).toFixed(1)+'h';
  return Math.round(s/86400)+'d';
}
function acctRow(accounts){
  if(!accounts || accounts.length < 2) return '';
  let h='<div class="accts">';
  for(const a of accounts){
    const age = a.ts ? Math.max(0, Math.round(Date.now()/1000 - a.ts)) : null;
    const tip = a.email + (a.active ? ' — active login' : '')
      + (a.stale ? ' — token expired, log in once to refresh' : '')
      + (age!=null ? ' — updated '+fmtAge(age)+' ago' : ' — no data yet')
      + ' — click to view';
    h += '<span class="pill'+(a.selected?' sel':'')+'" data-id="'+esc(a.id)+'" title="'+esc(tip)+'">'
      + (a.active ? '<span class="adot"></span>' : '')
      + esc(a.label)
      + (a.stale ? ' ⚠' : '')
      + '</span>';
  }
  h += '</div>';
  return h;
}
// 20 segments of 5% each; the boundary segment is partially filled, so the bar
// resolves single percent points instead of 10% jumps.
const NSEG = 20;
function segRow(p){
  const span = 100/NSEG;
  let segs='';
  for(let i=0;i<NSEG;i++){
    const fill = p==null ? 0 : Math.max(0, Math.min(1, (p - i*span)/span));
    let st='';
    if(fill>=1) st = 'background:'+color(p);
    else if(fill>0){
      const cut = (fill*100).toFixed(0)+'%';
      st = 'background:linear-gradient(90deg,'+color(p)+' '+cut+', var(--vscode-editorWidget-background, rgba(127,127,127,.2)) '+cut+')';
    }
    segs += '<div class="seg" style="'+st+'"></div>';
  }
  return '<div class="segs">'+segs+'</div>';
}
function fmtPct(p){
  if(p==null) return '?';
  return p < 10 ? (Math.round(p*10)/10).toString() : String(Math.round(p));
}
// Collapsible sections: the panel shares a sidebar with the session table, so
// every block below the gauges can be folded to one header line. State is kept
// in the webview state store (survives hide/show and window reloads).
let collapsed = (vscodeApi.getState() && vscodeApi.getState().collapsed) || { chart:false, sessions:false, models:true };
function secHeader(id, title, hint){
  return '<div class="sech" data-sec="'+id+'"><span class="chev">'+(collapsed[id]?'▸':'▾')+'</span>'
    + '<h4>'+title+'</h4>'
    + (collapsed[id] && hint ? '<span class="hint">'+hint+'</span>' : '')
    + '</div>';
}
function truncLbl(s){ return s.length>16 ? s.slice(0,15)+'…' : s; }
function sessionSection(rows){
  if(!rows || !rows.length) return '';
  let h='<div class="sec">'+secHeader('sessions','Sessions (5h tokens)', esc(truncLbl(rows[0].label))+' '+rows[0].pct+'%');
  if(!collapsed.sessions){
    for(const s of rows.slice(0,5)){
      h += '<div class="mrow"><span class="mname" title="'+esc(s.label)+'">'+esc(s.label)+'</span>'
        + '<span class="mbar"><span class="mfill" style="width:'+Math.max(2,s.pct)+'%;background:'+C_OK+'"></span></span>'
        + '<span class="mval">'+s.pct+'% · '+fmtTokens(s.tokens)+'</span></div>';
    }
    h += '<div class="legend"><span>share of this Mac\\'s 5h token total</span></div>';
  }
  h += '</div>';
  return h;
}
function modelSection(models){
  if(!models || !models.length) return '';
  let h='<div class="sec">'+secHeader('models','Models (7d share)', esc(models[0].name)+' '+models[0].pct+'%');
  if(!collapsed.models){
    let total=0, priced=true;
    for(const m of models){
      h += '<div class="mrow"><span class="mname" title="'+esc(m.name)+'">'+esc(m.name)+'</span>'
        + '<span class="mbar"><span class="mfill" style="width:'+Math.max(2,m.pct)+'%;background:'+C_BLUE+'"></span></span>'
        + '<span class="mval">'+m.pct+'% · '+fmtTokens(m.tokens)+(m.cost!=null?(' · ≈$'+m.cost.toFixed(2)):'')+'</span></div>';
      if(m.cost!=null) total+=m.cost; else priced=false;
    }
    if(total>0) h += '<div class="legend"><span>≈$'+total.toFixed(2)+' total'+(priced?'':' (priced models only)')+' · rough, excl. cache reads</span></div>';
  }
  h += '</div>';
  return h;
}
function fmtTokens(n){
  if(n==null) return '0';
  if(n<1000) return ''+Math.round(n);
  if(n<1e6) return (n/1e3).toFixed(n<1e4?1:0)+'K';
  return (n/1e6).toFixed(2)+'M';
}
function tokenSection(t, multiAcct){
  if(!t) return '';
  // One line: totals carry all the signal (the 48h hourly bars were dropped in
  // 1.9.1, and the two-row layout wasted a section on two numbers).
  return '<div class="sec"><div class="grow">'
    + '<span class="glabel" title="in + out + cache-write'+(multiAcct?', all logins on this Mac':'')+'">Tokens'+(multiAcct?' <span class="hint">all logins</span>':'')+'</span>'
    + '<span class="gpct">5h '+fmtTokens(t.fiveHour)+' · 7d '+fmtTokens(t.sevenDay)+'</span></div></div>';
}
function render(){
  const root = document.getElementById('root');
  if(!last){ return; }
  let h='';
  const multiAcct = !!(last.accounts && last.accounts.length > 1);
  h += acctRow(last.accounts);
  // Official 5h / 7d gauges: live for the selected account (or the statusline fallback).
  if(last.official){
    for(const g of last.gauges){
      const p = g.pct;
      const usedStr = fmtPct(p);
      // Derive "left" from the DISPLAYED used value so the two always sum to 100
      // (independent rounding could show 34% used / 67% left on p=33.5).
      const leftStr = p==null ? '100' : String(Math.max(0, Math.round((100 - Number(usedStr))*10)/10));
      h += '<div class="gauge"><div class="grow"><span class="glabel">'+esc(g.label)+'</span>'
         + '<span class="gpct">'+usedStr+'% used</span></div>'
         + segRow(p)
         + '<div class="greset"><b>'+leftStr+'% left</b>'+(g.resetMs?(' · '+fmtLeft(g.resetMs)):'')+'</div></div>';
      if((g.key==='session'||g.key==='5h')) h += etaLine(last.eta);
    }
    if(last.ts){
      const age = Math.max(0, Math.round(Date.now()/1000 - last.ts));
      h += '<div class="foot">official account usage · updated '+fmtAge(age)+' ago</div>';
    }
  }
  if(last.accountNote){
    h += '<div class="note">'+esc(last.accountNote)+'</div>';
  }
  const sparkBody = spark(last.history, last.eta);
  if(sparkBody){
    h += '<div class="sec">'+secHeader('chart','Usage over time','0-100%')+(collapsed.chart?'':sparkBody)+'</div>';
  }
  // Token usage (real proxy; always shown when available).
  h += tokenSection(last.tokens, multiAcct);
  h += sessionSection(last.sessions);
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
  if(!last.official && !last.usageNote && !last.accountNote){
    h += '<div class="note">Official 5h / 7d usage unavailable (needs macOS keychain access to "Claude Code-credentials" + network). The token-usage proxy below still works; sessions also appear under "Active limit hits" the moment they hit a limit.</div>';
  }
  root.innerHTML = h;
}
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
// Pills and section headers are re-rendered every second, so their click
// handlers are delegated from the stable root node.
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget){
    if(el.classList && el.classList.contains('pill') && el.dataset.id){
      vscodeApi.postMessage({ type: 'selectAccount', id: el.dataset.id });
      return;
    }
    if(el.classList && el.classList.contains('sech') && el.dataset.sec){
      collapsed[el.dataset.sec] = !collapsed[el.dataset.sec];
      vscodeApi.setState({ collapsed });
      render();
      return;
    }
    el = el.parentElement;
  }
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
  const trackAllAccounts = () => cfg().get<boolean>("trackAllAccounts", true);

  const resourceCache = new Map<number, ResStat>();
  const sessionsView = new SessionsView((action, sessionId) => {
    const v = lastViews.find((s) => s.sessionId === sessionId);
    if (!v) return;
    if (action === "open") void jumpToSession(v);
    else if (action === "transcript") openTranscript(v);
    else if (action === "kill") void vscode.commands.executeCommand("claudeSessionMonitor.killProcess", v);
    else if (action === "remove") void vscode.commands.executeCommand("claudeSessionMonitor.removeSession", v);
  });
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.view", sessionsView),
  );

  // Multi-account state: every account seen as the active login is remembered
  // (registry file shared across windows; tokens in SecretStorage), and the
  // webview can pin the panel to any of them.
  let accountsFile: AccountsFile = readAccountsFile();
  let selectedAccountId = ctx.globalState.get<string | null>("selectedAccountId", null);
  const usageByAccount = new Map<string, { usage: OfficialUsage | null; stale: boolean }>();
  let othersInflight = false;
  let lastOthersCheck = 0;

  const limitsView = new LimitsView(
    () => vscode.commands.executeCommand("claudeSessionMonitor.refreshUsage"),
    (id) => {
      // Clicking the active account returns to follow-the-login mode; any other
      // account pins the panel to it.
      selectedAccountId = id === (accountsFile.activeId ?? null) ? null : id;
      void ctx.globalState.update("selectedAccountId", selectedAccountId);
      pushUsagePayload();
    },
  );
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

  // Boot from the shared snapshots so gauges render immediately (with an honest
  // "updated Xs ago" age) even before the first live fetch succeeds.
  const bootSnap = readOfficialSnapshot();
  if (bootSnap?.gauges.length && bootSnap.ts) officialUsage = { gauges: bootSnap.gauges, ts: bootSnap.ts };
  for (const a of accountsFile.accounts) {
    const s = readOfficialSnapshot(officialUsageFileFor(a.id));
    if (s?.gauges.length && s.ts) usageByAccount.set(a.id, { usage: { gauges: s.gauges, ts: s.ts }, stale: !!s.tokenStale });
  }
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
      cachedCreds = undefined; // re-read keychain: the account may have changed
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
      const creds = await readClaudeCredentialsCached();
      if (!creds) {
        log("usage: no keychain token");
        if (force)
          usageNote = "not signed in to Claude Code on this Mac (no keychain credentials) — log in, then refresh";
        return;
      }
      const r = await fetchOfficialUsage(creds.token);
      if (!r.ok && (r.status === 401 || r.status === 403)) cachedCreds = undefined; // token rotated -> re-read keychain
      const nowSec = Date.now() / 1000;
      const cur = readOfficialSnapshot() ?? { gauges: [], ts: 0 };
      if (r.ok) {
        officialUsage = r.usage;
        usageNote = null;
        writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: nowSec }); // clears backoff
        log(`usage ok${force ? " (manual)" : ""}: ${r.usage.gauges.map((g) => `${g.key}=${Math.round(g.pct)}`).join(" ")}`);
        // Record which account this usage belongs to: registry entry, per-account
        // snapshot, and (when enabled) the token vault that lets the extension
        // keep refreshing this account after the user logs into another one.
        const ident = (await readActiveIdentity(creds.token)) ?? { id: "default", email: "this account" };
        accountsFile = upsertActiveAccount(readAccountsFile(), { ...ident, tokenExpiresAt: creds.expiresAt }, nowSec);
        writeAccountsFile(accountsFile);
        usageByAccount.set(ident.id, { usage: r.usage, stale: false });
        writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: nowSec }, officialUsageFileFor(ident.id));
        if (trackAllAccounts()) {
          void ctx.secrets.store(`csm.token.${ident.id}`, creds.token).then(undefined, () => {});
        }
        const g5 = r.usage.gauges.find((g) => g.key === "session");
        const g7 = r.usage.gauges.find((g) => g.key === "weekly");
        appendLimitsHistory({
          src: "ext",
          acct: ident.id,
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
      pushUsagePayload(); // also on the no-credentials early return
    }
  }

  /**
   * Background refresh for accounts that are NOT the active login, using their
   * stored tokens — slower cadence than the active poll, per-account snapshot
   * files for cross-window single-flight, and honest staleness marking when a
   * token has expired (Anthropic tokens outlive a logout for a few hours, so
   * right after switching accounts this keeps the other account live).
   */
  async function pollOtherAccounts(force: boolean): Promise<void> {
    if (othersInflight || !trackAllAccounts()) return;
    const activeId = accountsFile.activeId;
    const others = accountsFile.accounts.filter((a) => a.id !== activeId);
    if (!others.length) return;
    othersInflight = true;
    let changed = false;
    try {
      const cadence = Math.max(120, cfg().get<number>("usagePollSeconds", 30) * 2);
      for (const a of others) {
        const file = officialUsageFileFor(a.id);
        const snap = readOfficialSnapshot(file);
        const nowSec = Date.now() / 1000;
        const known = usageByAccount.get(a.id);
        if (snap?.gauges.length && snap.ts && (!known?.usage || snap.ts > known.usage.ts)) {
          usageByAccount.set(a.id, { usage: { gauges: snap.gauges, ts: snap.ts }, stale: !!snap.tokenStale });
          changed = true; // another window fetched it
        }
        if (a.tokenExpiresAt != null && Date.now() > a.tokenExpiresAt) {
          if (snap && !snap.tokenStale) writeOfficialSnapshot({ ...snap, tokenStale: true }, file);
          const cur = usageByAccount.get(a.id);
          if (cur && !cur.stale) {
            usageByAccount.set(a.id, { usage: cur.usage, stale: true });
            changed = true;
          }
          continue; // token is known-dead: don't burn a request on a guaranteed 401
        }
        const freshEnough = !force && !!snap && nowSec - snap.ts < cadence;
        const attempted = !force && !!snap?.attemptTs && nowSec - snap.attemptTs < Math.min(60, cadence);
        const inBackoff = !force && !!snap?.backoffUntil && nowSec < snap.backoffUntil;
        if (freshEnough || attempted || inBackoff) continue;
        let token: string | undefined;
        try {
          token = await ctx.secrets.get(`csm.token.${a.id}`);
        } catch {
          token = undefined;
        }
        if (!token) {
          const cur = usageByAccount.get(a.id);
          if (cur && !cur.stale) {
            usageByAccount.set(a.id, { usage: cur.usage, stale: true });
            changed = true;
          }
          continue;
        }
        writeOfficialSnapshot({ ...(snap ?? { gauges: [], ts: 0 }), attemptTs: nowSec }, file);
        const r = await fetchOfficialUsage(token);
        const now2 = Date.now() / 1000;
        const cur2 = readOfficialSnapshot(file) ?? { gauges: [], ts: 0 };
        if (r.ok) {
          usageByAccount.set(a.id, { usage: r.usage, stale: false });
          writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: now2 }, file);
          changed = true;
          log(`usage ok (acct ${a.email}): ${r.usage.gauges.map((g) => `${g.key}=${Math.round(g.pct)}`).join(" ")}`);
        } else if (r.status === 401 || r.status === 403) {
          // Token revoked/expired server-side: keep last-known data, mark stale,
          // and retry no sooner than 30 minutes (a re-login refreshes instantly).
          writeOfficialSnapshot(
            { ...cur2, attemptTs: now2, backoffUntil: now2 + 1800, backoffSec: 1800, tokenStale: true },
            file,
          );
          const cur = usageByAccount.get(a.id);
          usageByAccount.set(a.id, { usage: cur?.usage ?? null, stale: true });
          changed = true;
          log(`usage acct ${a.email}: token rejected (${r.status})`);
        } else if (r.status === 429) {
          const b = nextUsageBackoffSec(cur2.backoffSec, r.retryAfterSec);
          writeOfficialSnapshot({ ...cur2, attemptTs: now2, backoffUntil: now2 + b, backoffSec: b }, file);
        }
      }
    } catch (e) {
      log("pollOtherAccounts error: " + String(e));
    } finally {
      othersInflight = false;
    }
    if (changed) pushUsagePayload();
  }

  /**
   * Resolve which account the panel shows and the pill row to render.
   * Selection follows the active login unless the user pinned another account;
   * a pin that catches up with the active login dissolves back to follow mode.
   */
  function currentAccountCtx(): AccountCtx & { usage: OfficialUsage | null } {
    const activeId = accountsFile.activeId ?? null;
    const track = trackAllAccounts();
    if (activeId && officialUsage) usageByAccount.set(activeId, { usage: officialUsage, stale: false });
    if (selectedAccountId && selectedAccountId === activeId) {
      selectedAccountId = null;
      void ctx.globalState.update("selectedAccountId", null);
    }
    // A pin only holds while multi-account tracking is on: with tracking off the
    // pinned account would never refresh again, so the panel follows the active
    // login instead (the pin itself is kept for when tracking is re-enabled).
    const selId =
      track && selectedAccountId && accountsFile.accounts.some((a) => a.id === selectedAccountId)
        ? selectedAccountId
        : activeId;
    const list = track ? accountsFile.accounts : accountsFile.accounts.filter((a) => a.id === activeId);
    const labels = accountPillLabels(list.map((a) => a.email));
    const accounts: AccountView[] = list.map((a, i) => {
      const e = usageByAccount.get(a.id);
      return {
        id: a.id,
        email: a.email,
        label: labels[i],
        active: a.id === activeId,
        selected: a.id === selId,
        ts: e?.usage?.ts ?? null,
        stale:
          a.id === activeId
            ? false
            : (e?.stale ?? false) || (a.tokenExpiresAt != null && Date.now() > a.tokenExpiresAt),
      };
    });
    const usage = selId === activeId ? officialUsage : (selId && usageByAccount.get(selId)?.usage) || null;
    return {
      accounts: accounts.length > 1 ? accounts : [],
      selectedId: selId,
      activeId,
      selectedStale: accounts.find((v) => v.id === selId)?.stale ?? false,
      usage,
    };
  }

  /** Rebuild the sessions table payload (grouping, per-row stats, badge) and post it. */
  function pushSessions(views: SessionView[]): void {
    // Token hog: the biggest 5h consumer, only when it is a meaningful share.
    let hogId: string | null = null;
    if (tokenUsage?.bySession5h) {
      const top = Object.entries(tokenUsage.bySession5h).sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] >= 200_000 && top[1] >= tokenUsage.fiveHour * 0.25) hogId = top[0];
    }
    sessionsView.update(
      buildSessionsPayload(
        views,
        resourceCache,
        tokenUsage,
        hogId,
        needsYouOnly ? "needs-you only" : "",
        cfg().get<number>("cpuHogThreshold", 60),
      ),
    );
    let badge = 0;
    for (const v of views) {
      const g = groupOf(v);
      if (g === "limited" || g === "waiting") badge++;
    }
    sessionsView.setBadge(badge, `${badge} session(s) waiting / limited`);
  }

  function pushUsagePayload(): void {
    try {
      const c = currentAccountCtx();
      limitsView.update(buildLimitsPayload(lastViews, tokenUsage, c.usage, usageNote, c));
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

    // Non-active accounts: pick up registry changes other windows wrote, then
    // refresh their usage in the background on a slower cadence.
    if (now - lastOthersCheck > 30) {
      lastOthersCheck = now;
      accountsFile = readAccountsFile();
      void pollOtherAccounts(false);
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

    pushSessions(views);
    pushUsagePayload();

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
        pushSessions(lastViews);
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

      if (auto) {
        // Defense in depth: keystrokes land in whatever has OS keyboard focus,
        // and the tab-active check cannot guarantee focus is the Claude input
        // (it may be a terminal, search box, etc.). Require one explicit
        // confirmation before any unattended typing begins this sweep.
        vscode.window
          .showWarningMessage(
            `Claude Sessions: about to type "${prompt}" + Enter into the focused editor for ${queue.length} session(s), one every ${stagger}s. Put your cursor in the Claude input and keep VS Code frontmost.`,
            { modal: true },
            "Start typing",
          )
          .then((choice) => {
            if (choice !== "Start typing") {
              stopResume();
              return;
            }
            void runOne();
          });
      } else {
        vscode.window.showInformationMessage(
          `Claude Sessions: resuming ${queue.length} sessions, one every ${stagger}s. Press Enter in each.`,
        );
        void runOne();
      }
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.openTranscript", (arg?: SessionView) =>
      openTranscript(arg),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.openSession", (v: SessionView) =>
      jumpToSession(v),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.refreshUsage", async () => {
      vscode.window.setStatusBarMessage("Claude Sessions: refreshing usage…", 2500);
      await pollUsage(true);
      await pollOtherAccounts(true);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.forgetOtherAccounts", async () => {
      accountsFile = readAccountsFile(); // another window may have a fresher registry
      const keepId = accountsFile.activeId;
      if (!keepId) {
        vscode.window.showWarningMessage(
          "Claude Sessions: the active account is not known yet — try again after the next usage refresh.",
        );
        return;
      }
      const drop = accountsFile.accounts.filter((a) => a.id !== keepId);
      for (const a of drop) {
        try {
          await ctx.secrets.delete(`csm.token.${a.id}`);
        } catch {
          /* ignore */
        }
        try {
          fs.unlinkSync(officialUsageFileFor(a.id));
        } catch {
          /* may not exist */
        }
        usageByAccount.delete(a.id);
      }
      const active = accountsFile.accounts.find((a) => a.id === keepId);
      accountsFile = { v: 1, accounts: active ? [active] : [], activeId: keepId };
      writeAccountsFile(accountsFile);
      selectedAccountId = null;
      void ctx.globalState.update("selectedAccountId", null);
      vscode.window.showInformationMessage(
        drop.length
          ? `Claude Sessions: forgot ${drop.length} other account(s) and deleted their stored tokens.`
          : "Claude Sessions: no other accounts stored.",
      );
      pushUsagePayload();
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
    vscode.commands.registerCommand("claudeSessionMonitor.copySessionId", (arg?: SessionView) => {
      const v = asView(arg);
      if (!v) return;
      vscode.env.clipboard.writeText(v.sessionId);
      vscode.window.setStatusBarMessage(`Copied session id ${v.sessionId.slice(0, 8)}…`, 3000);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.revealCwd", (arg?: SessionView) => {
      const v = asView(arg);
      if (!v?.cwd) {
        vscode.window.showWarningMessage("No working folder known for this session.");
        return;
      }
      vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(v.cwd));
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.killProcess", async (arg?: SessionView) => {
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

function buildSessionsPayload(
  views: SessionView[],
  resCache: Map<number, ResStat>,
  tokens: TokenUsage | null,
  hogId: string | null,
  filter: string,
  cpuHogThreshold: number,
): SessionsPayload {
  const nowSec = Date.now() / 1000;
  const grouped = new Map<GroupKey, SessionRow[]>();
  let totalCpu = 0;
  let totalRss = 0;
  let anyRes = false;
  for (const v of views) {
    const g = groupOf(v);
    const res = freshRes(v, resCache);
    if (res) {
      totalCpu += res.cpu;
      totalRss += res.rssMb;
      anyRes = true;
    }
    const tok = tokens?.bySession5h?.[v.sessionId] ?? 0;
    const total5h = tokens?.fiveHour ?? 0;
    const share = tok && total5h > 0 ? Math.round((tok / total5h) * 100) : 0;
    const resTip = res ? `\nCPU: ${Math.round(res.cpu)}%  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
    const tokTip =
      tok >= 10_000
        ? `\ntokens (5h): ${fmtTokensCompact(tok)}${share >= 1 ? ` · ${share}% of this Mac's total` : ""}${v.sessionId === hogId ? " · top consumer" : ""}`
        : "";
    const row: SessionRow = {
      id: v.sessionId,
      title: v.title,
      sub: isRedundantSub(v.sub) ? "" : v.sub,
      reset: v.resetText ? formatReset(v.resetText, nowSec) : "",
      tokens: tok >= 10_000 ? fmtTokensCompact(tok) : "",
      share,
      hog: v.sessionId === hogId,
      model: v.model ? shortModelName(v.model) : "",
      effort: shortEffort(v.effort) ?? "",
      lastMs: v.lastActivityMs,
      dir: v.cwdLabel ?? "",
      cpu: res ? Math.round(res.cpu) : null,
      rssMb: res ? res.rssMb : null,
      cpuHog: !!res && res.cpu >= cpuHogThreshold,
      stale: g === "working" && v.stale,
      ended: g === "ended",
      tip: v.tooltip + resTip + tokTip,
    };
    const arr = grouped.get(g) ?? [];
    arr.push(row);
    grouped.set(g, arr);
  }
  const groups = GROUPS.filter((m) => grouped.get(m.key)?.length).map((m) => ({
    key: m.key,
    label: m.label,
    count: grouped.get(m.key)!.length,
    rows: grouped.get(m.key)!,
  }));
  // Effort also appears per row (user preference); the meta strip keeps the
  // value visible on narrow panels where the eff column is hidden.
  const effort = shortEffort(views.find((v) => v.effort)?.effort) ?? "";
  return {
    type: "update",
    groups,
    totalCpu: anyRes ? Math.round(totalCpu) : null,
    totalRss: anyRes ? totalRss : null,
    effort,
    filter,
  };
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

/** Normalize a command argument to a SessionView (undefined when absent/foreign). */
function asView(arg?: SessionView): SessionView | undefined {
  return arg && typeof arg.sessionId === "string" ? arg : undefined;
}

function openTranscript(arg?: SessionView): void {
  const p = asView(arg)?.transcriptPath;
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
