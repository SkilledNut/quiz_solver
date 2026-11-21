/* RealDarkMode — dark mode content script.
 * Injected on all pages at document_start. Applies a force-dark filter
 * (invert + hue-rotate) with image correction. Listens for on/off messages.
 */
(() => {
  'use strict';
  const VERSION = '1.0.0';
  const STYLE_ID = '__realdarkmode_style__';
  const DATA_ATTR = 'data-realdarkmode';
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
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function setDarkMode(on) {
    if (on) {
      ensureStyle();
      document.documentElement.setAttribute(DATA_ATTR, 'on');
    } else {
      document.documentElement.removeAttribute(DATA_ATTR);
      if (styleEl && styleEl.parentNode) styleEl.parentNode.removeChild(styleEl);
      styleEl = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'rdm:set') return false;
    setDarkMode(!!msg.on);
    return false;
  });

  globalThis.__RDM = { version: VERSION, setDarkMode };

  // Auto-enable if the background says dark mode is globally on.
  chrome.runtime.sendMessage({ type: 'rdm:getState' }).then((res) => {
    if (res && res.on) setDarkMode(true);
  }).catch(() => {});
})();
