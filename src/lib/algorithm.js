// Offline "algorithm" solver: extracts answers from the knowledge base, no API calls.
//
// 1. KB is split into sentences (hard-wrapped PDF lines re-joined); a BM25 inverted
//    index over sentences is built (cached per KB text).
// 2. For each question, every sentence gets a question-relevance score (BM25, 0..1);
//    a sentence next to a relevant one inherits a reduced share.
// 3. For each option, its *distinctive* terms (minus terms shared by all options and
//    terms already in the question) are matched against passages; an option scores
//    high when a passage that is relevant to the question also contains it
//    (idf-weighted coverage + exact phrase bonus).
// 4. Special handling: true/false statements, negated questions ("which is NOT"),
//    "all/none of the above", multi-select thresholds.
// Language-agnostic tokenization (Unicode letters, diacritics folded) with a light
// English + Slovene stemmer and stop-word lists.

const STOPWORDS = new Set((
  'a an the of to in on at by for with from as is are was were be been being and or but if then than that this these those ' +
  'it its into over under about which who whom whose what when where why how do does did done have has had can could ' +
  'should would will shall may might must also such there their them they he she his her we our you your i me my so very ' +
  'more most each other some any only just same both between during before after above below up down out off again ' +
  'further once here own too following true false statement correct incorrect answer question select choose one ' +
  'in je da se na za v z s k h ki so pa ali kot po od do iz pri to ta te ti tu ter tudi bi bo bil bila bilo sem si smo ' +
  'ste ga jo jih mu ji mi vi oni ona ono kateri katera katero katere kaj kdo kje kdaj kako zakaj ker ce ko se ze naj ' +
  'lahko med nad pod pred brez ena en eno dva dve trditev pravilna pravilno odgovor vprasanje izberi izberite'
).split(/\s+/));

const NEG_WORDS = /(?<![\p{L}\p{N}])(not|no|never|none|cannot|can't|isn't|aren't|doesn't|don't|didn't|won't|wasn't|weren't|ne|ni|nikoli|noben\w*|brez)(?![\p{L}\p{N}])/gu;
const NEG_QUESTION = /(?<![\p{L}\p{N}])(except|razen|false|incorrect|untrue|wrong|napacn\w*|neresnic\w*|ne drzi|ne velja|ni pravil\w*|least likely)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(which|what|katera|kateri|katero|katere|kaj)(?![\p{L}\p{N}])[^?]{0,60}(?<![\p{L}\p{N}])(not|ne|ni)(?![\p{L}\p{N}])/u;
const NEG_UPPER = /\b(NOT|EXCEPT|FALSE|INCORRECT|NI|NE|RAZEN)\b/;
const ALL_ABOVE = /(all of the above|all of these|all the above|all are correct|vse (od )?(zgoraj )?nastet\w*|vsi odgovori|vse navedeno|vse nasteto)/;
const NONE_ABOVE = /(none of the above|none of these|nothing of the above|noben od nastetih|nic od nastetega|nobeden)/;
const TF_PAIRS = [
  ['true', 'false'], ['yes', 'no'], ['correct', 'incorrect'], ['right', 'wrong'], ['drzi', 'ne drzi'], ['da', 'ne'],
  ['pravilno', 'napacno'], ['res', 'ni res'], ['t', 'f'], ['resnicno', 'neresnicno'], ['velja', 'ne velja'],
  ['tocno', 'netocno'], ['wahr', 'falsch'], ['richtig', 'falsch'], ['vrai', 'faux'], ['verdadero', 'falso'], ['vero', 'falso'],
  ['pravilna', 'napacna'], ['resnica', 'neresnica']
];

export const fold = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
const ENUM_RE = /^\s*(?:\(?[a-z0-9]{1,2}[.):]|\([a-z0-9]{1,2}\))\s+/i;
const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const phraseKey = (s) => ' ' + words(String(s).replace(ENUM_RE, '')).join(' ') + ' ';

export function stem(t) {
  if (t.length <= 3 || /^\d/.test(t)) return t;
  let s = t;
  if (s.length > 4) s = s.replace(/ies$/, 'y').replace(/(ing|ed|es|ly|s)$/, '');
  if (s.length > 4) s = s.replace(/(ami|ega|emu|ih|om|em|ov|ev|a|e|i|o|u)$/, '');
  return s.slice(0, 7);
}
export const tokenize = (s) => words(s).filter((w) => !STOPWORDS.has(w)).map(stem);

function splitSentences(text) {
  // re-join hard-wrapped lines (PDF copy/paste), keep real line breaks (bullets, headings)
  const lines = String(text).replace(/\r/g, '').split('\n');
  const merged = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { merged.push(''); continue; }
    const prev = merged.length ? merged[merged.length - 1] : '';
    if (prev && !/[.!?:;]$/.test(prev) && /^[\p{Ll}(]/u.test(line)) merged[merged.length - 1] = prev + ' ' + line;
    else merged.push(line);
  }
  const out = [];
  for (const block of merged) {
    if (!block) continue;
    for (let s of block.split(/(?<=[.!?;])\s+(?=[\p{Lu}\p{N}"“„(])/u)) {
      s = s.trim();
      if (!s) continue;
      if (s.length <= 450) { out.push(s); continue; }
      // very long sentence: chunk at commas
      let cur = '';
      for (const piece of s.split(/(?<=,)\s+/)) {
        if ((cur + ' ' + piece).length > 300 && cur) { out.push(cur); cur = piece; } else cur = cur ? cur + ' ' + piece : piece;
      }
      if (cur) out.push(cur);
    }
  }
  return out;
}

let cache = { key: null, index: null };

export function buildIndex(text) {
  const key = text.length + ':' + text.slice(0, 64) + text.slice(-64);
  if (cache.key === key && cache.text === text) return cache.index;
  const passages = splitSentences(text); // one passage per sentence; neighbours handled at scoring time
  const N = passages.length;
  const terms = passages.map((p) => tokenize(p));
  const lens = terms.map((t) => t.length);
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, N);
  const postings = new Map();
  terms.forEach((ts, pid) => {
    const tf = new Map();
    ts.forEach((t) => tf.set(t, (tf.get(t) || 0) + 1));
    for (const [t, f] of tf) {
      if (!postings.has(t)) postings.set(t, []);
      postings.get(t).push([pid, f]);
    }
  });
  const idf = (t) => {
    const df = postings.has(t) ? postings.get(t).length : 0;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };
  const index = { passages, phrases: passages.map(phraseKey), sets: terms.map((t) => new Set(t)), lens, avg, postings, idf, N };
  cache = { key, text, index };
  return index;
}

function bm25(index, qTerms) {
  const scores = new Float64Array(index.N);
  const k1 = 1.2, b = 0.75;
  for (const t of new Set(qTerms)) {
    const post = index.postings.get(t);
    if (!post) continue;
    const w = index.idf(t);
    for (const [pid, f] of post) scores[pid] += w * (f * (k1 + 1)) / (f + k1 * (1 - b + b * index.lens[pid] / (index.avg || 1)));
  }
  return scores;
}

// Relevance of each sentence to the question (0..1). A sentence next to a highly relevant
// one gets a reduced share, so answers stated in the following sentence are still found
// ("Who discovered penicillin? ... It was Alexander Fleming."), but facts from a
// neighbouring sentence about something else are not confused with direct statements.
const NEIGHBOUR = 0.35;
function relevance(index, qTerms) {
  const qs = bm25(index, qTerms);
  let maxQ = 0;
  for (const v of qs) if (v > maxQ) maxQ = v;
  const rel = new Float64Array(index.N);
  if (!maxQ) return rel;
  for (let i = 0; i < index.N; i++) {
    const nb = Math.max(i > 0 ? qs[i - 1] : 0, i + 1 < index.N ? qs[i + 1] : 0);
    rel[i] = Math.max(qs[i], NEIGHBOUR * nb) / maxQ;
  }
  return rel;
}

function coverage(index, pid, terms, set) {
  if (!terms.length) return 0;
  const s = set || index.sets[pid];
  let have = 0, total = 0;
  for (const t of terms) {
    const w = index.idf(t);
    total += w;
    if (s.has(t)) have += w;
  }
  return total ? have / total : 0;
}

function trueFalsePair(q) {
  if (q.options.length !== 2) return null;
  const k = q.options.map((o) => words(String(o).replace(ENUM_RE, '')).join(' '));
  for (const [t, f] of TF_PAIRS) {
    if (k[0] === t && k[1] === f) return { trueIdx: 0, falseIdx: 1 };
    if (k[0] === f && k[1] === t) return { trueIdx: 1, falseIdx: 0 };
  }
  return null;
}

function negCount(s) { return (fold(s).match(NEG_WORDS) || []).length; }

function solveTrueFalse(index, q, pair) {
  const qTerms = [...new Set(tokenize(q.text))];
  if (!qTerms.length) return { sel: [pair.trueIdx], conf: 0, scores: [0, 0] };
  const s = bm25(index, qTerms);
  // best few sentences by relevance; judge coverage of the sentence alone or with its successor
  const top = [...s.keys()].sort((a, b) => s[b] - s[a]).slice(0, 5).filter((i) => s[i] > 0);
  let best = -1, bestCov = 0, bestText = '';
  for (const pid of top) {
    const c1 = coverage(index, pid, qTerms);
    if (c1 > bestCov) { bestCov = c1; best = pid; bestText = index.passages[pid]; }
    if (pid + 1 < index.N) {
      const c2 = 0.95 * coverage(index, pid, qTerms, new Set([...index.sets[pid], ...index.sets[pid + 1]]));
      if (c2 > bestCov) { bestCov = c2; best = pid; bestText = index.passages[pid] + ' ' + index.passages[pid + 1]; }
    }
  }
  let truth = bestCov >= 0.6;
  if (best >= 0 && truth && (negCount(q.text) % 2) !== (negCount(bestText) % 2)) truth = false;
  const conf = Math.min(1, Math.abs(bestCov - 0.6) * 2.5);
  const scores = [0, 0];
  scores[pair.trueIdx] = truth ? bestCov : 1 - bestCov;
  scores[pair.falseIdx] = truth ? 1 - bestCov : bestCov;
  return { sel: [truth ? pair.trueIdx : pair.falseIdx], conf, scores, evidence: bestText };
}

export function scoreOptions(index, q) {
  const qTerms = [...new Set(tokenize(q.text))];
  const qSet = new Set(qTerms);
  const optTerms = q.options.map((o) => [...new Set(tokenize(String(o).replace(ENUM_RE, '')))]);
  const common = optTerms.length > 1 ? optTerms.reduce((acc, t) => acc.filter((x) => t.includes(x)), optTerms[0]) : [];
  const rel = relevance(index, qTerms);

  const evidence = [];
  const negated = [];
  const scores = q.options.map((opt, i) => {
    let d = optTerms[i].filter((t) => !common.includes(t) && !qSet.has(t));
    if (!d.length) d = optTerms[i].filter((t) => !common.includes(t));
    if (!d.length) d = optTerms[i];
    const phrase = phraseKey(opt);
    const usePhrase = phrase.trim().length >= 2;
    const cands = new Set();
    for (const t of d) for (const [pid] of index.postings.get(t) || []) cands.add(pid);
    let best = 0, bestPid = -1;
    for (const pid of cands) {
      const cov = coverage(index, pid, d);
      const ph = usePhrase && index.phrases[pid].includes(phrase) ? 1 : 0;
      const sc = (0.75 * cov + 0.25 * ph) * (0.1 + 0.9 * rel[pid]);
      if (sc > best) { best = sc; bestPid = pid; }
    }
    const ev = bestPid >= 0 ? index.passages[bestPid] : '';
    evidence.push(ev);
    // is the option negated in the sentence that mentions it? ("Sharks are fish, not mammals.")
    negated.push(!!ev && negCount(ev) > 0);
    return best;
  });
  return { scores, evidence, negated };
}

export function solveQuestion(index, q) {
  const pair = trueFalsePair(q);
  if (pair) return solveTrueFalse(index, q, pair);

  const { scores, evidence, negated } = scoreOptions(index, q);
  const n = scores.length;
  const keys = q.options.map((o) => fold(o));
  const allIdx = keys.findIndex((k) => ALL_ABOVE.test(k));
  const noneIdx = keys.findIndex((k) => NONE_ABOVE.test(k));
  const negative = NEG_QUESTION.test(fold(q.text)) || NEG_UPPER.test(q.text || '');
  // positive question: evidence that negates an option counts against it
  if (!negative && negCount(q.text) === 0) negated.forEach((ng, i) => { if (ng) scores[i] *= 0.4; });
  const order = [...scores.keys()].filter((i) => i !== allIdx && i !== noneIdx).sort((a, b) => scores[b] - scores[a]);
  const best = order.length ? scores[order[0]] : 0;
  const second = order.length > 1 ? scores[order[1]] : 0;
  let sel;

  // for "which is NOT ..." questions: options the KB explicitly negates are the answer;
  // otherwise the option with the least support.
  const negSupported = order.filter((i) => negated[i] && scores[i] >= Math.max(0.15, 0.3 * best));
  if (q.type === 'multi') {
    if (negative) {
      sel = negSupported.length ? negSupported : order.filter((i) => scores[i] < 0.5 * best);
      if (!sel.length) sel = [order[order.length - 1]];
    } else {
      const thr = Math.max(0.2, 0.65 * best);
      sel = order.filter((i) => scores[i] >= thr);
      if (!sel.length && order.length) sel = [order[0]];
      if (allIdx >= 0 && order.length >= 2 && sel.length === order.length) sel = [...sel, allIdx];
    }
  } else if (negative) {
    sel = [negSupported.length ? negSupported[0] : order[order.length - 1]];
  } else {
    sel = [order[0]];
    const supported = order.filter((i) => scores[i] >= Math.max(0.25, 0.7 * best));
    if (allIdx >= 0 && order.length >= 2 && supported.length >= Math.min(order.length, 3) && supported.length === order.length) sel = [allIdx];
    else if (noneIdx >= 0 && best < 0.15) sel = [noneIdx];
  }
  sel = sel.filter((i) => i != null && i >= 0 && i < n);
  const conf = best > 0 ? Math.min(1, (best - second) / best + best * 0.3) : 0;
  return { sel, conf, scores, evidence: sel.length ? evidence[sel[0]] : '' };
}

export function solveWithAlgorithm(questions, ctx) {
  if (!ctx || !ctx.text || !ctx.text.trim()) {
    throw new Error('Algorithm mode needs a knowledge base — create/select a context in the popup.');
  }
  const t0 = Date.now();
  const index = buildIndex(ctx.text);
  const details = questions.map((q) => solveQuestion(index, q));
  return {
    answers: details.map((d) => d.sel),
    missing: [],
    raw: details.map((d, i) => `${i + 1}: conf ${(d.conf * 100).toFixed(0)}%  scores [${d.scores.map((s) => s.toFixed(2)).join(', ')}]${d.evidence ? '\n   ↳ ' + d.evidence.slice(0, 160) : ''}`).join('\n'),
    meta: { provider: 'Algorithm (BM25)', ms: Date.now() - t0, passages: index.N, lowConfidence: details.filter((d) => d.conf < 0.15).length }
  };
}
