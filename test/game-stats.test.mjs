import fs from 'node:fs';
const src = fs.readFileSync('assets/js/game-stats.js', 'utf8');

function makeEnv({ turnstile = 'ok', fetchMode = 'ok', storage = 'ok' } = {}) {
  const store = new Map();
  const win = {};
  const head = { appendChild(s) {
    setTimeout(() => {
      if (turnstile === 'blocked') return s.onerror && s.onerror();
      win.turnstile = {
        render: (host, opts) => { setTimeout(() => {
          if (turnstile === 'error') opts['error-callback']();
          else if (turnstile !== 'hang') opts.callback('tok');
        }, 1); return 'id'; },
        execute: () => {}, remove: () => {},
      };
      s.onload && s.onload();
    }, 1);
  }};
  const g = {
    window: win, document: {
      head, body: { appendChild(){}, },
      createElement: () => ({ style:{}, remove(){}, onload:null, onerror:null }),
    },
    localStorage: storage === 'ok'
      ? { getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) }
      : { getItem(){ throw new Error('blocked'); }, setItem(){ throw new Error('blocked'); } },
    crypto: { randomUUID: () => 'uuid-aaaaaaaaaaaa' },
    fetch: async (url) => {
      if (fetchMode === 'throw') throw new Error('network down');
      if (fetchMode === 'down') return { ok:false, json: async()=>({}) };
      if (String(url).includes('/stats')) {
        return { ok:true, json: async () => {
          if (fetchMode === 'few') return { enough:false, min:20, source:'players' };
          // A response with counts but no denominator: an older Worker, or a
          // half-deployed one. The page would divide by it, so refuse it.
          if (fetchMode === 'nodenom') return { enough:true, solvers:57, dist:[1,2,3,4,5,6], source:'players' };
          return { enough:true, players:80, solvers:57, dist:[1,2,3,4,5,6], source:'players' };
        } };
      }
      return { ok:true, json: async()=>({ ok:true }) };
    },
    setTimeout, clearTimeout, Promise, JSON, Math, Date, String, Number, Array,
    encodeURIComponent, AbortSignal: { timeout: () => undefined },
    console,
  };
  g.globalThis = g; g.window = win;
  return { g, win };
}

async function run(name, opts, expect) {
  const { g, win } = makeEnv(opts);
  const vm = await import('node:vm');
  vm.createContext(g);
  vm.runInContext(src.replace('window.bhGameStats', 'globalThis.window.bhGameStats'), g);
  const api = win.bhGameStats;
  let reported, statsOut, threw = null;
  try {
    reported = await api.report('guess-the-book', '2026-08-03', 3);
    statsOut = await api.stats('guess-the-book', '2026-08-03');
  } catch (e) { threw = e.message; }
  const ok = threw === null && reported === expect.report &&
             (expect.stats === null ? statsOut === null : statsOut && statsOut.solvers === 57);
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (threw ? '  THREW: ' + threw : `  report=${reported} stats=${statsOut ? 'data' : statsOut}`));
  return ok;
}

const results = [];
results.push(await run('everything works',        {},                        { report:true,  stats:'data' }));
results.push(await run('turnstile blocked',       { turnstile:'blocked' },   { report:false, stats:'data' }));
results.push(await run('turnstile errors',        { turnstile:'error' },     { report:false, stats:'data' }));
results.push(await run('network throws',          { fetchMode:'throw' },     { report:false, stats:null }));
results.push(await run('worker returns 5xx',      { fetchMode:'down' },      { report:false, stats:null }));
results.push(await run('below reporting floor',   { fetchMode:'few' },       { report:true,  stats:null }));
results.push(await run('localStorage disabled',   { storage:'blocked' },     { report:false, stats:'data' }));
results.push(await run('stats missing players',   { fetchMode:'nodenom' },   { report:true,  stats:null }));
console.log('\nfailures:', results.filter(r=>!r).length);
process.exit(results.every(Boolean) ? 0 : 1);
