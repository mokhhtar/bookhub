/*
 * games/play-bot.js — play the SHIPPED mind reader, as a reader would.
 *
 *     node games/play-bot.js --title "Dune"
 *     node games/play-bot.js --pick --games 8 --out takes.json
 *     node games/play-bot.js --title "Dune" --headed --offline
 *     node games/play-bot.js --title "Piranesi" --offline --fresh-data
 *     node games/play-bot.js --title "Dune" --offline --video takes --mp4
 *
 * WHAT THIS IS FOR. A recorded demo of the game needs a game worth recording:
 * one a viewer can follow, and one that ENDS IN A WIN. Hunting for such a take
 * by hand, game after game, is what this replaces. It finds the take and writes
 * it down; a later pass replays the take on camera.
 *
 * WHY A BROWSER AND NOT engine.py. simulate.py already plays thousands of games
 * against the Python engine, and for statistics that is the right tool and this
 * is not. But the questions in this transcript have to be the questions the
 * PAGE asks, in the page's order, or the replay desynchronises at the first
 * divergence — and only the page can say what the page will ask. The cost is
 * about twenty seconds a game, nothing at the handful of games a video needs,
 * and in exchange a take is evidence the shipped artifacts really do produce
 * that game, which no offline run can promise.
 *
 * WHY IT CLICKS RATHER THAN CALLING __mindReaderEngine. parity-check.js drives
 * that hook because the thing under test there is the arithmetic. Here the
 * thing under test is the game a person plays, so this presses the same buttons
 * a person presses and waits out the same PRESS_MS the page makes them wait.
 *
 * HOW THE PLAYER ANSWERS, AND WHY IT IS NOT CIRCULAR. Groq is given the title
 * and the author and nothing else — never the book's row in the matrix, never
 * the belief, never the candidate list. It answers from what it knows about the
 * book, the way a person does, and it disagrees with the catalogue in the
 * places a person disagrees with it. That disagreement is the realistic part:
 * see simulate.py's --miss-rate note for why a simulated player who always
 * agrees with library metadata measures nothing at all.
 *
 * It is also told that "I don't know" is a real answer and is wanted whenever
 * it is not sure. That is not politeness. The game offers the answer, honest
 * players use it, and a model bluffing through twenty questions would record a
 * take no real player could reproduce.
 *
 * THE ANSWER CACHE IS THE POINT, not an optimisation. Keyed on (book, question
 * text), it makes the player DETERMINISTIC: replay the same book and every
 * answer is the one already recorded. The camera pass then follows the take
 * exactly and never stalls on a network call — a three second wait while Groq
 * thinks is dead air in a video, and a failed call is a ruined take. Collapsing
 * the call count is only a side effect; the opening questions are the same in
 * nearly every game.
 *
 * SERVED FROM _site, NOT THE SOURCE TREE. The page is a Jekyll template and its
 * data files resolve against the built site, so this serves ../_site and
 * refuses to run when that build is older than the page source. A take recorded
 * against a stale build is a take of the wrong game.
 *
 * --fresh-data narrows that one step further: games/data/akinator/* is
 * proxied live from GitHub instead of from _site, because that directory is
 * the one part of a build this checkout does not actually own -- the admin
 * worker and the nightly sync both commit straight to GitHub, and this
 * checkout only catches up on the next `git pull`. Without it, a take taken
 * right after an admin edit can play the OLD game and look like the edit
 * never landed, when it landed fine and this machine just had not asked yet.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

// The conversion and the safe-zone geometry are shared with studio/server.js
// on purpose: a desk that drew its guides somewhere other than where the
// converter padded to would be worse than a desk with no guides.
const videoTools = require('./video-tools');
// The browser, the static server and the camera. See that module for why
// these stopped living in this file.
const kit = require('./record-kit');

const ROOT = path.join(__dirname, '..');                 // the bookhub repo
const BUILT_SITE = path.join(ROOT, '_site');
const PAGE_SOURCE = path.join(__dirname, 'book-mind-reader.html');
const BOOKS_JSON = path.join(__dirname, 'data', 'akinator', 'books.json');
// --fresh-data proxies this one directory straight from the branch GitHub
// Pages itself deploys from, bypassing this checkout entirely. See serve().
const FRESH_DATA_REPO = 'mokhhtar/bookhub';
const FRESH_DATA_BRANCH = 'main';
const QUESTIONS_JSON = path.join(__dirname, 'data', 'akinator', 'questions.json');
const GAME_PATH = '/games/mind-reader/';

// The player's memory lives with the other akinator build data in the API repo,
// NOT under games/ — it is a record of what a model said about books, not
// something the site serves.
const API_REPO = path.join(ROOT, '..', 'bookhub-api');
const CACHE_PATH = path.join(API_REPO, 'data', 'akinator_player_cache.json');

// The five the page offers, in its own order — the index is what data-answer
// holds. Mirrored from ANSWERS in book-mind-reader.html; a sixth answer there
// without one here is an answer this player could never give.
const ANSWER_KEYS = ['yes', 'probably_yes', 'unknown', 'probably_no', 'no'];

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL_DEFAULT = 'openai/gpt-oss-120b';

// The one directory this checkout does not own: books.json, overrides.json and
// the rest are committed straight to GitHub by the admin worker and the nightly
// sync, so --fresh-data serves them from there instead of from _site. See
// record-kit's serve() for the incident that produced it.
const FRESH_DATA_PROXY = {
  prefix: '/games/data/akinator/',
  repo: FRESH_DATA_REPO,
  branch: FRESH_DATA_BRANCH
};

function checkBuild() {
  kit.requireFreshBuild(
    path.join(BUILT_SITE, 'games', 'mind-reader', 'index.html'), PAGE_SOURCE, ROOT);
}

// The page's own PRESS_MS, read rather than repeated: the two drifting apart
// would show up as a race that only bites on a slow machine.
function readPressMs() {
  const m = fs.readFileSync(PAGE_SOURCE, 'utf8').match(/var PRESS_MS\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 190;
}

// ── the player ─────────────────────────────────────────────────────────────
// DOES THIS GUESS NAME THE BOOK THE PLAYER IS HOLDING? Not a string equality
// question, because the game deliberately guesses SERIES as well as volumes —
// renderGuess prints the series name with "· the series" under it, and a
// reader thinking of Philosopher's Stone who is shown "Harry Potter" says yes.
//
// Measured before this existed: an exact match rejected "Harry Potter", and
// because rejecting a series zeroes every volume in it (see the mr-no handler)
// the bot destroyed its own answer and played on to a loss it had already won.
// A take is worthless if the player refuses the right book.
//
// The leading-phrase rule only runs FORWARD — offered inside target, never the
// reverse — so "Dune Messiah" offered to someone holding "Dune" is still a no.
// One-word matches need the page's own series marker, so a book called "It"
// cannot claim "It Ends with Us".
// A SUBTITLE IS NOT A DIFFERENT BOOK. Measured 2026-08-28: the game offered
// "Sapiens" to a player holding "Sapiens: A Brief History of Humankind" and the
// word-count guard rejected it, because the guard was written for "It" vs "It
// Ends with Us" and a one-word core title looks identical to that. Comparing
// the part before the colon settles both — "sapiens" == "sapiens", while "it"
// is still not the core of "it ends with us".
function coreTitle(s) {
  const stripped = String(s || '')
    .replace(/\((?:series|omnibus)\)\s*[\d\s–—-]*$/i, '')
    .split(/\s*[:—–]\s+/)[0];
  return normalize(stripped);
}

function acceptsGuess(offered, target, isSeries) {
  const o = coreTitle(offered);
  const t = normalize(target);
  const tCore = coreTitle(target);
  if (!o) { return false; }
  if (o === t || o === tCore) { return true; }
  if (!t.startsWith(o + ' ')) { return false; }        // word boundary, not substring
  return isSeries || o.split(' ').length >= 2;
}

function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// No dotenv anywhere in either repo — production reads Render's dashboard, and
// CLAUDE.md tells every local script to parse .env itself rather than assume a
// loader ran.
function loadEnv() {
  const file = path.join(API_REPO, '.env');
  if (!fs.existsSync(file)) { return; }
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

function prompt(title, author, question) {
  return `You are a reader who has read "${title}"${author ? ' by ' + author : ''}. \
Someone is playing a twenty-questions game to guess which book you are thinking \
of, and has asked:

  "${question}"

Answer about that book only, from what you actually know about it.

Reply with EXACTLY ONE of these five words and nothing else:
  yes            — you are confident the answer is yes
  probably_yes   — you lean yes but are not certain
  unknown        — you do not know, or the question does not apply
  probably_no    — you lean no but are not certain
  no             — you are confident the answer is no

"unknown" is a real answer and the game expects it. Use it whenever you are not \
sure rather than picking a side you cannot support — a confident wrong answer \
sends the game away from the book, which is worse than saying you do not know.`;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A 429 IS NOT AN ANSWER. Measured the hard way: a first batch of eight games
// took 130 rate-limit rejections across 240 calls, every one of them became a
// silent "unknown", and the run reported 1/8 won as though that were the
// engine's score. It was the score of a player who was gagged for 54% of its
// turns. Groq's free tier is generous per request and strict per minute, so
// the fix is to wait when told to and to COUNT what still failed — the count
// is reported per game, because a take built on failures must never be
// mistaken for a take built on a reader's answers.
// One place that talks to the model, so the sheet, the single question and the
// book picker cannot drift apart in how they retry or how they fail.
async function callModel(content, model, stats, maxTokens) {
  const key = (process.env.GROQ_API_KEY || '').trim();
  if (!key) { return null; }

  const body = {
    model,
    messages: [{ role: 'user', content }],
    temperature: 0,          // the player has to be reproducible, not creative
    max_tokens: maxTokens || 500,
    // gpt-oss-120b is a REASONING model and will spend its entire output budget
    // thinking before writing a word — measured in extract_traits.py, where it
    // returned empty strings at finish_reason: length. One word needs none of it.
    reasoning_effort: 'low'
  };

  for (let attempt = 0; attempt < 6; attempt++) {
    let resp;
    try {
      resp = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000)
      });
    } catch (e) {
      console.log('    groq: ' + e.name + ': ' + e.message);
      return null;
    }
    if (resp.status === 400 && 'reasoning_effort' in body) {
      delete body.reasoning_effort;      // a model that rejects it gets one retry
      continue;
    }
    if (resp.status === 429) {
      // Retry-After is authoritative when Groq sends it; the doubling is only
      // for when it does not. Capped so one exhausted daily quota cannot hold
      // a batch open for an hour pretending to make progress.
      const header = Number(resp.headers.get('retry-after'));
      const wait = Math.min((header > 0 ? header : 2 ** attempt) * 1000, 30000);
      if (attempt === 0) { stats.limited++; }
      if (attempt >= 4) {
        console.log('    groq: rate limited, gave up after ' + (attempt + 1) + ' tries');
        return null;
      }
      await sleep(wait);
      continue;
    }
    if (!resp.ok) {
      console.log('    groq: HTTP ' + resp.status);
      return null;
    }
    const json = await resp.json();
    const choice = json.choices[0];
    const text = (choice.message.content || '').trim();
    if (!text && choice.finish_reason === 'length') {
      // Name the wall that was hit. "the model returned nothing" once sent a
      // session hunting a quota that was never the problem — this model is a
      // reasoning model and can spend the whole budget before writing a word.
      console.log('    model: hit max_tokens before writing anything ' +
                  '(reasoning ate the budget)');
      return null;
    }
    return text || null;
  }
  return null;
}

async function askGroq(title, author, question, model, stats) {
  const raw = await callModel(prompt(title, author, question), model, stats);
  if (raw === null) { return null; }
  const text = raw.toLowerCase();
  // Take the first answer word present. It usually returns the one word asked
  // for, but "probably_yes." or a wrapping sentence should not cost a turn.
  for (const k of ['probably_yes', 'probably_no', 'unknown', 'yes', 'no']) {
    if (new RegExp('\\b' + k + '\\b').test(text)) { return k; }
  }
  console.log('    groq: unparsable answer ' + JSON.stringify(text.slice(0, 60)));
  return null;
}

// ── the answer sheet ───────────────────────────────────────────────────────
// ALL 48 AT ONCE, and the reason is not only speed. Asked one at a time the
// model answers each question in ISOLATION: it says "no" to "published in the
// last 25 years" and then meets "written before 1970" with no memory of the
// first, and the two answers need not agree. Contradictory answers are exactly
// what walks the engine away from the book, so an inconsistent player measures
// the engine against a reader who does not exist.
//
// One call also removes the rate limit as a category rather than handling it:
// 240 calls for eight games became eight. The 429 storm that made this
// script's first batch meaningless cannot recur at this size.
//
// The sheet fills the SAME per-question cache the one-at-a-time path uses, so
// nothing downstream changes and the two modes are interchangeable.
async function askSheet(title, author, model, stats) {
  const questions = JSON.parse(fs.readFileSync(QUESTIONS_JSON, 'utf8'));
  const list = questions.map((q, i) => (i + 1) + '. [' + q.id + '] ' + q.text).join('\n');

  const ask = `You are a reader who has read "${title}"${author ? ' by ' + author : ''}. \
Answer all of the following questions about that book.

${list}

Reply with ONE JSON object and nothing else — no prose, no code fence. Each key \
is the bracketed id, each value is exactly one of:
  "yes", "probably_yes", "unknown", "probably_no", "no"

Two rules that matter more than completeness:

1. BE CONSISTENT. These are answered together, so they must not contradict each \
other. If a book is not from the last 25 years it cannot also be from the last \
10; if the author is British the author is not American.

2. "unknown" IS A REAL ANSWER and is wanted. Use it whenever you are not sure \
rather than picking a side you cannot support. A confident wrong answer is \
worse than admitting the gap.`;

  const raw = await callModel(ask, model, stats, 4000);
  if (raw === null) { return null; }

  // The model is asked for bare JSON and usually obeys, but a stray fence or a
  // sentence in front should not cost the whole sheet.
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) { console.log('    sheet: no JSON in the reply'); return null; }
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) {
    console.log('    sheet: unparsable JSON (' + e.message.slice(0, 60) + ')');
    return null;
  }

  const byId = new Map(questions.map(q => [q.id, q.text]));
  const sheet = {};
  let unknown = 0;
  for (const [id, value] of Object.entries(parsed)) {
    const text = byId.get(id);
    if (!text) { continue; }                       // an id we never asked about
    const v = String(value).toLowerCase().trim();
    if (!ANSWER_KEYS.includes(v)) { continue; }    // never store an unusable one
    if (v === 'unknown') { unknown++; }
    sheet[normalize(text)] = v;
  }
  const got = Object.keys(sheet).length;
  console.log('  sheet: ' + got + '/' + questions.length + ' answered, ' +
              unknown + ' unknown');
  // A sheet that came back mostly empty is a failed call wearing a hat.
  if (got < questions.length * 0.6) {
    console.log('    sheet: too thin to trust, discarding');
    return null;
  }
  return sheet;
}

// CROSS-LANGUAGE TITLES CANNOT BE MATCHED AS STRINGS, and the catalogue is
// full of them: it offered "Män som hatar kvinnor" to a player holding "The
// Girl with the Dragon Tattoo" — the same book under its Swedish original —
// and every string rule on earth calls that a miss. books.json carries
// original-language titles for a large share of translated works, which is the
// same edition-vs-work confusion recorded elsewhere in this project.
//
// So the question goes to the model, exactly as it would go to a person: is
// this the book you are holding? That is NOT circular. The model is judging
// two titles against each other; it is not supplying a feature the engine
// infers from, and it never sees the matrix. Its verdict is recorded on the
// take so a human can audit every acceptance.
//
// Only consulted when the string rules already said no, so a plain match never
// costs a call and never risks an eager yes.
async function adjudicate(offered, title, author, model, stats) {
  const ask = `Someone is thinking of the book "${title}"${author ? ' by ' + author : ''}.

A guessing game has offered them: "${offered}"

Is that the SAME WORK — including a translation, the original-language title, \
a re-titled edition, or the series it belongs to?

It is NOT the same work if it is merely a sequel, another book by the same \
author, or a different book with a similar title.

Reply with one word: yes or no.`;

  const raw = await callModel(ask, model, stats, 300);
  if (raw === null) { return false; }
  return /^\W*yes\b/i.test(raw.trim());
}

class Player {
  constructor(title, author, model, offline) {
    // `fails` is the one that matters. Every failed call becomes an "unknown"
    // the player never chose, and a take with any of them is not a record of
    // how a reader answered.
    Object.assign(this, { title, author, model, offline, calls: 0, hits: 0, fails: 0, limited: 0 });
    this.cache = {};
    if (fs.existsSync(CACHE_PATH)) {
      try { this.cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (e) { /* start fresh */ }
    }
    this.bookKey = normalize(title + ' ' + (author || ''));
    this.book = this.cache[this.bookKey] || (this.cache[this.bookKey] = {});
  }

  async answer(question) {
    const key = normalize(question);
    if (key in this.book) { this.hits++; return this.book[key]; }
    if (this.offline) {
      // A miss in offline mode is a miss, not a licence to guess. "unknown" is
      // the honest stand-in and the game accepts it; the count is reported so a
      // thin cache is visible rather than silently shaping the take.
      return 'unknown';
    }
    this.calls++;
    const ans = await askGroq(this.title, this.author, question, this.model, this);
    if (ans === null) {
      // A failed call must never be written down. Recording it would make the
      // next run replay a NETWORK FAILURE as if it were the reader's view.
      this.fails++;
      return 'unknown';
    }
    this.book[key] = ans;
    return ans;
  }

  save() {
    // Sort by rebuilding the object, NOT by passing the key list as
    // JSON.stringify's second argument: that argument is the replacer, and an
    // array there is an allowlist applied at EVERY level — so book keys
    // survived and every question/answer pair under them was silently dropped.
    // The file looked plausible ({"dune frank herbert": {}}) while the cache
    // this whole script is built around held nothing.
    const sorted = {};
    for (const k of Object.keys(this.cache).sort()) {
      sorted[k] = Object.fromEntries(Object.entries(this.cache[k]).sort());
    }
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 1));
  }
}

// ── playing for the camera ─────────────────────────────────────────────────
// The measurement pass answers as fast as the page allows. A recorded one must
// not: a question answered in 40ms reads as a script, and the whole point of
// the recording is that it reads as a person.
//
// NO CURSOR IS DRAWN, and none is needed. Playwright's mouse moves a pointer
// INSIDE the browser while a screen recorder captures the operating system's,
// so a desktop take shows buttons lighting up under a cursor parked in the
// corner — the single clearest tell there is. Emulating a touch screen removes
// the problem rather than faking a solution: a phone has no cursor either, and
// the page already hides its keyboard hints at `pointer: coarse`.
//
// Taps, not clicks. With hasTouch a mouse click leaves :hover stuck on the
// answer just chosen, which on a phone layout looks plainly wrong. (The page's
// own hover rule is now gated behind `hover: hover`, so this is belt and
// braces — and it should stay that way, because the page is not this script's
// to depend on.)
const HUMAN = {
  readWordsPerMinute: 220,
  minRead: 900,
  hesitate: [300, 800],       // after reading, before reaching for an answer
  ponderEvery: 5,             // roughly one longer pause in this many questions
  ponder: [1200, 2600],
  afterTap: [400, 900],       // watching the card change before reading again
  beforeGuess: [1400, 2600],  // a guess deserves a beat; it is the moment
  typeDelay: [70, 160],       // ms between keystrokes, one value per title typed
  readResults: [700, 1700]    // scanning the search list before a pick lands
};

function between([lo, hi]) { return lo + Math.random() * (hi - lo); }

function readingTime(text) {
  const words = String(text).trim().split(/\s+/).length;
  return Math.max(HUMAN.minRead, (words / HUMAN.readWordsPerMinute) * 60000);
}

// ── one game ───────────────────────────────────────────────────────────────
async function play(page, player, base, pressMs, adjudicator, human, maxTurns = 60) {
  const turns = [];
  const guesses = [];

  // books.json carries the popularity prior, and a game begun before it lands
  // runs on the uniform prior — a different game. parity_trace.py waits on the
  // same race; a real player never loses it because they are still reading
  // question one.
  // Retried because a cold Chrome occasionally takes longer than 30s to make
  // its first request on this machine, and losing a whole batch to one slow
  // start wastes the Groq calls of every game after it.
  for (let attempt = 1; ; attempt++) {
    try {
      const [booksResponse] = await Promise.all([
        page.waitForResponse(r => r.url().endsWith('books.json'), { timeout: 30000 }),
        page.goto(base + GAME_PATH, { waitUntil: 'domcontentloaded' })
      ]);
      // HEADERS ARRIVING IS NOT THE BODY ARRIVING. waitForResponse resolves
      // on the 'response' event, which fires once headers are in — for a
      // local file server the two happen in the same instant, so this
      // distinction was invisible until --fresh-data introduced a real
      // upstream with real, sometimes double-digit-second latency (GitHub's
      // raw-content host, measured). The page has not run `books = b` until
      // the BODY finishes downloading and that .then() fires, and a bot
      // racing through questions at machine speed does not have a real
      // player's excuse of "still reading question one" — it can finish an
      // entire 30-question game and reach the give-up screen's search box
      // while `books` is still null, which searches nothing and reports
      // zero candidates for a book that is plainly in the catalogue. Found
      // exactly that way. `.body()` blocks on the actual bytes, which
      // `waitForResponse` alone does not.
      await booksResponse.body();
      break;
    } catch (e) {
      if (attempt >= 3) { throw e; }
      console.log('  (navigation attempt ' + attempt + ' timed out, retrying)');
    }
  }
  await page.waitForSelector('.mr-answer', { timeout: 30000 });

  for (let i = 0; i < maxTurns; i++) {
    if (await page.locator('#mr-again').count()) { break; }   // win or give-up

    const guess = page.locator('.mr-guess-title');
    if (await guess.count()) {
      const offered = (await guess.first().innerText()).trim();
      const sub = page.locator('.mr-guess-author');
      const isSeries = (await sub.count())
        ? /the series\s*$/i.test((await sub.first().innerText()).trim())
        : false;
      let right = acceptsGuess(offered, player.title, isSeries);
      let how = right ? 'title' : null;
      if (!right && adjudicator) {
        right = await adjudicator(offered);
        if (right) { how = 'same work (model)'; }
      }
      guesses.push({ offered, series: isSeries, accepted: right, matchedBy: how });
      console.log('  guess: ' + offered + (isSeries ? ' (the series)' : '') +
                  ' -> ' + (right ? 'YES [' + how + ']' : 'no, keep going'));
      const button = right ? '#mr-yes' : '#mr-no';
      if (human) {
        await page.waitForTimeout(between(HUMAN.beforeGuess));
        const box = await page.locator(button).boundingBox();
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(pressMs + between(HUMAN.afterTap));
      } else {
        await page.click(button);
        await page.waitForTimeout(pressMs + 80);
      }
      continue;
    }

    const q = page.locator('.mr-question');
    if (!(await q.count())) { break; }
    const text = (await q.first().innerText()).trim();
    const answer = await player.answer(text);
    turns.push({ question: text, answer });
    console.log('  ' + String(turns.length).padStart(2) + '. ' + text + '  ->  ' + answer);

    const target = '.mr-answer[data-answer="' + ANSWER_KEYS.indexOf(answer) + '"]';
    if (human) {
      await page.waitForTimeout(readingTime(text));
      await page.waitForTimeout(between(HUMAN.hesitate));
      // Not every turn is equal. One in five gets a real think, which is what
      // stops a fixed cadence from giving the whole thing away.
      if (Math.random() < 1 / HUMAN.ponderEvery) { await page.waitForTimeout(between(HUMAN.ponder)); }
      const box = await page.locator(target).boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(pressMs + between(HUMAN.afterTap));
    } else {
      await page.click(target);
      await page.waitForTimeout(pressMs + 80);
    }
  }

  // textContent, not innerText: #mr-count is styled `text-transform:
  // uppercase`, and innerText returns what is RENDERED — so the page's
  // 'Solved' arrives as 'SOLVED' and an === comparison scores a win as a
  // loss. That is exactly the failure this repo keeps naming: a measurement
  // that reports the opposite of what happened is worse than no measurement.
  // Lowercased as well, so a later styling change cannot undo this again.
  // ── after a loss, ask the page WHY ────────────────────────────────────────
  // A loss on its own says almost nothing. The give-up screen exists to split
  // it into the three cases that need entirely different work:
  //
  //   * the book is not known at all — nothing here is the engine's fault
  //     and no answer could have won it;
  //   * it IS known and nothing contradicted it — the engine ran out of
  //     questions that separate it from its neighbours;
  //   * it IS known and N answers disagreed with my notes — so either the
  //     row is wrong or the player was, and the page names which answers.
  //
  // Recording a loss without this is recording a symptom. explainMiss works it
  // out from the game that just happened and SENDS NOTHING, which is the only
  // reason automating it is safe.
  //
  // The "Tell it about this book" button is deliberately never pressed. That
  // one posts to the suggestion queue, and filling a review queue with a bot's
  // opinions is the owner's decision, not a side effect of measuring.
  //
  // TYPED, NOT FILLED, AND READ BEFORE IT IS TAPPED. .fill() writes the whole
  // title in one instant and used to be followed by a pick landing under a
  // second later — on a recording, that is the one moment nothing else in the
  // game gives away: every answer up to here was tapped at reading speed, and
  // then the title appeared fully formed and the next screen arrived before a
  // person could have read the list it appeared in.
  let diagnosis = null;
  const search = page.locator('#mr-search');
  if (await search.count()) {
    if (human) {
      await page.waitForTimeout(readingTime('Which book were you thinking of?'));
      await page.waitForTimeout(between(HUMAN.hesitate));
      await search.pressSequentially(player.title, { delay: between(HUMAN.typeDelay) });
      await page.waitForTimeout(between(HUMAN.readResults));
    } else {
      await search.fill(player.title);
      await page.waitForTimeout(500);
    }

    const picks = page.locator('#mr-results .mr-result--pick');
    const n = await picks.count();
    let clicked = false;
    for (let i = 0; i < n; i++) {
      // The <strong>, not the row: the row's innerText runs the title straight
      // into the author and year on one line ("Brave New World Aldous Huxley ·
      // 1932"), and comparing that to a title matches nothing. The markup puts
      // the title in its own element precisely so it can be read on its own.
      const strong = picks.nth(i).locator('strong');
      const label = (await strong.count())
        ? (await strong.first().innerText()).trim()
        : (await picks.nth(i).innerText()).split('\n')[0].trim();
      if (acceptsGuess(label, player.title, false)) {
        if (human) {
          await page.waitForTimeout(between(HUMAN.beforeGuess));
          const box = await picks.nth(i).boundingBox();
          await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(pressMs + between(HUMAN.afterTap));
        } else {
          await picks.nth(i).click();
          await page.waitForTimeout(500);
        }
        clicked = true;
        break;
      }
    }

    diagnosis = await page.evaluate(() => {
      const lead = document.querySelector('#mr-card .mr-guess-lead');
      const rows = [...document.querySelectorAll('#mr-card .mr-results .mr-result')]
        .map(li => li.innerText.replace(/\s+/g, ' ').trim())
        .filter(t => t && !/^None of these/.test(t) && !/^Not in the/.test(t));
      const notes = [...document.querySelectorAll('#mr-results .mr-result-note')]
        .map(li => li.innerText.trim()).join(' ');
      return {
        explained: !!(lead && /is one I know/.test(lead.innerText)),
        lead: lead ? lead.innerText.replace(/\s+/g, ' ').trim() : null,
        contradictions: rows,
        searchFoundNothing: /Not in the [\d,]+ books/.test(notes),
        // Counted in the page: `n` above is a Node-side variable and reading it
        // here is a ReferenceError inside the browser, not a closure.
        candidatesOffered: document.querySelectorAll('#mr-results .mr-result--pick').length
      };
    });
    diagnosis.matched = clicked;

    // NOTHING WAS CLICKED, so the take ends on a search box with a dropdown
    // hanging under it and the explanation screen never arrives. Said as loudly
    // as the missing-cover warning, and for the same reason: the run "succeeds"
    // and the file is unusable.
    //
    // This used to be reachable with a correct title. The page's give-up search
    // capped at eight rows BEFORE ranking them, so typing "Harry Potter"
    // offered the eight volumes and not the row called "Harry Potter" — 14
    // catalogue rows were unreachable from their own exact title. Fixed in
    // book-mind-reader.html; if this fires now, the cause is a different one
    // and worth reading rather than re-running.
    if (!clicked && human) {
      console.log('  ** NOTHING WAS PICKED on the give-up screen. The bot typed "' +
                  player.title + '" and no offered row matched it, so the ' +
                  'explanation screen never opened and this take ends on the ' +
                  'search box. Not publishable. **');
      if (diagnosis.candidatesOffered) {
        console.log('     ' + diagnosis.candidatesOffered + ' row(s) were offered — ' +
                    'the catalogue may hold this book under another title.');
      } else {
        console.log('     No rows at all. Titles under 3 characters and titles in ' +
                    'non-Latin scripts cannot be searched: normalize() keeps only ' +
                    '[a-z0-9], so the query is empty before it is used.');
      }
    }

    if (diagnosis.explained) {
      console.log('  why: ' + diagnosis.lead);
      if (!diagnosis.contradictions.length) {
        console.log('    nothing you said contradicted my notes — the engine ' +
                    'ran out of questions that separate it, not out of data.');
      } else {
        console.log('    ' + diagnosis.contradictions.length +
                    ' answer(s) disagreed with my notes:');
        diagnosis.contradictions.slice(0, 8).forEach(c => console.log('      · ' + c));
      }
    } else if (diagnosis.searchFoundNothing) {
      console.log('  why: no book with this title is known. Nothing the ' +
                  'player said could have won it.');
    } else {
      console.log('  why: ' + diagnosis.candidatesOffered + ' candidate(s) listed ' +
                  'but none was this book — it may be held under another title, ' +
                  'which the search cannot match.');
    }
  }

  if (human) {
    // THE WIN SCREEN IS THE PAYOFF, and the recording used to cut on the frame
    // it appeared. Worse, the cover is hotlinked from covers.openlibrary.org
    // — the one image on the page that is not served locally — so the take
    // ended on a grey rectangle where the book should be. Wait for it to
    // decode, then hold, so the shot is the answer rather than the moment
    // before it.
    await page.waitForFunction(() => {
      const img = document.querySelector('.mr-win img, .mr-guess img, #mr-card img');
      return !img || (img.complete && img.naturalWidth > 0);
    }, null, { timeout: 20000 }).catch(() => {});

    // AND THEN CHECK WHETHER IT IS ACTUALLY THERE. The wait above cannot tell
    // "this book has no cover" from "the cover request failed", because
    // wireCover() REMOVES the image on error — so both end as no <img> and the
    // wait resolves happily either way. On a slow connection the win screen's
    // -L cover (about 50 KB) is the one request most likely to fail, and it
    // fails at the exact moment the take is supposed to pay off. Silence here
    // means publishing a take with a hole in it.
    // Only on a WIN. The give-up explanation carries a line drawing, not a
    // cover, so on every loss this fired and said the take had a hole in it —
    // and a warning that cries wolf on half the runs is a warning nobody reads
    // by the time it is true.
    const cover = await page.evaluate(() => {
      const won = /solved/i.test((document.querySelector('#mr-count') || {}).textContent || '');
      const img = document.querySelector('#mr-card img');
      return { won: won, present: !!img, width: img ? img.naturalWidth : 0 };
    });
    if (cover.won && !cover.present) {
      console.log('  ** NO COVER on the end screen. Either this book has none, ' +
                  'or the request failed — wireCover() removes the image on error, ' +
                  'so the page cannot tell you which. Re-run before using this take. **');
    }
    // HOLD FOR AS LONG AS THE SCREEN TAKES TO READ, not a flat four seconds.
    // Four was measured against the WIN screen, which is a title, an author and
    // a cover. The loss screen is a different shape: a lead sentence plus a
    // list of every answer that disagreed with the catalogue, which is the most
    // text the game ever puts up at once — and it was getting the pause sized
    // for a book cover. The whole take is paced at reading speed; the one
    // screen that carries the explanation should not be the exception.
    const ending = await page.evaluate(() => {
      const card = document.querySelector('#mr-card');
      return card ? card.innerText.replace(/\s+/g, ' ').trim() : '';
    });
    await page.waitForTimeout(Math.min(14000, Math.max(4000, readingTime(ending))));
  }

  const status = ((await page.locator('#mr-count').textContent()) || '').trim();
  const state = status.toLowerCase();
  return {
    title: player.title,
    author: player.author,
    result: state === 'solved' ? 'won' : (state ? 'lost' : 'unfinished'),
    status,
    questions: turns.length,
    turns,
    guesses,
    // Present only on a loss, and the reason the loss is interpretable at all.
    diagnosis,
    cacheHits: player.hits,
    groqCalls: player.calls,
    failedCalls: player.fails,
    rateLimited: player.limited,
    // The flag a later reader needs, so a take cannot be picked for the camera
    // — or counted in a win rate — without knowing the player was gagged.
    trustworthy: player.fails === 0
  };
}

// ── choosing a book ────────────────────────────────────────────────────────
// A demo is watched by someone who has to recognise the answer, so takes are
// drawn from the most-read end of books.json rather than uniformly — and from
// the catalogue at all, because a book the table does not hold cannot be
// guessed and would only ever record a loss.
// THE FAIR PICKER. Drawing takes from books.json guarantees the game holds the
// answer, and a demo built that way gives a false impression of a product that
// is published on social media — the owner's call, and the right one: the page
// itself says losing gracefully is the point, not a fallback.
//
// So the model names the books and never sees the catalogue. Whether a title
// turns out to be in the table is then DISCOVERED by locate(), not arranged
// beforehand, and a take is never discarded for being a loss.
//
// Honest about its own bias: a model asked for famous books returns a
// canon-shaped, English-leaning list, which is not what a random reader thinks
// of either. It is independent of the game's data, which is the property that
// matters here — it is not a random sample of world literature, and no claim
// of one should be made from it.
async function pickFromModel(n, model, avoid, stats) {
  const seen = avoid.length ? '\n\nDo not name any of these, they are already ' +
    'recorded:\n' + avoid.map(t => '  - ' + t).join('\n') : '';

  const ask = `Name ${n} real, published books that ordinary readers know.

Spread them out: different decades, different genres, different countries, and \
do not put more than one book by the same author in the list. Include a mix of \
fiction and non-fiction the way a bookshelf does.

Every entry must be a real book with a real author — no textbooks, no manuals, \
no reports, no invented titles.${seen}

Reply with ONE JSON array and nothing else, each element:
  {"title": "...", "author": "..."}`;

  const raw = await callModel(ask, model, stats, 2000);
  if (raw === null) { return []; }
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) { console.log('  picker: no JSON array in the reply'); return []; }
  try {
    return JSON.parse(m[0])
      .filter(b => b && b.title)
      .map(b => ({ t: String(b.title).trim(), a: b.author ? String(b.author).trim() : null }));
  } catch (e) {
    console.log('  picker: unparsable JSON (' + e.message.slice(0, 60) + ')');
    return [];
  }
}

function pickBooks(n, pool, seed) {
  const rows = JSON.parse(fs.readFileSync(BOOKS_JSON, 'utf8')).slice(0, pool);
  let s = seed === null ? Math.floor(Math.random() * 2 ** 31) : seed;
  const rand = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, Math.min(n, rows.length));
}

// WHERE THE TITLE SITS, because that is what decides whether it can be won.
// The prior is the popularity column, so a book near the bottom of 5020 starts
// with almost no mass and needs overwhelming evidence to climb, while a
// better-read neighbour wins every near-tie. Measured on the first run of this
// script: "Dune" is row 4926 of 5020 (p=151) — BELOW four of its own sequels,
// because Open Library splits one work's readers across duplicate work keys —
// and a faithful 30-question game lost it to Asimov's Foundation. Without this
// line that reads as an engine failure, which it is not.
function locate(title) {
  const rows = JSON.parse(fs.readFileSync(BOOKS_JSON, 'utf8'));
  const want = normalize(title);
  const core = coreTitle(title);
  // Core titles too, or "Sapiens: A Brief History of Humankind" is reported
  // missing from a table that holds it as "Sapiens". Still an EXACT match on
  // one of the two forms — nothing fuzzy, because a false "we have it" is the
  // worse error and this repo already learned that at the suggestion gate.
  let i = rows.findIndex(r => normalize(r.t) === want);
  if (i < 0) { i = rows.findIndex(r => coreTitle(r.t) === core); }
  if (i < 0) {
    // NOT FOUND IS NOT ABSENT, and saying otherwise printed a flat lie: this
    // reported "The Girl with the Dragon Tattoo" missing from a table that
    // holds it as "Män som hatar kvinnor", and the game then won it in 17
    // questions. books.json carries original-language titles for much of its
    // translated stock, so a title lookup PROVES PRESENCE AND NEVER PROVES
    // ABSENCE — the same asymmetry this project already records about Open
    // Library work keys.
    console.log('catalogue: no row with this title. It may still be there ' +
                'under a translated or original-language title, so this is ' +
                'not proof the game cannot know it.');
    return null;
  }
  const pct = Math.round((1 - i / rows.length) * 100);
  console.log('catalogue: row ' + i + ' of ' + rows.length + ' (p=' + rows[i].p +
              ', top ' + pct + '%)' + (i > rows.length * 0.7
                ? ' — long tail, a loss here is the prior, not the engine' : ''));
  return rows[i];
}

function parseArgs(argv) {
  const a = { games: 1, pool: 300, seed: null, model: process.env.GROQ_MODEL || GROQ_MODEL_DEFAULT };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--pick') { a.pick = true; }
    else if (k === '--pick-model') { a.pickModel = true; }
    else if (k === '--sheet') { a.sheet = true; }
    else if (k === '--record') { a.record = true; }
    else if (k === '--width') { a.width = Number(argv[++i]); }
    else if (k === '--height') { a.height = Number(argv[++i]); }
    else if (k === '--live') { a.live = argv[++i]; }
    else if (k === '--video') { a.video = argv[++i] || 'takes'; }
    // Optional value, consumed only when it looks like a size — so `--mp4`
    // alone is the common case and `--mp4 720x1280` is there when it is not.
    else if (k === '--mp4') {
      a.mp4 = videoTools.MP4_DEFAULT_SIZE;
      const next = argv[i + 1];
      const m = next && /^(\d+)x(\d+)$/.exec(next);
      if (m) { a.mp4 = { width: Number(m[1]), height: Number(m[2]) }; i++; }
    }
    else if (k === '--mp4-bitrate') { a.mp4Bitrate = argv[++i]; }
    else if (k === '--mp4-fit') { a.mp4Fit = argv[++i]; }
    else if (k === '--headed') { a.headed = true; }
    else if (k === '--offline') { a.offline = true; }
    else if (k === '--fresh-data') { a.freshData = true; }
    else if (k === '--title') { a.title = argv[++i]; }
    else if (k === '--author') { a.author = argv[++i]; }
    else if (k === '--out') { a.out = argv[++i]; }
    else if (k === '--games') { a.games = Number(argv[++i]); }
    else if (k === '--pool') { a.pool = Number(argv[++i]); }
    else if (k === '--seed') { a.seed = Number(argv[++i]); }
    else { console.error('unknown option ' + k); process.exit(1); }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pick && !args.pickModel && !args.title) {
    console.error('give --title "…", --pick-model (the model names the books, ' +
                  'and whether the game holds them is discovered), or --pick ' +
                  '(draw from the catalogue, which guarantees it does)');
    process.exit(1);
  }
  if (args.pickModel && args.offline) {
    console.error('--pick-model needs the model; it cannot run --offline');
    process.exit(1);
  }
  if (args.mp4 && !args.video) {
    console.error('--mp4 converts what --video wrote; on its own there is no ' +
                  'file to convert. (An OBS take is already an MP4.)');
    process.exit(1);
  }

  loadEnv();
  if (!args.offline && !process.env.GROQ_API_KEY) {
    console.error('GROQ_API_KEY is not set (looked in the environment and ' +
                  path.join(API_REPO, '.env') + ').\n' +
                  '  Use --offline to play from the cache alone.');
    process.exit(1);
  }

  checkBuild();
  const pressMs = readPressMs();
  // --live records against the real site, so the address bar carries the real
  // domain. Local is the default because it is the only place a change can be
  // seen before it ships; the take that gets published should be --live.
  if (args.live && args.freshData) {
    console.error('--fresh-data is for the local server; --live already talks to the real site');
    process.exit(1);
  }
  const { base: localBase, server } = await kit.serve(
    BUILT_SITE, args.freshData ? { proxy: FRESH_DATA_PROXY } : {});
  const base = args.live || localBase;
  if (args.freshData) {
    console.log('  --fresh-data: games/data/akinator/* served live from '
      + FRESH_DATA_REPO + '@' + FRESH_DATA_BRANCH + ', not this checkout');
  }

  const stats = { limited: 0 };
  let books;
  if (args.pickModel) {
    const played = Object.keys(JSON.parse(
      fs.existsSync(CACHE_PATH) ? fs.readFileSync(CACHE_PATH, 'utf8') : '{}'));
    books = await pickFromModel(args.games, args.model, played, stats);
    if (!books.length) {
      console.error('the picker returned nothing — not playing a made-up list');
      process.exit(1);
    }
    console.log('picked: ' + books.map(b => b.t).join(' · '));
  } else if (args.pick) {
    books = pickBooks(args.games, args.pool, args.seed);
  } else {
    books = Array.from({ length: args.games }, () => ({ t: args.title, a: args.author }));
  }

  const pw = kit.loadPlaywright();
  const takes = [];
  const browser = await kit.launchBrowser(pw, args);

  try {
    for (let i = 0; i < books.length; i++) {
      const { t: title, a: author } = books[i];
      console.log('\n[' + (i + 1) + '/' + books.length + '] ' + title + ' — ' + author);

      // The owner starts the recorder, not the script: everything after the
      // countdown is in frame, so nothing before it may be.
      if (args.record && !args.video) { await kit.countdownForOBS(6); }

      // --pick drew from the catalogue, so membership there is a given, not a
      // finding. Every other route has to discover it.
      const row = args.pick ? books[i] : locate(title);
      const player = new Player(title, author, args.model, args.offline);

      if (args.sheet && !args.offline) {
        const sheet = await askSheet(title, author, args.model, player);
        if (sheet) { Object.assign(player.book, sheet); player.save(); }
        else { player.fails++; }   // a missing sheet is a gagged player, not an opinion
      }
      // A phone-shaped, phone-behaving, cursor-free context; see record-kit for
      // the measurements behind the viewport and the scale factor, and for why
      // widening this does NOT produce a bigger picture of the game.
      const size = { width: args.width || 574, height: args.height || 844 };
      const context = await kit.newRecordingContext(browser, args, size);
      const page = await context.newPage();
      let take;
      try {
        // Offline has no model to ask, so the string rules stand alone there.
        const adjudicator = args.offline
          ? null
          : (offered => adjudicate(offered, title, author, args.model, player));
        take = await play(page, player, base, pressMs, adjudicator, args.record || args.video);
      } finally {
        const files = await kit.finishVideo(page, context, args);
        if (take && files.webm) { take.video = files.webm; }
        if (take && files.mp4) { take.mp4 = files.mp4; }
        player.save();
      }
      // Recorded on the take, because "the game could never have known this
      // one" is the difference between a loss that is a result and a loss that
      // is a category error.
      // true when proven present — by a title match, or by the game naming it,
      // which is proof of a different and better kind. null, never false, when
      // the lookup simply failed: absence was not established.
      take.inCatalogue = (row || take.result === 'won') ? true : null;
      take.catalogueRank = row && row.p !== undefined ? row.p : null;
      takes.push(take);
      console.log('  => ' + take.result + ' in ' + take.questions + ' questions (' +
                  take.cacheHits + ' cached, ' + take.groqCalls + ' asked)' +
                  (take.failedCalls
                    ? '  ** ' + take.failedCalls + ' CALLS FAILED — this take is '
                      + 'not a reader\'s answers **'
                    : ''));
    }
  } finally {
    await browser.close();
    server.close();
  }

  // Scored over the takes where the player actually answered. A win rate that
  // silently averages in games the API refused to serve is the "429 is not a
  // measurement" mistake this repo has made before and made again here.
  const sound = takes.filter(t => t.trustworthy);
  const spoilt = takes.length - sound.length;
  const won = sound.filter(t => t.result === 'won');

  let line = '\n' + won.length + '/' + sound.length + ' won';
  if (won.length) {
    const best = won.reduce((a, b) => (b.questions < a.questions ? b : a));
    line += ' · shortest: ' + best.title + ' in ' + best.questions + ' questions';
  }
  console.log(line);
  if (spoilt) {
    console.log(spoilt + '/' + takes.length + ' take(s) EXCLUDED — the player was ' +
                'cut off mid-game and answered "unknown" it did not choose.\n' +
                '  Rerun those; the cache keeps every answer that did land, so a ' +
                'rerun is cheaper and finishes the gaps.');
  }
  if (!sound.length) {
    console.log('  No sound take in this batch — nothing here is a measurement.');
  }
  // Split out, because a book the table does not hold was never winnable and
  // averaging it into a win rate understates the engine as badly as picking
  // only catalogued books overstates it.
  const unproven = sound.filter(t => t.inCatalogue === null);
  if (unproven.length) {
    console.log('  ' + unproven.length + ' title(s) had no catalogue row and lost, so ' +
                'it is unknown whether the game could have known them:\n    ' +
                unproven.map(t => t.title).join('\n    ') +
                '\n  These are the ones worth checking by hand — a translated ' +
                'title in books.json would explain the loss without blaming the engine.');
  }

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(takes, null, 1));
    console.log('takes -> ' + args.out);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
