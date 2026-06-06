/* Dream service worker — offline caching of the app shell. */
const CACHE = 'dream-v4';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './supabase-config.js',
  './manifest.webmanifest',
  './icon.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for our own assets, network fallback for everything else.
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  e.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(resp => {
      // Cache same-origin successful responses for next time.
      if (resp.ok && new URL(request.url).origin === self.location.origin) {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
      }
      return resp;
    }).catch(() => cached))
  );
});
