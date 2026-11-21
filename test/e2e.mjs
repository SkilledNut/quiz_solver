// End-to-end test: loads the unpacked extension in Chromium, drives it through the
// background worker (same path as the keyboard shortcuts) on the HTML fixtures.
//   npm install            (installs playwright-core)
//   npm run test:e2e -- "C:\path\to\chrome.exe"     (or set CHROME_PATH)
// Uses ports 8765 (fixture server) and 8766 (mock OpenAI-compatible LLM).
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2] || process.env.CHROME_PATH;
if (!EXE) { console.error('Pass the Chrome/Chromium executable path as argument or CHROME_PATH.'); process.exit(2); }

// static server for the fixtures
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const files = http.createServer((req, res) => {
  const p = path.join(EXT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(EXT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(8765); // all interfaces: fixtures use both 127.0.0.1 and localhost (cross-origin iframe)
const BASE = 'http://127.0.0.1:8765/test/fixtures/';
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, cond, extra = '') => { log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// mock OpenAI-compatible LLM
let lastReq = null;
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    lastReq = { url: req.url, headers: req.headers, body: JSON.parse(body || '{}') };
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '**1:** B\n2: A, C\n3: A\n4) b' } }] }));
  });
}).listen(8766);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-e2e-'));
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: EXE, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 800));
const extId = new URL(sw.url()).host;
log('extension id', extId);

const page = await ctx.newPage();
await page.goto(BASE + 'moodle.html');
const popup = await ctx.newPage();
await popup.goto(`chrome-extension://${extId}/src/popup/popup.html`);
await popup.waitForTimeout(400);
const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8765/*' }))[0].id);
const cmd = (command) => popup.evaluate(([c, t]) => chrome.runtime.sendMessage({ type: 'popup:command', command: c, tabId: t }), [command, tabId]);
const domState = () => page.evaluate(() => ({
  q1: [0, 1, 2].map((i) => document.getElementById('q1_a' + i).checked),
  q2: [0, 1, 2, 3].map((i) => document.getElementById('q2c' + i).checked),
  m0: document.getElementById('m0').value, m1: document.getElementById('m1').value
}));
const KB = `The mitochondrion produces most of the cell's ATP. The nucleus stores DNA. Ribosomes carry out protein synthesis.
Chloroplasts perform photosynthesis. Whales and dolphins are mammals. Sharks and trout are fish.`;

// ---------- algorithm mode
await sw.evaluate(async (kb) => {
  await chrome.storage.local.set({
    contexts: [{ id: 'c1', name: 'Bio', text: kb }],
    settings: { mode: 'algorithm', activeContextId: 'c1', notifications: true }
  });
}, KB);
let r = await cmd('solve-quiz');
check('algorithm solve ok', r && r.ok, JSON.stringify(r));
let s = await domState();
check('algo q1 Mitochondrion', JSON.stringify(s.q1) === '[false,true,false]', JSON.stringify(s.q1));
check('algo q2 whale+dolphin', JSON.stringify(s.q2) === '[true,false,true,false]', JSON.stringify(s.q2));
check('algo match selects', s.m0 === '1' && s.m1 === '2', s.m0 + ' ' + s.m1);

// ---------- manual change + undo / redo / reapply
await page.click('#q2c1'); // tick "Shark" by hand
await page.click('#q1_a0'); // switch q1 to Nucleus by hand
await page.waitForTimeout(1600);
let h = await popup.evaluate((t) => chrome.runtime.sendMessage({ type: 'popup:history', tabId: t }), tabId);
check('history recorded manual change', h.entries.some((e) => e.label === 'Manual change'), h.entries.map((e) => e.label).join(' > '));
const manualSteps = h.entries.filter((e) => e.label === 'Manual change').length;
for (let i = 0; i < manualSteps; i++) r = await cmd('undo-answers');
s = await domState();
check(`undo x${manualSteps} -> back to solved state`, JSON.stringify(s.q1) === '[false,true,false]' && JSON.stringify(s.q2) === '[true,false,true,false]', JSON.stringify(s));
r = await cmd('undo-answers');
s = await domState();
check('undo again -> before solve (empty)', !s.q1.some(Boolean) && !s.q2.some(Boolean) && s.m0 === '0', JSON.stringify(s));
r = await cmd('redo-answers');
s = await domState();
check('redo -> solved again', JSON.stringify(s.q1) === '[false,true,false]', JSON.stringify(s));
await page.click('#q1_a2');
await page.waitForTimeout(1300);
r = await cmd('reapply-answers');
s = await domState();
check('reapply after manual edit', JSON.stringify(s.q1) === '[false,true,false]' && JSON.stringify(s.q2) === '[true,false,true,false]', JSON.stringify(s));

// history survives reload
await page.reload();
await page.waitForTimeout(300);
r = await cmd('reapply-answers');
s = await domState();
check('reapply after page reload', JSON.stringify(s.q1) === '[false,true,false]', JSON.stringify(s));

// ---------- LLM mode with a custom OpenAI-compatible endpoint
await page.reload();
await sw.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  settings.mode = 'llm';
  settings.llm = { provider: 'custom', webSearch: false, effort: '', maxTokens: 1024, temperature: '0', customInstructions: '',
    providers: { custom: { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:8766/v1', model: 'mock-model', apiFormat: 'openai-chat' } } };
  await chrome.storage.local.set({ settings });
});
r = await cmd('solve-quiz');
check('llm solve ok', r && r.ok, JSON.stringify(r));
s = await domState();
check('llm answers applied', JSON.stringify(s.q1) === '[false,true,false]' && JSON.stringify(s.q2) === '[true,false,true,false]' && s.m0 === '1' && s.m1 === '2', JSON.stringify(s));
check('llm request: one call, KB in system, bearer key', lastReq && lastReq.url === '/v1/chat/completions' && /KNOWLEDGE BASE/.test(lastReq.body.messages[0].content) && lastReq.headers.authorization === 'Bearer test-key');
const user = lastReq.body.messages[1].content;
check('llm prompt enumerates options with letters (site "a." numbering stripped)', /B\) Mitochondrion/.test(user) && !/a\. Nucleus/.test(user), '\n' + user);
const { lastRun } = await sw.evaluate(() => chrome.storage.local.get('lastRun'));
check('lastRun stored', lastRun && lastRun.questions.length === 4);
const labelState = () => sw.evaluate(async (t) => {
  const [r] = await chrome.scripting.executeScript({ target: { tabId: t, frameIds: [0] }, func: () => globalThis.__QS && globalThis.__QS.labelState() });
  return r && r.result;
}, tabId);
let lb = await labelState();
check('label: answers box shown after solve', lb && lb.visible && lb.items.length === 4 && lb.items[0].letters === 'B' && /Mitochondrion/.test(lb.items[0].text) && lb.items[1].letters === 'A,C', JSON.stringify(lb));

// ---------- manual mode: select text + shortcuts (LLM mock still configured)
await page.goto(BASE + 'manual.html');
const selectEl = (id) => page.evaluate((i) => { const r = document.createRange(); r.selectNodeContents(document.getElementById(i)); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }, id);
await selectEl('q');
r = await cmd('manual-question');
check('manual: question captured', r && r.ok && /ATP/.test(r.draft.question), JSON.stringify(r));
for (const id of ['a1', 'a2', 'a3']) { await selectEl(id); r = await cmd('manual-answer'); }
check('manual: 3 answers captured', r && r.ok && r.draft.options.join('|') === 'Nucleus|Mitochondrion|Ribosome', JSON.stringify(r && r.draft));
r = await cmd('manual-solve-single');
check('manual: solve single → B', r && r.ok && r.letters.join() === 'B', JSON.stringify(r));
const sentUser = lastReq.body.messages[1].content;
check('manual: prompt has single tag + lettered options', /\[single/.test(sentUser) && /B\) Mitochondrion/.test(sentUser), '\n' + sentUser);
r = await cmd('manual-solve-multi');
check('manual: solve multi sends [multi]', r && r.ok && /\[multi/.test(lastReq.body.messages[1].content), JSON.stringify(r));
const quizUntouched = await page.evaluate(() => document.querySelectorAll('[data-qs-flash]').length === 0);
check('manual: nothing clicked on the page', quizUntouched);
await selectEl('block');
r = await cmd('manual-question');
check('manual: whole block selection auto-splits question + answers', r && r.ok && r.draft.question === 'Which of these are mammals?' && r.draft.options.length === 3, JSON.stringify(r && r.draft));
await page.evaluate(() => getSelection().removeAllRanges());
r = await cmd('manual-answer');
check('manual: empty selection rejected', r && r.ok === false);
lb = await labelState();
check('label: manual answers appended (M1, M2)', lb && lb.visible && lb.items.map((i) => i.n).join() === 'M1,M2' && lb.items[0].letters === 'B', JSON.stringify(lb));

// page where selecting fails (scripted clicks rejected, no debugger permission): answers still visible in label
await page.goto(BASE + 'trusted.html');
await sw.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  settings.mode = 'algorithm';
  await chrome.storage.local.set({ settings, contexts: [{ id: 'c1', name: 'x', text: 'The RGB primary colours are red, green and blue. Jupiter is the largest planet. Water freezes at 0 °C. Even numbers include 2 and 8.' }] });
});
r = await cmd('solve-quiz');
lb = await labelState();
const q3 = lb && lb.items.find((i) => /freezes/.test(i.question));
check('label: unselectable question still shows answer, flagged "not selected"', q3 && q3.letters === 'A' && q3.warn === 'not selected', JSON.stringify(lb && lb.items));
await page.reload();
r = await popup.evaluate((t) => chrome.runtime.sendMessage({ type: 'popup:showLabel', tabId: t }), tabId);
lb = await labelState();
check('label: "Show answers on page" restores it after reload', r && r.ok && lb && lb.visible && lb.items.length >= 3, JSON.stringify(lb));
await page.bringToFront();
await page.keyboard.press('Alt+Shift+H');
await page.waitForTimeout(400);
lb = await labelState();
check('label: Alt+Shift+H hides it', lb && !lb.visible, JSON.stringify(lb && lb.visible));
await page.keyboard.press('Alt+Shift+H');
await page.waitForTimeout(400);
lb = await labelState();
check('label: Alt+Shift+H shows it again', lb && lb.visible, JSON.stringify(lb && lb.visible));
await page.reload();
r = await cmd('toggle-label');
lb = await labelState();
check('label: toggle command after reload shows last answers', r && r.ok && r.state === 'shown' && lb && lb.visible && lb.items.length >= 3, JSON.stringify(r));
r = await cmd('toggle-label');
lb = await labelState();
check('label: toggle command hides it', r && r.state === 'hidden' && lb && !lb.visible, JSON.stringify(r));

// ---------- ARIA page via extension
await page.goto(BASE + 'aria.html');
await sw.evaluate(async () => {
  const { settings } = await chrome.storage.local.get('settings');
  settings.mode = 'algorithm';
  await chrome.storage.local.set({ settings, contexts: [{ id: 'c1', name: 'x', text: 'Water boils at 100 °C at sea level. Prime numbers include 2, 3, 5 and 7. Mars is called the Red Planet.' }] });
});
r = await cmd('solve-quiz');
const aria = await page.evaluate(() => [...document.querySelectorAll('[role=radio],[role=checkbox],[role=option]')].map((e) => e.getAttribute('aria-checked') || e.getAttribute('aria-selected')));
check('aria page solved via extension', r && r.ok && JSON.stringify(aria) === JSON.stringify(['true', 'false', 'true', 'false', 'true', 'false', 'false', 'true', 'false']), JSON.stringify(aria));

await ctx.close();

// ---------- real (trusted) clicks on a page that ignores scripted events
// "debugger" is an optional permission (granted from the popup); headless Chromium cannot
// show the grant dialog, so the test loads a copy where it is a required permission.
const extCopy = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-ext-'));
fs.cpSync(path.join(EXT, 'src'), path.join(extCopy, 'src'), { recursive: true });
fs.cpSync(path.join(EXT, 'icons'), path.join(extCopy, 'icons'), { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.permissions.push('debugger');
fs.writeFileSync(path.join(extCopy, 'manifest.json'), JSON.stringify(man));

const ctx2 = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'qs-e2e2-')), {
  executablePath: EXE, headless: true, viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${extCopy}`, `--load-extension=${extCopy}`]
});
let [sw2] = ctx2.serviceWorkers();
if (!sw2) sw2 = await ctx2.waitForEvent('serviceworker');
await new Promise((r) => setTimeout(r, 800));
const ext2 = new URL(sw2.url()).host;
const tp = await ctx2.newPage();
await tp.goto(BASE + 'trusted.html');
await tp.waitForTimeout(500);
const pop2 = await ctx2.newPage();
await pop2.goto(`chrome-extension://${ext2}/src/popup/popup.html`);
const tab2 = await sw2.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:8765/*' }))[0].id);
const cmd2 = (c) => pop2.evaluate(([c, t]) => chrome.runtime.sendMessage({ type: 'popup:command', command: c, tabId: t }), [c, tab2]);
const tState = async () => {
  const main = await tp.evaluate(() => ({
    q1: [...document.querySelectorAll('.q:nth-of-type(1) input')].map((i) => i.checked),
    q2: [...document.querySelectorAll('input[name=p]')].map((i) => i.checked),
    q3: [...document.querySelectorAll('[role=radio]')].map((r) => r.getAttribute('aria-checked')),
    rej: +document.getElementById('rej').textContent, tc: +document.getElementById('tc').textContent
  }));
  const fr = tp.frames().find((f) => /trusted-frame/.test(f.url()));
  main.q4 = fr ? await fr.evaluate(() => [...document.querySelectorAll('[role=checkbox]')].map((c) => c.getAttribute('aria-checked'))) : null;
  return main;
};
await sw2.evaluate(async () => {
  await chrome.storage.local.set({
    contexts: [{ id: 't', name: 'T', text: 'The RGB primary colours are red, green and blue. Jupiter is the largest planet. Water freezes at 0 °C. Even numbers include 2 and 8.' }],
    settings: { mode: 'algorithm', activeContextId: 't', clickMode: 'auto' }
  });
});
r = await cmd2('solve-quiz');
let ts = await tState();
log('  trusted log:\n   ' + ((r && r.applied && r.applied.trustedLog) || []).join('\n   '));
check('trusted: solve ok, 4 questions incl. cross-origin iframe', r && r.ok && r.total === 4 && r.applied.failed === 0, JSON.stringify(r));
check('trusted: native checkboxes that reject scripted clicks', JSON.stringify(ts.q1) === '[true,false,true]', JSON.stringify(ts.q1));
check('trusted: hidden-input radio', JSON.stringify(ts.q2) === '[false,true,false]', JSON.stringify(ts.q2));
check('trusted: ARIA radio far below the fold', JSON.stringify(ts.q3) === '["true","false"]', JSON.stringify(ts.q3));
check('trusted: ARIA checkboxes inside cross-origin iframe', JSON.stringify(ts.q4) === '["true","false","true"]', JSON.stringify(ts.q4));
check('trusted: page saw real (isTrusted) events', ts.tc >= 4 && r.applied.trustedClicks >= 4, `trusted changes=${ts.tc}, real clicks=${r.applied.trustedClicks}, rejected scripted=${ts.rej}`);

// undo must also work with real clicks
await tp.evaluate(() => scrollTo(0, 0));
r = await cmd2('undo-answers');
ts = await tState();
check('trusted: undo restores empty state', !ts.q1.some(Boolean) && ts.q4 && ts.q4.every((x) => x === 'false'), JSON.stringify(ts));
await ctx2.close();

mock.close();
files.close();
log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
process.exit(fails ? 1 : 0);
