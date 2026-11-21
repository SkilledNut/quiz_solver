// Per-page answer history (undo / redo / restore), persisted in chrome.storage.local
// so it survives page reloads. A "state" is the list of question entries produced by
// the content script's getState(): { qid, qh, oh, nk, ord, qText, optKeys, sel, selKeys }.
// Entries are matched back to the DOM by fingerprint, not by element reference.

const MAX_ENTRIES = 60;
const MAX_SOLVES = 15;
const MAX_PAGES = 60;

let lock = Promise.resolve();
const withLock = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };

export function pageKey(url) {
  try { const u = new URL(url); u.hash = ''; return 'hist:' + u.href; } catch { return 'hist:' + url; }
}

function signature(state) {
  return (state || []).map((e) => e.qid + '=' + [...(e.selKeys || [])].sort().join('|')).sort().join('\n');
}
export const sameState = (a, b) => signature(a) === signature(b);

export async function load(url) {
  const k = pageKey(url);
  const o = await chrome.storage.local.get(k);
  return o[k] || { url, entries: [], pointer: -1, solves: [] };
}

async function save(url, h) {
  const k = pageKey(url);
  h.updated = Date.now();
  const { histIndex = {} } = await chrome.storage.local.get('histIndex');
  histIndex[k] = h.updated;
  const keys = Object.keys(histIndex).sort((a, b) => histIndex[b] - histIndex[a]);
  const stale = keys.slice(MAX_PAGES);
  stale.forEach((s) => delete histIndex[s]);
  if (stale.length) await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({ [k]: h, histIndex });
}

// Adds a snapshot after the current pointer (drops the redo branch). Skips duplicates.
export function push(url, entry) {
  return withLock(async () => {
    const h = await load(url);
    if (!entry.state || !entry.state.length) return h;
    const cur = h.entries[h.pointer];
    if (cur && sameState(cur.state, entry.state)) return h;
    h.entries = h.entries.slice(0, h.pointer + 1);
    h.entries.push({ time: Date.now(), ...entry });
    if (h.entries.length > MAX_ENTRIES) h.entries = h.entries.slice(-MAX_ENTRIES);
    h.pointer = h.entries.length - 1;
    await save(url, h);
    return h;
  });
}

export function setPointer(url, pointer) {
  return withLock(async () => {
    const h = await load(url);
    h.pointer = Math.max(-1, Math.min(pointer, h.entries.length - 1));
    await save(url, h);
    return h;
  });
}

// The answers an AI/algorithm run decided on — kept separately so they survive undo branches.
export function recordSolve(url, solve) {
  return withLock(async () => {
    const h = await load(url);
    h.solves.push({ time: Date.now(), ...solve });
    if (h.solves.length > MAX_SOLVES) h.solves = h.solves.slice(-MAX_SOLVES);
    await save(url, h);
    return h;
  });
}

export async function clear(url) {
  const k = pageKey(url);
  await chrome.storage.local.remove(k);
  const { histIndex = {} } = await chrome.storage.local.get('histIndex');
  delete histIndex[k];
  await chrome.storage.local.set({ histIndex });
}
