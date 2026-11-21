// Run: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer, extractLetters, optionLabel, buildMessages } from '../src/lib/prompt.js';
import { solveWithAlgorithm } from '../src/lib/algorithm.js';

const S = (n) => ({ type: 'single', options: Array.from({ length: n }, (_, i) => 'opt' + i) });
const M = (n) => ({ type: 'multi', options: Array.from({ length: n }, (_, i) => 'opt' + i) });

test('optionLabel', () => {
  assert.equal(optionLabel(0), 'A');
  assert.equal(optionLabel(25), 'Z');
  assert.equal(optionLabel(26), 'AA');
});

test('parse: canonical lines', () => {
  const qs = [S(4), M(4), S(3)];
  const r = parseAnswer('1: B\n2: A, C\n3: c', qs);
  assert.deepEqual(r.answers, [[1], [0, 2], [2]]);
  assert.deepEqual(r.missing, []);
});

test('parse: messy formats', () => {
  const qs = [S(4), M(5), S(4), M(4), S(2)];
  const raw = '```\n**1.** B) Paris\nQuestion 2 - A and D\n3) d\n4: AC\n5 = A\n```';
  assert.deepEqual(parseAnswer(raw, qs).answers, [[1], [0, 3], [3], [0, 2], [0]]);
});

test('parse: inline + think tags + later wins', () => {
  const qs = [S(4), M(4), S(4)];
  const raw = '<think>1: A maybe</think>1:B 2:A,C 3:D';
  assert.deepEqual(parseAnswer(raw, qs).answers, [[1], [0, 2], [3]]);
  const raw2 = '1: A\n2: B\n3: C\nFinal:\n1: D';
  assert.deepEqual(parseAnswer(raw2, qs).answers[0], [3]);
});

test('parse: single question bare letter, semicolons, out-of-range', () => {
  assert.deepEqual(parseAnswer('C', [S(4)]).answers, [[2]]);
  assert.deepEqual(parseAnswer('Answer: b', [S(4)]).answers, [[1]]);
  assert.deepEqual(parseAnswer('1: B; 2: A, C', [S(3), M(3)]).answers, [[1], [0, 2]]);
  const r = parseAnswer('1: Z\n2: B', [S(3), S(3)]);
  assert.deepEqual(r.answers, [null, [1]]);
  assert.deepEqual(r.missing, [0]);
});

test('parse: single-choice with multiple letters keeps first; text fallback', () => {
  assert.deepEqual(extractLetters('B, C', S(4)), [1]);
  const q = { type: 'single', options: ['Paris', 'Berlin', 'Rome'] };
  assert.deepEqual(extractLetters('Berlin', q), [1]);
});

test('prompt: KB in stable system prompt, letters in user prompt', () => {
  const qs = [{ type: 'single', text: 'Capital of France?', options: ['Berlin', 'Paris'] }];
  const { system, user } = buildMessages(qs, { name: 'Geo', text: 'Paris is the capital of France.' }, { webSearch: true });
  assert.match(system, /KNOWLEDGE BASE \("Geo"\)/);
  assert.match(system, /web search/);
  assert.match(user, /1\. \[single/);
  assert.match(user, /B\) Paris/);
  const again = buildMessages([{ type: 'multi', text: 'x', options: ['a', 'b'] }], { name: 'Geo', text: 'Paris is the capital of France.' }, { webSearch: true });
  assert.equal(again.system, system, 'system prompt must not depend on questions (prompt caching)');
});

const KB = {
  name: 'bio',
  text: `The mitochondrion is the powerhouse of the cell and produces ATP through cellular respiration.
Chloroplasts perform photosynthesis in plant cells, converting light energy into chemical energy.
The nucleus contains the genetic material (DNA) of eukaryotic cells.
Ribosomes are responsible for protein synthesis.
Water boils at 100 degrees Celsius at sea level.
The Battle of Hastings took place in 1066.
Mitohondriji so energijske centrale celice. Kloroplasti opravljajo fotosintezo.
Whales are mammals. Sharks are fish, not mammals. Dolphins are mammals. Bats are mammals.`
};

test('algorithm: single choice', () => {
  const qs = [
    { type: 'single', text: 'Which organelle produces ATP?', options: ['Nucleus', 'Mitochondrion', 'Ribosome', 'Chloroplast'] },
    { type: 'single', text: 'Where does protein synthesis happen?', options: ['Ribosomes', 'Nucleus', 'Chloroplast'] },
    { type: 'single', text: 'In which year was the Battle of Hastings?', options: ['1066', '1215', '1492'] },
    { type: 'single', text: 'Katera organela opravlja fotosintezo?', options: ['Mitohondrij', 'Kloroplast', 'Jedro'] }
  ];
  const r = solveWithAlgorithm(qs, KB);
  assert.deepEqual(r.answers, [[1], [0], [0], [1]]);
});

test('algorithm: true/false and negation', () => {
  const qs = [
    { type: 'single', text: 'Water boils at 100 degrees Celsius at sea level.', options: ['True', 'False'] },
    { type: 'single', text: 'The nucleus performs photosynthesis in animal cells using sunlight energy.', options: ['True', 'False'] },
    { type: 'single', text: 'Which of the following is NOT a mammal?', options: ['Whale', 'Shark', 'Dolphin', 'Bat'] }
  ];
  const r = solveWithAlgorithm(qs, KB);
  assert.deepEqual(r.answers[0], [0]);
  assert.deepEqual(r.answers[1], [1]);
  assert.deepEqual(r.answers[2], [1]);
});

test('algorithm: multi select', () => {
  const qs = [{ type: 'multi', text: 'Which animals are mammals?', options: ['Whales', 'Sharks', 'Dolphins', 'Bats'] }];
  const r = solveWithAlgorithm(qs, KB);
  assert.deepEqual([...r.answers[0]].sort(), [0, 2, 3], JSON.stringify(r));
});

test('algorithm: adjacent-sentence facts are not mixed up, follow-up sentence still found', () => {
  const kb = { text: 'Whales and dolphins are mammals. Sharks and trout are fish. Penicillin changed medicine forever. It was discovered by Alexander Fleming in 1928.' };
  const r = solveWithAlgorithm([
    { type: 'multi', text: 'Which of these animals are mammals?', options: ['Whale', 'Shark', 'Dolphin', 'Trout'] },
    { type: 'single', text: 'Who discovered penicillin?', options: ['Louis Pasteur', 'Alexander Fleming', 'Marie Curie'] }
  ], kb);
  assert.deepEqual([...r.answers[0]].sort(), [0, 2], r.raw);
  assert.deepEqual(r.answers[1], [1], r.raw);
});

test('algorithm: needs KB', () => {
  assert.throws(() => solveWithAlgorithm([S(2)], null), /knowledge base/);
});
