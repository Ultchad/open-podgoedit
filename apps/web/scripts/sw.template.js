// Offline shell for the production build.
//
// The Vite plugin in `vite.config.ts` fills in the build id and precache list
// and writes the result to `dist/sw.js`. Everything the app needs is cached
// during install, so one online visit is enough to open the editor offline
// afterwards.
//
// Navigations are network-first so a new deploy is picked up immediately while
// still falling back to the cached page offline. Hashed assets are cache-first
// and refreshed in the background.
//
// The native shells (Android WebView and Tauri) serve the bundle from the
// package itself and never register this worker.

const PREFIX = 'podgo-editor-';
const CACHE = `podgo-editor-__BUILD_ID__`;
const PRECACHE = __PRECACHE__;
const OFFLINE_URL = './';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // A failed fetch rejects the install; the next visit retries. Same-origin
      // static files should all succeed, and a partial cache would be worse
      // than no offline mode.
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // GitHub Pages serves every project from the same origin, so only delete
      // this app's own caches.
      await Promise.all(
        keys
          .filter((key) => key.startsWith(PREFIX) && key !== CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() =>
          caches.match(request, { ignoreVary: true }).then(
            (cached) =>
              cached ||
              caches.match(OFFLINE_URL, { ignoreVary: true }) ||
              caches.match('index.html', { ignoreVary: true }) ||
              Response.error(),
          ),
        ),
    );
    return;
  }

  event.respondWith(
    (async () => {
      // ignoreVary: a response cached from fetch() carries a Vary header;
      // matching on it would miss every reload.
      const cached = await caches.match(request, { ignoreVary: true });
      const network = fetch(request)
        .then(async (response) => {
          if (response.ok) {
            const cache = await caches.open(CACHE);
            await cache.put(request, response.clone());
          }
          return response;
        })
        .catch(() => cached);
      return cached || (await network) || Response.error();
    })(),
  );
});