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
import { SWITCH_CLI, SWITCH_PANEL_FILE, SWITCH_STATE_DIR, allBadges, readQuotaEngine, displayNames, excludedEmails, excludedOf, headerChip, installedPanel, mergePanelAccounts, orderCards, panelFresh, poolSummary, readPanel, renderSwitchBlock, renderSwitchActivity, headerGauges, switchInstalled, useTargets, type CardHeader, type PoolSummary } from "./switchPanel";
import { gaugeColumn } from "./compact";
import { calibrate } from "./burn";
import { BURN_WINDOWS, DEFAULT_BURN_WINDOW_MS, buildBurnPayload, burnShares, gaugeSamplesFromHistory, resolveScale, type BurnPayload } from "./burnPayload";
import { BurnTracker } from "./burnTracker";
import { ViewPoster } from "./viewPost";
import { TYPED_REASON, deliverText, registerRemoteBridge, remoteCwdRoots, remoteFlag, type CommandOutcome, type FleetCommand, type PathAttempt, type RemoteBridge } from "./remoteBridge";
import { runTool } from "./remote";
import { sanitizeRemoteLine } from "./remoteInput";
import { TIMED_OUT, canStart, nodeForwardDeps } from "./remoteForward";
import { backgroundByDue, fmtClock, timingNote } from "./closingBuckets";
import { resolveClaudeBinary } from "./claudeBinary";
import { stageGuard } from "./safeStage";
import { DebugLog } from "./debugLog";
import { readIfThere, saveErrors } from "./errorRegistry";
import { SUMMARY_EVERY_SEC, SessionDrops, liveKeys, sessionSummary } from "./sessionLog";
import { BusyClock, DurationRing, HEALTH_EVERY_MS, removeHealth, writeHealth, type HealthDeps } from "./health";
import { OverseerBeat, nodeBeatDeps, overseerBin } from "./overseerBeat";
import { REFRESH_GAP_MS, codexSignature, monitorEventMatters, projectsEventMatters, singleFlight, throttle } from "./refreshGate";
import { SessionCollector } from "./sessionCollector";
import { sendToSession } from "./peerSend";
import { activeName, alreadyActive, markActive, newerUsage, panelActive, pickActive, snapshotAccount, usageForActive, useOutcome, useStartMs, USE_STUCK_MS, type ActiveCandidate } from "./activeAccount";
import { SwitchRunner, busyText, exitText, lastLine, spawnFailureText } from "./switchRunner";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { parseParentPid, pickSessionTerminal, pickUniqueLabel, type TerminalCandidate } from "./terminalMatch";
import { ResumeRegistry, isClaudeCliCommand, isClaudeSessionCommand } from "./resumeRegistry";
import { allowedCwds, mergeSeen, withoutPaths } from "./remoteCwds";
import { startNewSession } from "./remoteNewSession";
import { startNewTab, type NewTabDeps } from "./remoteNewTab";
import { buildSeedBlob, decidePassiveSource, keeperWaiting, readCliVault, shouldSeed, writeCliVault } from "./cliVault";
import { OPEN_COMMAND, TabWaker, nodeProbes, ownSessions, readLiveSessions, readParentPids, summaryText } from "./wakeTabs";
import { ContinuityServer, continuityDir, readText, storageDir, windowKey, writeTextAtomic } from "./continuity";
import { focusGroupBySlot, revealTabByIndex, type TabFocusDeps } from "./tabFocus";
import { OTHER_PROJECT, projectOf, readProjectRules } from "./projects";
import { OVERRIDES_KEY, limitedToResume, readOverrides, rowAutoResume, settledOverrides, sweepQueue, withOverride } from "./autoResume";
import { submitAnswer } from "./answers";
import { nothingTyped, typeIntoPrompt, type TypeResult } from "./keystrokeTyping";
import { FOCUS_COMMAND, FOCUS_SETTLE_MS, focusCommandBlocker, typingLine, waitForActive } from "./promptFocus";
import { acquireSwitchLock, autoRotateOn, remoteSwitch as routeRemoteSwitch } from "./accountSwitch";
import { activateRestartGuard } from "./restartGuard";
import { observerMode } from "./observerMode";
import { AutomationGate, CLAUDE_CODE_ID, readPulseStage, type Automation } from "./automationGate";
import {
  KIND_LABEL,
  RESET_KINDS,
  accountView,
  claimReset,
  claimUnresolved,
  cliUserAgent,
  describeClaim,
  fmtUseBy,
  parseCedarEmber,
  parseResetsFile,
  pickGrant,
  refillText,
  resetsFilePath,
  resetsFileText,
  resetsTotal,
  summarize,
  usageRequest,
  withResetsLeft,
  type CedarEmber,
  type ResetGrant,
  type ResetKind,
  type ResetsEntry,
  type ResetsFetch,
  type ResetsPayload,
  type UsageFail,
} from "./resets";
import {
  KEYCHAIN_SERVICE,
  REFRESH_MARGIN_MS,
  needsRefresh,
  parseJsonObject,
  performSwitch,
  pickBestAccount,
  refreshOAuth,
  remainingSummary,
  shouldAutoRotate,
  vaultIdentKey,
  vaultOauthKey,
  type FetchLike,
  type OAuthBlob,
  type SwitchDeps,
} from "./rotation";
import {
  CAPTURE_MOVE_SETTLE_MS,
  CAPTURE_SETTLE_MS,
  classifyIdentityChange,
  decideCapture,
  refreshBlocked,
  settleCapture,
  tokenFingerprint,
  withoutNeedsLogin,
  type PendingCapture,
} from "./capture";
import {
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
  type AccountInfo,
  type AccountsFile,
  type SessionView,
  type RecentTranscript,
  type TokenUsage,
  pidAlive,
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
  type ClosingKind,
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
  claudePlanLabel,
  planPrice,
  claudePlanTier,
  codexPlanLabel,
  filterHistoryForAccount,
  topSessionRows,
  labelsMatchStrict,
  type AccountView,
  type SessionTokenRow,
  type BurnEta,
  type GroupKey,
  type OfficialGauge,
} from "./view";

/** The debug log, ~/.claude/session-monitor/csm-debug.log: one JSON line per message, from every window (debugLog.ts). */
const LOG_FILE = `${MONITOR_DIR}/csm-debug.log`;
const debugLog = new DebugLog({ file: LOG_FILE, pid: process.pid, lock: (file) => acquireSwitchLock(file) });
/** The windows' health files (health.ts) and errors.json (errorRegistry.ts). */
const HEALTH_DIR = path.join(MONITOR_DIR, "health");
const ERRORS_FILE = path.join(HEALTH_DIR, "errors.json");

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

let logSink: ((msg: string) => void) | undefined; // observer mode (observerMode.ts): this window's Output channel instead of the shared file

/** Observer mode's log: a dev host never writes the shared csm-debug.log, it logs to an Output channel of its own. */
function observerLog(ctx: vscode.ExtensionContext): (msg: string) => void {
  const channel = vscode.window.createOutputChannel("Agent Session Monitor (observer)", { log: true });
  const sink = (msg: string): void => channel.info(msg);
  ctx.subscriptions.push(channel, {
    dispose: () => {
      if (logSink === sink) logSink = undefined;
    },
  });
  return sink;
}

/** Appends one line to the debug log (best-effort, for diagnosis); `feature` names it when the first word does not (debugLog.ts). */
function log(msg: string, feature?: string): void {
  if (logSink) return logSink(msg);
  debugLog.write(msg, feature);
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
  project: string; // project tag ("" when no project rules are set or none matched)
  projectIdx: number; // the tag's color slot (-1: none)
  cpu: number | null;
  rssMb: number | null;
  cpuHog: boolean;
  stale: boolean; // "working" but silent — warning tint on the state dot
  closing: "" | ClosingKind; // "your turn" closing status line, replaces the dot ("" when none)
  closingText: string; // text after the closing emoji ("" when none)
  due: string; // ⏳ finish clock, e.g. "06:15" ("" when none)
  late: string; // ⏳ past its finish time: the warning ("" when on time)
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
  projects: ProjectStrip | null; // null when no project rules are set
  health: ProviderHealth[];
  emptyMessage: string;
}

/** The project filter strip: rule names in order, sessions per project (and "other"), the active filter. */
interface ProjectStrip {
  names: string[];
  counts: Record<string, number>;
  filter: string; // "all", a rule name or "other"
}

class SessionsView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly poster = new ViewPoster(); // a changed payload only, while the view shows (viewPost.ts)

  constructor(private readonly onAction: (action: string, sessionId: string) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = sessionsHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m && typeof m.type === "string" && typeof m.id === "string") this.onAction(m.type, m.id);
    });
    this.poster.attach(view);
  }

  update(payload: SessionsPayload): void {
    this.poster.post(payload);
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
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Top strip: provider filter on the left, machine totals on the right. */
  .top { display:flex; align-items:center; gap:4px; padding:5px 12px 3px; }
  .pfilter { border:0; background:transparent; color:var(--vscode-descriptionForeground); border-radius:999px;
    padding:2px 8px; font:inherit; font-size:11px; cursor:pointer; }
  .pfilter:hover { color:var(--vscode-foreground); }
  .pfilter.active { color:var(--vscode-foreground); background:var(--vscode-badge-background, rgba(127,127,127,.25)); }
  .projrow { flex-wrap:wrap; padding-top:0; }
  .pfilter.proj.active, .ptag { color:var(--pc, var(--vscode-foreground)); }
  .ptag { font-weight:600; }
  .totals { margin-left:auto; font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .health { padding:2px 12px 6px; color:var(--vscode-descriptionForeground); font-size:10px; line-height:1.4; }
  /* Group header: quiet label + count; a chevron only when it is collapsible. */
  .ghead { display:flex; align-items:center; gap:6px; width:100%; padding:7px 12px 2px; border:0; background:transparent;
    color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; font-weight:600; text-transform:uppercase;
    letter-spacing:.08em; text-align:left; cursor:default; }
  .ghead.fold { cursor:pointer; }
  .ghead.fold:hover { color: var(--vscode-foreground); }
  .ghead .n { font-weight:400; opacity:.7; }
  .ghead .chev { margin-left:auto; font-size:9px; opacity:.6; }
  /* Row = one line: state dot · title (model · dir muted inline) · tokens · age
     (actions replace the age on hover). The hairline under the row is this chat's
     share of the machine's 5h total — who is eating the limit reads as geometry.
     Kept to one line so the list stays short; the usage view below is the main event. */
  .row { position:relative; display:grid; grid-template-columns: 14px minmax(0,1fr) auto auto;
    column-gap:8px; align-items:center; padding:3px 12px 4px; cursor:pointer; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
  .row:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
  .row.ended { opacity: .5; }
  .dot { grid-row:1; justify-self:center; width:7px; height:7px; border-radius:50%; }
  .dot.stale { box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-yellow, #e6b800) 35%, transparent); }
  .mark { grid-row:1; justify-self:center; font-size:11px; line-height:1; }
  .mark.late { border-radius:50%; box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-charts-red, #f14c4c) 60%, transparent); }
  .title { grid-row:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .right { grid-row:1; display:flex; align-items:center; gap:2px; color: var(--vscode-descriptionForeground); }
  .meta { font-size:11px; color: var(--vscode-descriptionForeground); }
  .meta .sub { color: var(--vscode-foreground); opacity:.85; }
  .meta .hot { color: var(--vscode-charts-red, #f14c4c); }
  .tok { grid-row:1; color: var(--vscode-descriptionForeground); }
  .tok b { font-weight:500; color: var(--vscode-foreground); }
  .tokbar { position:absolute; left:12px; bottom:0; height:2px; border-radius:1px;
    background: var(--vscode-charts-blue, #3794ff); opacity:.4; }
  .tokbar.hog { background: var(--vscode-charts-yellow, #e6b800); opacity:.9; }
  .acts { display:none; gap:2px; }
  .row:hover .acts, .row:focus-within .acts { display:flex; }
  .row:hover .age, .row:focus-within .age { display:none; }
  .act { border:0; background:transparent; color: var(--vscode-descriptionForeground);
    cursor:pointer; font-size:11px; line-height:1; padding:2px 4px; border-radius:3px; }
  .act:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.25)); color: var(--vscode-foreground); }
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
  background: 'var(--vscode-charts-purple, #b180d7)',
  working: 'var(--vscode-charts-green, #4caf50)',
  ended: 'var(--vscode-disabledForeground, #888)',
  unknown: 'var(--vscode-disabledForeground, #888)'
};
const MARK = { done:'✅', pending:'⏳', blocked:'🟡' };
const MARK_LABEL = { done:'done, safe to close', pending:'waiting on a background job', blocked:'needs your decision' };
// Ended and unknown sessions are the long tail; they fold to one line by default.
const FOLDABLE = { ended:true, unknown:true };
const saved = vscodeApi.getState() || {};
let folded = saved.folded || { ended:true, unknown:true };
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
function fmtMb(mb){ return mb >= 1024 ? (mb/1024).toFixed(1)+'GB' : mb+'MB'; }
const PCOLOR = ['var(--vscode-charts-blue)','var(--vscode-charts-orange)','var(--vscode-charts-green)','var(--vscode-charts-purple)','var(--vscode-charts-yellow)','var(--vscode-charts-red)'];
function projectStrip(p){
  if(!p) return '';
  const chip = (key, label, i, n) => '<button class="pfilter proj'+(p.filter===key?' active':'')+'" data-project="'+esc(key)+'" aria-pressed="'+(p.filter===key)+'"'
    + (i>=0?' style="--pc:'+PCOLOR[i % PCOLOR.length]+'"':'')+'>'+esc(label)+' '+n+'</button>';
  let total = 0;
  for(const k in p.counts) total += p.counts[k];
  return '<div class="top projrow" role="toolbar" aria-label="Session project filter" data-testid="csm-project-filter">'
    + chip('all','All projects',-1,total)
    + p.names.map((n,i)=>chip(n,n,i,p.counts[n]||0)).join('')
    + chip('other','other',-1,p.counts.other||0)
    + '</div>';
}
function metaLine(r){
  const bits = [];
  const due = r.due ? 'bitiş '+r.due : '';
  if(r.late) bits.push('<span class="hot">'+esc(due ? 'late · '+due : 'late')+'</span>');
  const extra = [r.late ? '' : due, r.sub, r.reset ? ('reset '+r.reset) : ''].filter(Boolean).join(' · ');
  if(extra) bits.push('<span class="sub">'+esc(extra)+'</span>');
  if(r.model) bits.push(esc(r.model)+(r.effort?' · '+esc(r.effort):''));
  else bits.push(esc(r.providerLabel));
  if(r.project) bits.push('<span class="ptag" style="--pc:'+PCOLOR[r.projectIdx % PCOLOR.length]+'">'+esc(r.project)+'</span>');
  else if(r.dir) bits.push(esc(r.dir));
  if(r.cpuHog && r.cpu!=null) bits.push('<span class="hot">cpu '+r.cpu+'%</span>');
  if(r.rssMb!=null && r.rssMb>=1024) bits.push(esc(fmtMb(r.rssMb)));
  return bits.join(' · ');
}
function rowHtml(r, gkey){
  const meta = metaLine(r);
  const acts = (r.canTranscript?'<button class="act" data-act="transcript" title="Open transcript" aria-label="Open transcript">▤</button>':'')
    + (r.ended
        ? '<button class="act" data-act="remove" title="Remove from list" aria-label="Remove from list">✕</button>'
        : (r.canKill
            ? '<button class="act" data-act="kill" title="Kill process (SIGTERM)" aria-label="Kill process">⊘</button>'
            : (r.canResume?'<button class="act" data-act="resume" title="Resume in terminal" aria-label="Resume in terminal">↻</button>':'')));
  return '<div class="row'+(r.ended?' ended':'')+'" role="row" tabindex="0" data-id="'+esc(r.id)+'" title="'+esc(r.tip)+'">'
    + (r.closing
        ? '<span class="mark'+(r.late?' late':'')+'" role="img" aria-label="'+(r.late?esc(r.late):MARK_LABEL[r.closing])+'" title="'+esc((r.late?r.late+' · ':'')+MARK[r.closing]+' '+r.closingText)+'">'+MARK[r.closing]+'</span>'
        : '<span class="dot'+(r.stale?' stale':'')+'" style="background:'+GCOLOR[gkey]+'"></span>')
    + '<span class="title">'+esc(r.title)+(meta?' <span class="meta">· '+meta+'</span>':'')+'</span>'
    + '<span class="tok num">'+(r.tokens ? '<b>'+esc(r.tokens)+'</b>'+(r.share>=1?' · '+r.share+'%':'') : '')+'</span>'
    + '<span class="right"><span class="num age" data-last="'+r.lastMs+'">'+fmtAge(r.lastMs)+'</span><span class="acts">'+acts+'</span></span>'
    + (r.tokens?'<i class="tokbar'+(r.hog?' hog':'')+'" style="width:calc((100% - 24px) * '+Math.min(100,Math.max(2,r.share))/100+')"></i>':'')
    + '</div>';
}
function render(){
  if(!last) return;
  const root = document.getElementById('root');
  let h = '';
  const enabled = new Set((last.health||[]).map(x=>x.provider));
  const pf = last.providerFilter || 'all';
  const pill = (key, label, n) => '<button class="pfilter'+(pf===key?' active':'')+'" data-provider="'+key+'" aria-pressed="'+(pf===key)+'">'+label+' '+n+'</button>';
  const totals = [];
  if(last.totalCpu != null) totals.push('CPU '+last.totalCpu+'%');
  if(last.totalRss != null) totals.push(esc(fmtMb(last.totalRss)));
  if(last.filter) totals.push('⧩ '+esc(last.filter));
  h += '<div class="top" role="toolbar" aria-label="Session provider filter">'
    + pill('all','All',last.providerCounts.all)
    + (enabled.has('claude')?pill('claude','Claude',last.providerCounts.claude):'')
    + (enabled.has('codex')?pill('codex','Codex',last.providerCounts.codex):'')
    + (totals.length?'<span class="totals num">'+totals.join(' · ')+'</span>':'')
    + '</div>';
  h += projectStrip(last.projects);
  const health = (last.health||[]).filter(x=>x.state!=='ready' && x.message);
  if(health.length) h += '<div class="health">'+health.map(x=>'<div><b>'+esc(x.provider==='codex'?'Codex':'Claude')+':</b> '+esc(x.message)+'</div>').join('')+'</div>';
  if(!last.groups.length){
    h += '<div class="empty">'+esc(last.emptyMessage || 'No recent agent sessions.')+'</div>';
    root.innerHTML = h;
    return;
  }
  for(const g of last.groups){
    const fold = !!FOLDABLE[g.key];
    const closed = fold && folded[g.key];
    h += (fold?'<button type="button" class="ghead fold" data-group="'+g.key+'" aria-expanded="'+(!closed)+'">':'<div class="ghead">')
      + esc(g.label)+' <span class="n">'+g.count+'</span>'
      + (fold?'<span class="chev">'+(closed?'▸':'▾')+'</span>':'')
      + (fold?'</button>':'</div>');
    if(closed) continue;
    for(const r of g.rows) h += rowHtml(r, g.key);
  }
  root.innerHTML = h;
}
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget && !(el.classList && (el.classList.contains('pfilter') || el.classList.contains('act') || el.classList.contains('row') || el.classList.contains('fold')))) el = el.parentElement;
  if(!el || el === ev.currentTarget) return;
  if(el.classList.contains('pfilter')){
    if(el.dataset.project) vscodeApi.postMessage({ type: 'filterProject', id: el.dataset.project });
    else vscodeApi.postMessage({ type: 'filterProvider', id: el.dataset.provider });
    return;
  }
  if(el.classList.contains('fold')){
    folded[el.dataset.group] = !folded[el.dataset.group];
    vscodeApi.setState({ folded });
    render();
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
  plan: string | null; // "$200 Max", "$100 Pro Lite"… (planLabels setting or detected tier)
  active: boolean; // Claude: this account is the current login (green dot)
  ts: number | null;
  official: boolean;
  gauges: Gauge[];
  note: string | null;
  sevenDayTokens: number | null;
  lifetimeTokens: number | null;
  accountId?: string; // Claude account card: clicking its name switches Claude Code to it
  best?: boolean; // Claude account card: the account with the most headroom
  cols?: { session?: Gauge; weekly?: Gauge; fable?: Gauge }; // grid cells (see compact.ts)
  loginNeeded?: boolean; // note says the token is expired/revoked
  email?: string; // Claude account card: the login email (label may be shortened)
  hdr?: CardHeader; // one-line collapsible header (claude-switch panel fresh)
}

/** Add grid cells and the login flag to every card. */
function decorateCards(providers: UsageProviderCard[]): UsageProviderCard[] {
  return providers.map((p) => {
    const cols: NonNullable<UsageProviderCard["cols"]> = {};
    for (const g of p.official ? p.gauges : []) {
      const c = gaugeColumn(g.key);
      if (c && !cols[c]) cols[c] = g;
    }
    return { ...p, cols, loginNeeded: /^token (expired|revoked)/.test(p.note ?? "") };
  });
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
  switchHtml?: string; // claude-switch status lines, rendered host-side by switchPanel.ts
  switchActivity?: { count: number; html: string }; // Activity tab: claude-switch's latest events (fresh panel only)
  switchBadges?: Record<string, { rank?: number; loginNeeded?: string }>; // by account email
  showTokenStats?: boolean; // render the Tokens row + Models block (claudeSessionMonitor.showTokenStats)
  panelFresh?: boolean; // claude-switch owns switching: simplified cards, no Rotate
  pool?: PoolSummary; // the table's "all accounts" row (fresh panel, 2+ Claude logins)
  ui?: { tab: LimitsTab; expandedAccounts: Record<string, boolean> }; // persisted in workspaceState
  useEmails?: string[]; // non-active accounts the panel can switch to
  usePending?: string; // email `claude-switch use` is switching to right now (until it exits or the 90 s UI timeout)
  useResult?: { email: string; at: number; ok: boolean; text: string; running?: boolean }; // last finished `use` (at = its click time), shown for a few seconds; running: past the UI timeout, until it exits
  skipFailed?: { email: string; at: number }; // last skip box change claude-switch did not apply (at = its click time): the webview drops its optimistic state
  resets?: ResetsPayload; // Resets tab (claude-switch installed only)
  burnOn?: boolean; // Burn tab (Claude enabled): there before its first ranking arrives
}

/** The Usage Limits view's bottom tabs; Burn needs Claude, Resets and Activity need claude-switch. */
const LIMITS_TABS = ["accounts", "burn", "resets", "activity"] as const;
type LimitsTab = (typeof LIMITS_TABS)[number];
const isLimitsTab = (v: unknown): v is LimitsTab => (LIMITS_TABS as readonly unknown[]).includes(v);

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
  tier?: string; // claudePlanTier(): subscriptionType for Team/Enterprise, else rateLimitTier — used only for the plan label
  oauth?: OAuthBlob; // the whole claudeAiOauth object (vaulted for account rotation)
}

// The keychain read spawns a `security` subprocess; with a 10s usage poll that
// would be constant churn, so the credentials are cached and invalidated on 401/403
// (captureActiveLogin also replaces them with each of its fresh reads).
const TOKEN_TTL_SEC = 300;
// No countdown: it froze between panel pushes. Each card shows its reading's age instead (webview readingOld).
const RATE_LIMITED_NOTE = "usage API rate-limited — showing the last successful read, retrying automatically";
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
          const tier = claudePlanTier(oauth.rateLimitTier, oauth.subscriptionType);
          resolve({ token, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : undefined, tier, oauth });
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
  block?: Record<string, unknown>; // the whole oauthAccount object (vaulted for account rotation)
}

let identityCache: { token: string; identity: ActiveIdentity | undefined } | undefined;

const CLAUDE_JSON = `${os.homedir()}/.claude.json`;

/** Parse oauthAccount out of ~/.claude.json (uncached: callers decide how often). */
async function readIdentityFile(): Promise<ActiveIdentity | undefined> {
  try {
    const raw = await fs.promises.readFile(CLAUDE_JSON, "utf8");
    const oa = JSON.parse(raw)?.oauthAccount;
    if (oa && typeof oa.accountUuid === "string" && oa.accountUuid && typeof oa.emailAddress === "string") {
      return { id: oa.accountUuid, email: oa.emailAddress, block: oa };
    }
  } catch {
    /* missing or unparsable — identity stays unknown */
  }
  return undefined;
}

let identityAt: { mtimeMs: number; identity: ActiveIdentity | undefined } | undefined;

/** readIdentityFile() memoized on the file's mtime: the capture loop and the active-login probe share one parse per change. */
async function readIdentityFileAt(mtimeMs: number): Promise<ActiveIdentity | undefined> {
  if (identityAt?.mtimeMs === mtimeMs) return identityAt.identity;
  const identity = await readIdentityFile();
  identityAt = { mtimeMs, identity };
  return identity;
}

async function readActiveIdentity(token: string): Promise<ActiveIdentity | undefined> {
  if (identityCache?.token === token) return identityCache.identity;
  const identity = await readIdentityFile();
  identityCache = { token, identity };
  return identity;
}

/** mtime of ~/.claude.json in ms (undefined when missing): the cheap per-tick login-change probe. */
async function claudeJsonMtimeMs(): Promise<number | undefined> {
  try {
    return (await fs.promises.stat(CLAUDE_JSON)).mtimeMs;
  } catch {
    return undefined;
  }
}

type UsageFetch =
  | { ok: true; usage: OfficialUsage; resets: CedarEmber | null } // resets: the cedar_ember block when the request asked for it (usageRequest)
  | { ok: false; status?: number; retryAfterSec?: number };

async function fetchOfficialUsage(req: { url: string; headers: Record<string, string> }): Promise<UsageFetch> {
  try {
    const res = await fetch(req.url, {
      headers: req.headers,
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
    return { ok: true, usage: { gauges, ts: Date.now() / 1000 }, resets: parseCedarEmber(p) };
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
  planLabels: Record<string, string> = {},
  showTokenStats = false,
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
  if (showTokenStats && tokens?.byModel7d) {
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
      const bestId = pickBestAccount(acctCtx.accounts)?.id;
      for (const a of acctCtx.accounts) {
        const isSel = a.id === acctCtx.selectedId;
        const aGauges = isSel ? gauges : a.gauges;
        const aOfficial = aGauges.some((g) => g.pct != null);
        let note: string | null;
        if (isSel) note = selectedNote;
        else if (keeperWaiting.has(a.id)) note = "waiting for claude-switch keeper";
        else if (a.needsLogin) note = "token revoked — log in with Claude Code once";
        else if (a.stale) note = "token expired — last-known data; log in with Claude Code once to refresh";
        else if (!aOfficial) note = "no usage data yet — appears after the first background fetch";
        else note = null;
        providers.push({
          id: `claude:${a.id}`,
          provider: "claude",
          label: `Claude · ${a.label}`,
          plan: a.plan,
          active: a.id === acctCtx.activeId,
          ts: isSel ? ts : a.ts,
          official: aOfficial,
          gauges: aGauges,
          note,
          sevenDayTokens: null,
          lifetimeTokens: null,
          accountId: a.id,
          best: a.id === bestId,
        });
      }
    } else {
      providers.push({
        id: "claude",
        provider: "claude",
        label: "Claude",
        plan: planLabels["claude"] ?? null,
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
      plan: planLabels["codex"] ?? codexPlanLabel(usage?.planType) ?? null,
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
  private readonly poster = new ViewPoster(); // the limits "update" and the Burn tab's "burn", each only when changed and shown (viewPost.ts)

  constructor(
    private readonly onRefresh: () => void,
    private readonly onSwitch: (accountId: string) => void,
    private readonly onRotate: () => void,
    private readonly onUse: (email: string, clickedAt?: number) => void,
    private readonly onUi: (key: string, value: unknown) => void,
    private readonly onExclude: (email: string, excluded: boolean, clickedAt?: number) => void,
    private readonly onUseReset: (key: string, clickedAt?: number) => void,
    private readonly onBurn: (action: "open" | "window", value: string) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = limitsHtml();
    view.webview.onDidReceiveMessage((m) => {
      if (m && m.type === "refresh") this.onRefresh();
      else if (m && m.type === "switchAccount" && typeof m.id === "string") this.onSwitch(m.id);
      else if (m && m.type === "rotateBest") this.onRotate();
      else if (m && m.type === "useAccount" && typeof m.email === "string") this.onUse(m.email, typeof m.at === "number" ? m.at : undefined);
      else if (m && m.type === "setUi" && typeof m.key === "string") this.onUi(m.key, m.value);
      else if (m && m.type === "setExcluded" && typeof m.email === "string" && typeof m.excluded === "boolean") this.onExclude(m.email, m.excluded, typeof m.at === "number" ? m.at : undefined);
      else if (m && m.type === "useReset" && typeof m.key === "string") this.onUseReset(m.key, typeof m.at === "number" ? m.at : undefined);
      else if (m && m.type === "burnWindow" && typeof m.ms === "number" && Number.isFinite(m.ms) && m.ms > 0) this.onBurn("window", String(m.ms));
      else if (m && m.type === "openSession" && typeof m.id === "string" && m.id !== "") this.onBurn("open", m.id);
    });
    this.poster.attach(view);
  }

  update(payload: LimitsPayload): void {
    this.poster.post(payload);
  }

  /** The Burn tab's ranking, every few seconds; posted as type "burn" beside the limits "update". */
  updateBurn(payload: BurnPayload): void {
    this.poster.post({ ...payload, type: "burn" });
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
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 8px 12px 6px; margin: 0; }
  .empty { color: var(--vscode-descriptionForeground); padding: 6px 0; line-height:1.5; }
  .num { font-family: var(--vscode-editor-font-family, monospace); font-size:11px; font-variant-numeric: tabular-nums; }
  /* One card per login/provider, separated by a hairline. Each window is a row:
     label · monochrome 4px bar · used% · reset countdown. The bar is foreground
     at half opacity; color appears only as pressure (used% amber from 70%, bar
     and used% red from 90%), so a healthy card carries no color at all. */
  .card { padding:10px 0 12px; border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25)); }
  .card:first-child { padding-top:2px; border-top:0; }
  .chead { display:flex; align-items:baseline; gap:6px; margin-bottom:7px; min-width:0; }
  .bar { display:grid; grid-template-columns: 92px minmax(0,1fr) 40px 56px; column-gap:10px; align-items:center; margin:3px 0; }
  .bar .l { font-size:11px; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .bar .t { height:4px; border-radius:2px; overflow:hidden; background: var(--vscode-editorWidget-background, rgba(127,127,127,.2)); }
  .bar .t i { display:block; height:100%; border-radius:2px; background: var(--vscode-foreground); opacity:.5; }
  .bar .t i.bad { background: var(--vscode-charts-red, #f14c4c); opacity:1; }
  @media (prefers-reduced-motion: no-preference) { .bar .t i { transition: width .4s ease; } }
  .bar .p { text-align:right; font-weight:600; }
  .bar .r { text-align:right; font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .ctitle { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .cplan { color: var(--vscode-descriptionForeground); font-size:11px; white-space:nowrap; }
  .ctitle.sw { cursor:pointer; }
  .ctitle.sw:hover { text-decoration:underline; }
  .best { color: var(--vscode-charts-yellow, #e6b800); font-size:11px; }
  .cwarn { color: var(--vscode-charts-yellow, #e6b800); font-size:11px; cursor:help; }
  .swblock { padding:0 0 4px; margin-bottom:0; border-bottom:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25)); }
  .swline { font-size:11px; line-height:1.3; overflow-wrap:anywhere; }
  .swline.sw-hint, .swline.sw-info { color: var(--vscode-descriptionForeground); }
  .swline.sw-q-up { color: var(--vscode-charts-green); }
  .swline.sw-q-tight { color: var(--vscode-charts-orange); }
  .swline.sw-offline { color: var(--vscode-charts-yellow, #e6b800); }
  .swline.sw-error, .swline.sw-needsLogin { color: var(--vscode-descriptionForeground); }
  .swrank { color: var(--vscode-descriptionForeground); font-size:11px; }
  .clogin { color: var(--vscode-charts-red, #f14c4c); font-size:10px; font-weight:600; }
  .swline.sw-muted { color: var(--vscode-descriptionForeground); opacity:.7; }
  .swevents { padding-top:4px; }
  /* Resets tab: per account its name line, then a line per kind with Use or why not. */
  .rsblock { padding:0 0 4px; }
  .rsacct { margin-top:5px; }
  .rsname { display:flex; align-items:baseline; gap:6px; min-width:0; font-size:11px; }
  .rsnote { min-width:0; font-size:10px; color: var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rsrow { display:flex; align-items:baseline; gap:8px; min-width:0; margin:2px 0 0 10px; font-size:11px; }
  .rsrow .rsk { flex:none; white-space:nowrap; }
  .rsrow .rsd, .rsrow .rsact { min-width:0; font-size:10px; color: var(--vscode-descriptionForeground); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rsrow .rsact, .rsrow .useacct { margin:0 0 0 auto; }
  .rsrow .useacct { flex:none; }
  .rsnone { margin:2px 0 0 10px; font-size:10px; color: var(--vscode-descriptionForeground); }
  /* Section tabs pinned to the bottom of the view: equal-width boxed buttons, the selected one filled like a primary
     button, counts in badges; the spacer keeps the last line above them. */
  .ltabs { position:fixed; left:0; right:0; bottom:0; display:flex; gap:4px; padding:6px 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.35)); }
  .ltab { flex:1 1 0; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; height:26px; padding:0 6px;
    border:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.35)); border-radius:4px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.12));
    color: var(--vscode-foreground); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; }
  .ltab:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.2)); }
  .ltab:focus-visible { outline:1px solid var(--vscode-focusBorder, #007fd4); outline-offset:1px; }
  .ltab.active { background: var(--vscode-button-background, #0e639c); border-color: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); font-weight:600; }
  .ltab .tl { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .ltab .tn { flex:none; min-width:16px; padding:0 5px; border-radius:8px; font-size:10px; line-height:16px; text-align:center;
    background: var(--vscode-badge-background, rgba(127,127,127,.3)); color: var(--vscode-badge-foreground, inherit); }
  .ltab.active .tn { background: rgba(255,255,255,.25); color: inherit; }
  .ltabspace { height:44px; }
  /* Burn tab: window picker, headline, then per session two lines (rank · dot · title · rate · used, then the bar and the meta). */
  .bwins { display:flex; gap:2px; margin:6px 0 2px; padding:2px; border-radius:4px; background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  .bwin { flex:1; border:0; border-radius:3px; background:transparent; color:var(--vscode-descriptionForeground); padding:2px 0; font:inherit; font-size:11px; cursor:pointer; }
  .bwin:hover { color:var(--vscode-foreground); }
  .bwin[aria-pressed="true"] { color:var(--vscode-foreground); background:var(--vscode-badge-background, rgba(127,127,127,.25)); box-shadow: inset 0 0 0 1px var(--vscode-contrastActiveBorder, transparent); }
  .bwin:focus-visible { outline:1px solid var(--vscode-focusBorder, #007fd4); outline-offset:-1px; }
  .bhead { padding:6px 0 4px; font-weight:600; line-height:1.4; overflow-wrap:break-word; }
  .brow { display:grid; grid-template-columns: 16px 7px minmax(0,1fr) auto auto; column-gap:6px; row-gap:3px; align-items:center; margin:0 -12px; padding:4px 12px 5px; }
  .brow[data-open] { cursor:pointer; }
  .brow[data-open]:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
  .brow:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
  .brow.ended { opacity: .6; }
  .brank { text-align:right; color: var(--vscode-descriptionForeground); }
  .bdot { width:7px; height:7px; border-radius:50%; border:1px solid var(--vscode-descriptionForeground); opacity:.6; }
  .bdot.live { background: var(--vscode-charts-green, #89d185); border-color: var(--vscode-charts-green, #89d185); opacity:1; }
  .btitle { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .brate { font-weight:600; min-width:7ch; text-align:right; white-space:nowrap; }
  .bused { min-width:6ch; text-align:right; white-space:nowrap; color: var(--vscode-descriptionForeground); }
  .bl2 { grid-column: 3 / -1; display:flex; align-items:center; gap:6px; min-width:0; }
  .bbar { flex:0 0 30%; max-width:120px; height:3px; border-radius:2px; overflow:hidden; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
  .bfill { display:block; height:100%; background: var(--vscode-progressBar-background, #0e70c0); }
  .bmeta { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; color: var(--vscode-descriptionForeground); }
  .bmore { padding:3px 0; font-size:11px; color: var(--vscode-descriptionForeground); }
  .bnote { padding:8px 0 10px; font-size:10px; line-height:1.4; color: var(--vscode-descriptionForeground); }
  .bempty { padding:14px 0; color: var(--vscode-descriptionForeground); line-height:1.5; }
  /* Collapsed card = one table row: 16px line + 1px padding top and bottom + 1px hairline = 19px, so 25-30 logins fit. */
  .card.ccard { padding:1px 0; border-top:1px solid color-mix(in srgb, var(--vscode-editorWidget-border, rgba(127,127,127,.25)) 55%, transparent); }
  .card.ccard:first-child, .lhead + .card.ccard { border-top:0; }
  .card.ccard.act { background: color-mix(in srgb, var(--vscode-charts-green, #4caf50) 9%, transparent); border-radius:3px; }
  .card.ccard:not(.act) .chrow:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); border-radius:3px; }
  .chdr { display:flex; align-items:center; gap:6px; cursor:pointer; min-width:0; overflow:hidden; height:16px; line-height:16px; user-select:none; }
  .chdr { container-type:inline-size; }
  .chdr .ctitle { flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .chdr .chip { flex:none; }
  .chdr .cold { flex:none; font-size:10px; color: var(--vscode-charts-yellow, #cca700); white-space:nowrap; }
  .chdr .chev, .lhead .chev { color: var(--vscode-descriptionForeground); font-size:10px; width:10px; flex:none; }
  .ptag, .lhp { flex:none; width:36px; text-align:center; font-family: var(--vscode-editor-font-family, monospace); font-size:10px; font-weight:700; line-height:14px; border-radius:3px; }
  .ptag.phi { color: var(--vscode-charts-purple, #b180d7); background: color-mix(in srgb, var(--vscode-charts-purple, #b180d7) 20%, transparent); }
  .ptag.pmid { color: var(--vscode-charts-blue, #3794ff); background: color-mix(in srgb, var(--vscode-charts-blue, #3794ff) 18%, transparent); }
  .ptag.plo { color: var(--vscode-descriptionForeground); background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent); }
  .ptag.pnone { color: var(--vscode-descriptionForeground); font-weight:400; overflow:hidden; }
  .chdr .cgauges, .lhg { margin-left:auto; flex:none; display:flex; gap:6px; font-size:11px; white-space:nowrap; }
  .hg, .gnil, .lhc { width:76px; flex:none; display:flex; align-items:center; justify-content:flex-end; gap:4px; }
  .hg .gl, .hg .gs { display:none; }
  .hg.zero { color: var(--vscode-descriptionForeground); }
  .hg.warn { color: var(--vscode-charts-yellow, #cca700); }
  .hg.hot { color: var(--vscode-charts-red, #f14c4c); font-weight:600; }
  .hgb { order:-1; width:34px; height:3px; border-radius:2px; overflow:hidden; background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
  .hgb b { display:block; height:100%; background: currentColor; opacity:.75; }
  .hg.zero .hgb b { display:none; }
  .lhead { display:flex; align-items:center; gap:6px; height:15px; padding-bottom:1px; font-size:10px; color: var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25)); margin-top:4px; }
  .lhp { font-family: inherit; font-weight:400; }
  .lhn { flex:1; min-width:0; }
  .lhg { font-size:10px; }
  .lhc { justify-content:flex-end; }
  .lhs, .skipnil { flex:none; width:22px; text-align:center; }
  .card.ccard.rdy .chip { color: var(--vscode-charts-green, #4caf50); }
  .card.ccard.pool { border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.25)); margin-top:2px; padding-top:2px; font-weight:600; }
  .card.ccard.pool .chdr { cursor:default; }
  .card.ccard.pool .chip.prdy { color: var(--vscode-charts-green, #4caf50); }
  @media (max-width: 440px) { .hgb { display:none; } .hg, .gnil, .lhc { width:38px; } }
  .chip { font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .chip.login { color: var(--vscode-charts-red, #f14c4c); font-weight:600; }
  /* Skip box: outside the role=button header so it never toggles the card; an excluded header is dimmed. */
  .chrow { display:flex; align-items:center; gap:6px; min-width:0; }
  .chrow .chdr { flex:1; min-width:0; }
  .chdr.excl { opacity:.55; }
  .skipbox { flex:none; width:22px; justify-content:center; display:flex; align-items:center; gap:3px; font-size:10px; line-height:16px; color: var(--vscode-descriptionForeground); cursor:pointer; user-select:none; }
  .skipbox input { margin:0; width:11px; height:11px; cursor:pointer; accent-color: var(--vscode-checkbox-background, auto); }
  body.vscode-dark .skipbox input { color-scheme: dark; }
  .cbody { margin-top:4px; padding-bottom:4px; }
  .useacct { border:0; background:transparent; color: var(--vscode-textLink-foreground); font:inherit; font-size:11px; cursor:pointer; padding:0; margin-top:4px; }
  .useacct:hover { text-decoration:underline; }
  .useacct[disabled] { cursor:default; opacity:.6; text-decoration:none; }
  .useres { font-size:11px; line-height:1.3; margin:4px 0 2px; color: var(--vscode-descriptionForeground); overflow-wrap:anywhere; }
  .useres.err { color: var(--vscode-charts-red, #f14c4c); }
  .rot { display:flex; justify-content:flex-end; margin:0 0 2px; }
  .rot + .card { padding-top:2px; border-top:0; }
  .rotbtn { border:0; background:transparent; color: var(--vscode-textLink-foreground); font:inherit; font-size:11px; cursor:pointer; padding:0; }
  .rotbtn:hover { text-decoration:underline; }
  .adot { align-self:center; width:6px; height:6px; border-radius:50%; background:var(--vscode-charts-green,#4caf50); flex:none; }
  .cage { margin-left:auto; font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .eta { margin-top:2px; font-size:11px; color: var(--vscode-charts-red, #f14c4c); }
  .note { font-size:10px; line-height:1.4; color: var(--vscode-descriptionForeground); margin-top:2px; }
  .foot { display:flex; gap:8px; align-items:baseline; margin:4px 0 2px; font-size:11px; color: var(--vscode-descriptionForeground); }
  .foot .num { margin-left:auto; color: var(--vscode-foreground); }
  .sech { display:flex; align-items:baseline; gap:6px; width:100%; padding:6px 0 2px; border:0; background:transparent;
    color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; text-align:left; cursor:pointer; user-select:none; }
  .sech:hover { color: var(--vscode-foreground); }
  .chev { font-size:9px; width:9px; flex:none; }
  .hint { margin-left:auto; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:55%; }
  .mrow { display:flex; align-items:center; gap:8px; margin:4px 0; }
  .mname { width:84px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mbar { flex:1; height:2px; border-radius:1px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.2)); overflow:hidden; }
  .mfill { display:block; height:100%; background: var(--vscode-charts-blue, #3794ff); opacity:.6; }
  .mval { font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; }
  .hit { padding:5px 0; border-top:1px solid var(--vscode-editorWidget-border, rgba(127,127,127,.2)); font-size:11px; }
  .hitt { font-weight:600; }
</style>
</head>
<body>
  <div id="root"><div class="empty">Waiting for usage-limit data… (reload the window once so the status line starts reporting)</div></div>
<script nonce="${nonce}">
const vscodeApi = acquireVsCodeApi();
const C_OK = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-green') || '#4caf50';
const C_WARN = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-yellow') || '#e6b800';
const C_BAD = getComputedStyle(document.documentElement).getPropertyValue('--vscode-charts-red') || '#f14c4c';
let last = null;

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Pressure color: red from 90%, amber from 70%, otherwise plain foreground so a
// healthy card carries no color at all.
function color(p){ if(p==null) return 'inherit'; if(p>=90) return C_BAD; if(p>=70) return C_WARN; return 'inherit'; }
function fmtLeft(ms){
  if(ms==null) return '';
  let s = Math.round((ms - Date.now())/1000);
  if(s<=0) return 'resets now';
  const d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
  if(d>0) return d+'d '+h+'h';
  if(h>0) return h+'h '+m+'m';
  if(m>0) return m+'m';
  return '<1m';
}
function fmtDur(ms){
  if(ms==null || ms<=0) return 'now';
  const s=Math.round(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  if(h>0) return h+'h '+m+'m';
  if(m>0) return m+'m';
  return '<1m';
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
// The active login is polled every 30 s and keeps burning, so its reading is old after 2 min; other accounts move only
// at a reset (or through claude.ai), 10 min. An old reading gets ~ before its percentages and its age in the header.
function readingAge(card){ return card.ts ? Math.max(0, Math.round(Date.now()/1000 - card.ts)) : null; }
function readingOld(card, age){ return age!=null && age > (card.active ? 120 : 600); }
function fmtTokens(n){
  if(n==null) return '0';
  if(n<1000) return ''+Math.round(n);
  if(n<1e6) return (n/1e3).toFixed(n<1e4?1:0)+'K';
  return (n/1e6).toFixed(2)+'M';
}
// Gauge label without the parenthetical window, the reset countdown carries it.
function gaugeLabel(l){ return l.replace(/\\s*\\((5h|7d)\\)/, ''); }
// The burn-rate line only appears when it is a warning: the window would fill
// before its own reset. "Safe" projections are noise and stay off the panel.
function etaLine(eta){
  if(!eta || !eta.beforeReset) return '';
  return '<div class="eta">full in '+fmtDur(eta.fullAtMs-Date.now())+' at +'+eta.perHour.toFixed(0)+'%/h, before the reset</div>';
}
const savedState = vscodeApi.getState() || {};
let collapsed = savedState.collapsed || { models:true };
function saveState(){ vscodeApi.setState({ collapsed }); }
function secHeader(id, title, hint){
  return '<button type="button" class="sech" data-sec="'+id+'" aria-expanded="'+(!collapsed[id])+'"><span class="chev">'+(collapsed[id]?'▸':'▾')+'</span>'
    + '<span>'+title+'</span>'
    + (collapsed[id] && hint ? '<span class="hint">'+hint+'</span>' : '')
    + '</button>';
}
function modelSection(models){
  if(!models || !models.length) return '';
  let h=secHeader('models','Models, 7d share', esc(models[0].name)+' '+models[0].pct+'%');
  if(!collapsed.models){
    let total=0, priced=true;
    for(const m of models){
      h += '<div class="mrow"><span class="mname" title="'+esc(m.name)+'">'+esc(m.name)+'</span>'
        + '<span class="mbar"><i class="mfill" style="width:'+Math.max(2,m.pct)+'%"></i></span>'
        + '<span class="mval">'+m.pct+'% · '+fmtTokens(m.tokens)+(m.cost!=null?(' · ≈$'+m.cost.toFixed(2)):'')+'</span></div>';
      if(m.cost!=null) total+=m.cost; else priced=false;
    }
    if(total>0) h += '<div class="note">≈$'+total.toFixed(2)+' total'+(priced?'':' (priced models only)')+' · rough, excl. cache reads</div>';
  }
  return h;
}
function tokenFoot(t, multiAcct){
  if(!t) return '';
  return '<div class="foot"><span title="in + out + cache-write'+(multiAcct?', all logins on this Mac':'')+'">Tokens'+(multiAcct?', all logins':'')+'</span>'
    + '<span class="num">5h '+fmtTokens(t.fiveHour)+' · 7d '+fmtTokens(t.sevenDay)+'</span></div>';
}
function nameSpan(card, name){
  const canSwitch = card.provider==='claude' && !!card.accountId && !card.active;
  return canSwitch
    ? '<span class="ctitle sw" role="button" tabindex="0" data-switch="'+esc(card.accountId)+'" title="Switch Claude Code to this account">'+esc(name)+'</span>'
    : '<span class="ctitle" title="'+esc(card.label)+'">'+esc(name)+'</span>';
}
function gaugeRow(g, old){
  const p = g.pct, spent = p!=null && p>=90;
  return '<div class="bar"><span class="l" title="'+esc(g.label)+'">'+esc(gaugeLabel(g.label))+'</span>'
    + '<span class="t"><i'+(spent?' class="bad"':'')+' style="width:'+(p==null?0:Math.min(100,Math.max(1,p)))+'%"></i></span>'
    + '<span class="p num" style="color:'+color(p)+'">'+(old&&p!=null?'~':'')+fmtPct(p)+'%</span>'
    + '<span class="r num">'+(g.resetMs?fmtLeft(g.resetMs).replace('resets now','now'):'')+'</span></div>';
}
// One card per account: header line, then the original one-row-per-gauge bars.
function providerCard(card){
  const age = readingAge(card), old = readingOld(card, age);
  const name = card.label.replace(/^(Claude|Codex) · /,'');
  const sb = (card.provider==='claude' && last.switchBadges && last.switchBadges[name]) || {};
  let h='<div class="card" data-testid="csm-account-row"><div class="chead">'
    + nameSpan(card, name)
    + (sb.rank ? '<span class="swrank num" title="claude-switch priority">#'+sb.rank+'</span>' : '')
    + (card.best ? '<span class="best" title="most headroom">★</span>' : '')
    + (card.provider==='claude' && card.active ? '<span class="adot" title="active login"></span>' : '')
    + (card.note && card.loginNeeded ? '<span class="clogin">login</span>' : '')
    + (sb.loginNeeded ? '<span class="clogin" title="claude-switch">login needed ('+esc(sb.loginNeeded)+')</span>' : '')
    + (card.plan ? '<span class="cplan">'+esc(card.plan)+'</span>' : '')
    + (old ? '<span class="cage num" title="last official usage fetch">'+fmtAge(age)+' ago</span>' : '')
    + '</div>';
  const gauges = card.official ? (card.gauges||[]) : [];
  if(gauges.length){
    h += gauges.map(g=>gaugeRow(g, old)).join('');
    if(card.provider==='claude' && card.active && gauges.some(g=>g.key==='session'||g.key==='5h')) h += etaLine(last.eta);
  }
  if(card.note) h += '<div class="note">'+esc(card.note)+'</div>';
  else if(!card.official) h += '<div class="note">Official '+esc(card.label)+' usage is unavailable. Session state remains available.</div>';
  return h+'</div>';
}
let ui = null;
let pendingUse = null; // { email, at }: a Use this account click waiting for the host's result
let pendingSkip = {}; // email -> { value, at }: a skip box change shown as clicked until the panel agrees, the host reports a failure or 20 s pass
function expandedOf(card){
  const v = ui && ui.expandedAccounts ? ui.expandedAccounts[card.id] : undefined;
  return v === undefined ? !!card.active : !!v;
}
function chipHtml(h){
  if(h.chip==='active') return '<span class="adot" title="active login"></span><span class="chip'+(h.loginNeeded?' login':'')+'">active'+(h.excluded?' · excluded':'')+(h.loginNeeded?' · login needed':'')+(h.exhausted?' · exhausted'+(h.resetMs?' · '+fmtLeft(h.resetMs).replace('resets now','now'):''):'')+'</span>';
  if(h.chip==='excluded') return '<span class="chip">excluded</span>';
  if(h.chip==='exhausted') return '<span class="chip">exhausted'+(h.resetMs?' · '+fmtLeft(h.resetMs).replace('resets now','now'):'')+'</span>';
  if(h.chip==='login') return '<span class="chip login">login needed</span>';
  return '<span class="chip">ready</span>';
}
// Skip box for an account claude-switch lists (hdr.excluded is set only for those): ticked = never switched to.
function skipBox(card, email){
  const h = card.hdr;
  if(card.provider!=='claude' || typeof h.excluded!=='boolean') return '';
  const p = pendingSkip[email], on = p ? p.value : h.excluded;
  return '<label class="skipbox" title="Skip: claude-switch never switches to this account. Untick to use it again.">'
    + '<input type="checkbox" data-skip="'+esc(email)+'" aria-label="Skip '+esc(email)+' in claude-switch" data-testid="csm-account-skip"'+(on?' checked':'')+'></label>';
}
// Plan price tag: "$200" with the full plan in its title; tiers colour by price so the costly logins stand out.
function planTag(card){
  const m = /\$\s*(\d+)/.exec(card.plan||'');
  if(!m) return '<span class="ptag pnone" title="'+esc(card.plan||'plan unknown')+'">'+(card.plan?esc(card.plan.slice(0,5)):'–')+'</span>';
  const n = Number(m[1]);
  return '<span class="ptag '+(n>=200?'phi':n>=100?'pmid':'plo')+'" title="'+esc(card.plan)+' / month" data-testid="csm-account-plan">$'+n+'</span>';
}
// Gauge columns of the account table: Session, Weekly, then every scoped weekly any card has (Fable, …).
let gcols = [];
function gaugeCols(cards){
  const sc = [];
  for(const c of cards) for(const g of ((c.hdr && c.hdr.gauges) || [])) if(!/^(Session|Weekly)$/i.test(g.label) && sc.indexOf(g.label)<0) sc.push(g.label);
  return ['Session','Weekly'].concat(sc);
}
function gaugeCell(g, old){
  if(!g) return '<span class="gnil"></span>';
  const p = Math.max(0, Math.min(100, Number(g.pct)||0));
  return '<span class="hg'+(g.hot?' hot':p>=70?' warn':'')+(p<=0?' zero':'')+'"><span class="gl">'+esc(g.label)+'</span><span class="gs">'+esc(g.short)+'</span> '+(old?'~':'')+fmtPct(g.pct)+'%'
    + '<i class="hgb"><b style="width:'+p+'%"></b></i></span>';
}
function gaugeCells(h, old){
  const gs = h.gauges || [];
  return gcols.map(l=>gaugeCell(gs.find(g=>g.label.toLowerCase()===l.toLowerCase()), old)).join('');
}
// Column header above the account rows (same widths as the row cells).
function tableHead(){
  return '<div class="lhead" aria-hidden="true"><span class="chev"></span><span class="lhp">plan</span><span class="lhn">account</span>'
    + '<span class="lhg">'+gcols.map(l=>'<span class="lhc">'+esc(l)+'</span>').join('')+'</span><span class="lhs">skip</span></div>';
}
// Simplified card: ONE always-visible table row, gauge rows only when expanded.
function collapsibleCard(card){
  const h = card.hdr, open = expandedOf(card), age = readingAge(card), old = readingOld(card, age);
  const email = card.email || card.label.replace(/^(Claude|Codex) · /,'');
  const box = skipBox(card, email);
  let out = '<div class="card ccard'+(card.active?' act':'')+(h.chip==='ready'?' rdy':'')+'" data-testid="csm-account-row"><div class="chrow"><div class="chdr'+(h.excluded?' excl':'')+'" role="button" tabindex="0" data-toggle="'+esc(card.id)+'" aria-expanded="'+open+'" title="'+esc(card.label)+'">'
    + '<span class="chev">'+(open?'▾':'▸')+'</span>'
    + planTag(card)
    + '<span class="ctitle">'+(h.rank?'<span class="swrank num">#'+h.rank+'</span> ':'')+esc(h.name)+'</span>'
    + chipHtml(h)
    + (old ? '<span class="cold num" title="time since the last successful usage read">'+fmtAge(age)+' ago</span>' : '')
    + '<span class="cgauges num" data-testid="csm-account-gauges">'+gaugeCells(h, old)+'</span>'
    + '</div>' + (box || '<span class="skipnil"></span>') + '</div>';
  if(open){
    out += '<div class="cbody">';
    const gauges = card.official ? (card.gauges||[]) : [];
    out += gauges.map(g=>gaugeRow(g, old)).join('');
    if(card.provider==='claude' && card.active && gauges.some(g=>g.key==='session'||g.key==='5h')) out += etaLine(last.eta);
    if(card.note) out += '<div class="note">'+esc(card.note)+'</div>';
    else if(!card.official) out += '<div class="note">Official '+esc(card.label)+' usage is unavailable. Session state remains available.</div>';
    if(card.provider==='claude' && !card.active && last.useEmails && last.useEmails.indexOf(email)>=0) out += useButton(email);
    out += '</div>';
  }
  return out+'</div>';
}
// Last table row: the whole Claude pool. Plan cell = summed monthly price; each column = share of the pool's limit used.
function poolRow(p){
  const how = p.weighted ? 'each login weighted by its plan price' : 'each login counted equally (a plan price is unknown)';
  const tip = p.ready+' of '+p.total+' Claude logins can take work now (Codex and skipped logins left out). Columns: share of the whole pool already used, '+how+'.';
  return '<div class="card ccard pool" data-testid="csm-account-pool"><div class="chrow"><div class="chdr" title="'+esc(tip)+'">'
    + '<span class="chev"></span>'
    + '<span class="ptag plo" data-testid="csm-pool-price">'+(p.price?'$'+p.price:'Σ')+'</span>'
    + '<span class="ctitle">all</span>'
    + '<span class="chip'+(p.ready?' prdy':'')+'" data-testid="csm-pool-ready">'+p.ready+'/'+p.total+' ready</span>'
    + '<span class="cgauges num" data-testid="csm-pool-gauges">'+gaugeCells(p, false)+'</span>'
    + '</div><span class="skipnil"></span></div></div>';
}
// While a switch runs its button reads "Switching…" (also after a webview reload,
// via the host's usePending) and every other Use button is disabled.
function useButton(email){
  const busy = (pendingUse && pendingUse.email===email) || last.usePending===email;
  if(busy) return '<button type="button" class="useacct" disabled aria-busy="true" data-testid="csm-use-account">Switching…</button>';
  const locked = !!pendingUse || !!last.usePending;
  return '<button type="button" class="useacct" data-use="'+esc(email)+'"'+(locked?' disabled':'')+' data-testid="csm-use-account">Use this account</button>';
}
function useResultLine(){
  const r = last.useResult;
  if(!r) return '';
  return '<div class="useres'+(r.ok||r.running?'':' err')+'" role="status" data-testid="csm-use-result">'
    + (r.ok ? 'Switched to '+esc(r.email) : (r.running ? 'Still switching to ' : 'Could not switch to ')+esc(r.email)+': '+esc(r.text)) + '</div>';
}
let pendingReset = null; // { key, at }: a reset Use click waiting for the host's done.at (or 60 s)
// One line per kind: its count, first expiry, and a Use button (or why it cannot be used now).
function resetRow(a, k){
  const key = a.id+'|'+k.kind;
  let act;
  if(!k.usable) act = '<span class="rsact" title="'+esc(k.why)+'">'+esc(k.why)+'</span>';
  else if(pendingReset && pendingReset.key===key) act = '<button type="button" class="useacct" disabled aria-busy="true" data-testid="csm-reset-use">Using…</button>';
  else act = '<button type="button" class="useacct" data-use-reset="'+esc(key)+'"'+(pendingReset?' disabled':'')+' data-testid="csm-reset-use">Use</button>';
  return '<div class="rsrow" title="'+esc(k.tip)+'" data-testid="csm-reset-row"><span class="rsk">'+esc(k.label)+' · '+k.count+'</span>'
    + (k.until ? '<span class="rsd">'+(k.count>1?'first expires ':'use by ')+esc(k.until)+'</span>' : '')
    + act + '</div>';
}
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// The rows come from the account's last usage reading; an old one (active login 10 min, others 20 min) shows its time.
function asOfNote(a){
  if(!a.ts || Date.now()/1000 - a.ts <= (a.active ? 600 : 1200)) return '';
  const d = new Date(a.ts*1000), hm = String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  const day = d.toDateString()===new Date(Date.now()).toDateString() ? '' : d.getDate()+' '+MONTHS[d.getMonth()]+' ';
  return '<span class="rsnote" data-testid="csm-resets-asof">as of '+day+hm+'</span>';
}
// Resets tab (claude-switch only): every account in card order, a line per kind with Use or why not.
function resetsList(){
  const r = last.resets;
  let h = '<div class="rsblock" data-testid="csm-resets">';
  if(r.cliMissing) h += '<div class="rsnone">Claude Code CLI not found</div>';
  else for(const a of (r.accounts||[])){
    h += '<div class="rsacct" data-testid="csm-resets-account"><div class="rsname"><span class="ctitle" title="'+esc(a.email)+'">'+esc(a.name)+'</span>'
      + (a.atLimit ? '<span class="chip">at limit</span>' : '')
      + asOfNote(a)
      + (a.note ? '<span class="rsnote" title="'+esc(a.note)+'">'+esc(a.note)+'</span>' : '') + '</div>';
    const kinds = a.kinds || [];
    if(kinds.length) h += kinds.map(k=>resetRow(a, k)).join('');
    else if(a.state==='ok') h += '<div class="rsnone">no resets</div>';
    h += '</div>';
  }
  return h + '</div>';
}
let burn = null; // the Burn tab's last ranking from the host (every few seconds)
function burnPct(n){ n = Number(n); return n > 0 ? Math.min(100, Math.round(n * 10) / 10) : 0; }
function burnRow(r){
  const open = r.openId ? ' data-open="'+esc(r.openId)+'" tabindex="0" role="button"' : '';
  return '<div class="brow'+(r.ended?' ended':'')+'" title="'+esc(r.tip)+'"'+open+'>'
    + '<span class="num brank">'+esc(r.rank)+'</span>'
    + '<span class="bdot'+(r.live?' live':'')+'" role="img" aria-label="'+(r.live?'live':'not live')+'"></span>'
    + '<span class="btitle">'+esc(r.title)+'</span>'
    + '<span class="num brate">'+esc(r.rate)+'</span>'
    + '<span class="num bused">'+esc(r.used)+'</span>'
    + '<div class="bl2"><span class="bbar"><span class="bfill" style="width:'+burnPct(r.barPct)+'%"></span></span>'
    + '<span class="bmeta">'+esc(r.meta)+'</span></div>'
    + '</div>';
}
// Burn tab: the window picker, the headline, one entry per session (a click opens it), the more line and the note.
function burnTab(){
  const p = burn;
  if(!p) return '<div class="bempty">Collecting usage…</div>';
  const ws = Array.isArray(p.windows) ? p.windows : [];
  let h = ws.length ? '<div class="bwins" role="group" aria-label="Burn window">'
    + ws.map(w=>'<button type="button" class="bwin" data-ms="'+esc(w.ms)+'" aria-pressed="'+(w.ms === p.windowMs)+'">'+esc(w.label)+'</button>').join('') + '</div>' : '';
  if(p.headline) h += '<div class="bhead">'+esc(p.headline)+'</div>';
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if(!rows.length) h += '<div class="bempty">'+esc(p.empty)+'</div>';
  else {
    h += rows.map(r=>burnRow(r)).join('');
    const n = Number(p.more);
    if(n > 0) h += '<div class="bmore">+ '+esc(n)+' more session'+(n === 1 ? '' : 's')+'</div>';
  }
  if(p.note) h += '<div class="bnote">'+esc(p.note)+'</div>';
  return h;
}
// Section tabs pinned to the bottom of the view: Accounts, Burn while Claude is on, Resets and Activity from claude-switch.
function tabList(){
  const t = [{ id:'accounts', label:'Accounts', n:null }];
  if(last.burnOn) t.push({ id:'burn', label:'Burn', n:null });
  if(last.resets) t.push({ id:'resets', label:'Resets', n:last.resets.total });
  if(last.switchActivity) t.push({ id:'activity', label:'Activity', n:last.switchActivity.count });
  return t;
}
function tabBar(tabs, cur){
  return '<div class="ltabspace"></div><div class="ltabs" role="tablist" aria-label="Usage Limits sections" data-testid="csm-limits-tabs">'
    + tabs.map(t=>'<button type="button" role="tab" class="ltab'+(t.id===cur?' active':'')+'" aria-selected="'+(t.id===cur)+'" data-tab="'+t.id+'" data-testid="csm-tab-'+t.id+'"><span class="tl">'+t.label+'</span>'+(t.n!=null?'<span class="tn">'+t.n+'</span>':'')+'</button>').join('')
    + '</div>';
}
function setUi(key, value){
  ui[key] = value;
  vscodeApi.postMessage({ type:'setUi', key: key, value: value });
  render();
}
function render(){
  const root = document.getElementById('root');
  if(!last){ return; }
  if(!ui) ui = last.ui || { tab:'accounts', expandedAccounts:{} };
  if(pendingUse && Date.now() - pendingUse.at > 90000) pendingUse = null; // the host answers within its 90 s UI timeout (the result, or that the run goes on)
  for(const e in pendingSkip) if(Date.now() - pendingSkip[e].at > 20000) delete pendingSkip[e];
  if(pendingReset && Date.now() - pendingReset.at > 60000) pendingReset = null; // the host answers when its modal closes; 60 s caps a lost answer
  const tabs = tabList(), tab = tabs.some(t=>t.id===ui.tab) ? ui.tab : 'accounts';
  let h = last.switchHtml || '';
  if(tab==='resets') h += resetsList();
  else if(tab==='burn') h += burnTab();
  else if(tab==='activity') h += last.switchActivity.html;
  else h += accountsHtml();
  if(tabs.length > 1) h += tabBar(tabs, tab);
  root.innerHTML = h;
}
// Accounts tab (the whole view without claude-switch): the cards, then the token, model and limit-hit lines.
function accountsHtml(){
  let h = useResultLine();
  const cards = (last.providers && last.providers.length) ? last.providers : [{
    id:'claude', provider:'claude', label:'Claude', active:true, ts:last.ts, official:last.official, gauges:last.gauges||[],
    note:last.usageNote||last.accountNote||null, sevenDayTokens:null, lifetimeTokens:null
  }];
  if(!last.panelFresh && last.accounts && last.accounts.length > 1) h += '<div class="rot"><button type="button" class="rotbtn" data-rotate="1" title="Switch Claude Code to the account with the most headroom">Rotate ▸</button></div>';
  const table = last.panelFresh && cards.some(c=>c.hdr);
  if(table){ gcols = gaugeCols(cards); h += tableHead(); }
  for(const c of cards) h += (last.panelFresh && c.hdr) ? collapsibleCard(c) : providerCard(c);
  if(table && last.pool) h += poolRow(last.pool);
  if(cards.some(c=>c.provider==='claude')){
    const multiAcct = !!(last.accounts && last.accounts.length > 1);
    if(last.showTokenStats){
      h += tokenFoot(last.tokens, multiAcct);
      h += modelSection(last.models);
    }
  }
  const limited = last.limited||[];
  if(limited.length){
    h += '<div class="foot">Active limit hits</div>';
    for(const l of limited){
      const reset = l.resetMs ? (' · resets in '+fmtLeft(l.resetMs)) : (l.resetText? (' · resets '+esc(l.resetText)) : '');
      const prov = cards.length > 1 ? (l.provider==='codex' ? 'Codex · ' : 'Claude · ') : '';
      h += '<div class="hit"><span class="hitt">'+prov+esc(l.title)+'</span> <span class="note">'+esc(l.sub)+reset+'</span></div>';
    }
  }
  return h;
}
function toggleAccount(id){
  const card = ((last && last.providers) || []).find(c=>c.id===id);
  const next = Object.assign({}, ui.expandedAccounts);
  next[id] = !(card ? expandedOf(card) : next[id]);
  setUi('expandedAccounts', next);
}
document.getElementById('root').addEventListener('keydown', (ev) => {
  if(ev.key !== 'Enter' && ev.key !== ' ') return;
  const d = ev.target && ev.target.dataset;
  if(!d) return;
  if(d.switch){ vscodeApi.postMessage({ type:'switchAccount', id: d.switch }); ev.preventDefault(); }
  else if(d.toggle){ toggleAccount(d.toggle); ev.preventDefault(); }
  else if(d.open){ vscodeApi.postMessage({ type:'openSession', id: d.open }); ev.preventDefault(); }
});
document.getElementById('root').addEventListener('click', (ev) => {
  let el = ev.target;
  while(el && el !== ev.currentTarget){
    if(el.classList && el.classList.contains('skipbox')) return; // the skip box and its label never toggle the card
    if(el.dataset && el.dataset.switch){ vscodeApi.postMessage({ type:'switchAccount', id: el.dataset.switch }); return; }
    if(el.dataset && el.dataset.use){
      if(!pendingUse && !last.usePending){
        pendingUse = { email: el.dataset.use, at: Date.now() };
        vscodeApi.postMessage({ type:'useAccount', email: pendingUse.email, at: pendingUse.at });
        render();
      }
      return;
    }
    if(el.dataset && el.dataset.useReset){
      if(!pendingReset){
        pendingReset = { key: el.dataset.useReset, at: Date.now() };
        vscodeApi.postMessage({ type:'useReset', key: pendingReset.key, at: pendingReset.at });
        render();
      }
      return;
    }
    if(el.dataset && el.dataset.toggle){ toggleAccount(el.dataset.toggle); return; }
    if(el.dataset && el.dataset.tab){ setUi('tab', el.dataset.tab); return; }
    if(el.dataset && el.dataset.ms){ const ms = Number(el.dataset.ms); if(ms > 0) vscodeApi.postMessage({ type:'burnWindow', ms: ms }); return; }
    if(el.dataset && el.dataset.open){ vscodeApi.postMessage({ type:'openSession', id: el.dataset.open }); return; }
    if(el.dataset && el.dataset.rotate){ vscodeApi.postMessage({ type:'rotateBest' }); return; }
    if(el.classList && el.classList.contains('sech') && el.dataset.sec){
      collapsed[el.dataset.sec] = !collapsed[el.dataset.sec];
      saveState();
      render();
      return;
    }
    el = el.parentElement;
  }
});
document.getElementById('root').addEventListener('change', (ev) => {
  const t = ev.target, email = t && t.dataset && t.dataset.skip;
  if(!email) return;
  pendingSkip[email] = { value: !!t.checked, at: Date.now() };
  vscodeApi.postMessage({ type:'setExcluded', email: email, excluded: !!t.checked, at: pendingSkip[email].at });
});
// A pending skip box ends when the panel reports the clicked value or the host reports that click failed.
function settleSkips(){
  const f = last.skipFailed;
  if(f && pendingSkip[f.email] && pendingSkip[f.email].at===f.at) delete pendingSkip[f.email];
  for(const c of (last.providers||[])){
    const p = c.email && pendingSkip[c.email];
    if(p && c.hdr && c.hdr.excluded===p.value) delete pendingSkip[c.email];
  }
}
window.addEventListener('message', e => {
  if(e.data && e.data.type==='update'){
    last = e.data;
    if(pendingUse && last.useResult && last.useResult.at===pendingUse.at) pendingUse = null;
    if(pendingReset && last.resets && last.resets.done && last.resets.done.at===pendingReset.at) pendingReset = null;
    settleSkips();
    render();
  }
  else if(e.data && e.data.type==='burn'){ burn = e.data; render(); }
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
  // One key per window in the debug log, the health file and the continuity heartbeat (continuity.ts windowKey).
  const win = windowKey(storageDir(ctx.storageUri?.fsPath), process.pid);
  const version = (ctx.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0";
  debugLog.identify(win, version);
  const cfg = () => vscode.workspace.getConfiguration("claudeSessionMonitor");
  const showTokenStats = (): boolean => cfg().get<boolean>("showTokenStats", false);
  const workspaceCwd = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const trackAllAccounts = () => cfg().get<boolean>("trackAllAccounts", true);
  // planLabels: { "<email>" | "claude" | "codex": "$200 Max" } — manual override
  // for the plan shown on each usage card (keys are case-insensitive).
  const planLabels = (): Record<string, string> => {
    const raw = cfg().get<Record<string, unknown>>("planLabels", {}) ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "string" && v.trim()) out[k.trim().toLowerCase()] = v.trim();
    return out;
  };
  const planLabelFor = (key: string): string | null => planLabels()[key.toLowerCase()] ?? null;
  const claudeEnabled = () => cfg().get<boolean>("enableClaude", true);
  const codexEnabled = () => cfg().get<boolean>("enableCodex", true);
  const enabledProviders = (): AgentProvider[] => [
    ...(claudeEnabled() ? (["claude"] as const) : []),
    ...(codexEnabled() ? (["codex"] as const) : []),
  ];
  const savedProviderFilter = ctx.globalState.get<string>("providerFilter", "all");
  let providerFilter: AgentProvider | "all" =
    savedProviderFilter === "claude" || savedProviderFilter === "codex" ? savedProviderFilter : "all";
  let projectFilter = ctx.globalState.get<string>("projectFilter", "all");
  let projectStrip: ProjectStrip | null = null; // set by refreshOnce, read by pushSessions
  const stages = stageGuard(log); // a refresh stage or feature start that throws is logged and skipped (safeStage.ts)
  // An Extension Development Host only reads and shows both panels; dev.enableFeatures lists what it may do besides (observerMode.ts).
  const observer = observerMode({
    development: ctx.extensionMode === vscode.ExtensionMode.Development,
    enableFeatures: cfg().get<unknown>("dev.enableFeatures", []),
    notify: (text) => void vscode.window.showInformationMessage(text),
  });
  const allowed = observer.featureAllowed;
  logSink = allowed("sharedFiles") ? undefined : observerLog(ctx);
  log(`activated: version ${version} pid ${process.pid} window ${win}`, "activation");
  if (observer.on) log(observer.summary());

  const resourceCache = new Map<number, ResStat>();
  const sessionsView = new SessionsView((action, sessionId) => {
    if (action === "filterProject") {
      projectFilter = sessionId;
      void ctx.globalState.update("projectFilter", projectFilter);
      refresh();
      return;
    }
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
  let activeChangedAtMs = 0; // when this window last saw activeId move (attributes snapshots of older builds)

  /** Adopt a registry state; every path that moves activeId goes through here, so the change time is never stale. */
  function setAccounts(next: AccountsFile): void {
    if (next.activeId !== accountsFile.activeId) activeChangedAtMs = Date.now();
    accountsFile = next;
  }
  const usageByAccount = new Map<string, { usage: OfficialUsage | null; stale: boolean }>();
  /** Newest usage reading held for any account (epoch seconds), or undefined before the first one. */
  function newestReadingSec(): number | undefined {
    let best = officialUsage?.ts ?? 0;
    for (const { usage } of usageByAccount.values()) if (usage && usage.ts > best) best = usage.ts;
    return best > 0 ? best : undefined;
  }
  let othersInflight = false;
  let lastOthersCheck = 0;

  const limitsView = new LimitsView(
    () => vscode.commands.executeCommand("claudeSessionMonitor.refreshUsage"),
    (id) => void switchToAccount(id),
    () => void vscode.commands.executeCommand("claudeSessionMonitor.switchToBestAccount"),
    (email, clickedAt) => useAccountViaCli(email, clickedAt),
    (key, value) => {
      if (key === "tab" && isLimitsTab(value)) void ctx.workspaceState.update("csm.limitsTab", value);
      else if (key === "expandedAccounts" && value && typeof value === "object") void ctx.workspaceState.update("csm.expandedAccounts", value);
    },
    (email, excluded, clickedAt) => setExcludedViaCli(email, excluded, clickedAt),
    (key, clickedAt) => void useResetFromPanel(key, clickedAt),
    onBurnAction,
  );

  type UseFinish = (ok: boolean, text: string, cliMs: number | null, running?: boolean) => void;
  type UseRun = { email: string; started: number; finish: UseFinish };
  let usePending: UseRun | null = null; // the `claude-switch use` the panel shows as "Switching…"
  let useDone: { email: string; at: number; ok: boolean; text: string; until: number; running?: boolean } | null = null;
  let skipFailed: { email: string; at: number; until: number } | null = null; // last skip box change claude-switch did not apply
  const switchRunner = new SwitchRunner(SWITCH_CLI); // one `use`, `tick --fresh` or `exclude`/`include` at a time, never signaled

  /**
   * claude-switch owns switching; this only shells out to its `use` command (no
   * shell, no token in args or logs). The panel shows "Switching…" while it runs;
   * on exit the active login is re-resolved and the panel re-rendered at once,
   * with the outcome in the panel, and the click-to-render time is logged.
   * Returns null once `use` started, else why it did not (shown in the panel too).
   */
  function useAccountViaCli(email: string, clickedAt?: number): string | null {
    const received = Date.now();
    const t0 = useStartMs(clickedAt, received);
    const at = typeof clickedAt === "number" ? clickedAt : received;
    const finish: UseFinish = (ok, text, cliMs, running = false) => {
      useDone = { email, at, ok, text, until: running ? Infinity : Date.now() + (ok ? 10_000 : 30_000), ...(running ? { running } : {}) };
      pushUsagePayload();
      log(`use: ${email} ${Date.now() - t0}ms (${cliMs === null ? "cli not run" : `cli ${cliMs}ms`}, ${ok ? "ok" : running ? "still running" : "failed"}: ${text})`);
      vscode.window.setStatusBarMessage(`claude-switch use ${email}: ${text.slice(0, 160)}`, 8000);
    };
    const refuse = (text: string): string => {
      finish(false, text, null);
      return text;
    };
    if (!allowed("accountWrites")) return refuse(observer.notice("accountWrites"));
    if (usePending) return refuse(`already switching to ${usePending.email}`);
    const panel = installedPanel();
    if (!panelFresh(panel, Date.now()) || !(panel.accounts ?? []).some((a) => a.email === email)) {
      return refuse("claude-switch does not list this account right now (panel.json missing, stale or without it)");
    }
    const run: UseRun = { email, started: Date.now(), finish };
    const launch = switchRunner.start(["use", email], { timeoutMs: USE_STUCK_MS, onTimeout: () => stopWaitingForUse(run) });
    if (!launch.started) return refuse(busyText(launch.running, Date.now()));
    usePending = run;
    pushUsagePayload();
    void launch.done.then(
      (res) => {
        const cliMs = Date.now() - run.started;
        const out = useOutcome(res);
        void syncActive(true)
          .catch((e: unknown) => {
            log("use: re-resolve failed " + String(e));
            return false;
          })
          .then(() => {
            if (usePending === run) usePending = null; // after the UI timeout the panel already stopped showing "Switching…"
            const now = accountsFile.accounts.find((a) => a.id === accountsFile.activeId)?.email;
            if (out.ok && now?.toLowerCase() !== email.toLowerCase()) finish(false, `claude-switch exited without error but the active login is ${now ?? "unknown"}`, cliMs);
            else finish(out.ok, out.text, cliMs);
          });
      },
      (e: unknown) => {
        // Not started (ENOENT, EACCES, E2BIG): without this the button stays "Switching…" until the UI timeout.
        if (usePending === run) usePending = null;
        finish(false, spawnFailureText(e, SWITCH_CLI), null);
      },
    );
    return null;
  }

  /** The UI timeout of a `use`: the panel stops showing "Switching…" and says the run goes on; the process is never signaled and its exit is still handled. */
  function stopWaitingForUse(run: UseRun): void {
    if (usePending !== run) return;
    usePending = null;
    run.finish(false, `claude-switch use has been running for ${USE_STUCK_MS / 1000} s; the panel will update from panel.json when it finishes`, Date.now() - run.started, true);
  }

  /**
   * The skip box: `claude-switch exclude|include <email>` through the same runner as
   * `use` (one claude-switch run at a time, never signaled). While another run is in
   * flight the change is refused with a warning, not queued. On success panel.json is
   * re-read at once; on failure the CLI's message is shown and the webview drops its
   * optimistic box state.
   */
  function setExcludedViaCli(email: string, excluded: boolean, clickedAt?: number): void {
    const at = typeof clickedAt === "number" ? clickedAt : Date.now();
    const cmd = excluded ? "exclude" : "include";
    const fail = (text: string): void => {
      skipFailed = { email, at, until: Date.now() + 30_000 };
      pushUsagePayload();
      log(`${cmd}: ${email} failed: ${text}`);
      void vscode.window.showWarningMessage(`claude-switch ${cmd} ${email}: ${text}`);
    };
    if (!allowed("accountWrites")) {
      fail(observer.notice("accountWrites"));
      return;
    }
    if (!(installedPanel()?.accounts ?? []).some((a) => a.email === email)) {
      fail("claude-switch does not list this account (panel.json missing or without it)");
      return;
    }
    const launch = switchRunner.start([cmd, email]);
    if (!launch.started) {
      fail(`${busyText(launch.running, Date.now())}; try again when it ends`);
      return;
    }
    void launch.done.then(
      (res) => {
        if (res.code !== 0) {
          fail(lastLine(res.stderr) || lastLine(res.stdout) || exitText(res, cmd));
          return;
        }
        const out = lastLine(res.stdout) || `${cmd} ${email}: done`;
        log(`${cmd}: ${email} ok: ${out}`);
        vscode.window.setStatusBarMessage(`claude-switch: ${out.slice(0, 160)}`, 8000);
        pushUsagePayload(); // re-reads panel.json now, not after the watch debounce
      },
      (e: unknown) => fail(spawnFailureText(e, SWITCH_CLI)),
    );
  }

  // --- Limit resets (pure logic in src/resets.ts) ----------------------------
  // claude-switch installs only. Each account's gift resets come with its own usage
  // poll (usageRequest asks for the cedar_ember block as well), so they cost no extra
  // call. The last reading per account is kept in resets-<accountUuid>.json next to
  // the usage snapshots and loaded at activation, so a reload shows it at once. A reset
  // is spent only after a click and a modal confirm. Tokens are never refreshed here
  // and the active login is never written.
  const resetsByAccount = new Map<string, ResetsEntry>();
  const usageFail = new Map<string, UsageFail>(); // accountId -> how its latest usage poll failed (a good poll clears it)
  const resetsLogged = new Map<string, string>(); // accountId -> last logged summary (a debug line only when it changes)
  const resetsRequestIds = new Map<string, string>(); // "<accountId>|<grantId>" -> request_id of a claim that came back unresolved
  let resetsClaiming = false;
  let resetsDone: { at: number } | null = null; // the last finished Use click (at = its click time)
  let cliUaCache: { at: number; ua: string | null } | undefined;
  const resetsFetch: ResetsFetch = (url, init) => fetch(url, init);
  const resetsOn = (): boolean => claudeEnabled() && switchInstalled();

  /** The Claude Code CLI's User-Agent, looked up at most once a minute; null when the CLI is not installed. */
  function cliUa(): string | null {
    if (!cliUaCache || Date.now() - cliUaCache.at > 60_000) {
      const ua = cliUserAgent({ home: os.homedir(), readdir: (d) => fs.readdirSync(d), realpath: (p) => fs.realpathSync(p) });
      if (ua === null && cliUaCache?.ua !== null) log("resets: Claude Code CLI not found, usage polls carry no reset data");
      cliUaCache = { at: Date.now(), ua };
    }
    return cliUaCache.ua;
  }

  /** The usage poll's request: it asks for the resets too only with claude-switch and the Claude Code CLI installed. */
  function usageReq(token: string): { url: string; headers: Record<string, string> } {
    const on = resetsOn();
    return usageRequest(token, on, on ? cliUa() : null);
  }

  /** Keep the resets that came with an account's usage reading (ts in epoch s), in memory and on disk. */
  function storeResets(id: string, ts: number, status: CedarEmber): void {
    if (!resetsOn()) return;
    const entry: ResetsEntry = { ts, status };
    resetsByAccount.set(id, entry);
    const file = resetsFilePath(MONITOR_DIR, id);
    try {
      if (file) writePrivateTextAtomic(file, resetsFileText(entry));
    } catch (e) {
      log(`resets: could not save acct ${id.slice(0, 8)}: ${String(e)}`);
    }
    const kinds = summarize(status, Date.now()).map((k) => `${k.kind}=${k.count}${k.usable ? "" : " (not usable)"}`).join(" ");
    const line = `${status.eligible ? kinds || "none" : `ineligible (${status.ineligibleReason ?? "?"})`}${status.atLimit ? " · at limit" : ""}`;
    if (resetsLogged.get(id) === line) return;
    resetsLogged.set(id, line);
    log(`resets: ${accountsFile.accounts.find((a) => a.id === id)?.email ?? `acct ${id.slice(0, 8)}`} ${line}`);
  }

  /** Adopt every saved reading newer than the one in memory (at activation, then other windows' polls); true when one was. */
  function loadResetsFiles(): boolean {
    let changed = false;
    for (const a of accountsFile.accounts) {
      const file = resetsFilePath(MONITOR_DIR, a.id);
      let entry: ResetsEntry | null = null;
      try {
        entry = file ? parseResetsFile(fs.readFileSync(file, "utf8")) : null;
      } catch {
        entry = null; // no file yet
      }
      const cur = resetsByAccount.get(a.id);
      if (entry && (!cur || entry.ts > cur.ts)) {
        resetsByAccount.set(a.id, entry);
        changed = true;
      }
    }
    return changed;
  }
  if (resetsOn()) loadResetsFiles();

  /**
   * Token and organization for a claim, never refreshed here: the keychain for the active login (read
   * fresh, with the login re-checked after the read), else the claude-switch vault (decidePassiveSource;
   * the extension's own vault when the CLI has no file for it).
   */
  async function resetsCreds(id: string): Promise<{ token?: string; orgUuid?: string; why: string }> {
    const activeIdent = async (): Promise<ActiveIdentity | undefined> => {
      const m = await claudeJsonMtimeMs();
      return m === undefined ? undefined : readIdentityFileAt(m);
    };
    const orgOf = (b: Record<string, unknown> | undefined): string | undefined => (typeof b?.organizationUuid === "string" ? b.organizationUuid : undefined);
    const expired = (at: unknown): boolean => typeof at === "number" && Date.now() > at - 60_000;
    const ident = await activeIdent();
    if (ident?.id === id) {
      const creds = await readClaudeCredentials();
      if ((await activeIdent())?.id !== id) return { why: "the active login changed meanwhile" };
      if (!creds) return { why: "no keychain token" };
      if (expired(creds.expiresAt)) return { why: "token expired · Claude Code refreshes it" };
      return { token: creds.token, orgUuid: orgOf(ident.block), why: "" };
    }
    const cli = await readCliVault(id, log);
    const own = await readVaultOauth(id);
    const oauth = decidePassiveSource(own, cli?.claudeAiOauth) === "use-cli" ? cli?.claudeAiOauth : own;
    const token = typeof oauth?.accessToken === "string" ? oauth.accessToken : undefined;
    if (!token) return { why: "no stored token" };
    if (expired(oauth?.expiresAt)) return { why: "token expired · claude-switch keeper refreshes it" };
    let ownIdent: Record<string, unknown> | undefined;
    try {
      ownIdent = parseJsonObject(await ctx.secrets.get(vaultIdentKey(id)));
    } catch {
      ownIdent = undefined;
    }
    return { token, orgUuid: orgOf(cli?.oauthAccount) ?? orgOf(ownIdent), why: "" };
  }

  /** The section's payload: every Claude account the cards list, in card order, with its card's display name. */
  function resetsPayload(cards: UsageProviderCard[]): ResetsPayload {
    const now = Date.now();
    const accounts: ResetsPayload["accounts"] = [];
    for (const c of cards) {
      if (c.provider !== "claude") continue;
      const id = c.accountId ?? accountsFile.activeId; // the single "Claude" card is the active login
      const email = accountsFile.accounts.find((a) => a.id === id)?.email;
      if (!id || !email) continue;
      accounts.push({ id, name: c.hdr?.name ?? c.label.replace(/^Claude · /, ""), email, active: c.active, ...accountView(resetsByAccount.get(id), usageFail.get(id), now) });
    }
    return {
      total: resetsTotal(accounts.map((a) => resetsByAccount.get(a.id)), now),
      ...(cliUa() === null ? { cliMissing: true } : {}),
      accounts,
      done: resetsDone,
    };
  }

  /** A Use click: the host picks the grant from its own listing (never from the webview), confirms in a modal, then claims. */
  async function useResetFromPanel(key: string, clickedAt?: number): Promise<void> {
    const sep = key.lastIndexOf("|");
    const id = key.slice(0, sep);
    const kind = RESET_KINDS.find((k) => k === key.slice(sep + 1));
    const email = accountsFile.accounts.find((a) => a.id === id)?.email;
    const status = resetsByAccount.get(id)?.status;
    const grant = status && kind ? pickGrant(status, kind, Date.now()) : null;
    if (resetsClaiming) {
      vscode.window.setStatusBarMessage("Limit resets: another reset is being used", 5000);
    } else if (!resetsOn() || !kind || !email || !status || !grant) {
      void vscode.window.showInformationMessage(`No usable ${kind ? KIND_LABEL[kind] : "reset"}${email ? ` on ${email}` : ""} right now.`);
    } else if (observer.actionAllowed("accountWrites")) {
      resetsClaiming = true;
      try {
        await confirmAndClaim(id, email, kind, status, grant);
      } catch (e) {
        log("resets: claim error " + String(e));
      } finally {
        resetsClaiming = false;
      }
    }
    resetsDone = { at: typeof clickedAt === "number" ? clickedAt : Date.now() };
    pushUsagePayload();
  }

  async function confirmAndClaim(id: string, email: string, kind: ResetKind, status: CedarEmber, grant: ResetGrant): Promise<void> {
    const label = KIND_LABEL[kind];
    const now = Date.now();
    const count = summarize(status, now).find((r) => r.kind === kind)?.count ?? grant.resetsLeft;
    const useBy = grant.endsAt ? ` · use by ${fmtUseBy(grant.endsAt, now)}` : "";
    const pick = await vscode.window.showWarningMessage(
      `Use a ${label} on ${email}?`,
      { modal: true, detail: `${refillText(grant)}. ${count} left${useBy}.` },
      "Use reset",
    );
    if (pick !== "Use reset") return;
    const ua = cliUa();
    const creds = await resetsCreds(id);
    if (!ua || !creds.token || !creds.orgUuid) {
      const why = !ua ? "Claude Code CLI not found" : !creds.token ? creds.why : "its organization is unknown";
      log(`resets: claim ${email} ${grant.id} not sent: ${why}`);
      void vscode.window.showWarningMessage(`The ${label} on ${email} was not used: ${why}.`);
      return;
    }
    const slot = `${id}|${grant.id}`;
    const retry = resetsRequestIds.get(slot);
    const requestId = retry ?? randomUUID();
    log(`resets: claim ${email} ${grant.id}${retry ? " (same request id as the unresolved try)" : ""}`);
    const out = await claimReset(creds.token, creds.orgUuid, grant.id, requestId, ua, resetsFetch);
    const result = out.ok
      ? `${out.reply.result}${out.reply.reason ? ` (${out.reply.reason})` : ""}${out.reply.cleared.length ? ` · cleared ${out.reply.cleared.join(",")}` : ""}`
      : out.kind === "invalid"
        ? `not sent: malformed ${out.field}`
        : `${out.kind}${out.httpStatus ? ` (HTTP ${out.httpStatus})` : ""}`;
    log(`resets: claim ${email} ${grant.id} -> ${result}`);
    const sent = out.ok || out.kind !== "invalid";
    if (sent) {
      if (claimUnresolved(out)) resetsRequestIds.set(slot, requestId);
      else resetsRequestIds.delete(slot);
    }
    if (!out.ok || out.reply.result !== "reset") {
      void vscode.window.showWarningMessage(describeClaim(out, label, email, Date.now()));
      return;
    }
    const entry = resetsByAccount.get(id);
    const after = entry ? withResetsLeft(entry.status, grant.id, out.reply.resetsLeft ?? Math.max(0, grant.resetsLeft - 1)) : undefined;
    if (entry && after) storeResets(id, entry.ts, after); // kept on disk too; the reading time stays the poll's
    const left = after ? summarize(after, Date.now()).find((r) => r.kind === kind)?.count ?? 0 : 0;
    vscode.window.setStatusBarMessage(`${label} used on ${email} · ${left} left`, 10_000);
    void vscode.commands.executeCommand("claudeSessionMonitor.refreshUsage"); // its polls bring the refilled limits and the resets
  }

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("claudeSessionMonitor.limits", limitsView),
  );

  // Limit burn: what each session spends, read from the transcripts (subagents
  // included) every few seconds and ranked on the Usage limits view's Burn tab.
  const BURN_HORIZON_MS = 5.5 * 3_600_000;
  const burnTracker = new BurnTracker({ projectsDir: PROJECTS_DIR, horizonMs: BURN_HORIZON_MS });
  const storedBurnWindow = ctx.globalState.get<number>("burnWindowMs", DEFAULT_BURN_WINDOW_MS);
  let burnWindowMs = BURN_WINDOWS.some((w) => w.ms === storedBurnWindow) ? storedBurnWindow : DEFAULT_BURN_WINDOW_MS;
  let burnScaleCache: Readonly<Record<string, number>> = ctx.globalState.get<Record<string, number>>("burnScaleByAcct") ?? {};
  let burnShareBySession: Map<string, number> | null = null; // null until the first transcript scan finished
  let burnHogId: string | null = null;
  let lastBurnTick = 0;
  /** A Burn tab click: one of BURN_WINDOWS, or a session row to open. */
  function onBurnAction(action: "open" | "window", value: string): void {
    if (action === "window") {
      const ms = Number(value);
      if (!BURN_WINDOWS.some((w) => w.ms === ms)) return;
      burnWindowMs = ms;
      void ctx.globalState.update("burnWindowMs", ms);
      void burnTick();
      return;
    }
    const v = lastAllViews.find((session) => session.key === value);
    if (v) void jumpToSession(v);
  }

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "claudeSessionMonitor.focus";
  statusBar.show();
  ctx.subscriptions.push(statusBar);

  const collector = new SessionCollector();
  const lastSeen = new Map<string, GroupKey>();
  const stuckNotified = new Set<string>();
  let recentCache: RecentTranscript[] = [];
  let lastViews: SessionView[] = [];
  let lastAllViews: SessionView[] = [];
  let remoteBridge: RemoteBridge | undefined; // optional remote bridge (remoteBridge.ts), off unless url + token are set
  let tabWaker: TabWaker<TabMemo> | undefined; // wakeTabs.ts, inert unless claudeSessionMonitor.wakeDeadTabs is on
  let continuity: ContinuityServer<vscode.TabGroup, vscode.Tab> | undefined; // continuity.ts, inert unless claudeSessionMonitor.continuityChannel is on
  let lastRecentScan = 0;
  let lastCleanup = 0;
  let lastResourceSample = 0;
  let lastTokenScan = Date.now() / 1000; // the first token scan waits a minute: activation is when Claude Code restores its tabs
  let lastSessLog = 0;
  const sessionDrops = new SessionDrops(); // one log line when 5+ live sessions are gone within 60 s
  let lastRefreshMs = 0; // start of the last refresh from any path; timer, watcher and Codex poll refreshes wait REFRESH_GAP_MS after it
  const refreshMs = new DurationRing(); // the main-thread time of the recent refreshes, for the health file's p95
  const refresh = singleFlight(timedRefresh, (e) => stages.fail("refresh", e)); // a request while one runs shares it
  let tokenUsage: TokenUsage | null = null;
  let officialUsage: OfficialUsage | null = null;
  let officialUsageAcct: string | null = null; // account officialUsage was fetched for (the active card only shows its own)
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
  if (bootSnap?.gauges.length && bootSnap.ts) {
    officialUsage = { gauges: bootSnap.gauges, ts: bootSnap.ts };
    const bootActive = accountsFile.activeId ?? null;
    const bootOwn = bootActive && !bootSnap.acct ? readOfficialSnapshot(officialUsageFileFor(bootActive)) : undefined;
    officialUsageAcct = snapshotAccount(bootSnap, bootActive, activeChangedAtMs, bootOwn);
  }
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
  let endSweep: (() => void) | undefined; // detaches the running sweep from its automation gate signal
  let autoResumeTimer: ReturnType<typeof setTimeout> | undefined;
  let autoResumeAt = 0;
  let lastIdleRamWarn = 0;
  let focusCursor = "";

  // Auto-resume: when sessions are limited (or the 5h window is pinned at 99%+),
  // schedule one staggered resume sweep for just after the window resets. A limited
  // session's own choice (remote `autoResume`, autoResume.ts) overrides the setting.
  function clearAutoResume(): void {
    if (autoResumeTimer) clearTimeout(autoResumeTimer);
    autoResumeTimer = undefined;
    autoResumeAt = 0;
  }

  const autoResumeAll = () => cfg().get<boolean>("autoResumeAfterReset", false);
  const autoResumeOverrides = () => readOverrides(ctx.globalState.get(OVERRIDES_KEY), Date.now());

  function maybeScheduleAutoResume(views: SessionView[]): void {
    if (!allowed("autoResume")) return; // observer mode: no sweep is ever scheduled
    const all = autoResumeAll();
    const limitedViews = claudeEnabled() ? limitedToResume(views, autoResumeOverrides(), all) : [];
    if (!claudeEnabled() || (!all && !limitedViews.length)) {
      clearAutoResume();
      return;
    }
    const nowMs = Date.now();
    const g5 = activeUsage()?.gauges.find((g) => g.key === "session");
    let target = 0;
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
      if (disposed || !claudeEnabled() || resumeActive) return;
      const held = automationGate.blocker("autoResume");
      if (held) {
        log(`auto-resume skipped: ${held}`);
        return;
      }
      const queue = inThisWindow(sweepQueue(lastAllViews, autoResumeOverrides(), autoResumeAll()));
      if (!queue.length) return; // every window sweeps its own sessions; one without any stays silent
      vscode.window.showInformationMessage("Claude Sessions: limit reset — starting auto resume sweep.");
      startResumeSweep(queue, "autoResume");
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
    endSweep?.();
    endSweep = undefined;
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
    const activeId = accountsFile.activeId ?? null;
    const activeOwn = snap && !snap.acct && activeId ? readOfficialSnapshot(officialUsageFileFor(activeId)) : undefined;
    const snapAcct = snap ? snapshotAccount(snap, activeId, activeChangedAtMs, activeOwn) : null;
    if (!force && snap?.gauges.length && snap.ts && snapAcct === activeId && (!officialUsage || officialUsageAcct !== snapAcct || snap.ts > officialUsage.ts)) {
      officialUsage = { gauges: snap.gauges, ts: snap.ts }; // another window fetched it for this login
      officialUsageAcct = snapAcct;
      if (activeId) usageFail.delete(activeId);
    }
    const inBackoff = !force && !!snap?.backoffUntil && now < snap.backoffUntil;
    if (inBackoff) {
      usageNote = RATE_LIMITED_NOTE;
      if (activeId) usageFail.set(activeId, { kind: "rate_limited", httpStatus: 429 });
    } else if (usageNote?.startsWith("usage API rate-limited")) {
      usageNote = null;
    }
    if (!allowed("usagePolls")) {
      if (force) pushUsagePayload();
      return; // observer mode: only what the other windows' polls saved (adopted above on every tick)
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
      const r = await fetchOfficialUsage(usageReq(creds.token));
      if (!r.ok && (r.status === 401 || r.status === 403)) {
        cachedCreds = undefined; // token rotated -> re-read keychain
        if (activeId) usageFail.set(activeId, { kind: "auth", httpStatus: r.status });
      }
      const nowSec = Date.now() / 1000;
      const cur = readOfficialSnapshot() ?? { gauges: [], ts: 0 };
      if (r.ok) {
        // Record which account this usage belongs to: registry entry, per-account
        // snapshot, and (when enabled) the token vault that lets the extension
        // keep refreshing this account after the user logs into another one.
        const ident = (await readActiveIdentity(creds.token)) ?? { id: "default", email: "this account" };
        officialUsage = r.usage;
        officialUsageAcct = ident.id;
        usageNote = null;
        writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: nowSec, acct: ident.id }); // clears backoff
        log(`usage ok${force ? " (manual)" : ""}: ${r.usage.gauges.map((g) => `${g.key}=${Math.round(g.pct)}`).join(" ")}`);
        const reg = upsertActiveAccount(readAccountsFile(), { ...ident, tokenExpiresAt: creds.expiresAt, tier: creds.tier }, nowSec);
        // A fetch that raced an account switch (old token) keeps its usage but must not undo the switch.
        setAccounts(activeNow && activeNow.id !== ident.id ? { ...reg, activeId: activeNow.id } : reg);
        writeAccountsFile(accountsFile);
        usageByAccount.set(ident.id, { usage: r.usage, stale: false });
        writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: nowSec }, officialUsageFileFor(ident.id));
        usageFail.delete(ident.id);
        if (r.resets) storeResets(ident.id, r.usage.ts, r.resets);
        if (await captureWanted(ident, creds)) captureRetry = true; // vaulted by captureActiveLogin (fresh reads + settle window)
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
        maybeAutoRotate();
      } else if (r.status === 429) {
        const b = nextUsageBackoffSec(r.retryAfterSec);
        writeOfficialSnapshot({ ...cur, attemptTs: nowSec, backoffUntil: nowSec + b, backoffSec: b });
        usageNote = RATE_LIMITED_NOTE;
        if (activeId) usageFail.set(activeId, { kind: "rate_limited", httpStatus: 429 });
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
      // Without claude-switch its vault is never read, seeded or created: our own refresh keeps passive tokens alive.
      const cliPresent = switchInstalled();
      for (const a0 of others) {
        let a = a0;
        const file = officialUsageFileFor(a.id);
        const snap = readOfficialSnapshot(file);
        const nowSec = Date.now() / 1000;
        const known = usageByAccount.get(a.id);
        if (snap?.gauges.length && snap.ts && (!known?.usage || snap.ts > known.usage.ts)) {
          usageByAccount.set(a.id, { usage: { gauges: snap.gauges, ts: snap.ts }, stale: !!snap.tokenStale });
          usageFail.delete(a.id);
          changed = true; // another window fetched it
        }
        if (!allowed("usagePolls")) continue; // observer mode: only what the other windows' polls saved
        let vault = await readVaultOauth(a.id);
        const cliBlob = cliPresent ? await readCliVault(a.id, log) : null;
        const cliOauth = cliBlob?.claudeAiOauth;
        const seatTier = cliOauth ? claudePlanTier(cliOauth.rateLimitTier, cliOauth.subscriptionType, cliBlob?.oauthAccount?.seatTier) : undefined;
        if (seatTier && seatTier !== a.tier && allowed("accountWrites")) {
          // The plan label (and the panel's price order) follows the CLI vault's seat tier, also for never-active logins.
          const f = readAccountsFile();
          setAccounts({ ...f, accounts: f.accounts.map((x) => (x.id === a.id ? { ...x, tier: seatTier } : x)) });
          writeAccountsFile(accountsFile);
          a = accountsFile.accounts.find((x) => x.id === a.id) ?? a;
          changed = true;
        }
        const source = decidePassiveSource(vault, cliOauth);
        let seeded = false;
        let cliToken: string | undefined;
        if (cliOauth && source === "use-cli") {
          // The CLI keeper owns this token: poll with it and mirror it into our own vault.
          cliToken = cliOauth.accessToken;
          if (vault?.refreshToken !== cliOauth.refreshToken || vault?.accessToken !== cliOauth.accessToken || vault?.expiresAt !== cliOauth.expiresAt) {
            try {
              await ctx.secrets.store(vaultOauthKey(a.id), JSON.stringify(cliOauth));
              if (cliOauth.accessToken) await ctx.secrets.store(`csm.token.${a.id}`, cliOauth.accessToken);
            } catch (e) {
              log("oauth vault store failed: " + String(e));
            }
            vault = cliOauth;
            const f = readAccountsFile();
            setAccounts({
              ...f,
              accounts: f.accounts.map((x) => (x.id === a.id ? { ...withoutNeedsLogin(x), tokenExpiresAt: cliOauth.expiresAt } : x)),
            });
            writeAccountsFile(accountsFile);
            a = accountsFile.accounts.find((x) => x.id === a.id) ?? a;
            changed = true;
          }
        } else if (cliPresent && vault && source === "use-own-and-seed" && shouldSeed(seededRefreshTokens.get(a.id), vault.refreshToken)) {
          let ident: Record<string, unknown> | undefined;
          try {
            ident = parseJsonObject(await ctx.secrets.get(vaultIdentKey(a.id)));
          } catch {
            ident = undefined;
          }
          seeded = await writeCliVault(a.id, buildSeedBlob(vault, ident, Date.now()), log);
          if (seeded) {
            seededRefreshTokens.set(a.id, vault.refreshToken);
            log(`cli vault seeded (acct ${a.id.slice(0, 8)})`);
          }
        }
        // The keeper owns refresh as soon as the CLI vault holds this account; our own refresh stays only for machines without it.
        const keeperOwns = cliPresent && (!!cliOauth || seeded || seededRefreshTokens.has(a.id));
        if (!keeperOwns && keeperWaiting.delete(a.id)) changed = true; // our own refresh owns it (again): no keeper note
        if (vault && healNeedsLogin(a, vault)) changed = true;
        if (keeperOwns) {
          if (a.needsLogin && source === "use-cli") {
            const f = readAccountsFile();
            setAccounts({ ...f, accounts: f.accounts.map((x) => (x.id === a.id ? withoutNeedsLogin(x) : x)) });
            writeAccountsFile(accountsFile);
            a = accountsFile.accounts.find((x) => x.id === a.id) ?? a;
          }
          const best = source === "use-cli" ? cliOauth : vault;
          if (typeof best?.expiresAt === "number" && Date.now() > best.expiresAt) {
            if (!keeperWaiting.has(a.id)) log(`acct ${a.id.slice(0, 8)}: tokens expired, waiting for claude-switch keeper`);
            keeperWaiting.add(a.id);
            const cur = usageByAccount.get(a.id);
            if (cur && !cur.stale) usageByAccount.set(a.id, { usage: cur.usage, stale: true });
            changed = true;
            continue;
          }
          if (keeperWaiting.delete(a.id)) changed = true;
        } else if (vault && needsRefresh(vault, Date.now(), REFRESH_MARGIN_MS) && (await refreshStoredAccount(a.id, vault, force))) {
          a = accountsFile.accounts.find((x) => x.id === a.id) ?? a;
          changed = true;
        }
        if (!keeperOwns && a.tokenExpiresAt != null && Date.now() > a.tokenExpiresAt) {
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
        if (inBackoff && !usageFail.has(a.id)) {
          usageFail.set(a.id, snap?.tokenStale ? { kind: "auth" } : { kind: "rate_limited", httpStatus: 429 }); // this or another window's poll failed
          changed = true;
        }
        if (freshEnough || attempted || inBackoff) continue;
        let token: string | undefined = cliToken;
        try {
          if (!token) token = await ctx.secrets.get(`csm.token.${a.id}`);
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
        let r = await fetchOfficialUsage(usageReq(token));
        if (!r.ok && (r.status === 401 || r.status === 403) && !keeperOwns) {
          const v2 = await readVaultOauth(a.id);
          const t2 = v2 ? await refreshStoredAccount(a.id, v2, true) : undefined;
          if (t2) r = await fetchOfficialUsage(usageReq(t2));
        }
        const now2 = Date.now() / 1000;
        const cur2 = readOfficialSnapshot(file) ?? { gauges: [], ts: 0 };
        if (r.ok) {
          usageByAccount.set(a.id, { usage: r.usage, stale: false });
          writeOfficialSnapshot({ gauges: r.usage.gauges, ts: r.usage.ts, attemptTs: now2 }, file);
          usageFail.delete(a.id);
          if (r.resets) storeResets(a.id, r.usage.ts, r.resets);
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
          usageFail.set(a.id, { kind: "auth", httpStatus: r.status });
          changed = true;
          log(`usage acct ${a.id.slice(0, 8)}: token rejected (${r.status})`);
        } else if (r.status === 429) {
          const b = nextUsageBackoffSec(r.retryAfterSec);
          writeOfficialSnapshot({ ...cur2, attemptTs: now2, backoffUntil: now2 + b, backoffSec: b }, file);
          usageFail.set(a.id, { kind: "rate_limited", httpStatus: 429 });
          changed = true;
        }
      }
    } catch (e) {
      log("pollOtherAccounts error: " + String(e));
    } finally {
      othersInflight = false;
    }
    if (changed) pushUsagePayload();
  }

  // --- Account rotation (pure logic in src/rotation.ts) ---------------------
  let lastSwitchTs = 0;
  let switchInflight = false;
  const seededRefreshTokens = new Map<string, string | undefined>(); // accountId -> refresh token last seeded into the CLI vault
  const refreshFailTs = new Map<string, number>(); // accountId -> ms of the last failed refresh
  const httpFetch: FetchLike = (url, init) => fetch(url, init);

  async function readVaultOauth(id: string): Promise<OAuthBlob | undefined> {
    try {
      return parseJsonObject(await ctx.secrets.get(vaultOauthKey(id))) as OAuthBlob | undefined;
    } catch {
      return undefined;
    }
  }

  // --- Login capture (pure decisions in src/capture.ts) ----------------------
  let captureInflight = false;
  let captureForceQueued = false; // a forced capture arrived mid-pass: the next pass runs forced
  let captureRetry = false; // fresh keychain read wanted on the next tick (failed store, mid-read switch, usage-poll nudge)
  let captureFails = 0; // consecutive failed stores: only the first one schedules that retry
  let captureMidReadRetried = false; // the account changed during the last keychain read and was re-read once
  let captureMtimeMs: number | undefined; // ~/.claude.json mtime seen on the last tick
  let captureIdent: ActiveIdentity | undefined; // its parsed oauthAccount (change probe only)
  let captureKcTs = 0; // ms of the capture loop's last fresh keychain read
  let captureDirty = false; // oauthAccount edited (same account) since that read: read within 5 s
  let capturePending: PendingCapture | null = null; // changed login waiting out the settle window

  /** Other accounts whose vaulted blob holds this refresh token (stale data or an earlier mismatched pair). */
  async function vaultOwners(id: string, refreshToken: string | undefined): Promise<string[]> {
    if (!refreshToken) return [];
    const owners: string[] = [];
    for (const a of readAccountsFile().accounts) {
      if (a.id !== id && (await readVaultOauth(a.id))?.refreshToken === refreshToken) owners.push(a.id);
    }
    return owners;
  }

  /** True when the keychain blob differs from what is vaulted for this identity. */
  async function captureWanted(ident: ActiveIdentity, creds: ClaudeCredentials): Promise<boolean> {
    if (!trackAllAccounts()) return false;
    const vaulted = (await readVaultOauth(ident.id)) ?? null;
    return decideCapture({ identity: ident, keychain: creds.oauth ?? null, vaulted }) === "store";
  }

  /**
   * Write a settled login under `ident.id`. The pair held for the settle window
   * (30 s when `owners` is non-empty), so ~/.claude.json is trusted: the same
   * refresh token vaulted under another id is moved here (that id's entries are
   * deleted). False when a store failed.
   */
  async function writeVault(ident: ActiveIdentity, creds: ClaudeCredentials, owners: string[]): Promise<boolean> {
    const rt = creds.oauth?.refreshToken;
    try {
      await ctx.secrets.store(`csm.token.${ident.id}`, creds.token);
      await ctx.secrets.store(vaultOauthKey(ident.id), JSON.stringify(creds.oauth));
      if (ident.block) await ctx.secrets.store(vaultIdentKey(ident.id), JSON.stringify(ident.block));
      for (const other of owners) {
        if ((await readVaultOauth(other))?.refreshToken !== rt) continue;
        await ctx.secrets.delete(vaultOauthKey(other));
        await ctx.secrets.delete(vaultIdentKey(other));
        await ctx.secrets.delete(`csm.token.${other}`);
        log(`capture: moved vault entry from ${other.slice(0, 8)} to ${ident.id.slice(0, 8)} after a 30 s settle`);
      }
    } catch (e) {
      log(`capture: vault store failed (acct ${ident.id.slice(0, 8)}): ${String(e)}`);
      return false;
    }
    return true;
  }

  /**
   * The one code path that vaults the active login. Takes a pair read FRESH on
   * this tick (keychain + ~/.claude.json), stores only once the settle window
   * confirmed the pair (3 s; 30 s when the token would move from another id),
   * then records the account in the registry (which clears needsLogin).
   */
  async function vaultActiveLogin(ident: ActiveIdentity, creds: ClaudeCredentials): Promise<"stored" | "skipped" | "waiting" | "failed"> {
    if (!(await captureWanted(ident, creds))) {
      capturePending = null;
      return "skipped";
    }
    const rt = creds.oauth?.refreshToken;
    const owners = await vaultOwners(ident.id, rt);
    const minMs = owners.length ? CAPTURE_MOVE_SETTLE_MS : CAPTURE_SETTLE_MS;
    const settle = settleCapture(capturePending, { accountUuid: ident.id, refreshToken: rt }, Date.now(), minMs);
    capturePending = settle.pending;
    if (settle.action === "wait") return "waiting";
    if (!(await writeVault(ident, creds, owners))) return "failed";
    refreshFailTs.delete(ident.id);
    setAccounts(
      upsertActiveAccount(
        readAccountsFile(),
        { id: ident.id, email: ident.email, tokenExpiresAt: creds.expiresAt, tier: creds.tier },
        Date.now() / 1000,
      ),
    );
    writeAccountsFile(accountsFile);
    log(`capture: vaulted login (acct ${ident.id.slice(0, 8)})`);
    return "stored";
  }

  /**
   * Follow ~/.claude.json through its mtime (parse only on change). True when
   * the logged-in account changed; an edited oauthAccount of the same account
   * marks captureDirty; unrelated rewrites (every few seconds) change nothing.
   */
  async function noteClaudeJson(mtimeMs: number | undefined): Promise<boolean> {
    if (mtimeMs === captureMtimeMs) return false;
    captureMtimeMs = mtimeMs;
    const ident = mtimeMs === undefined ? undefined : await readIdentityFileAt(mtimeMs);
    const change = classifyIdentityChange(captureIdent, ident);
    captureIdent = ident;
    if (change === "block") captureDirty = true;
    return change === "account";
  }

  /** Read keychain then ~/.claude.json fresh (never mtime-cached) and hand the pair to vaultActiveLogin. */
  async function captureFreshPair(now: number): Promise<void> {
    const before = captureIdent;
    const creds = before ? await readClaudeCredentials() : undefined;
    const ident = creds ? await readIdentityFile() : undefined;
    if (!creds || !ident) {
      capturePending = null;
      return;
    }
    cachedCreds = { creds, ts: now / 1000 };
    if (ident.id !== before?.id && !captureMidReadRetried) {
      captureMidReadRetried = true; // account switched during the keychain read: re-read once on the next tick
      captureRetry = true;
      return;
    }
    captureMidReadRetried = false;
    const res = await vaultActiveLogin(ident, creds);
    if (res === "stored" || res === "skipped") captureFails = 0;
    else if (res === "failed" && ++captureFails === 1) captureRetry = true; // retry once on the next tick
  }

  /**
   * Called every tick: stat ~/.claude.json; when the account or its oauthAccount
   * changed, a settle confirmation is due, or 60 s passed, read the login fresh
   * (captureFreshPair), so a /login is captured even while the usage API is
   * rate-limited.
   */
  async function captureActiveLogin(force: boolean): Promise<void> {
    if (!allowed("accountWrites") || switchInflight || !trackAllAccounts() || process.platform !== "darwin") return;
    if (captureInflight) {
      if (force) captureForceQueued = true; // don't drop a manual refresh: the next pass runs forced
      return;
    }
    captureInflight = true;
    try {
      const forced = force || captureForceQueued;
      captureForceQueued = false;
      const now = Date.now();
      const uuidChanged = await noteClaudeJson(await claudeJsonMtimeMs());
      if (uuidChanged) cachedCreds = undefined; // another login: drop the 300 s keychain cache
      const retry = captureRetry;
      captureRetry = false;
      const confirm = !!capturePending && now - capturePending.observedAt >= capturePending.holdMs;
      const stale = (captureDirty && now - captureKcTs >= 5_000) || now - captureKcTs >= 60_000;
      if (!(forced || uuidChanged || retry || confirm || stale)) return;
      captureKcTs = now;
      captureDirty = false;
      await captureFreshPair(now);
    } catch (e) {
      log("capture error: " + String(e));
    } finally {
      captureInflight = false;
    }
  }

  /** Clear needsLogin once the vault no longer holds the rejected token (another window refreshed it); true when cleared. */
  function healNeedsLogin(a: AccountInfo, vault: OAuthBlob): boolean {
    if (!a.needsLogin || refreshBlocked(a, vault.refreshToken)) return false;
    const f = readAccountsFile(); // fresh read: another window may have written the registry
    setAccounts({ ...f, accounts: f.accounts.map((x) => (x.id === a.id ? withoutNeedsLogin(x) : x)) });
    writeAccountsFile(accountsFile);
    log(`needsLogin cleared (acct ${a.id.slice(0, 8)}): vault holds a newer refresh token`);
    return true;
  }

  /**
   * Transient failure (429, 5xx, network): retry after the 10-minute backoff.
   * Permanent (invalid_grant) only when the vault STILL holds the token that was
   * sent: otherwise another window rotated the single-use refresh token first.
   * A permanent failure flags needsLogin (+ token fingerprint) so background
   * refresh stops until the vault holds a different token or a new login.
   */
  async function recordRefreshFailure(
    id: string,
    sentRefreshToken: string | undefined,
    r: { permanent: boolean; status: number | null; snippet: string },
  ): Promise<void> {
    const permanent = r.permanent && (await readVaultOauth(id))?.refreshToken === sentRefreshToken;
    const kind = permanent ? "permanent" : r.permanent ? "transient: vault rotated elsewhere" : "transient";
    log(`oauth refresh failed (acct ${id.slice(0, 8)}, ${kind}): HTTP ${r.status ?? "-"} ${r.snippet}`);
    if (!permanent) {
      refreshFailTs.set(id, Date.now());
      return;
    }
    refreshFailTs.delete(id);
    const f = readAccountsFile(); // another window may have a fresher registry
    const flag = { needsLogin: true, needsLoginFp: tokenFingerprint(sentRefreshToken) };
    setAccounts({ ...f, accounts: f.accounts.map((x) => (x.id === id ? { ...x, ...flag } : x)) });
    writeAccountsFile(accountsFile);
    const cur = usageByAccount.get(id);
    usageByAccount.set(id, { usage: cur?.usage ?? null, stale: true });
  }

  /**
   * Refresh an INACTIVE account's stored token pair (never the active login:
   * Claude Code owns that one). Returns the new access token, or undefined on
   * failure (the existing stale/backoff handling then applies).
   */
  async function refreshStoredAccount(id: string, oauth: OAuthBlob, force: boolean): Promise<string | undefined> {
    if (id === accountsFile.activeId) return undefined;
    const entry = accountsFile.accounts.find((x) => x.id === id);
    if (entry && refreshBlocked(entry, oauth.refreshToken)) return undefined; // rejected token still vaulted: wait for a new login
    const failed = refreshFailTs.get(id);
    if (!force && failed && Date.now() - failed < 10 * 60_000) return undefined;
    const r = await refreshOAuth(oauth, httpFetch, Date.now());
    if (!r.ok) {
      await recordRefreshFailure(id, oauth.refreshToken, r);
      return undefined;
    }
    const next = r.blob;
    refreshFailTs.delete(id);
    try {
      await ctx.secrets.store(vaultOauthKey(id), JSON.stringify(next));
      await ctx.secrets.store(`csm.token.${id}`, next.accessToken);
    } catch (e) {
      log("oauth vault store failed: " + String(e));
    }
    setAccounts({
      ...accountsFile,
      accounts: accountsFile.accounts.map((x) => (x.id === id ? { ...withoutNeedsLogin(x), tokenExpiresAt: next.expiresAt } : x)),
    });
    writeAccountsFile(accountsFile);
    const file = officialUsageFileFor(id);
    const snap = readOfficialSnapshot(file);
    if (snap?.tokenStale) {
      const { tokenStale: _t, backoffUntil: _b, backoffSec: _s, ...rest } = snap;
      writeOfficialSnapshot(rest, file);
    }
    const cur = usageByAccount.get(id);
    if (cur?.stale) usageByAccount.set(id, { usage: cur.usage, stale: false });
    log(`oauth refreshed (acct ${id.slice(0, 8)})`);
    return next.accessToken;
  }

  function securityExec(args: string[]): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      // Never propagate `err` itself: execFile errors embed the full argv (which
      // may carry credentials) in err.message/err.cmd. Report code + stderr only.
      execFile("security", args, { encoding: "utf8", timeout: 8000 }, (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code ?? "error";
          reject(new Error(`security ${args[0]} failed (${String(code)}): ${String(stderr || "").trim().slice(0, 200)}`));
        } else resolve(String(stdout).trim());
      });
    });
  }

  const switchDeps: SwitchDeps = {
    lock: () => acquireSwitchLock(path.join(MONITOR_DIR, "account-switch.lock")),
    readKeychain: async () => {
      const user = process.env.USER || os.userInfo().username || "";
      try {
        return await securityExec(["find-generic-password", "-a", user, "-w", "-s", KEYCHAIN_SERVICE]);
      } catch {
        return undefined;
      }
    },
    writeKeychain: async (json) => {
      const user = process.env.USER || os.userInfo().username || "";
      // Hex-encoded (-X) exactly like the Claude CLI writes it; argv exposure is identical to the CLI's own login.
      await securityExec(["add-generic-password", "-U", "-a", user, "-s", KEYCHAIN_SERVICE, "-X", Buffer.from(json, "utf8").toString("hex")]);
    },
    getSecret: async (k) => ctx.secrets.get(k),
    setSecret: async (k, v) => ctx.secrets.store(k, v),
    readClaudeJson: async () => {
      try {
        return await fs.promises.readFile(`${os.homedir()}/.claude.json`, "utf8");
      } catch {
        return undefined;
      }
    },
    writeClaudeJson: async (text) => {
      const file = `${os.homedir()}/.claude.json`;
      const tmp = `${file}.csm-${process.pid}.tmp`;
      let mode = 0o600;
      try {
        mode = (await fs.promises.stat(file)).mode & 0o777;
      } catch {
        /* keep default */
      }
      await fs.promises.writeFile(tmp, text, { mode });
      await fs.promises.rename(tmp, file);
    },
    fetchFn: httpFetch,
    now: () => Date.now(),
  };

  async function switchToAccount(targetId: string, auto = false): Promise<void> {
    if (!(auto ? allowed("rotation") : observer.actionAllowed("accountWrites"))) return; // observer mode: no keychain or ~/.claude.json write
    if (process.platform !== "darwin") {
      vscode.window.showErrorMessage("Agent Sessions: switching Claude accounts is only supported on macOS.");
      return;
    }
    if (switchInflight) return;
    setAccounts(readAccountsFile());
    const target = accountsFile.accounts.find((a) => a.id === targetId);
    if (!target) {
      vscode.window.showErrorMessage("Agent Sessions: unknown Claude account.");
      return;
    }
    if (target.id === accountsFile.activeId) {
      vscode.window.showInformationMessage(`Agent Sessions: already on ${target.email}.`);
      return;
    }
    switchInflight = true;
    try {
      const r = await performSwitch(switchDeps, targetId, target.email);
      if (!r.ok) {
        vscode.window.showErrorMessage(`Agent Sessions: ${r.error}`);
        return;
      }
      if (r.refreshed?.accessToken) {
        await ctx.secrets.store(`csm.token.${targetId}`, r.refreshed.accessToken);
      }
      lastSwitchTs = Date.now();
      setAccounts({ ...readAccountsFile(), activeId: targetId });
      writeAccountsFile(accountsFile);
      cachedCreds = undefined;
      identityCache = undefined;
      vscode.window.showInformationMessage(
        `${auto ? "Auto-rotate: s" : "S"}witched Claude Code to ${r.email}. New sessions use it; running sessions switch at their next token refresh.`,
      );
      await pollUsage(true);
    } catch (e) {
      log("switch failed: " + String(e));
      vscode.window.showErrorMessage(`Agent Sessions: could not switch accounts (${String(e)})`);
    } finally {
      switchInflight = false;
    }
  }

  function maybeAutoRotate(): void {
    if (!allowed("rotation")) return;
    const c = cfg();
    const rc = {
      autoRotate: autoRotateOn(c.get<boolean>("autoRotate", false), switchInstalled()), // claude-switch rotates by itself
      rotateAtPercent: c.get<number>("rotateAtPercent", 90),
    };
    if (!rc.autoRotate || switchInflight) return;
    const views = currentAccountCtx().accounts;
    const active = views.find((a) => a.active);
    const best = pickBestAccount(views);
    if (!active || !best || !shouldAutoRotate(active, best, rc, lastSwitchTs, Date.now())) return;
    if (readAccountsFile().activeId !== active.id) return; // another window already switched
    void switchToAccount(best.id, true);
  }

  async function pickAndSwitchAccount(): Promise<void> {
    const views = currentAccountCtx().accounts;
    if (!views.length) {
      vscode.window.showInformationMessage("Agent Sessions: only one Claude account is known. Log in with another one (claude /login) first.");
      return;
    }
    const bestId = pickBestAccount(views)?.id;
    const picked = await vscode.window.showQuickPick(
      views.map((v) => ({
        label: `${v.stale ? "$(circle-slash) " : ""}${v.email}${v.active ? " (active)" : ""}${v.id === bestId ? " ★" : ""}`,
        description: v.stale ? "(needs /login)" : remainingSummary(v.gauges),
        id: v.id,
      })),
      { placeHolder: "Switch Claude Code to which account?" },
    );
    if (picked) await switchToAccount(picked.id);
  }

  async function rotateToBest(): Promise<void> {
    const views = currentAccountCtx().accounts;
    const best = pickBestAccount(views);
    if (!best) {
      vscode.window.showInformationMessage("Agent Sessions: no other Claude account with usage data to rotate to.");
      return;
    }
    if (best.active) {
      vscode.window.showInformationMessage("Already on the account with the most headroom");
      return;
    }
    await switchToAccount(best.id);
  }

  // --- Active login (pure resolution in src/activeAccount.ts) ---------------
  // ~/.claude.json oauthAccount (a stat per tick, parsed on change) and a fresh
  // claude-switch panel.json (only with its CLI installed) both name the active login; the fresher one becomes
  // the registry's activeId right away. A usage fetch or a vault write used to be
  // the only way to move it, and after a claude-switch switch neither happens:
  // the usage API 429s the newly active token and the token is already vaulted.
  let ownActive: ActiveCandidate | undefined; // last ~/.claude.json read that had an identity
  let activeNow: ActiveCandidate | undefined; // the last resolved active login
  let activeRuns = 0; // syncActive calls started
  let activeApplied = 0; // newest call that resolved: an older one finishing later is dropped
  let activeInflight = 0;

  /** Re-resolve the active login (a tick skips while another call runs; `force` never does); true when activeId moved. */
  async function syncActive(force = false): Promise<boolean> {
    if (!force && activeInflight) return false;
    const run = ++activeRuns;
    activeInflight++;
    try {
      const mtimeMs = await claudeJsonMtimeMs();
      const ident = mtimeMs === undefined ? undefined : await readIdentityFileAt(mtimeMs);
      if (run < activeApplied) return false;
      activeApplied = run;
      if (ident && mtimeMs !== undefined) ownActive = { id: ident.id, email: ident.email, atMs: mtimeMs, source: "claude.json" };
      activeNow = pickActive(ownActive, panelActive(installedPanel(), Date.now()));
      return activeNow ? applyActive(activeNow) : false;
    } finally {
      activeInflight--;
    }
  }

  /** Make `next` the registry's active login when it is not already; the next usage poll re-reads the keychain. */
  function applyActive(next: ActiveCandidate): boolean {
    if (next.id === accountsFile.activeId) return false;
    const disk = readAccountsFile();
    setAccounts(markActive(disk, next, Date.now() / 1000));
    if (!alreadyActive(disk, next.id) && allowed("accountWrites")) writeAccountsFile(accountsFile); // every window follows the switch within a tick: only the first one writes
    cachedCreds = undefined; // the keychain holds the new login's token now
    const snap = readOfficialSnapshot(officialUsageFileFor(next.id)); // another window may have polled it more recently
    const known = usageByAccount.get(next.id);
    if (snap?.gauges.length && snap.ts && (!known?.usage || snap.ts > known.usage.ts)) {
      usageByAccount.set(next.id, { usage: { gauges: snap.gauges, ts: snap.ts }, stale: !!snap.tokenStale });
    }
    log(`active: ${next.email} (acct ${next.id.slice(0, 8)}, from ${next.source})`);
    return true;
  }

  /**
   * Resolve the account list the panel renders (one card each) and the active
   * login, whose gauges drive the burn-rate ETA and history.
   */
  function currentAccountCtx(): AccountCtx & { usage: OfficialUsage | null } {
    const activeId = accountsFile.activeId ?? null;
    const track = trackAllAccounts();
    // Mirror the live poll into the active card, unless a background poll (any window) fetched this account more recently.
    const own = activeId ? usageByAccount.get(activeId)?.usage ?? null : null;
    if (activeId && officialUsage && officialUsageAcct === activeId && newerUsage(officialUsage, own) === officialUsage) usageByAccount.set(activeId, { usage: officialUsage, stale: false });
    const selId = activeId;
    const list = track ? accountsFile.accounts : accountsFile.accounts.filter((a) => a.id === activeId);
    const labels = accountPillLabels(list.map((a) => a.email));
    const skip = excludedEmails(installedPanel()); // claude-switch's skip boxes: no automatic pick (best, Rotate, auto-rotate) lands on one
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
        plan: planLabelFor(a.email) ?? claudePlanLabel(a.tier),
        stale:
          a.id === activeId
            ? false
            : (e?.stale ?? false) || a.needsLogin === true || (a.tokenExpiresAt != null && Date.now() > a.tokenExpiresAt),
        needsLogin: a.id !== activeId && a.needsLogin === true,
        excluded: skip.has(a.email.toLowerCase()),
      };
    });
    return {
      accounts: accounts.length > 1 ? accounts : [],
      selectedId: selId,
      activeId,
      selectedStale: accounts.find((v) => v.id === selId)?.stale ?? false,
      usage: activeUsage(),
    };
  }

  /** The active login's usage for the panel, the status bar and auto-resume: the newer of its live poll and its last per-account fetch. */
  function activeUsage(): OfficialUsage | null {
    return usageForActive(accountsFile.activeId ?? null, { usage: officialUsage, acct: officialUsageAcct }, usageByAccount);
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
    let changed = false;
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
        changed = codexSignature(next) !== codexSignature(codexSnapshot);
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
    if (!disposed && changed) autoRefresh(); // an unchanged poll leaves the redraw to the timer
  }

  /** Rebuild the sessions table payload (grouping, per-row stats, badge) and post it. */
  function pushSessions(views: SessionView[], allViews: SessionView[] = views): void {
    // Token hog: the biggest 5h consumer, only when it is a meaningful share.
    let hogId: string | null = null;
    if (burnShareBySession) {
      hogId = burnHogId; // priced and with subagents, so it decides once it is available
    } else if (tokenUsage?.bySession5h) {
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
          projectStrip && projectFilter !== "all" ? projectFilter : "",
        ]
          .filter(Boolean)
          .join(" · "),
        cfg().get<number>("cpuHogThreshold", 60),
        countProviders(allViews),
        providerFilter,
        enabledProviders().map((provider) => {
          if (provider === "codex") return codexSnapshot.health;
          const notice = automationGate.notice(); // Claude Code failed the compatibility check
          return { provider: "claude", state: notice ? ("degraded" as const) : ("ready" as const), message: notice, updatedAt: Date.now() / 1000 };
        }),
        views.length
          ? ""
          : enabledProviders().length === 0
            ? "Both providers are disabled. Enable Claude or Codex in Settings."
            : providerFilter !== "all" || needsYouOnly || (projectStrip && projectFilter !== "all")
              ? "No sessions match the active filters."
              : "No recent Claude or Codex sessions. Start one and it will appear here.",
        burnShareBySession,
        projectStrip,
      ),
    );
    let badge = 0;
    for (const v of views) {
      const g = groupOf(v);
      if (g === "limited" || g === "waiting") badge++;
    }
    sessionsView.setBadge(badge, `${badge} session(s) waiting / limited`);
  }

  // Limit burn tick: tail the transcripts, turn spend into 5h-limit percent with
  // the account's own gauge history, and push the ranked list to the Burn tab.
  async function burnTick(): Promise<void> {
    try {
      await burnTracker.refresh();
      if (disposed) return;
      const nowMs = Date.now();
      const samples = gaugeSamplesFromHistory(readLimitsHistory(240));
      const latest = samples.length ? samples[samples.length - 1] : null;
      const fresh = calibrate(samples, burnTracker.records(), { sinceTs: nowMs - BURN_HORIZON_MS });
      const resolved = resolveScale(fresh, latest?.acct ?? null, burnScaleCache);
      if (resolved.cache !== burnScaleCache) {
        burnScaleCache = resolved.cache;
        void ctx.globalState.update("burnScaleByAcct", burnScaleCache);
      }
      const summary5h = burnTracker.summary(5 * 3_600_000);
      const top = summary5h.sessions[0];
      burnShareBySession = burnShares(summary5h);
      burnHogId = top && top.share >= 0.25 && top.cost >= 10 ? top.sessionId : null;
      const listed = new Map(
        lastAllViews.filter((v) => v.provider === "claude").map((v) => [v.sessionId, v] as const),
      );
      limitsView.updateBurn(
        buildBurnPayload({
          summary: burnTracker.summary(burnWindowMs),
          scale: resolved.scale,
          sessionPct: latest && nowMs - latest.ts <= 600_000 ? latest.pct : null,
          nowMs,
          lookup: (id) => {
            const v = listed.get(id);
            if (v) return { title: v.title, openId: v.key, ended: groupOf(v) === "ended" };
            const dir = path.basename(burnTracker.cwdOf(id) ?? "");
            return { title: burnTracker.titleOf(id) ?? `${dir || "session"} ${id.slice(0, 8)}`, openId: "", ended: true };
          },
        }),
      );
    } catch (e) {
      log("burn tick error: " + String(e));
    }
  }

  /** syncActive for ticks and watchers: re-render when the active login moved, or always when asked. */
  function followActive(always = false): void {
    void syncActive().then(
      (moved) => {
        if (moved || always) pushUsagePayload();
      },
      (e: unknown) => log("active sync error: " + String(e)),
    );
  }

  function pushUsagePayload(): void {
    try {
      const c = currentAccountCtx();
      const payload = buildLimitsPayload(
          lastAllViews,
          tokenUsage,
          c.usage,
          usageNote,
          c,
          codexEnabled() ? codexSnapshot : null,
          enabledProviders(),
          planLabels(),
          showTokenStats(),
      );
      const installed = switchInstalled(); // without claude-switch: no block, no badges, the generic cards
      const panel = installed ? readPanel() : null;
      const fresh = panelFresh(panel, Date.now());
      const savedTab = ctx.workspaceState.get<unknown>("csm.limitsTab");
      const emailById = new Map(payload.accounts.map((a) => [a.id, a.email] as const));
      let providers = decorateCards(payload.providers).map((p) => ({ ...p, email: p.accountId ? emailById.get(p.accountId) ?? p.label.replace(/^Claude · /, "") : p.label.replace(/^(Claude|Codex) · /, "") }));
      if (fresh) {
        providers = orderCards(providers, panel, (p) => planPrice(p.plan));
        const claudeNames = displayNames(providers.filter((p) => p.provider === "claude").map((p) => p.email ?? p.label));
        let ci = 0;
        const badges = allBadges(panel);
        providers = providers.map((p) => {
          const email = p.email ?? p.label;
          const b = p.provider === "claude" ? badges[email] ?? {} : {};
          const hdr: CardHeader = {
            ...(b.rank !== undefined ? { rank: b.rank } : {}),
            name: p.provider === "claude" ? claudeNames[ci++] : "Codex",
            ...headerChip({ active: p.provider === "claude" && p.active, loginNeeded: !!p.loginNeeded || !!b.loginNeeded, excluded: p.provider === "claude" ? excludedOf(panel, email) : undefined, gauges: p.official ? p.gauges : [] }),
            gauges: headerGauges(p.official ? p.gauges : []),
          };
          return { ...p, hdr };
        });
      }
      limitsView.update({
        ...payload,
        providers,
        switchHtml: installed ? renderSwitchBlock(panel, Date.now(), newestReadingSec(), readQuotaEngine()) : undefined,
        switchActivity: renderSwitchActivity(panel, Date.now()) ?? undefined, // panel is null without claude-switch
        switchBadges: allBadges(panel),
        panelFresh: fresh,
        pool: fresh ? poolSummary(providers, planPrice) : undefined,
        showTokenStats: showTokenStats(),
        burnOn: claudeEnabled(),
        ui: { tab: isLimitsTab(savedTab) ? savedTab : "accounts", expandedAccounts: ctx.workspaceState.get<Record<string, boolean>>("csm.expandedAccounts", {}) },
        useEmails: fresh ? useTargets(panel) : [],
        usePending: usePending?.email,
        useResult: useDone && Date.now() < useDone.until ? { email: useDone.email, at: useDone.at, ok: useDone.ok, text: useDone.text, ...(useDone.running ? { running: true } : {}) } : undefined,
        skipFailed: skipFailed && Date.now() < skipFailed.until ? { email: skipFailed.email, at: skipFailed.at } : undefined,
        ...(installed && claudeEnabled() ? { resets: resetsPayload(providers) } : {}),
      });
      renderStatusBar();
    } catch (e) {
      stages.fail("limits", e);
    }
  }

  /** Every status bar update (panel pushes and the resource sampler) shows the active login's usage and, with 2+ accounts, its name. */
  function renderStatusBar(): void {
    const act = accountsFile.accounts.length > 1 ? accountsFile.accounts.find((a) => a.id === accountsFile.activeId) : undefined;
    updateStatusBar(
      statusBar,
      lastAllViews,
      resourceCache,
      claudeEnabled() ? activeUsage() : null,
      claudeEnabled() && act ? { name: activeName(act.email, accountsFile.accounts.map((a) => a.email)), email: act.email } : undefined,
    );
  }

  /** Every refresh is timed: the health file reports the 95th percentile of their main-thread time (health.ts). */
  async function timedRefresh(): Promise<void> {
    const clock = new BusyClock();
    try {
      await refreshOnce(clock);
    } finally {
      refreshMs.add(clock.total());
    }
  }

  async function refreshOnce(clock: BusyClock): Promise<void> {
    if (disposed) return;
    lastRefreshMs = Date.now();
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
        recentCache = await clock.wait(findRecentTranscripts(maxAgeHours * 3600 * 1000, 120, now));
      } catch {
        /* ignore */
      }
      if (disposed) return; // the window closed during an await: no file write or network call after it
      lastRecentScan = now;
    }

    if (now - lastCleanup > 600 && allowed("sharedFiles")) {
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
        const tx7 = await clock.wait(findRecentTranscripts(7 * 86400 * 1000, 400, now));
        if (disposed) return;
        tokenUsage = scanTokenUsage(tx7, now, { persist: allowed("sharedFiles") }); // observer mode reads the shared token-count cache, never writes it
      } catch {
        /* ignore */
      }
    }

    if (claudeEnabled() && now - lastBurnTick > 5) {
      lastBurnTick = now;
      void burnTick();
    }

    // Follow the active login on every tick (a stat, a parse only on change) and
    // vault it, both independent of the usage API (and its 429 backoff): a
    // keychain read only on change / every 60 s.
    if (claudeEnabled()) followActive();
    if (claudeEnabled()) void captureActiveLogin(false);

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
      // Without registry writes (observer mode) the login applyActive followed lives in memory only: keep it.
      const disk = readAccountsFile();
      setAccounts(activeNow && !allowed("accountWrites") ? markActive(disk, activeNow, now) : disk);
      const panel0 = installedPanel();
      if (panelFresh(panel0, Date.now())) {
        const merged = mergePanelAccounts(accountsFile, panel0);
        if (merged !== accountsFile) {
          setAccounts(merged);
          if (allowed("accountWrites")) writeAccountsFile(accountsFile);
        }
      }
      void pollOtherAccounts(false);
      if (resetsOn() && loadResetsFiles()) pushUsagePayload(); // Limit resets another window's polls saved
    }

    const wsOnly =
      workspaceOnlyOverride !== undefined ? workspaceOnlyOverride : c.get<boolean>("workspaceOnly", false);

    let claudeViews: SessionView[] = [];
    let collected = true;
    if (claudeEnabled()) {
      try {
        const tabLabels = vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudePanelTab).map((t) => t.label));
        claudeViews = await collector.collect({
          now,
          extraTranscripts: recentCache,
          allowedEntrypoints: DEFAULT_ENTRYPOINTS,
          maxAgeSec: maxAgeHours * 3600,
          hideEndedOlderThanSec: c.get<number>("hideEndedAfterMinutes", 30) * 60,
          workspaceCwd: wsOnly ? workspaceCwd() : undefined,
          showEnded: c.get<boolean>("showEnded", false),
          closingMarkers: c.get<boolean>("closingStatusMarkers", false),
          resumePids: resumeTerminals.livePids(),
          hasOpenTab: (labels) => labels.some((title) => tabLabels.some((label) => labelsMatchStrict(label, title))),
          onError: (sid, e) => stages.fail(`collect ${sid}`, e),
        }, clock);
      } catch (e) {
        claudeViews = [];
        collected = false;
        stages.fail("collect", e);
      }
      if (disposed) return;
    }

    let allViews = mergeProviderSessions(
      claudeViews,
      codexEnabled() ? codexSnapshot.sessions : [],
    );
    // A failed collect or another provider or workspace filter starts the drop watch over (sessionLog.ts).
    const listScope = collected ? JSON.stringify([enabledProviders(), wsOnly && workspaceCwd()]) : "collect failed";
    const dropped = stages.safe("session drops", () => sessionDrops.observe(liveKeys(allViews), listScope, Date.now()));
    if (dropped) log(dropped);
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
    const projectRules = readProjectRules(cfg().get<unknown>("projects", []));
    if (projectRules.length) {
      allViews = allViews.map((v) => ({
        ...v,
        project: projectOf(projectRules, { cwd: v.cwd, title: v.title, prompt: v.lastPrompt, refs: v.toolRefs }),
      }));
    }
    if (projectFilter !== "all" && projectFilter !== OTHER_PROJECT && !projectRules.some((r) => r.name === projectFilter)) {
      projectFilter = "all";
      void ctx.globalState.update("projectFilter", projectFilter);
    }
    lastAllViews = allViews;
    const settled = settledOverrides(autoResumeOverrides(), allViews); // a session's auto-resume choice ends with its limit
    if (settled) void ctx.globalState.update(OVERRIDES_KEY, settled);

    let views = filterProvider(allViews, providerFilter);
    projectStrip = null;
    if (projectRules.length) {
      const counts: Record<string, number> = {};
      for (const v of views) counts[v.project ?? OTHER_PROJECT] = (counts[v.project ?? OTHER_PROJECT] ?? 0) + 1;
      projectStrip = { names: projectRules.map((r) => r.name), counts, filter: projectFilter };
      if (projectFilter !== "all") views = views.filter((v) => (v.project ?? OTHER_PROJECT) === projectFilter);
    }
    if (needsYouOnly) views = views.filter((v) => NEEDS_YOU.includes(groupOf(v)));
    lastViews = views;

    if (now - lastSessLog >= SUMMARY_EVERY_SEC) {
      lastSessLog = now;
      log(sessionSummary(allViews, dismissed.size));
    }

    stages.safe("sessions", () => pushSessions(views, allViews));
    pushUsagePayload(); // reports its own errors (stage "limits")
    stages.safe("remote bridge", () => remoteBridge?.onRows(allViews));

    stages.safe("auto-resume", () => maybeScheduleAutoResume(allViews));
    stages.safe("continuity", () => continuity?.observe());
    stages.safe("tab wake", () => tabWaker?.observe());

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
    stages.safe("stuck check", () => checkStuck(allViews, stuckNotified, c, resourceCache, lastSeen));
    stages.safe("transitions", () => detectTransitions(allViews, lastSeen, firstPaintDone, c));
    firstPaintDone = true;

    if (now - lastResourceSample > Math.max(1000, c.get<number>("resourceSampleMs", 3000)) / 1000) {
      lastResourceSample = now;
      const pids = allViews.map((v) => v.pid).filter((p): p is number => !!p);
      stages.safe("sampling", () => sampleResources(pids, resourceCache, () => stages.safe("sessions", () => {
        if (disposed) return;
        renderStatusBar();
        pushSessions(lastViews, lastAllViews);
      })));
    }
  }

  type FocusedTypeResult = TypeResult;

  /**
   * Type `text` + Enter into the session whose tab the caller just showed by its
   * index (tabFocus.ts): wait up to 1 s until it is the active tab of the active
   * group, (optionally bring VS Code forward,) then type in chunks
   * (keystrokeTyping.ts): before every chunk and before Enter this window must be
   * focused, the session's tab active, VS Code frontmost and the Claude prompt
   * input focused, else typing stops without Enter. When the first check finds the
   * focus elsewhere, Claude Code's focus command runs once if that is safe
   * (refocusPrompt). `alive` aborts between steps. Each attempt logs its path
   * (promptFocus.ts). Shared by the typing sweep (activates VS Code, panel label
   * match) and the remote keystroke path (no activation, strict match).
   */
  async function typeIntoFocusedSession(
    text: string,
    submitDelayMs: number | undefined,
    alive: () => boolean,
    opts: { activate: boolean; tabActive: () => boolean; label: string },
  ): Promise<FocusedTypeResult> {
    const done = (r: FocusedTypeResult): FocusedTypeResult => {
      log(typingLine(opts.label, r));
      return r;
    };
    if (!(await waitForActive(opts.tabActive))) {
      return done({ ok: false, reason: "tab-mismatch", detail: "the session's tab did not become the active tab within 1 s" });
    }
    if (opts.activate) {
      await activateEditorApp();
      await sleep(150);
    }
    await sleep(220);
    if (!alive()) return done({ ok: false, reason: "aborted", detail: "stopped" });
    const refocus = (): Promise<string | undefined> => refocusPrompt(opts.tabActive);
    return done(await typeIntoPrompt(text, { submitDelayMs: submitDelayMs ?? 150, alive, windowFocused, tabActive: opts.tabActive, refocus }));
  }

  /**
   * Claude Code's focus command, only while it can do nothing but focus the target panel's prompt input
   * (promptFocus.ts): the target Claude panel is the active editor, no text editor is active and no other
   * Claude panel is visible. Then, once a visible Claude sidebar's focus retries are over, the target's
   * group gets the keyboard focus back. Undefined once that ran, else why not.
   */
  async function refocusPrompt(targetActive: () => boolean): Promise<string | undefined> {
    const group = vscode.window.tabGroups.activeTabGroup;
    const active = group.activeTab;
    const blocked = focusCommandBlocker({
      targetActive: targetActive(),
      claudePanel: active !== undefined && isClaudePanelTab(active),
      textEditor: vscode.window.activeTextEditor !== undefined,
      otherClaudePanels: vscode.window.tabGroups.all.filter((g) => g !== group && g.activeTab !== undefined && isClaudePanelTab(g.activeTab)).length,
    });
    if (blocked) return `${FOCUS_COMMAND} not run: ${blocked}`;
    try {
      await vscode.commands.executeCommand(FOCUS_COMMAND);
      await sleep(FOCUS_SETTLE_MS);
      if (!targetActive()) return `the session's tab is no longer active after ${FOCUS_COMMAND}`;
      await focusTabGroup(group);
    } catch (e) {
      return `${FOCUS_COMMAND} failed: ${String(e)}`;
    }
    return undefined;
  }

  /**
   * Remote path (b): type `text` + Enter into the session's Claude Code tab. Only
   * when typing is allowed (`remote.typeFallback`), the session's tab is this
   * window's one tab matching its title (labelsMatchStrict, truncated labels
   * included, no other listed session matching it), and this window is focused,
   * i.e. VS Code is already frontmost (it is never activated), and the automation gate lets
   * remote typing through. The tab is then shown by its index and re-verified, and the
   * typing osascript checks the frontmost app itself. Never prompts. `skip` = nothing
   * was typed; only a failed keystroke is final. Nothing starts once `stop` aborted
   * or with less than 10 s left before the command's `deadline`.
   */
  async function typeIntoSession(v: SessionView, text: string, stop?: AbortSignal, deadline?: number): Promise<PathAttempt> {
    const skip = (reason: string, detail?: string): PathAttempt => ({ ok: false, skip: true, reason, detail });
    if (!remoteFlag("remote.typeFallback")) return skip("typing disabled (remote.typeFallback is off)");
    const held = automationGate.blocker("remoteTyping");
    if (held) return skip(`typing disabled (${held})`);
    if (process.platform !== "darwin") return skip("keystrokes need macOS");
    if (v.provider !== "claude" || !v.capabilities.bulkInput) return skip("this session has no typable Claude input");
    if (resumeActive) return skip("a typing sweep is running");
    const rivals = rivalLabels(v);
    const tab = findSessionTab(v, rivals);
    if (!tab) return skip(NO_TAB_MESSAGE);
    if (!windowFocused()) return skip(TYPED_REASON["not-frontmost"], "this VS Code window is not focused");
    const s = sanitizeRemoteLine(text);
    if (!s.ok) return { ok: false, skip: false, reason: s.reason };
    if (stop?.aborted || !canStart(deadline)) return { ok: false, skip: false, reason: TIMED_OUT };
    const signal = automationGate.signal("remoteTyping");
    await focusTab(tab.gi, tab.ti); // also when active: showing it moves the keyboard focus into the tab
    const r = await typeIntoFocusedSession(s.line, undefined, () => !disposed && !resumeActive && !signal.aborted && !stop?.aborted, {
      activate: false,
      tabActive: () => findSessionTab(v, rivals)?.active === true,
      label: `remote ${v.key}`,
    });
    if (r.ok) return { ok: true };
    // Only a failed keystroke or typing stopped midway is final: every other reason typed nothing.
    return { ok: false, skip: nothingTyped(r.reason), reason: TYPED_REASON[r.reason] ?? r.reason, detail: r.detail };
  }

  /**
   * Why a remote newSession cannot open in a Claude Code tab of this window
   * (remoteNewTab.ts) and runs in a terminal instead, or undefined. A tab starts
   * in the window's workspace folder, so that must be the session's folder; a
   * first message needs Enter pressed by keystroke, so the typing rules must
   * let it through right now.
   */
  function newTabBlocker(cmd: FleetCommand): string | undefined {
    if (!vscode.extensions.getExtension(CLAUDE_CODE_ID)) return "Claude Code is not installed";
    const own = ownFolders();
    if (own.length !== 1 || own[0] !== cmd.cwd) return "the folder is not this window's one workspace folder";
    if (typeof cmd.text !== "string" || cmd.text === "") return undefined;
    if (process.platform !== "darwin") return "keystrokes need macOS";
    if (!remoteFlag("remote.typeFallback")) return "typing disabled (remote.typeFallback is off)";
    const held = automationGate.blocker("remoteTyping");
    if (held) return `typing disabled (${held})`;
    if (resumeActive) return "a typing sweep is running";
    if (!windowFocused()) return "this VS Code window is not focused";
    return undefined;
  }

  /** remoteNewTab.ts's deps: Claude Code's open command, this host's Claude processes, Enter by keystroke into the new tab. */
  function newTabDeps(stop: AbortSignal): NewTabDeps {
    let tab: vscode.Tab | undefined;
    const claudeTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudePanelTab));
    const where = (): { gi: number; ti: number } | undefined => {
      const groups = vscode.window.tabGroups.all;
      for (let gi = 0; gi < groups.length; gi++) {
        const ti = tab ? groups[gi].tabs.indexOf(tab) : -1;
        if (ti >= 0) return { gi, ti };
      }
      return undefined;
    };
    return {
      allowed: () => remoteCwds(true),
      ownSessions: async () => {
        const parents = await readParentPids();
        return parents && ownSessions(readLiveSessions(), parents, process.pid);
      },
      open: async (prompt) => {
        const before = new Set(claudeTabs());
        // Claude Code's own new-tab request: an editor tab whatever the preferred location, the prompt only fills the input.
        await vscode.commands.executeCommand(OPEN_COMMAND, undefined, prompt, undefined, undefined, undefined, { programmatic: "pin-to-panel" });
        for (let i = 0; i < 10 && !tab; i++) {
          tab = claudeTabs().find((t) => !before.has(t));
          if (!tab) await sleep(300);
        }
      },
      pressEnter: async () => {
        const at = where();
        if (!at) return tab ? "the new tab was closed" : "the new tab was not found";
        if (!windowFocused()) return TYPED_REASON["not-frontmost"];
        const signal = automationGate.signal("remoteTyping");
        await focusTab(at.gi, at.ti);
        const r = await typeIntoFocusedSession("", 0, () => !disposed && !resumeActive && !signal.aborted && !stop.aborted, {
          activate: false,
          tabActive: () => vscode.window.tabGroups.activeTabGroup.activeTab === tab,
          label: "remote newSession tab",
        });
        return r.ok ? undefined : (TYPED_REASON[r.reason] ?? r.reason);
      },
      monitorDir: MONITOR_DIR,
      sleep,
    };
  }

  /** Title candidates of every other listed session: a tab or terminal name they match too is ambiguous. */
  function rivalLabels(v: SessionView): string[] {
    return lastAllViews.filter((o) => o.sessionId !== v.sessionId).flatMap((o) => matchCandidates(o));
  }

  /** The sessions among `views` whose one matching tab (findSessionTab) is in this window: the typing sweep's queue. */
  function inThisWindow(views: SessionView[]): SessionView[] {
    return views.filter((v) => findSessionTab(v, rivalLabels(v)) !== null);
  }

  /** This window holds the session for a tab-bound remote command (remoteForward.ts): a live terminal it started or registered, or its one matching tab. */
  function holdsSession(v: SessionView): boolean {
    if (resumeTerminals.liveTerminalFor(v.sessionId)) return true;
    return v.provider === "claude" && groupOf(v) !== "ended" && findSessionTab(v, rivalLabels(v)) !== null;
  }

  /**
   * Remote path (a): write `text` + Return straight into the VS Code terminal
   * that hosts the session (process-tree match first, else the one terminal
   * named exactly like the session, else the live terminal this window resumed
   * it in, whose hook record may have no pid). No `show()`, no focus change: the
   * user keeps working where they are. `skip` when no terminal here is the
   * session's; the text must pass sanitizeRemoteLine before it is written.
   */
  async function sendToSessionTerminal(v: SessionView, text: string, stop?: AbortSignal): Promise<PathAttempt> {
    if (v.provider !== "claude" || !v.capabilities.bulkInput) {
      return { ok: false, skip: true, reason: "this session has no typable Claude input" };
    }
    let term: vscode.Terminal | undefined;
    try {
      term = await findSessionTerminal(v, matchCandidates(v), rivalLabels(v));
    } catch (e) {
      return { ok: false, skip: true, reason: "terminal lookup failed", detail: String(e) };
    }
    if (!term) return { ok: false, skip: true, reason: "no terminal for this session in this window" };
    const s = sanitizeRemoteLine(text);
    if (!s.ok) return { ok: false, skip: false, reason: s.reason };
    if (stop?.aborted) return { ok: false, skip: false, reason: TIMED_OUT };
    try {
      term.sendText(s.line + "\r", false);
      return { ok: true };
    } catch (e) {
      return { ok: false, skip: false, reason: "terminal write failed", detail: String(e) };
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
  /** The resume sweep over `queue`: resumePrompt typed into each session, staggered (resumeAll, auto-resume). */
  function startResumeSweep(queue: SessionView[], feature: Automation = "typingSweep"): void {
    const c = cfg();
    // Collapse newlines so a single resumePrompt value can never encode more
    // than one Return keystroke (osascript `keystroke` submits on each \n).
    const prompt = c.get<string>("resumePrompt", "resume").replace(/[\r\n]+/g, " ").slice(0, 500);
    startTypingSweep(queue, prompt, {
      staggerSec: Math.max(5, c.get<number>("resumeStaggerSeconds", 60)),
      doneLabel: "resume",
      autoType: c.get<boolean>("resumeAutoType", true),
      feature,
    });
  }

  function startTypingSweep(
    queue: SessionView[],
    text: string,
    opts: { staggerSec: number; doneLabel: string; submitDelayMs?: number; autoType?: boolean; feature?: Automation },
  ): void {
    const feature = opts.feature ?? "typingSweep";
    const off = automationGate.blocker(feature);
    if (off) {
      vscode.window.showInformationMessage(`Claude Sessions: ${opts.doneLabel} is off: ${off}.`);
      return;
    }
    // These commands type Claude slash-commands into the focused Claude input.
    // Keep this guard even when the caller already filtered by capability so a
    // mixed-provider command argument can never receive unattended keystrokes.
    // Only sessions whose one matching tab is in this window are queued.
    queue = inThisWindow(queue.filter((v) => v.provider === "claude" && v.capabilities.bulkInput));
    if (!queue.length) {
      vscode.window.showInformationMessage(`Claude Sessions: no open sessions in this window to ${opts.doneLabel}.`);
      return;
    }
    stopResume();
    const stagger = Math.max(3, opts.staggerSec);
    const auto = opts.autoType ?? true;
    let i = 0;
    let typed = 0;
    let skipped = 0;
    resumeActive = true;
    // Turning tab automation or the sweep's own setting off stops it at once (automationGate.ts).
    const signal = automationGate.signal(feature);
    const onAbort = (): void => stopResume(`Claude Sessions: ${opts.doneLabel} stopped: ${String(signal.reason)}.`);
    signal.addEventListener("abort", onAbort, { once: true });
    endSweep = () => signal.removeEventListener("abort", onAbort);

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
      const rivals = rivalLabels(v);
      const tab = findSessionTab(v, rivals);
      if (!tab) {
        // Its tab closed, or no longer is the one match, since the sweep began: skip it, never prompt.
        skipped++;
        log(`${opts.doneLabel} skip ${v.key}: ${NO_TAB_MESSAGE}`);
        if (resumeActive) resumeTimer = setTimeout(runOne, 0); // nothing was shown or typed
        return;
      }
      try {
        const held = automationGate.blocker(feature); // right before the tab is shown
        if (held) {
          stopResume(`Claude Sessions: ${opts.doneLabel} stopped: ${held}.`);
          return;
        }
        await focusTab(tab.gi, tab.ti); // by its index; also when active, so the keyboard focus moves into the tab
        if (!resumeActive) return;

        if (!auto) {
          vscode.window
            .showInformationMessage(`${opts.doneLabel} ${i}/${queue.length}: "${truncate(v.title, 40)}" · press Enter`, "Stop")
            .then((x) => {
              if (x === "Stop") stopResume("Claude Sessions: resume sweep stopped.");
            });
        } else {
          const t = await typeIntoFocusedSession(text, opts.submitDelayMs, () => resumeActive, {
            activate: true,
            tabActive: () => findSessionTab(v, rivals)?.active === true,
            label: `${opts.doneLabel} ${v.key}`,
          });
          if (!t.ok && t.reason === "aborted") return;
          if (!t.ok && (t.reason === "not-frontmost" || t.reason === "tab-mismatch")) {
            skipped++; // logged by typeIntoFocusedSession
          } else {
            if (!t.ok) {
              if (t.reason === "accessibility") {
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
      for (const [sessionId, status] of await readHookStatuses()) {
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
      collector.forget();
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
      startResumeSweep(
        lastAllViews.filter((v) => v.provider === "claude" && v.capabilities.bulkInput && groupOf(v) !== "ended"),
      );
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.wakeDeadTabsNow", async () => {
      if (tabWaker && observer.actionAllowed("wake")) vscode.window.showInformationMessage(summaryText(await tabWaker.runNow()));
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
        feature: "typingSweep",
        staggerSec: Math.max(3, cfg().get<number>("commandStaggerSeconds", 8)),
        doneLabel: "set model",
        submitDelayMs: 500,
      });
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.setEffortAll", async () => {
      if (!observer.actionAllowed("accountWrites")) return; // it writes ~/.claude/settings.json
      const queue = inThisWindow(
        lastAllViews.filter((v) => v.provider === "claude" && v.capabilities.bulkInput && groupOf(v) !== "ended"),
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
        feature: "typingSweep",
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
          ? captureActiveLogin(true).then(() => pollUsage(true)).then(() => pollOtherAccounts(true))
          : Promise.resolve(),
        codexEnabled() ? pollCodex(true) : Promise.resolve(),
      ]);
      try {
        if (switchInstalled() && allowed("accountWrites")) {
          const launch = switchRunner.start(["tick", "--fresh"]);
          if (!launch.started) {
            vscode.window.setStatusBarMessage(busyText(launch.running, Date.now()), 8000);
          } else {
            launch.done
              .then(
                (res) => {
                  const ok = res.code === 0;
                  const out = ok ? lastLine(res.stdout) || lastLine(res.stderr) || "done" : lastLine(res.stderr) || lastLine(res.stdout) || exitText(res, "tick --fresh");
                  vscode.window.setStatusBarMessage(`claude-switch: ${out.slice(0, 160)}`, 8000);
                  pushUsagePayload();
                },
                (e: unknown) => vscode.window.setStatusBarMessage(spawnFailureText(e, SWITCH_CLI), 8000),
              )
              .catch(() => {
                /* never fail the refresh */
              });
          }
        }
      } catch {
        /* never fail the refresh */
      }
    }),
    vscode.commands.registerCommand("claudeSessionMonitor.switchAccount", () => pickAndSwitchAccount()),
    vscode.commands.registerCommand("claudeSessionMonitor.switchToBestAccount", () => rotateToBest()),
    vscode.commands.registerCommand("claudeSessionMonitor.forgetOtherAccounts", async () => {
      if (!observer.actionAllowed("accountWrites")) return;
      setAccounts(readAccountsFile()); // another window may have a fresher registry
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
          await ctx.secrets.delete(vaultOauthKey(a.id));
          await ctx.secrets.delete(vaultIdentKey(a.id));
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
      setAccounts({ v: 1, accounts: active ? [active] : [], activeId: keepId });
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

  const autoRefresh = throttle(refresh, REFRESH_GAP_MS, () => lastRefreshMs);
  ctx.subscriptions.push({ dispose: () => autoRefresh.cancel() });
  const debouncedRefresh = debounce(autoRefresh, 200);
  ctx.subscriptions.push({ dispose: () => debouncedRefresh.cancel() });
  for (const monitorDir of [MONITOR_DIR, CODEX_MONITOR_DIR]) {
    try {
      if (allowed("sharedFiles")) ensurePrivateDir(monitorDir); // observer mode watches only a folder that is there
      const w = fs.watch(monitorDir, (_ev, name) => {
        if (monitorEventMatters(name)) debouncedRefresh();
      });
      w.on("error", () => {});
      ctx.subscriptions.push({ dispose: () => w.close() });
    } catch {
      /* polling still covers it */
    }
  }
  if (switchInstalled()) {
    try {
      const debouncedPanel = debounce(() => followActive(true), 1000);
      ctx.subscriptions.push({ dispose: () => debouncedPanel.cancel() });
      const w3 = fs.watch(SWITCH_STATE_DIR, (_ev, name) => {
        if (!name || name === path.basename(SWITCH_PANEL_FILE)) debouncedPanel();
      });
      w3.on("error", () => {});
      ctx.subscriptions.push({ dispose: () => w3.close() });
    } catch {
      /* state dir absent; the poll-driven refresh still re-reads the panel */
    }
  }
  try {
    const w2 = fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, name) => {
      if (projectsEventMatters(name)) debouncedRefresh();
    });
    w2.on("error", () => {});
    ctx.subscriptions.push({ dispose: () => w2.close() });
  } catch {
    /* recursive watch unsupported here; polling covers it */
  }

  const pollMs = Math.max(500, cfg().get<number>("pollIntervalMs", 1500));
  let pollTimer = setInterval(autoRefresh, pollMs);
  ctx.subscriptions.push({ dispose: () => clearInterval(pollTimer) });
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("claudeSessionMonitor.pollIntervalMs")) {
        clearInterval(pollTimer);
        pollTimer = setInterval(autoRefresh, Math.max(500, cfg().get<number>("pollIntervalMs", 1500)));
      }
      if (e.affectsConfiguration("claudeSessionMonitor.showTokenStats")) pushUsagePayload();
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

  // --- Remote bridge (optional) -------------------------------------------
  // Commands arriving from the relay run through the same actions as the panel,
  // minus every prompt: a session without a tab here fails instead of asking.
  // kill skips the modal: the remote request is the confirmation, the pid is still
  // re-verified. resumeAll keeps its own modal before any unattended typing.
  const remoteAccounts = () => {
    const accounts = currentAccountCtx().accounts;
    if (accounts.length) return { accounts, bestId: pickBestAccount(accounts)?.id ?? null };
    const active = accountsFile.accounts.find((a) => a.id === accountsFile.activeId);
    if (!active) return { accounts: [], bestId: null };
    const u = activeUsage();
    const one = {
      id: active.id,
      email: active.email,
      plan: planLabelFor(active.email) ?? claudePlanLabel(active.tier),
      active: true,
      gauges: (u?.gauges ?? []).map((g) => ({ key: g.key, label: g.label, pct: g.pct, resetMs: g.resetMs })),
    };
    return { accounts: [one], bestId: null };
  };

  // Folders a remote newSession may use (remoteCwds.ts). While the bridge runs,
  // every window adds its workspace folders while it trusts them (and drops them
  // while it does not) and the cwds of the sessions it lists, in globalState
  // shared by all windows, so each window offers and accepts the same list.
  const TRUSTED_FOLDERS_KEY = "remote.trustedFolders";
  const SESSION_CWDS_KEY = "remote.sessionCwds";
  let lastFolderRecord = 0;
  let cwdsCache: { at: number; list: string[] } | undefined;
  const ownFolders = () =>
    (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === "file").map((f) => f.uri.fsPath);
  const isRealDirectory = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory() && fs.realpathSync(p) === p;
    } catch {
      return false;
    }
  };
  function recordRemoteFolders(now: number): void {
    if (now - lastFolderRecord < 60_000) return;
    lastFolderRecord = now;
    const own = ownFolders();
    const known = mergeSeen(ctx.globalState.get(TRUSTED_FOLDERS_KEY), [], now);
    const trusted = vscode.workspace.isTrusted ? mergeSeen(known, own.map((p) => [p, now] as const), now) : withoutPaths(known, own);
    const cwds = lastAllViews.filter((v) => v.cwd).map((v) => [v.cwd as string, v.lastActivityMs] as const);
    void ctx.globalState.update(TRUSTED_FOLDERS_KEY, trusted);
    void ctx.globalState.update(SESSION_CWDS_KEY, mergeSeen(ctx.globalState.get(SESSION_CWDS_KEY), cwds, now));
    cwdsCache = undefined;
  }
  /** The snapshot's allowedCwds, recomputed at most every 30 s unless `fresh` (a newSession check). */
  function remoteCwds(fresh = false): string[] {
    const now = Date.now();
    recordRemoteFolders(now);
    if (!fresh && cwdsCache && now - cwdsCache.at < 30_000) return cwdsCache.list;
    const list = allowedCwds({
      trusted: mergeSeen(ctx.globalState.get(TRUSTED_FOLDERS_KEY), [], now),
      sessions: mergeSeen(ctx.globalState.get(SESSION_CWDS_KEY), [], now),
      now,
      exists: isRealDirectory,
      cwdRoots: remoteCwdRoots(),
    });
    cwdsCache = { at: now, list };
    return list;
  }

  /** Remote switchAccount: through claude-switch when it is installed, else the extension's own switch (accountSwitch.ts). */
  function remoteSwitch(account: string): Promise<CommandOutcome> {
    return routeRemoteSwitch(account, {
      accounts: () => currentAccountCtx().accounts,
      switchInstalled: () => switchInstalled(),
      readPanel: () => readPanel(),
      nowMs: () => Date.now(),
      busy: () => switchInflight,
      startUse: (email) => useAccountViaCli(email),
      switchDirect: async (id) => {
        await switchToAccount(id);
        return accountsFile.activeId === id;
      },
    });
  }

  /**
   * Runs a remote command; once `signal` aborts (its 60 s are up, at `deadline`) nothing more is written,
   * typed, opened or killed, and typing or an inbox send does not start with less than 10 s left.
   */
  async function executeRemote(cmd: FleetCommand, signal: AbortSignal, deadline: number): Promise<CommandOutcome> {
    const find = () => (cmd.sessionId ? lastAllViews.find((v) => v.sessionId === cmd.sessionId) : undefined);
    switch (cmd.type) {
      case "resume": {
        const v = find();
        if (!v) return { ok: false, message: `unknown session ${cmd.sessionId}` };
        if (!v.capabilities.resume) return { ok: false, message: "this provider cannot resume the session" };
        // An open session gets the word "resume" written into its own terminal
        // (no tab switch, no focus change), the live terminal this window resumed
        // it in included. Only a session with no terminal is reopened, in the
        // background, so the user keeps working where they are.
        const written = await sendToSessionTerminal(v, "resume", signal);
        if (written.ok) return { ok: true, message: `"resume" written into the open session "${truncate(v.title, 40)}"` };
        if (!written.skip) return { ok: false, message: `"resume" could not be written into the session's terminal: ${written.reason}` };
        if (v.pid && pidAlive(v.pid)) {
          // The session is running somewhere without a terminal we can address
          // (the Claude Code extension's own tab): a second `claude --resume`
          // would duplicate it, so type into the tab, only under the keystroke rules.
          const typed = await typeIntoSession(v, "resume", signal, deadline);
          if (typed.ok) return { ok: true, message: `"resume" typed into the running session "${truncate(v.title, 40)}"` };
          if (typed.reason === NO_TAB_MESSAGE) return { ok: false, message: NO_TAB_MESSAGE };
          return {
            ok: false,
            message: `session is running but "resume" could not be delivered: ${typed.reason}${typed.detail ? ` (${typed.detail})` : ""}`,
          };
        }
        // An exited session is reopened by the claude executable's absolute path only.
        if (v.provider === "claude" && !(await claudeBinary)) {
          return { ok: false, message: "claude executable not found on this Mac; remote resume refused" };
        }
        if (signal.aborted) return { ok: false, message: TIMED_OUT };
        resumeInTerminal(v, { show: false });
        return { ok: true, message: `resume terminal opened in the background for "${truncate(v.title, 40)}"` };
      }
      case "kill": {
        const v = find();
        // No hook pid: the live terminal this window resumed the session in runs claude itself.
        const term = v && !v.pid && v.provider === "claude" ? resumeTerminals.liveTerminalFor(v.sessionId) : undefined;
        const pid = term
          ? await Promise.resolve(term.processId).then(undefined, () => undefined)
          : v?.capabilities.kill
            ? v.pid
            : undefined;
        if (!v || !pid) return { ok: false, message: "no process id known for this session" };
        if (!(await verifyKillTarget(v, pid))) return { ok: false, message: "the recorded process has exited or no longer matches" };
        if (signal.aborted) return { ok: false, message: TIMED_OUT };
        try {
          process.kill(pid, "SIGTERM");
        } catch (e) {
          return { ok: false, message: "kill failed: " + String(e) };
        }
        refresh();
        return { ok: true, message: `sent SIGTERM to pid ${pid}` };
      }
      case "resumeAll":
        await vscode.commands.executeCommand("claudeSessionMonitor.resumeAll");
        return {
          ok: true,
          message: cfg().get<boolean>("resumeAutoType", true)
            ? "resume sweep requested; it starts after the confirmation on this machine"
            : "resume sweep started",
        };
      case "switchAccount":
        return cmd.account ? remoteSwitch(cmd.account) : { ok: false, message: "account is required" };
      case "newSession": {
        // A new Claude Code tab in this window when it can (remoteNewTab.ts), else a new claude in a
        // background terminal of this window, registered like a resume.
        const tabBlocked = newTabBlocker(cmd);
        if (tabBlocked === undefined) return startNewTab(cmd, newTabDeps(signal));
        log(`remote newSession: terminal, not a tab: ${tabBlocked}`);
        return startNewSession(cmd, {
          allowed: () => remoteCwds(true),
          claudeBinary: () => claudeBinary ?? Promise.resolve(undefined),
          open: (spec) => vscode.window.createTerminal(spec),
          register: (id, term) => resumeTerminals.register(id, term),
          monitorDir: MONITOR_DIR,
          sleep,
        });
      }
      case "answer": {
        // An AskUserQuestion answer from the phone, handed to the waiting PermissionRequest hook (answers.ts).
        return submitAnswer(cmd, { nowSec: Date.now() / 1000, askPending: !!find()?.askPending });
      }
      case "autoResume": {
        // One limited session in or out of the auto-resume sweep (autoResume.ts).
        const v = find();
        if (!v) return { ok: false, message: `unknown session ${cmd.sessionId}` };
        if (v.provider !== "claude") return { ok: false, message: "auto-resume is supported for Claude sessions only" };
        if (typeof cmd.enabled !== "boolean") return { ok: false, message: "enabled (true or false) is required" };
        if (groupOf(v) !== "limited") return { ok: false, message: "the session is not stopped by a limit" };
        await ctx.globalState.update(OVERRIDES_KEY, withOverride(autoResumeOverrides(), v.sessionId, cmd.enabled, Date.now()));
        maybeScheduleAutoResume(lastAllViews);
        const when = cmd.enabled && autoResumeAt ? `; the resume sweep runs at ${new Date(autoResumeAt).toLocaleTimeString()}` : "";
        return { ok: true, message: `auto-resume ${cmd.enabled ? "on" : "off"} for "${truncate(v.title, 40)}"${when}` };
      }
      case "send": {
        if (!cmd.sessionId || typeof cmd.text !== "string" || !cmd.text) {
          return { ok: false, message: "sessionId and text are required" };
        }
        // Only a session in the local list is a target; the inbox gets its pid too,
        // so a session id prefix can never reach another session.
        const v = find();
        if (!v) return { ok: false, message: "session not found" };
        if (v.provider !== "claude") return { ok: false, message: "send is supported for Claude sessions only" };
        const text = cmd.text;
        return deliverText({
          text,
          terminal: () => sendToSessionTerminal(v, text, signal),
          typed: () => typeIntoSession(v, text, signal, deadline),
          uds: (line) => sendToSession({ pid: v.pid, sessionId: v.sessionId, text: line, timeoutMs: 5000, waitTranscriptMs: 15_000, signal }),
          signal,
          deadline,
        });
      }
      default:
        return { ok: false, message: `unknown command type ${cmd.type}` };
    }
  }

  // Resolved once per activation; the remote path never runs a bare `claude`. Observer mode skips the `which` process.
  claudeBinaryPath = undefined;
  const which = (): Promise<string | null> => (allowed("remoteBridge") ? runTool("which", ["claude"], 3000) : Promise.resolve(null));
  claudeBinary = resolveClaudeBinary({ which, home: os.homedir() }).then((p) => {
    claudeBinaryPath = p;
    if (!p) {
      log(
        "claude executable not found (which claude, ~/.claude/local/claude, /opt/homebrew/bin/claude, /usr/local/bin/claude): remote resume of exited sessions is refused",
      );
    }
    return p;
  });

  // A closed resume terminal is no longer the session's.
  ctx.subscriptions.push(vscode.window.onDidCloseTerminal((t) => resumeTerminals.forget(t)));

  // Each feature start below fails alone: the others and the first refresh still run.
  // Observer mode (observerMode.ts) skips the bridge and the restart guard and keeps wakes and continuity disabled.
  let healthNow: (() => void) | undefined; // writes this window's health file now; set below, once its deps exist
  remoteBridge = allowed("remoteBridge") ? stages.safe("remote bridge start", () => registerRemoteBridge(ctx, {
    log,
    accounts: remoteAccounts,
    execute: executeRemote,
    allowedCwds: () => remoteCwds(),
    autoResume: (v) => rowAutoResume(v, autoResumeOverrides(), autoResumeAll(), autoResumeAt),
    // A tab-bound command goes to the window holding its session; the health file lists the sessions this one holds.
    forward: nodeForwardDeps({ win, monitorDir: MONITOR_DIR, healthDir: HEALTH_DIR, shared: () => allowed("sharedFiles"), holds: holdsSession, log }),
    holdsChanged: () => healthNow?.(),
  })) : undefined;

  // After a restart, show each limit-stopped Claude Code tab once so its process runs
  // again (wakeTabs.ts). Started before the first refresh, which updates its registry.
  const probes = nodeProbes();
  // Every tab automation asks this gate right before it shows or moves a tab or types (automationGate.ts).
  const automationOn: Record<Automation, () => boolean> = {
    wake: () => cfg().get<boolean>("wakeDeadTabs", false) === true,
    continuity: () => cfg().get<boolean>("continuityChannel", false) === true,
    autoResume: () => autoResumeAll() || Object.values(autoResumeOverrides()).some((o) => o.enabled),
    typingSweep: () => true,
    remoteTyping: () => remoteFlag("remote.typeFallback"),
  };
  const automationGate = new AutomationGate({
    log,
    now: () => Date.now(),
    masterOn: () => cfg().get<boolean>("tabAutomation", true) !== false,
    featureOn: (a) => claudeEnabled() && automationOn[a](),
    pressureLevel: probes.pressureLevel,
    pulseStage: () => readPulseStage(Date.now()),
    claudeCode: () => {
      const cc = vscode.extensions.getExtension(CLAUDE_CODE_ID);
      return cc ? { version: String((cc.packageJSON as { version?: unknown } | undefined)?.version ?? ""), active: cc.isActive } : undefined;
    },
    commands: () => vscode.commands.getCommands(true),
    tabViews: () =>
      vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.flatMap((t) => {
          const viewType = (t.input as { viewType?: unknown } | undefined)?.viewType;
          return typeof viewType === "string" ? [{ label: t.label, viewType }] : [];
        }),
      ),
    claudeTitles: () => lastAllViews.filter((v) => v.provider === "claude").map((v) => v.title),
  });
  void automationGate.checkCompat();
  ctx.subscriptions.push(
    vscode.extensions.onDidChange(() => void automationGate.checkCompat()), // a Claude Code update
    vscode.workspace.onDidChangeConfiguration((e) => {
      automationGate.configChanged((setting) => e.affectsConfiguration(setting));
      // Turning the wake on starts it without a restart (start() does nothing while it is off).
      if (e.affectsConfiguration("claudeSessionMonitor.wakeDeadTabs") || e.affectsConfiguration("claudeSessionMonitor.enableClaude")) {
        stages.safe("tab wake start", () => tabWaker?.start(true));
      }
    }),
  );
  tabWaker = stages.safe("tab wake start", () => new TabWaker<TabMemo>({
    ...probes,
    enabled: () => allowed("wake") && claudeEnabled() && cfg().get<boolean>("wakeDeadTabs", false) === true,
    store: ctx.workspaceState,
    log,
    now: () => Date.now(),
    hostPid: process.pid,
    titleOf: (sid) => lastAllViews.find((v) => v.provider === "claude" && v.sessionId === sid)?.title,
    windowFocused: () => vscode.window.state.focused,
    commandExists: async (id) => (await vscode.commands.getCommands(true)).includes(id),
    executeCommand: (id, ...args) => vscode.commands.executeCommand(id, ...args),
    snapshotTabs,
    activeTab: () => vscode.window.tabGroups.activeTabGroup.activeTab,
    activeClaudeLabel: () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return tab && isClaudePanelTab(tab) ? tab.label : undefined;
    },
    restoreTabs,
    claudeTabLabels: () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.filter(isClaudePanelTab).map((t) => t.label)),
    yieldTo: () => continuity?.pending() === true,
    gate: automationGate.wakeGate("wake"),
  }));
  stages.safe("tab wake start", () => tabWaker?.start());
  ctx.subscriptions.push(
    { dispose: () => tabWaker?.dispose() },
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const t of e.closed) if (isClaudePanelTab(t)) tabWaker?.tabClosed(t.label);
    }),
  );

  // Show the dormant Claude Code tabs the continuity daemon asks this window for
  // (continuity.ts), each in its existing tab, ahead of the limit-stopped tab wakes.
  continuity = stages.safe("continuity start", () => new ContinuityServer<vscode.TabGroup, vscode.Tab>({
    ...probes,
    enabled: () => allowed("continuity") && claudeEnabled() && cfg().get<boolean>("continuityChannel", false) === true,
    storage: storageDir(ctx.storageUri?.fsPath),
    version: (ctx.extension?.packageJSON as { version?: string } | undefined)?.version ?? "0.0.0",
    pid: process.pid,
    dir: continuityDir(),
    now: () => Date.now(),
    log,
    read: readText,
    write: writeTextAtomic,
    windowFocused,
    othersBusy: () => tabWaker?.isBusy() === true,
    tabs: () =>
      vscode.window.tabGroups.all.flatMap((group) =>
        group.tabs.map((tab) => ({ group, tab, label: tab.label, claude: isClaudePanelTab(tab), active: tab.isActive })),
      ),
    activeGroup: () => vscode.window.tabGroups.activeTabGroup,
    activeTabOf: (group) => group.activeTab,
    reveal: revealTab,
    focusGroup: focusTabGroup,
    gate: automationGate.wakeGate("continuity"),
  }));
  ctx.subscriptions.push({ dispose: () => continuity?.dispose() });

  // Ask before an extension restart stops every session in this window (restartGuard.ts).
  const restartGuard = allowed("restartGuard") ? stages.safe("restart guard start", () => activateRestartGuard(ctx, {
    log,
    focusGroup: focusTabGroup,
    idleMs: probes.idleMs,
  })) : undefined;
  // The commands of a feature observer mode keeps off say so instead of "command not found".
  for (const { command, feature } of observer.offCommands()) {
    ctx.subscriptions.push(vscode.commands.registerCommand(command, () => observer.actionAllowed(feature)));
  }

  // Now, every 30 s and at dispose: new occurrences of the errors the stage guard caught go to errors.json
  // (errorRegistry.ts), this window's health file is rewritten (health.ts), and one window sends the
  // overseer heartbeat for all of them (overseerBeat.ts; only where overseer is installed).
  const saveStageErrors = (): void => {
    const records = stages.unsaved();
    const deps = { file: ERRORS_FILE, shared: () => allowed("sharedFiles"), lock: (file: string) => acquireSwitchLock(file), read: readIfThere, write: writePrivateTextAtomic };
    if (records.length && saveErrors(records, version, win, deps)) stages.saved(records);
  };
  const health: HealthDeps = {
    dir: HEALTH_DIR,
    win,
    pid: process.pid,
    version,
    nowMs: () => Date.now(),
    enabled: () => ({
      sessions: claudeEnabled() || codexEnabled(),
      limits: claudeEnabled(),
      remote: remoteBridge?.running === true,
      autoResume: allowed("autoResume") && claudeEnabled() && autoResumeAll(),
      continuity: allowed("continuity") && claudeEnabled() && cfg().get<boolean>("continuityChannel", false) === true,
      wake: allowed("wake") && claudeEnabled() && cfg().get<boolean>("wakeDeadTabs", false) === true,
      restartGuard: allowed("restartGuard") && cfg().get<boolean>("restartGuard", false) === true,
    }),
    failures: () => stages.lastFailures(),
    refresh: refreshMs,
    guardArmed: () => restartGuard?.armed() === true,
    holds: () => remoteBridge?.held(),
    shared: () => allowed("sharedFiles"),
    write: writePrivateTextAtomic,
    remove: (file) => fs.rmSync(file, { force: true }),
  };
  healthNow = () => stages.safe("health", () => writeHealth(health));
  const overseer = new OverseerBeat(nodeBeatDeps(HEALTH_DIR, overseerBin(), () => allowed("sharedFiles"), log));
  const observe = (): void => {
    stages.safe("error registry", saveStageErrors);
    stages.safe("health", () => writeHealth(health));
    void overseer.tick().catch((e: unknown) => stages.fail("overseer", e));
  };
  // The first write waits for the first refresh, so the health file and errors.json carry what it found.
  void refresh().then(() => {
    if (!disposed) observe();
  });
  const observeTimer = setInterval(observe, HEALTH_EVERY_MS);
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(observeTimer);
      stages.safe("error registry", saveStageErrors);
      stages.safe("health", () => removeHealth(health));
    },
  });
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

/**
 * True when `pid` still runs this session's provider: Codex (never a shared
 * app-server), the Claude Code extension's binary or a `claude` CLI. The pid of
 * the session's live resume terminal needs no hook record but must be exactly
 * `claude --resume <session id>`.
 */
function verifyKillTarget(view: SessionView, pid = view.pid): Promise<boolean> {
  const resumed = !!pid && view.provider === "claude" && resumeTerminals.livePids().get(view.sessionId) === pid;
  if (!pid || (!resumed && !view.capabilities.kill)) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 3000 },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(false);
          return;
        }
        const raw = String(stdout).trim();
        const command = raw.toLowerCase();
        if (view.provider === "codex") {
          resolve(
            /(?:^|[/\s])codex(?:\s|$)/.test(command) &&
              !/(?:^|\s)app-server(?:\s|$)/.test(command),
          );
          return;
        }
        if (resumed) {
          resolve(isClaudeSessionCommand(raw, view.sessionId));
          return;
        }
        resolve((command.includes("anthropic.claude-code") && command.includes("resources")) || isClaudeCliCommand(raw));
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
  usage: OfficialUsage | null, // the active login's usage
  account?: { name: string; email: string }, // the active login, once 2+ accounts are known
): void {
  const counts = countBuckets(views);
  let waiting = 0;
  let done = 0;
  let background = 0;
  for (const v of views) {
    const g = groupOf(v);
    if (g === "waiting") waiting++;
    else if (g === "done") done++;
    else if (g === "background") background++;
  }
  const segs: string[] = [];
  if (counts.working) segs.push(`$(sync) ${counts.working}`);
  if (waiting) segs.push(`$(bell-dot) ${waiting}`);
  if (done) segs.push(`$(comment) ${done}`);
  if (counts.limited) segs.push(`$(error) ${counts.limited}`);

  // With 2+ accounts name the active login with its 5h gauge; a single login
  // surfaces the gauge once it is worth watching (>= 70%).
  const g5 = usage?.gauges.find((g) => g.key === "session");
  if (account) segs.push(`$(account) ${account.name}${g5 ? ` ${Math.round(g5.pct)}%` : ""}`);
  else if (g5 && g5.pct >= 70) segs.push(`$(dashboard) C ${Math.round(g5.pct)}%`);

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
  const usageLine =
    (account ? `\nClaude account: ${account.email} (active)` : "") +
    (usage?.gauges.length ? `\nClaude usage: ${usage.gauges.map((g) => `${g.label} ${Math.round(g.pct)}%`).join(" · ")}` : "");
  const providers = countProviders(views);
  item.tooltip = `Agent sessions\nClaude: ${providers.claude} · Codex: ${providers.codex}\nworking: ${counts.working}\nwaiting: ${waiting}\nyour turn: ${done}${background ? `\nin background: ${background}` : ""}\nlimited: ${counts.limited}${resLine}${usageLine}\n(click to open the panel)`;

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
  burnShare: ReadonlyMap<string, number> | null = null,
  projects: ProjectStrip | null = null,
): SessionsPayload {
  const nowSec = Date.now() / 1000;
  const grouped = new Map<GroupKey, SessionRow[]>();
  let totalCpu = 0;
  let totalRss = 0;
  let anyRes = false;
  const tokOf = (v: SessionView): number =>
    v.tokens ?? (v.provider === "claude" ? (tokens?.bySession5h?.[v.sessionId] ?? 0) : 0);
  // In background lists the soonest finish time first; the other groups keep the token order.
  for (const v of backgroundByDue(sortByTokens(views, tokOf))) {
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
    // Once the burn tracker has data its share (priced, subagents included) replaces the raw token share.
    const burnPct = burnShare && v.provider === "claude" ? (burnShare.get(v.sessionId) ?? 0) : undefined;
    const share =
      burnPct !== undefined
        ? Math.round(burnPct)
        : tokenScope === "rolling-5h" && tok && total5h > 0
          ? Math.round((tok / total5h) * 100)
          : 0;
    const resTip = res ? `\nCPU: ${Math.round(res.cpu)}%  RAM: ${res.rssMb}MB  (pid ${v.pid})` : "";
    const tokTip =
      tok >= 10_000
        ? `\ntokens (${tokenScope === "thread-total" ? "thread total" : "rolling 5h"}): ${fmtTokensCompact(tok)}${share >= 1 ? ` · ${share}% of this Mac's ${burnPct !== undefined ? "5h limit burn" : "total"}` : ""}${v.provider === "claude" && v.sessionId === hogId ? " · top consumer" : ""}`
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
      project: projects && v.project ? v.project : "",
      projectIdx: projects && v.project ? projects.names.indexOf(v.project) : -1,
      cpu: res ? Math.round(res.cpu) : null,
      rssMb: res ? res.rssMb : null,
      cpuHog: !!res && res.cpu >= cpuHogThreshold,
      stale: g === "working" && v.stale,
      closing: (g === "done" || g === "background") && v.closing ? v.closing.kind : "",
      closingText: (g === "done" || g === "background") && v.closing ? v.closing.text : "",
      due: v.closingTiming?.dueMs != null ? fmtClock(v.closingTiming.dueMs) : "",
      late: v.closingTiming?.overdue ? timingNote(v.closingTiming) : "",
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
  // value visible on narrow panels where the eff column is hidden. Effort is
  // per session, so the strip shows it only when every session agrees.
  const efforts = new Set(views.map((v) => v.effort).filter(Boolean));
  const effort = efforts.size === 1 ? (shortEffort([...efforts][0]) ?? "") : "";
  return {
    type: "update",
    groups,
    totalCpu: anyRes ? Math.round(totalCpu) : null,
    totalRss: anyRes ? totalRss : null,
    effort,
    filter,
    providerCounts,
    providerFilter,
    projects,
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

/** The editor side of tabFocus.ts. */
const TAB_FOCUS: TabFocusDeps<vscode.TabGroup> = {
  run: (command, ...args) => vscode.commands.executeCommand(command, ...args),
  activeGroup: () => vscode.window.tabGroups.activeTabGroup,
};

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

/** Parent chain of `pid` (nearest first), at most 8 levels, stopping at launchd. */
async function ancestorPids(pid: number | undefined): Promise<number[]> {
  const out: number[] = [];
  let cur = pid;
  for (let depth = 0; cur && cur > 1 && depth < 8; depth++) {
    const stdout = await runTool("ps", ["-o", "ppid=", "-p", String(cur)]);
    const parent = stdout === null ? null : parseParentPid(stdout);
    if (!parent || parent <= 1) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** What a terminal lookup saw (tabs-debug.json): the window's terminals, the session's pid chain, how it matched. */
interface TerminalTrace {
  terminals?: TerminalCandidate[];
  pidChain?: number[];
  via?: "match" | "registry" | null;
}

/**
 * The terminal in this window that hosts the session: the one whose shell pid is
 * the session's process or an ancestor of it, else the one terminal named
 * strictly like a `labels` entry (no name match when `labels` is empty), else the
 * live terminal this window started or resumed the session in (its hook record
 * may have no pid yet). Rejects when the terminal lookup itself fails. Fills
 * `trace`, when given, with what the lookup saw.
 */
async function findSessionTerminal(
  v: SessionView,
  labels: string[] = [],
  rivals: string[] = [],
  trace?: TerminalTrace,
): Promise<vscode.Terminal | undefined> {
  const terms = vscode.window.terminals;
  const pids = await Promise.all(terms.map((t) => Promise.resolve(t.processId).catch(() => undefined)));
  const candidates = terms.map((t, i) => ({ name: t.name, pid: pids[i] ?? undefined }));
  const pidChain = v.pid ? [v.pid, ...(await ancestorPids(v.pid))] : [];
  const hit = terms[pickSessionTerminal(candidates, labels, pidChain, rivals)];
  const term = hit ?? resumeTerminals.liveTerminalFor(v.sessionId);
  if (trace) {
    trace.terminals = candidates;
    trace.pidChain = pidChain;
    trace.via = hit ? "match" : term ? "registry" : null;
  }
  return term;
}

/** Answer of a remote command whose session has no tab (or several same-titled ones) in this window. */
const NO_TAB_MESSAGE = "no tab for this session in this window";

interface TabHit {
  gi: number;
  ti: number;
  active: boolean; // the active tab of the active group
}

/**
 * The session's tab in this window for the remote paths: the one tab whose label
 * strictly matches a title candidate, its truncated form included
 * (labelsMatchStrict via pickUniqueLabel), or null when none matches, several
 * do, or the label matches one of the `rivals` (other sessions' titles) too.
 */
function findSessionTab(v: SessionView, rivals: string[]): TabHit | null {
  const tabs: Array<TabHit & { label: string }> = [];
  vscode.window.tabGroups.all.forEach((g, gi) =>
    g.tabs.forEach((t, ti) => tabs.push({ gi, ti, label: t.label, active: g.isActive && t.isActive })),
  );
  const k = pickUniqueLabel(tabs.map((t) => t.label), matchCandidates(v), rivals);
  return k >= 0 ? tabs[k] : null;
}

/**
 * Make tab `ti` of editor group `gi` (tabGroups.all order) the active editor, by its
 * index in the group focused by its screen slot (tabFocus.ts); returns the action
 * taken (tabs-debug.json). Throws when the group or tab is gone or cannot be focused.
 */
async function focusTab(gi: number, ti: number): Promise<string> {
  const group = vscode.window.tabGroups.all[gi];
  if (!group) throw new Error(`editor group ${gi} is gone`);
  await revealTabByIndex(group, ti, TAB_FOCUS);
  return `openEditorAtIndex ${ti} in editor group ${group.viewColumn}`;
}

/** Each editor group's active tab and the active group, taken before a tab wake (wakeTabs.ts). */
interface TabMemo {
  group: vscode.TabGroup;
  actives: Array<[vscode.TabGroup, vscode.Tab | undefined]>;
}

function snapshotTabs(): TabMemo {
  const groups = vscode.window.tabGroups;
  return {
    group: groups.activeTabGroup,
    actives: groups.all.map((g): [vscode.TabGroup, vscode.Tab | undefined] => [g, g.activeTab]),
  };
}

/** Make every remembered tab its group's active tab again, then focus the remembered group (by index and screen slot, tabFocus.ts). */
async function restoreTabs(memo: TabMemo): Promise<void> {
  const all = vscode.window.tabGroups.all;
  for (const [g, tab] of memo.actives) {
    const ti = tab ? g.tabs.indexOf(tab) : -1;
    if (all.includes(g) && ti >= 0 && g.activeTab !== tab) await revealTabByIndex(g, ti, TAB_FOCUS);
  }
  if (all.includes(memo.group) && vscode.window.tabGroups.activeTabGroup !== memo.group) {
    await focusGroupBySlot(memo.group, TAB_FOCUS);
  }
}

/**
 * Make `tab` its group's active tab and focus the group (continuity.ts), by its index
 * in the group focused by its screen slot (tabFocus.ts), so a tab past the ninth is
 * reached without showing the tabs before it.
 */
async function revealTab(group: vscode.TabGroup, tab: vscode.Tab): Promise<void> {
  const ti = group.tabs.indexOf(tab);
  if (ti < 0) return; // closed meanwhile
  await revealTabByIndex(group, ti, TAB_FOCUS);
}

/** Focus `group` by its screen slot (viewColumn); throws unless it became the active group. */
function focusTabGroup(group: vscode.TabGroup): Promise<void> {
  return focusGroupBySlot(group, TAB_FOCUS);
}

/** A Claude Code editor tab (the anthropic.claude-code `claudeVSCodePanel` webview). */
function isClaudePanelTab(tab: vscode.Tab): boolean {
  return tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith("claudeVSCodePanel");
}

/**
 * Show a Claude session whose `claude` process this window's Claude Code started (a
 * child of this extension host, wakeTabs.ts ownSessions) through Claude Code, which
 * knows the tab that hosts it: a session without an ai-title keeps its first prompt
 * as tab label while its row shows the newest prompt, and several tabs can share a
 * label. False when the session runs elsewhere or Claude Code could not show it.
 */
async function showHostedSession(v: SessionView, dbg: Record<string, unknown>): Promise<boolean> {
  if (v.provider !== "claude") return false;
  const live = readLiveSessions().filter((s) => s.sessionId === v.sessionId);
  if (live.length === 0) return false;
  const parents = await readParentPids();
  if (!parents || ownSessions(live, parents, process.pid).length === 0) return false;
  try {
    await vscode.commands.executeCommand(OPEN_COMMAND, v.sessionId, undefined, undefined, undefined, undefined, { programmatic: true });
  } catch (e) {
    dbg.hostedError = String(e); // fall back to the tab labels
    return false;
  }
  dbg.action = `${OPEN_COMMAND} (session runs in this window)`;
  writeTabDebug(dbg);
  return true;
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
    if (await showHostedSession(v, dbg)) return;

    for (let gi = 0; gi < groups.length; gi++) {
      const tabs = groups[gi].tabs;
      const ti = tabs.findIndex((t) => t.label && candidates.some((c) => labelsMatch(t.label, c)));
      if (ti >= 0) {
        dbg.matched = { groupIndex: gi, tabIndex: ti, label: tabs[ti].label };
        dbg.action = await focusTab(gi, ti);
        writeTabDebug(dbg);
        return;
      }
    }
    // A session that runs in a terminal (a remote new session, Resume in Terminal,
    // `claude` typed in a shell) has no editor tab: show its terminal instead.
    const trace: TerminalTrace = {};
    const term = await findSessionTerminal(v, [], [], trace);
    dbg.terminalLookup = { pid: v.pid ?? null, ...trace };
    if (term) {
      term.show();
      dbg.action = `terminal: ${term.name}`;
      writeTabDebug(dbg);
      return;
    }
    dbg.action = "no-match -> prompt";
  } catch (e) {
    dbg.error = String(e);
  }
  writeTabDebug(dbg);
  if (!dbg.matched) await promptNoTabMatch(v); // a matched tab that could not be shown is in tabs-debug.json
}

/**
 * Neither an open tab nor a terminal in this window hosts this session. Rather
 * than silently opening the (possibly huge) transcript file, ask what to do:
 * open it anyway, resume the session in a fresh terminal, or just copy its id.
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
    `Session "${truncate(v.title, 60)}" has no open tab or terminal in this window.`,
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

// Absolute path of the claude CLI, resolved at activation (claudeBinary.ts);
// the remote path awaits `claudeBinary` and refuses to resume without it.
let claudeBinaryPath: string | undefined;
let claudeBinary: Promise<string | undefined> | undefined;

// The terminals resumeInTerminal opened, by session id (resumeRegistry.ts).
const resumeTerminals = new ResumeRegistry<vscode.Terminal>();

function resumeInTerminal(arg: SessionView, opts: { show?: boolean } = {}): void {
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
  // A session this window already resumed keeps its live terminal: never a second process.
  const { terminal: term } = resumeTerminals.openOrReuse(v.sessionId, () =>
    vscode.window.createTerminal({
      name: `${providerLabel(v.provider)} · ${truncate(v.title, 32)}`,
      cwd: v.cwd,
      shellPath: v.provider === "codex" ? codexExecutable : claudeBinaryPath ?? "claude",
      shellArgs:
        v.provider === "codex"
          ? ["resume", v.sessionId]
          : ["--resume", v.sessionId],
    }),
  );
  if (opts.show !== false) term.show();
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

function activateEditorApp(): Promise<void> {
  return new Promise((res) => {
    execFile("osascript", ["-e", 'tell application "Visual Studio Code" to activate'], { timeout: 4000 }, () => res());
  });
}

/** True when this VS Code window has OS focus: VS Code is the frontmost app and this is its focused window. */
function windowFocused(): boolean {
  return vscode.window.state?.focused === true;
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
