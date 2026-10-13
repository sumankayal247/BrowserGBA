# Compatibility and verification status

This mirrors what the app itself reports on its **Compatibility** screen
(`src/emulator/compatibility.ts`). The in-app screen is the source of truth for
users; this page exists so the reasoning and the evidence are reviewable, and so
unverified claims stay labelled as unverified.

Levels: **implemented** — works and is covered by automated tests.
**experimental** — expected to work, but not verified against the ROMs you will
try. **unsupported** — deliberately not implemented.

## Emulator core

| Feature | Level | Evidence |
| --- | --- | --- |
| GBA ROM boot and rendering | implemented | Core probe boots a generated fixture ROM and verifies all 38,400 framebuffer pixels against a deterministic pattern (17/17 checks). |
| Battery saves (SRAM/Flash/EEPROM) | implemented | The exported 32 KiB SRAM image contains the byte the fixture wrote (0xA5); the app test asserts those bytes reach IndexedDB. Flash/EEPROM take the same core path but are untested with a real cartridge. |
| Save states | implemented | Probe writes and loads a state; unit tests cover ROM-hash mismatch, foreign-core states and corrupt files. |
| Rewind | implemented | Probe toggles the rewind path; unit tests cover budget clamping and that a hold cannot latch. |
| Real-time clock | implemented | Exposed by the core; no automated clock test (would require a real clock-reading game). |
| User-supplied BIOS | unsupported | The core's high-level BIOS is used instead. No BIOS files are shipped, and the loader is not implemented. |
| Per-game cheats | implemented | Unit tests prove codes are scoped to one game by construction, that a refused code is skipped instead of aborting startup, and that refusal is recorded on the record. |
| Link cable / multiplayer | unsupported | No implementation. |
| Other consoles (NES/SNES/GB/GBC/DS) | unsupported | Import validation rejects non-`.gba` files and non-GBA headers; unit tested. |

## Compatibility expectations

| Feature | Level | Evidence |
| --- | --- | --- |
| Pokémon GBA games and ROM hacks | experimental | **Not verified.** No commercial ROM has been run in this project, and none ever will be in CI. The core is a stock mGBA build, which is the basis for the expectation only. |
| ROM hacks in general | experimental | Import validation enforces the 32 MiB limit and a valid header. Larger hacks, patched-header hacks and hacks that rely on link, RTC or save-type quirks may behave differently. |
| Homebrew and test ROMs | implemented | Unit tested end to end, and the browser fixtures are themselves original homebrew. |

We deliberately make no blanket Pokémon or ROM-hack compatibility claim. Anything
you read about specific games elsewhere is not a statement from this project.

## Platform

| Feature | Level | Evidence |
| --- | --- | --- |
| Cross-origin isolation (required for playback) | implemented | The app-level browser test asserts isolation is granted by the documented headers, and that a framed page explains the block instead of failing. |
| Working on a host that sends no isolation headers | implemented | Four origins are exercised: one with the headers, one with none, one embedding the app cross-origin, and the repository sub-path layout GitHub Pages produces (no headers, app one directory down). The suite asserts the header-less origin starts un-isolated, that the blocked player offers the repair, that after one reload the page reports `crossOriginIsolated` and the game runs with fixture-accurate frames, and that a framed copy is refused rather than offered a repair it could not complete. |
| Browser engines (Chromium, Firefox, Safari) | implemented | No Chromium-only APIs or too-new CSS — a unit test scans the source and the stylesheet and fails if one appears; defaults avoid keys a browser claims (F5/F9); engine detection is unit tested. The automated suites run in Chromium. A Firefox path exists (`BROWSERGBA_FIREFOX=… npm run test:browser`), but no Firefox build was available where this release was prepared, so **Firefox is untested here — not known-bad**. Safari is detected only. |
| Haptic feedback on touch controls | implemented | Unit tests cover the on/off switch and that a missing or refusing implementation is ignored. The pulse itself is manual, and iOS Safari does not implement the API at all. |
| Local library, saves and states | implemented | Unit tests run against a real IndexedDB implementation including quota and failure paths. |
| Per-game metadata editing (name, cover, tags, notes, links) | implemented | The app test drives the pencil button on a card, renames the game, uploads a generated PNG cover, and pastes links — including `steam:` and `javascript:` — then reads IndexedDB back and checks the rendered card and game screen. |
| Installable app + offline shell | implemented | The browser test waits for the worker to reach `activated` and asserts it precached the shell; the build fails on an unsubstituted worker placeholder. |
| Gamepads | implemented | Mapping unit tests. The Gamepad API cannot be driven from an automated test, so hardware use is manual. |
| Multi-touch controls | implemented | Pointer-tracking unit tests. Layout and comfort on real phones is manual — please test on your device. |
| Audio | implemented | The core API is exercised (muted) in the probe. Audible output and mobile autoplay gestures are manual. |
| Cross-device sync | unsupported | No implementation. The boundary is described in ARCHITECTURE.md. |
| Online community catalog | unsupported | No backend, no database, and no network calls from the app. |

## What has actually been run

Commands and their results as of the last verification:

```
npm run typecheck   clean (TypeScript 7, strict)
npm test            165 tests, 9 files, all passing
npm run build       42 modules, dist/ + sw.js with 22 precache entries
npm run test:browser  17/17 checks (real Chromium + real mGBA core)
npm run test:e2e      67/67 checks (real UI: import → play → save → export → backup → edit →
                      cheat → remap → duplicate import → three-origin isolation/embed →
                      repository sub-path on a header-less host → offline)
```

The browser suites need a browser binary (`BROWSERGBA_CHROMIUM=/path/to/chrome`, with
`BROWSERGBA_FIREFOX=/path/to/firefox` to run the same checks in Gecko) and skip
themselves with an explanation when none is present, rather than failing a build for
an unrelated reason.

Not verified anywhere yet, and therefore not claimed: **Firefox** (the harness path
exists but has not been run — see the table above), performance on low-end phones,
iOS Safari specifics, iPad split-view, Bluetooth gamepads, screen readers, haptic
hardware, and any particular commercial game. The keyboard, mouse and touch paths
are covered by unit tests and by driving the real UI.

## Known limitations

- The core's save flush is lazy: mGBA writes a `.sav` only after save data settles
  for a few frames. A ROM that wrote on every single frame would never produce a
  file. Real games save once and then stop, so this matches how games behave; the
  fixture is written the same way.
- Cheat codes are parsed as text and never executed as code. Codes the core
  refuses are skipped, marked on the record, and reported to the user.
- Importing the same file twice raises a duplicate prompt rather than silently
  creating a second entry; the second copy shares the same content hash, so saves,
  states and cheats stay attached to one identity.
