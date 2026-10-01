// Service worker: offline app shell (cache-first, versioned) + runtime cache for fonts.
// Uploads (POST) and any other cross-origin request are never intercepted.

const VERSION = 'gnsslog-v0.1.0';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/attitude.js',
  'js/db.js',
  'js/export.js',
  'js/filters.js',
  'js/fusion.js',
  'js/geo.js',
  'js/recorder.js',
  'js/sensors.js',
  'js/settings.js',
  'js/sync.js',
  'js/visualizer.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const FONT_CACHE = 'gnsslog-fonts';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== VERSION && k !== FONT_CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONT_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch {
          return new Response('', { status: 504 });
        }
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // App shell for navigations, refreshed in the background.
    e.respondWith(
      caches.match('index.html').then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res.ok) caches.open(VERSION).then((c) => c.put('index.html', res.clone()));
            return res;
          })
          .catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
