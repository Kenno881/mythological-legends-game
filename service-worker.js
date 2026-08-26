// Basic app-shell service worker — makes "Add to Home Screen" behave like a
// real installed app (works from a cold cache, no browser chrome flash).
// Deliberately simple: no offline gameplay support (this is a live
// multiplayer game over WebSocket, useless without a connection anyway),
// just enough caching to make install/launch feel instant.
const CACHE_NAME = 'camelot-shell-v1';

const SHELL_FILES = [
  '/',
  '/camelot-crawler.html',
  '/manifest.json',
  '/css/style.css',
  '/js/data.js',
  '/js/audio.js',
  '/js/net.js',
  '/js/input.js',
  '/js/render.js',
  '/js/main.js',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  // Take over immediately rather than waiting for every open tab of this
  // app to fully close first (the normal SW lifecycle) — a new deploy
  // should win as soon as the page is next reloaded, not "whenever the
  // player eventually force-quits their phone app." Paired with
  // clients.claim() below in activate.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  const isImage = req.destination === 'image';
  if (isImage) {
    // Sprites/icons rarely change once shipped — cache-first is safe and fast.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // HTML/CSS/JS: network-only, deliberately no cache fallback (removed
  // 2026-08-26 — a real incident, not theoretical). The original
  // "network-first, cache as an offline fallback" design had a live bug:
  // ANY network hiccup — not just being fully offline — silently served
  // a stale cached bundle with zero indication anything was wrong. On a
  // installed Android PWA, that meant old client-side game logic (missing
  // wall rendering, no knowledge of ability level-gating) running against
  // the current server, which just silently rejects what the stale client
  // doesn't know it needs to ask for correctly — every symptom of a real
  // bug with none of the visibility. This is a live multiplayer game over
  // WebSocket anyway (per the file-top comment) — genuinely offline was
  // always going to mean unplayable, so there's no scenario where serving
  // a version-mismatched stale bundle is actually better than just
  // failing the request and letting the browser/player know to retry.
  event.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
      return res;
    })
  );
});
