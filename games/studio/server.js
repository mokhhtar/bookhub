/*
 * games/studio/server.js — the recording desk for the daily games.
 *
 *     node games/studio/server.js        then open http://127.0.0.1:8750
 *
 * TWO GAMES, ONE CAMERA. The mind reader needs a book and an answer sheet; Spot
 * the Slop needs a day and nothing else. What they share is the whole bottom
 * half of the page — size, mode, MP4, safe zone — so they are tabs over one
 * recording panel rather than two desks.
 *
 * WHY A PAGE AND NOT FLAGS. The command line for a take had grown to eight
 * arguments across two repos, and getting one wrong cost a run: a wrong
 * directory, a placeholder title, a flag whose absence silently changed what
 * was recorded. None of that is interesting work. This puts the same runs
 * behind a form, keeps the settings between sessions, and — the part that
 * actually matters — writes the answer sheet down before it is used, so a
 * sheet is never typed twice and never lost after the take.
 *
 * IT GENERATES THE PROMPT FROM questions.json. The questions are not copied
 * into this file. If a rebuild adds or reworries a question, the prompt handed
 * to Gemini changes with it, and a sheet answering the previous set is
 * detectably short rather than quietly wrong.
 *
 * WHAT IT DOES NOT DO. It never invents an answer. A question the sheet does
 * not cover is left out, reported, and played as "I don't know" by the bot —
 * the game offers that answer and a real player uses it.
 *
 * LOCAL ONLY. Bound to 127.0.0.1 because it spawns processes and writes files
 * on request. Nothing here is authenticated and nothing here should be exposed.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const videoTools = require('../video-tools');

const HERE = __dirname;
const GAMES = path.join(HERE, '..');
const ROOT = path.join(GAMES, '..');
const API_REPO = path.join(ROOT, '..', 'bookhub-api');
const ENV_PATH = path.join(API_REPO, '.env');

const QUESTIONS_JSON = path.join(GAMES, 'data', 'akinator', 'questions.json');
// A question the game asks that has no column in matrix.bin yet. The page keeps
// these in their own file precisely BECAUSE position is load-bearing there —
// matrix.bin is indexed by column, so a new entry cannot be inserted before
// meta.questions without shifting every packed cell. Nothing about that
// constraint applies to a prompt, but the split is easy to read as "the real
// questions and some other thing", which is how this desk came to ignore them.
const COLD_QUESTIONS_JSON = path.join(GAMES, 'data', 'akinator', 'cold_questions.json');
const BOOKS_JSON = path.join(GAMES, 'data', 'akinator', 'books.json');
const PLAY_BOT = path.join(GAMES, 'play-bot.js');
const CACHE_PATH = path.join(API_REPO, 'data', 'akinator_player_cache.json');

// ── Spot the Slop ──────────────────────────────────────────────────────────
// The desk records two games now. They share the camera panel below and
// nothing else: one needs an answer sheet, the other needs a day.
const SLOP_BOT = path.join(GAMES, 'slop-bot.js');
const STS_DATA_DIR = path.join(GAMES, 'data', 'spot-the-slop');
// Kept out of the published bank deliberately — see slop-bot.js. A video
// reveals all five answers, and every date in the real bank is a date somebody
// is going to play.
const SHOWCASE_DIR = path.join(GAMES, 'studio', 'showcase', 'spot-the-slop');
const SHOWCASE_DATE = '2026-01-01';
const STS_MAKER = path.join('scripts', 'make_sts_puzzles.py');

// Sheets are kept as their own files as well as merged into the player cache.
// The cache is keyed by question TEXT and mixes every book together; a sheet is
// one book, keyed by question ID, with the model and the date that produced it.
// That is the form worth keeping for the catalogue later — the cache is a
// working file, these are the record.
const SHEETS_DIR = path.join(API_REPO, 'data', 'akinator_sheets');
const SETTINGS = path.join(HERE, 'settings.json');

const ANSWER_KEYS = ['yes', 'probably_yes', 'unknown', 'probably_no', 'no'];

// What Gemini is allowed to say. The owner asked for three, which is what a
// person actually offers when asked about a book they know; the two hedges are
// still accepted here because the game has five and a sheet that uses them is
// more informative, not less.
const ACCEPTED = new Set(ANSWER_KEYS);

function normalize(s) {
  return String(s || '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/*
 * EVERY question the game asks, packed and cold, in the page's own order.
 *
 * This used to read questions.json alone, and the header above promised that a
 * question added to the game reaches the prompt with it. It did not: two
 * questions were added — "Is it set in the Victorian era?" and "Is it narrated
 * in the first person?" — and lived in cold_questions.json, so the prompt kept
 * saying 48 and Gemini was never asked them. The sheet then had no answer for
 * them, the cache had nothing to serve, and the bot answered "I don't know" to
 * both in every recorded game. A NEW question is exactly the one most worth
 * having a sheet for, and it was the only kind that could not get one.
 *
 * Worse than the missing answers: saveSheet validates ids against this list,
 * so a sheet that DID carry them would have had them thrown away as ids the
 * game never asks.
 *
 * Merge rules copied from addColdQuestions() in book-mind-reader.html, dedup
 * included: a cold id already promoted into the packed matrix is dropped
 * rather than asked twice, because the promoted column is the real one.
 */
function questions() {
  const packed = JSON.parse(fs.readFileSync(QUESTIONS_JSON, 'utf8'));
  let cold = [];
  try { cold = JSON.parse(fs.readFileSync(COLD_QUESTIONS_JSON, 'utf8')); } catch (e) { cold = []; }
  if (!Array.isArray(cold)) { return packed; }

  const seen = new Set(packed.map(q => q.id));
  for (const c of cold) {
    if (!c || typeof c.id !== 'string' || typeof c.text !== 'string') { continue; }
    if (seen.has(c.id)) { continue; }
    seen.add(c.id);
    packed.push({ id: c.id, text: c.text, cold: true });
  }
  return packed;
}

// ── the prompt ─────────────────────────────────────────────────────────────
// Written to be pasted into the Gemini web app, where a search tool is
// available that the free API key cannot reach. Three things it must get right:
//
//   1. SEARCH, don't recall. The whole reason for using the web app rather
//      than the API is the search, so the instruction has to be explicit or
//      the model will happily answer from memory and the advantage is lost.
//   2. STRICT JSON, one object, no fence. Anything else has to be repaired by
//      hand, and hand-repair is how a wrong answer gets in.
//   3. "unknown" is wanted. A model that hedges into a guess sends the game
//      away from the book, and the resulting take measures nothing. This is
//      the same instruction the fandom extractors use, for the same reason.
function buildPrompt(opts) {
  const qs = questions();
  const list = qs.map((q, i) => (i + 1) + '. [' + q.id + '] ' + q.text).join('\n');

  const choose = opts.title
    ? `The book is "${opts.title}"${opts.author ? ' by ' + opts.author : ''}.`
    : `First, pick ONE real, published book at random.

Do not pick the most obvious famous book. Vary the decade, the language of
origin, the genre, and whether it is fiction — pick as a well-stocked library
would, not as a bestseller list would. It must be a real book by a real
author: no textbooks, no manuals, no reports, no invented titles.`;

  return `You are helping test a twenty-questions game that guesses books.

${choose}

**Search the web before you answer.** Do not answer from memory. Check the
book's publication date, its author's nationality and dates, its setting, and
its subject against real sources, and let what you find decide each answer.

Then answer every one of these ${qs.length} questions about that book:

${list}

RULES

1. Answer with exactly one of: "yes", "no", "unknown".
2. "unknown" is a real answer and I want it. Use it whenever the sources do
   not settle the question, or the question does not apply to this book. A
   confident wrong answer is worse than "unknown" — it sends the game away
   from the book and ruins the test.
3. Be consistent with yourself. You are answering these together, so they must
   not contradict: a book that is not from the last 25 years is not from the
   last 10 either, and an author who is British is not American.
4. Answer about the WORK, not about one edition of it. Use the original
   publication date, not a reprint's.

OUTPUT

Reply with ONE JSON object and nothing else — no explanation before it, no
code fence around it, no commentary after it:

{
  "title": "the book's title in English",
  "author": "the author's name",
  "answers": {
    "${qs[0].id}": "yes",
    "${qs[1].id}": "no",
    "${qs[2].id}": "unknown"
  }
}

The keys inside "answers" must be the bracketed ids exactly as written above,
and every one of the ${qs.length} must be present.`;
}

// ── the sheet ──────────────────────────────────────────────────────────────
function saveSheet(body) {
  const qs = questions();
  const byId = new Map(qs.map(q => [q.id, q.text]));

  const title = String(body.title || '').trim();
  if (!title) { throw new Error('no title'); }
  const author = String(body.author || '').trim() || null;

  const answers = body.answers || {};
  const kept = {};
  const unknownIds = [];
  const badValues = [];
  for (const [id, raw] of Object.entries(answers)) {
    if (!byId.has(id)) { continue; }                 // an id we never asked
    const v = String(raw).toLowerCase().trim();
    if (!ACCEPTED.has(v)) { badValues.push(id + '=' + raw); continue; }
    kept[id] = v;
  }
  for (const q of qs) { if (!(q.id in kept)) { unknownIds.push(q.id); } }

  // Merge into the cache the bot reads, which is keyed by question TEXT because
  // that is what the page shows and what the bot can match on.
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch (e) { cache = {}; }
  }
  const bookKey = normalize(title + ' ' + (author || ''));
  const book = cache[bookKey] || (cache[bookKey] = {});
  for (const [id, v] of Object.entries(kept)) { book[normalize(byId.get(id))] = v; }

  const sorted = {};
  for (const k of Object.keys(cache).sort()) {
    sorted[k] = Object.fromEntries(Object.entries(cache[k]).sort());
  }
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(sorted, null, 1));

  // And keep the sheet itself. This is the artefact that might one day become
  // catalogue rows, so it records WHERE the answers came from — a sheet whose
  // provenance is unknown cannot be reviewed, only trusted, and this project
  // does not trust unreviewed data.
  fs.mkdirSync(SHEETS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(SHEETS_DIR, normalize(title).replace(/ /g, '-') + '__' + stamp + '.json');
  fs.writeFileSync(file, JSON.stringify({
    title, author,
    source: body.source || 'gemini web (search)',
    saved: new Date().toISOString(),
    questionCount: qs.length,
    answers: kept
  }, null, 1));

  return { kept: Object.keys(kept).length, total: qs.length, missing: unknownIds, badValues, file };
}

function locate(title) {
  const rows = JSON.parse(fs.readFileSync(BOOKS_JSON, 'utf8'));
  const want = normalize(title);
  const core = normalize(String(title).split(/\s*[:—–]\s+/)[0]);
  let i = rows.findIndex(r => normalize(r.t) === want);
  if (i < 0) { i = rows.findIndex(r => normalize(String(r.t).split(/\s*[:—–]\s+/)[0]) === core); }
  if (i < 0) { return null; }
  return { row: i, of: rows.length, p: rows[i].p, title: rows[i].t, author: rows[i].a };
}

// ── running the bot ────────────────────────────────────────────────────────
const runs = new Map();
let nextRun = 1;

// One record of a spawned process, whatever was spawned. The page polls
// /api/run for lines and does not care whether it is node or python on the
// other end — which is what lets the showcase build stream into the same log.
function track(child, args, cmd) {
  const id = String(nextRun++);
  const run = { id, lines: [], done: false, code: null, args, cmd: cmd || 'node' };
  runs.set(id, run);
  const push = buf => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (line.trim()) { run.lines.push(line); }
    }
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', e => { run.lines.push('[desk] ' + e.message); run.done = true; run.code = -1; });
  child.on('close', code => { run.done = true; run.code = code; });
  return run;
}

// The camera flags, identical for both bots because record-kit reads them.
function cameraArgs(opts, args) {
  if (opts.width) { args.push('--width', String(opts.width)); }
  if (opts.height) { args.push('--height', String(opts.height)); }
  if (opts.mode === 'video') {
    args.push('--video', opts.outDir || 'takes');
    // Off by default for a quick look, because the conversion is the slowest
    // part of a preview run and a preview is not going anywhere.
    if (opts.mp4) {
      args.push('--mp4', (opts.mp4Width || 1080) + 'x' + (opts.mp4Height || 1920));
      if (opts.mp4Bitrate) { args.push('--mp4-bitrate', opts.mp4Bitrate); }
      if (opts.mp4Fit === 'safe') { args.push('--mp4-fit', 'safe'); }
    }
  } else if (opts.mode === 'obs') { args.push('--record'); }
  // 'test' passes neither: headless, no window, no file — just the result.
  return args;
}

function startSlopRun(opts) {
  const args = [SLOP_BOT];
  if (opts.stsShowcase) { args.push('--showcase'); }
  else if (opts.stsDate) { args.push('--date', opts.stsDate); }
  if (opts.stsPairs) { args.push('--pairs', String(opts.stsPairs)); }
  // Blank means "work it out from how long the passages actually are", which
  // is the better default — a 180-character pair and a 420-character pair are
  // not the same wait. A number here overrides it for a particular take.
  if (opts.stsRead) { args.push('--read', String(opts.stsRead)); }
  if (opts.stsHold) { args.push('--hold', String(opts.stsHold)); }
  cameraArgs(opts, args);
  return track(spawn(process.execPath, args, { cwd: GAMES }), args);
}

// Builds the showcase day by running the API repo's generator into this desk's
// own directory. Spawned with .env loaded the same way the backend is — the
// generator needs GEMINI_API_KEY and that repo loads no .env itself.
function startShowcaseBuild() {
  const args = [STS_MAKER, '--from', SHOWCASE_DATE, '--epoch', SHOWCASE_DATE,
                '--data-dir', SHOWCASE_DIR, '--overwrite'];
  const env = Object.assign({}, process.env, loadEnvFile(),
                            { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' });
  return track(spawn('python', args, { cwd: API_REPO, env }), args, 'python');
}

// Both bots refuse to record against a build older than the page source, and
// they are right to — a take of a stale build is a take of the wrong game. But
// the check is on mtime, and git rewrites mtimes on every pull whether or not a
// byte changed, which in this repo is routine: the admin worker commits
// straight to GitHub all day. So the fix is one button rather than a trip to
// another terminal for a command that is usually a no-op.
function startSiteBuild() {
  const args = ['exec', 'jekyll', 'build'];
  return track(spawn('bundle', args, { cwd: ROOT, shell: true }), args, 'bundle');
}

function stsState() {
  const days = fs.existsSync(STS_DATA_DIR)
    ? fs.readdirSync(STS_DATA_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
        .map(n => n.slice(0, -5)).sort()
    : [];
  return {
    days,
    showcaseDate: SHOWCASE_DATE,
    showcase: fs.existsSync(path.join(SHOWCASE_DIR, SHOWCASE_DATE + '.json'))
  };
}

function startRun(opts) {
  if (opts.game === 'spot-the-slop') { return startSlopRun(opts); }

  const args = [PLAY_BOT, '--title', opts.title, '--offline'];
  if (opts.author) { args.push('--author', opts.author); }
  // THE ONE FLAG THAT DECIDES WHETHER AN ADMIN EDIT IS IN THE TAKE. The admin
  // commits straight to GitHub; this machine plays whatever the last `git pull`
  // and `jekyll build` left in _site. Measured again 2026-09-04: a book's
  // answers were corrected by hand, the bot then disagreed with the catalogue
  // on three questions, and _site's overrides.json turned out to be four days
  // old and to hold no entry for that book at all. The edit was perfect; the
  // build was not. --fresh-data serves games/data/akinator/* live from GitHub
  // and skips both staleness at once.
  if (opts.freshData) { args.push('--fresh-data'); }
  if (opts.width) { args.push('--width', String(opts.width)); }
  if (opts.height) { args.push('--height', String(opts.height)); }

  if (opts.mode === 'video') {
    args.push('--video', opts.outDir || 'takes');
    // Off by default for a quick look, because the conversion is the slowest
    // part of a preview run and a preview is not going anywhere.
    if (opts.mp4) {
      args.push('--mp4', (opts.mp4Width || 1080) + 'x' + (opts.mp4Height || 1920));
      if (opts.mp4Bitrate) { args.push('--mp4-bitrate', opts.mp4Bitrate); }
      if (opts.mp4Fit === 'safe') { args.push('--mp4-fit', 'safe'); }
    }
  }
  else if (opts.mode === 'obs') { args.push('--record'); }
  // 'test' passes neither: headless, no window, no file — just the result.

  return track(spawn(process.execPath, args, { cwd: GAMES }), args);
}

// ── the backend ────────────────────────────────────────────────────────────
// A prompt build needs `/api/prompt` to read questions.json fresh, and a
// sheet is meaningless without the game it will play into being reachable —
// both already require this repo's checkout, so starting the API from the
// same desk that already assumes it is close by is one fewer terminal, not
// a new dependency.
//
// main.py never loads .env itself (no python-dotenv anywhere in that repo,
// by design — production reads Render's dashboard). Spawned directly rather
// than through a shell that would `export` it, so nothing in it reaches
// uvicorn unless read and passed here.
function loadEnvFile() {
  const out = {};
  if (!fs.existsSync(ENV_PATH)) { return out; }
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) { out[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); }
  }
  return out;
}

let backend = { proc: null, status: 'idle', lines: [] };

function backendPush(buf) {
  for (const line of String(buf).split(/\r?\n/)) {
    if (line.trim()) { backend.lines.push(line); }
  }
}

function startBackend() {
  if (backend.proc) { return false; }
  backend.lines = [];
  backend.status = 'running';
  const env = Object.assign({}, process.env, loadEnvFile());
  const proc = spawn('python', ['-m', 'uvicorn', 'main:app', '--reload', '--port', '8000'],
                     { cwd: API_REPO, env });
  backend.proc = proc;
  proc.stdout.on('data', backendPush);
  proc.stderr.on('data', backendPush);
  proc.on('error', e => { backendPush('[desk] failed to start: ' + e.message); backend.status = 'error'; backend.proc = null; });
  proc.on('exit', code => { backend.status = code === 0 ? 'idle' : (backend.status === 'stopping' ? 'idle' : 'error'); backend.proc = null; });
  return true;
}

// taskkill /t so uvicorn --reload's child watcher dies with it -- a bare
// proc.kill() leaves the watcher (and the bound port) running.
function stopBackend() {
  if (!backend.proc) { return false; }
  backend.status = 'stopping';
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(backend.proc.pid), '/t', '/f']);
  } else {
    backend.proc.kill('SIGTERM');
  }
  return true;
}

// ── the safe-zone check ────────────────────────────────────────────────────
// The geometry and the conversion both come from games/video-tools.js rather
// than being restated here — see that module for why the guides are drawn on
// the finished file instead of over the live page, and for how provisional the
// margins are.
//
// Only files this process made are ever served back. Nothing here is
// authenticated, so "read any path the query string names" is not a door to
// leave open even on a loopback-only desk.
const checkImages = new Set();

// The run's own output is the record of what it wrote — parsed rather than
// guessed at, because the recorder names the file and only it knows the name.
function filesFromRun(run) {
  const found = { webm: null, mp4: null };
  for (const line of run.lines) {
    let m = /^\s*video\s+->\s+(.+\.webm)\s*$/.exec(line);
    if (m) { found.webm = m[1].trim(); }
    m = /^\s*mp4\s+->\s+(.+\.mp4)\s/.exec(line);
    if (m) { found.mp4 = m[1].trim(); }
  }
  return found;
}

// ── settings ───────────────────────────────────────────────────────────────
function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch (e) { return {}; }
}

// ── http ───────────────────────────────────────────────────────────────────
function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) { req.destroy(); reject(new Error('too big')); } });
    req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(HERE, 'index.html')));
      return;
    }
    if (url.pathname === '/api/prompt') {
      return json(res, 200, {
        prompt: buildPrompt({ title: url.searchParams.get('title'), author: url.searchParams.get('author') }),
        questionCount: questions().length
      });
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, readSettings());
    }
    if (url.pathname === '/api/settings' && req.method === 'POST') {
      const body = await readBody(req);
      fs.writeFileSync(SETTINGS, JSON.stringify(body, null, 1));
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/locate') {
      return json(res, 200, { found: locate(url.searchParams.get('title') || '') });
    }
    if (url.pathname === '/api/sheet' && req.method === 'POST') {
      const body = await readBody(req);
      return json(res, 200, saveSheet(body));
    }
    if (url.pathname === '/api/sheets') {
      const files = fs.existsSync(SHEETS_DIR) ? fs.readdirSync(SHEETS_DIR).sort().reverse() : [];
      return json(res, 200, { dir: SHEETS_DIR, files });
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.game !== 'spot-the-slop' && !body.title) {
        return json(res, 400, { error: 'no title' });
      }
      if (body.game === 'spot-the-slop' && !body.stsShowcase && !body.stsDate) {
        return json(res, 400, { error: 'no day to record' });
      }
      const run = startRun(body);
      // The script path is kept, not sliced off. The log line is meant to be
      // copy-pasteable into a terminal, and `node --showcase --pairs 2` is not
      // a command anyone can run — it just looks like one, which is worse.
      // basename, because both bots live in games/ and that is this process's
      // cwd — so `node slop-bot.js --showcase …` is the real command, verbatim.
      return json(res, 200, { id: run.id, cmd: run.cmd,
                              args: [path.basename(run.args[0]), ...run.args.slice(1)] });
    }
    if (url.pathname === '/api/run') {
      const run = runs.get(url.searchParams.get('id'));
      if (!run) { return json(res, 404, { error: 'no such run' }); }
      return json(res, 200, { lines: run.lines, done: run.done, code: run.code });
    }
    if (url.pathname === '/api/sts') {
      return json(res, 200, stsState());
    }
    if (url.pathname === '/api/sts/showcase' && req.method === 'POST') {
      const run = startShowcaseBuild();
      return json(res, 200, { id: run.id, cmd: run.cmd, args: run.args });
    }
    if (url.pathname === '/api/site/build' && req.method === 'POST') {
      const run = startSiteBuild();
      return json(res, 200, { id: run.id, cmd: run.cmd, args: run.args });
    }
    // What this desk can and cannot do, asked of the machine rather than
    // assumed: without an ffmpeg that has libx264 there is no MP4 and no
    // safe-zone check, and the page should say so before a run rather than
    // after one.
    if (url.pathname === '/api/capabilities') {
      const ffmpeg = videoTools.findFfmpeg();
      return json(res, 200, { ffmpeg: ffmpeg || null, safeZone: videoTools.SAFE_ZONE });
    }
    if (url.pathname === '/api/safezone' && req.method === 'POST') {
      const body = await readBody(req);
      const run = runs.get(String(body.id));
      if (!run) { return json(res, 404, { error: 'no such run' }); }
      const files = filesFromRun(run);
      // The MP4 when there is one: it is the file that gets uploaded, and it is
      // the only one whose geometry includes the padding this desk added.
      const target = files.mp4 || files.webm;
      if (!target) { return json(res, 400, { error: 'that run recorded no file' }); }
      if (!fs.existsSync(target)) { return json(res, 400, { error: 'gone from disk: ' + target }); }
      const check = videoTools.safeZoneCheck(target);
      checkImages.add(check.file);
      return json(res, 200, {
        source: target, checkedMp4: !!files.mp4,
        width: check.width, height: check.height,
        url: '/api/image?path=' + encodeURIComponent(check.file)
      });
    }
    if (url.pathname === '/api/image') {
      const p = url.searchParams.get('path') || '';
      if (!checkImages.has(p)) { return json(res, 403, { error: 'not a file this desk made' }); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      fs.createReadStream(p).pipe(res);
      return;
    }
    if (url.pathname === '/api/backend/start' && req.method === 'POST') {
      return json(res, 200, { ok: true, started: startBackend() });
    }
    if (url.pathname === '/api/backend/stop' && req.method === 'POST') {
      return json(res, 200, { ok: true, stopped: stopBackend() });
    }
    if (url.pathname === '/api/backend/status') {
      return json(res, 200, { status: backend.status, lines: backend.lines });
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

const PORT = Number(process.env.PORT || 8750);
server.listen(PORT, '127.0.0.1', () => {
  console.log('recording desk: http://127.0.0.1:' + PORT);
  console.log('  sheets  -> ' + SHEETS_DIR);
  console.log('  cache   -> ' + CACHE_PATH);
});
