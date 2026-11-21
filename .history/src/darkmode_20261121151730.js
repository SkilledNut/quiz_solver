/* RealDarkMode — dark mode content script (v2).
 * Injected on all pages (all frames) at document_start.
 *
 * How it works
 *  - Settings live in chrome.storage.local under "rdmSettings" and are written by the popup.
 *    Every tab listens for changes, so slider moves preview live.
 *  - Dark mode = one filter on <html> only (invert + hue-rotate + a soft contrast so the result is
 *    #121212-ish instead of pure black), with photos/video/canvas/iframes re-inverted exactly once.
 *  - Pages that are already dark are detected after DOMContentLoaded and left untouched.
 *  - Legacy messages still work: {type:'rdm:set', on} forces on/off, and 'rdm:getState' from the
 *    background is used as a fallback when no settings have been saved yet.
 */
(() => {
  "use strict";

  const VERSION = "2.0.0";
  const STYLE_ID = "__realdarkmode_style__";
  const ATTR = "data-realdarkmode";
  const SETTINGS_KEY = "rdmSettings";

  const DEFAULTS = Object.freeze({
    enabled: false,
    mode: "dark", // 'dark' | 'light'
    brightness: 100, // 50–150
    contrast: 100, // 50–150
    sepia: 0, // 0–100
    grayscale: 0, // 0–100
    detectDark: true, // leave already-dark sites alone
    siteListMode: "exclude", // 'exclude' = everywhere except listed, 'only' = listed sites only
    sites: [],
  });
  const LIMITS = {
    brightness: [50, 150],
    contrast: [50, 150],
    sepia: [0, 100],
    grayscale: [0, 100],
  };

  // Softens the inverted result: page white -> ~#121212, page black -> ~#ededed.
  const BASE_CONTRAST = 0.86;

  // Elements that must keep their real colours (re-inverted once, never twice when nested).
  const MEDIA = [
    "img",
    "video",
    "picture",
    "canvas",
    "iframe",
    "object",
    "embed",
    '[style*="background-image"]',
    '[style*="background: url"]',
    '[style*="background:url"]',
  ].join(", ");

  const prev = globalThis.__RDM;
  if (prev && prev.version === VERSION) return;
  if (prev && typeof prev.setDarkMode === "function") {
    try {
      prev.setDarkMode(false);
    } catch {
      /* older instance already gone */
    }
  }

  const root = document.documentElement;
  const siteKey = topSiteKey();

  let settings = normalize(null);
  let override = null; // set by legacy 'rdm:set' messages; cleared when the user changes settings
  let detectedDark = false;
  let styleEl = null;
  let appliedCss = null;

  /* ---------- settings ---------- */

  // Per-site rules follow the tab's top-level site, also inside iframes.
  function topSiteKey() {
    try {
      const anc = location.ancestorOrigins;
      const u = anc && anc.length ? new URL(anc[anc.length - 1]) : location;
      return (u.hostname || u.protocol.replace(/:$/, "")).toLowerCase();
    } catch {
      return (
        location.hostname || location.protocol.replace(/:$/, "")
      ).toLowerCase();
    }
  }

  function cleanHost(v) {
    return String(v || "")
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .split(/[/?#]/)[0]
      .replace(/:\d+$/, "");
  }

  function clamp(n, [lo, hi], d) {
    n = Number(n);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  }

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    s.enabled = !!s.enabled;
    s.mode = s.mode === "light" ? "light" : "dark";
    for (const k of Object.keys(LIMITS))
      s[k] = clamp(s[k], LIMITS[k], DEFAULTS[k]);
    s.detectDark = s.detectDark !== false;
    s.siteListMode = s.siteListMode === "only" ? "only" : "exclude";
    s.sites = Array.isArray(s.sites)
      ? [...new Set(s.sites.map(cleanHost).filter(Boolean))]
      : [];
    return s;
  }

  function isListed() {
    return settings.sites.some(
      (h) => siteKey === h || siteKey.endsWith("." + h),
    );
  }

  function shouldRun() {
    if (override !== null) return override;
    if (!settings.enabled) return false;
    if (settings.mode === "dark" && settings.detectDark && detectedDark)
      return false;
    return settings.siteListMode === "only" ? isListed() : !isListed();
  }

  /* ---------- styles ---------- */

  function buildCss(s) {
    const f = (n) => (n / 100).toFixed(2);
    const adjust = [
      s.brightness !== 100 && `brightness(${f(s.brightness)})`,
      s.contrast !== 100 && `contrast(${f(s.contrast)})`,
      s.sepia && `sepia(${f(s.sepia)})`,
      s.grayscale && `grayscale(${f(s.grayscale)})`,
    ]
      .filter(Boolean)
      .join(" ");
    const on = `html[${ATTR}]`;

    if (s.mode === "light") {
      return adjust ? `${on} { filter: ${adjust} !important; }` : "";
    }

    return `
${on} {
  filter: invert(1) hue-rotate(180deg) contrast(${BASE_CONTRAST}) ${adjust} !important;
}
/* Page with no background of its own: paint it white so it inverts to dark (zero specificity, so
   any background the site sets still wins). */
:where(${on}) { background-color: #fff; }

${on} :is(${MEDIA}):not(:is(${MEDIA}) *) {
  filter: invert(1) hue-rotate(180deg) !important;
}

/* Fullscreen content is drawn outside the page filter, so it must not be re-inverted. */
${on} :fullscreen,
${on} :fullscreen :is(${MEDIA}) {
  filter: none !important;
}
`;
  }

  function writeStyle(css) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
    }
    if (appliedCss !== css) {
      styleEl.textContent = css;
      appliedCss = css;
    }
    if (!styleEl.isConnected) (document.head || root).appendChild(styleEl);
  }

  function removeStyle() {
    if (styleEl) styleEl.remove();
    styleEl = null;
    appliedCss = null;
  }

  function apply() {
    if (shouldRun()) {
      writeStyle(buildCss(settings));
      root.setAttribute(ATTR, settings.mode);
    } else {
      root.removeAttribute(ATTR);
      removeStyle();
    }
  }

  function setDarkMode(on) {
    override = !!on;
    apply();
  }

  /* ---------- already-dark detection ---------- */

  function parseColor(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || "");
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }

  function luminance({ r, g, b }) {
    const ch = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
  }

  function pageLooksDark() {
    for (const el of [document.body, root]) {
      if (!el) continue;
      const cs = getComputedStyle(el);
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0.5) return luminance(c) < 0.18;
    }
    return getComputedStyle(root).colorScheme.trim() === "dark";
  }

  function detect() {
    if (!document.body) return;
    const dark = pageLooksDark();
    if (dark !== detectedDark) {
      detectedDark = dark;
      apply();
    } else if (appliedCss !== null && styleEl && !styleEl.isConnected) {
      writeStyle(appliedCss); // the site replaced <head>; put our style back
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", detect, { once: true });
  } else {
    detect();
  }
  addEventListener(
    "load",
    () => {
      detect();
      setTimeout(detect, 1500); // late JS themes
    },
    { once: true },
  );

  /* ---------- messaging ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === "rdm:set") {
      setDarkMode(!!msg.on);
    } else if (msg.type === "rdm:status") {
      sendResponse({
        version: VERSION,
        active: root.hasAttribute(ATTR),
        detectedDark,
        siteKey,
      });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== "local" || !ch[SETTINGS_KEY]) return;
    settings = normalize(ch[SETTINGS_KEY].newValue);
    override = null;
    apply();
  });

  // In-page hotkeys (any frame, every page). Only active while the quiz solver is enabled,
  // otherwise the keys pass through to the page untouched.
  const HOTKEYS = {
    H: "toggle-label",
    P: "solve-quiz",
    U: "undo-answers",
    Y: "redo-answers",
    L: "reapply-answers",
  };
  let hotkeysOn = false;
  chrome.storage.local
    .get("rdmQuizSolverEnabled")
    .then((r) => {
      hotkeysOn = !!(r && r.rdmQuizSolverEnabled);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.rdmQuizSolverEnabled)
      hotkeysOn = !!ch.rdmQuizSolverEnabled.newValue;
  });
  addEventListener(
    "keydown",
    (e) => {
      if (
        !hotkeysOn ||
        !e.altKey ||
        !e.shiftKey ||
        e.ctrlKey ||
        e.metaKey ||
        e.repeat
      )
        return;
      // e.key follows the keyboard layout (QWERTZ: Y/Z swapped); fall back to the physical key
      const k = (
        e.key && e.key.length === 1 ? e.key : (e.code || "").replace(/^Key/, "")
      ).toUpperCase();
      const command = HOTKEYS[k];
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        if (chrome.runtime && chrome.runtime.id)
          chrome.runtime
            .sendMessage({ type: "qs:hotkey", command })
            .catch(() => {});
      } catch {
        /* extension reloaded */
      }
    },
    true,
  );

  globalThis.__RDM = { version: VERSION, setDarkMode, refresh: apply };

  /* ---------- startup ---------- */

  chrome.storage.local
    .get(SETTINGS_KEY)
    .then((r) => {
      if (r && r[SETTINGS_KEY]) {
        settings = normalize(r[SETTINGS_KEY]);
        apply();
        return;
      }
      // Nothing saved yet: fall back to the background's global on/off state.
      chrome.runtime
        .sendMessage({ type: "rdm:getState" })
        .then((res) => {
          if (res && res.on) {
            settings = normalize({ enabled: true });
            apply();
          }
        })
        .catch(() => {});
    })
    .catch(() => {});
})();
