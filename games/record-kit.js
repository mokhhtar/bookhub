/*
 * games/record-kit.js — the browser and camera plumbing both game bots share.
 *
 * WHY THIS EXISTS. play-bot.js had all of this inline, and it was correct: a
 * static server over _site, a build-freshness check, a real-Chrome launch, a
 * phone-shaped recording context, and the .webm -> .mp4 hand-off. Then a second
 * bot needed every one of them and none of the twenty-questions machinery
 * around them. Copying would have meant two deviceScaleFactor decisions, two
 * consent-banner scripts, and two chances for a take to be recorded under
 * settings nobody remembered choosing.
 *
 * The measured reasoning behind these values is NOT repeated here — it is in
 * play-bot.js's header and in the comments below, kept with the code it
 * explains. Read it before changing a number: most of these were arrived at by
 * recording the same page three ways and looking at the files.
 *
 * WHAT IS DELIBERATELY NOT HERE. Pacing. How long a question or a passage
 * stays on screen is a decision about a particular video, and the two bots
 * disagree about it for good reasons — one is imitating a person answering,
 * the other is giving a viewer time to read. Each keeps its own.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');

const videoTools = require('./video-tools');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain'
};

const UA = 'Litheca/1.0 (games/record-kit.js; https://litheca.com; hello@litheca.com)';

// ── playwright, wherever this machine happens to keep it ────────────────────
// There is no package.json in this repo and pip/npm here run at about 11 KB/s,
// so the working copy is whichever one some other tool already installed. Real
// Chrome rather than a downloaded Chromium for the same reason — and it is what
// the camera pass wants anyway, since a Playwright-branded Chromium does not
// look like a browser anyone uses.
function loadPlaywright() {
  const tried = [];
  const roots = ['playwright'];

  const npx = path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx');
  if (fs.existsSync(npx)) {
    for (const d of fs.readdirSync(npx)) {
      roots.push(path.join(npx, d, 'node_modules', 'playwright'));
    }
  }
  const global = path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  if (fs.existsSync(global)) {
    for (const d of fs.readdirSync(global)) {
      roots.push(path.join(global, d, 'node_modules', 'playwright'));
    }
  }

  for (const r of roots) {
    try { return require(r); } catch (e) { tried.push(r); }
  }
  console.error('playwright not found. Tried:\n  ' + tried.join('\n  '));
  process.exit(1);
}

// ── the site under test ────────────────────────────────────────────────────
// SERVED FROM _site, NOT THE SOURCE TREE. Every game page here is a Jekyll
// template whose data files resolve against the built site. A take recorded
// against a stale build is a take of the wrong game, so refusing is the only
// safe answer — a warning would be read past.
function requireFreshBuild(builtFile, sourceFile, repoRoot) {
  const rebuild = 'run: cd ' + repoRoot + ' && bundle exec jekyll build';
  if (!fs.existsSync(builtFile)) {
    console.error('no built page at ' + builtFile + '\n  ' + rebuild);
    process.exit(1);
  }
  if (fs.statSync(builtFile).mtimeMs < fs.statSync(sourceFile).mtimeMs) {
    console.error('the built page is older than ' + path.basename(sourceFile) + '.\n' +
                  '  A take recorded now would be of the wrong game.\n  ' + rebuild);
    process.exit(1);
  }
}

// A GET to raw.githubusercontent.com, piped straight into the response.
// Redirects are not expected from that host for a plain branch path, so
// none are followed — a follow here would need the same not-outside-dir
// discipline the local path already has, for a case that should not occur.
function proxyUpstream(repo, branch, upstreamPath, contentType, res) {
  const url = 'https://raw.githubusercontent.com/' + repo + '/' + branch + upstreamPath;
  https.get(url, { headers: { 'User-Agent': UA } }, (up) => {
    if (up.statusCode !== 200) {
      res.writeHead(up.statusCode || 502).end('upstream ' + upstreamPath + ': ' + up.statusCode);
      up.resume();
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    up.pipe(res);
  }).on('error', (e) => {
    res.writeHead(502).end('upstream fetch failed for ' + upstreamPath + ': ' + e.message);
  });
}

/*
 * A static server over the built site, with two ways to override one path.
 *
 *   opts.proxy  = { prefix, repo, branch }
 *     Serve that prefix live from GitHub instead of from this checkout.
 *     play-bot uses it for games/data/akinator/*, which the admin worker and
 *     the nightly sync commit straight to GitHub — so a local _site build is a
 *     snapshot of whatever this checkout held at the last `jekyll build` and
 *     silently plays the OLD game after an admin edit. Measured the hard way,
 *     once: a real edit landed correctly on GitHub and a take taken minutes
 *     later still showed it losing.
 *
 *   opts.mounts = [{ prefix, dir }]
 *     Serve that prefix from another local directory. slop-bot uses it for the
 *     showcase puzzle, which must NOT live in the published bank — a video
 *     reveals all five answers, and a date in the real bank is a date somebody
 *     is going to play.
 *
 * The PAGE ITSELF always stays local, under either. An in-progress edit to a
 * game template is exactly what requireFreshBuild exists to protect, and
 * neither of these replaces it: they are orthogonal kinds of staleness, one in
 * data this checkout never owns, one in code it is mid-editing.
 */
function serve(dir, opts) {
  opts = opts || {};
  // Resolved, because the containment check below is a string comparison and
  // path.join() always returns platform separators. A root passed with forward
  // slashes on Windows made every single request 404 — and a 404 for the page
  // itself looks exactly like a page whose script never ran.
  dir = path.resolve(dir);
  const mounts = (opts.mounts || []).map(m => ({ prefix: m.prefix, dir: path.resolve(m.dir) }));
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (p.endsWith('/')) { p += 'index.html'; }
    const type = MIME[path.extname(p)] || 'application/octet-stream';

    if (opts.proxy && p.startsWith(opts.proxy.prefix)) {
      proxyUpstream(opts.proxy.repo, opts.proxy.branch, p, type, res);
      return;
    }

    // A mount wins over the built site, and a miss inside one is a 404 rather
    // than a quiet fall-through: a showcase day that silently served the live
    // day instead would be the exact spoiler the mount exists to prevent.
    let root = dir;
    let rel = p;
    const mount = mounts.find(m => p.startsWith(m.prefix));
    if (mount) {
      root = mount.dir;
      rel = p.slice(mount.prefix.length);
    }

    const file = path.join(root, rel);
    // Never serve outside the root, even though nothing but a bot talks to it.
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: 'http://127.0.0.1:' + server.address().port, server });
    });
  });
}

// ── the browser ────────────────────────────────────────────────────────────
function launchBrowser(pw, args) {
  return pw.chromium.launch({
    // --video needs no window at all: headless Chrome renders the same page,
    // and nothing appears on screen to be caught by anything else.
    headless: args.video ? true : (args.record ? false : !args.headed),
    channel: 'chrome',
    // ignoreDefaultArgs drops the "controlled by automated test software"
    // infobar, which is otherwise the first thing in frame.
    ...(args.record ? {
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled', '--hide-crash-restore-bubble']
    } : {})
  });
}

/*
 * A context shaped like a phone, and recorded like one.
 *
 * hasTouch is what makes it a phone: it hides the pages' keyboard hints
 * (pointer: coarse), it makes touchscreen.tap dispatch real touch events, and
 * it means no cursor has to be invented for the frame. Playwright's mouse
 * moves a pointer INSIDE the browser while a screen recorder captures the
 * operating system's, so a desktop take shows buttons lighting up under a
 * cursor parked in the corner — the single clearest tell there is.
 *
 * deviceScaleFactor 2 IS NOT DECORATION AND IT IS NOT RESOLUTION EITHER, and
 * both halves of that were measured rather than reasoned about. The recorded
 * video is the viewport in CSS pixels whatever this is set to — 540x960 at dsf
 * 1, 2 and 3 alike. What it changes is the frames inside that size: Chrome
 * renders at 2x and the screencast samples down, and the same page recorded
 * three times came out visibly cleaner at 2 than at 1 (and 3 looked like 1
 * again, so this is not a dial to keep turning). The encoder agrees — the same
 * still page cost 403 KB at dsf 1 and 468 KB at dsf 2: more detail to spend
 * bits on.
 *
 * WIDENING THE VIEWPORT IS NOT THE WAY TO A BIGGER PICTURE. These pages cap
 * their stage in ch units, so a 1080-wide viewport does not enlarge the game —
 * it renders the full desktop page, nav bar and footer and all, with the card
 * as a small box in the top third. Record at a phone width and scale up
 * afterwards (--mp4). The recorder also scales a frame DOWN to fit the size
 * given and never up, so asking for more produces the page in the top-left
 * corner with grey padding around it.
 */
function newRecordingContext(browser, args, size) {
  const recording = !!(args.record || args.video);
  return browser.newContext(recording ? {
    viewport: size,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    ...(args.video ? { recordVideo: { dir: args.video, size } } : {})
  } : {}).then(async (context) => {
    // THE COOKIE BANNER SITS OVER THE GAME. A viewer watching a finger tap a
    // button hidden behind a consent card learns nothing. Recorded as a
    // RETURNING visitor, who genuinely sees no banner — declining analytics
    // rather than accepting, since a demo should not quietly opt a recording
    // into being counted. The schema is the one _layouts/default.html reads; a
    // version bump there re-shows the banner and this stops working, which is
    // the correct failure: the recording would then show what a real visitor
    // sees.
    if (recording) {
      await context.addInitScript(() => {
        try {
          localStorage.setItem('litheca_consent',
            JSON.stringify({ analytics: false, ts: Date.now(), v: 1 }));
        } catch (e) { /* private mode: the banner shows, and that is honest */ }
      });
    }
    return context;
  });
}

/*
 * Close the context and report what landed on disk.
 *
 * The file is only written on close, and its name is only knowable once it
 * exists — so ask before closing, report after. A failed MP4 conversion must
 * not take the take with it: the .webm is still on disk and is still the
 * recording, and this step only ever ADDS a file.
 */
async function finishVideo(page, context, args) {
  const video = args.video ? page.video() : null;
  await context.close();
  if (!video) { return {}; }

  const webm = await video.path();
  console.log('  video -> ' + webm);
  const out = { webm };
  if (!args.mp4) { return out; }

  try {
    out.mp4 = videoTools.toMp4(webm, args.mp4, args.mp4Bitrate, args.mp4Fit);
    const m = videoTools.probe(out.mp4);
    console.log('  mp4   -> ' + out.mp4 + '  (' + m.width + 'x' + m.height + ', ' +
                Math.round(m.bitRate / 1000) + ' kbps, ' +
                (m.bytes / 1048576).toFixed(1) + ' MB)');
  } catch (e) {
    console.log('  mp4: conversion failed — ' +
                String(e.stderr || e.message).trim().split(/\r?\n/)[0].slice(0, 160));
    console.log('       the .webm is untouched and still usable.');
  }
  return out;
}

// The six-second handshake for an OBS take. The owner starts the recorder, not
// the script: everything after the countdown is in frame, so nothing before it
// may be.
async function countdownForOBS(seconds) {
  console.log('\n  RECORDING TAKE — start the recorder now.');
  for (let s = seconds || 6; s > 0; s--) {
    process.stdout.write('\r  opening the site in ' + s + '… ');
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log('\r  opening the site now.        ');
}

module.exports = {
  MIME, loadPlaywright, requireFreshBuild, serve,
  launchBrowser, newRecordingContext, finishVideo, countdownForOBS
};
