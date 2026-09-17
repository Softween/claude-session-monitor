import { randomBytes } from "node:crypto";

/** Native-tool launcher. Provider state arrives only after the ready handshake. */
export function hubHtml(): string {
  const nonce = randomBytes(24).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'">
<title>Agent Hub</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size, 13px)/1.45 var(--vscode-font-family, sans-serif); }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: default; opacity: .55; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
button { border: 1px solid var(--vscode-button-border, transparent); border-radius: 3px; padding: 6px 9px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
h1, h2, p { margin: 0; }
h1 { font-size: 14px; font-weight: 600; }
h2 { font-size: 13px; font-weight: 600; }
.muted, .hint { color: var(--vscode-descriptionForeground); }
.hint { font-size: 11px; line-height: 1.5; }
.topline, .provider-heading, .settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.eyebrow { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--vscode-descriptionForeground); }
.tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; margin: 12px 0 10px; padding: 3px; border: 1px solid var(--vscode-widget-border, transparent); border-radius: 5px; background: var(--vscode-editor-background); }
.tab { min-width: 0; padding: 6px 1px; font-size: 12px; background: transparent; color: var(--vscode-descriptionForeground); }
.tab[aria-selected="true"] { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: var(--vscode-contrastActiveBorder, transparent); }
.workspace { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0 0 10px; border: 0; border-radius: 0; color: var(--vscode-descriptionForeground); background: transparent; text-align: left; font-size: 11px; }
.workspace:hover:not(:disabled) { background: transparent; color: var(--vscode-textLink-foreground); }
.workspace-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.workspace-arrow { flex: 0 0 auto; }
.provider-heading { margin: 3px 0 10px; }
.availability { font-size: 10px; white-space: nowrap; color: var(--vscode-descriptionForeground); }
.availability[data-ready="true"] { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
.session-note { margin-top: 7px; overflow-wrap: anywhere; }
.options { margin-top: 14px; }
.field { display: block; margin-top: 9px; }
.field-label { display: block; margin-bottom: 4px; font-size: 11px; color: var(--vscode-descriptionForeground); }
input, select { width: 100%; min-width: 0; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; padding: 5px 7px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); }
select { color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
input::placeholder { color: var(--vscode-input-placeholderForeground); }
.settings-footer { margin-top: 8px; align-items: flex-start; }
.settings-footer .hint { flex: 1; }
.small { padding: 3px 8px; font-size: 11px; flex: 0 0 auto; }
.permission-note { margin-top: 6px; color: var(--vscode-editorWarning-foreground); }
.tools { margin-top: 14px; padding-top: 11px; border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
.text-action { color: var(--vscode-textLink-foreground); background: transparent; padding: 3px 0; border: 0; text-align: left; }
.text-action:hover:not(:disabled) { color: var(--vscode-textLink-activeForeground); background: transparent; text-decoration: underline; }
.native-settings { display: block; width: 100%; }
.utilities { display: flex; flex-wrap: wrap; gap: 2px 14px; margin-top: 5px; font-size: 11px; }
.usage { margin-top: 12px; padding: 9px 10px; border-radius: 3px; border: 1px solid var(--vscode-widget-border, transparent); background: var(--vscode-editor-background); }
.usage-title { font-size: 11px; font-weight: 600; }
.usage .hint { margin-top: 3px; }
.footnote { margin-top: 10px; }
.notice { margin-top: 10px; padding: 8px; border-left: 2px solid var(--vscode-focusBorder); background: var(--vscode-textBlockQuote-background); font-size: 11px; overflow-wrap: anywhere; }
[hidden] { display: none !important; }
@media (max-width: 220px) { body { padding: 9px; } .actions { grid-template-columns: 1fr; } .provider-heading { align-items: flex-start; flex-direction: column; gap: 2px; } }
</style>
</head>
<body>
<main aria-label="Agent Hub">
  <header class="topline"><h1>Agent Hub</h1><span class="eyebrow">Native tools</span></header>
  <nav class="tabs" role="tablist" aria-label="AI provider">
    <button class="tab" id="tab-claude" type="button" role="tab" aria-controls="provider-panel" aria-selected="true" tabindex="0" data-provider="claude">Claude</button>
    <button class="tab" id="tab-codex" type="button" role="tab" aria-controls="provider-panel" aria-selected="false" tabindex="-1" data-provider="codex">Codex</button>
    <button class="tab" id="tab-copilot" type="button" role="tab" aria-controls="provider-panel" aria-selected="false" tabindex="-1" data-provider="copilot">Copilot</button>
  </nav>
  <button class="workspace" type="button" data-action="selectWorkspace" title="Choose the working folder" disabled>
    <span aria-hidden="true">&#x25A1;</span><span class="workspace-label" id="workspace">Loading workspace…</span><span class="workspace-arrow" aria-hidden="true">&#x2304;</span>
  </button>
  <section id="provider-panel" role="tabpanel" aria-labelledby="tab-claude">
    <div class="provider-heading"><h2 id="provider-name">Claude Code</h2><span id="availability" class="availability" role="status">Checking tools…</span></div>
    <div class="actions">
      <button id="start" class="primary" type="button" data-action="start" disabled>Open Claude Code</button>
      <button type="button" data-action="newSession" disabled>New session</button>
    </div>
    <p class="hint session-note" id="session-note">Runs in your VS Code editor terminal.</p>
    <form id="settings-form" class="options" aria-label="New session options">
      <label class="field"><span class="field-label">Model</span><input id="model" name="model" list="model-options" placeholder="Provider default" maxlength="128" autocomplete="off" spellcheck="false" aria-describedby="model-error" disabled></label>
      <p class="hint permission-note" id="model-error" hidden>Enter a model ID without spaces or command options.</p>
      <datalist id="model-options"></datalist>
      <label class="field"><span class="field-label">Permissions</span><select id="permissions" name="permissions" aria-describedby="permission-note" disabled><option value="native">Provider settings</option></select></label>
      <p class="hint permission-note" id="permission-note" hidden>Full access allows tools to run without approval.</p>
      <div class="settings-footer"><p class="hint">Changes apply to new sessions.</p><button id="apply" class="small" type="submit" disabled>Apply</button></div>
    </form>
    <div class="tools">
      <button class="text-action native-settings" type="button" data-action="nativeSettings" disabled>Settings, tools &amp; instructions…</button>
      <p class="hint">Open native configuration, MCP and skills.</p>
      <div class="utilities">
        <button class="text-action" type="button" data-action="login" disabled>Sign in</button>
        <button class="text-action" type="button" data-action="resume" disabled>Resume history</button>
        <button class="text-action" type="button" data-action="usageHelp" disabled>Usage commands</button>
      </div>
    </div>
    <div class="usage" aria-label="Usage information">
      <p class="usage-title" id="usage-label">Account limits</p><p class="hint" id="usage-detail">Live quotas and reset times are in Usage limits below.</p>
      <button class="text-action small" type="button" data-action="openUsage" disabled>Official usage page &#x2197;</button>
    </div>
    <p class="hint footnote">Native settings and history stay with each provider.</p>
  </section>
  <p class="notice" id="notice" role="status" aria-live="polite" hidden></p>
</main>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const providerIds = ['claude', 'codex', 'copilot'];
  const permissionIds = ['native', 'ask', 'auto', 'full'];
  const allowedActions = new Set(['selectProvider', 'selectWorkspace', 'start', 'newSession', 'configure', 'nativeSettings', 'login', 'resume', 'usageHelp', 'openUsage']);
  const byId = (id) => document.getElementById(id);
  const tabs = Array.from(document.querySelectorAll('[data-provider]'));
  const actionButtons = Array.from(document.querySelectorAll('[data-action]'));
  let current = null;
  let settingsKey = '';
  let savedModel = '';
  let savedPermission = 'native';
  let editable = false;

  function send(action, extra) {
    if (!allowedActions.has(action) || !current) return;
    vscode.postMessage(Object.assign({ type: 'action', action: action, provider: current.id }, extra || {}));
  }

  function updateDraft() {
    const model = byId('model').value.trim();
    const validModel = model === '' || /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model);
    const changed = model !== savedModel || byId('permissions').value !== savedPermission;
    byId('model').setCustomValidity(validModel ? '' : 'Use a model ID with letters, numbers, dots, colons, slashes or hyphens.');
    byId('model').setAttribute('aria-invalid', String(!validModel));
    byId('model-error').hidden = validModel;
    byId('apply').disabled = !current || !editable || !changed || !validModel;
    byId('permission-note').hidden = byId('permissions').value !== 'full';
  }

  function setOptions(target, rows) {
    target.replaceChildren();
    rows.forEach((row) => {
      const option = document.createElement('option');
      option.value = row.id;
      option.textContent = row.label;
      target.appendChild(option);
    });
  }

  function updateSettings(provider) {
    const model = typeof provider.model === 'string' ? provider.model : '';
    const permissions = Array.isArray(provider.permissionOptions) ? provider.permissionOptions.filter((entry) => entry && permissionIds.includes(entry.id) && typeof entry.label === 'string') : [];
    if (!permissions.length) permissions.push({ id: 'native', label: 'Provider settings' });
    const permission = permissions.some((entry) => entry.id === provider.permissionPreset) ? provider.permissionPreset : permissions[0].id;
    const key = JSON.stringify([provider.id, model, permission, permissions, provider.modelOptions]);
    if (key === settingsKey) return;
    settingsKey = key;
    savedModel = model;
    savedPermission = permission;
    const models = Array.isArray(provider.modelOptions) ? provider.modelOptions.filter((entry) => typeof entry === 'string') : [];
    setOptions(byId('model-options'), models.map((entry) => ({ id: entry, label: entry })));
    setOptions(byId('permissions'), permissions);
    byId('model').value = model;
    byId('permissions').value = permission;
    updateDraft();
  }

  function render(state) {
    if (!state || state.type !== 'state' || !providerIds.includes(state.activeProvider) || !Array.isArray(state.providers)) return;
    const provider = state.providers.find((entry) => entry && entry.id === state.activeProvider);
    if (!provider || typeof provider.label !== 'string') return;
    current = provider;
    tabs.forEach((tab) => {
      const active = tab.dataset.provider === provider.id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    byId('provider-panel').setAttribute('aria-labelledby', 'tab-' + provider.id);
    byId('provider-name').textContent = provider.label;
    byId('start').textContent = 'Open ' + provider.label;
    const trusted = state.workspace && state.workspace.trusted === true;
    editable = trusted;
    const available = provider.available === true;
    byId('availability').textContent = !trusted ? 'Workspace not trusted' : available ? 'CLI available' : 'CLI not found';
    byId('availability').dataset.ready = String(available && trusted);
    byId('workspace').textContent = state.workspace && typeof state.workspace.label === 'string' ? state.workspace.label : 'Choose a workspace';
    byId('session-note').textContent = typeof provider.sessionNote === 'string' ? provider.sessionNote : 'Runs in your VS Code editor terminal.';
    actionButtons.forEach((button) => {
      const needsCli = ['start', 'newSession', 'login', 'resume'].includes(button.dataset.action);
      button.disabled = (needsCli && (!available || !trusted)) || (button.dataset.action === 'nativeSettings' && !trusted);
    });
    byId('model').disabled = !trusted;
    byId('permissions').disabled = !trusted;
    updateSettings(provider);
    updateDraft();
    const usage = provider.usage;
    byId('usage-label').textContent = usage && typeof usage.label === 'string' ? usage.label : 'Account limits';
    byId('usage-detail').textContent = usage && typeof usage.detail === 'string' ? usage.detail : 'Live quotas and reset times are in Usage limits below.';
    const notice = typeof state.notice === 'string' ? state.notice : '';
    byId('notice').textContent = notice;
    byId('notice').hidden = !notice;
  }

  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => send('selectProvider', { provider: tab.dataset.provider }));
    tab.addEventListener('keydown', (event) => {
      const moves = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      if (!Object.prototype.hasOwnProperty.call(moves, event.key)) return;
      event.preventDefault();
      const next = tabs[moves[event.key]];
      next.focus();
      send('selectProvider', { provider: next.dataset.provider });
    });
  });
  actionButtons.forEach((button) => button.addEventListener('click', () => {
    if (!button.disabled) send(button.dataset.action);
  }));
  byId('model').addEventListener('input', updateDraft);
  byId('permissions').addEventListener('change', updateDraft);
  byId('settings-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (byId('apply').disabled || !permissionIds.includes(byId('permissions').value)) return;
    send('configure', { model: byId('model').value.trim(), permissionPreset: byId('permissions').value });
  });
  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'focusSettings') {
      if (!byId('model').disabled) {
        byId('model').focus();
        byId('model').select();
      }
      return;
    }
    render(event.data);
  });
  vscode.postMessage({ type: 'ready' });
}());
</script>
</body>
</html>`;
}
