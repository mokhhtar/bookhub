/*
 * games/video-tools.js — turning a recorded take into a file a feed will take.
 *
 * Shared by play-bot.js (which records) and studio/server.js (which checks
 * what was recorded). It is one module rather than two copies because the two
 * have to agree about where ffmpeg is and where the safe zone falls; a desk
 * that draws its guides in a different place from the one the converter
 * padded to would be worse than no guides at all.
 *
 * WHAT THE PLAYWRIGHT RECORDER ACTUALLY PRODUCES, measured against the copy
 * this machine loads (playwright-core's videoRecorder, and ffprobe on the
 * files it wrote) rather than taken from anyone's blog:
 *
 *   * VP8 in WebM, and nothing else — it throws on any other extension.
 *   * 25 fps, a module-level constant with no option attached to it.
 *   * `-b:v 1M`, likewise fixed. The real output never approaches it: 260 kbps
 *     at 574x844, 590 kbps at 1080x1920. TikTok asks for 4-8 Mbps.
 *   * the recorded RESOLUTION is the viewport in CSS pixels. deviceScaleFactor
 *     does not raise it (it does sharpen the frames — see play-bot.js).
 *
 * So the encoder is the ceiling, and re-encoding cannot lift a ceiling that
 * was applied before the file existed. What it CAN fix is everything else,
 * and each of these was a real reason a take could not be posted:
 *
 *   1. THE CONTAINER. TikTok and Reels want MP4/H.264. WebM is not a format
 *      they take, so the take was unusable regardless of how it looked.
 *   2. THE ASPECT RATIO. 574x844 is 1:1.47. Handed to a 9:16 feed it is
 *      letterboxed by the app's own scaler, which is a second re-encode on
 *      top of this one and a smaller picture inside it.
 *   3. THE SECOND GENERATION LOSS. An upload at 250 kbps is re-encoded by the
 *      platform as if it were a 250 kbps source. Handing it 8 Mbps of the same
 *      pictures adds no detail — nothing can — but it stops the platform's own
 *      encoder from taking another bite out of what is there.
 *
 * None of that makes this the good path. It is the preview path made postable;
 * a genuinely sharper take needs a real window and a real screen recorder.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const MP4_DEFAULT_SIZE = { width: 1080, height: 1920 };
const MP4_DEFAULT_BITRATE = '8M';

// ── finding an ffmpeg that can do the job ──────────────────────────────────
// PLAYWRIGHT SHIPS AN ffmpeg AND IT IS NOT THIS ONE. Its bundled build exists
// to write the VP8 the recorder needs and nothing else: no libx264, and not
// even the rawvideo muxer. Preferring it (on the reasoning that it is
// guaranteed present, since the .webm could not otherwise exist) produced
// "Unrecognized option 'preset'" and "Requested output format 'rawvideo' is
// not known" on the first real take. So the test is not "is there an ffmpeg"
// but "is there one that can encode H.264", and it is asked of the binary
// rather than assumed from its path.
let cachedFfmpeg;
function findFfmpeg() {
  if (cachedFfmpeg !== undefined) { return cachedFfmpeg; }
  const candidates = ['ffmpeg'];
  const bundled = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (fs.existsSync(bundled)) {
    for (const d of fs.readdirSync(bundled)) {
      if (!d.startsWith('ffmpeg')) { continue; }
      const exe = path.join(bundled, d, 'ffmpeg-win64.exe');
      if (fs.existsSync(exe)) { candidates.push(exe); }
    }
  }
  for (const c of candidates) {
    try {
      const out = execFileSync(c, ['-hide_banner', '-encoders'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 22 });
      if (/\blibx264\b/.test(out)) { return (cachedFfmpeg = c); }
    } catch (e) { /* not there, or not runnable — try the next */ }
  }
  return (cachedFfmpeg = null);
}

function ffmpegOrExplain() {
  const ffmpeg = findFfmpeg();
  if (ffmpeg) { return ffmpeg; }
  throw new Error('no ffmpeg with libx264 on this machine. Playwright\'s bundled ' +
    'copy cannot do it — it is a VP8-only build. Install a full ffmpeg and put ' +
    'it on PATH.');
}

// ffprobe lives beside whichever ffmpeg was chosen; on PATH it is just there.
function findFfprobe() {
  const ffmpeg = ffmpegOrExplain();
  if (ffmpeg === 'ffmpeg') { return 'ffprobe'; }
  const sibling = path.join(path.dirname(ffmpeg), 'ffprobe' + path.extname(ffmpeg));
  return fs.existsSync(sibling) ? sibling : 'ffprobe';
}

function probe(file) {
  const out = execFileSync(findFfprobe(), ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate,codec_name',
    '-show_entries', 'format=duration,bit_rate,size',
    '-of', 'default=noprint_wrappers=1', file], { encoding: 'utf8' });
  const o = {};
  for (const line of out.trim().split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) { o[line.slice(0, i)] = line.slice(i + 1); }
  }
  return {
    width: Number(o.width), height: Number(o.height),
    duration: Number(o.duration), bitRate: Number(o.bit_rate),
    bytes: Number(o.size), codec: o.codec_name, fps: o.avg_frame_rate
  };
}

// ── the conversion ─────────────────────────────────────────────────────────
// PAD WITH THE PAGE'S OWN BACKGROUND, not with black. A take whose aspect ratio
// does not match the target gets bars either way; cream bars beside a cream
// page read as margin, black bars read as a video that was cropped wrong. Read
// out of the first frame rather than hard-coded, so dark mode pads dark and a
// restyle of the site cannot leave this behind.
function frameCornerColour(file) {
  try {
    const px = execFileSync(ffmpegOrExplain(),
      ['-v', 'error', '-i', file, '-frames:v', '1',
       '-vf', 'crop=4:4:0:0,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { maxBuffer: 1 << 16, stdio: ['ignore', 'pipe', 'ignore'] });
    if (px.length >= 3) {
      return [...px.slice(0, 3)].map(b => b.toString(16).padStart(2, '0')).join('');
    }
  } catch (e) { /* fall through to the neutral choice */ }
  return '000000';
}

// fit: 'frame' fills the target and lets the app's overlays fall where they
// fall; 'safe' shrinks the whole take until it sits inside the safe rectangle,
// so nothing in it can ever be under a comment button. The second was not a
// theory — the first safe-zone check of a 540x960 take put the right-hand edge
// of every answer button, and half of "That's the one" on the win screen,
// under the action rail. 'frame' is still the default because the picture is
// bigger and a top-and-tailed take may not need it; the check says which.
function toMp4(webm, target, bitrate, fit) {
  const ffmpeg = ffmpegOrExplain();
  const size = target || MP4_DEFAULT_SIZE;
  const rate = bitrate || MP4_DEFAULT_BITRATE;
  const out = webm.replace(/\.webm$/i, '') + '.mp4';
  const { width: w, height: h } = size;
  const pad = frameCornerColour(webm);

  // The box the picture has to fit in: the whole frame, or the safe rectangle
  // inside it. Even numbers, because H.264 chroma subsampling needs them and an
  // odd one fails the encode rather than rounding quietly.
  //
  // THE SAFE RECTANGLE IS NOT CENTRED — the action rail on the right is three
  // times the left margin — so 'safe' cannot pad to the middle. Centring a
  // 840-wide picture in a 1080 frame puts its right edge at x=960, and the rail
  // starts at 900: the picture would be scaled down for nothing and still be
  // under the buttons. The offsets are the margins themselves.
  let boxW = w, boxH = h, offX = '(ow-iw)/2', offY = '(oh-ih)/2';
  if (fit === 'safe') {
    const l = Math.round(w * SAFE_ZONE.left);
    const t = Math.round(h * SAFE_ZONE.top);
    boxW = (w - l - Math.round(w * SAFE_ZONE.right)) & ~1;
    boxH = (h - t - Math.round(h * SAFE_ZONE.bottom)) & ~1;
    offX = `${l}+(${boxW}-iw)/2`;
    offY = `${t}+(${boxH}-ih)/2`;
  }

  // decrease + pad, never crop: cropping a take to fit silently eats the answer
  // buttons at the edge of a narrow frame, and losing part of the thing being
  // demonstrated is worse than a margin.
  const vf = `scale=${boxW}:${boxH}:force_original_aspect_ratio=decrease:flags=lanczos,` +
             `pad=${w}:${h}:${offX}:${offY}:color=0x${pad},format=yuv420p`;

  execFileSync(ffmpeg, [
    '-v', 'error', '-y', '-i', webm,
    // A SILENT TRACK, deliberately. The recorder writes no audio at all, and a
    // video with no audio stream is refused or silently mangled by enough
    // uploaders and editors that adding one costs nothing and removes a whole
    // class of "it would not import" that has nothing to do with the game.
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-shortest',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium',
    '-b:v', rate, '-maxrate', rate, '-bufsize', (parseInt(rate, 10) * 2) + 'M',
    '-profile:v', 'high', '-level', '4.1',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    out
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return out;
}

// ── the safe-zone check ────────────────────────────────────────────────────
// WHY THIS IS A PICTURE OF THE TAKE AND NOT AN OVERLAY ON THE PAGE. A guide
// drawn over the live page tells you where the safe zone falls in the BROWSER;
// what matters is where it falls in the FILE, after the scale and the padding
// toMp4 applies on the way out. Those are not the same rectangle, and only the
// second one is what a viewer sees. Drawing it on frames pulled back out of the
// finished file also makes it impossible for the guide to end up in a take.
//
// THESE MARGINS ARE A STARTING POINT AND ARE MEANT TO BE EDITED. TikTok's
// overlays move with its app — published figures for the same year disagree by
// as much as 150px on the bottom bar — so what is here is near the strict end
// of what several 2026 guides claim, and the only authority is a real upload
// looked at on a real phone. Kept as fractions so they hold at any frame size.
const SAFE_ZONE = { top: 140 / 1920, bottom: 400 / 1920, left: 60 / 1080, right: 180 / 1080 };

// Three moments, because one frame proves nothing about a take: a question
// early on, a question in the middle, and the end screen — which is the shot
// that actually has to survive, since the cover and the title land there and
// that is the frame a viewer stops on.
const CHECK_AT = [0.2, 0.55, 0.93];

// The four bars are drawn filled and semi-transparent rather than as outlines:
// an outline shows where the line is, a wash shows what is UNDER it, which is
// the actual question — whether the answer the video turns on is sitting
// beneath the comment button or not.
function overlayFilter(w, h, zone) {
  const z = zone || SAFE_ZONE;
  const t = Math.round(h * z.top);
  const b = Math.round(h * z.bottom);
  const l = Math.round(w * z.left);
  const r = Math.round(w * z.right);
  const midH = h - t - b;
  return [
    `drawbox=x=0:y=0:w=${w}:h=${t}:color=red@0.30:t=fill`,
    `drawbox=x=0:y=${h - b}:w=${w}:h=${b}:color=red@0.30:t=fill`,
    `drawbox=x=0:y=${t}:w=${l}:h=${midH}:color=red@0.30:t=fill`,
    `drawbox=x=${w - r}:y=${t}:w=${r}:h=${midH}:color=red@0.30:t=fill`,
    `drawbox=x=${l}:y=${t}:w=${w - l - r}:h=${midH}:color=0x39FF6A:t=3`
  ].join(',');
}

function safeZoneCheck(video, zone) {
  const ffmpeg = ffmpegOrExplain();
  const meta = probe(video);
  if (!meta.width || !meta.duration) {
    throw new Error('could not read ' + path.basename(video));
  }

  const filter = overlayFilter(meta.width, meta.height, zone);
  const args = ['-v', 'error', '-y'];
  // -ss BEFORE each -i so the seek is done on input and does not decode the
  // whole file three times over.
  for (const at of CHECK_AT) { args.push('-ss', (meta.duration * at).toFixed(2), '-i', video); }

  const scaled = CHECK_AT.map((_, i) => `[${i}:v]${filter},scale=360:-2[c${i}]`).join(';');
  const stack = CHECK_AT.map((_, i) => `[c${i}]`).join('') + 'hstack=inputs=' + CHECK_AT.length;
  args.push('-filter_complex', scaled + ';' + stack, '-frames:v', '1');

  const out = video.replace(/\.(webm|mp4)$/i, '') + '.safezone.png';
  args.push(out);
  execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  return { file: out, width: meta.width, height: meta.height, duration: meta.duration };
}

module.exports = {
  MP4_DEFAULT_SIZE, MP4_DEFAULT_BITRATE, SAFE_ZONE, CHECK_AT,
  findFfmpeg, probe, toMp4, safeZoneCheck, overlayFilter
};
