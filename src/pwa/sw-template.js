/**
 * BrowserGBA service worker template.
 *
 * Vite substitutes two build-time placeholders in this file: the cache-version
 * constant (a fresh id per build, so old caches are discarded) and the precache
 * manifest (the list of built shell assets). The placeholders are spelled out
 * only in the two `const` declarations below — never in prose, because the
 * substitution is a plain string replace and a second mention would be rewritten
 * instead of the real one (which is how the worker once shipped broken).
 *
 * What is cached: the app shell, its styles, icons and the emulator core's
 * JavaScript. What is *not* cached: `mgba.wasm` (cached on first use so the
 * first paint is not blocked by a ~2 MB download) and absolutely no user data.
 * ROMs, battery saves, save states, cheats, screenshots and settings live in
 * IndexedDB, which the HTTP cache cannot see — so clearing this cache never
 * destroys progress.
 *
 * Requests to other origins are never intercepted or cached, so the app cannot
 * become an accidental proxy for third-party content.
 */

const CACHE_VERSION = '__CACHE_VERSION__';
const PRECACHE_MANIFEST = __PRECACHE_MANIFEST__;

const CACHE_NAME = `browsergba-${CACHE_VERSION}`;
const RUNTIME_CACHE = `browsergba-runtime-${CACHE_VERSION}`;

/** Core binaries are large; fetch them on first use rather than at install. */
const RUNTIME_ASSETS = ['./mgba/mgba.js', './mgba/mgba.wasm'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Precache entry by entry: one missing file must not abort the install.
      await Promise.all(
        PRECACHE_MANIFEST.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }));
          } catch (error) {
            console.warn('[BrowserGBA sw] Could not precache', url, error);
          }
        }),
      );
      // Take over as soon as possible: the shell is versioned by cache name.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
  if (event.data === 'clear-caches') {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      })(),
    );
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;

  // Only GETs to our own origin are handled. Everything else goes straight to
  // the network, untouched — the app has no third-party dependencies at runtime
  // and this keeps it that way.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Cross-origin isolation needs opaque-response-free fetches; let the browser
  // handle range requests and navigation requests normally.
  if (request.headers.has('range')) return;

  event.respondWith(handleRequest(request));
});

async function handleRequest(request) {
  const url = new URL(request.url);

  // Navigations: network first so a new build is picked up, cache as backup.
  if (request.mode === 'navigate') {
    try {
      const response = await fetch(request);
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = (await caches.match(request)) ?? (await caches.match('./index.html'));
      if (cached) return cached;
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Offline</title><p>BrowserGBA could not load. Reconnect once to make it available offline.',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
  }

  // Core binaries: cache first, then fill the runtime cache on first use.
  if (RUNTIME_ASSETS.some((asset) => url.pathname.endsWith(asset.replace('./', '/')))) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  }

  // Everything else in the shell: cache first, revalidate in the background.
  const cached = await caches.match(request);
  if (cached) {
    if (navigator.onLine) {
      void (async () => {
        try {
          const fresh = await fetch(request);
          if (fresh.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(request, fresh.clone());
          }
        } catch {
          /* offline: the cached copy stands */
        }
      })();
    }
    return cached;
  }

  try {
    const response = await fetch(request);
    return response;
  } catch (error) {
    return new Response('Offline and not cached.', { status: 504, statusText: 'Offline' });
  }
}
