/* RealDarkMode — popup panel. All HTML and CSS are embedded below; popup.html only needs
 * an empty <div id="darkmodeView"></div> and a <script src="darkmode-panel.js" defer></script>.
 */
"use strict";

/* ---------- embedded styles + markup ---------- */

const POPUP_CSS = `
:host {
  all: initial;
  display: block;
  color-scheme: dark;
  --bg: #0f1318;
  --surface: #161c23;
  --surface-2: #1d252e;
  --border: #29333e;
  --border-strong: #3b4756;
  --text: #e8ecf1;
  --muted: #8b97a6;
  --faint: #5f6b79;
  --accent: #8ea2ff;
  --accent-2: #c08cff;
  --accent-soft: rgba(142, 162, 255, 0.15);
  --accent-line: rgba(142, 162, 255, 0.38);
  --on: #5ee39a;
  --warn: #f5b454;
  --radius: 10px;
  font: 13px/1.4 "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
}

* { box-sizing: border-box; }
.app {
  width: 340px;
  padding: 14px 14px 10px;
  background:
    radial-gradient(120% 60% at 0% 0%, rgba(142, 162, 255, 0.08), transparent 60%),
    var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
  user-select: none;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.app.ready { opacity: 1; }

button { font: inherit; }
button:focus-visible,
.switch:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* ---------- header ---------- */

.brand { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.logo { width: 30px; height: 30px; flex: none; }
.brand h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text);
}
.brand h1 span {
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.ver { margin-left: auto; font-size: 11px; color: var(--faint); font-variant-numeric: tabular-nums; }

/* ---------- site + power ---------- */

.top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; }

.site-btn {
  width: 100%;
  height: 36px;
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 0 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.site-btn:hover:not(:disabled) { background: var(--surface-2); border-color: var(--border-strong); }
.site-btn:disabled { cursor: default; color: var(--muted); }
.site-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dot {
  width: 8px; height: 8px; flex: none; border-radius: 50%;
  background: var(--faint);
  box-shadow: 0 0 0 3px rgba(95, 107, 121, 0.2);
  transition: background 0.2s, box-shadow 0.2s;
}
[data-tone="on"] .dot { background: var(--on); box-shadow: 0 0 0 3px rgba(94, 227, 154, 0.18); }
[data-tone="warn"] .dot { background: var(--warn); box-shadow: 0 0 0 3px rgba(245, 180, 84, 0.18); }

.status { margin: 6px 2px 0; min-height: 16px; font-size: 11.5px; color: var(--muted); }
.status[data-tone="on"] { color: var(--on); }
.status[data-tone="warn"] { color: var(--warn); }

/* ---------- segmented controls ---------- */

.seg {
  display: inline-flex;
  gap: 3px;
  padding: 3px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.seg-block { display: flex; width: 100%; }
.seg button {
  flex: 1;
  height: 28px;
  padding: 0 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, box-shadow 0.15s;
}
.seg button:hover { color: var(--text); }
.seg button svg { width: 15px; height: 15px; }
.seg button[aria-pressed="true"] {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.seg-power button[data-power="on"][aria-pressed="true"] {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #10131a;
  box-shadow: 0 2px 10px rgba(142, 162, 255, 0.35);
}
.seg-power button[data-power="off"][aria-pressed="true"] {
  background: var(--surface-2);
  color: var(--text);
  box-shadow: inset 0 0 0 1px var(--border-strong);
}

/* ---------- tabs ---------- */

.tabs { display: flex; gap: 2px; margin: 14px 0 12px; border-bottom: 1px solid var(--border); }
.tabs button {
  position: relative;
  padding: 8px 12px 10px;
  border: 0;
  background: none;
  color: var(--muted);
  font-weight: 600;
  cursor: pointer;
}
.tabs button:hover { color: var(--text); }
.tabs button[aria-selected="true"] { color: var(--text); }
.tabs button[aria-selected="true"]::after {
  content: "";
  position: absolute;
  left: 10px; right: 10px; bottom: -1px;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
}

.panel { display: flex; flex-direction: column; gap: 12px; }
.panel[hidden] { display: none; }

.app[data-power="off"] #panel-filter { opacity: 0.5; transition: opacity 0.2s; }
.app[data-power="off"] #panel-filter:hover { opacity: 0.8; }

/* ---------- sliders ---------- */

.sliders { display: flex; flex-direction: column; gap: 10px; }
.slider {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 30px;
  column-gap: 6px;
  row-gap: 3px;
  align-items: center;
}
.step {
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, transform 0.08s;
}
.step:hover { color: var(--text); border-color: var(--border-strong); }
.step:active { transform: scale(0.93); }
.step svg { width: 14px; height: 14px; }

.track { position: relative; height: 32px; }
.track input {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: 100%;
  height: 100%;
  margin: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: linear-gradient(90deg, var(--accent-soft) 0 var(--p, 50%), var(--surface) var(--p, 50%) 100%);
  cursor: ew-resize;
  outline: none;
  transition: border-color 0.15s;
}
.track input:hover { border-color: var(--border-strong); }
.track input:focus-visible { border-color: var(--accent); }
.track input::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 3px;
  height: 20px;
  border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(142, 162, 255, 0.7);
}
.track-label {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.value {
  grid-column: 2;
  text-align: center;
  font-size: 11px;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
}
.slider[data-changed] .value { color: var(--accent); }

/* ---------- site list ---------- */

.hint { margin: 0; font-size: 11.5px; color: var(--muted); }
textarea {
  width: 100%;
  height: 168px;
  padding: 10px 12px;
  resize: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font: 12.5px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace;
  outline: none;
  user-select: text;
}
textarea:focus { border-color: var(--accent); }
textarea::placeholder { color: var(--faint); }

/* ---------- more ---------- */

.option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}
.option-text strong { display: block; font-weight: 600; }
.option-text span { font-size: 11.5px; color: var(--muted); }

.switch {
  -webkit-appearance: none;
  appearance: none;
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  margin: 0;
  border-radius: 999px;
  background: var(--surface-2);
  box-shadow: inset 0 0 0 1px var(--border-strong);
  cursor: pointer;
  transition: background 0.2s;
}
.switch::before {
  content: "";
  position: absolute;
  top: 3px; left: 3px;
  width: 14px; height: 14px;
  border-radius: 50%;
  background: var(--muted);
  transition: transform 0.2s, background 0.2s;
}
.switch:checked { background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: none; }
.switch:checked::before { transform: translateX(16px); background: #10131a; }

.btn {
  height: 34px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.btn:hover { background: var(--surface-2); border-color: var(--border-strong); }

/* ---------- footer ---------- */

footer {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--faint);
}
`;

const POPUP_HTML = `
<main class="app" data-power="off">
  <header class="brand">
    <svg class="logo" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="rdm-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#8ea2ff"/>
          <stop offset="1" stop-color="#c08cff"/>
        </linearGradient>
        <mask id="rdm-m">
          <rect width="32" height="32" fill="#fff"/>
          <circle cx="20.5" cy="11.5" r="7" fill="#000"/>
        </mask>
      </defs>
      <rect width="32" height="32" rx="9" fill="#1b222b"/>
      <circle cx="15" cy="17" r="8.5" fill="url(#rdm-g)" mask="url(#rdm-m)"/>
      <circle cx="23.5" cy="20" r="1.3" fill="#c08cff"/>
    </svg>
    <h1>Real<span>Dark</span>Mode</h1>
    <span class="ver" id="version"></span>
  </header>

  <section class="top">
    <div class="site">
      <button id="siteBtn" class="site-btn" type="button">
        <span class="dot" aria-hidden="true"></span>
        <span class="site-name" id="siteName">—</span>
      </button>
      <p class="status" id="siteStatus"></p>
    </div>
    <div class="seg seg-power" role="group" aria-label="Dark mode everywhere">
      <button type="button" data-power="on">On</button>
      <button type="button" data-power="off">Off</button>
    </div>
  </section>

  <nav class="tabs" role="tablist">
    <button type="button" role="tab" data-tab="filter" aria-selected="true">Filter</button>
    <button type="button" role="tab" data-tab="sites" aria-selected="false">Site list</button>
    <button type="button" role="tab" data-tab="more" aria-selected="false">More</button>
  </nav>

  <section class="panel" id="panel-filter" role="tabpanel">
    <div class="seg seg-block seg-mode" role="group" aria-label="Mode">
      <button type="button" data-mode="dark">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 14.6A8.5 8.5 0 0 1 9.4 3.8 8.5 8.5 0 1 0 20.2 14.6z" fill="currentColor"/></svg>
        Dark
      </button>
      <button type="button" data-mode="light">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        Light
      </button>
    </div>
    <div class="sliders" id="sliders"></div>
  </section>

  <section class="panel" id="panel-sites" role="tabpanel" hidden>
    <div class="seg seg-block" role="group" aria-label="Site list mode">
      <button type="button" data-listmode="exclude">Skip listed sites</button>
      <button type="button" data-listmode="only">Only listed sites</button>
    </div>
    <p class="hint" id="listHint"></p>
    <textarea id="siteList" spellcheck="false" placeholder="example.com&#10;docs.google.com"></textarea>
  </section>

  <section class="panel" id="panel-more" role="tabpanel" hidden>
    <label class="option">
      <span class="option-text">
        <strong>Skip sites that are already dark</strong>
        <span>Leaves pages with their own dark theme untouched.</span>
      </span>
      <input type="checkbox" class="switch" id="detectDark">
    </label>
    <button type="button" class="btn" id="resetBtn">Reset filter settings</button>
  </section>

  <footer>
    <span>Double-click a slider to reset it</span>
  </footer>
</main>
`;

// Draws the panel inside #darkmodeView (or at the end of <body> if that element is missing).
// A shadow root keeps these styles and the rest of the popup's styles from affecting each other.
let ui = null;
function mountUI() {
  const target = document.getElementById("darkmodeView") || document.body;
  const host = document.createElement("div");
  host.className = "rdm-panel-host";
  target.appendChild(host);
  ui = host.attachShadow({ mode: "open" });
  ui.innerHTML = `<style>${POPUP_CSS}</style>${POPUP_HTML}`;
}

const KEY = "rdmSettings";
const DEFAULTS = Object.freeze({
  enabled: false,
  mode: "dark",
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  detectDark: true,
  siteListMode: "exclude",
  sites: [],
});
const SLIDERS = [
  { key: "brightness", label: "Brightness", min: 50, max: 150, neutral: 100 },
  { key: "contrast", label: "Contrast", min: 50, max: 150, neutral: 100 },
  { key: "sepia", label: "Sepia", min: 0, max: 100, neutral: 0 },
  { key: "grayscale", label: "Grayscale", min: 0, max: 100, neutral: 0 },
];
const STEP = 5;
const PROTECTED =
  /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|devtools|view-source|chrome-search|chrome-untrusted):/i;
const STORES =
  /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i;

const CHEVRON = (d) =>
  `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CHEV_L = CHEVRON("M10 3 5 8l5 5");
const CHEV_R = CHEVRON("M6 3l5 5-5 5");

const $ = (sel) => ui.querySelector(sel);
const $$ = (sel) => [...ui.querySelectorAll(sel)];

const state = {
  settings: normalize(null),
  tab: null,
  siteKey: "",
  protected: false,
  page: null,
};

/* ---------- settings ---------- */

function cleanHost(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");
}

function clamp(n, lo, hi, d) {
  n = Number(n);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
}

function normalize(raw) {
  const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  s.enabled = !!s.enabled;
  s.mode = s.mode === "light" ? "light" : "dark";
  for (const c of SLIDERS)
    s[c.key] = clamp(s[c.key], c.min, c.max, DEFAULTS[c.key]);
  s.detectDark = s.detectDark !== false;
  s.siteListMode = s.siteListMode === "only" ? "only" : "exclude";
  s.sites = Array.isArray(s.sites)
    ? [...new Set(s.sites.map(cleanHost).filter(Boolean))]
    : [];
  return s;
}

const matches = (key, h) => key === h || key.endsWith("." + h);
const isListed = () =>
  !!state.siteKey &&
  state.settings.sites.some((h) => matches(state.siteKey, h));

let saveTimer = 0;
function save(immediate) {
  clearTimeout(saveTimer);
  const write = () =>
    chrome.storage.local.set({ [KEY]: state.settings }).catch(() => {});
  if (immediate) write();
  else saveTimer = setTimeout(write, 50);
}

function update(patch, immediate = true) {
  Object.assign(state.settings, patch);
  render();
  save(immediate);
}

/* ---------- rendering ---------- */

function siteState() {
  const s = state.settings;
  const listed = isListed();
  if (state.protected)
    return { tone: "warn", text: "This page is protected by the browser" };
  if (!s.enabled) return { tone: "off", text: "Dark mode is turned off" };
  if (s.siteListMode === "exclude" && listed)
    return { tone: "off", text: "Turned off for this site" };
  if (s.siteListMode === "only" && !listed)
    return { tone: "off", text: "Not in your site list" };
  if (!state.page) return { tone: "warn", text: "Reload the page to apply" };
  if (s.mode === "dark" && s.detectDark && state.page.detectedDark)
    return { tone: "off", text: "Already dark, left untouched" };
  return {
    tone: "on",
    text: s.mode === "dark" ? "Dark mode active" : "Light filter active",
  };
}

function formatValue(c, v) {
  if (v === c.neutral) return "off";
  if (c.neutral === 100) return `${v > 100 ? "+" : "−"}${Math.abs(v - 100)}`;
  return `${v}%`;
}

function renderSlider(c) {
  const row = $(`.slider[data-key="${c.key}"]`);
  const input = row.querySelector("input");
  const v = state.settings[c.key];
  if (Number(input.value) !== v) input.value = v;
  row
    .querySelector(".track")
    .style.setProperty("--p", `${((v - c.min) / (c.max - c.min)) * 100}%`);
  row.querySelector(".value").textContent = formatValue(c, v);
  row.toggleAttribute("data-changed", v !== c.neutral);
}

function render() {
  const s = state.settings;
  $(".app").dataset.power = s.enabled ? "on" : "off";
  $$("[data-power]").forEach((b) =>
    b.setAttribute(
      "aria-pressed",
      String((b.dataset.power === "on") === s.enabled),
    ),
  );
  $$("[data-mode]").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.mode === s.mode)),
  );
  $$("[data-listmode]").forEach((b) =>
    b.setAttribute(
      "aria-pressed",
      String(b.dataset.listmode === s.siteListMode),
    ),
  );
  SLIDERS.forEach(renderSlider);

  // site row
  const st = siteState();
  const btn = $("#siteBtn");
  const listed = isListed();
  btn.dataset.tone = st.tone;
  btn.disabled = state.protected || !state.siteKey;
  $("#siteName").textContent =
    state.siteKey === "file" ? "Local file" : state.siteKey || "No page";
  btn.title = btn.disabled
    ? ""
    : s.siteListMode === "exclude"
      ? listed
        ? "Turn back on for this site"
        : "Turn off for this site"
      : listed
        ? "Remove this site from the list"
        : "Turn on for this site";
  const status = $("#siteStatus");
  status.dataset.tone = st.tone;
  status.textContent = st.text;

  // site list
  $("#listHint").textContent =
    s.siteListMode === "exclude"
      ? "Dark mode runs everywhere except these sites. One per line; subdomains are included."
      : "Dark mode runs only on these sites. One per line; subdomains are included.";
  const ta = $("#siteList");
  if (ui.activeElement !== ta) ta.value = s.sites.join("\n");

  $("#detectDark").checked = s.detectDark;
}

/* ---------- UI wiring ---------- */

function buildSliders() {
  const wrap = $("#sliders");
  for (const c of SLIDERS) {
    const row = document.createElement("div");
    row.className = "slider";
    row.dataset.key = c.key;
    row.innerHTML = `
      <button type="button" class="step" data-dir="-1" aria-label="Decrease ${c.label}">${CHEV_L}</button>
      <div class="track">
        <input type="range" min="${c.min}" max="${c.max}" step="1" aria-label="${c.label}" title="Double-click to reset">
        <span class="track-label">${c.label}</span>
      </div>
      <button type="button" class="step" data-dir="1" aria-label="Increase ${c.label}">${CHEV_R}</button>
      <span class="value"></span>`;
    const input = row.querySelector("input");
    input.addEventListener("input", () =>
      update({ [c.key]: Number(input.value) }, false),
    );
    input.addEventListener("change", () => save(true));
    input.addEventListener("dblclick", () => update({ [c.key]: c.neutral }));
    row.querySelectorAll(".step").forEach((b) =>
      b.addEventListener("click", () => {
        const v = state.settings[c.key] + Number(b.dataset.dir) * STEP;
        update({ [c.key]: clamp(v, c.min, c.max, c.neutral) });
      }),
    );
    wrap.appendChild(row);
  }
}

function selectTab(id) {
  $$('[role="tab"]').forEach((t) => {
    const on = t.dataset.tab === id;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$(".panel").forEach((p) => {
    p.hidden = p.id !== `panel-${id}`;
  });
}

function toggleSite() {
  if (!state.siteKey) return;
  const s = state.settings;
  const sites = isListed()
    ? s.sites.filter((h) => !matches(state.siteKey, h))
    : [...s.sites, state.siteKey];
  update({ sites });
}

function bind() {
  $$("[data-power]").forEach((b) =>
    b.addEventListener("click", () =>
      update({ enabled: b.dataset.power === "on" }),
    ),
  );
  $$("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => update({ mode: b.dataset.mode })),
  );
  $$("[data-listmode]").forEach((b) =>
    b.addEventListener("click", () =>
      update({ siteListMode: b.dataset.listmode }),
    ),
  );
  $$('[role="tab"]').forEach((t) =>
    t.addEventListener("click", () => selectTab(t.dataset.tab)),
  );
  $("#siteBtn").addEventListener("click", toggleSite);
  $("#detectDark").addEventListener("change", (e) =>
    update({ detectDark: e.target.checked }),
  );
  $("#resetBtn").addEventListener("click", () =>
    update({
      mode: "dark",
      brightness: 100,
      contrast: 100,
      sepia: 0,
      grayscale: 0,
    }),
  );

  const ta = $("#siteList");
  let listTimer = 0;
  const readList = () => [
    ...new Set(
      ta.value
        .split(/[\s,]+/)
        .map(cleanHost)
        .filter(Boolean),
    ),
  ];
  ta.addEventListener("input", () => {
    clearTimeout(listTimer);
    listTimer = setTimeout(() => update({ sites: readList() }), 350);
  });
  ta.addEventListener("blur", () => {
    clearTimeout(listTimer);
    update({ sites: readList() });
  });

  // Keep in sync if settings change elsewhere (another popup, background).
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch[KEY]) return;
    const next = normalize(ch[KEY].newValue);
    if (JSON.stringify(next) !== JSON.stringify(state.settings)) {
      state.settings = next;
      render();
    }
  });
}

/* ---------- startup ---------- */

async function init() {
  mountUI();
  $("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  buildSliders();
  bind();

  try {
    [state.tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
  } catch {
    /* no tab */
  }
  const url = (state.tab && (state.tab.url || state.tab.pendingUrl)) || "";
  state.protected = !url || PROTECTED.test(url) || STORES.test(url);
  try {
    const u = new URL(url);
    state.siteKey = (u.hostname || u.protocol.replace(/:$/, "")).toLowerCase();
  } catch {
    /* unparsable */
  }

  const stored = await chrome.storage.local.get(KEY).catch(() => ({}));
  if (stored && stored[KEY]) {
    state.settings = normalize(stored[KEY]);
  } else {
    // First run on v2: take over the background's old on/off state.
    const res = await chrome.runtime
      .sendMessage({ type: "rdm:getState" })
      .catch(() => null);
    state.settings = normalize({ enabled: !!(res && res.on) });
  }

  if (!state.protected && state.tab) {
    state.page = await chrome.tabs
      .sendMessage(state.tab.id, { type: "rdm:status" }, { frameId: 0 })
      .catch(() => null);
  }

  render();
  $(".app").classList.add("ready");
}

init();
