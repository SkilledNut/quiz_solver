import { PRESETS } from './presets.js';

// Everything lives in chrome.storage.local (never sync: API keys must not leave the machine).
export const DEFAULT_SETTINGS = {
  mode: 'llm',                 // 'llm' | 'algorithm'
  activeContextId: null,       // null = no knowledge base
  viewportOnly: false,         // only questions currently inside the viewport
  notifications: true,         // on-page toast
  flash: false,                // briefly outline the options that were selected
  answerLabel: true,           // persistent answers box in the bottom-right corner
  clickMode: 'auto',           // 'auto' | 'trusted' | 'synthetic' (trusted needs the optional "debugger" permission)
  llm: {
    provider: 'gemini',
    webSearch: true,
    effort: 'low',             // '' | 'minimal' | 'low' | 'medium' | 'high'
    maxTokens: 4096,
    temperature: '',           // '' = provider default
    customInstructions: '',
    providers: {}              // per provider: { apiKey, model, baseUrl, apiFormat }
  }
};

function merge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) {
    out[k] = (typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return merge(DEFAULT_SETTINGS, settings || {});
}
export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
export async function getContexts() {
  const { contexts } = await chrome.storage.local.get('contexts');
  return Array.isArray(contexts) ? contexts : [];
}
export async function saveContexts(contexts) {
  await chrome.storage.local.set({ contexts });
}

// Flattens settings + preset into the config object the LLM adapters consume.
export function resolveLLMConfig(settings) {
  const id = PRESETS[settings.llm.provider] ? settings.llm.provider : 'gemini';
  const p = PRESETS[id];
  const u = settings.llm.providers[id] || {};
  return {
    id,
    label: p.label,
    apiFormat: id === 'custom' ? (u.apiFormat || p.apiFormat) : p.apiFormat,
    baseUrl: (u.baseUrl || p.baseUrl || '').trim().replace(/\/+$/, ''),
    model: (u.model || p.model || '').trim(),
    apiKey: (u.apiKey || '').trim(),
    noKey: !!p.noKey,
    search: p.search,
    webSearch: !!settings.llm.webSearch && p.search !== 'none',
    effort: settings.llm.effort || '',
    maxTokens: Math.max(256, parseInt(settings.llm.maxTokens, 10) || 4096),
    temperature: settings.llm.temperature,
    customInstructions: settings.llm.customInstructions || '',
    chatEffort: !!p.chatEffort
  };
}
