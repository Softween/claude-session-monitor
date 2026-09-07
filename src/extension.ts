/**
 * extension.ts - VS Code UI for the shared Claude + Codex session monitor.
 *
 * Activity Bar sidebar with two views:
 *  - a table of interactive Claude Code and Codex sessions grouped by live state
 *    (limited / waiting / your-turn / working / ended), each row showing
 *    CPU% + RAM, with an Activity Bar badge, toasts + native macOS
 *    notifications, a live limit-reset countdown, a stuck-session alert,
 *    a "needs-you only" filter, and click -> best-effort jump to that tab.
 *  - a webview charting the account usage limits (5-hour / 7-day) as gauges
 *    with reset countdowns and a burn-rate projection line.
 *
 * Claude state comes from core.ts. Codex metadata/usage comes from its official
 * app-server and is combined with provider-scoped lifecycle hook state.
 */
import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import {
  collectSessions,
  countBuckets,
  findRecentTranscripts,
  cleanupMonitorFiles,
  cleanupEndedMonitorFiles,
  readHookStatuses,
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
  writeGlobalEffort,
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
  CODEX_MONITOR_DIR,
  CodexAppServerClient,
  readCodexHookStatuses,
  type CodexProviderSnapshot,
} from "./providers/codex";
import {
  countProviders,
  filterProvider,
  mergeProviderSessions,
  type ProviderCounts,
} from "./providers/registry";
import {
  defaultCapabilities,
  providerLabel,
  sessionKey,
  type AgentProvider,
  type ProviderHealth,
} from "./providers/types";
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
  subtreeTotals,
  parseOfficialGauges,
  isRedundantSub,
  computeBurnEta,
  estimateCostUsd,
  shortModelName,
  shortEffort,
  fmtTokensCompact,
  sortByTokens,
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

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* chmod is best-effort on platforms without POSIX modes */
  }
}

function writePrivateTextAtomic(file: string, text: string): void {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best-effort on non-POSIX filesystems */
    }
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* temp may not have been created */
    }
    throw error;
  }
}

function rotateLog(): void {
  try {
    if (fs.statSync(LOG_FILE).size > 1024 * 1024) {
      const buf = fs.readFileSync(LOG_FILE);
      writePrivateTextAtomic(LOG_FILE, buf.subarray(buf.length - 128 * 1024).toString("utf8"));
    }
  } catch {
    /* no log yet */
  }
}

function log(msg: string): void {
  try {
    ensurePrivateDir(MONITOR_DIR);
    try {
      if (fs.lstatSync(LOG_FILE).isSymbolicLink()) {
        writePrivateTextAtomic(LOG_FILE, "");
      }
    } catch {
      /* no log yet */
    }
    if (logCount++ % 1000 === 0) rotateLog();
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(LOG_FILE, 0o600);
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
  id: string; // opaque provider-qualified key
  provider: AgentProvider;
  providerLabel: string;
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
  canTranscript: boolean;
  canKill: boolean;
  canResume: boolean;
  tip: string; // full tooltip (title, status, model, cwd, id, ...)
}

interface SessionsPayload {
  type: "update";
  groups: { key: GroupKey; label: string; count: number; rows: SessionRow[] }[];
  totalCpu: number | null;
  totalRss: number | null;
  effort: string; // "" when unknown
  filter: string; // active list filter label, "" when none
  providerCounts: ProviderCounts;
  providerFilter: AgentProvider | "all";
  health: ProviderHealth[];
  emptyMessage: string;
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
  .providers { display:flex; gap:4px; padding:4px 10px 3px; }
  .pfilter { border:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.35));
    background:transparent; color:var(--vscode-foreground); border-radius:999px;
    padding:2px 8px; font:inherit; font-size:10px; cursor:pointer; opacity:.72; }
  .pfilter:hover { opacity:1; }
  .pfilter.active { opacity:1; background:var(--vscode-badge-background, rgba(127,127,127,.25));
    color:var(--vscode-badge-foreground, var(--vscode-foreground)); border-color:transparent; }
  .health { padding:3px 10px 5px; color:var(--vscode-descriptionForeground); font-size:10px; line-height:1.4; }
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
  .pbadge { display:inline-block; min-width:25px; margin-right:5px; padding:1px 3px;
    border:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.35));
    border-radius:3px; font-size:8px; font-weight:700; letter-spacing:.04em;
    text-align:center; vertical-align:1px; color:var(--vscode-descriptionForeground); }
  .pbadge.codex { color:var(--vscode-charts-blue, #3794ff); }
  .pbadge.claude { color:var(--vscode-charts-orange, #d18616); }
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
  <div id="root" aria-live="polite"><div class="empty">Loading Claude and Codex sessions…</div></div>
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
  const enabled = new Set((last.health||[]).map(x=>x.provider));
  const pf = last.providerFilter || 'all';
  h += '<div class="providers" role="toolbar" aria-label="Session provider filter">'
    + '<button class="pfilter'+(pf==='all'?' active':'')+'" data-provider="all" aria-pressed="'+(pf==='all')+'">All '+last.providerCounts.all+'</button>'
    + (enabled.has('claude')?'<button class="pfilter'+(pf==='claude'?' active':'')+'" data-provider="claude" aria-pressed="'+(pf==='claude')+'">Claude '+last.providerCounts.claude+'</button>':'')
    + (enabled.has('codex')?'<button class="pfilter'+(pf==='codex'?' active':'')+'" data-provider="codex" aria-pressed="'+(pf==='codex')+'">Codex '+last.providerCounts.codex+'</button>':'')
    + '</div>';
  const health = (last.health||[]).filter(x=>x.state!=='ready' && x.message);
  if(health.length) h += '<div class="health">'+health.map(x=>'<div><b>'+esc(x.provider==='codex'?'Codex':'Claude')+':</b> '+esc(x.message)+'</div>').join('')+'</div>';
  if(!last.groups.length){
    h += '<div class="empty">'+esc(last.emptyMessage || 'No recent agent sessions.')+'</div>';
    root.innerHTML = h;
    return;
  }
  h += '<div class="thead" role="row"><span></span><span>session</span><span class="num">tokens</span>'
    + '<span class="num c-pct">%</span><span class="c-model">model</span><span class="c-eff">eff</span><span class="c-dir">dir</span>'
    + '<span class="num">age</span><span class="num">cpu</span><span class="num c-ram">mem</span><span></span></div>';
  for(const g of last.groups){
    h += '<div class="ghead"><span class="gdot" style="background:'+GCOLOR[g.key]+'"></span>'
      + esc(g.label)+' <span class="gcount">'+g.count+'</span></div>';
    for(const r of g.rows){
      const extra = [r.sub, r.reset ? ('reset '+r.reset) : ''].filter(Boolean).join(' · ');
      h += '<div class="row'+(r.ended?' ended':'')+'" role="row" tabindex="0" data-id="'+esc(r.id)+'" title="'+esc(r.tip)+'">'
        + '<span><span class="dot'+(r.stale?' stale':'')+'" style="background:'+GCOLOR[g.key]+'"></span></span>'
        + '<span class="c-title"><span class="pbadge '+esc(r.provider)+'" title="'+esc(r.providerLabel)+'">'+(r.provider==='codex'?'CDX':'CLD')+'</span>'+esc(r.title)+(extra?' <span class="sub">· '+esc(extra)+'</span>':'')+'</span>'
        + '<span class="num c-tok">'+esc(r.tokens)
        +   (r.tokens?'<i class="tokbar'+(r.hog?' hog':'')+'" style="width:'+Math.min(100,Math.max(2,r.share))+'%"></i>':'')
        + '</span>'
        + '<span class="num c-pct">'+(r.tokens && r.share>=1 ? r.share+'%' : '')+'</span>'
        + '<span class="c-model" title="'+esc(r.model)+'">'+esc(r.model)+'</span>'
        + '<span class="c-eff" title="reasoning effort">'+esc(r.effort)+'</span>'
        + '<span class="c-dir" title="'+esc(r.dir)+'">'+esc(r.dir)+'</span>'
        + '<span class="num age" data-last="'+r.lastMs+'">'+fmtAge(r.lastMs)+'</span>'
        + '<span class="num c-cpu'+(r.cpuHog?' hot':'')+'">'+(r.cpu!=null?r.cpu+'%':'')+'</span>'
        + '<span class="num c-ram">'+(r.rssMb!=null?esc(fmtMb(r.rssMb)):'')+'</span>'
        + '<span class="c-act">'
        +   (r.canTranscript?'<button class="act" data-act="transcript" title="Open transcript" aria-label="Open transcript">▤</button>':'')
        +   (r.ended
              ? '<button class="act" data-act="remove" title="Remove from list" aria-label="Remove from list">✕</button>'
              : (r.canKill
                  ? '<button class="act" data-act="kill" title="Kill process (SIGTERM)" aria-label="Kill process">⊘</button>'
                  : (r.canResume?'<button class="act" data-act="resume" title="Resume in terminal" aria-label="Resume in terminal">↻</button>':'')))
        + '</span>'
        + '</div>';
    }
  }
  root.innerHTML = h;
}
function fmtMb(mb){ return mb >= 1024 ? (mb/1024).toFixed(1)+'GB' : mb+'MB'; }
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget && !(el.classList && (el.classList.contains('pfilter') || el.classList.contains('act') || el.classList.contains('row')))) el = el.parentElement;
  if(!el || el === ev.currentTarget) return;
  if(el.classList.contains('pfilter')){
    vscodeApi.postMessage({ type: 'filterProvider', id: el.dataset.provider });
    return;
  }
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
setInterval(() => {
  for(const el of document.querySelectorAll('.age[data-last]')){
    el.textContent = fmtAge(Number(el.dataset.last));
  }
}, 1000);
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
  provider: AgentProvider;
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

interface UsageProviderCard {
  id: string; // unique per card: "codex", "claude" or "claude:<accountId>"
  provider: AgentProvider;
  label: string;
  active: boolean; // Claude: this account is the current login (green dot)
  ts: number | null;
  official: boolean;
  gauges: Gauge[];
  note: string | null;
  sevenDayTokens: number | null;
  lifetimeTokens: number | null;
}

interface LimitsPayload {
  type: "update";
  ts: number | null;
  model: string | null;
  official: boolean; // true only when real 5h/7d gauges are available (terminal status line)
  gauges: Gauge[];
  limited: LimitedHit[]; // reactive: sessions that actually hit a limit (from transcripts)
  tokens: TokenUsage | null; // rolling 5h / 7d token usage (proxy for limit pressure)
  eta: BurnEta | null; // burn-rate projection for the 5h window
  models: ModelRow[]; // 7d token share per model (+ rough cost where priced)
  sessions: SessionTokenRow[]; // top 5h token consumers per session (this machine)
  accounts: AccountView[]; // known Claude logins ([] until 2+ accounts are known)
  accountNote: string | null; // honesty note when a non-active account is displayed
  usageNote: string | null; // honest status when the usage API is degraded
  providers: UsageProviderCard[];
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
  codexSnapshot: CodexProviderSnapshot | null = null,
  enabledProviders: ReadonlyArray<AgentProvider> = ["claude"],
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
      return {
        provider: v.provider,
        title: v.title,
        sub: v.sub,
        resetText: v.resetText,
        resetMs: e ? e * 1000 : null,
      };
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

  const providers: UsageProviderCard[] = [];
  if (enabledProviders.includes("claude")) {
    const unavailable =
      !official && !usageNote && !accountNote
        ? 'Official Claude usage unavailable (macOS keychain access to "Claude Code-credentials" is required).'
        : null;
    const selectedNote = accountNote ?? (selectedIsActive ? usageNote : null) ?? unavailable;
    if (acctCtx && acctCtx.accounts.length) {
      // Every known login gets its own card so the panel shows all accounts at
      // once. The selected (active) account carries the live gauges; the others
      // show their last background fetch.
      for (const a of acctCtx.accounts) {
        const isSel = a.id === acctCtx.selectedId;
        const aGauges = isSel ? gauges : a.gauges;
        const aOfficial = aGauges.some((g) => g.pct != null);
        let note: string | null;
        if (isSel) note = selectedNote;
        else if (a.stale) note = "token expired — last-known data; log in with Claude Code once to refresh";
        else if (!aOfficial) note = "no usage data yet — appears after the first background fetch";
        else note = null;
        providers.push({
          id: `claude:${a.id}`,
          provider: "claude",
          label: `Claude · ${a.label}`,
          active: a.id === acctCtx.activeId,
          ts: isSel ? ts : a.ts,
          official: aOfficial,
          gauges: aGauges,
          note,
          sevenDayTokens: null,
          lifetimeTokens: null,
        });
      }
    } else {
      providers.push({
        id: "claude",
        provider: "claude",
        label: "Claude",
        active: true,
        ts,
        official,
        gauges,
        note: selectedNote,
        sevenDayTokens: tokens?.sevenDay ?? null,
        lifetimeTokens: null,
      });
    }
  }
  if (enabledProviders.includes("codex")) {
    const usage = codexSnapshot?.usage;
    providers.push({
      id: "codex",
      provider: "codex",
      label: "Codex",
      active: false,
      ts: usage?.ts ?? null,
      official: !!usage,
      gauges:
        usage?.gauges.map((g) => ({
          key: g.key,
          label: g.label,
          pct: g.pct,
          resetMs: g.resetMs,
        })) ?? [],
      note:
        usage?.note ??
        (codexSnapshot?.health.state === "degraded" ? codexSnapshot.health.message ?? null : null) ??
        (!usage ? "Codex account usage is not available yet." : null),
      sevenDayTokens: usage?.sevenDayTokens ?? null,
      lifetimeTokens: usage?.lifetimeTokens ?? null,
    });
  }

  return {
    type: "update",
    ts,
    model,
    official,
    gauges,
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
    providers,
  };
}

class LimitsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: LimitsPayload;

  constructor(
    private readonly onRefresh: () => void,
  ) {}

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
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 6px 10px 4px; }
  .empty { opacity: .65; padding: 6px 0; }
  .gauge { margin: 0 0 7px 0; }
  .grow { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:3px; }
  .glabel { font-weight:600; }
  .gpct { font-variant-numeric: tabular-nums; }
  .greset { opacity:.7; font-size:11px; }
  .bar { height:8px; border-radius:4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.18)); overflow:hidden; }
  .fill { height:100%; border-radius:4px; transition: width .4s ease; }
  .card { padding:5px 0 3px; border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.2)); }
  .card:first-child { border-top:0; padding-top:0; }
  .chead { display:flex; align-items:center; gap:6px; margin-bottom:3px; }
  .ctitle { font-weight:700; font-size:11px; opacity:.85; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .card .grow { margin-bottom:2px; }
  .card .note { margin-top:3px; }
  .adot { width:7px; height:7px; border-radius:50%; background:var(--vscode-charts-green,#4caf50); flex:none; }
  .legend { font-size:11px; opacity:.7; display:flex; gap:12px; margin-top:2px; flex-wrap:wrap; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:4px; vertical-align:middle; }
  svg { width:100%; display:block; }
  .foot { margin-top:8px; font-size:11px; opacity:.55; }
  .sec { margin-top:8px; }
  .sec h4 { margin:0 0 4px 0; font-size:11px; opacity:.7; font-weight:600; }
  .sech { display:flex; align-items:baseline; gap:6px; cursor:pointer; user-select:none; padding:1px 0; }
  button.sech { width:100%; border:0; background:transparent; color:inherit; font:inherit; text-align:left; }
  .sech h4 { margin:0; }
  .sech:hover h4 { opacity:1; }
  .chev { font-size:9px; opacity:.55; width:9px; flex:none; }
  .hint { font-size:10px; opacity:.5; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:55%; font-weight:400; }
  .hit { padding:4px 0; border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.2)); }
  .hitt { font-weight:600; }
  .note { margin-top:10px; font-size:11px; opacity:.6; line-height:1.4; }
  .eta { font-size:11px; margin:-3px 0 8px 0; opacity:.85; }
  .eta.bad { color: var(--vscode-charts-red, #f14c4c); opacity:1; }
  .mrow { display:flex; align-items:center; gap:6px; margin:3px 0; }
  .mname { width:84px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mbar { flex:1; height:7px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.18)); overflow:hidden; }
  .mfill { height:100%; border-radius:3px; }
  .mval { font-size:10px; font-variant-numeric: tabular-nums; opacity:.75; white-space:nowrap; }
</style>
</head>
<body>
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
function fmtPct(p){
  if(p==null) return '?';
  return p < 10 ? (Math.round(p*10)/10).toString() : String(Math.round(p));
}
// Collapsible sections: the panel shares a sidebar with the session table, so
// every block below the gauges can be folded to one header line. State is kept
// in the webview state store (survives hide/show and window reloads).
const savedState = vscodeApi.getState() || {};
let collapsed = savedState.collapsed || { sessions:false, models:true };
function saveState(){ vscodeApi.setState({ collapsed }); }
function secHeader(id, title, hint){
  return '<button type="button" class="sech" data-sec="'+id+'" aria-expanded="'+(!collapsed[id])+'"><span class="chev">'+(collapsed[id]?'▸':'▾')+'</span>'
    + '<h4>'+title+'</h4>'
    + (collapsed[id] && hint ? '<span class="hint">'+hint+'</span>' : '')
    + '</button>';
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
function providerTokenLine(card){
  if(card.sevenDayTokens==null && card.lifetimeTokens==null) return '';
  const parts=[];
  if(card.sevenDayTokens!=null) parts.push('7d '+fmtTokens(card.sevenDayTokens));
  if(card.lifetimeTokens!=null) parts.push('lifetime '+fmtTokens(card.lifetimeTokens));
  return '<div class="grow"><span class="glabel">Tokens</span><span class="gpct">'+parts.join(' · ')+'</span></div>';
}
// One compact line per gauge: label, used% (colored by pressure) and the reset
// countdown. The segment bars were dropped so every account fits on screen.
function gaugeRow(g){
  const p = g.pct;
  return '<div class="grow"><span class="glabel">'+esc(g.label)+'</span>'
    + '<span class="gpct"><span style="color:'+color(p)+'">'+fmtPct(p)+'%</span>'
    + (g.resetMs?(' <span class="greset">· '+fmtLeft(g.resetMs)+'</span>'):'')+'</span></div>';
}
// One card per provider/account, all stacked: every Claude login and Codex are
// visible at once, no tabs.
function providerCard(card){
  const age = card.ts ? Math.max(0, Math.round(Date.now()/1000 - card.ts)) : null;
  let h='<div class="card"><div class="chead">'
    + (card.provider==='claude' && card.active ? '<span class="adot" title="active login"></span>' : '')
    + '<span class="ctitle">'+esc(card.label)+'</span>'
    + (age!=null ? '<span class="hint" title="last official usage fetch">'+fmtAge(age)+' ago</span>' : '')
    + '</div>';
  if(card.official){
    for(const g of card.gauges){
      h += gaugeRow(g);
      if(card.provider==='claude' && card.active && (g.key==='session'||g.key==='5h')) h += etaLine(last.eta);
    }
  }
  h += providerTokenLine(card);
  if(card.note) h += '<div class="note">'+esc(card.note)+'</div>';
  else if(!card.official) h += '<div class="note">Official '+esc(card.label)+' usage is unavailable. Session state remains available.</div>';
  return h+'</div>';
}
function render(){
  const root = document.getElementById('root');
  if(!last){ return; }
  let h='';
  const cards = (last.providers && last.providers.length) ? last.providers : [{
    id:'claude', provider:'claude', label:'Claude', active:true, ts:last.ts, official:last.official, gauges:last.gauges||[],
    note:last.usageNote||last.accountNote||null, sevenDayTokens:null, lifetimeTokens:null
  }];
  for(const c of cards) h += providerCard(c);
  if(cards.some(c=>c.provider==='claude')){
    // Claude token usage is a rolling local proxy with per-session/model detail.
    const multiAcct = !!(last.accounts && last.accounts.length > 1);
    h += tokenSection(last.tokens, multiAcct);
    h += sessionSection(last.sessions);
    h += modelSection(last.models);
  }
  // Reactive limit hits: always real, derived from session transcripts (429).
  const limited = last.limited||[];
  if(limited.length){
    h += '<div class="sec"><h4>Active limit hits</h4>';
    for(const l of limited){
      const reset = l.resetMs ? (' · '+fmtLeft(l.resetMs)) : (l.resetText? (' · resets '+esc(l.resetText)) : '');
      const prov = cards.length > 1 ? (l.provider==='codex' ? 'Codex · ' : 'Claude · ') : '';
      h += '<div class="hit"><span class="hitt">'+prov+esc(l.title)+'</span> <span class="greset">'+esc(l.sub)+reset+'</span></div>';
    }
    h += '</div>';
  }
  root.innerHTML = h;
}
// Manual refresh lives in the view title bar (the ⟳ icon runs
// claudeSessionMonitor.refreshUsage); the in-panel button was removed to give
// the vertical space back to data. The "refreshing…" note still reports state.
// Section headers are re-rendered every second, so their click handlers are
// delegated from the stable root node.
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget){
    if(el.classList && el.classList.contains('sech') && el.dataset.sec){
      collapsed[el.dataset.sec] = !collapsed[el.dataset.sec];
      saveState();
      render();
      return;
    }
    el = el.parentElement;
  }
});
window.addEventListener('message', e => {
  if(e.data && e.data.type==='update'){ last = e.data; render(); }
});
setInterval(render, 1000); // keep countdowns live
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
  const claudeEnabled = () => cfg().get<boolean>("enableClaude", true);
  const codexEnabled = () => cfg().get<boolean>("enableCodex", true);
  const enabledProviders = (): AgentProvider[] => [
    ...(claudeEnabled() ? (["claude"] as const) : []),
    ...(codexEnabled() ? (["codex"] as const) : []),
  ];
  const savedProviderFilter = ctx.globalState.get<string>("providerFilter", "all");
  let providerFilter: AgentProvider | "all" =
    savedProviderFilter === "claude" || savedProviderFilter === "codex" ? savedProviderFilter : "all";

  const resourceCache = new Map<number, ResStat>();
  const sessionsView = new SessionsView((action, sessionId) => {
    if (action === "filterProvider") {
      if (sessionId === "all" || sessionId === "claude" || sessionId === "codex") {
        providerFilter = sessionId;
        void ctx.globalState.update("providerFilter", providerFilter);
        refresh();
      }
      return;
    }
    const v = lastAllViews.find((session) => session.key === sessionId);
    if (!v) return;
    if (action === "open") void jumpToSession(v);
    else if (action === "transcript") openTranscript(v);
    else if (action === "resume") void resumeInTerminal(v);
    else if (action === "kill") void vscode.commands.executeCommand("claudeSessionMonitor.killProcess", v);
    else if (action === "remove") void vscode.commands.executeCommand("claudeSessionMonitor.removeSession", v);
  });
  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.view", sessionsView),
  );

  // Multi-account state: every account seen as the active login is remembered
  // (registry file shared across windows; tokens in SecretStorage), and the
  // usage panel shows every one of them at once.
  let accountsFile: AccountsFile = readAccountsFile();
  const usageByAccount = new Map<string, { usage: OfficialUsage | null; stale: boolean }>();
  let othersInflight = false;
  let lastOthersCheck = 0;

  const limitsView = new LimitsView(() =>
    vscode.commands.executeCommand("claudeSessionMonitor.refreshUsage"),
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
  let lastAllViews: SessionView[] = [];
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
  let codexClient: CodexAppServerClient | undefined;
  let codexExecutable = "";
  let codexRefreshInflight = false;
  let lastCodexRefresh = 0;
  let codexFailureCount = 0;
  let codexRetryAfter = 0;
  let disposed = false;
  let codexSnapshot: CodexProviderSnapshot = {
    sessions: [],
    usage: null,
    health: { provider: "codex", state: "loading", message: "Connecting to Codex app-server…" },
  };

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
  const dismissalTtlMs = 30 * 24 * 3600 * 1000;
  const storedDismissals = ctx.globalState.get<Array<{ key: string; at: number }>>(
    "dismissedSessionsV2",
    [],
  );
  const dismissed = new Map<string, number>();
  const dismissalLoadNow = Date.now();
  if (Array.isArray(storedDismissals)) {
    for (const entry of storedDismissals.slice(-5000)) {
      if (
        entry &&
        typeof entry.key === "string" &&
        /^(claude|codex):/.test(entry.key) &&
        entry.key.length <= 256 &&
        typeof entry.at === "number" &&
        entry.at > dismissalLoadNow - dismissalTtlMs &&
        entry.at < dismissalLoadNow + 60_000
      ) {
        dismissed.set(entry.key, entry.at);
      }
    }
  }
  const persistDismissals = async (): Promise<void> => {
    const cutoff = Date.now() - dismissalTtlMs;
    for (const [key, at] of dismissed) {
      if (at < cutoff) dismissed.delete(key);
    }
    if (dismissed.size > 5000) {
      const keep = [...dismissed].sort((a, b) => b[1] - a[1]).slice(0, 5000);
      dismissed.clear();
      for (const [key, at] of keep) dismissed.set(key, at);
    }
    await ctx.globalState.update(
      "dismissedSessionsV2",
      [...dismissed].map(([key, at]) => ({ key, at })),
    );
  };
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
    if (!claudeEnabled() || !cfg().get<boolean>("autoResumeAfterReset", false)) {
      clearAutoResume();
      return;
    }
    const nowMs = Date.now();
    const g5 = officialUsage?.gauges.find((g) => g.key === "session");
    let target = 0;
    const limitedViews = views.filter((v) => v.provider === "claude" && groupOf(v) === "limited");
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
      if (
        disposed ||
        !claudeEnabled() ||
        !cfg().get<boolean>("autoResumeAfterReset", false) ||
        resumeActive
      ) {
        return;
      }
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
          log(`usage ok (acct ${a.id.slice(0, 8)}): ${r.usage.gauges.map((g) => `${g.key}=${Math.round(g.pct)}`).join(" ")}`);
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
          log(`usage acct ${a.id.slice(0, 8)}: token rejected (${r.status})`);
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
   * Resolve the account list the panel renders (one card each) and the active
   * login, whose gauges drive the burn-rate ETA and history.
   */
  function currentAccountCtx(): AccountCtx & { usage: OfficialUsage | null } {
    const activeId = accountsFile.activeId ?? null;
    const track = trackAllAccounts();
    if (activeId && officialUsage) usageByAccount.set(activeId, { usage: officialUsage, stale: false });
    const selId = activeId;
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
        gauges: (e?.usage?.gauges ?? []).map((g) => ({ key: g.key, label: g.label, pct: g.pct, resetMs: g.resetMs })),
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

  function currentCodexClient(): CodexAppServerClient {
    const executable = cfg().get<string>("codexExecutable", "codex").trim() || "codex";
    if (!codexClient || codexExecutable !== executable) {
      codexClient?.dispose();
      codexExecutable = executable;
      codexClient = new CodexAppServerClient(executable);
    }
    return codexClient;
  }

  async function pollCodex(force: boolean): Promise<void> {
    if (disposed) return;
    if (!codexEnabled()) {
      codexClient?.dispose();
      codexClient = undefined;
      codexExecutable = "";
      codexFailureCount = 0;
      codexRetryAfter = 0;
      return;
    }
    const now = Date.now() / 1000;
    const cadence = Math.max(3, cfg().get<number>("codexPollSeconds", 5));
    if (!force && now < codexRetryAfter) return;
    if (!force && now - lastCodexRefresh < cadence) return;
    if (codexRefreshInflight) return;
    codexRefreshInflight = true;
    lastCodexRefresh = now;
    try {
      const c = cfg();
      const wsOnly =
        workspaceOnlyOverride !== undefined
          ? workspaceOnlyOverride
          : c.get<boolean>("workspaceOnly", false);
      const client = currentCodexClient();
      const next = await client.refresh({
        now,
        maxAgeSec: c.get<number>("recentScanMaxAgeHours", 6) * 3600,
        hideEndedOlderThanSec: c.get<number>("hideEndedAfterMinutes", 30) * 60,
        showEnded: c.get<boolean>("showEnded", false),
        workspaceCwd: wsOnly ? workspaceCwd() : undefined,
      });
      // Ignore a late response from an executable/provider instance that was
      // disabled or replaced while its request was in flight.
      if (client === codexClient && codexEnabled()) {
        codexSnapshot = next;
        if (next.health.state === "degraded") {
          codexFailureCount++;
          const delay = Math.min(
            300,
            cadence * 2 ** Math.min(codexFailureCount - 1, 6),
          );
          codexRetryAfter = Date.now() / 1000 + delay;
        } else {
          codexFailureCount = 0;
          codexRetryAfter = 0;
        }
      }
    } finally {
      codexRefreshInflight = false;
    }
    if (!disposed) refresh();
  }

  /** Rebuild the sessions table payload (grouping, per-row stats, badge) and post it. */
  function pushSessions(views: SessionView[], allViews: SessionView[] = views): void {
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
        [
          needsYouOnly ? "needs-you only" : "",
          providerFilter !== "all" ? providerLabel(providerFilter) : "",
        ]
          .filter(Boolean)
          .join(" · "),
        cfg().get<number>("cpuHogThreshold", 60),
        countProviders(allViews),
        providerFilter,
        enabledProviders().map((provider) =>
          provider === "codex"
            ? codexSnapshot.health
            : { provider: "claude", state: "ready" as const, updatedAt: Date.now() / 1000 },
        ),
        views.length
          ? ""
          : enabledProviders().length === 0
            ? "Both providers are disabled. Enable Claude or Codex in Settings."
            : providerFilter !== "all" || needsYouOnly
              ? "No sessions match the active filters."
              : "No recent Claude or Codex sessions. Start one and it will appear here.",
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
      limitsView.update(
        buildLimitsPayload(
          lastAllViews,
          tokenUsage,
          c.usage,
          usageNote,
          c,
          codexEnabled() ? codexSnapshot : null,
          enabledProviders(),
        ),
      );
      updateStatusBar(
        statusBar,
        lastAllViews,
        resourceCache,
        claudeEnabled() ? officialUsage : null,
      );
    } catch {
      /* ignore */
    }
  }

  function refresh(): void {
    if (disposed) return;
    const now = Date.now() / 1000;
    const c = cfg();
    if (providerFilter !== "all" && !enabledProviders().includes(providerFilter)) {
      providerFilter = "all";
      void ctx.globalState.update("providerFilter", providerFilter);
    }
    if (codexEnabled()) void pollCodex(false);

    const maxAgeHours = c.get<number>("recentScanMaxAgeHours", 6);
    if (claudeEnabled() && now - lastRecentScan > 25) {
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
        cleanupMonitorFiles(12 * 3600 * 1000, now, CODEX_MONITOR_DIR);
        pruneLimitsHistory(3000);
      } catch {
        /* ignore */
      }
      lastCleanup = now;
    }

    if (claudeEnabled() && now - lastTokenScan > 60) {
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
    if (claudeEnabled() && now - lastUsageCheck > 5) {
      lastUsageCheck = now;
      void pollUsage(false);
    }

    // Non-active accounts: pick up registry changes other windows wrote, then
    // refresh their usage in the background on a slower cadence.
    if (claudeEnabled() && now - lastOthersCheck > 30) {
      lastOthersCheck = now;
      accountsFile = readAccountsFile();
      void pollOtherAccounts(false);
    }

    const wsOnly =
      workspaceOnlyOverride !== undefined ? workspaceOnlyOverride : c.get<boolean>("workspaceOnly", false);

    let claudeViews: SessionView[] = [];
    if (claudeEnabled()) {
      try {
        claudeViews = collectSessions({
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
        claudeViews = [];
      }
    }

    let allViews = mergeProviderSessions(
      claudeViews,
      codexEnabled() ? codexSnapshot.sessions : [],
    );
    let dismissalsChanged = false;
    for (const v of allViews) {
      const dismissedAt = dismissed.get(v.key);
      if (
        dismissedAt != null &&
        groupOf(v) !== "ended" &&
        v.lastActivityMs > dismissedAt + 500
      ) {
        dismissed.delete(v.key);
        dismissalsChanged = true;
      }
    }
    if (dismissalsChanged) void persistDismissals();
    if (dismissed.size) allViews = allViews.filter((v) => !dismissed.has(v.key));
    lastAllViews = allViews;

    let views = filterProvider(allViews, providerFilter);
    if (needsYouOnly) views = views.filter((v) => NEEDS_YOU.includes(groupOf(v)));
    lastViews = views;

    if (now - lastSessLog > 20) {
      lastSessLog = now;
      log(
        `sessions=${allViews.length} ${JSON.stringify(countBuckets(allViews))} providers=${JSON.stringify(countProviders(allViews))} dismissed=${dismissed.size}`,
      );
    }

    pushSessions(views, allViews);
    pushUsagePayload();

    maybeScheduleAutoResume(allViews);

    // Idle RAM advisory: waiting/your-turn sessions silent >1h holding real memory.
    const idleThr = c.get<number>("idleRamWarnMb", 2000);
    if (idleThr > 0 && now - lastIdleRamWarn > 3600) {
      let rss = 0;
      let cnt = 0;
      for (const v of allViews) {
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
            `Agent Sessions: ${cnt} idle session(s) holding ${fmtMb(rss)} RAM — consider closing finished tabs.`,
            "Show",
          )
          .then((ch) => {
            if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
      }
    }

    // Run on the first snapshot as well: checkStuck silently seeds sessions
    // that were already stale before monitoring began. This also covers a
    // provider whose first asynchronous snapshot arrives after first paint.
    checkStuck(allViews, stuckNotified, c, resourceCache, lastSeen);
    detectTransitions(allViews, lastSeen, firstPaintDone, c);
    firstPaintDone = true;

    if (now - lastResourceSample > Math.max(1000, c.get<number>("resourceSampleMs", 3000)) / 1000) {
      lastResourceSample = now;
      const pids = allViews.map((v) => v.pid).filter((p): p is number => !!p);
      sampleResources(pids, resourceCache, () => {
        if (disposed) return;
        updateStatusBar(
          statusBar,
          lastAllViews,
          resourceCache,
          claudeEnabled() ? officialUsage : null,
        );
        pushSessions(lastViews, lastAllViews);
      });
    }
  }

  /**
   * Generic OS-keystroke sweep: focuses each queued session and types `text`
   * + Enter into it, one every `opts.staggerSec`. Shared by "Resume All" and
   * the "Set Model/Effort for All Sessions" commands so they all get the same
   * safety rails: the resumeActive/stopResume guard (so "Stop Resume Sweep"
   * always works), the modal "about to type..." confirmation before any
   * unattended typing, accessibility-error handling, a frontmost + active-tab
   * re-verification right before each keystroke, and self-chained scheduling
   * (never overlaps, never double-types).
   */
  function startTypingSweep(
    queue: SessionView[],
    text: string,
    opts: { staggerSec: number; doneLabel: string; submitDelayMs?: number; autoType?: boolean },
  ): void {
    // These commands type Claude slash-commands into the focused Claude input.
    // Keep this guard even when the caller already filtered by capability so a
    // mixed-provider command argument can never receive unattended keystrokes.
    queue = queue.filter((v) => v.provider === "claude" && v.capabilities.bulkInput);
    if (!queue.length) {
      vscode.window.showInformationMessage(`Claude Sessions: no open sessions to ${opts.doneLabel}.`);
      return;
    }
    stopResume();
    const stagger = Math.max(3, opts.staggerSec);
    const auto = opts.autoType ?? true;
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
            ? `Claude Sessions: ${opts.doneLabel} done · typed ${typed}, skipped ${skipped}.`
            : `Claude Sessions: ${opts.doneLabel} done (${queue.length}).`,
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
            .showInformationMessage(`${opts.doneLabel} ${i}/${queue.length}: "${truncate(v.title, 40)}" · press Enter`, "Stop")
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
          if (!front || !a || !matchCandidates(v).some((c) => labelsMatch(a, c))) {
            skipped++;
            log(
              `${opts.doneLabel} skip ${v.key}: front=${front} activeMatched=${
                !!a && matchCandidates(v).some((candidate) => labelsMatch(a, candidate))
              }`,
            );
          } else {
            const r = await typeAndSubmit(text, opts.submitDelayMs);
            if (!r.ok) {
              if (/not allowed|assistive|accessibility|-1743|-25211|not permitted/i.test(r.err || "")) {
                stopResume();
                vscode.window
                  .showErrorMessage(
                    'Auto-resume needs Accessibility permission. Enable "Visual Studio Code" in System Settings > Privacy & Security > Accessibility, then run the sweep again.',
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
        log(`${opts.doneLabel} step error: ` + String(e));
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
          `Claude Sessions: about to type "${text}" + Enter into the focused editor for ${queue.length} session(s), one every ${stagger}s. Put your cursor in the Claude input and keep VS Code frontmost.`,
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
          ? "Agent Sessions: this workspace only."
          : "Agent Sessions: all workspaces.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleNeedsYouOnly", () => {
      needsYouOnly = !needsYouOnly;
      vscode.window.showInformationMessage(
        needsYouOnly ? "Agent Sessions: needs-you only." : "Agent Sessions: all sessions.",
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.toggleProvider", () => {
      const order: Array<AgentProvider | "all"> = ["all", ...enabledProviders()];
      providerFilter = order[(order.indexOf(providerFilter) + 1) % order.length];
      void ctx.globalState.update("providerFilter", providerFilter);
      vscode.window.showInformationMessage(
        providerFilter === "all"
          ? "Agent Sessions: showing Claude and Codex."
          : `Agent Sessions: showing ${providerLabel(providerFilter)} only.`,
      );
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.clearEnded", async () => {
      const now = Date.now() / 1000;
      const dismissedAt = Date.now();
      const previousDismissals = new Map(dismissed);
      for (const v of lastAllViews) {
        if (groupOf(v) === "ended") dismissed.set(v.key, dismissedAt);
      }
      // Ended rows are normally hidden before they reach lastAllViews. Capture
      // their provider-scoped identities before deleting the lifecycle files,
      // otherwise transcript/app-server fallback can resurrect them as unknown
      // immediately (or after a VS Code reload).
      for (const [sessionId, status] of readHookStatuses()) {
        if (status.state === "ended") {
          dismissed.set(sessionKey("claude", sessionId), dismissedAt);
        }
      }
      for (const [sessionId, status] of readCodexHookStatuses()) {
        if (status.state === "ended") {
          dismissed.set(sessionKey("codex", sessionId), dismissedAt);
        }
      }
      try {
        await persistDismissals();
      } catch {
        dismissed.clear();
        for (const [key, at] of previousDismissals) dismissed.set(key, at);
        vscode.window.showErrorMessage(
          "Agent Sessions: could not persist the cleared-session state; no status files were removed.",
        );
        return;
      }
      const removed =
        cleanupEndedMonitorFiles(now) + cleanupEndedMonitorFiles(now, 12 * 3600 * 1000, CODEX_MONITOR_DIR);
      vscode.window.showInformationMessage(`Agent Sessions: cleared ${removed} ended status file(s).`);
      txCache.clear();
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.removeSession", async (arg?: SessionView) => {
      const ref = asView(arg);
      const v = ref ? lastAllViews.find((session) => session.key === ref.key) : undefined;
      if (!v) return;
      const previousDismissal = dismissed.get(v.key);
      dismissed.set(v.key, Date.now());
      try {
        await persistDismissals();
      } catch {
        if (previousDismissal == null) dismissed.delete(v.key);
        else dismissed.set(v.key, previousDismissal);
        vscode.window.showErrorMessage(
          "Agent Sessions: could not persist the removed-session state; the session was kept.",
        );
        return;
      }
      try {
        const dir = v.provider === "codex" ? CODEX_MONITOR_DIR : MONITOR_DIR;
        fs.unlinkSync(`${dir}/${v.sessionId}.json`);
      } catch {
        /* may not exist */
      }
      refresh();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.dumpTabs", () => {
      const total = dumpTabsTo(`${MONITOR_DIR}/tabs-debug.json`);
      vscode.window.showInformationMessage(
        `Agent Sessions: wrote ${total} tabs to ~/.claude/session-monitor/tabs-debug.json`,
      );
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.stopResumeAll", () =>
      stopResume("Claude Sessions: resume sweep stopped."),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.resumeAll", () => {
      const queue = lastAllViews.filter(
        (v) => v.provider === "claude" && v.capabilities.bulkInput && groupOf(v) !== "ended",
      );
      const c = cfg();
      // Collapse newlines so a single resumePrompt value can never encode more
      // than one Return keystroke (osascript `keystroke` submits on each \n).
      const prompt = c.get<string>("resumePrompt", "resume").replace(/[\r\n]+/g, " ").slice(0, 500);
      startTypingSweep(queue, prompt, {
        staggerSec: Math.max(5, c.get<number>("resumeStaggerSeconds", 60)),
        doneLabel: "resume",
        autoType: c.get<boolean>("resumeAutoType", true),
      });
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.setModelAll", async () => {
      const queue = lastAllViews.filter(
        (v) => v.provider === "claude" && v.capabilities.bulkInput && groupOf(v) !== "ended",
      );
      const items: { label: string; value: string }[] = [
        { label: "Opus 4.8", value: "opus" },
        { label: "Sonnet 5", value: "sonnet" },
        { label: "Haiku 4.5", value: "haiku" },
        { label: "Fable 5", value: "claude-fable-5" },
        { label: "Default (recommended)", value: "default" },
        { label: "Custom…", value: "" },
      ];
      const pick = await vscode.window.showQuickPick(
        items.map((it) => it.label),
        { placeHolder: "Model to set for every open session" },
      );
      if (!pick) return;
      let value = items.find((it) => it.label === pick)?.value;
      if (pick === "Custom…") {
        const custom = await vscode.window.showInputBox({
          prompt: "Model id or alias (e.g. claude-opus-4-8)",
          placeHolder: "claude-opus-4-8",
        });
        if (!custom?.trim()) return;
        value = custom.trim();
      }
      if (!value) return;
      startTypingSweep(queue, `/model ${value}`, {
        staggerSec: Math.max(3, cfg().get<number>("commandStaggerSeconds", 8)),
        doneLabel: "set model",
        submitDelayMs: 500,
      });
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.setEffortAll", async () => {
      const queue = lastAllViews.filter(
        (v) => v.provider === "claude" && v.capabilities.bulkInput && groupOf(v) !== "ended",
      );
      const level = await vscode.window.showQuickPick(["low", "medium", "high", "xhigh", "max"], {
        placeHolder: "Reasoning effort to set for every open session",
      });
      if (!level) return;
      if (!writeGlobalEffort(level)) {
        vscode.window.showErrorMessage(
          "Claude Sessions: could not update effortLevel in ~/.claude/settings.json — sweep aborted.",
        );
        return;
      }
      vscode.window.showInformationMessage(
        `Claude Sessions: effortLevel set to "${level}"; sweeping /effort into ${queue.length} open session(s).`,
      );
      startTypingSweep(queue, `/effort ${level}`, {
        staggerSec: Math.max(3, cfg().get<number>("commandStaggerSeconds", 8)),
        doneLabel: "set effort",
        submitDelayMs: 500,
      });
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.openTranscript", (arg?: SessionView) =>
      openTranscript(arg),
    ),
    vscode.commands.registerCommand("claudeSessionMonitor.openSession", (arg?: SessionView) => {
      const v = asView(arg);
      if (v) void jumpToSession(v);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.resumeSession", (v?: SessionView) => {
      const session = asView(v);
      if (session) resumeInTerminal(session);
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.refreshUsage", async () => {
      vscode.window.setStatusBarMessage("Agent Sessions: refreshing usage…", 2500);
      await Promise.all([
        claudeEnabled()
          ? pollUsage(true).then(() => pollOtherAccounts(true))
          : Promise.resolve(),
        codexEnabled() ? pollCodex(true) : Promise.resolve(),
      ]);
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
      vscode.window.showInformationMessage(
        drop.length
          ? `Claude Sessions: forgot ${drop.length} other account(s) and deleted their stored tokens.`
          : "Claude Sessions: no other accounts stored.",
      );
      pushUsagePayload();
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.focusNextNeedsYou", () => {
      const order: Record<string, number> = { limited: 0, waiting: 1, done: 2 };
      const cand = lastAllViews
        .filter((v) => NEEDS_YOU.includes(groupOf(v)))
        .sort(
          (a, b) =>
            (order[groupOf(a)] ?? 9) - (order[groupOf(b)] ?? 9) || a.lastActivityMs - b.lastActivityMs,
        );
      if (!cand.length) {
        vscode.window.setStatusBarMessage("Agent Sessions: nothing needs you 🎉", 3000);
        return;
      }
      const idx = cand.findIndex((v) => v.key === focusCursor);
      const next = cand[(idx + 1) % cand.length];
      focusCursor = next.key;
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
      const ref = asView(arg);
      const v = ref ? lastAllViews.find((session) => session.key === ref.key) : undefined;
      if (!v?.pid || !v.capabilities.kill) {
        vscode.window.showWarningMessage("No process id known for this session.");
        return;
      }
      const pick = await vscode.window.showWarningMessage(
        `Send SIGTERM to "${truncate(v.title, 40)}" (pid ${v.pid})?`,
        { modal: true },
        "Kill",
      );
      if (pick !== "Kill") return;
      if (!(await verifyKillTarget(v))) {
        vscode.window.showWarningMessage(
          "The recorded process has exited or no longer matches this session provider; nothing was killed.",
        );
        return;
      }
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
    {
      dispose: () => {
        disposed = true;
        codexClient?.dispose();
        codexClient = undefined;
      },
    },
  );

  const debouncedRefresh = debounce(refresh, 200);
  ctx.subscriptions.push({ dispose: () => debouncedRefresh.cancel() });
  for (const monitorDir of [MONITOR_DIR, CODEX_MONITOR_DIR]) {
    try {
      ensurePrivateDir(monitorDir);
      const w = fs.watch(monitorDir, debouncedRefresh);
      w.on("error", () => {});
      ctx.subscriptions.push({ dispose: () => w.close() });
    } catch {
      /* polling still covers it */
    }
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
      if (
        e.affectsConfiguration("claudeSessionMonitor.enableClaude") ||
        e.affectsConfiguration("claudeSessionMonitor.enableCodex") ||
        e.affectsConfiguration("claudeSessionMonitor.codexExecutable") ||
        e.affectsConfiguration("claudeSessionMonitor.codexPollSeconds")
      ) {
        if (e.affectsConfiguration("claudeSessionMonitor.enableClaude") && !claudeEnabled()) {
          clearAutoResume();
          stopResume();
        }
        lastCodexRefresh = 0;
        if (
          e.affectsConfiguration("claudeSessionMonitor.enableCodex") ||
          e.affectsConfiguration("claudeSessionMonitor.codexExecutable")
        ) {
          codexClient?.dispose();
          codexClient = undefined;
          codexExecutable = "";
          codexFailureCount = 0;
          codexRetryAfter = 0;
          codexSnapshot = {
            sessions: [],
            usage: null,
            health: {
              provider: "codex",
              state: "loading",
              message: "Connecting to Codex app-server…",
            },
          };
        }
        void pollCodex(true);
        refresh();
      }
    }),
  );

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
  const roots = [...new Set(pids)];
  // One system-wide snapshot per tick (not one `ps -p <pid>` call per session):
  // a session's real footprint includes ~14 MCP-server children plus tool
  // subprocesses, invisible to a single top-level pid sample. subtreeTotals
  // walks the ppid tree from this one snapshot to sum each session's subtree.
  execFile("ps", ["-axo", "pid=,ppid=,pcpu=,rss="], { timeout: 4000 }, (err, stdout) => {
    const now = Date.now() / 1000;
    if (!err && stdout) {
      const rows = parsePsOutput(String(stdout));
      for (const pid of roots) {
        const { cpu, rssMb } = subtreeTotals(rows, pid);
        cache.set(pid, { cpu, rssMb, ts: now });
      }
    }
    for (const [pid, v] of cache) if (now - v.ts > 60) cache.delete(pid);
    done();
  });
}

function verifyKillTarget(view: SessionView): Promise<boolean> {
  if (!view.pid || !view.capabilities.kill) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(view.pid), "-o", "command="],
      { timeout: 3000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(false);
          return;
        }
        const command = String(stdout).trim().toLowerCase();
        if (view.provider === "codex") {
          resolve(
            /(?:^|[/\s])codex(?:\s|$)/.test(command) &&
              !/(?:^|\s)app-server(?:\s|$)/.test(command),
          );
          return;
        }
        resolve(command.includes("anthropic.claude-code") && command.includes("resources"));
      },
    );
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
  if (g5 && g5.pct >= 70) segs.push(`$(dashboard) C ${Math.round(g5.pct)}%`);

  item.text = segs.length ? `$(pulse) ${segs.join("  ")}` : "$(pulse) Agent: no sessions";

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
    ? `\nClaude usage: ${usage.gauges.map((g) => `${g.label} ${Math.round(g.pct)}%`).join(" · ")}`
    : "";
  const providers = countProviders(views);
  item.tooltip = `Agent sessions\nClaude: ${providers.claude} · Codex: ${providers.codex}\nworking: ${counts.working}\nwaiting: ${waiting}\nyour turn: ${done}\nlimited: ${counts.limited}${resLine}${usageLine}\n(click to open the panel)`;

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
  providerCounts: ProviderCounts,
  providerFilter: AgentProvider | "all",
  health: ProviderHealth[],
  emptyMessage: string,
): SessionsPayload {
  const nowSec = Date.now() / 1000;
  const grouped = new Map<GroupKey, SessionRow[]>();
  let totalCpu = 0;
  let totalRss = 0;
  let anyRes = false;
  const tokOf = (v: SessionView): number =>
    v.tokens ?? (v.provider === "claude" ? (tokens?.bySession5h?.[v.sessionId] ?? 0) : 0);
  for (const v of sortByTokens(views, tokOf)) {
    const g = groupOf(v);
    const res = freshRes(v, resCache);
    if (res) {
      totalCpu += res.cpu;
      totalRss += res.rssMb;
      anyRes = true;
    }
    const tok = tokOf(v);
    const tokenScope = v.tokenScope ?? (v.provider === "claude" ? "rolling-5h" : undefined);
    const total5h = tokens?.fiveHour ?? 0;
    const share =
      tokenScope === "rolling-5h" && tok && total5h > 0
        ? Math.round((tok / total5h) * 100)
        : 0;
    const resTip = res ? `\nCPU: ${Math.round(res.cpu)}%  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
    const tokTip =
      tok >= 10_000
        ? `\ntokens (${tokenScope === "thread-total" ? "thread total" : "rolling 5h"}): ${fmtTokensCompact(tok)}${share >= 1 ? ` · ${share}% of this Mac's total` : ""}${v.provider === "claude" && v.sessionId === hogId ? " · top consumer" : ""}`
        : "";
    const row: SessionRow = {
      id: v.key,
      provider: v.provider,
      providerLabel: providerLabel(v.provider),
      title: v.title,
      sub: isRedundantSub(v.sub) ? "" : v.sub,
      reset: v.resetText ? formatReset(v.resetText, nowSec) : "",
      tokens: tok >= 10_000 ? fmtTokensCompact(tok) : "",
      share,
      hog: v.provider === "claude" && v.sessionId === hogId,
      model: v.model ? shortModelName(v.model) : "",
      effort: shortEffort(v.effort) ?? "",
      lastMs: v.lastActivityMs,
      dir: v.cwdLabel ?? "",
      cpu: res ? Math.round(res.cpu) : null,
      rssMb: res ? res.rssMb : null,
      cpuHog: !!res && res.cpu >= cpuHogThreshold,
      stale: g === "working" && v.stale,
      ended: g === "ended",
      canTranscript: v.capabilities.transcript,
      canKill: v.capabilities.kill,
      canResume: v.capabilities.resume,
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
    providerCounts,
    providerFilter,
    health,
    emptyMessage,
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
    present.add(v.key);
    const g = groupOf(v);
    const prev = lastSeen.get(v.key);
    lastSeen.set(v.key, g);

    // A provider may deliver its first snapshot after the panel's first paint.
    // Seed that row silently: only a transition from a state we have actually
    // observed should notify.
    if (!firstPaintDone || prev === undefined) continue;
    if (prev === g) continue;

    if (g === "limited" && notifyLimited) {
      const reset = v.resetText ? ` (reset ${v.resetText})` : "";
      toast("error", `🔴 ${providerLabel(v.provider)} limited: "${truncate(v.title, 48)}" · ${v.sub}${reset}`, v);
      nativeNotify(c, `${providerLabel(v.provider)}: limited`, `${truncate(v.title, 48)} · ${v.sub}${reset}`);
    } else if (g === "waiting" && notifyWaiting) {
      const msg = v.notifMessage ? ` · ${truncate(v.notifMessage, 60)}` : "";
      toast("warn", `🟡 ${providerLabel(v.provider)} waiting: "${truncate(v.title, 48)}"${msg}`, v);
      nativeNotify(c, `${providerLabel(v.provider)}: waiting for you`, `${truncate(v.title, 48)}${msg}`);
    } else if (g === "done" && notifyDone) {
      toast("info", `🔵 ${providerLabel(v.provider)} — your turn: "${truncate(v.title, 48)}"`, v);
    }
  }
  for (const id of [...lastSeen.keys()]) if (!present.has(id)) lastSeen.delete(id);
}

function checkStuck(
  views: SessionView[],
  stuckNotified: Set<string>,
  c: vscode.WorkspaceConfiguration,
  cache: Map<number, ResStat>,
  seenBefore: ReadonlyMap<string, GroupKey>,
): void {
  const mins = c.get<number>("stuckAlertMinutes", 5);
  if (mins <= 0) return;
  const now = Date.now() / 1000;
  const present = new Set<string>();
  for (const v of views) {
    present.add(v.key);
    if (groupOf(v) === "working") {
      // A silent transcript with real CPU load means "still computing", not stuck.
      const r = freshRes(v, cache);
      const cpuBusy = !!r && r.cpu >= 5;
      const age = v.lastActivityMs ? now - v.lastActivityMs / 1000 : 0;
      if (age > mins * 60 && !cpuBusy) {
        // When a provider's first asynchronous snapshot is already stale,
        // remember it without producing a startup alert. Once it becomes
        // active/non-working the sentinel is cleared, so a later real crossing
        // of the threshold can still notify.
        if (!seenBefore.has(v.key)) {
          stuckNotified.add(v.key);
          continue;
        }
        if (!stuckNotified.has(v.key)) {
          stuckNotified.add(v.key);
          const msg = `${truncate(v.title, 48)} · ${Math.round(age / 60)}m silent`;
          vscode.window.showWarningMessage(`⚠️ Possibly stuck: ${msg}`, "Show").then((ch) => {
            if (ch === "Show") vscode.commands.executeCommand("claudeSessionMonitor.focus");
          });
          nativeNotify(c, `${providerLabel(v.provider)}: possibly stuck`, msg);
        }
      } else {
        stuckNotified.delete(v.key);
      }
    } else {
      stuckNotified.delete(v.key);
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
    writePrivateTextAtomic(MONITOR_DIR + "/tabs-debug.json", JSON.stringify(dbg, null, 2));
  } catch {
    /* ignore */
  }
}

/** Every cleaned title candidate for `v`, falling back to just its title. */
function matchCandidates(v: SessionView): string[] {
  return v.matchLabels?.length ? v.matchLabels : [v.title];
}

async function jumpToSession(v: SessionView): Promise<void> {
  const dbg: any = {
    ts: new Date().toISOString(),
    provider: v.provider,
    title: v.title,
    groups: [],
    matched: null,
    action: null,
    error: null,
  };
  const candidates = matchCandidates(v);
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
      const ti = tabs.findIndex((t) => t.label && candidates.some((c) => labelsMatch(t.label, c)));
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
    dbg.action = "no-match -> prompt";
  } catch (e) {
    dbg.error = String(e);
  }
  writeTabDebug(dbg);
  await promptNoTabMatch(v);
}

/**
 * No open tab matched this session's title. Rather than silently opening the
 * (possibly huge) transcript file, ask what to do: open it anyway, resume the
 * session in a fresh terminal, or just copy its id.
 */
async function promptNoTabMatch(v: SessionView): Promise<void> {
  let canOpenCodex = false;
  if (v.provider === "codex") {
    try {
      canOpenCodex = (await vscode.commands.getCommands(true)).includes("chatgpt.openSidebar");
    } catch {
      canOpenCodex = false;
    }
  }
  const choices =
    v.provider === "codex"
      ? [
          ...(canOpenCodex ? ["Open Codex"] : []),
          "Resume in Terminal",
          "Open Transcript",
          "Copy ID",
        ]
      : ["Open Transcript", "Resume in Terminal", "Copy ID"];
  const choice = await vscode.window.showInformationMessage(
    `Session "${truncate(v.title, 60)}" has no open tab in this window.`,
    ...choices,
  );
  if (choice === "Open Codex") {
    try {
      await vscode.commands.executeCommand("chatgpt.openSidebar");
    } catch {
      vscode.window.showWarningMessage(
        "The Codex sidebar command is unavailable. Resume this session in a terminal instead.",
      );
    }
  } else if (choice === "Open Transcript") {
    openTranscript(v);
  } else if (choice === "Resume in Terminal") {
    resumeInTerminal(v);
  } else if (choice === "Copy ID") {
    await vscode.env.clipboard.writeText(v.sessionId);
    vscode.window.setStatusBarMessage(`Copied session id ${v.sessionId.slice(0, 8)}…`, 3000);
  }
}

/** Normalize a command argument to a SessionView (undefined when absent/foreign). */
function asView(arg?: SessionView): SessionView | undefined {
  if (!arg || typeof arg.sessionId !== "string" || !arg.sessionId.trim()) return undefined;
  const provider: AgentProvider = arg.provider === "codex" ? "codex" : "claude";
  return {
    ...arg,
    provider,
    key: typeof arg.key === "string" && arg.key ? arg.key : sessionKey(provider, arg.sessionId),
    capabilities: {
      ...defaultCapabilities(provider),
      ...(arg.capabilities ?? {}),
    },
  };
}

function resumeInTerminal(arg: SessionView): void {
  const v = asView(arg);
  if (!v || !v.capabilities.resume) {
    vscode.window.showWarningMessage("This provider cannot resume the selected session.");
    return;
  }
  const codexExecutable =
    vscode.workspace
      .getConfiguration("claudeSessionMonitor")
      .get<string>("codexExecutable", "codex")
      .trim() || "codex";
  // Launch the provider directly instead of composing text for the user's
  // configured terminal shell. This is safe for paths/ids containing quoting
  // characters and works consistently across POSIX shells, PowerShell and cmd.
  const term = vscode.window.createTerminal({
    name: `${providerLabel(v.provider)} · ${truncate(v.title, 32)}`,
    cwd: v.cwd,
    shellPath: v.provider === "codex" ? codexExecutable : "claude",
    shellArgs:
      v.provider === "codex"
        ? ["resume", v.sessionId]
        : ["--resume", v.sessionId],
  });
  term.show();
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

interface CancelableDebounced {
  (): void;
  cancel(): void;
}

function debounce(fn: () => void, ms: number): CancelableDebounced {
  let t: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (() => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = undefined;
      fn();
    }, ms);
  }) as CancelableDebounced;
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = undefined;
  };
  return wrapped;
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

/**
 * Types `text` into the focused element and presses Return, via System Events.
 * `submitDelayMs` (default 150) is the pause between the keystroke and Return —
 * slash commands (e.g. "/model ...") pop an autocomplete widget, so callers
 * that type one should pass a longer delay (500ms) to let it settle first.
 */
function typeAndSubmit(text: string, submitDelayMs = 150): Promise<{ ok: boolean; err?: string }> {
  return new Promise((res) => {
    const delaySec = (Math.max(0, submitDelayMs) / 1000).toString();
    const lines = ['tell application "System Events"', `keystroke ${appleStr(text)}`, `delay ${delaySec}`, "key code 36", "end tell"];
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
    writePrivateTextAtomic(file, JSON.stringify(dbg, null, 2));
  } catch {
    /* ignore */
  }
  return dbg.groups.reduce((n: number, g: any) => n + g.tabs.length, 0);
}
