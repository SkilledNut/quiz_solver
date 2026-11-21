import { PRESETS, API_FORMATS } from '../lib/presets.js';
import { getSettings, saveSettings, getContexts, saveContexts } from '../lib/storage.js';
import { optionLabel } from '../lib/prompt.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  Object.assign(e, props);
  kids.flat().forEach((k) => e.append(k instanceof Node ? k : document.createTextNode(String(k))));
  return e;
};

let settings;
let contexts;
let tabId;
const expanded = new Set();

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
const persistSettings = debounce(() => saveSettings(settings), 250);
const persistContexts = debounce(() => saveContexts(contexts), 400);
const send = (msg) => chrome.runtime.sendMessage({ tabId, ...msg });

function status(text, type = '') {
  const s = $('#status');
  s.hidden = !text;
  s.className = 'status ' + type;
  s.textContent = text || '';
}

// ------------------------------------------------------------------ sections
function initSections() {
  const { sections = {} } = JSON.parse(localStorageSafe('qsSections') || '{}');
  $$('.card').forEach((card) => {
    const key = card.dataset.sec;
    const btn = $('.sec-toggle', card);
    const body = $('.sec-body', card);
    const setOpen = (open) => { btn.setAttribute('aria-expanded', String(open)); body.hidden = !open; };
    if (key in sections) setOpen(sections[key]);
    btn.addEventListener('click', () => {
      const open = btn.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
      sections[key] = open;
      localStorageSafe('qsSections', JSON.stringify({ sections }));
      if (open && key === 'history') loadHistory();
      if (open && key === 'lastrun') loadLastRun();
    });
  });
}
function localStorageSafe(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { /* ignore */ }
  return null;
}

// ------------------------------------------------------------------ mode
function renderMode() {
  $$('.seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === settings.mode)));
  $('#llmCard').style.opacity = settings.mode === 'llm' ? '1' : '0.55';
}

// ------------------------------------------------------------------ contexts
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const fmtSize = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)) + ' chars';

function renderContexts() {
  const list = $('#ctxList');
  list.textContent = '';
  const tpl = $('#ctxTpl');
  for (const c of contexts) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    const radio = $('.ctx-radio', node);
    const exp = $('.ctx-expand', node);
    const body = $('.ctx-body', node);
    const title = $('.ctx-title', node);
    const meta = $('.ctx-meta', node);
    const name = $('.ctx-name', node);
    const text = $('.ctx-text', node);
    radio.value = c.id;
    radio.checked = settings.activeContextId === c.id;
    node.classList.toggle('active', radio.checked);
    const refreshHead = () => { title.textContent = c.name || 'Untitled context'; meta.textContent = fmtSize((c.text || '').length); };
    refreshHead();
    name.value = c.name || '';
    text.value = c.text || '';
    const open = expanded.has(c.id);
    exp.setAttribute('aria-expanded', String(open));
    body.hidden = !open;

    radio.addEventListener('change', () => { settings.activeContextId = c.id; persistSettings(); renderContexts(); });
    exp.addEventListener('click', () => {
      const o = exp.getAttribute('aria-expanded') !== 'true';
      exp.setAttribute('aria-expanded', String(o));
      body.hidden = !o;
      if (o) expanded.add(c.id); else expanded.delete(c.id);
    });
    name.addEventListener('input', () => { c.name = name.value; refreshHead(); persistContexts(); });
    text.addEventListener('input', () => { c.text = text.value; refreshHead(); persistContexts(); });
    $('.ctx-file', node).addEventListener('change', async (e) => {
      for (const f of e.target.files) {
        const t = await f.text();
        c.text = (c.text ? c.text.replace(/\s*$/, '') + '\n\n' : '') + t;
        if (!c.name) c.name = f.name.replace(/\.[^.]+$/, '');
      }
      text.value = c.text;
      name.value = c.name;
      refreshHead();
      persistContexts();
      e.target.value = '';
    });
    $('.ctx-delete', node).addEventListener('click', () => {
      if (!confirm(`Delete context “${c.name || 'Untitled'}”?`)) return;
      contexts = contexts.filter((x) => x !== c);
      if (settings.activeContextId === c.id) { settings.activeContextId = null; persistSettings(); }
      saveContexts(contexts);
      renderContexts();
    });
    list.append(node);
  }
  $('.ctx-none input').checked = !settings.activeContextId || !contexts.some((c) => c.id === settings.activeContextId);
}

function initContexts() {
  $('.ctx-none input').addEventListener('change', () => { settings.activeContextId = null; persistSettings(); renderContexts(); });
  $('#addCtx').addEventListener('click', () => {
    const c = { id: uid(), name: '', text: '' };
    contexts.push(c);
    expanded.add(c.id);
    settings.activeContextId = c.id;
    persistSettings();
    saveContexts(contexts);
    renderContexts();
    const last = $$('.ctx-name').pop();
    if (last) last.focus();
  });
}

// ------------------------------------------------------------------ LLM settings
function prov() {
  const id = settings.llm.provider;
  settings.llm.providers[id] = settings.llm.providers[id] || {};
  return settings.llm.providers[id];
}

function renderLLM() {
  const id = PRESETS[settings.llm.provider] ? settings.llm.provider : 'gemini';
  settings.llm.provider = id;
  const p = PRESETS[id];
  const u = prov();
  $('#provider').value = id;
  $('#formatWrap').hidden = id !== 'custom';
  $('#apiFormat').value = u.apiFormat || p.apiFormat;
  $('#apiKey').value = u.apiKey || '';
  $('#apiKey').placeholder = p.noKey ? 'not required' : 'paste API key';
  $('#model').value = u.model || '';
  $('#model').placeholder = p.model || 'model id';
  $('#baseUrl').value = u.baseUrl || '';
  $('#baseUrl').placeholder = p.baseUrl || 'https://…/v1';
  const dl = $('#modelList');
  dl.textContent = '';
  (p.models || []).forEach((m) => dl.append(el('option', { value: m })));
  const link = $('#keyLink');
  link.hidden = !p.keyUrl;
  if (p.keyUrl) link.href = p.keyUrl;
  const ws = $('#webSearch');
  ws.checked = !!settings.llm.webSearch && p.search !== 'none';
  ws.disabled = p.search === 'none' || p.search === 'always';
  if (p.search === 'always') ws.checked = true;
  ws.closest('label').classList.toggle('disabled', ws.disabled);
  $('#providerNote').textContent = p.search === 'none' ? 'This provider has no built-in web search.' : (p.note || '');
  $('#effort').value = settings.llm.effort || '';
  $('#maxTokens').value = settings.llm.maxTokens;
  $('#temperature').value = settings.llm.temperature;
  $('#customInstructions').value = settings.llm.customInstructions || '';
}

function initLLM() {
  const sel = $('#provider');
  Object.entries(PRESETS).forEach(([id, p]) => sel.append(el('option', { value: id, textContent: p.label })));
  const fmt = $('#apiFormat');
  Object.entries(API_FORMATS).forEach(([id, label]) => fmt.append(el('option', { value: id, textContent: label })));

  sel.addEventListener('change', () => { settings.llm.provider = sel.value; persistSettings(); renderLLM(); });
  fmt.addEventListener('change', () => { prov().apiFormat = fmt.value; persistSettings(); });
  const bindProv = (id, key) => $(id).addEventListener('input', (e) => { prov()[key] = e.target.value.trim(); persistSettings(); });
  bindProv('#apiKey', 'apiKey');
  bindProv('#model', 'model');
  bindProv('#baseUrl', 'baseUrl');
  $('#toggleKey').addEventListener('click', () => { const k = $('#apiKey'); k.type = k.type === 'password' ? 'text' : 'password'; });
  $('#webSearch').addEventListener('change', (e) => { settings.llm.webSearch = e.target.checked; persistSettings(); });
  $('#effort').addEventListener('change', (e) => { settings.llm.effort = e.target.value; persistSettings(); });
  $('#maxTokens').addEventListener('input', (e) => { settings.llm.maxTokens = parseInt(e.target.value, 10) || 4096; persistSettings(); });
  $('#temperature').addEventListener('input', (e) => { settings.llm.temperature = e.target.value; persistSettings(); });
  $('#customInstructions').addEventListener('input', (e) => { settings.llm.customInstructions = e.target.value; persistSettings(); });

  $('#test').addEventListener('click', async () => {
    const out = $('#testResult');
    out.textContent = 'Testing…';
    await saveSettings(settings);
    const r = await send({ type: 'popup:test' });
    if (!r || r.error) { out.textContent = '✗ ' + ((r && r.error) || 'no response'); out.style.color = 'var(--danger)'; return; }
    out.style.color = r.ok ? 'var(--ok)' : 'var(--warn)';
    out.textContent = (r.ok ? '✓ Works' : `⚠ Unexpected answer “${(r.raw || '').slice(0, 40)}”`) + ` · ${r.ms} ms` + (r.warnings && r.warnings.length ? ` · ${r.warnings.length} param(s) auto-dropped` : '');
  });
}

// ------------------------------------------------------------------ options
function initOptions() {
  $('#showLabel').addEventListener('click', async () => {
    const r = await send({ type: 'popup:showLabel' });
    status(r && r.ok ? 'Answers shown in the bottom-right corner.' : '✗ ' + ((r && r.error) || 'Nothing to show'), r && r.ok ? 'ok' : 'err');
  });
  for (const key of ['viewportOnly', 'notifications', 'flash', 'answerLabel']) {
    const cb = $('#' + key);
    cb.checked = key === 'answerLabel' ? settings[key] !== false : !!settings[key];
    cb.addEventListener('change', () => { settings[key] = cb.checked; persistSettings(); });
  }
  const op = $('#labelOpacity');
  const opVal = $('#labelOpacityVal');
  op.value = settings.labelOpacity ?? 100;
  opVal.textContent = op.value + '%';
  op.addEventListener('input', () => { settings.labelOpacity = +op.value; opVal.textContent = op.value + '%'; persistSettings(); });
  const mode = $('#clickMode');
  const grant = $('#grantDebugger');
  const info = $('#trustedStatus');
  const refresh = async () => {
    const has = await chrome.permissions.contains({ permissions: ['debugger'] });
    const wants = settings.clickMode !== 'synthetic';
    grant.hidden = has || !wants;
    info.textContent = !wants ? 'Real clicks off.' : has ? '✓ Real clicks enabled.' : 'Real clicks need one-time permission →';
    info.style.color = wants && !has ? 'var(--warn)' : '';
  };
  // permission request must come from a user gesture; Chrome may close the popup while asking
  const request = async () => {
    try { await chrome.permissions.request({ permissions: ['debugger'] }); } catch { /* ignore */ }
    refresh();
  };
  mode.value = settings.clickMode || 'auto';
  mode.addEventListener('change', async () => {
    settings.clickMode = mode.value;
    await saveSettings(settings);
    if (mode.value !== 'synthetic' && !(await chrome.permissions.contains({ permissions: ['debugger'] }))) await request();
    refresh();
  });
  grant.addEventListener('click', request);
  refresh();
}

// ------------------------------------------------------------------ history
async function loadHistory() {
  const list = $('#historyList');
  list.textContent = '';
  if (tabId == null) return;
  const h = await send({ type: 'popup:history' });
  if (!h || !h.entries || !h.entries.length) { list.append(el('li', { className: 'empty', textContent: 'No history for this page yet.' })); return; }
  h.entries.map((e, i) => [e, i]).reverse().forEach(([e, i]) => {
    const answered = (e.state || []).filter((s) => s.sel && s.sel.length).length;
    const li = el('li', { className: i === h.pointer ? 'current' : '' },
      el('span', { className: 'lbl', textContent: `${e.label} · ${answered}/${(e.state || []).length}` }),
      el('span', { className: 'time', textContent: new Date(e.time).toLocaleTimeString() }));
    const b = el('button', { type: 'button', textContent: i === h.pointer ? 'current' : 'Restore', disabled: i === h.pointer });
    b.addEventListener('click', async () => {
      const r = await send({ type: 'popup:restore', index: i });
      status(r && r.ok ? `Restored “${e.label}” (${r.applied} questions)` : 'Restore failed' + (r && r.error ? ': ' + r.error : ''), r && r.ok ? 'ok' : 'err');
      loadHistory();
    });
    li.append(b);
    list.append(li);
  });
}

function initHistory() {
  $$('[data-sec="history"] [data-cmd]').forEach((b) => b.addEventListener('click', async () => {
    const r = await send({ type: 'popup:command', command: b.dataset.cmd });
    if (r && r.error) status(r.error, 'err');
    loadHistory();
  }));
  $('#clearHistory').addEventListener('click', async () => {
    if (!confirm('Clear the answer history for this page?')) return;
    await send({ type: 'popup:clearHistory' });
    loadHistory();
  });
}

// ------------------------------------------------------------------ last run
async function loadLastRun() {
  const box = $('#lastRun');
  const { lastRun } = await chrome.storage.local.get('lastRun');
  box.textContent = '';
  if (!lastRun) { box.textContent = 'Nothing yet.'; return; }
  const head = [new Date(lastRun.time).toLocaleString()];
  if (lastRun.meta) head.push(lastRun.meta.provider + (lastRun.meta.model ? ' · ' + lastRun.meta.model : ''), (lastRun.secs || '') + ' s');
  if (lastRun.meta && lastRun.meta.searched) head.push('used web search');
  if (lastRun.context) head.push('context: ' + lastRun.context);
  box.append(el('div', { textContent: head.join(' · ') }));
  if (lastRun.error) box.append(el('div', { className: 'run-q none', textContent: '✗ ' + lastRun.error }));
  if (lastRun.meta && lastRun.meta.warnings && lastRun.meta.warnings.length) {
    box.append(el('div', { className: 'small', textContent: '⚠ ' + lastRun.meta.warnings.join(' | ') }));
  }
  (lastRun.questions || []).forEach((q, i) => {
    const picked = new Set(q.answer || []);
    const ans = picked.size ? [...picked].map(optionLabel).join(', ') : '—';
    const div = el('div', { className: 'run-q' },
      el('div', {}, el('b', { textContent: `${i + 1}. ` }), (q.text || '(no question text)').slice(0, 220), ' → ',
        el('span', { className: picked.size ? 'ans' : 'none', textContent: ans })));
    const ol = el('ol', { type: 'A' });
    q.options.forEach((o, j) => ol.append(el('li', { className: picked.has(j) ? 'picked' : '', textContent: o || '(no text)' })));
    div.append(ol);
    box.append(div);
  });
  const ap = lastRun.applied;
  if (ap && (ap.trustedClicks || ap.trustedError || (ap.trustedLog && ap.trustedLog.length))) {
    box.append(el('div', { className: 'small', textContent: `Real clicks: ${ap.trustedClicks || 0}${ap.trustedError ? ' · ' + ap.trustedError : ''}` }));
    if (ap.trustedLog && ap.trustedLog.length) box.append(el('pre', { className: 'raw', textContent: ap.trustedLog.join('\n') }));
  }
  if (lastRun.raw) {
    box.append(el('div', { className: 'small', textContent: 'Raw output:' }), el('pre', { className: 'raw', textContent: lastRun.raw }));
  }
}

// ------------------------------------------------------------------ manual question
async function loadDraft(picked = []) {
  const d = (await send({ type: 'popup:draft' })) || { question: '', options: [] };
  $('#draftQ').textContent = d.question || 'No question yet — select the question text and press Alt+Shift+Q.';
  const ol = $('#draftOpts');
  ol.textContent = '';
  d.options.forEach((o, i) => {
    const rm = el('button', { type: 'button', className: 'ghost', textContent: '✕', title: 'Remove answer' });
    rm.addEventListener('click', async () => {
      d.options.splice(i, 1);
      await send({ type: 'popup:setDraft', draft: d });
      loadDraft();
    });
    ol.append(el('li', { className: picked.includes(i) ? 'picked' : '' }, o, rm));
  });
  if (!d.options.length) {
    const hint = el('li', { className: 'small', textContent: 'Select each answer and press Alt+Shift+O.' });
    hint.style.listStyle = 'none';
    ol.append(hint);
  }
}

function initDraft() {
  $('#clearDraft').addEventListener('click', async () => {
    await send({ type: 'popup:setDraft', draft: { question: '', options: [] } });
    $('#draftAnswer').hidden = true;
    loadDraft();
  });
  $$('[data-cmd^="manual-solve"]').forEach((b) => b.addEventListener('click', async () => {
    const box = $('#draftAnswer');
    box.hidden = false;
    box.textContent = 'Solving…';
    await Promise.all([saveSettings(settings), saveContexts(contexts)]);
    const r = await send({ type: 'popup:command', command: b.dataset.cmd });
    box.textContent = r && r.ok ? 'Answer: ' + r.letters.join(', ') : '✗ ' + ((r && r.error) || 'see Last run');
    loadDraft(r && r.ok ? r.answer : []);
    loadLastRun();
  }));
  chrome.storage.session.onChanged.addListener(() => loadDraft());
}

// ------------------------------------------------------------------ shortcuts
// What every command does (shown under its key in the Shortcuts section).
const SHORTCUT_HELP = [
  { group: 'Manual mode — select text, press keys (nothing is clicked on the page)' },
  { name: 'manual-question', title: 'Set question', detail: 'Selected text becomes the question and starts a new one. Selecting question + “a) b) c)” lines at once also captures the answers.' },
  { name: 'manual-answer', title: 'Add answer', detail: 'Selected text is added as the next answer (A, B, C…). Several selected lines = several answers.' },
  { name: 'manual-solve-single', title: 'Solve — single choice', detail: 'Asks for exactly one correct answer. Result goes to the Answers box + notification.' },
  { name: 'manual-solve-multi', title: 'Solve — multiple choice', detail: 'Asks for all correct answers.' },
  { group: 'Automatic mode — detects questions on the page and selects answers' },
  { note: 'Alt+Shift keys work inside web pages (reload tabs that were open before installing). Optionally add a Chrome-wide key too.' },
  { name: 'solve-quiz', fallback: 'Alt+Shift+P', title: 'Solve page', detail: 'Finds all visible questions (also in iframes), solves them in one request, selects the answers and lists them in the Answers box.' },
  { name: 'undo-answers', fallback: 'Alt+Shift+U', title: 'Undo', detail: 'Steps back in this page’s answer history (also your own manual changes).' },
  { name: 'redo-answers', fallback: 'Alt+Shift+Y', title: 'Redo', detail: 'Steps forward again after an undo.' },
  { name: 'reapply-answers', fallback: 'Alt+Shift+L', title: 'Re-apply solved answers', detail: 'Puts the last solved answers back after you changed them by hand (works after reload too).' },
  { group: 'Answers box (bottom right)' },
  { name: 'toggle-label', fallback: 'Alt+Shift+H', title: 'Show / hide answers box', detail: 'Shows the last answers if the box isn’t there yet.' },
  { key: 'click box header', title: 'Collapse / expand the box', detail: '✕ closes it.' },
  { group: 'Popup' },
  { key: 'click toolbar icon', title: 'Open this popup' }
];

async function loadShortcuts() {
  const list = $('#shortcutList');
  list.textContent = '';
  const keys = Object.fromEntries((await chrome.commands.getAll()).map((c) => [c.name, c.shortcut]));
  for (const h of SHORTCUT_HELP) {
    if (h.group) { list.append(el('div', { className: 'sc-group', textContent: h.group })); continue; }
    if (h.note) { list.append(el('div', { className: 'sc-detail', textContent: h.note })); continue; }
    const key = h.name ? keys[h.name] : h.key;
    const k = el('kbd', { textContent: key || 'not set', className: key ? '' : 'unset' });
    if (!key) { k.title = 'Click to set'; k.addEventListener('click', openShortcutSettings); }
    const keysBox = el('span', { className: 'sc-keys' });
    if (h.fallback) keysBox.append(el('kbd', { textContent: h.fallback, title: 'On the page' }));
    if (!h.fallback || key) keysBox.append(k);
    else { const set = el('kbd', { textContent: '+ global key', className: 'unset', title: 'Set a Chrome-wide key' }); set.addEventListener('click', openShortcutSettings); keysBox.append(set); }
    const row = el('div', { className: 'sc-row' }, el('div', { className: 'sc-top' }, el('b', { textContent: h.title }), keysBox));
    if (h.detail) row.append(el('div', { className: 'sc-detail', textContent: h.detail }));
    list.append(row);
  }
}
const openShortcutSettings = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });

// ------------------------------------------------------------------ main
async function initDarkMode() {
  const darkToggle = document.getElementById('darkModeToggle');
  const satToggle = document.getElementById('saturationToggle');
  const darkView = document.getElementById('darkmodeView');
  const quizView = document.getElementById('quizView');
  if (!darkToggle || !satToggle || !darkView || !quizView) return;

  satToggle.checked = false;
  darkView.hidden = false;
  quizView.hidden = true;

  try {
    const res = await send({ type: 'popup:rdmState' });
    if (res && typeof res.on === 'boolean') darkToggle.checked = res.on;
  } catch { /* ignore */ }

  darkToggle.addEventListener('change', () => {
    send({ type: 'popup:rdmToggle', on: darkToggle.checked }).catch(() => {});
  });

  satToggle.addEventListener('change', () => {
    const on = satToggle.checked;
    darkView.hidden = on;
    quizView.hidden = !on;
    send({ type: 'popup:quizSolverToggle', on }).catch(() => {});
  });
}

async function main() {
  [settings, contexts] = await Promise.all([getSettings(), getContexts()]);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab && tab.id;

  initSections();
  $$('.seg button').forEach((b) => b.addEventListener('click', () => { settings.mode = b.dataset.mode; persistSettings(); renderMode(); }));
  renderMode();
  initContexts();
  renderContexts();
  initLLM();
  renderLLM();
  initOptions();
  initHistory();
  initDraft();
  loadDraft();
  loadShortcuts();
  $('#editShortcuts').addEventListener('click', openShortcutSettings);
  if ($('[data-sec="history"] .sec-toggle').getAttribute('aria-expanded') === 'true') loadHistory();
  if ($('[data-sec="lastrun"] .sec-toggle').getAttribute('aria-expanded') === 'true') loadLastRun();

  $('#solve').addEventListener('click', async () => {
    await Promise.all([saveSettings(settings), saveContexts(contexts)]);
    status('Solving…');
    const r = await send({ type: 'popup:command', command: 'solve-quiz' });
    if (r && r.ok) status(`✓ Answered ${r.applied.applied}/${r.total}${r.applied.failed ? ` · ${r.applied.failed} failed to click` : ''}`, 'ok');
    else status('✗ ' + ((r && r.error) || 'Failed'), 'err');
    loadLastRun();
    loadHistory();
  });
  $('#highlight').addEventListener('click', async () => {
    const r = await send({ type: 'popup:highlight' });
    status(r && !r.error ? `Detected ${r.count} question(s) — outlined on the page for 8 s.` : '✗ ' + ((r && r.error) || 'Failed'), r && !r.error ? '' : 'err');
  });

  await initDarkMode();

  // flush pending saves when the popup closes
  addEventListener('pagehide', () => { saveSettings(settings); saveContexts(contexts); });
}

main();
