// Prompt construction + robust parsing of the letters-only LLM answer.
// Pure functions (no chrome.* APIs) so they can be unit-tested in Node.

// 0 -> A, 25 -> Z, 26 -> AA, ...
export function optionLabel(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// The system prompt only depends on the context + settings, never on the questions,
// so providers with prefix caching (Anthropic cache_control, OpenAI / Gemini implicit
// caching) reuse the cached knowledge base across solves.
export function buildSystemPrompt(ctx, cfg = {}) {
  const kb = ctx && ctx.text ? ctx.text.trim() : '';
  const lines = [
    'You are a precise quiz-answering engine.',
    kb
      ? 'Answer each multiple-choice question using the KNOWLEDGE BASE below as the primary source of truth.'
      : 'Answer each multiple-choice question.',
    cfg.webSearch
      ? (kb ? 'If the knowledge base does not contain the answer, use web search; if still unsure, use your best knowledge.'
            : 'Use web search when you are not certain; otherwise use your knowledge.')
      : (kb ? 'If the knowledge base does not contain the answer, use your own knowledge.' : ''),
    'Always answer every question, even when unsure (pick the most likely option).',
    '',
    'OUTPUT FORMAT (strict):',
    '- Exactly one line per question: <question number>: <letter(s)>',
    '- [single] questions: exactly one letter. [multi] questions: ALL correct letters, comma-separated.',
    '- Output nothing else: no explanations, no option text, no markdown.',
    'Example:',
    '1: B',
    '2: A, C',
    '3: D'
  ];
  if (cfg.customInstructions && cfg.customInstructions.trim()) {
    lines.push('', 'Additional instructions: ' + cfg.customInstructions.trim());
  }
  if (kb) {
    lines.push('', `=== KNOWLEDGE BASE${ctx.name ? ` ("${ctx.name}")` : ''} ===`, kb, '=== END OF KNOWLEDGE BASE ===');
  }
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

// Sites often number options themselves ("a. Paris", "2) Rome"). Strip that when every
// option has it, so the model only sees our A/B/C letters.
const SITE_ENUM = /^\s*(?:\(?[a-z0-9]{1,2}[.):]|\([a-z0-9]{1,2}\))\s+/i;
export function stripEnumerators(options) {
  if (options.length < 2 || !options.every((o) => SITE_ENUM.test(o || ''))) return options;
  return options.map((o) => o.replace(SITE_ENUM, ''));
}

export function buildUserPrompt(questions) {
  const parts = [`Answer these ${questions.length} question(s). Reply only in the required format.`, ''];
  questions.forEach((q, i) => {
    const tag = q.type === 'multi' ? '[multi — select ALL correct options]' : '[single — select exactly one option]';
    parts.push(`${i + 1}. ${tag}`);
    parts.push(q.text ? q.text : '(question text not detected — infer from the options)');
    stripEnumerators(q.options).forEach((o, j) => parts.push(`${optionLabel(j)}) ${o || '(no text)'}`));
    parts.push('');
  });
  return parts.join('\n').trim();
}

export function buildMessages(questions, ctx, cfg) {
  return { system: buildSystemPrompt(ctx, cfg), user: buildUserPrompt(questions) };
}

const FILLER = new Set(['AND', 'OR', 'IN', 'ALSO', 'OPTION', 'OPTIONS', 'ANSWER', 'ANSWERS', 'IS', 'ARE', 'THE',
  'LETTER', 'LETTERS', 'CORRECT', 'ODGOVOR', 'IN', 'TER', 'ONLY']);

const foldKey = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/^\s*(?:\(?[a-z0-9]{1,2}[.):]|\([a-z0-9]{1,2}\))\s+/i, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Extracts option indices from the answer part of one line ("B", "A, C", "AC", "B) Paris", "A and D").
export function extractLetters(s, q) {
  const n = q.options.length;
  const labels = Array.from({ length: n }, (_, i) => optionLabel(i));
  const tokens = String(s).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const idx = labels.indexOf(t);
    if (idx >= 0) { out.push(idx); continue; }
    if (FILLER.has(t)) continue;
    // "AC" / "BD" glued multi answers
    if (q.type === 'multi' && n <= 26 && t.length > 1 && t.length <= n && [...t].every((c) => labels.includes(c)) && new Set(t).size === t.length) {
      [...t].forEach((c) => out.push(labels.indexOf(c)));
      continue;
    }
    break; // first real word ends the letter list ("B) Paris" -> stop at PARIS)
  }
  let uniq = [...new Set(out)];
  if (!uniq.length) {
    // model answered with option text instead of letters
    const k = foldKey(s);
    if (k.length >= 2) {
      const hits = q.options.map((o, i) => [foldKey(o), i]).filter(([ok]) => ok && (k === ok || (ok.length >= 3 && k.includes(ok))));
      uniq = hits.map(([, i]) => i);
    }
  }
  if (q.type !== 'multi' && uniq.length > 1) uniq = [uniq[0]];
  return uniq;
}

// Returns { answers: Array<number[]|null>, missing: number[] }
export function parseAnswer(raw, questions) {
  let text = String(raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```[a-z]*\s*/gi, '')
    .replace(/\*\*|__|`/g, '');
  const answers = new Array(questions.length).fill(null);
  const lineRe = /^\s*(?:[-•>]\s*)?(?:q(?:uestion)?|vpra[sš]anje|frage|pregunta)?\s*#?\s*(\d{1,3})\s*(?:[:.)=\]\-–—]|\s(?=[A-Za-z]\b))\s*(.*)$/i;

  // pass 1: one answer per line
  for (const line of text.split(/\r?\n/)) {
    // a line may contain several "n: X" chunks ("1: B; 2: A,C")
    const chunks = line.split(/[;|](?=\s*(?:q(?:uestion)?\s*)?\d{1,3}\s*[:.)=\-])/i);
    for (const chunk of chunks) {
      const m = chunk.match(lineRe);
      if (!m) continue;
      const qi = parseInt(m[1], 10) - 1;
      if (qi < 0 || qi >= questions.length) continue;
      const letters = extractLetters(m[2], questions[qi]);
      if (letters.length) answers[qi] = letters; // later lines win (final answer after reasoning)
    }
  }

  // pass 2: inline "1:B 2:AC 3:D" all on one line
  if (answers.some((a) => !a)) {
    const re = /(?:^|[\s,;|(])(\d{1,3})\s*[:=)\].\-]\s*([A-Za-z](?:\s*(?:,|\/|\+|&|and)?\s*[A-Za-z](?![A-Za-z]))*)(?![A-Za-z])/g;
    for (const m of text.matchAll(re)) {
      const qi = parseInt(m[1], 10) - 1;
      if (qi < 0 || qi >= questions.length || answers[qi]) continue;
      const letters = extractLetters(m[2], questions[qi]);
      if (letters.length) answers[qi] = letters;
    }
  }

  // pass 3: single question and the model replied with just letters
  if (questions.length === 1 && !answers[0]) {
    const cleaned = text.replace(/^[^A-Za-z]*(?:answer|odgovor)\s*[:=-]?\s*/i, '').trim();
    const letters = extractLetters(cleaned, questions[0]);
    if (letters.length) answers[0] = letters;
  }

  const missing = answers.map((a, i) => (a ? -1 : i)).filter((i) => i >= 0);
  return { answers, missing };
}

export function formatAnswers(answers, questions) {
  return answers.map((a, i) => `${i + 1}: ${a && a.length ? a.map(optionLabel).join(',') : '?'}`).join('  ');
}
