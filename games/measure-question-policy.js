/*
 * Resource-bounded paired A/B test for semantic question ordering.
 *
 * Reads the shipped artifacts and runs the browser engine itself. Both arms
 * share the same typed-array matrix and per-game random seed; only the old
 * "ask first, suppress later" ordering is toggled. Run Node with an explicit
 * heap cap, for example:
 *
 *   node --max-old-space-size=256 games/measure-question-policy.js \
 *     --games 80 --pool 300 --max-books 6000 --max-questions 25
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'akinator');
const PAGE = path.join(ROOT, 'book-mind-reader.html');

function numberArg(name, fallback, required) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) {
    if (required) { throw new Error('--' + name + ' is required'); }
    return fallback;
  }
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value)) { throw new Error('--' + name + ' must be a number'); }
  return value;
}

function stringArg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? fallback : String(process.argv[i + 1]);
}

function extractScript(html) {
  const match = html.match(/<script>\r?\n([\s\S]*)\r?\n<\/script>/);
  if (!match) { throw new Error('page has no script block'); }
  return match[1];
}

function makeSandbox() {
  const element = () => ({
    textContent: '', innerHTML: '', value: '', style: {},
    addEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, remove() {}, focus() {},
    appendChild() {}, classList: { add() {}, remove() {} }
  });
  const sandbox = {
    console,
    setTimeout,
    location: { search: '' },
    localStorage: {
      _v: {},
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._v, k) ? this._v[k] : null; },
      setItem(k, v) { this._v[k] = String(v); },
      removeItem(k) { delete this._v[k]; }
    },
    navigator: {},
    URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
    document: {
      getElementById: element,
      createElement: element,
      addEventListener() {},
      body: { appendChild() {}, removeChild() {} }
    },
    fetch(url) {
      const match = String(url).match(/([\w-]+\.(?:json|bin))$/);
      if (!match) { return Promise.resolve({ ok: false, status: 404 }); }
      const file = path.join(DATA, match[1]);
      if (!fs.existsSync(file)) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      const buffer = fs.readFileSync(file);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(buffer.toString('utf8'))),
        arrayBuffer: () => Promise.resolve(
          buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
      });
    }
  };
  sandbox.window = sandbox;
  sandbox.window.__MR_TEST__ = true;
  return sandbox;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function conditionSatisfied(condition, answers) {
  if (!condition || typeof condition !== 'object') { return false; }
  if (Array.isArray(condition.any)) {
    return condition.any.length > 0 && condition.any.some(c => conditionSatisfied(c, answers));
  }
  if (Array.isArray(condition.all)) {
    return condition.all.length > 0 && condition.all.every(c => conditionSatisfied(c, answers));
  }
  const actual = answers[condition.question];
  return actual === condition.answer || actual === 'probably_' + condition.answer;
}

function exactMcNemar(b, c) {
  const n = b + c;
  if (!n) { return 1; }
  const upto = Math.min(b, c);
  let probability = Math.pow(0.5, n), term = probability, tail = term;
  for (let k = 1; k <= upto; k++) {
    term *= (n - k + 1) / k;
    tail += term;
  }
  return Math.min(1, 2 * tail);
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function main() {
  const games = numberArg('games', 0, true);
  const poolSize = numberArg('pool', 0, true);
  const maxBooks = numberArg('max-books', 0, true);
  const maxQuestions = numberArg('max-questions', 0, true);
  const maxGuesses = numberArg('max-guesses', 3, false);
  const seed = numberArg('seed', 20260919, false);
  const noise = numberArg('noise', 0.10, false);
  const missRate = numberArg('miss-rate', 0.25, false);
  const includeTitle = stringArg('include-title', 'The Prince');

  const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
  const questions = JSON.parse(fs.readFileSync(path.join(DATA, 'questions.json'), 'utf8'));
  const books = JSON.parse(fs.readFileSync(path.join(DATA, 'books.json'), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(DATA, 'question_policy.json'), 'utf8'));
  const matrix = fs.readFileSync(path.join(DATA, 'matrix.bin'));
  const chars = JSON.parse(fs.readFileSync(path.join(DATA, 'characters.json'), 'utf8'));
  if (meta.books > maxBooks) {
    throw new Error(`refusing ${meta.books} books; --max-books is ${maxBooks}`);
  }
  const pool = Math.min(poolSize, books.length);
  if (games <= 0 || games > pool || maxQuestions <= 0) {
    throw new Error('games/pool/max-questions bounds are invalid');
  }

  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext(extractScript(fs.readFileSync(PAGE, 'utf8')), sandbox);
  const engine = sandbox.window.__mindReaderEngine;
  for (let i = 0; i < 200 && !engine.ready(); i++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (!engine.ready()) { throw new Error('browser engine did not become ready'); }
  await new Promise(resolve => setTimeout(resolve, 100));

  const qIndex = Object.fromEntries(questions.map((q, i) => [q.id, i]));
  const policyRows = policy.questions || {};
  const charSets = books.map((_book, i) => {
    const ids = (chars.books && chars.books[i]) || [];
    return new Set(ids.map(id => chars.tokens[id]));
  });

  function packedState(bookIndex, questionIndex) {
    const offset = bookIndex * meta.bytes_per_row + (questionIndex >> 2);
    return (matrix[offset] >> ((questionIndex & 3) * 2)) & 3;
  }

  function answer(bookIndex, questionId, rng) {
    if (questionId.startsWith('char:')) {
      const token = questionId.slice(5), known = charSets[bookIndex];
      if (!known.size) { return rng() < 0.5 ? 'unknown' : 'no'; }
      if (known.has(token)) { return rng() < noise ? 'unknown' : 'yes'; }
      return 'no';
    }
    const index = qIndex[questionId];
    if (index === undefined) { return 'unknown'; } // cold question
    const state = packedState(bookIndex, index);
    if (state === 2) { return 'unknown'; }
    if (state === 3) { return 'no'; }
    let truth = state === 1;
    if (!truth && rng() < missRate) { truth = true; }
    if (rng() < noise) {
      return ['probably_yes', 'unknown', 'probably_no'][Math.floor(rng() * 3)];
    }
    if (truth) { return rng() > 0.15 ? 'yes' : 'probably_yes'; }
    return rng() > 0.20 ? 'no' : 'probably_no';
  }

  function play(bookIndex, legacy) {
    engine.setLegacyOrdering(legacy);
    engine.start(0);
    const rng = mulberry32((seed * 1000003 + bookIndex) >>> 0);
    const answers = {};
    let asked = 0, guesses = 0, violations = 0;

    function offer() {
      const target = engine.guessTarget();
      if (!target) { return false; }
      guesses++;
      if (engine.guessMatches(target, bookIndex)) { return true; }
      engine.rejectTarget(target);
      return guesses >= maxGuesses ? false : null;
    }

    while (asked < maxQuestions) {
      if (engine.shouldGuess() && guesses < maxGuesses) {
        const result = offer();
        if (result !== null) { return { won: result, asked, violations }; }
      }
      if (asked === maxQuestions - 1 && guesses < maxGuesses) {
        const contradicted = engine.contradictedQuestion();
        if (contradicted !== null) {
          const response = answer(bookIndex, contradicted, rng);
          engine.revise(contradicted, response);
          answers[contradicted] = response;
          asked++;
          continue;
        }
      }
      const index = engine.nextQuestion();
      if (index === null) { break; }
      const id = engine.questionId(index);
      const entry = policyRows[id];
      if (entry && entry.applies_if && !conditionSatisfied(entry.applies_if, answers)) {
        violations++;
      }
      const response = answer(bookIndex, id, rng);
      engine.update(index, response);
      answers[id] = response;
      asked++;
    }
    while (guesses < maxGuesses) {
      const result = offer();
      if (result !== null) { return { won: result, asked, violations }; }
    }
    return { won: false, asked, violations };
  }

  const targetRng = mulberry32(seed);
  const candidates = Array.from({ length: pool }, (_v, i) => i);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(targetRng() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  const targets = candidates.slice(0, games);
  const named = books.findIndex((book, i) => i < pool && book.t === includeTitle);
  if (named >= 0 && !targets.includes(named)) { targets[targets.length - 1] = named; }

  const baseline = [], treatment = [];
  for (let i = 0; i < targets.length; i++) {
    baseline.push(play(targets[i], true));
    treatment.push(play(targets[i], false));
    if ((i + 1) % 10 === 0 || i + 1 === targets.length) {
      console.log(`completed ${i + 1}/${targets.length} paired games`);
    }
  }

  const oldWins = baseline.filter(row => row.won).length;
  const newWins = treatment.filter(row => row.won).length;
  const b = baseline.filter((row, i) => row.won && !treatment[i].won).length;
  const c = baseline.filter((row, i) => !row.won && treatment[i].won).length;
  const oldQ = baseline.map(row => row.asked), newQ = treatment.map(row => row.asked);
  const sum = values => values.reduce((a, b) => a + b, 0);
  const prince = named >= 0 ? targets.indexOf(named) : -1;
  console.log(JSON.stringify({
    engine: 'shipped browser typed-array engine',
    books: meta.books,
    questions: meta.questions,
    games,
    target_pool: pool,
    max_questions: maxQuestions,
    baseline: {
      wins: oldWins,
      success_percent: +(100 * oldWins / games).toFixed(2),
      mean_questions: +(sum(oldQ) / games).toFixed(2),
      median_questions: median(oldQ),
      semantic_violations: sum(baseline.map(row => row.violations))
    },
    policy: {
      wins: newWins,
      success_percent: +(100 * newWins / games).toFixed(2),
      mean_questions: +(sum(newQ) / games).toFixed(2),
      median_questions: median(newQ),
      semantic_violations: sum(treatment.map(row => row.violations))
    },
    delta_success_points: +(100 * (newWins - oldWins) / games).toFixed(2),
    discordant: { policy_lost: b, policy_won: c },
    mcnemar_exact_p: +exactMcNemar(b, c).toFixed(6),
    mean_paired_question_delta: +(sum(newQ.map((q, i) => q - oldQ[i])) / games).toFixed(3),
    included_title: prince >= 0 ? {
      title: includeTitle,
      baseline: baseline[prince],
      policy: treatment[prince]
    } : null
  }, null, 2));
}

main().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
