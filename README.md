# BrowserGBA

A polished, local-first **Game Boy Advance** emulator and personal ROM library that
runs entirely in the browser. Built for people who play Pokémon GBA games and ROM
hacks on a phone or a laptop and want their ROMs, saves, save states and cheats to
stay on their own device.

- **Local-first.** ROMs, battery saves, save states, cheats, screenshots and
  settings live in IndexedDB on your device. Nothing is uploaded, ever.
- **GBA only**, deliberately. No NES/SNES/GB/GBC/DS, no link cable, no BIOS files.
- **Real emulation.** The vendored [mGBA](https://mgba.io/) core (MPL-2.0) runs
  threaded WebAssembly; see [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
- **No ROMs, no BIOS, no cheat databases, no artwork from games.** You bring your
  own files; they are validated before they are stored.

## Try it live

**<https://sumankayal247.github.io/BrowserGBA/>** — the current build, deployed from
this repository by `.github/workflows/deploy-pages.yml`.

Everything works there **except the database-backed community catalog**, because that
part does not exist yet: Phase 7 of [`GAME_PLAN.md`](GAME_PLAN.md) (a MongoDB-backed
metadata service) is unimplemented everywhere, not just on Pages. What you get on
that URL is the whole local app — import a ROM, play, save, export, edit your library.

The site is published by `.github/workflows/deploy-pages.yml` on every push to
`arena` or `main`. Publishing needs Pages turned on once for the repository
(**Settings → Pages → Build and deployment → Source: GitHub Actions**): creating a
Pages site is a repository-admin action, and a workflow token is not allowed to do it.
Until that setting exists the deploy run stops at its `configure-pages` step with a
permissions error, after the install, tests and build have already passed.

One caveat that only applies to hosting like this: GitHub Pages cannot send response
headers, so the first visit is not cross-origin isolated and the emulator refuses to
start. The app's own service worker fixes that by serving the two headers browsers
require; press **Enable playback (reloads once)** — or simply come back later — and
games run. No configuration in the repository is needed for that; see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Status

Phases 0–6 of the plan in [`GAME_PLAN.md`](GAME_PLAN.md) are in place and green:

| Gate | Result |
| --- | --- |
| `npm run typecheck` | clean (TypeScript 7, `strict`) |
| `npm test` | 165 tests across 9 files |
| `npm run build` | 42 modules; `dist/` + service worker with 22 precache entries |
| `npm run test:browser` | 17/17 — real browser, real mGBA core, fixture ROM |
| `npm run test:e2e` | 61/61 — real UI: import → play → screenshot → battery save → export → backup → edit → cheats → remap → duplicate handling → isolation repair → embed refusal → offline |

What is **not** verified is in [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md), which
mirrors the app's own Compatibility screen. In particular: no commercial ROM has
been run in this project, so there is no blanket "your Pokémon hack will work"
claim — the expectation rests on the stock mGBA core, nothing more.

## Requirements

- Node 20.19+ to build.
- A browser with WebAssembly threads, i.e. a **cross-origin isolated** page
  (`Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`). The dev server sets these for you; a host must send them in
  production — and if it cannot, the app's service worker supplies them after one
  reload. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Without them the library
  still works and the app explains why playback is blocked.
- **Chromium and Firefox** are both supported targets: the app avoids
  Chromium-only APIs and picks default shortcuts that Firefox does not claim for
  itself (F5 reloads the page and F9 opens Reader View, so quick save/load are F2/F4
  and screenshots are F8). The automated browser suites run in Chromium; set
  `BROWSERGBA_FIREFOX=/path/to/firefox` to run the same checks in Gecko. Firefox has
  not been run in CI yet — see [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md).

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

Open the app, press **Import ROM**, choose a `.gba` file from your device, then
**Play**. Files are read locally; the app never asks for a network round trip.

```bash
npm run build        # static site in dist/
npm run preview      # serve the build on http://localhost:4173
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | dev server with cross-origin isolation headers |
| `npm run build` | type-check, then build `dist/` and the service worker |
| `npm run preview` | serve the production build locally |
| `npm run check` | `typecheck` + unit tests |
| `npm test` | vitest (happy-dom + fake-indexeddb) |
| `npm run test:browser` | core probe: real Chromium + real mGBA against the fixture ROM |
| `npm run test:e2e` | drives the real UI end to end |
| `npm run rom:fixture` | regenerate `fixtures/test-rom.gba` (original homebrew, MIT) |
| `npm run sync:core` | vendor the mGBA wasm build into `public/mgba/` |
| `npm run lint` | type-check (the lint gate is the type checker) |

The two browser suites need a browser binary — your own, never a download:

```bash
BROWSERGBA_CHROMIUM=/path/to/chrome npm run test:e2e    # Chromium
BROWSERGBA_FIREFOX=/path/to/firefox npm run test:browser  # the same probe in Firefox
```

They use `puppeteer-core` and report what is missing instead of failing when no
browser is found. Firefox is driven over WebDriver BiDi, so the suites stay free of
Chromium-only calls.

## Using it

- **Library** — import, search, tag, favourite, sort, rename, cover art, playtime.
  Duplicate imports are detected by content hash and never silently merged.
- **Editing** — the pencil on any game card opens one editor for the display name,
  cover image, tags, notes and links. Links are yours: paste any address you like.
  The app checks nothing about where a link points — no allow-list, no deny-list, no
  reputation lookup, no network request. The only rule is that a `javascript:`,
  `data:` or `vbscript:` URL is shown as text instead of a clickable link, so a
  pasted string can never run code in the page.
- **Playback** — pixel-perfect 240×160 canvas with integer scaling, optional CRT /
  scanline filters, adjustable normal and fast-forward speeds, hold-to-rewind,
  volume and mute, reset, and a fullscreen mode.
- **Saves** — in-game battery saves plus separate named save-state slots, with
  import/export and backup bundles (JSON, no ROM bytes) for moving between devices.
- **Cheats** — per-game cheat files (GameShark, CodeBreaker, PAR, raw VBA). A code
  the core refuses is skipped and flagged instead of breaking the session, and codes
  can never leak between games.
- **Controls** — remappable keyboard, multi-touch pad with three layouts, optional
  gamepad, and settings for hold behaviour. On a phone in portrait the app says
  that rotating gives a bigger picture; in landscape while a game runs, the app
  chrome steps aside, the game claims the height, and the on-screen controls sit
  beside the screen instead of over it.
- **Storage** — see quota usage, export/import backups, and delete data with a
  clear description of what each option removes.
- **Compatibility** — an honest, live report of what your browser supports and what
  the app does and does not do.

## Privacy

No accounts, no analytics, no telemetry, no remote fonts or scripts. The app makes
no network request outside its own origin. Everything you import stays in your
browser's storage until you export it or delete it.

## Project layout

```
src/            application code (see docs/ARCHITECTURE.md)
tests/          unit tests, plus browser probes under tests/browser/
tools/          icon generator and the original fixture-ROM assembler
docs/           architecture, deployment, compatibility and third-party notices
GAME_PLAN.md    the product plan this repository is being built against
```

## License

MIT for this project (see `LICENSE`). The emulator core is mGBA under the MPL-2.0,
used unmodified through `@thenick775/mgba-wasm`; see
[docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md). BrowserGBA ships no
ROMs, no BIOS files and no copyrighted game artwork, and it will not help you
obtain them.
