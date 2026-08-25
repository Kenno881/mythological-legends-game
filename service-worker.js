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
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
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

  // HTML/CSS/JS: network-first so a fresh deploy is never stuck behind a
  // stale cached copy of the game's own code; cache is just the offline/
  // slow-connection fallback.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});
