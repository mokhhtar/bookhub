/*
 * games/slop-bot.js — record Spot the Slop revealing itself, for social video.
 *
 *     node games/slop-bot.js --showcase --headed
 *     node games/slop-bot.js --showcase --video takes --mp4
 *     node games/slop-bot.js --date 2026-09-04 --pairs 3 --video takes
 *
 * NOTHING HERE PICKS AN ANSWER, and that is the whole design.
 *
 * The obvious video is a bot playing: five pairs, five taps, a score at the
 * end. It is the wrong video twice over. A bot that picks correctly every time
 * is a video about a bot being right, which is not what this game is about and
 * is not even interesting — the viewer is a spectator. And a bot that picks
 * WRONG on camera publishes an advertisement for the opposite of the site's
 * argument: that the machine-written passage was the better one.
 *
 * So this shows the pair, waits long enough for the person watching to decide,
 * and then reveals. The viewer plays; the bot is the hand turning the card
 * over. Everything below follows from that: the reading beat is generous and
 * derived from the actual passage lengths, the scroll makes sure both passages
 * were on screen before the answer appears, and the reveal holds long enough
 * to be read on a phone at arm's length.
 *
 * WHY A SECOND SCRIPT AND NOT A FLAG ON play-bot.js. They share a camera and
 * nothing else. play-bot is twenty questions, a Groq player, an answer cache
 * and a catalogue lookup; none of that has any meaning here, and this needs no
 * model, no key, and no network beyond the loopback server. What they genuinely
 * share now lives in record-kit.js and is imported by both.
 *
 * THE PAGE DOES THE REVEALING, not this script. games/spot-the-slop.html has a
 * demo mode, gated to localhost, that exposes window.stsDemo; this drives that
 * hook and reads back what the page rendered. Nothing here draws a card or
 * decides which passage was real — a recording that rendered the game its own
 * way would be a recording of a game that does not exist. It also means the
 * take is evidence the shipped page really behaves this way.
 *
 * IT NEVER TOUCHES THE LIVE COUNTS. Demo mode writes no localStorage and
 * reports no score to the games Worker, so a morning of takes cannot appear in
 * the "how many people solved this" the video is advertising.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const kit = require('./record-kit');
const videoTools = require('./video-tools');

const ROOT = path.join(__dirname, '..');
const BUILT_SITE = path.join(ROOT, '_site');
const PAGE_SOURCE = path.join(__dirname, 'spot-the-slop.html');
const GAME_PATH = '/games/spot-the-slop/';
const DATA_PREFIX = '/games/data/spot-the-slop/';

// The showcase puzzle: a real generated day on a date no calendar reaches, kept
// OUT of the published bank on purpose. A video reveals all five answers, and
// every date in the real bank is a date somebody is going to play. Served by a
// mount, so the live bank is not even readable during a showcase take.
const SHOWCASE_DIR = path.join(__dirname, 'studio', 'showcase', 'spot-the-slop');
const SHOWCASE_DATE = '2026-01-01';

// ── pacing ─────────────────────────────────────────────────────────────────
// The one number that decides whether this video works. Too short and the
// viewer has not finished the second passage when the answer lands, so they
// never played and the reveal means nothing. Too long and it is not a social
// video any more.
//
// 240 wpm is a scanning rate, not a reading-for-pleasure rate: the viewer is
// comparing two texts for register and rhythm, which is faster than reading
// them. The clamp matters more than the rate — a 180-character pair and a
// 420-character pair are both still one decision.
const PACE = {
  wordsPerMinute: 240,
  minRead: 8000,
  maxRead: 20000,
  hold: 5000,          // the reveal on screen, before moving on
  settle: 700,         // after a scroll, before counting reading time again
  endHold: 6000        // the closing card
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readingTime(texts) {
  const words = texts.join(' ').trim().split(/\s+/).length;
  const ms = (words / PACE.wordsPerMinute) * 60000;
  return Math.min(PACE.maxRead, Math.max(PACE.minRead, ms));
}

// Native smooth scrolling rather than Playwright's scrollIntoViewIfNeeded,
// which jumps instantly — correct for a test, unwatchable in a video. Resolves
// when the page has stopped moving rather than after a guessed delay, because
// a scroll still running when the reveal lands looks like a mis-tap.
async function glideTo(page, selector, block) {
  await page.evaluate(([sel, blk]) => {
    const el = document.querySelector(sel);
    if (el) { el.scrollIntoView({ behavior: 'smooth', block: blk }); }
  }, [selector, block || 'center']);

  let last = -1;
  for (let i = 0; i < 40; i++) {                       // ~4s ceiling
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) { break; }
    last = y;
    await sleep(100);
  }
}

// ── one pair ───────────────────────────────────────────────────────────────
async function showPair(page, index, total, opts) {
  const cards = page.locator('.sts-card');
  await cards.first().waitFor({ timeout: 15000 });

  const passages = await page.locator('.sts-passage').allInnerTexts();
  const beat = opts.read != null ? opts.read : readingTime(passages);
  const author = (await page.locator('.sts-prompt').innerText().catch(() => '')).trim();
  console.log('  pair ' + (index + 1) + '/' + total + ' — ' + author.replace(/\s+/g, ' '));
  console.log('    ' + passages.length + ' passages, ' + passages.join('').length +
              ' chars, reading beat ' + Math.round(beat) + 'ms');

  // BOTH PASSAGES HAVE TO HAVE BEEN ON SCREEN. At a phone width the two cards
  // stack, and a 400-character pair is taller than the viewport — so a take
  // that never scrolled would reveal the answer to a passage the viewer was
  // never shown, which is the one thing this format cannot do.
  await glideTo(page, '.sts-card:first-child', 'start');
  await sleep(beat / 2);
  await glideTo(page, '.sts-card:last-child', 'end');
  await sleep(PACE.settle + beat / 2);

  await page.evaluate(() => window.stsDemo.reveal());
  await page.locator('.sts-verdict').first().waitFor({ timeout: 5000 });

  // The verdicts sit at the foot of each card and the sentence naming the book
  // is below both, so the answer is not in one place — bring the join between
  // them into frame rather than either end.
  await glideTo(page, '.sts-after', 'end');
  const found = (await page.locator('.sts-after p').innerText().catch(() => '')).trim();
  console.log('    revealed: ' + found.replace(/\s+/g, ' '));
  await sleep(opts.hold != null ? opts.hold : PACE.hold);
}

// ── the take ───────────────────────────────────────────────────────────────
async function record(page, base, opts) {
  const url = base + GAME_PATH + '?demo=1&date=' + opts.date;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // The hook only exists in demo mode, and demo mode only exists on localhost.
  // Waiting on it rather than assuming it means a page served from anywhere
  // else fails here, loudly, instead of recording a silent non-take.
  try {
    await page.waitForFunction(() => window.stsDemo && window.stsDemo.ready(), { timeout: 15000 });
  } catch (e) {
    const empty = await page.locator('.sts-empty').innerText().catch(() => null);
    throw new Error(empty
      ? 'the page has no puzzle for ' + opts.date + ' — it says: ' + empty.replace(/\s+/g, ' ')
      : 'window.stsDemo never appeared. Demo mode is localhost-only; ' +
        'is this a --live run, or is _site stale?');
  }

  const total = await page.evaluate(() => window.stsDemo.rounds());
  const want = Math.min(opts.pairs || total, total);
  console.log('  ' + opts.date + ' — ' + total + ' pairs published, showing ' + want);

  for (let i = 0; i < want; i++) {
    await showPair(page, i, want, opts);
    if (i < want - 1) {
      await page.evaluate(() => window.stsDemo.next());
      await page.locator('.sts-pick').first().waitFor({ timeout: 5000 });
    }
  }

  // Only walk to the closing card when the whole day was shown. Stopping at
  // three of five and then displaying "that was today's five" would be a
  // caption that contradicts the video above it.
  if (want === total) {
    await page.evaluate(() => window.stsDemo.next());
    await page.locator('.sts-result').waitFor({ timeout: 5000 }).catch(() => {});
    await glideTo(page, '.sts-result', 'start');
    await sleep(PACE.endHold);
  }
  return { date: opts.date, pairs: want, of: total };
}

// ── cli ────────────────────────────────────────────────────────────────────
function localISODate(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--showcase') { a.showcase = true; }
    else if (k === '--date') { a.date = argv[++i]; }
    else if (k === '--pairs') { a.pairs = Number(argv[++i]); }
    else if (k === '--read') { a.read = Number(argv[++i]) * 1000; }
    else if (k === '--hold') { a.hold = Number(argv[++i]) * 1000; }
    else if (k === '--width') { a.width = Number(argv[++i]); }
    else if (k === '--height') { a.height = Number(argv[++i]); }
    else if (k === '--video') { a.video = argv[++i] || 'takes'; }
    else if (k === '--mp4') {
      a.mp4 = videoTools.MP4_DEFAULT_SIZE;
      const m = argv[i + 1] && /^(\d+)x(\d+)$/.exec(argv[i + 1]);
      if (m) { a.mp4 = { width: Number(m[1]), height: Number(m[2]) }; i++; }
    }
    else if (k === '--mp4-bitrate') { a.mp4Bitrate = argv[++i]; }
    else if (k === '--mp4-fit') { a.mp4Fit = argv[++i]; }
    else if (k === '--record') { a.record = true; }
    else if (k === '--headed') { a.headed = true; }
    else { console.error('unknown option ' + k); process.exit(1); }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mp4 && !args.video) {
    console.error('--mp4 converts what --video wrote; on its own there is no file ' +
                  'to convert. (An OBS take is already an MP4.)');
    process.exit(1);
  }
  if (args.showcase && args.date) {
    console.error('--showcase IS a date (' + SHOWCASE_DATE + '); pass one or the other');
    process.exit(1);
  }

  kit.requireFreshBuild(
    path.join(BUILT_SITE, 'games', 'spot-the-slop', 'index.html'), PAGE_SOURCE, ROOT);

  const mounts = [];
  if (args.showcase) {
    const file = path.join(SHOWCASE_DIR, SHOWCASE_DATE + '.json');
    if (!fs.existsSync(file)) {
      console.error('no showcase puzzle at ' + file + '\n' +
        '  build one, from the API repo:\n' +
        '  python scripts/make_sts_puzzles.py --from ' + SHOWCASE_DATE +
        ' --epoch ' + SHOWCASE_DATE + ' --data-dir "' + SHOWCASE_DIR + '"');
      process.exit(1);
    }
    mounts.push({ prefix: DATA_PREFIX, dir: SHOWCASE_DIR });
    console.log('  showcase day, served from ' + SHOWCASE_DIR);
    console.log('  the published bank is not readable in this take, so nothing live is spoilt.');
  }

  const opts = {
    date: args.showcase ? SHOWCASE_DATE : (args.date || localISODate(new Date())),
    pairs: args.pairs, read: args.read, hold: args.hold
  };

  const { base, server } = await kit.serve(BUILT_SITE, { mounts });
  const pw = kit.loadPlaywright();
  const browser = await kit.launchBrowser(pw, args);
  try {
    if (args.record && !args.video) { await kit.countdownForOBS(6); }
    const size = { width: args.width || 540, height: args.height || 960 };
    const context = await kit.newRecordingContext(browser, args, size);
    const page = await context.newPage();
    let take = null;
    try {
      take = await record(page, base, opts);
    } finally {
      const files = await kit.finishVideo(page, context, args);
      if (take) {
        console.log('  => ' + take.pairs + ' of ' + take.of + ' pairs revealed, ' +
                    'none of them answered' + (files.mp4 ? ' — upload ' + files.mp4 : ''));
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
