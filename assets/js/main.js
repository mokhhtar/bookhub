/* BookHub — main.js */

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
  toggle.addEventListener('click', () => {
    const isOpen = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
  });
  // Close on outside click
  document.addEventListener('click', e => {
    if (!toggle.contains(e.target) && !nav.contains(e.target)) {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
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
