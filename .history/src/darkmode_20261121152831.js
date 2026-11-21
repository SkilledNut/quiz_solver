/* RealDarkMode — logic for the #darkmodeView block in popup.html. */
"use strict";

// Brings the #darkmodeView block in popup.html to life. All markup and styling live in that block.
const ROOT = () => document.getElementById("darkmodeView");

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

const $ = (sel) => ROOT().querySelector(sel);
const $$ = (sel) => [...ROOT().querySelectorAll(sel)];

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
  const btn = $("#rdm-siteBtn");
  const listed = isListed();
  btn.dataset.tone = st.tone;
  btn.disabled = state.protected || !state.siteKey;
  $("#rdm-siteName").textContent =
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
  const status = $("#rdm-siteStatus");
  status.dataset.tone = st.tone;
  status.textContent = st.text;

  // site list
  $("#rdm-listHint").textContent =
    s.siteListMode === "exclude"
      ? "Dark mode runs everywhere except these sites. One per line; subdomains are included."
      : "Dark mode runs only on these sites. One per line; subdomains are included.";
  const ta = $("#rdm-siteList");
  if (document.activeElement !== ta) ta.value = s.sites.join("\n");

  $("#rdm-detectDark").checked = s.detectDark;
}

/* ---------- UI wiring ---------- */

function bindSliders() {
  for (const c of SLIDERS) {
    const row = $(`.slider[data-key="${c.key}"]`);
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
  }
}

function selectTab(id) {
  $$('[role="tab"]').forEach((t) => {
    const on = t.dataset.tab === id;
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  });
  $$(".panel").forEach((p) => {
    p.hidden = p.id !== `rdm-panel-${id}`;
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
  $("#rdm-siteBtn").addEventListener("click", toggleSite);
  $("#rdm-detectDark").addEventListener("change", (e) =>
    update({ detectDark: e.target.checked }),
  );
  $("#rdm-resetBtn").addEventListener("click", () =>
    update({
      mode: "dark",
      brightness: 100,
      contrast: 100,
      sepia: 0,
      grayscale: 0,
    }),
  );

  const ta = $("#rdm-siteList");
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
  if (!ROOT()) return;
  $("#rdm-version").textContent = `v${chrome.runtime.getManifest().version}`;
  bindSliders();
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
