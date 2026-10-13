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
unavailable, and the core cannot start. BrowserGBA detects this before mounting the
player and explains it in the UI rather than failing with a blank screen.

Sending them from the host is the right answer, and it is what you should do whenever
you can. It is not the only one, though: if the host cannot be configured (GitHub
Pages, an internal file server, a deployment you do not control), the app's own
service worker supplies the same two headers on the responses it answers with, which
makes the page isolated after a single reload. That mechanism is documented under
[Hosts that cannot send headers](#hosts-that-cannot-send-headers) below, and it is
covered by tests rather than assumed.

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

**GitHub Pages cannot set headers** — see the next section, which is what this
project's own deployment at <https://sumankayal247.github.io/BrowserGBA/> relies on.

## Hosts that cannot send headers

A host that sends no headers still produces a fully playable site. The trick is that
the app already registers a service worker for offline support, and a response that
comes *from a service worker of the same origin* counts as a network response for
isolation purposes: if it carries `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, the document it delivers is
cross-origin isolated. This is verified by automated tests (`npm run test:e2e`), not
assumed: the suite runs one origin with the headers, one with none, and one
embedding the app cross-origin, and asserts what each one can do.

The sequence on a header-less host:

1. **First visit** — the page is not isolated, so the emulator refuses to start. The
   library, imports, exports and settings all work. The player shows
   *“This page is not cross-origin isolated”* with a button,
   **Enable playback (reloads once)**; the Compatibility screen offers the same
   action as **Take over now (reloads once)**.
2. **Pressing the button** waits for the worker to become the active controller of
   this page (reloading before that would produce another non-isolated document and
   waste the click), then reloads once.
3. **Second visit** — every response now carries the headers, the document is
   isolated, `SharedArrayBuffer` exists, and the game runs. Nothing is asked of the
   user in the normal case: the worker was installed on the first visit, so coming
   back later is enough.

BrowserGBA never reloads the page on its own. There is no auto-repair, no redirect
loop, and no state is touched: the worker changes response headers only, and the
headers it adds are the ones a correctly configured host would have sent anyway.

Limits worth knowing:

- **A frame can never be isolated.** Browsers do not grant cross-origin isolation to
  a nested document, whatever headers arrive, so inside an `<iframe>` on someone
  else's site the app says exactly that and offers *Open in a new tab* instead of
  pretending to fix it. The library, imports and exports still work in the frame.
- **HTTPS (or localhost) is required**, because a worker cannot be registered
  otherwise. On plain HTTP from a non-local origin nothing can help, and the app
  says so.
- **Nothing else on the origin is affected**, and nothing outside it is: the worker
  only intercepts same-origin requests, and `docs/ARCHITECTURE.md` records that
  third-party requests are passed through untouched.

## GitHub Pages deployment

`.github/workflows/deploy-pages.yml` builds and publishes the site. It runs on
pushes to `arena` and `main`, and can be started by hand from the Actions tab
(`workflow_dispatch`). It runs `npm ci`, then `npm run check` (type-check + unit
tests) before `npm run build`, so a red build never reaches the published site, and
uploads `dist/` with `actions/upload-pages-artifact@v4` for
`actions/deploy-pages@v4`.

Creating a Pages site through the API needs repository-admin rights, and a workflow's
`GITHUB_TOKEN` does not have them: `POST /repos/{owner}/{repo}/pages` answers
*"Resource not accessible by integration"*. The workflow therefore **checks first**.
If the repository has no Pages site it says so as a run warning, skips
`configure-pages` and the deploy job, and finishes green — install, tests and build
all still run and are still reported, so a genuine test failure is never hidden behind
this. `enablement: true` is kept on `configure-pages` for repositories whose token is
allowed to create the site, where the step below is unnecessary.

For this repository the one-time step is therefore an admin action:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Re-run the workflow (Actions → Deploy to GitHub Pages → Re-run jobs), or push
   anything to `arena`/`main`. The next run finds the site, runs
   `configure-pages`, uploads `dist/` and publishes it.

The site then lives at `https://<user>.github.io/<repo>/` — for this repository,
<https://sumankayal247.github.io/BrowserGBA/>. `enablement: true` stays in the
workflow because it does work in repositories whose token is allowed to create the
Pages site, which makes the setting step unnecessary there.

Because Pages cannot send response headers, the deployed site is the case described
above: the first visit registers the worker and everything except playback works,
and playback follows on the next visit or immediately via the button. `base: './'`
in `vite.config.ts` means the same build works at the root of a domain and in a
repository sub-path — and the end-to-end suite serves `dist/` one directory down on a
header-less origin to prove both halves of that sentence, including that the worker's
scope stays inside the sub-path instead of claiming the whole domain.

## If the site loads but shows nothing

A blank page on a self-hosted deployment is nearly always one of two hosting mistakes,
and both are now reported in the page itself rather than left as an empty screen.

**The host is serving the repository instead of the build.** The repository's own
`index.html` is a *development* shell: it asks the browser for `/src/main.ts`, which a
static host does not transform, so nothing runs. This is what a `legacy` Pages site
does — with **Source: Deploy from a branch**, GitHub serves the branch root, which is
why the first deployment of this project rendered exactly one link (`Skip to main
content`) and a 404 for `/src/main.ts`. Fix it by pointing the host at the build:

- GitHub Pages: **Settings → Pages → Build and deployment → Source: GitHub Actions**
  (or, if you must stay on a branch, publish a `gh-pages` branch containing `dist/`).
- Any other static host: upload/serve `dist/`, not the repository root.

The dev shell now detects this itself: if the module script fails to load and nothing
has mounted, it replaces the empty page with the explanation and the exact setting to
change. `npm run test:e2e` serves the repository at `/devshell/` and asserts that
message appears (and that a correctly built deployment never shows it).

**The app started but the emulator is blocked.** That is the isolation notice
described above, not a blank page — playback needs the headers or one reload, and the
library keeps working meanwhile.

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

The worker also answers with the isolation headers when the host does not supply
them (see [Hosts that cannot send headers](#hosts-that-cannot-send-headers)). Two
invariants follow, and `npm run test:e2e` asserts both: the worker must reach
`activated` — a worker that throws during evaluation installs as "registered but
never active", which looks fine and isolates nothing — and the responses it returns
must actually carry `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The template documents why the
isolation headers are only set on responses it produced itself (opaque and 3xx/204
responses are passed through untouched, since they cannot carry headers and cannot be
a document anyway).

The build **fails** if a placeholder is left unsubstituted. That guard exists
because a worker that throws during evaluation installs as "registered but never
active": the app looks fine and simply never works offline. `npm run test:e2e`
now waits for the worker to reach `activated` and asserts it precached something,
so this cannot silently regress again. Spelled-out placeholders must therefore only
appear in the two `const` declarations at the top of the template.

## Releasing a new version

1. `npm run check` (type-check + unit tests), then `npm run test:browser` and
   `npm run test:e2e` with a browser available (`BROWSERGBA_CHROMIUM`, or
   `BROWSERGBA_FIREFOX` to run the same checks in Gecko).
2. `npm run build`.
3. Deploy `dist/` with the headers above, or push to `arena`/`main` and let the
   Pages workflow publish it.
4. The service worker version is derived from the build time, so returning users
   get the new shell on the next load; nothing needs to be invalidated by hand.

## Offline behaviour

With the shell cached, the app opens with no network at all: the library, saves,
states, cheats and backups are all local. The core's `mgba.wasm` must have been
fetched at least once for playback to work offline.
