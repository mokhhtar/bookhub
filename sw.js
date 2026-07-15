---
# layout: null — the site-wide default layout would wrap this JS in HTML.
layout: null
permalink: /sw.js
---
// Litheca service worker.
// VERSION is stamped from the Jekyll build time, so every push to main ships
// a byte-different sw.js → browsers install the new worker and the activate
// step below drops all previous caches. No manual version bumping.
const VERSION = "bh-{{ site.time | date: '%s' }}";
const HTML_CACHE = VERSION + "-html";
const ASSET_CACHE = VERSION + "-assets";

self.addEventListener("install", (e) => {
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith("bh-") && !k.startsWith(VERSION))
        .map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Same-origin only. Firebase/gstatic/the API manage their own caching
  // (auth traffic must NEVER be intercepted; the API now sends real
  // Cache-Control headers that the normal HTTP cache honors).
  if (url.origin !== location.origin) return;

  // Pages: network-first so a deploy is visible on the next load, with the
  // cached copy as an offline / flaky-connection fallback.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(HTML_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static assets (CSS/JS/fonts/images — all cache-busted or immutable):
  // stale-while-revalidate → instant paint from cache, silent refresh behind.
  if (["style", "script", "font", "image"].includes(req.destination)) {
    e.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        const refresh = fetch(req)
          .then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || refresh;
      })
    );
  }
});
