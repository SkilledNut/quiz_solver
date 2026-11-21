/* Quiz Solver — content script.
 *
 * Injected on demand by the background worker into every frame of the active tab
 * (so it also works for quizzes embedded in iframes). Idempotent: safe to inject
 * many times.
 *
 * Responsibilities
 *   - detect questions + answer options in arbitrary HTML (native radios/checkboxes,
 *     ARIA radios/checkboxes/listbox options, <select> dropdowns, open shadow DOM)
 *   - read the current answer state and apply a desired one (robust clicking)
 *   - watch for manual changes so the background can keep an undo history
 *   - show a small on-page toast (top frame only)
 */
(() => {
  'use strict';
  const VERSION = '1.2.0';
  if (globalThis.__QS && globalThis.__QS.version === VERSION) return;

  // ------------------------------------------------------------------ constants
  const NATIVE_CHOICE = 'input[type="radio"],input[type="checkbox"]';
  const ARIA_CHOICE = '[role="radio"],[role="checkbox"],[role="option"]';
  const CHOICE_SELECTOR = NATIVE_CHOICE + ',' + ARIA_CHOICE;

  // Elements that usually wrap exactly one question (stop climbing there).
  const HINT_SELECTOR = [
    '.que', '.question', '.questionContainer', '.question-container', '.quiz-question', '.quiz_question',
    '.display_question', '.question-wrapper', '.questionWrapper', '.question-block', '.wpProQuiz_listItem',
    'fieldset', '[role="listitem"]', '[data-question-id]', '[data-questionid]', '[data-question]',
    '[data-automation-id="questionItem"]', 'li.question', '.Qr7Oae', '.geS5n'
  ].join(',');

  // Elements that usually hold the question stem (ordered by specificity).
  const QTEXT_SELECTORS = [
    '.qtext', '.question_text', '.questiontext', '.question-text', '.questionText', '.question-title',
    '.questionTitle', '[data-automation-id="questionTitle"]', '.wpProQuiz_question_text', '.M7eMe',
    '[role="heading"]', 'legend', 'h1,h2,h3,h4,h5,h6'
  ];

  const NAV_SELECTOR = 'nav,header,footer,[role="navigation"],[role="banner"],[role="contentinfo"],[role="menubar"],[role="toolbar"],[role="tablist"],[role="menu"]';
  const CUSTOM_SELECT_WIDGET = '.select2,.select2-container,.chosen-container,.choices,.ts-wrapper,.selectize-control,[role="combobox"]';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT',
    'SELECT', 'OPTION', 'TEXTAREA', 'INPUT', 'BUTTON', 'VIDEO', 'AUDIO']);
  const HOST_ID = '__quiz_solver_toast_host__';
  const LABEL_ID = '__quiz_solver_label_host__';
  const CLEAR_CHOICE_RE = /^(clear my choice|clear selection|clear choice|počisti mojo izbiro|počisti izbiro)$/i;
  const PLACEHOLDER_RE = /^(?:choose|select|pick|please|izberi|izberite|wähle|bitte|seleccione|choisir|--+|—+|\.\.\.|…|-)/i;

  const NOISE_RE = new RegExp('(?<![\\p{L}\\p{N}])(?:' + [
    'not yet answered', 'answer saved', 'not answered', 'incomplete answer',
    'marked out of\\s*[\\d.,]+', 'mark\\s*[\\d.,]+\\s*out of\\s*[\\d.,]+', 'flag question', 'remove flag',
    'clear my choice', 'question text', 'select one or more\\s*:?', 'select one\\s*:?', 'choose one\\s*:?',
    'question\\s*\\d+(?:\\s*of\\s*\\d+)?', 'points?\\s*:?\\s*[\\d.,]+', '[\\d.,]+\\s*(?:points?|pts)',
    'še ni odgovorjeno', 'odgovor shranjen', 'ni odgovorjeno', 'označi vprašanje', 'odstrani oznako',
    'počisti mojo izbiro', 'izberite enega ali več\\s*:?', 'izberite enega\\s*:?', 'izberite en odgovor\\s*:?',
    'besedilo vprašanja', 'vprašanje\\s*\\d+', 'največ\\s*[\\d.,]+\\s*točk\\w*', 'točk\\w*\\s*:?\\s*[\\d.,]+'
  ].join('|') + ')(?![\\p{L}\\p{N}])', 'giu');

  // ------------------------------------------------------------------ helpers
  const norm = (s) => (s || '').replace(/[\s ​‌‍﻿]+/g, ' ').trim();
  const fold = (s) => norm(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const ENUM_RE = /^\s*(?:\(?[a-z0-9]{1,2}[.):]|\([a-z0-9]{1,2}\))\s+/i;
  const optKey = (s) => fold(s).replace(ENUM_RE, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const cleanNoise = (s) => norm(String(s || '').replace(NOISE_RE, ' ')).replace(/^[\s:.\-–—|*]+/, '').replace(/\s*\*+$/, '').trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  const parentOf = (n) => {
    if (!n) return null;
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    return p && p.host ? p.host : null; // cross open/closed shadow boundary
  };
  function containsDeep(a, b) { for (let n = b; n; n = parentOf(n)) if (n === a) return true; return false; }
  function closestDeep(el, sel) {
    for (let n = el; n; n = parentOf(n)) if (n.nodeType === 1 && n.matches(sel)) return n;
    return null;
  }
  function deepQueryAll(root, sel, out = []) {
    root.querySelectorAll(sel).forEach((e) => out.push(e));
    for (const e of root.querySelectorAll('*')) if (e.shadowRoot) deepQueryAll(e.shadowRoot, sel, out);
    return out;
  }
  function getById(el, id) {
    const root = el.getRootNode();
    return (root && root.getElementById && root.getElementById(id)) || document.getElementById(id);
  }
  const textOf = (el) => norm(el ? (el.innerText !== undefined ? el.innerText : el.textContent) : '');
  const docOrder = (a, b) => (a === b ? 0 : (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  function cssVisible(el) {
    if (!el.checkVisibility) return true;
    if (el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true })) return true;
    try { return getComputedStyle(el).display === 'contents'; } catch { return false; }
  }
  function isShown(el) {
    if (!el || el.nodeType !== 1 || !el.isConnected) return false;
    if (!cssVisible(el)) return false;
    for (const r of el.getClientRects()) if (r.width > 0 && r.height > 0) return true;
    return false;
  }
  function inViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  }

  // Visible text of `root`, skipping excluded nodes, optionally only between two boundaries.
  function collectText(root, exclude, after = null, before = null) {
    const parts = [];
    let started = !after, done = false;
    const visit = (n) => {
      if (done) return;
      if (n === before) { done = true; return; }
      if (n === after) { started = true; return; }
      if (n.nodeType === 3) {
        if (started && !(exclude && exclude.has(n))) { const t = norm(n.data); if (t) parts.push(t); }
        return;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        const skip = SKIP_TAGS.has(n.tagName) || (exclude && exclude.has(n)) || n.id === HOST_ID || n.id === LABEL_ID ||
          n.getAttribute('aria-hidden') === 'true' || n.matches(ARIA_CHOICE) || !cssVisible(n);
        if (skip) {
          if (after && !started && n.contains(after)) started = true;
          if (before && n.contains(before)) done = true;
          return;
        }
        if (n.tagName === 'IMG') { if (started && n.alt) parts.push(norm(n.alt)); return; }
      }
      const kids = n.shadowRoot ? n.shadowRoot.childNodes
        : (n.tagName === 'SLOT' ? n.assignedNodes({ flatten: true }) : n.childNodes);
      for (const k of kids) { visit(k); if (done) return; }
    };
    visit(root);
    return norm(parts.join(' '));
  }

  // ------------------------------------------------------------------ option text
  function labelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return norm(ids.map((id) => { const t = getById(el, id); return t && t !== el ? textOf(t) : ''; }).join(' '));
  }
  function siblingText(el, sources) {
    let out = '', n = el.nextSibling, steps = 0;
    while (n && steps++ < 12) {
      if (n.nodeType === 1) {
        if (n.tagName === 'BR' || n.tagName === 'HR') break;
        if (n.matches(CHOICE_SELECTOR) || n.tagName === 'SELECT' || n.querySelector(CHOICE_SELECTOR + ',select')) break;
        if (!SKIP_TAGS.has(n.tagName)) {
          if (/^(P|DIV|H[1-6]|LI|UL|OL|TABLE|FIELDSET|SECTION)$/.test(n.tagName) && out) break;
          const t = textOf(n);
          if (t) { out += ' ' + t; sources.push(n); }
        }
      } else if (n.nodeType === 3) {
        const t = norm(n.data);
        if (t) { out += ' ' + t; sources.push(n); }
      }
      n = n.nextSibling;
    }
    return norm(out);
  }
  function columnHeader(el) {
    const td = closestDeep(el, 'td,th');
    const table = td && closestDeep(td, 'table');
    if (!table) return '';
    const headRow = (table.tHead && table.tHead.rows[0]) || table.rows[0];
    if (!headRow || headRow === td.parentElement) return '';
    const th = headRow.cells[td.cellIndex];
    return th ? textOf(th) : '';
  }
  function choiceText(m, sources) {
    const el = m.el;
    let t;
    if ((t = labelledByText(el))) return t;
    if (m.native && el.labels && el.labels.length) {
      t = norm([...el.labels].map(textOf).join(' '));
      if (t) return t;
    }
    if ((t = norm(el.getAttribute('aria-label')))) return t;
    if (!m.native && (t = textOf(el))) return t;
    if (m.row !== el) { t = textOf(m.row); if (t && t.length <= 600) return t; }
    if ((t = siblingText(el, sources))) return t;
    if ((t = columnHeader(el))) return t;
    const img = m.row.querySelector && m.row.querySelector('img[alt]');
    if (img && (t = norm(img.alt))) return t;
    const v = m.native && el.value && !/^(on|-?\d+)$/i.test(el.value) ? el.value : '';
    return norm(el.getAttribute('title') || el.getAttribute('data-value') || v);
  }

  // ------------------------------------------------------------------ detection
  let lastGroups = [];

  function detectGroups(opts = {}) {
    // 1. candidate choice elements
    const seen = new Set();
    const cands = [];
    for (const el of deepQueryAll(document, CHOICE_SELECTOR)) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (closestDeep(el, NAV_SELECTOR)) continue;
      const native = el.tagName === 'INPUT';
      if (native) {
        if (el.disabled) continue;
      } else {
        if (el.matches('input,select,option,textarea')) continue;
        if (el.getAttribute('aria-disabled') === 'true') continue;
        if (el.querySelector(NATIVE_CHOICE)) continue; // wrapper around a native control -> use the native one
      }
      if (closestDeep(el, '[aria-hidden="true"]')) continue;
      const role = native ? el.type : el.getAttribute('role');
      let multi = native ? el.type === 'checkbox' : role === 'checkbox';
      let container = null;
      if (role === 'option') {
        container = closestDeep(el, '[role="listbox"]');
        if (!container || !isShown(container)) continue;
        multi = container.getAttribute('aria-multiselectable') === 'true';
      }
      cands.push({ el, native, role, multi, container });
    }

    const selects = deepQueryAll(document, 'select').filter(selectEligible);

    // ancestor -> number of candidates (and selects) below it
    const countMap = new Map();
    const bump = (el) => { for (let n = parentOf(el); n; n = parentOf(n)) countMap.set(n, (countMap.get(n) || 0) + 1); };
    cands.forEach((c) => bump(c.el));
    selects.forEach(bump);
    const count = (n) => countMap.get(n) || 0;

    // 2. per-choice row / label / text
    for (const m of cands) {
      const sources = [];
      m.label = m.native && m.el.labels && m.el.labels[0] ? m.el.labels[0] : null;
      let row = m.el, n = parentOf(m.el), steps = 0;
      while (n && steps++ < 6 && n !== document.body && count(n) <= 1) { row = n; n = parentOf(n); }
      m.row = row;
      m.text = choiceText(m, sources).slice(0, 500);
      m.sources = sources;
      m.region = row !== m.el ? row : (m.label || m.el);
      m.visible = isShown(m.el) || isShown(m.region) || (m.label && isShown(m.label)) ||
        sources.some((s) => s.nodeType === 1 && isShown(s));
    }
    const live = cands.filter((m) => !CLEAR_CHOICE_RE.test(m.text));

    // 3. grouping
    const groups = [];
    const keyed = new Map();
    const loose = [];
    for (const m of live) {
      let key = null;
      if (m.native && m.el.type === 'radio' && m.el.name) {
        key = 'n|' + oid(m.el.form || m.el.getRootNode()) + '|' + m.el.name;
      } else if (m.container) {
        key = 'c|' + oid(m.container);
      } else if (!m.native && m.role === 'radio') {
        const g = closestDeep(m.el, '[role="radiogroup"]');
        if (g) { m.container = g; key = 'c|' + oid(g); }
      }
      if (key) {
        if (!keyed.has(key)) keyed.set(key, []);
        keyed.get(key).push(m);
      } else loose.push(m);
    }
    for (const members of keyed.values()) groups.push({ kind: 'choice', members, container: members[0].container || null });

    // loose choices (checkboxes, ungrouped radios): cluster by nearest shared ancestor, then split flat layouts
    const looseCount = new Map();
    loose.forEach((m) => { for (let n = parentOf(m.el); n; n = parentOf(n)) looseCount.set(n, (looseCount.get(n) || 0) + 1); });
    const clusters = new Map();
    for (const m of loose) {
      let a = parentOf(m.el);
      while (a && (looseCount.get(a) || 0) < 2) a = parentOf(a);
      if (!a) continue;
      if (!clusters.has(a)) clusters.set(a, []);
      clusters.get(a).push(m);
    }
    const allSources = new Set();
    live.forEach((m) => m.sources.forEach((s) => allSources.add(s)));
    for (const [a, members] of clusters) {
      for (const run of splitFlat(a, members, allSources)) groups.push({ kind: 'choice', members: run, container: null });
    }

    // finalize choice groups
    const out = [];
    for (const g of groups) {
      g.members.sort((x, y) => docOrder(x.el, y.el));
      if (g.members.length < 2) continue;
      const vis = g.members.filter((m) => m.visible);
      if (!opts.includeHidden && vis.length < 2) continue;
      if (vis.length >= 2 && vis.length < g.members.length) g.members = vis;
      g.multi = g.members.some((m) => m.multi);
      out.push(g);
    }

    // selects
    for (const s of selects) {
      const opts2 = [...s.options];
      const real = [], ph = [];
      opts2.forEach((o, i) => (isPlaceholder(o, i) ? ph : real).push(o));
      if (real.length < 2) continue;
      const visible = isShown(s) || [s.nextElementSibling, s.parentElement].some((w) => w && w.matches && w.matches(CUSTOM_SELECT_WIDGET) && isShown(w));
      if (!visible && !opts.includeHidden) continue;
      out.push({
        kind: 'select', select: s, multi: s.multiple, placeholder: ph[0] || null,
        members: real.map((o) => ({ el: o, text: norm(o.label || o.text).slice(0, 500), native: true, isOption: true }))
      });
    }

    out.sort((x, y) => docOrder(anchorOf(x), anchorOf(y)));
    describeGroups(out);
    let res = out.filter((g) => g.text || g.members.some((m) => m.text));
    if (opts.viewportOnly) res = res.filter((g) => inViewport(g.block) || g.members.some((m) => m.region && inViewport(m.region)));
    return res;
  }

  function anchorOf(g) { return g.kind === 'select' ? g.select : g.members[0].el; }

  function isPlaceholder(o, i) {
    const t = norm(o.text);
    return o.value === '' || !t || (i === 0 && PLACEHOLDER_RE.test(t));
  }
  function selectEligible(s) {
    if (s.disabled || closestDeep(s, NAV_SELECTOR)) return false;
    const hasPh = [...s.options].some((o, i) => isPlaceholder(o, i));
    return hasPh || !!closestDeep(s, HINT_SELECTOR);
  }

  // Splits a cluster of choices that share a parent with no wrapper per question
  // (e.g. <p>Q1</p><label>..</label><label>..</label><p>Q2</p>...).
  function splitFlat(container, members, optionSources) {
    if (members.length < 2) return [members];
    const childOf = (el) => { let n = el; while (n && parentOf(n) !== container) n = parentOf(n); return n; };
    const byChild = new Map();
    for (const m of members) {
      const ch = childOf(m.el);
      if (!byChild.has(ch)) byChild.set(ch, []);
      byChild.get(ch).push(m);
    }
    const kids = container.shadowRoot ? container.shadowRoot.childNodes : container.childNodes;
    const runs = [];
    let cur = [];
    for (const k of kids) {
      if (byChild.has(k)) { cur.push(...byChild.get(k)); continue; }
      if (!cur.length || k.nodeType !== 1 || optionSources.has(k)) continue;
      if (k.tagName === 'BR' || k.tagName === 'LABEL' || SKIP_TAGS.has(k.tagName)) continue;
      if (members.some((m) => m.label === k || m.row === k)) continue;
      const t = textOf(k);
      if (t.length >= 2 && isShown(k)) { runs.push(cur); cur = []; }
    }
    if (cur.length) runs.push(cur);
    const covered = runs.reduce((a, r) => a + r.length, 0);
    return covered === members.length ? runs : [members];
  }

  // Locates each group's question block and computes question text + fingerprints.
  function describeGroups(groups) {
    const anchorCount = new Map();
    const anchors = (g) => (g.kind === 'select' ? [g.select] : g.members.map((m) => m.el));
    for (const g of groups) for (const a of anchors(g)) {
      for (let n = parentOf(a); n; n = parentOf(n)) anchorCount.set(n, (anchorCount.get(n) || 0) + 1);
    }
    const ac = (n) => anchorCount.get(n) || 0;

    const exclude = new Set();
    for (const g of groups) for (const m of g.members) {
      if (m.isOption) continue;
      [m.row, m.label, m.region, ...(m.sources || [])].forEach((x) => x && exclude.add(x));
    }

    const ordCounter = new Map();
    const usedQid = new Set();
    groups.forEach((g, gi) => {
      const as = anchors(g);
      const size = as.length;
      const start = lca(as);
      let block = start, steps = 0;
      while (block && !(block.matches && block.matches(HINT_SELECTOR))) {
        const p = parentOf(block);
        if (!p || p === document.body || p === document.documentElement || ac(p) > size || steps++ > 12) break;
        block = p;
      }
      g.block = block && block.nodeType === 1 ? block : document.body;
      const exclusive = ac(g.block) <= size;

      const first = g.kind === 'select' ? g.select : (g.members[0].region || g.members[0].el);
      let prevEnd = null;
      if (gi > 0) {
        const pg = groups[gi - 1];
        const last = pg.kind === 'select' ? pg.select : (pg.members[pg.members.length - 1].region || pg.members[pg.members.length - 1].el);
        if (containsDeep(g.block, last) && last !== g.block) prevEnd = last;
      }

      let text = '';
      if (g.container) text = cleanNoise(labelledByText(g.container));
      if (!text && exclusive) text = knownText(g.block, exclude);
      if (!text && g.container) text = cleanNoise(g.container.getAttribute('aria-label') || '');
      if (!text) {
        let generic = cleanNoise(collectText(g.block, exclude, prevEnd, first));
        if (!generic && exclusive) generic = cleanNoise(collectText(g.block, exclude));
        text = generic;
      }
      if (!text || text.length < 3) {
        const outside = precedingOutside(g.block, exclude, ac);
        if (outside) text = norm(outside + ' ' + text);
      }
      // stems in table rows / dropdown matching: prefix the overall question
      if (g.kind === 'select' || g.block.tagName === 'TR' || text.length < 12) {
        const outer = closestDeep(parentOf(g.block), HINT_SELECTOR);
        let ctx = outer ? knownText(outer, exclude) : '';
        if (!ctx && g.block.tagName === 'TR') {
          const table = closestDeep(g.block, 'table');
          if (table) ctx = (table.caption && textOf(table.caption)) || precedingOutside(table, exclude, ac);
        }
        if (ctx && !text.includes(ctx)) text = norm(ctx + ' — ' + text);
      }
      if (text.length > 1500) text = '…' + text.slice(-1500);
      g.text = text;

      g.optKeys = g.members.map((m, i) => optKey(m.text) || ('#' + i));
      g.oh = hash([...g.optKeys].sort().join('|'));
      g.qh = hash(fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').slice(0, 300));
      const ordKey = g.oh;
      g.ord = ordCounter.get(ordKey) || 0;
      ordCounter.set(ordKey, g.ord + 1);
      let qid = g.qh + '.' + g.oh;
      while (usedQid.has(qid)) qid += '+';
      usedQid.add(qid);
      g.qid = qid;
      g.nk = nameKey(g);
    });
  }

  function nameKey(g) {
    if (g.kind === 'select') return g.select.name ? 'sel:' + g.select.name : (g.select.id ? 'sel#' + g.select.id : '');
    const names = g.members.map((m) => (m.native ? m.el.name : '')).filter(Boolean);
    if (names.length !== g.members.length) return '';
    if (g.members[0].el.type === 'radio') return 'r:' + names[0];
    let p = names[0];
    for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
    return p.length >= 3 ? 'c:' + p : '';
  }

  function lca(nodes) {
    if (nodes.length === 1) return nodes[0];
    const chain = [];
    for (let n = nodes[0]; n; n = parentOf(n)) chain.push(n);
    const idx = new Map(chain.map((n, i) => [n, i]));
    let best = 0;
    for (let i = 1; i < nodes.length; i++) {
      let n = nodes[i];
      while (n && !idx.has(n)) n = parentOf(n);
      if (!n) return document.body;
      best = Math.max(best, idx.get(n));
    }
    return chain[best];
  }

  function knownText(root, exclude) {
    for (const sel of QTEXT_SELECTORS) {
      for (const e of root.querySelectorAll(sel)) {
        let bad = false;
        for (let n = e; n && n !== root; n = parentOf(n)) if (exclude.has(n)) { bad = true; break; }
        if (bad || e.querySelector(CHOICE_SELECTOR + ',select')) continue;
        const t = cleanNoise(collectText(e, exclude));
        if (t.length >= 3) return t;
      }
    }
    return '';
  }

  function precedingOutside(block, exclude, ac) {
    const out = [];
    let len = 0, n = block, levels = 0;
    while (n && levels++ < 4 && len < 400) {
      for (let s = n.previousSibling; s; s = s.previousSibling) {
        if (s.nodeType === 1 && (ac(s) > 0 || s.matches(CHOICE_SELECTOR) || s.tagName === 'SELECT')) return norm(out.join(' '));
        const t = s.nodeType === 3 ? norm(s.data) : (s.nodeType === 1 ? collectText(s, exclude) : '');
        if (t) { out.unshift(cleanNoise(t)); len += t.length; if (len >= 400) break; }
      }
      n = parentOf(n);
      if (!n || n === document.body) break;
    }
    return norm(out.join(' ')).slice(-600);
  }

  const W = new WeakMap();
  let wSeq = 0;
  function oid(o) { if (!W.has(o)) W.set(o, ++wSeq); return W.get(o); }

  // ------------------------------------------------------------------ state
  function isChecked(m) {
    if (m.isOption) return m.el.selected;
    if (m.native) return m.el.checked;
    return m.el.getAttribute('aria-checked') === 'true' || m.el.getAttribute('aria-selected') === 'true';
  }
  const selectedIdx = (g) => g.members.map((m, i) => (isChecked(m) ? i : -1)).filter((i) => i >= 0);

  function toQuestion(g) {
    return {
      qid: g.qid, qh: g.qh, oh: g.oh, nk: g.nk, ord: g.ord,
      kind: g.kind, type: g.multi ? 'multi' : 'single',
      text: g.text, options: g.members.map((m) => m.text), optKeys: g.optKeys,
      selected: selectedIdx(g)
    };
  }
  function toEntry(g) {
    const sel = selectedIdx(g);
    return {
      qid: g.qid, qh: g.qh, oh: g.oh, nk: g.nk, ord: g.ord, qText: g.text.slice(0, 200),
      optKeys: g.optKeys, sel, selKeys: sel.map((i) => g.optKeys[i])
    };
  }

  function similarity(a, b) {
    const A = new Set(fold(a).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const B = new Set(fold(b).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    if (!A.size || !B.size) return 0;
    let i = 0;
    for (const x of A) if (B.has(x)) i++;
    return i / (A.size + B.size - i);
  }

  function matchGroup(e, groups, used) {
    const free = groups.filter((g) => !used.has(g));
    let c;
    if (e.nk) { c = free.filter((g) => g.nk === e.nk); if (c.length === 1) return c[0]; }
    c = free.filter((g) => g.qid === e.qid);
    if (c.length) return c[0];
    c = free.filter((g) => g.oh === e.oh);
    if (c.length === 1) return c[0];
    if (c.length > 1) {
      c.sort((x, y) => (similarity(e.qText, y.text) - similarity(e.qText, x.text)) || (Math.abs(x.ord - e.ord) - Math.abs(y.ord - e.ord)));
      return c[0];
    }
    c = free.filter((g) => g.qh === e.qh && g.members.length === (e.optKeys || []).length);
    return c.length === 1 ? c[0] : null;
  }

  // ------------------------------------------------------------------ applying
  let suppressUntil = 0;
  let applying = false;

  function nativeSet(el, prop, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, prop) ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, prop);
    if (desc && desc.set) desc.set.call(el, value); else el[prop] = value;
  }
  function fireInputChange(el) {
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }
  function fireClick(el) {
    const r = el.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new P('pointerdown', { ...base, buttons: 1, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    if (el.focus) try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    el.dispatchEvent(new P('pointerup', { ...base, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', base));
    el.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
  }
  function keyActivate(el) {
    if (el.focus) try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
    const o = { key: ' ', code: 'Space', keyCode: 32, which: 32, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  async function waitFor(fn, ms = 300) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await sleep(25); }
    return fn();
  }

  // force=false skips the "set the property directly" fallback, so the background can
  // try real (trusted) input first — a forced property can look right while the page's
  // own logic never registered the answer.
  async function setChoice(m, want, force = true) {
    if (isChecked(m) === want) return true;
    const attempts = m.native
      ? [() => m.el.click(), () => m.label && m.label.click(), force && (() => { nativeSet(m.el, 'checked', want); fireInputChange(m.el); })]
      : [() => fireClick(m.el), () => m.el.click(), () => m.region && m.region !== m.el && fireClick(m.region), () => keyActivate(m.el)];
    for (const a of attempts) {
      if (!a) continue;
      try { a(); } catch { /* try next */ }
      if (await waitFor(() => isChecked(m) === want)) return true;
    }
    return isChecked(m) === want;
  }

  async function applyGroup(g, idx, flash, force = true) {
    if (g.kind === 'select') {
      const s = g.select;
      if (s.multiple) {
        g.members.forEach((m, i) => { m.el.selected = idx.has(i); });
      } else {
        const target = idx.size ? g.members[[...idx][0]].el : g.placeholder;
        if (!target) return false;
        if (!target.selected) { nativeSet(s, 'selectedIndex', target.index); }
      }
      s.dispatchEvent(new Event('focus', { bubbles: false }));
      fireInputChange(s);
      s.dispatchEvent(new Event('blur', { bubbles: false }));
      if (flash) flashEl(isShown(s) ? s : (s.nextElementSibling || s));
      return true;
    }
    let ok = true;
    if (!g.multi) {
      if (!idx.size) {
        // clear a single-choice question (only possible for native radios)
        for (const m of g.members) if (m.native && m.el.checked) { nativeSet(m.el, 'checked', false); fireInputChange(m.el); }
        return true;
      }
      const m = g.members[[...idx][0]];
      ok = await setChoice(m, true, force);
      if (ok && flash) flashEl(m.region || m.el);
    } else {
      for (let i = 0; i < g.members.length; i++) {
        const m = g.members[i];
        const want = idx.has(i);
        if (isChecked(m) !== want) {
          ok = (await setChoice(m, want, force)) && ok;
          await sleep(15);
        }
        if (want && flash) flashEl(m.region || m.el);
      }
    }
    return ok;
  }

  // Maps stored/desired entries onto the groups currently in the DOM.
  function resolveEntries(entries) {
    const groups = detectGroups({ includeHidden: true });
    lastGroups = groups;
    const used = new Set();
    const out = [];
    let missing = 0;
    for (const e of entries || []) {
      const g = matchGroup(e, groups, used);
      if (!g) { missing++; continue; }
      used.add(g);
      let idx;
      const sameOpts = (e.optKeys || []).join('\u0001') === g.optKeys.join('\u0001');
      if (sameOpts) idx = e.sel || [];
      else {
        idx = (e.selKeys || []).map((k) => g.optKeys.indexOf(k)).filter((i) => i >= 0);
        if (idx.length !== (e.selKeys || []).length && (e.optKeys || []).length === g.members.length) idx = e.sel || [];
      }
      out.push({ e, g, idx: new Set(idx.filter((i) => i >= 0 && i < g.members.length)) });
    }
    return { items: out, missing };
  }

  async function setState(entries, opts = {}) {
    applying = true;
    suppressUntil = Infinity;
    const res = { applied: 0, failed: 0, missing: 0, details: [] };
    try {
      const { items, missing } = resolveEntries(entries);
      res.missing = missing;
      for (const { e, g, idx } of items) {
        const ok = await applyGroup(g, idx, opts.flash, opts.force !== false);
        if (ok) res.applied++; else res.failed++;
        res.details.push({ qid: e.qid, matched: g.qid, ok });
      }
    } finally {
      applying = false;
      suppressUntil = Date.now() + 900;
    }
    return res;
  }

  // Clicks still needed to reach `entries` (used by the trusted-input pass).
  // Dropdowns and "clear a radio group" are not clickable -> handled by setState.
  function plan(entries) {
    const { items } = resolveEntries(entries);
    const actions = [];
    for (const { g, idx } of items) {
      if (g.kind === 'select') continue;
      if (!g.multi) {
        if (!idx.size) continue;
        const i = [...idx][0];
        if (!isChecked(g.members[i])) actions.push({ qid: g.qid, i, want: true });
      } else {
        g.members.forEach((m, i) => { if (isChecked(m) !== idx.has(i)) actions.push({ qid: g.qid, i, want: idx.has(i) }); });
      }
    }
    return { matched: items.length, actions };
  }

  // ------------------------------------------------------------------ trusted-input support
  // The background clicks with chrome.debugger (real, isTrusted input). It needs the
  // point in top-level viewport coordinates, so frames report their offset via a
  // postMessage handshake with the parent frame's content script (works cross-origin).
  const offsetWaiters = new Map();
  addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__qsOffReq && e.source) {
      const fr = deepQueryAll(document, 'iframe,frame').find((f) => f.contentWindow === e.source);
      if (!fr) return;
      const r = fr.getBoundingClientRect();
      const cs = getComputedStyle(fr);
      const x = r.left + fr.clientLeft + (parseFloat(cs.paddingLeft) || 0);
      const y = r.top + fr.clientTop + (parseFloat(cs.paddingTop) || 0);
      frameOffset().then((o) => e.source.postMessage({ __qsOffRes: d.__qsOffReq, x: x + o.x, y: y + o.y, ok: o.ok }, '*'));
    } else if (d.__qsOffRes && offsetWaiters.has(d.__qsOffRes)) {
      offsetWaiters.get(d.__qsOffRes)(d);
      offsetWaiters.delete(d.__qsOffRes);
    }
  });
  function frameOffset() {
    if (window === window.top) return Promise.resolve({ x: 0, y: 0, ok: true });
    return new Promise((resolve) => {
      const id = 'qs' + Math.random().toString(36).slice(2);
      const t = setTimeout(() => { offsetWaiters.delete(id); resolve({ x: 0, y: 0, ok: false }); }, 800);
      offsetWaiters.set(id, (d) => { clearTimeout(t); resolve({ x: d.x, y: d.y, ok: d.ok !== false }); });
      window.parent.postMessage({ __qsOffReq: id }, '*');
    });
  }
  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }
  function findMember(qid, i) {
    const groups = detectGroups({ includeHidden: true });
    lastGroups = groups;
    const g = groups.find((x) => x.qid === qid);
    return g && g.members[i] ? { g, m: g.members[i] } : null;
  }
  function clickTargets(m) {
    const list = [];
    const add = (e) => { if (e && e.nodeType === 1 && !list.includes(e) && isShown(e)) list.push(e); };
    add(m.el);
    add(m.label);
    if (m.region !== m.row) add(m.region);
    (m.sources || []).forEach(add);
    add(m.row);
    return list;
  }
  function isRelated(hit, t, m) {
    if (!hit) return false;
    if ([t, m.el, m.label, m.region, m.row].some((a) => a && containsDeep(a, hit))) return true;
    // an overlay/wrapper around exactly this option is fine; around several options is not
    return containsDeep(hit, t) && hit.querySelectorAll(CHOICE_SELECTOR).length <= 1;
  }

  // Returns { x, y } (top-viewport coordinates) for click attempt #attempt,
  // { key: true } when the last resort is a keyboard Space on the focused control,
  // { skip: true } when this candidate is covered by something else, or null when exhausted.
  async function clickPoint(qid, i, attempt = 0) {
    suppressUntil = Date.now() + 3000;
    const f = findMember(qid, i);
    if (!f || f.m.isOption) return null;
    const { m } = f;
    const targets = clickTargets(m);
    if (attempt === targets.length) {
      try { m.el.focus({ preventScroll: false }); } catch { /* ignore */ }
      return document.activeElement === m.el || containsDeep(m.el, document.activeElement) ? { key: true } : null;
    }
    if (attempt > targets.length) return null;
    const t = targets[attempt];
    t.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await sleep(80);
    const rects = [...t.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
    for (const r of rects) {
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + Math.min(8, r.width / 2), r.top + r.height / 2]];
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (!isRelated(deepElementFromPoint(x, y), t, m)) continue;
        const off = await frameOffset();
        return { x: x + off.x, y: y + off.y, offsetKnown: off.ok };
      }
    }
    return { skip: true };
  }
  function memberState(qid, i) {
    suppressUntil = Date.now() + 3000;
    const g = lastGroups.find((x) => x.qid === qid);
    const m = g && g.members[i];
    if (!m || !m.el.isConnected) { const f = findMember(qid, i); return f ? isChecked(f.m) : null; }
    return isChecked(m);
  }
  function scrollPos(set) {
    if (set) { window.scrollTo({ left: set[0], top: set[1], behavior: 'instant' }); return true; }
    return [scrollX, scrollY];
  }

  // ------------------------------------------------------------------ flash / debug overlay
  let styleInjected = false;
  function ensureStyle() {
    if (styleInjected) return;
    styleInjected = true;
    const st = document.createElement('style');
    st.textContent = '[data-qs-flash]{outline:2px solid #22c55e !important;outline-offset:2px !important;border-radius:4px}' +
      '[data-qs-debug]{outline:2px dashed #6366f1 !important;outline-offset:3px !important;position:relative}' +
      '[data-qs-debug]::before{content:attr(data-qs-debug);position:absolute;top:-10px;left:-6px;z-index:2147483646;' +
      'background:#6366f1;color:#fff;font:600 11px/16px system-ui,sans-serif;padding:0 5px;border-radius:8px;pointer-events:none}' +
      '[data-qs-debug-opt]{outline:1px solid #a5b4fc !important}';
    (document.head || document.documentElement).appendChild(st);
  }
  function flashEl(el) {
    if (!el || !el.setAttribute) return;
    ensureStyle();
    el.setAttribute('data-qs-flash', '');
    setTimeout(() => el.removeAttribute('data-qs-flash'), 1400);
  }
  function highlight(on = true) {
    ensureStyle();
    document.querySelectorAll('[data-qs-debug],[data-qs-debug-opt]').forEach((e) => { e.removeAttribute('data-qs-debug'); e.removeAttribute('data-qs-debug-opt'); });
    if (!on) return 0;
    const groups = detectGroups({});
    groups.forEach((g, i) => {
      g.block.setAttribute('data-qs-debug', `Q${i + 1} ${g.kind === 'select' ? 'dropdown' : g.multi ? 'multi' : 'single'} · ${g.members.length} opts`);
      g.members.forEach((m) => m.region && m.region.setAttribute && m.region.setAttribute('data-qs-debug-opt', ''));
    });
    setTimeout(() => highlight(false), 8000);
    return groups.length;
  }

  // ------------------------------------------------------------------ manual change watcher
  let watching = false;
  let watchTimer = null;
  function startWatching() {
    if (watching) return;
    watching = true;
    const handler = (e) => {
      if (applying || Date.now() < suppressUntil) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      const relevant = path.some((n) => n && n.nodeType === 1 && (n.matches(CHOICE_SELECTOR) || n.tagName === 'LABEL' || n.tagName === 'SELECT'));
      if (!relevant) return;
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try { if (chrome.runtime && chrome.runtime.id) chrome.runtime.sendMessage({ type: 'qs:manual-change' }).catch(() => {}); } catch { /* extension reloaded */ }
      }, 700);
    };
    document.addEventListener('change', handler, true);
    document.addEventListener('click', handler, true);
    document.addEventListener('keyup', handler, true);
  }

  // ------------------------------------------------------------------ toast (top frame only)
  let toastHost = null, toastBox = null, toastTimer = null;
  function toast(msg, opts = {}) {
    if (window !== window.top) return;
    if (!toastHost || !toastHost.isConnected) {
      toastHost = document.createElement('div');
      toastHost.id = HOST_ID;
      toastHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:16px;pointer-events:none';
      const root = toastHost.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .t{font:13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;color:#f8fafc;background:#0f172aee;border:1px solid #334155;
           border-left:4px solid #6366f1;border-radius:10px;padding:9px 12px;max-width:340px;white-space:pre-line;
           box-shadow:0 8px 24px #0006;opacity:0;transform:translateY(8px);transition:opacity .18s,transform .18s}
        .t.show{opacity:1;transform:none}.t.ok{border-left-color:#22c55e}.t.err{border-left-color:#ef4444}
        .t.busy::before{content:"";display:inline-block;width:10px;height:10px;margin-right:8px;border:2px solid #94a3b8;
           border-top-color:transparent;border-radius:50%;animation:s .8s linear infinite;vertical-align:-1px}
        @keyframes s{to{transform:rotate(360deg)}}</style><div class="t"></div>`;
      toastBox = root.querySelector('.t');
      (document.body || document.documentElement).appendChild(toastHost);
    }
    // sit just above the answers label when it is shown
    const lh = labelHost && labelHost.isConnected && labelHost.style.display !== 'none' ? labelHost.getBoundingClientRect().height : 0;
    toastHost.style.bottom = (lh ? lh + 24 : 16) + 'px';
    toastBox.className = 't ' + (opts.type || 'info');
    toastBox.textContent = msg;
    requestAnimationFrame(() => toastBox.classList.add('show'));
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(() => toastBox.classList.remove('show'), opts.duration || 3800);
  }

  // ------------------------------------------------------------------ answers label (top frame only)
  // Persistent box in the bottom-right corner listing the answers of the last solve, so they are
  // visible even when a question could not be selected on the page (or was never detected and
  // was solved in manual mode). Items: [{ n, letters, text, question, warn }].
  let labelHost = null, labelRoot = null, labelItems = [], labelCollapsed = false;
  function renderLabel() {
    const list = labelRoot.querySelector('.list');
    const head = labelRoot.querySelector('.count');
    list.textContent = '';
    head.textContent = labelItems.length ? `(${labelItems.length})` : '';
    for (const it of labelItems) {
      const row = document.createElement('div');
      row.className = 'row' + (it.warn ? ' warn' : '');
      if (it.question) row.title = it.question;
      const n = document.createElement('span'); n.className = 'n'; n.textContent = it.n + '.';
      const l = document.createElement('b'); l.textContent = it.letters || '?';
      const t = document.createElement('span'); t.className = 'tx'; t.textContent = it.text || '';
      row.append(n, l, t);
      if (it.warn) { const w = document.createElement('span'); w.className = 'w'; w.textContent = '⚠ ' + it.warn; row.append(w); }
      list.append(row);
    }
    labelRoot.querySelector('.box').classList.toggle('collapsed', labelCollapsed);
  }
  function label(items, opts = {}) {
    if (window !== window.top) return false;
    if (items === null) { if (labelHost) labelHost.style.display = 'none'; return true; }
    if (!labelHost || !labelHost.isConnected) {
      labelHost = document.createElement('div');
      labelHost.id = LABEL_ID;
      labelHost.style.cssText = 'all:initial;position:fixed;z-index:2147483646;right:16px;bottom:16px';
      labelRoot = labelHost.attachShadow({ mode: 'closed' });
      labelRoot.innerHTML = `<style>
        .box{font:12px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;color:#f1f5f9;background:#0f172a;border:1px solid #334155;
             border-radius:8px;box-shadow:0 6px 18px #0005;width:260px;max-width:calc(100vw - 32px)}
        .hd{display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;user-select:none;border-bottom:1px solid #1e293b}
        .hd .ttl{font-weight:600;flex:1}.hd .count{color:#94a3b8}
        .hd button{all:unset;cursor:pointer;color:#94a3b8;padding:0 3px}.hd button:hover{color:#fff}
        .list{max-height:180px;overflow-y:auto;padding:4px 8px 6px}
        .collapsed .list{display:none}.collapsed .hd{border-bottom:0}
        .row{display:flex;gap:6px;align-items:baseline;padding:1px 0}
        .n{color:#94a3b8;min-width:22px;text-align:right}
        b{color:#4ade80;min-width:28px}
        .tx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;color:#cbd5e1}
        .warn b{color:#fbbf24}.w{color:#fbbf24;white-space:nowrap;font-size:11px}</style>
        <div class="box"><div class="hd"><span class="ttl">Answers</span><span class="count"></span>
        <button class="min" title="Collapse / expand">▾</button><button class="x" title="Close">✕</button></div>
        <div class="list"></div></div>`;
      labelRoot.querySelector('.hd').addEventListener('click', (e) => {
        if (e.target.closest('.x')) { labelHost.style.display = 'none'; return; }
        labelCollapsed = !labelCollapsed;
        renderLabel();
      });
      (document.body || document.documentElement).appendChild(labelHost);
    }
    labelItems = opts.append ? labelItems.concat(items).slice(-50) : items.slice(0, 200);
    labelHost.style.display = '';
    renderLabel();
    return true;
  }

  // ------------------------------------------------------------------ public API
  function scan(opts = {}) {
    try {
      const groups = detectGroups(opts);
      lastGroups = groups;
      if (opts.watch) startWatching();
      return { url: location.href, top: window === window.top, questions: groups.map(toQuestion) };
    } catch (e) {
      return { url: location.href, error: String(e && e.stack || e), questions: [] };
    }
  }
  function getState(opts = {}) {
    try {
      const groups = detectGroups({ includeHidden: true });
      lastGroups = groups;
      if (opts.watch !== false) startWatching();
      return { entries: groups.map(toEntry) };
    } catch (e) {
      return { entries: [], error: String(e) };
    }
  }

  globalThis.__QS = {
    version: VERSION, scan, getState, setState, plan, clickPoint, memberState, scrollPos, toast, label, highlight,
    labelState: () => ({ visible: !!(labelHost && labelHost.isConnected && labelHost.style.display !== 'none'), items: labelItems }),
    _internals: { optKey, cleanNoise }
  };
})();
