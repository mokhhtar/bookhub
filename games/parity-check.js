/*
 * games/parity-check.js — does the browser engine still match engine.py?
 *
 *     node games/parity-check.js
 *
 * WHY. "The Python engine and the JavaScript engine must stay identical" is
 * a hard constraint of this game and was, until this file, enforced only by
 * remembering to edit both. The failure mode is silent: the game gets worse
 * and every offline measurement keeps saying it is fine, because the
 * measurements run against the Python side.
 *
 * HOW. scripts/akinator/parity_trace.py plays one fixed, scripted game
 * through the real Engine class — fed from the SHIPPED artifacts, not the
 * corpus, so both sides start from identical data — and writes every
 * question asked plus a belief checksum per turn to
 * games/data/akinator/parity_trace.json. This drives the page's engine
 * through the same script and compares.
 *
 * The page is a Jekyll template full of DOM work, so this stubs the few
 * browser things the engine touches (document, fetch) rather than running a
 * real browser: the thing under test is the arithmetic, and a headless
 * browser would add minutes and a dependency to test the same numbers.
 *
 * Exit code 0 = identical, 1 = a divergence (printed).
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data', 'akinator');
const PAGE = path.join(ROOT, 'book-mind-reader.html');
const TRACE = path.join(DATA, 'parity_trace.json');

// Belief values are compared as a checksum, not per-book, and 1e-9 is the
// tolerance. Python and JavaScript use different libm implementations, so
// Math.log and math.log may differ in the last ulp; after twenty
// multiplicative updates that drift accumulates. Anything above this is a
// real algorithmic difference, not floating point.
const TOLERANCE = 1e-9;

function extractScript(html) {
  // \r?\n, not \n: the repo has Prettier-on-save and git autocrlf, so this
  // file is CRLF on disk. Python's text mode hides that and Node's does not,
  // which is exactly how a "works in the generator, fails in the checker"
  // difference gets in.
  const m = html.match(/<script>\r?\n([\s\S]*)\r?\n<\/script>/);
  if (!m) { throw new Error('no <script> block found in ' + PAGE); }
  return m[1];
}

// The engine reads four files by URL and writes to four elements by id.
// Nothing else about the browser is touched before a question is asked.
function makeSandbox() {
  const el = () => ({
    textContent: '', innerHTML: '',
    addEventListener() {}, querySelector() { return null; },
    querySelectorAll() { return []; }, remove() {}, classList: { add() {} }
  });

  const sandbox = {
    console,
    setTimeout,
    // The page reads these for the owner-only transcript switch. Stubbed
    // rather than left undefined so this harness keeps simulating a browser
    // accurately as the page grows — an under-stubbed sandbox fails in a way
    // that looks like an engine bug.
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
      getElementById: el,
      createElement: el,
      // The page binds its keyboard shortcuts on the document at load, so
      // this is reached before a single question is asked. A no-op is the
      // whole truth here: the harness drives the engine through its test
      // hook and never presses a key, and the shortcut only forwards a
      // click to a button that would have been clicked anyway.
      addEventListener() {},
      body: { appendChild() {}, removeChild() {} }
    },
    fetch(url) {
      // BASE is a Jekyll expression ({{ "/games/data/akinator/" |
      // relative_url }}) and nothing renders it outside a site build, so the
      // requested URL is that literal template with a filename glued on the
      // end. Take the trailing filename rather than splitting on '/'.
      const m = String(url).match(/([\w-]+\.(?:json|bin))$/);
      if (!m) { return Promise.resolve({ ok: false, status: 404 }); }
      const file = path.join(DATA, m[1]);
      if (!fs.existsSync(file)) {
        return Promise.resolve({ ok: false, status: 404 });
      }
      const buf = fs.readFileSync(file);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(buf.toString('utf8'))),
        arrayBuffer: () => Promise.resolve(
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
      });
    }
  };
  sandbox.window = sandbox;
  sandbox.window.__MR_TEST__ = true;
  return sandbox;
}

// Byte-for-byte mirror of parity_trace.overrides_fingerprint(). NOT
// JSON.stringify: it and json.dumps disagree about numbers (a float 1.0 is
// "1" here and "1.0" there), so a fingerprint built on either one would
// report a stale fixture on every single run. Six fixed decimals is the one
// format both languages are guaranteed to agree on. Edit the two together.
function overridesFingerprint(overrides) {
  const parts = [];
  for (const key of Object.keys(overrides).sort()) {
    const cells = overrides[key] || {};
    for (const q of Object.keys(cells).sort()) {
      const p = cells[q];
      const value = (typeof p === 'number' && isFinite(p)) ? p.toFixed(6) : '?';
      parts.push(key + '|' + q + '|' + value);
    }
  }
  return parts.join('\n');
}

function beliefChecksum(belief) {
  // Must match parity_trace.py's: sum(b * log1p(i + 1)).
  let s = 0;
  for (let i = 0; i < belief.length; i++) { s += belief[i] * Math.log1p(i + 1); }
  return s;
}

async function main() {
  if (!fs.existsSync(TRACE)) {
    console.error('No parity_trace.json. Generate it first:\n' +
      '  python scripts/akinator/parity_trace.py --out ' + TRACE);
    process.exit(1);
  }
  const trace = JSON.parse(fs.readFileSync(TRACE, 'utf8'));

  // A STALE FIXTURE IS NOT A DIVERGENCE. The nightly /akinator/sync appends
  // newly published books to matrix.bin and meta.json, which changes the
  // prior, the belief vector and therefore every checksum in the trace —
  // through no fault of either engine. Reporting that as "the engines have
  // drifted" would be the same conflation this project keeps having to fix
  // (a 429 is not a measurement; an unharvested description is not "no
  // magic"). So it is its own state, with its own instruction.
  const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
  const from = trace.generated_from || {};
  if (meta.books !== from.books || meta.question_hash !== from.question_hash) {
    console.error('STALE FIXTURE — the artifacts changed since the trace was recorded.');
    console.error(`  trace: ${from.books} books, question_hash ${from.question_hash}`);
    console.error(`  now:   ${meta.books} books, question_hash ${meta.question_hash}`);
    console.error('This is expected after a nightly sync or a rebuild. Regenerate:');
    console.error('  python scripts/akinator/parity_trace.py --out ' + TRACE);
    console.error('It does NOT mean the engines disagree — that check has not run.');
    process.exit(2);   // 2, not 1: "could not test", not "test failed"
  }

  // THE THIRD INPUT THAT MOVES UNDERNEATH THE FIXTURE, and the one that moves
  // most often. The page applies overrides.json to pYesCache on every load,
  // and since 2026-08-23 so does parity_trace.py — before that it did not,
  // and the mismatch was reported here as 19 belief divergences and then a
  // QUESTION MISMATCH, on engines that agreed perfectly once both were given
  // the same file. Now that the trace is recorded WITH those cells, every
  // cell the owner teaches from the admin page invalidates it, so the digest
  // has to be compared or the same lie comes back by the other door.
  const OVERRIDES = path.join(DATA, 'overrides.json');
  let liveOverrides = {};
  if (fs.existsSync(OVERRIDES)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of Object.keys(parsed)) {
          const v = parsed[k];
          if (v && typeof v === 'object' && !Array.isArray(v)) { liveOverrides[k] = v; }
        }
      }
    } catch (e) { liveOverrides = {}; }
  }
  const liveDigest = crypto.createHash('sha256')
    .update(overridesFingerprint(liveOverrides), 'utf8').digest('hex').slice(0, 16);
  if (from.overrides_digest !== undefined && from.overrides_digest !== liveDigest) {
    const liveCells = Object.keys(liveOverrides)
      .reduce((n, k) => n + Object.keys(liveOverrides[k]).length, 0);
    console.error('STALE FIXTURE — overrides.json changed since the trace was recorded.');
    console.error(`  trace: ${from.overrides_cells} taught cell(s), digest ${from.overrides_digest}`);
    console.error(`  now:   ${liveCells} taught cell(s), digest ${liveDigest}`);
    console.error('Expected after the nightly drain or any Taught-tab verdict. Regenerate:');
    console.error('  python scripts/akinator/parity_trace.py --out ' + TRACE);
    console.error('It does NOT mean the engines disagree — that check has not run.');
    process.exit(2);
  }

  const sandbox = makeSandbox();
  vm.createContext(sandbox);
  vm.runInContext(extractScript(fs.readFileSync(PAGE, 'utf8')), sandbox);

  const engine = sandbox.window.__mindReaderEngine;
  if (!engine) {
    console.error('window.__mindReaderEngine missing — is the __MR_TEST__ ' +
                  'hook still in book-mind-reader.html?');
    process.exit(1);
  }

  // The popularity prior arrives with books.json. Answering before it lands
  // plays a different game on a uniform prior — the same race a real player
  // never loses because they are still reading question one.
  for (let i = 0; i < 200 && !engine.ready(); i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  if (!engine.ready()) {
    console.error('books.json never arrived in the sandbox');
    process.exit(1);
  }
  engine.start();
  await new Promise(r => setTimeout(r, 50));   // let applyPriorWhenReady run

  let failures = 0;
  console.log(`Comparing ${trace.turns.length} turns ` +
              `(question_hash ${trace.generated_from.question_hash})\n`);

  for (let t = 0; t < trace.turns.length; t++) {
    const want = trace.turns[t];
    const qi = engine.nextQuestion();
    if (qi === null) {
      console.log(`turn ${t + 1}: JS ran out of questions, Python asked ` +
                  `${want.question}`);
      failures++;
      break;
    }
    const qid = engine.questionId(qi);
    if (qid !== want.question) {
      console.log(`turn ${t + 1}: QUESTION MISMATCH\n` +
                  `    python: ${want.question}\n    js:     ${qid}`);
      failures++;
      break;   // beliefs diverge from here on; one report is enough
    }
    engine.update(qi, want.answer);

    const got = beliefChecksum(engine.belief());
    const diff = Math.abs(got - want.belief_checksum);
    const ok = diff <= TOLERANCE;
    if (!ok) { failures++; }
    console.log(`turn ${String(t + 1).padStart(2)}  ${ok ? 'ok  ' : 'FAIL'}  ` +
                `${qid.padEnd(24)} ${want.answer.padEnd(13)} ` +
                `diff ${diff.toExponential(2)}`);
  }

  // The re-check, as its own comparison after the scripted game. Both halves
  // are checked even when Python found nothing to re-check: agreeing that no
  // answer is contradicted is a real result, and it is the one that would go
  // silently untested if this only ran when the feature fired.
  const rc = trace.recheck;
  if (rc && !failures) {
    if (typeof engine.contradictedQuestion !== 'function') {
      console.log('recheck  FAIL  the page exposes no contradictedQuestion() — ' +
                  'is the __MR_TEST__ hook still in step with engine.py?');
      failures++;
    } else {
      const jsQ = engine.contradictedQuestion();
      if (jsQ !== rc.question) {
        console.log(`recheck  FAIL  CONTRADICTION MISMATCH\n` +
                    `    python: ${rc.question}\n    js:     ${jsQ}`);
        failures++;
      } else if (rc.question === null) {
        console.log('recheck  ok    both engines found nothing contradicted');
      } else {
        engine.revise(rc.question, rc.answer);
        const got = beliefChecksum(engine.belief());
        const diff = Math.abs(got - rc.belief_checksum);
        const ok = diff <= TOLERANCE;
        if (!ok) { failures++; }
        console.log(`recheck  ${ok ? 'ok  ' : 'FAIL'}  ` +
                    `${rc.question.padEnd(24)} ${String(rc.answer).padEnd(13)} ` +
                    `diff ${diff.toExponential(2)}`);
      }
    }
  }

  console.log();
  if (failures) {
    console.log(`PARITY FAILED — ${failures} divergence(s).`);
    console.log('The engines have drifted. Fix before shipping: an offline ' +
                'measurement no longer describes the live game.');
    process.exit(1);
  }
  console.log('PARITY OK — both engines ask the same questions and hold the ' +
              'same beliefs.');
}

main().catch(err => { console.error(err); process.exit(1); });
