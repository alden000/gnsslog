// Analyser service worker: the app shell works offline (data needs the hub), map tiles are
// cached like in the phone app. API calls always go to the network.
const VERSION = 'gnsslog-analyzer-v1';
const SHELL = [
  '/',
  '/hub/web/app.css',
  '/hub/web/js/main.js',
  '/hub/web/js/palette.js',
  '/hub/web/js/painter.js',
  '/hub/web/js/data.js',
  '/hub/web/js/stats.js',
  '/hub/web/js/formats.js',
  '/hub/web/js/trackview.js',
  '/hub/web/js/charts.js',
  '/hub/web/js/scrub.js',
  '/hub/web/js/exporter.js',
  '/js/geo.js',
  '/js/maptiles.js',
  '/icons/icon.svg',
];
const TILES = 'gnsslog-analyzer-tiles';
const TILE_HOSTS = /(^|\.)arcgisonline\.com$|(^|\.)openseamap\.org$/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== TILES && k.startsWith('gnsslog-analyzer')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(
      caches.open(TILES).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  if (url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ingest') return;
  // Network first so updates show at once; the cache covers a hub that is offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/'))),
  );
});
