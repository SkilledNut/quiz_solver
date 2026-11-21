// Quiz Solver — background service worker (MV3, ES module).
// Orchestrates: keyboard commands -> inject content script in all frames -> detect
// questions -> solve (algorithm or LLM, ONE request for all questions) -> apply ->
// record history. Also serves the popup.

import { getSettings, getContexts, resolveLLMConfig } from './lib/storage.js';
import { solveWithLLM, testConnection } from './lib/llm.js';
import { solveWithAlgorithm } from './lib/algorithm.js';
import { formatAnswers, optionLabel, stripEnumerators } from './lib/prompt.js';
import * as History from './lib/history.js';

// ------------------------------------------------------------------ RealDarkMode
let darkModeEnabled = null;
let quizSolverEnabled = false;

async function setQuizSolverEnabled(on) {
  quizSolverEnabled = !!on;
  try { await chrome.storage.local.set({ rdmQuizSolverEnabled: quizSolverEnabled }); } catch { /* ignore */ }
}

chrome.storage.local.get('rdmQuizSolverEnabled').then((r) => {
  quizSolverEnabled = !!(r && r.rdmQuizSolverEnabled);
}).catch(() => {});

async function getDarkModeState() {
  if (darkModeEnabled !== null && darkModeEnabled !== undefined) return darkModeEnabled;
  const { rdmState } = await chrome.storage.local.get('rdmState');
  darkModeEnabled = !!(rdmState && rdmState.on);
  return darkModeEnabled;
}

async function setDarkMode(on) {
  darkModeEnabled = !!on;
  await chrome.storage.local.set({ rdmState: { on: darkModeEnabled } });
  // Notify all tabs to apply/remove the filter
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) =>
      chrome.tabs.sendMessage(t.id, { type: 'rdm:set', on: darkModeEnabled }).catch(() => {})
    ));
  } catch { /* ignore */ }
}

// Apply dark mode to new / updated tabs when globally enabled
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    getDarkModeState().then((on) => {
      if (on) chrome.tabs.sendMessage(tabId, { type: 'rdm:set', on: true }).catch(() => {});
    });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  getDarkModeState().then((on) => {
    if (on) {
      chrome.tabs.onUpdated.addListener(function waiter(tId, info) {
        if (tId === tab.id && info.status === 'complete') {
          chrome.tabs.sendMessage(tId, { type: 'rdm:set', on: true }).catch(() => {});
          chrome.tabs.onUpdated.removeListener(waiter);
        }
      });
    }
  });
});

const busy = new Set();      // tabs currently solving
const IN_PAGE_COMMANDS = new Set(['toggle-label', 'solve-quiz', 'undo-answers', 'redo-answers', 'reapply-answers']);
const manualTimers = new Map();

// ------------------------------------------------------------------ frame helpers
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['src/content.js'] });
  } catch (e) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content.js'] });
    } catch (e2) {
      throw new Error('Cannot run on this page (' + (e2.message || e2) + '). Browser pages like chrome:// and the Web Store are blocked.');
    }
  }
}

async function inFrames(tabId, func, args = [], frameIds) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  let res;
  try {
    res = await chrome.scripting.executeScript({ target, func, args });
  } catch (e) {
    res = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  }
  return (res || []).filter((r) => r && r.result != null);
}

async function tabUrl(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return tab.url || '';
}

async function snapshot(tabId) {
  const res = await inFrames(tabId, () => (globalThis.__QS ? globalThis.__QS.getState() : null));
  return res.flatMap((r) => r.result.entries || []);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setStateAll(tabId, state, flash, force) {
  const res = await inFrames(tabId, (entries, o) => (globalThis.__QS ? globalThis.__QS.setState(entries, o) : null), [state, { flash, force }]);
  return res.reduce((a, r) => ({ applied: a.applied + (r.result.applied || 0), failed: a.failed + (r.result.failed || 0) }), { applied: 0, failed: 0 });
}

async function planAll(tabId, state) {
  const res = await inFrames(tabId, (s) => (globalThis.__QS ? globalThis.__QS.plan(s) : null), [state]);
  return {
    matched: res.reduce((a, r) => a + (r.result.matched || 0), 0),
    actions: res.flatMap((r) => (r.result.actions || []).map((a) => ({ ...a, frameId: r.frameId })))
  };
}

const hasDebugger = () => chrome.permissions.contains({ permissions: ['debugger'] }).catch(() => false);

// ---- trusted input via chrome.debugger (Input.dispatch*Event => isTrusted events)
async function cdp(target, method, params) { return chrome.debugger.sendCommand(target, method, params); }
async function trustedClick(target, x, y) {
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', pointerType: 'mouse' });
  await sleep(25 + Math.random() * 40);
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(40 + Math.random() * 50);
  await cdp(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
}
async function trustedSpace(target) {
  const k = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 };
  await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...k, text: ' ' });
  await sleep(40);
  await cdp(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

// Performs every remaining click with real input. Returns { attempted, ok, error? }.
async function trustedPass(tabId, state) {
  const { actions } = await planAll(tabId, state);
  if (!actions.length) return { attempted: 0, ok: 0 };
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message || '')) return { attempted: 0, ok: 0, error: 'debugger: ' + (e.message || e) };
  }
  await sleep(350); // Chrome's "is debugging this browser" bar shifts the layout; measure after it appears
  const [scroll] = await inFrames(tabId, () => (globalThis.__QS ? globalThis.__QS.scrollPos() : null), [], [0]);
  let ok = 0;
  const log = [];
  try {
    for (const a of actions) {
      const tries = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        const [pt] = await inFrames(tabId, (q, i, at) => (globalThis.__QS ? globalThis.__QS.clickPoint(q, i, at) : null), [a.qid, a.i, attempt], [a.frameId]);
        const p = pt && pt.result;
        if (!p) { tries.push('none'); break; }
        if (p.skip) { tries.push('covered'); continue; }
        if (p.key) await trustedSpace(target); else await trustedClick(target, p.x, p.y);
        await sleep(160);
        const [st] = await inFrames(tabId, (q, i) => (globalThis.__QS ? globalThis.__QS.memberState(q, i) : null), [a.qid, a.i], [a.frameId]);
        const done = !!st && st.result === a.want;
        tries.push(p.key ? 'space' : `click(${Math.round(p.x)},${Math.round(p.y)})` + (done ? ' ✓' : ''));
        if (done) { ok++; break; }
      }
      log.push(`frame ${a.frameId} q ${a.qid} opt ${a.i}: ${tries.join(' → ')}`);
    }
  } catch (e) {
    return { attempted: actions.length, ok, log, error: 'debugger: ' + (e.message || e) }; // e.g. user closed the debugging bar
  } finally {
    if (scroll && scroll.result) await inFrames(tabId, (s) => (globalThis.__QS ? globalThis.__QS.scrollPos(s) : null), [scroll.result], [0]).catch(() => {});
    await chrome.debugger.detach(target).catch(() => {});
  }
  return { attempted: actions.length, ok, log };
}

// Applies a desired state with the configured click method:
//   synthetic — JS events (+ forced property as last resort)
//   auto      — JS events first; answers that did not register get real (trusted) clicks
//   trusted   — real clicks for everything clickable; JS only for dropdowns / leftovers
async function restore(tabId, state, settings) {
  const mode = settings.clickMode || 'auto';
  const trusted = mode !== 'synthetic' && await hasDebugger();
  let tp = { attempted: 0, ok: 0 };
  if (trusted && mode === 'trusted') tp = await trustedPass(tabId, state);
  await setStateAll(tabId, state, settings.flash, !trusted);
  if (trusted && mode === 'auto') tp = await trustedPass(tabId, state);
  let leftover = await planAll(tabId, state);
  if (trusted && leftover.actions.length) {
    await setStateAll(tabId, state, false, true); // final forced fallback
    leftover = await planAll(tabId, state);
  }
  const failedQ = new Set(leftover.actions.map((a) => a.frameId + ':' + a.qid)).size;
  return { applied: Math.max(0, leftover.matched - failedQ), failed: failedQ, failedQids: [...new Set(leftover.actions.map((a) => a.qid))], trustedClicks: tp.ok, trustedError: tp.error || null, trustedLog: tp.log || [], trustedAvailable: trusted, mode };
}

async function notify(tabId, msg, type = 'info', opts = {}) {
  const settings = await getSettings();
  if (!settings.notifications && type !== 'err') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (m, o) => { if (globalThis.__QS) globalThis.__QS.toast(m, o); },
      args: [msg, { type, ...opts }]
    });
  } catch { /* page not scriptable */ }
}

// Persistent answers box (bottom right). items: [{ n, letters, text, question, warn }]
// opts.show: always pop the box up (manual solve), regardless of the notification settings.
async function showLabel(tabId, items, opts = {}) {
  const settings = await getSettings();
  const { show, ...rest } = opts;
  // box off or notifications off: fill it silently, Alt+Shift+H brings it up
  const hidden = !show && (settings.answerLabel === false || !settings.notifications);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (it, o) => { if (globalThis.__QS) globalThis.__QS.label(it, o); },
      args: [items, { ...rest, hidden }]
    });
  } catch { /* page not scriptable */ }
}
const short = (s, n = 70) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');
function labelItem(n, q, sel, warn) {
  q = { ...q, options: stripEnumerators(q.options || []) };
  return {
    n, question: short(q.text, 300), warn: warn || '',
    letters: sel && sel.length ? sel.map(optionLabel).join(',') : '?',
    text: sel && sel.length ? short(sel.map((i) => q.options[i]).join(' · ')) : 'no answer'
  };
}

// Puts the answers of the last run into the box (used after a reload / when the box was never shown).
async function labelFromLastRun(tabId) {
  const { lastRun } = await chrome.storage.local.get('lastRun');
  const settings = await getSettings();
  if (!lastRun || !lastRun.questions || !lastRun.questions.length) return { ok: false, error: 'No answers yet' };
  await inject(tabId);
  const items = lastRun.questions.map((q, i) => labelItem(i + 1, q, q.answer, q.answer && q.answer.length ? '' : 'unparsed'));
  const transparency = settings.discreetTransparency != null ? Math.max(0, Math.min(90, settings.discreetTransparency)) : 50;
  const labelOpts = {
    discreet: !!settings.discreetMode,
    opacity: 1 - transparency / 100
  };
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: (it, o) => globalThis.__QS && globalThis.__QS.label(it, o), args: [items, labelOpts] });
  return { ok: true, state: 'shown' };
}

// Show / hide the answers box (explicit user action, so it ignores the "answerLabel" option).
async function toggleLabel(tabId) {
  await inject(tabId);
  const [r] = await inFrames(tabId, () => (globalThis.__QS ? globalThis.__QS.labelToggle() : 'empty'), [], [0]);
  if (r && r.result !== 'empty') return { ok: true, state: r.result };
  const res = await labelFromLastRun(tabId);
  if (!res.ok) await notify(tabId, 'No answers to show yet.', 'info', { always: true });
  return res;
}

// No badge on the toolbar icon, ever. Clear any left over from older versions.
chrome.action.setBadgeText({ text: '' }).catch(() => {});
chrome.tabs.query({}).then((tabs) => tabs.forEach((t) => chrome.action.setBadgeText({ tabId: t.id, text: '' }).catch(() => {}))).catch(() => {});

// MV3 workers idle out after ~30 s; calling an extension API resets the timer.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  return () => clearInterval(t);
}

// ------------------------------------------------------------------ solve
async function solve(tabId) {
  if (busy.has(tabId)) { await notify(tabId, 'Already solving…'); return { ok: false, error: 'busy' }; }
  busy.add(tabId);
  const stop = keepAlive();
  const t0 = Date.now();
  let questions = [];
  try {
    const settings = await getSettings();
    const contexts = await getContexts();
    const ctx = contexts.find((c) => c.id === settings.activeContextId) || null;
    await inject(tabId);

    const scans = await inFrames(tabId, (o) => (globalThis.__QS ? globalThis.__QS.scan(o) : null), [{ viewportOnly: settings.viewportOnly, watch: true }]);
    const seen = new Set();
    for (const r of scans) {
      for (const q of r.result.questions || []) {
        if (seen.has(q.qid)) continue;
        seen.add(q.qid);
        questions.push({ ...q, frameId: r.frameId });
      }
    }
    if (!questions.length) {
      await notify(tabId, 'No quiz questions detected on this page.', 'err');
      await chrome.storage.local.set({ lastRun: { time: Date.now(), url: await tabUrl(tabId), error: 'No questions detected', questions: [] } });
      return { ok: false, error: 'No questions detected' };
    }

    const url = await tabUrl(tabId);
    await History.push(url, { label: 'Before solve', state: await snapshot(tabId) });

    const modeLabel = settings.mode === 'llm' ? resolveLLMConfig(settings).label : 'algorithm';
    await notify(tabId, `Solving ${questions.length} question${questions.length > 1 ? 's' : ''} (${modeLabel})…`, 'busy', { sticky: true });

    const result = settings.mode === 'llm'
      ? await solveWithLLM(questions, ctx, resolveLLMConfig(settings))
      : solveWithAlgorithm(questions, ctx);

    const desired = [];
    questions.forEach((q, i) => {
      const sel = result.answers[i];
      if (!sel || !sel.length) return;
      desired.push({ qid: q.qid, qh: q.qh, oh: q.oh, nk: q.nk, ord: q.ord, qText: q.text.slice(0, 200), optKeys: q.optKeys, sel, selKeys: sel.map((j) => q.optKeys[j]) });
    });
    const applied = await restore(tabId, desired, settings);
    const failedSet = new Set(applied.failedQids || []);
    await showLabel(tabId, questions.map((q, i) => labelItem(i + 1, q, result.answers[i],
      !result.answers[i] || !result.answers[i].length ? 'unparsed' : failedSet.has(q.qid) ? 'not selected' : '')));

    await History.push(url, { label: `Solved (${settings.mode === 'llm' ? 'LLM' : 'algorithm'})`, state: await snapshot(tabId), solved: true });
    await History.recordSolve(url, { mode: settings.mode, state: desired });

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const unanswered = questions.length - desired.length;
    await chrome.storage.local.set({
      lastRun: {
        time: Date.now(), url, mode: settings.mode, context: ctx ? ctx.name : null, secs,
        meta: result.meta, raw: result.raw, applied,
        questions: questions.map((q, i) => ({ text: q.text, type: q.type, options: q.options, answer: result.answers[i] || [] }))
      }
    });

    const lines = [`✓ ${applied.applied}/${questions.length} answered · ${secs}s${result.meta && result.meta.searched ? ' · web' : ''}`];
    if (unanswered) lines.push(`${unanswered} without a parsable answer`);
    if (applied.trustedClicks) lines.push(`${applied.trustedClicks} answer(s) needed real clicks`);
    if (applied.failed) lines.push(`${applied.failed} could not be clicked` + (applied.trustedAvailable ? '' : ' — answers are in the box; real clicks: popup → Options'));
    if (applied.trustedError) lines.push(applied.trustedError);
    if (questions.length <= 30) lines.push(formatAnswers(result.answers, questions));
    await notify(tabId, lines.join('\n'), applied.failed || unanswered ? 'info' : 'ok', { duration: 5000 });
    return { ok: true, applied, total: questions.length };
  } catch (e) {
    console.error('[QuizSolver]', e);
    await notify(tabId, 'Quiz Solver: ' + (e.message || e), 'err', { duration: 7000 });
    await chrome.storage.local.set({ lastRun: { time: Date.now(), error: e.message || String(e), questions: questions.map((q) => ({ text: q.text, type: q.type, options: q.options, answer: [] })) } });
    return { ok: false, error: e.message || String(e) };
  } finally {
    busy.delete(tabId);
    stop();
  }
}

// ------------------------------------------------------------------ history actions
async function step(tabId, dir) {
  await inject(tabId);
  const url = await tabUrl(tabId);
  let h = await History.load(url);
  if (!h.entries.length) { await notify(tabId, 'No answer history for this page yet.', 'err'); return { ok: false }; }
  // record unsaved live changes first so they can be redone
  const live = await snapshot(tabId);
  if (h.pointer >= 0 && live.length && !History.sameState(live, h.entries[h.pointer].state)) {
    h = await History.push(url, { label: 'Manual change', state: live });
  }
  const target = h.pointer + dir;
  if (target < 0 || target >= h.entries.length) {
    await notify(tabId, dir < 0 ? 'Nothing more to undo.' : 'Nothing to redo.', 'info');
    return { ok: false };
  }
  return restoreIndex(tabId, target, url);
}

async function restoreIndex(tabId, index, url) {
  url = url || await tabUrl(tabId);
  await inject(tabId);
  const h = await History.load(url);
  const entry = h.entries[index];
  if (!entry) return { ok: false };
  const settings = await getSettings();
  const r = await restore(tabId, entry.state, settings);
  await History.setPointer(url, index);
  const time = new Date(entry.time).toLocaleTimeString();
  await notify(tabId, `↶ Restored “${entry.label}” (${time}) · ${r.applied} question${r.applied === 1 ? '' : 's'}${r.failed ? ` · ${r.failed} failed` : ''}`, r.failed ? 'info' : 'ok');
  return { ok: true, ...r };
}

async function reapply(tabId) {
  await inject(tabId);
  const url = await tabUrl(tabId);
  const h = await History.load(url);
  const last = h.solves[h.solves.length - 1];
  if (!last) { await notify(tabId, 'No solved answers stored for this page.', 'err'); return { ok: false }; }
  const live = await snapshot(tabId);
  await History.push(url, { label: 'Manual change', state: live });
  const settings = await getSettings();
  const r = await restore(tabId, last.state, settings);
  await History.push(url, { label: 'Re-applied solved answers', state: await snapshot(tabId), solved: true });
  await notify(tabId, `↻ Re-applied solved answers · ${r.applied} question${r.applied === 1 ? '' : 's'}`, 'ok');
  return { ok: true, ...r };
}

async function recordManual(tabId) {
  if (busy.has(tabId)) return;
  try {
    const url = await tabUrl(tabId);
    const h = await History.load(url);
    if (!h.entries.length) return; // only track pages where the extension was used
    const state = await snapshot(tabId);
    await History.push(url, { label: 'Manual change', state });
  } catch { /* tab gone */ }
}

// ------------------------------------------------------------------ manual mode
// You select text and press shortcuts: question → each answer → solve (single / multi).
// Nothing on the page is clicked; the answer is shown in the toast and the popup.
const DRAFT_KEY = 'manualDraft';
let manualCount = 0;
const ENUM_LINE = /^\s*(?:\(?[a-zA-Z0-9]{1,2}[.):]|\([a-zA-Z0-9]{1,2}\)|[-•*])\s+/;

async function getDraft() {
  const o = await chrome.storage.session.get(DRAFT_KEY);
  return o[DRAFT_KEY] || { question: '', options: [] };
}
const setDraft = (d) => chrome.storage.session.set({ [DRAFT_KEY]: d });

async function selectedText(tabId) {
  const res = await inFrames(tabId, () => {
    const ae = document.activeElement;
    let t = '';
    if (ae && typeof ae.selectionStart === 'number' && typeof ae.value === 'string' && ae.selectionEnd > ae.selectionStart) {
      t = ae.value.slice(ae.selectionStart, ae.selectionEnd);
    } else {
      const s = getSelection();
      t = s ? s.toString() : '';
    }
    return { text: t.replace(/ /g, ' ').trim(), focus: document.hasFocus() };
  });
  const withText = res.map((r) => r.result).filter((r) => r.text);
  const hit = withText.find((r) => r.focus) || withText[0];
  return hit ? hit.text : '';
}

const lines = (t) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

async function manualQuestion(tabId) {
  await inject(tabId);
  const text = await selectedText(tabId);
  if (!text) { await notify(tabId, 'Select the question text first, then press the shortcut.', 'err'); return { ok: false }; }
  // whole block selected (question + "a) … b) …" lines)? split it automatically
  const ls = lines(text);
  const optLines = ls.filter((l) => ENUM_LINE.test(l));
  let draft;
  if (optLines.length >= 2 && ls.length > optLines.length) {
    draft = { question: ls.filter((l) => !ENUM_LINE.test(l)).join(' '), options: optLines };
  } else {
    draft = { question: ls.join(' '), options: [] };
  }
  await setDraft(draft);
  const extra = draft.options.length ? `\n+ ${draft.options.length} answers found in the selection` : '\nNow select each answer + Alt+Shift+O';
  await notify(tabId, `Question saved: “${draft.question.slice(0, 90)}${draft.question.length > 90 ? '…' : ''}”${extra}`, 'info', { duration: 4000 });
  return { ok: true, draft };
}

async function manualAnswer(tabId) {
  await inject(tabId);
  const text = await selectedText(tabId);
  if (!text) { await notify(tabId, 'Select an answer first, then press the shortcut.', 'err'); return { ok: false }; }
  const draft = await getDraft();
  const ls = lines(text);
  const added = ls.length > 1 ? ls : [ls.join(' ')]; // several lines selected = several answers
  for (const a of added) if (!draft.options.includes(a)) draft.options.push(a);
  await setDraft(draft);
  const last = draft.options.length - 1;
  await notify(tabId, `${added.length > 1 ? added.length + ' answers added' : `${optionLabel(last)}) ${added[0].slice(0, 80)}`} · ${draft.options.length} total` +
    (draft.question ? '' : '\n(no question saved yet — Alt+Shift+Q)'), 'info', { duration: 2500 });
  return { ok: true, draft };
}

async function manualSolve(tabId, type) {
  if (busy.has(tabId)) return { ok: false, error: 'busy' };
  await inject(tabId);
  const draft = await getDraft();
  if (draft.options.length < 2) {
    await notify(tabId, `Need at least 2 answers (have ${draft.options.length}). Select each answer + Alt+Shift+O.`, 'err');
    return { ok: false };
  }
  busy.add(tabId);
  const stop = keepAlive();
  const t0 = Date.now();
  try {
    const settings = await getSettings();
    const ctx = (await getContexts()).find((c) => c.id === settings.activeContextId) || null;
    const q = { type, text: draft.question, options: draft.options };
    await notify(tabId, `Solving (${type === 'multi' ? 'multiple choice' : 'single choice'})…`, 'busy', { sticky: true });
    const result = settings.mode === 'llm'
      ? await solveWithLLM([q], ctx, resolveLLMConfig(settings))
      : solveWithAlgorithm([q], ctx);
    const sel = result.answers[0] || [];
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    await chrome.storage.local.set({
      lastRun: { time: Date.now(), url: await tabUrl(tabId), mode: settings.mode, context: ctx ? ctx.name : null, secs, meta: result.meta, raw: result.raw, questions: [{ ...q, answer: sel }] }
    });
    if (!sel.length) {
      await notify(tabId, 'No parsable answer — see popup → Last run.', 'err');
      return { ok: false };
    }
    manualCount = (manualCount || 0) + 1;
    await showLabel(tabId, [labelItem('M' + manualCount, q, sel)], { append: true, show: true });
    const msg = sel.map((i) => `${optionLabel(i)}) ${draft.options[i].slice(0, 90)}`).join('\n');
    await notify(tabId, msg + `\n· ${secs}s${result.meta && result.meta.searched ? ' · web' : ''}`, 'ok', { duration: 12000 });
    return { ok: true, answer: sel, letters: sel.map(optionLabel) };
  } catch (e) {
    await notify(tabId, 'Quiz Solver: ' + (e.message || e), 'err', { duration: 7000 });
    return { ok: false, error: e.message || String(e) };
  } finally {
    busy.delete(tabId);
    stop();
  }
}

// ------------------------------------------------------------------ routing
async function activeTabId() {
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return t && t.id;
}

async function runCommand(command, tabId) {
  if (!quizSolverEnabled) return { ok: false, error: 'Quiz Solver is disabled' };
  tabId = tabId ?? await activeTabId();
  if (tabId == null) return { ok: false };
  try {
    switch (command) {
      case 'solve-quiz': return await solve(tabId);
      case 'undo-answers': return await step(tabId, -1);
      case 'redo-answers': return await step(tabId, +1);
      case 'reapply-answers': return await reapply(tabId);
      case 'manual-question': return await manualQuestion(tabId);
      case 'manual-answer': return await manualAnswer(tabId);
      case 'manual-solve-single': return await manualSolve(tabId, 'single');
      case 'manual-solve-multi': return await manualSolve(tabId, 'multi');
      case 'toggle-label': return await toggleLabel(tabId);
      default: return { ok: false };
    }
  } catch (e) {
    await notify(tabId, 'Quiz Solver: ' + (e.message || e), 'err');
    return { ok: false, error: e.message || String(e) };
  }
}

chrome.commands.onCommand.addListener((command, tab) => { runCommand(command, tab && tab.id); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  if (msg.type === 'rdm:getState') {
    getDarkModeState().then((on) => sendResponse({ on })).catch(() => sendResponse({ on: false }));
    return true;
  }
  if (msg.type === 'rdm:toggle') {
    getDarkModeState().then(async (on) => {
      await setDarkMode(!on);
      sendResponse({ on: !on });
    }).catch((e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'popup:rdmToggle') {
    const next = typeof msg.on === 'boolean' ? msg.on : null;
    getDarkModeState().then(async (on) => {
      const target = next !== null ? next : !on;
      await setDarkMode(target);
      sendResponse({ on: target });
    }).catch((e) => sendResponse({ error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'popup:rdmState') {
    getDarkModeState().then((on) => sendResponse({ on })).catch(() => sendResponse({ on: false }));
    return true;
  }
  if (msg.type === 'popup:quizSolverToggle') {
    setQuizSolverEnabled(!!msg.on).then(() => sendResponse({ ok: true, enabled: quizSolverEnabled })).catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'quizSolver:get') {
    sendResponse({ enabled: quizSolverEnabled });
    return false;
  }
  if (msg.type === 'qs:manual-change') {
    if (!quizSolverEnabled) return false;
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return false;
    clearTimeout(manualTimers.get(tabId));
    manualTimers.set(tabId, setTimeout(() => recordManual(tabId), 400));
    return false;
  }
  if (msg.type === 'qs:hotkey') { // in-page Alt+Shift+H/P/U/Y/L (src/darkmode.js)
    if (!quizSolverEnabled || !IN_PAGE_COMMANDS.has(msg.command)) return false;
    if (sender.tab && sender.tab.id != null) runCommand(msg.command, sender.tab.id).catch(() => {});
    return false;
  }
  const handlers = {
    'popup:command': () => runCommand(msg.command, msg.tabId),
    'popup:restore': () => restoreIndex(msg.tabId, msg.index),
    'popup:history': async () => History.load(await tabUrl(msg.tabId)),
    'popup:clearHistory': async () => { await History.clear(await tabUrl(msg.tabId)); return { ok: true }; },
    'popup:test': async () => testConnection(resolveLLMConfig(await getSettings())),
    'popup:showLabel': () => labelFromLastRun(msg.tabId),
    'popup:draft': () => getDraft(),
    'popup:setDraft': async () => { await setDraft(msg.draft || { question: '', options: [] }); return { ok: true }; },
    'popup:highlight': async () => {
      if (!quizSolverEnabled) return { count: 0 };
      await inject(msg.tabId);
      const r = await inFrames(msg.tabId, () => (globalThis.__QS ? globalThis.__QS.highlight(true) : 0));
      return { count: r.reduce((a, x) => a + (x.result || 0), 0) };
    }
  };
  const h = handlers[msg.type];
  if (!h) return false;
  Promise.resolve().then(h).then(sendResponse, (e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true;
});
