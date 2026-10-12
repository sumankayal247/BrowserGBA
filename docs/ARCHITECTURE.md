# Architecture

BrowserGBA is a local-first Game Boy Advance emulator and personal ROM library
that runs entirely in the browser. Nothing leaves the device unless the user
explicitly exports a file.

```
main.ts            app shell, routing, toast/dialog host
├─ app/            app.ts (shell + views + environment), settings.ts, player.ts (session controller)
├─ ui/             dom.ts, toast.ts, dialog.ts, views/{library,player,game,settings,storage,compatibility}.ts
├─ library/        library.ts — import, querying, play sessions, deletion
├─ storage/        db.ts, records.ts, ids.ts, hash.ts, quota.ts, support.ts, backup.ts, covers.ts
├─ rom/            hash.ts, header.ts, validate.ts — untrusted-input parsing
├─ emulator/       environment.ts, core.ts, mgba-adapter.ts, session.ts, compatibility.ts
├─ cheats/         cheats.ts — parsing and validation of user cheat text
├─ render/         display.ts — integer scaling, filters, fullscreen
├─ input/          bindings.ts — keyboard/gamepad/touch mapping
└─ pwa/            register.ts, sw-template.js
```

## Layers and the boundaries between them

**`rom/`** parses files the user chose. Everything it returns is treated as
untrusted: sizes are bounded (32 MiB), the header is validated structurally, the
title is sanitised, and ROM text is never rendered as HTML. Nothing is executed.

**`storage/`** owns IndexedDB. It is the only module that touches the database.
Every transaction goes through `transact`/`request`, which translate browser
errors (`QuotaExceededError`, `VersionError`, …) into typed `StorageError`s with
messages written for a person. Schema changes are append-only migrations; version
1 creates the original stores, version 2 adds `covers`.

**`library/`** is the domain layer: it decides what "import", "duplicate",
"remove" and "play session" mean, and it is what the UI calls. It holds no DOM
and no storage details.

**`emulator/`** wraps the vendored mGBA build. `core.ts` defines the narrow
interface the app depends on (`EmulatorCore`), `mgba-adapter.ts` implements it
against the real module, and `session.ts` is the state machine on top: load,
pause, save, state slots, screenshots, cheats, speed, rewind, teardown. The core
is loaded at runtime from `/mgba/mgba.js` — never bundled — because its pthread
worker resolves `new URL('mgba.js', import.meta.url)`.

## Data model

| Store | Key | Contents |
| --- | --- | --- |
| `games` | `g_<hash prefix>` | title, header, size, hashes, tags, playtime, favourite, cover id |
| `roms` | gameId | the ROM bytes (the only place they are stored; never in `localStorage`) |
| `batterySaves` | id | cartridge save images, per game, with size/hash/timestamp |
| `saveStates` | id | state slots (`slot: 0` is quick save), thumbnail, ROM hash, core version |
| `cheats` | id | one row per code with its game id, format, enabled flag, rejection history |
| `screenshots` | id | native 240×160 PNGs with a downscaled thumbnail |
| `covers` | gameId | user-chosen artwork, kept separate from game metadata |
| `settings` | key | single record holding app/control/session/touch settings |

Structured-clone types are used throughout, so PNG blobs stay blobs and save
bytes stay bytes — no base64 in the hot path (backup bundles do use base64, since
they are JSON files meant to be portable).

**Game identity is the content hash**, not a path or a name. Saves, states and
cheats are keyed by `gameId`, which is derived from the ROM's SHA-256, so progress
cannot be attached to the wrong game even if two files share a title.

## Session lifecycle

`EmulatorSession.start()` loads the core, writes the ROM into its filesystem,
loads the cartridge, applies settings, writes the per-game cheat file and starts
the main loop. `stop()` flushes the battery save, pauses, and releases the core.

Notable decisions:

- **Cheats are per game, by construction.** Each game gets its own cheat file
  named after its ROM, and the core only reads the file belonging to the loaded
  cartridge. A code that the core rejects is dropped from the file, marked on its
  record with the reason, surfaced to the user, and never prevented the game from
  starting. This is the "isolation proven by tests" requirement: refusing one
  game's code must never affect another game.
- **Battery saves settle.** The core flushes a `.sav` only once writes stop for a
  few frames (`GBASavedataClean` in mGBA's `savedata.c`). The fixture ROM writes
  `0xA5` to SRAM exactly once at boot *because* of this, and the tests assert the
  exported bytes contain it — a ROM that wrote every frame would never produce a
  file, which is a property of the core, not of the app.
- **Save states and battery saves are separate stores** and never overwrite each
  other. Importing a state validates the ROM hash and the core version first.
- **Rewind is bounded** by a configurable buffer; it is opt-in because it costs
  memory on mobile.

## Cross-origin isolation

`environment.ts` probes the browser (wasm, `SharedArrayBuffer`, isolation, WebGL,
IndexedDB, audio, gamepad, touch, embedding, secure context) and produces a
report with *blocking* and *advisory* issues. The player refuses to start on a
blocking issue and explains it; the compatibility screen renders the same report.
See [DEPLOYMENT.md](DEPLOYMENT.md) for the headers that make isolation possible.

## Testing layers

| Layer | Runs | Covers |
| --- | --- | --- |
| `tests/*.test.ts` (vitest + happy-dom + fake-indexeddb) | `npm run test` | validation, storage, library, cheats, session state machine, bindings |
| `tests/browser/run-smoke.mjs` + `boot.html` | `npm run test:browser` | the real comp
iled core: boot, framebuffer, input, saves, states, rewind |
| `tests/browser/run-app.mjs` | `npm run test:e2e` | the real UI in a real browser: import → play → screenshot → save → cheat → remap → offline shell |

The browser suites need a Chromium binary (`BROWSERGBA_CHROMIUM=/path/to/chrome`,
falling back to `/tmp/chromium` and system paths) and skip themselves with an
explanation when none is available. They never download a browser.

## Extension points (not implemented)

- **Community catalog (Phase 7)**: would be a separate backend API. The browser
  must never hold database credentials, and no catalog call exists in the code.
- **Sync (Phase 8)**: `storage/` already treats the local database as the source
  of truth; a sync layer would sit behind an interface, never inside the views.

Both are listed as `unsupported` in `emulator/compatibility.ts` so the app's own
capability screen cannot drift from reality.
