/* RealDarkMode — dark mode content script.
 * Injected on all pages at document_start. Applies a force-dark filter
 * (invert + hue-rotate) with image correction. Listens for on/off messages.
 */
(() => {
  "use strict";
  const VERSION = "1.1.0";
  const STYLE_ID = "__realdarkmode_style__";
  const DATA_ATTR = "data-realdarkmode";
  if (globalThis.__RDM && globalThis.__RDM.version === VERSION) return;

  const CSS = `
html[${DATA_ATTR}="on"], html[${DATA_ATTR}="on"] body {
  filter: invert(1) hue-rotate(180deg) !important;
  background-color: #121212 !important;
}
html[${DATA_ATTR}="on"] img,
html[${DATA_ATTR}="on"] video,
html[${DATA_ATTR}="on"] canvas,
html[${DATA_ATTR}="on"] svg,
html[${DATA_ATTR}="on"] iframe,
html[${DATA_ATTR}="on"] object,
html[${DATA_ATTR}="on"] embed,
html[${DATA_ATTR}="on"] picture,
html[${DATA_ATTR}="on"] [style*="background-image"] {
  filter: invert(1) hue-rotate(180deg) !important;
}
`;

  let styleEl = null;

  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement("style");
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function setDarkMode(on) {
    if (on) {
      ensureStyle();
      document.documentElement.setAttribute(DATA_ATTR, "on");
    } else {
      document.documentElement.removeAttribute(DATA_ATTR);
      if (styleEl && styleEl.parentNode)
        styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== "rdm:set") return false;
    setDarkMode(!!msg.on);
    return false;
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
      // Alt+Shift+Up/Down: answers box opacity +/- 10% (saved to settings, the box follows live)
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        changeLabelOpacity(e.key === "ArrowUp" ? 10 : -10);
        return;
      }
      // e.key follows the keyboard layout (QWERTZ: Y/Z swapped); fall back to the physical key
      const k = (
        e.key && e.key.length === 1 ? e.key : (e.code || "").replace(/^Key/, "")
      ).toUpperCase();
      const command = HOTKEYS[k];
      if (!command) return;
      e.preventDefault();
      e.stopPropagation();
      sendHotkey(command);
    },
    true,
  );

  function changeLabelOpacity(delta) {
    try {
      chrome.storage.local
        .get("settings")
        .then(({ settings = {} }) => {
          const cur = settings.labelOpacity ?? 100;
          const next = Math.min(100, Math.max(5, Math.round((cur + delta) / 5) * 5));
          if (next === cur) return;
          return chrome.storage.local.set({ settings: { ...settings, labelOpacity: next } });
        })
        .catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }

  function sendHotkey(command) {
    try {
      if (chrome.runtime && chrome.runtime.id)
        chrome.runtime
          .sendMessage({ type: "qs:hotkey", command })
          .catch(() => {});
    } catch {
      /* extension reloaded */
    }
  }

  // Quadruple click (4 fast left clicks anywhere) = solve the page.
  const MULTI_CLICK_COUNT = 4;
  const MULTI_CLICK_GAP_MS = 400; // max time between consecutive clicks
  let clickCount = 0;
  let lastClickAt = 0;
  addEventListener(
    "mousedown",
    (e) => {
      if (!hotkeysOn || e.button !== 0) return;
      const now = e.timeStamp;
      clickCount = now - lastClickAt <= MULTI_CLICK_GAP_MS ? clickCount + 1 : 1;
      lastClickAt = now;
      if (clickCount < MULTI_CLICK_COUNT) return;
      clickCount = 0;
      sendHotkey("solve-quiz");
    },
    true,
  );

  globalThis.__RDM = { version: VERSION, setDarkMode };

  // Auto-enable if the background says dark mode is globally on.
  chrome.runtime
    .sendMessage({ type: "rdm:getState" })
    .then((res) => {
      if (res && res.on) setDarkMode(true);
    })
    .catch(() => {});
})();
