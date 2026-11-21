// Provider presets. Every field can be overridden per provider in the popup
// (model, base URL, and — for "custom" — the API format), so any provider that
// speaks one of the four supported wire formats works.
//
// apiFormat: 'openai-chat' | 'openai-responses' | 'anthropic' | 'gemini'
// search:    'native'  -> provider tool the model calls only when needed
//            'plugin'  -> OpenRouter web plugin
//            'always'  -> model always searches (Perplexity Sonar)
//            'none'    -> no web search available

export const API_FORMATS = {
  'openai-chat': 'OpenAI-compatible (Chat Completions)',
  'openai-responses': 'OpenAI Responses API',
  anthropic: 'Anthropic Messages API',
  gemini: 'Google Gemini API'
};

export const PRESETS = {
  gemini: {
    label: 'Google Gemini',
    apiFormat: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.1-flash-lite',
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'],
    search: 'native',
    keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Search = Grounding with Google Search (model decides when to search).'
  },
  anthropic: {
    label: 'Anthropic Claude',
    apiFormat: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-5-5',
    models: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    search: 'native',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: 'Search = Anthropic web search tool (must be enabled for your org in the Console).'
  },
  openai: {
    label: 'OpenAI',
    apiFormat: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5.4-mini',
    models: ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano'],
    search: 'native',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: 'Search = Responses API web_search tool.'
  },
  openrouter: {
    label: 'OpenRouter (any model)',
    apiFormat: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-3.1-flash-lite',
    models: ['google/gemini-3.1-flash-lite', 'anthropic/claude-haiku-5-5', 'openai/gpt-5.4-mini', 'deepseek/deepseek-chat'],
    search: 'plugin',
    keyUrl: 'https://openrouter.ai/keys',
    note: 'Search = OpenRouter web plugin (billed per request by OpenRouter).'
  },
  perplexity: {
    label: 'Perplexity Sonar',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar',
    models: ['sonar', 'sonar-pro'],
    search: 'always',
    keyUrl: 'https://www.perplexity.ai/settings/api',
    note: 'Sonar models always search the web.'
  },
  deepseek: {
    label: 'DeepSeek',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    search: 'none',
    keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  groq: {
    label: 'Groq',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-20b',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    search: 'none',
    chatEffort: true,
    keyUrl: 'https://console.groq.com/keys'
  },
  mistral: {
    label: 'Mistral',
    apiFormat: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-small-latest',
    models: ['mistral-small-latest', 'mistral-medium-latest'],
    search: 'none',
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  ollama: {
    label: 'Ollama (local)',
    apiFormat: 'openai-chat',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    models: [],
    search: 'none',
    noKey: true,
    note: 'Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.'
  },
  custom: {
    label: 'Custom endpoint',
    apiFormat: 'openai-chat',
    baseUrl: '',
    model: '',
    models: [],
    search: 'native',
    chatEffort: true,
    note: 'Any endpoint speaking one of the four API formats.'
  }
};
