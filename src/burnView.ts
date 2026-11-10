// "Limit burn" sidebar view: the host ranks sessions by how fast they eat the
// subscription limit and posts a BurnPayload every few seconds. The webview only
// renders it and reports clicks; the host owns the data and the selected window.
import type * as vscode from "vscode";
import type { BurnPayload } from "./burnPayload";

export class BurnView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pending?: BurnPayload;

  constructor(private readonly onAction: (action: "open" | "window", value: string) => void) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = burnHtml();
    view.webview.onDidReceiveMessage((m: unknown) => this.receive(m));
    if (this.pending) view.webview.postMessage(this.pending);
  }

  update(payload: BurnPayload): void {
    this.pending = payload;
    this.view?.webview.postMessage(payload);
  }

  private receive(m: unknown): void {
    if (!m || typeof m !== "object") return;
    const { type, ms, id } = m as { type?: unknown; ms?: unknown; id?: unknown };
    if (type === "window" && typeof ms === "number" && Number.isFinite(ms) && ms > 0) this.onAction("window", String(ms));
    else if (type === "open" && typeof id === "string" && id !== "") this.onAction("open", id);
  }
}

const BURN_CSS = `
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground); padding: 0; margin: 0; }
  .num { font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
    font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Window picker: aria-pressed mirrors payload.windowMs, a press only asks the host. */
  .wins { display:flex; gap:2px; margin:6px 12px 2px; padding:2px; border-radius:4px;
    background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent); }
  .win { flex:1; border:0; border-radius:3px; background:transparent; color:var(--vscode-descriptionForeground);
    padding:2px 0; font:inherit; font-size:11px; cursor:pointer; }
  .win:hover { color:var(--vscode-foreground); }
  .win[aria-pressed="true"] { color:var(--vscode-foreground); background:var(--vscode-badge-background, rgba(127,127,127,.25));
    box-shadow: inset 0 0 0 1px var(--vscode-contrastActiveBorder, transparent); }
  .win:focus-visible { outline:1px solid var(--vscode-focusBorder, #007fd4); outline-offset:-1px; }
  .head { padding:6px 12px 4px; font-weight:600; line-height:1.4; overflow-wrap:break-word; }
  /* Entry = two lines: rank · dot · title · rate · used, then the bar (relative to
     the top row) with the meta beside it, both aligned under the title. */
  .row { display:grid; grid-template-columns: 16px 7px minmax(0,1fr) auto auto; column-gap:6px; row-gap:3px;
    align-items:center; padding:4px 12px 5px; }
  .row[data-id] { cursor:pointer; }
  .row[data-id]:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.12)); }
  .row:focus { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px; }
  .row.ended { opacity: .6; }
  .rank { text-align:right; color: var(--vscode-descriptionForeground); }
  .dot { width:7px; height:7px; border-radius:50%; border:1px solid var(--vscode-descriptionForeground); opacity:.6; }
  .dot.live { background: var(--vscode-charts-green, #89d185); border-color: var(--vscode-charts-green, #89d185); opacity:1; }
  .title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rate { font-weight:600; min-width:7ch; text-align:right; }
  .used { min-width:6ch; text-align:right; color: var(--vscode-descriptionForeground); }
  .l2 { grid-column: 3 / -1; display:flex; align-items:center; gap:6px; min-width:0; }
  .bar { flex:0 0 30%; max-width:120px; height:3px; border-radius:2px; overflow:hidden;
    background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent); }
  .fill { display:block; height:100%; background: var(--vscode-progressBar-background, #0e70c0); }
  .meta { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px;
    color: var(--vscode-descriptionForeground); }
  .more { padding:3px 12px; font-size:11px; color: var(--vscode-descriptionForeground); }
  .note { padding:8px 12px 10px; font-size:10px; line-height:1.4; color: var(--vscode-descriptionForeground); }
  .empty { padding: 14px 12px; color: var(--vscode-descriptionForeground); line-height:1.5; }
`;

const BURN_SCRIPT = `
const vscodeApi = acquireVsCodeApi();
const root = document.getElementById('root');
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function pct(n){ n = Number(n); return n > 0 ? Math.min(100, Math.round(n * 10) / 10) : 0; }
function windowsHtml(p){
  const ws = Array.isArray(p.windows) ? p.windows : [];
  if(!ws.length) return '';
  let h = '<div class="wins" role="group" aria-label="Burn window">';
  for(const w of ws){
    h += '<button class="win" data-ms="'+esc(w.ms)+'" aria-pressed="'+(w.ms === p.windowMs)+'">'+esc(w.label)+'</button>';
  }
  return h + '</div>';
}
function rowHtml(r){
  const open = r.openId ? ' data-id="'+esc(r.openId)+'" tabindex="0" role="button"' : '';
  return '<div class="row'+(r.ended?' ended':'')+'" title="'+esc(r.tip)+'"'+open+'>'
    + '<span class="num rank">'+esc(r.rank)+'</span>'
    + '<span class="dot'+(r.live?' live':'')+'" role="img" aria-label="'+(r.live?'live':'not live')+'"></span>'
    + '<span class="title">'+esc(r.title)+'</span>'
    + '<span class="num rate">'+esc(r.rate)+'</span>'
    + '<span class="num used">'+esc(r.used)+'</span>'
    + '<div class="l2"><span class="bar"><span class="fill" style="width:'+pct(r.barPct)+'%"></span></span>'
    + '<span class="meta">'+esc(r.meta)+'</span></div>'
    + '</div>';
}
function listHtml(p){
  const rows = Array.isArray(p.rows) ? p.rows : [];
  if(!rows.length) return '<div class="empty">'+esc(p.empty)+'</div>';
  const n = Number(p.more);
  const more = n > 0 ? '<div class="more">+ '+esc(n)+' more session'+(n === 1 ? '' : 's')+'</div>' : '';
  return rows.map(r => rowHtml(r)).join('') + more;
}
function render(p){
  root.innerHTML = windowsHtml(p)
    + (p.headline ? '<div class="head">'+esc(p.headline)+'</div>' : '')
    + listHtml(p)
    + (p.note ? '<div class="note">'+esc(p.note)+'</div>' : '');
}
function closestData(el, key){
  for(; el && el !== root; el = el.parentElement){ if(el.dataset && el.dataset[key]) return el; }
  return null;
}
root.addEventListener('click', (ev) => {
  const win = closestData(ev.target, 'ms');
  if(win){
    const ms = Number(win.dataset.ms);
    if(Number.isFinite(ms) && ms > 0) vscodeApi.postMessage({ type: 'window', ms });
    return;
  }
  const row = closestData(ev.target, 'id');
  if(row) vscodeApi.postMessage({ type: 'open', id: row.dataset.id });
});
root.addEventListener('keydown', (ev) => {
  if(ev.key !== 'Enter' && ev.key !== ' ') return;
  const row = ev.target;
  if(!row || !row.dataset || !row.dataset.id) return;
  ev.preventDefault();
  vscodeApi.postMessage({ type: 'open', id: row.dataset.id });
});
window.addEventListener('message', e => { if(e.data && e.data.type === 'update') render(e.data); });
`;

export function burnHtml(): string {
  const nonce = nonceStr();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${BURN_CSS}</style>
</head>
<body>
  <div id="root"><div class="empty">Collecting usage…</div></div>
<script nonce="${nonce}">${BURN_SCRIPT}</script>
</body>
</html>`;
}

function nonceStr(): string {
  return (Math.random().toString(36) + Math.random().toString(36)).replace(/[^a-z0-9]/g, "").slice(0, 24);
}
