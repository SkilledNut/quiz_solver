// Provider-agnostic LLM client. One request per solve: the knowledge base is sent
// once, as a stable system prompt (cache-friendly), followed by all questions.
//
// Four wire formats cover practically every provider:
//   openai-chat      — OpenAI-compatible /chat/completions (OpenRouter, Groq, DeepSeek,
//                      Mistral, Perplexity, Together, Ollama, LM Studio, vLLM, ...)
//   openai-responses — OpenAI /responses (native web_search tool)
//   anthropic        — Anthropic /messages (web_search server tool, prompt caching)
//   gemini           — Google generateContent (Grounding with Google Search)
//
// Optional parameters that a given model rejects (temperature, reasoning effort,
// max_tokens naming, web search tool) are dropped automatically and retried.

import { buildMessages, parseAnswer, optionLabel } from './prompt.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function errorMessage(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    if (typeof e === 'string') return e;
    return e?.message || j.message || j.detail || bodyText.slice(0, 300);
  } catch {
    return bodyText.slice(0, 300);
  }
}

const hasTemp = (cfg) => cfg.temperature !== '' && cfg.temperature != null && !Number.isNaN(Number(cfg.temperature));

// ---------------------------------------------------------------- adapters
// build(cfg, system, user, drop) -> { url, headers, body }
// parse(data, body)              -> { text, next?, searched?, usage? }
// optional: [{ name, re }] droppable params, matched against the API error message

const openaiChat = {
  optional: [
    { name: 'temperature', re: /temperature/i },
    { name: 'max_tokens', re: /max_tokens|max_completion_tokens/i },
    { name: 'max_completion_tokens', re: /max_tokens|max_completion_tokens/i },
    { name: 'reasoning_effort', re: /reasoning/i },
    { name: 'plugins', re: /plugin|web/i }
  ],
  build(cfg, system, user, drop) {
    const body = { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (!drop.has('max_tokens')) body.max_tokens = cfg.maxTokens;
    else if (!drop.has('max_completion_tokens')) body.max_completion_tokens = cfg.maxTokens;
    if (hasTemp(cfg) && !drop.has('temperature')) body.temperature = Number(cfg.temperature);
    if (cfg.effort && cfg.chatEffort && !drop.has('reasoning_effort')) body.reasoning_effort = cfg.effort === 'minimal' ? 'low' : cfg.effort;
    if (cfg.webSearch && cfg.search === 'plugin' && !drop.has('plugins')) body.plugins = [{ id: 'web', max_results: 3 }];
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = 'Bearer ' + cfg.apiKey;
    if (cfg.id === 'openrouter') { headers['X-Title'] = 'Quiz Solver'; }
    return { url: cfg.baseUrl + '/chat/completions', headers, body };
  },
  parse(data) {
    const msg = data.choices?.[0]?.message || {};
    let text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : '';
    if (!text && data.choices?.[0]?.text) text = data.choices[0].text;
    return { text, usage: data.usage, searched: (msg.annotations || []).length > 0 || !!data.citations };
  }
};

const openaiResponses = {
  optional: [
    { name: 'temperature', re: /temperature/i },
    { name: 'reasoning', re: /reasoning|effort/i },
    { name: 'tools', re: /tool|web_search/i },
    { name: 'max_output_tokens', re: /max_output_tokens/i }
  ],
  build(cfg, system, user, drop) {
    const body = { model: cfg.model, instructions: system, input: user, store: false };
    if (!drop.has('max_output_tokens')) body.max_output_tokens = cfg.maxTokens;
    if (cfg.webSearch && !drop.has('tools')) body.tools = [{ type: drop.has('tools-v2') ? 'web_search_preview' : 'web_search' }];
    if (cfg.effort && !drop.has('reasoning')) {
      body.reasoning = { effort: cfg.webSearch && cfg.effort === 'minimal' ? 'low' : cfg.effort };
    }
    if (hasTemp(cfg) && !drop.has('temperature')) body.temperature = Number(cfg.temperature);
    return {
      url: cfg.baseUrl + '/responses',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body
    };
  },
  parse(data) {
    let text = typeof data.output_text === 'string' ? data.output_text : '';
    let searched = false;
    for (const item of data.output || []) {
      if (item.type === 'web_search_call') searched = true;
      if (!text && item.type === 'message') {
        text += (item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('\n');
      }
    }
    return { text, usage: data.usage, searched };
  },
  onDrop(drop, name) { if (name === 'tools' && !drop.has('tools-v2')) { drop.delete('tools'); drop.add('tools-v2'); } }
};

function anthropicSearchTool(model) {
  // Newer models take the dynamic-filtering variant; older ones (and Haiku) the basic one.
  return /(fable|mythos|opus-(4-[6-9]|5)|sonnet-(4-6|5))/i.test(model) ? 'web_search_20260209' : 'web_search_20250305';
}

const anthropic = {
  optional: [
    { name: 'output_config', re: /effort|output_config/i },
    { name: 'tools', re: /tool|web_search/i }
  ],
  build(cfg, system, user, drop, prev) {
    const body = prev || {
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      // cache the (large, stable) knowledge-base system prompt between solves
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }]
    };
    delete body.tools;
    delete body.output_config;
    if (cfg.webSearch && !drop.has('tools')) {
      const type = drop.has('tools-v2') ? 'web_search_20250305' : anthropicSearchTool(cfg.model);
      body.tools = [{ type, name: 'web_search', max_uses: 3 }];
    }
    if (cfg.effort && !drop.has('output_config')) body.output_config = { effort: cfg.effort === 'minimal' ? 'low' : cfg.effort };
    return {
      url: cfg.baseUrl + '/messages',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2026-10-21',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body
    };
  },
  parse(data, body) {
    if (data.stop_reason === 'refusal') throw new Error('The model declined to answer (refusal).');
    const blocks = data.content || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const searched = blocks.some((b) => b.type === 'server_tool_use');
    // server-side tool loop paused: send the turn back so the model can continue
    const next = data.stop_reason === 'pause_turn'
      ? { ...body, messages: [...body.messages, { role: 'assistant', content: blocks }] }
      : null;
    return { text, next, searched, usage: data.usage };
  },
  onDrop(drop, name) { if (name === 'tools' && !drop.has('tools-v2')) { drop.delete('tools'); drop.add('tools-v2'); } }
};

function geminiThinking(model, effort) {
  if (/gemini-2\./i.test(model)) {
    const budgets = { minimal: 0, low: 512, medium: 2048, high: 8192 };
    return { thinkingBudget: budgets[effort] ?? 512 };
  }
  return { thinkingLevel: effort };
}

const gemini = {
  optional: [
    { name: 'thinkingConfig', re: /thinking/i },
    { name: 'tools', re: /google_search|tool|grounding|search/i },
    { name: 'temperature', re: /temperature/i }
  ],
  build(cfg, system, user, drop) {
    const model = cfg.model.replace(/^models\//, '');
    const generationConfig = { maxOutputTokens: cfg.maxTokens };
    if (hasTemp(cfg) && !drop.has('temperature')) generationConfig.temperature = Number(cfg.temperature);
    if (cfg.effort && !drop.has('thinkingConfig')) generationConfig.thinkingConfig = geminiThinking(model, cfg.effort);
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig
    };
    if (cfg.webSearch && !drop.has('tools')) body.tools = [{ google_search: {} }];
    return {
      url: `${cfg.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body
    };
  },
  parse(data) {
    const cand = data.candidates?.[0];
    if (!cand) {
      const reason = data.promptFeedback?.blockReason;
      throw new Error(reason ? `Gemini blocked the prompt (${reason}).` : 'Gemini returned no candidates.');
    }
    const text = (cand.content?.parts || []).filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    if (!text && cand.finishReason && cand.finishReason !== 'STOP') {
      throw new Error(`Gemini stopped: ${cand.finishReason}${cand.finishReason === 'MAX_TOKENS' ? ' (increase Max tokens)' : ''}.`);
    }
    return { text, searched: !!cand.groundingMetadata?.webSearchQueries?.length, usage: data.usageMetadata };
  }
};

export const ADAPTERS = { 'openai-chat': openaiChat, 'openai-responses': openaiResponses, anthropic, gemini };

// ---------------------------------------------------------------- transport
async function fetchJSON(req, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)} s.`);
    throw new Error('Network error: ' + e.message);
  } finally {
    clearTimeout(timer);
  }
}

export async function callLLM(cfg, system, user, { timeoutMs = 120000 } = {}) {
  const adapter = ADAPTERS[cfg.apiFormat];
  if (!adapter) throw new Error('Unknown API format: ' + cfg.apiFormat);
  if (!cfg.baseUrl) throw new Error('No base URL configured for ' + cfg.label + '.');
  if (!cfg.model) throw new Error('No model configured for ' + cfg.label + '.');
  if (!cfg.apiKey && !cfg.noKey) throw new Error(`No API key set for ${cfg.label}. Open the extension popup → LLM settings.`);

  const drop = new Set();
  const warnings = [];
  let texts = [];
  let searched = false;
  let usage = null;
  let prevBody = null;
  let networkRetries = 0;
  let blindRetried = false;

  for (let attempt = 0; attempt < 8; attempt++) {
    const req = adapter.build(cfg, system, user, drop, prevBody);
    let res, text;
    try {
      ({ res, text } = await fetchJSON(req, timeoutMs));
    } catch (e) {
      if (networkRetries++ < 1 && !/timed out/.test(e.message)) { await sleep(1200); continue; }
      throw e;
    }

    if (res.ok) {
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON from API: ' + text.slice(0, 200)); }
      const out = adapter.parse(data, req.body);
      texts.push(out.text || '');
      searched = searched || !!out.searched;
      usage = out.usage || usage;
      if (out.next) { prevBody = out.next; continue; } // continuation (Anthropic pause_turn)
      return { text: texts.join('\n'), searched, usage, warnings };
    }

    const msg = errorMessage(text) || res.statusText;
    if (res.status === 400 || res.status === 422) {
      const present = adapter.optional.filter((o) => !drop.has(o.name) && (o.name in req.body || o.name in (req.body.generationConfig || {}) || (o.name === 'tools' && req.body.tools)));
      const hit = present.find((o) => o.re.test(msg));
      if (hit) {
        drop.add(hit.name);
        if (adapter.onDrop) adapter.onDrop(drop, hit.name);
        warnings.push(`API rejected "${hit.name}" — retried without it (${msg.slice(0, 120)})`);
        prevBody = null;
        texts = [];
        continue;
      }
      // unspecific 400: one blind retry without all optional tuning params (web search kept)
      const tuning = present.filter((o) => o.name !== 'tools' && !/max_/.test(o.name));
      if (!blindRetried && tuning.length) {
        blindRetried = true;
        tuning.forEach((o) => drop.add(o.name));
        warnings.push(`API returned 400 — retried without ${tuning.map((o) => o.name).join(', ')} (${msg.slice(0, 120)})`);
        prevBody = null;
        texts = [];
        continue;
      }
    }
    if ((res.status === 429 || res.status === 503 || res.status === 529 || res.status >= 500) && attempt < 3) {
      const ra = parseFloat(res.headers.get('retry-after'));
      await sleep(Number.isFinite(ra) ? Math.min(ra * 1000, 10000) : 1500 * (attempt + 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error(`${cfg.label}: authentication failed (${res.status}) — check the API key. ${msg}`);
    throw new Error(`${cfg.label} API error ${res.status}: ${msg}`);
  }
  throw new Error('Too many retries.');
}

// ---------------------------------------------------------------- high level
export async function solveWithLLM(questions, ctx, cfg) {
  const { system, user } = buildMessages(questions, ctx, cfg);
  const t0 = Date.now();
  const out = await callLLM(cfg, system, user);
  const parsed = parseAnswer(out.text, questions);
  return {
    answers: parsed.answers,
    missing: parsed.missing,
    raw: out.text,
    meta: {
      provider: cfg.label, model: cfg.model, ms: Date.now() - t0, searched: out.searched,
      usage: out.usage, warnings: out.warnings, promptChars: system.length + user.length
    }
  };
}

export async function testConnection(cfg) {
  const q = [{ type: 'single', text: 'What is 2 + 2?', options: ['3', '4', '5'] }];
  const { system, user } = buildMessages(q, null, { ...cfg, webSearch: false });
  const t0 = Date.now();
  const out = await callLLM({ ...cfg, webSearch: false }, system, user, { timeoutMs: 45000 });
  const parsed = parseAnswer(out.text, q);
  const got = parsed.answers[0] ? parsed.answers[0].map(optionLabel).join(',') : '?';
  return { ok: got === 'B', ms: Date.now() - t0, raw: out.text, got, warnings: out.warnings };
}
