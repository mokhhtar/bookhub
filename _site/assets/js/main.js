/* BookHub — main.js */

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
