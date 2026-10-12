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
 *
 * The worker also *supplies* the cross-origin isolation headers when the host does
 * not. The emulator core is threaded and needs SharedArrayBuffer, which browsers
 * only grant to an isolated document, and some hosts (notably GitHub Pages) cannot
 * send response headers at all. A service worker can set them on the responses it
 * returns, which makes such a host fully playable: the first visit registers the
 * worker and reloads once, and from then on every response carries the headers.
 * On a host that already sends them this is a no-op.
 */

const CACHE_VERSION = '__CACHE_VERSION__';
const PRECACHE_MANIFEST = __PRECACHE_MANIFEST__;

const CACHE_NAME = `browsergba-${CACHE_VERSION}`;
const RUNTIME_CACHE = `browsergba-runtime-${CACHE_VERSION}`;

/** Core binaries are large; fetch them on first use rather than at install. */
const RUNTIME_ASSETS = ['./mgba/mgba.js', './mgba/mgba.wasm'];

/** The headers a top-level document needs before browsers expose SharedArrayBuffer. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Returns the response with the isolation headers set.
 *
 * A response the browser already produced stays usable: the headers are copied and
 * the body streamed into a new response, which is what lets the isolation work on a
 * host that sends none. Opaque and body-less statuses are passed through untouched —
 * they cannot carry headers and cannot be a document anyway.
 */
function withIsolationHeaders(response) {
  if (!response || response.type === 'opaque' || response.type === 'opaqueredirect') return response;
  if (response.status < 200 || response.status === 204 || response.status === 205 || response.status === 304) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

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
  // Lets the page confirm the worker is answering before it reloads itself for
  // isolation; see src/pwa/register.ts.
  if (event.data === 'ping') event.source?.postMessage('pong');
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

  event.respondWith(handleRequest(request).then(withIsolationHeaders));
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
