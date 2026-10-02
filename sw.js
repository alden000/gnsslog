// Service worker: offline app shell (cache-first, versioned) + runtime cache for fonts.
// Uploads (POST) and any other cross-origin request are never intercepted.

const VERSION = 'gnsslog-v0.8.4';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/attitude.js',
  'js/compat.js',
  'js/db.js',
  'js/deviation.js',
  'js/export.js',
  'js/filters.js',
  'js/fusion.js',
  'js/geo.js',
  'js/haptics.js',
  'js/maptiles.js',
  'js/native.js',
  'js/recorder.js',
  'js/sensors.js',
  'js/settings.js',
  'js/still.js',
  'js/sync.js',
  'js/visualizer.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];
const FONT_CACHE = 'gnsslog-fonts';
const TILE_CACHE = 'gnsslog-tiles';
const TILE_HOSTS = /(^|\.)(server\.arcgisonline\.com|tiles\.openseamap\.org)$/;
const TILE_LIMIT = 3000; // ~30-60 MB; oldest are dropped first
let tilePuts = 0;

async function trimTiles(cache) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - TILE_LIMIT; i++) await cache.delete(keys[i]);
}

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== VERSION && k !== FONT_CACHE && k !== TILE_CACHE) await caches.delete(k);
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

  // Map tiles: cache-first so tiles already viewed still show offline (e.g. at sea).
  if (TILE_HOSTS.test(url.hostname)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) {
          await c.put(req, res.clone());
          if (++tilePuts % 100 === 0) trimTiles(c);
        }
        return res;
      }),
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Network first, so online navigations always get the real response (redirects, other pages
    // on the same domain). The cached app shell is only the fallback for the app's own page, used
    // offline or when the network is too slow. Only the app's own page is ever stored as the shell:
    // storing any in-scope navigation made unrelated pages on a shared domain show up as the app.
    const scope = new URL(self.registration.scope);
    const shell = new URL('index.html', scope).href;
    const isAppPage = url.pathname === scope.pathname || url.href.split(/[?#]/)[0] === shell;
    e.respondWith(
      (async () => {
        const net = fetch(req).then((res) => {
          if (isAppPage && res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(shell, copy));
          }
          return res;
        });
        const cached = isAppPage ? await caches.match(shell) : null;
        if (!cached) return net;
        const slow = new Promise((resolve) => setTimeout(() => resolve(null), 3000));
        try {
          return (await Promise.race([net, slow])) || cached;
        } catch {
          return cached; // offline
        }
      })(),
    );
    return;
  }

  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
