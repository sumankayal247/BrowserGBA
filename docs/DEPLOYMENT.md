# Deploying BrowserGBA

BrowserGBA is a static site: `npm run build` writes a self-contained `dist/` that
any static host can serve. The only unusual requirement is
**cross-origin isolation**, because the emulator core is threaded and needs
`SharedArrayBuffer`.

## The headers that matter

Every HTML response (and every response the page loads) must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without them `window.crossOriginIsolated` is `false`, `SharedArrayBuffer` is
unavailable, and the core cannot start. BrowserGBA detects this before mounting
the player and explains it in the UI rather than failing with a blank screen —
but playback is genuinely impossible, so treat the headers as mandatory.

Consequences to keep in mind:

- **Every subresource must be same-origin or send `Cross-Origin-Resource-Policy`**
  (`cross-origin` for fonts/CDNs you legitimately need). BrowserGBA ships no
  third-party runtime dependencies, so in practice this is a non-issue.
- **An iframe cannot be cross-origin isolated.** COOP/COEP on the framed document
  is not enough; the whole ancestor chain must be isolated too. BrowserGBA detects
  the embedded case, says so in plain language, and offers "Open in a new tab".
  Library, imports, exports and backups keep working in that frame.

`vite.config.ts` sets these headers for `npm run dev` and `npm run preview`, so
localhost always behaves like a correctly configured host.

## Host recipes

**Netlify** — `public/_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

**Vercel** — `vercel.json`:

```json
{ "headers": [{ "source": "/(.*)", "headers": [
  { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
  { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
]}]}
```

**nginx**:

```nginx
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
types { application/wasm wasm; }
location = /sw.js { add_header Cache-Control "no-cache"; }
```

**Caddy**:

```
header {
  Cross-Origin-Opener-Policy same-origin
  Cross-Origin-Embedder-Policy require-corp
}
header /sw.js Cache-Control "no-cache"
```

**GitHub Pages cannot do this.** It does not let you set response headers, so a
project hosted there will load the library but cannot play games. Use a host with
header support (or a service worker that synthesises the headers — do not do that;
the browser trusts the network response, not the worker's, for isolation).

## MIME types and caching

| File | Requirement |
| --- | --- |
| `*.wasm` | `application/wasm` (streaming compilation is much faster) |
| `*.js` | `text/javascript` |
| `sw.js` | served from the site root, `Cache-Control: no-cache` so updates are picked up |

Hashed assets under `dist/assets/` are content-addressed and can be cached for a
year. `index.html` should be `no-cache` (or short-lived) so a new build is seen.

## The service worker

`npm run build` emits `dist/sw.js` from `src/pwa/sw-template.js`, substituting a
per-build cache version and the precache manifest. It caches the shell, the icons
and `mgba.js`; `mgba.wasm` (~1.8 MB) is cached on first use so the first paint is
not blocked by it.

**ROMs, battery saves, save states, cheats, screenshots and settings are never
cached** — they live in IndexedDB, which the cache cannot see. Clearing site data
or bumping the cache version can never destroy progress.

The build **fails** if a placeholder is left unsubstituted. That guard exists
because a worker that throws during evaluation installs as "registered but never
active": the app looks fine and simply never works offline. `npm run test:e2e`
now waits for the worker to reach `activated` and asserts it precached something,
so this cannot silently regress again. Spelled-out placeholders must therefore only
appear in the two `const` declarations at the top of the template.

## Releasing a new version

1. `npm run check` (type-check + unit tests), then
   `npm run test:browser` and `npm run test:e2e` with a Chromium binary available.
2. `npm run build`.
3. Deploy `dist/` with the headers above.
4. The service worker version is derived from the build time, so returning users
   get the new shell on the next load; nothing needs to be invalidated by hand.

## Offline behaviour

With the shell cached, the app opens with no network at all: the library, saves,
states, cheats and backups are all local. The core's `mgba.wasm` must have been
fetched at least once for playback to work offline.
