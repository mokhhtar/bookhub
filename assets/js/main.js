/* Litheca — main.js */

// Everything lives inside one IIFE: this file loads on every page AFTER the
// page's own inline <script>, and top-level const/let share the global
// lexical scope across classic scripts — a page declaring the same name
// (e.g. RL_KEY on the summary and My Library pages) made this whole file
// throw "already been declared" and die. Shared helpers are exposed on
// window explicitly below.
(function () {

// ── Mobile nav ──────────────────────────────────────────
const toggle = document.querySelector('.nav-toggle');
const nav    = document.querySelector('.site-nav');

if (toggle && nav) {
  // html.nav-open drives the dimmed backdrop (::after overlay in CSS) —
  // a huge box-shadow spread was tried first but Chromium caps it.
  const setOpen = (isOpen) => {
    nav.classList.toggle('open', isOpen);
    document.documentElement.classList.toggle('nav-open', isOpen);
    toggle.setAttribute('aria-expanded', String(isOpen));
  };
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('open')));
  // Close on outside click (includes taps on the backdrop overlay)
  document.addEventListener('click', e => {
    if (!toggle.contains(e.target) && !nav.contains(e.target)) setOpen(false);
  });
}

// ── Active nav link ──────────────────────────────────────
document.querySelectorAll('.nav-link').forEach(link => {
  if (link.href === window.location.href) link.classList.add('active');
});

// ── Reading list (localStorage) ──────────────────────────
const RL_KEY = 'bookhub_rl_v1';

const ReadingList = {
  get()       { try { return JSON.parse(localStorage.getItem(RL_KEY)) || []; } catch { return []; } },
  save(list)  { localStorage.setItem(RL_KEY, JSON.stringify(list)); },
  add(book)   {
    const list = this.get();
    if (list.find(b => b.title.toLowerCase() === book.title.toLowerCase())) return false;
    list.unshift({ ...book, id: Date.now(), addedAt: Date.now(), status: 'want', rating: 0 });
    this.save(list);
    return true;
  },
  remove(id)  { this.save(this.get().filter(b => b.id !== id)); },
  update(id, patch) { this.save(this.get().map(b => b.id === id ? { ...b, ...patch } : b)); },
};

window.ReadingList = ReadingList;

// ── Reading time helper ──────────────────────────────────
window.calcReadingTime = function(pages, wpm = 250) {
  const words   = pages * 275;
  const minutes = Math.round(words / wpm);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0)  return `${m} min`;
  if (m === 0)  return `${h} hr`;
  return `${h} hr ${m} min`;
};

// ── Hero search fill ─────────────────────────────────────
window.fillSearch = function(title) {
  const input = document.getElementById('hero-q');
  if (input) { input.value = title; input.focus(); }
};

// ── Toasts (site-wide notification system) ───────────────
// bhToast("Saved", "success") — types: info | success | error.
// Container is aria-live so screen readers announce messages.
window.bhToast = function (message, type = 'info', ms = 3200) {
  let wrap = document.getElementById('bh-toasts');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'bh-toasts';
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-live', 'polite');
    document.body.appendChild(wrap);
  }
  const t = document.createElement('div');
  t.className = 'bh-toast bh-toast-' + type;
  t.textContent = message;
  wrap.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    t.addEventListener('transitionend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 600); // fallback if transition never fires
  }, ms);
};

// ── Safe lightweight text formatting (comments/reviews) ──
// Renders **bold**, *italic*, and "- "/"* " bullet lists from user text.
// XSS-safe: the input is HTML-escaped FIRST, then only a fixed set of
// safe tags (strong/em/ul/li/br) is introduced — raw HTML never survives.
// Store text RAW; call bhFormat() at render time only.
window.bhFormat = function (raw) {
  const esc = (s) => String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  let t = esc(raw);
  t = t.replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, '$1<em>$2</em>');
  const lines = t.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const m = line.match(/^\s*[-*]\s+(.+)$/);
    if (m) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + m[1] + '</li>'); }
    else { if (inList) { out.push('</ul>'); inList = false; } out.push(line); }
  }
  if (inList) out.push('</ul>');
  let html = '';
  for (let i = 0; i < out.length; i++) {
    const isTag = /^<\/?(ul|li)>/.test(out[i]);
    if (i > 0 && !isTag && !/^<\/?(ul|li)>/.test(out[i - 1])) html += '<br>';
    html += out[i];
  }
  return html;
};

// ── Comment/review avatar ────────────────────────────────
// A colored initials circle. Universal — works without a stored photo
// (comment docs only carry {uid,name,text,...}, and other users' Google
// photos aren't reachable client-side), and the hue is derived from the
// name so a given reader keeps one consistent color. Returns safe HTML.
window.bhAvatar = function (name, size) {
  size = size || 34;
  const clean = String(name == null ? '' : name).trim();
  const initial = (clean.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
  let h = 0;
  for (let i = 0; i < clean.length; i++) h = (h * 31 + clean.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const safe = initial.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return '<span aria-hidden="true" style="flex-shrink:0;width:' + size + 'px;height:' + size + 'px;'
    + 'border-radius:50%;background:hsl(' + hue + ' 55% 42%);color:#fff;display:inline-flex;'
    + 'align-items:center;justify-content:center;font-size:' + Math.round(size * 0.45) + 'px;'
    + 'font-weight:700;line-height:1;">' + safe + '</span>';
};

// ── Ambience: generated background sounds (shared module) ─
// Calm (brown-noise pad), Rain (banded white noise), Wind (bandpass noise
// with a slow LFO) — all synthesized in Web Audio, so there is no audio
// asset to download or license. Used by the summary page's audio player
// AND standalone by the free-book reader. Type + level persist.
window.bhAmbience = (function () {
  let ctx = null, gain = null, nodes = [];
  let type = localStorage.getItem('bh_amb_type') || 'calm';
  let level = parseFloat(localStorage.getItem('bh_audio_amb') || '0') || 0;

  function teardown() {
    nodes.forEach(n => { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect && n.disconnect(); } catch (e) {} });
    nodes = [];
  }
  function noiseSource(fill) {
    const sr = ctx.sampleRate, len = sr * 6;
    const buf = ctx.createBuffer(1, len, sr);
    fill(buf.getChannelData(0), sr);
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    return src;
  }
  function build() {
    teardown();
    if (type === 'rain') {
      const n = noiseSource(d => { for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 0.6; });
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 500;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500;
      n.connect(hp); hp.connect(lp); lp.connect(gain);
      n.start(); nodes.push(n, hp, lp);
    } else if (type === 'wind') {
      const n = noiseSource(d => { let l = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; l = (l + 0.05 * w) / 1.05; d[i] = l * 4; } });
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 320; bp.Q.value = 0.7;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
      const lg = ctx.createGain(); lg.gain.value = 190;
      lfo.connect(lg); lg.connect(bp.frequency); lfo.start();
      n.connect(bp); bp.connect(gain);
      n.start(); nodes.push(n, bp, lfo, lg);
    } else {  // calm
      const n = noiseSource(d => { let l = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; l = (l + 0.02 * w) / 1.02; d[i] = l * 3.2; } });
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
      n.connect(lp); lp.connect(gain);
      n.start(); nodes.push(n, lp);
    }
  }
  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      gain = ctx.createGain(); gain.gain.value = level;
      gain.connect(ctx.destination);
      build();
    }
  }
  return {
    getType: () => type,
    getLevel: () => level,
    setType(t) {
      type = t; localStorage.setItem('bh_amb_type', t);
      if (ctx) { build(); if (level) ctx.resume(); }
    },
    setLevel(v) {
      level = parseFloat(v) || 0;
      localStorage.setItem('bh_audio_amb', String(level));
      if (!level) { if (ctx) ctx.suspend(); return; }
      try { ensure(); gain.gain.value = level; ctx.resume(); } catch (e) {}
    },
    start() { if (!level) return; try { ensure(); gain.gain.value = level; ctx.resume(); } catch (e) {} },
    stop() { try { if (ctx) ctx.suspend(); } catch (e) {} },
  };
})();

// ── Theme Switcher ───────────────────────────────────────
function initThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
      const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initThemeToggle);
} else {
  initThemeToggle();
}

})();
