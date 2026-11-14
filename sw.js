// EZ Records service worker: keeps the app working with no signal.
// Bump VERSION whenever any app file changes so phones pick up the update.
const VERSION = 'ez-records-v2';
const FILES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-512.png',
];
// The map library comes from this CDN; keep a copy so the map code loads offline too.
const LIBRARY_HOST = 'https://unpkg.com';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'ez-records-lib').map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map library: cache first (the version is pinned, so it never changes).
  if (url.origin === LIBRARY_HOST) {
    event.respondWith(
      caches.open('ez-records-lib').then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
        return res;
      }))),
    );
    return;
  }
  if (url.origin !== self.location.origin) return;

  // App files: network first (so updates show up when online), falling back to the cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))),
  );
});
