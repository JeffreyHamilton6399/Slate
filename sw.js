/* Slate service worker — minimal, just enough to satisfy PWA install
   criteria (and offer light offline support for the app shell). The
   collaborative bits run live over WebRTC, so we only cache the static
   shell and let everything else fall through to the network. */

const CACHE_VERSION = 'slate-shell-v5';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './sfx.js',
  './layout-dock.js',
  './features.js',
  './notes.js',
  './editor3d.js',
  './fbx-export.js',
  './model-io.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(SHELL).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* Network-first for navigations (so users always get the latest HTML),
   stale-while-revalidate for same-origin static assets, and pass-through
   for everything else (peerjs, fonts CDN, etc.). */
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Don't try to intercept the peer signaling endpoint.
  if (url.pathname.startsWith('/peerjs')) return;
  if (url.pathname.startsWith('/health'))  return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(resp => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      const fetcher = fetch(req)
        .then(resp => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then(c => c.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() => cached);
      return cached || fetcher;
    })
  );
});

self.addEventListener('message', e => {
  if (e?.data?.type === 'skip-waiting') self.skipWaiting();
});
