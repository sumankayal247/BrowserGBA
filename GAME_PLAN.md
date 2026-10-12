# BrowserGBA — Game Plan

> **Project goal:** Build a polished, reliable, mobile-friendly, browser-based **Game Boy Advance (GBA) emulator and personal game library**, with Pokémon GBA games and ROM hacks as priority use cases.
>
> **Scope rule:** GBA only for the initial release. Do not add NES, SNES, GB/GBC, DS, or other console support unless the project owner explicitly changes scope.
>
> **For coding agents:** Treat this document as the product direction and implementation checklist. First inspect the repository, its `AGENTS.md`, `README.md`, existing architecture, tests, and current work before making changes. Preserve working code and conventions. Implement in small, testable increments; do not claim a feature works until it is implemented and verified.

---

## 1. Product vision

Create a personal retro gaming hub that runs GBA games in a modern browser. Users can import their own legally obtained `.gba` ROM files, keep a tidy library, launch any game, save and restore progress, configure emulator behavior, and use the app on desktop or mobile.

The experience should feel like a purpose-built retro handheld library rather than a bare emulator demo.

### Core principles

1. **GBA-first:** Every initial-release decision should prioritize GBA compatibility and usability.
2. **Local-first and privacy-first:** ROMs, save data, states, cheat configurations, and library metadata stay on the user's device by default.
3. **No ROM distribution:** Never bundle, host, scrape, or provide copyrighted commercial ROMs. Users import their own files. Homebrew/test ROMs may be used when their license permits it.
4. **Never lose progress silently:** Show save status, handle storage failures, and offer exportable backups.
5. **Mobile and desktop are first-class:** Responsive layout, touch controls, keyboard controls, and gamepad support where practical.
6. **Honest compatibility:** Distinguish implemented, tested, experimental, and unsupported features.
7. **Build on the existing project:** Inspect the current codebase and reuse or improve existing emulator, rendering, UI, persistence, and test infrastructure instead of duplicating it.

## 2. Repository-first instructions for agents

Before coding:

- Read `AGENTS.md`, `README.md`, `package.json`, and any existing project plans or architecture notes.
- Inspect the existing source tree, emulator core or core adapter, UI entry points, storage implementation, test scripts, CI workflows, and current issues/tasks.
- Run the existing fast test/lint/type-check/build commands and record the baseline.
- Identify whether a GBA core already exists and what license applies to it. Preserve upstream copyright and license notices.
- Write a short implementation proposal describing what can be reused, gaps, risks, and the smallest safe first increment.
- Do not replace the emulator core, framework, or build setup merely for preference. Propose a migration only if there is a concrete technical reason.
- If the repository has an agent task queue or locking workflow, follow it exactly and update its status files as required.
- Do not commit ROMs, BIOS files, copyrighted artwork, personal saves, secrets, or test data derived from commercial games.

## 3. Main application areas

### A. Game library

Provide a home/library screen with:

- Import ROM button and drag-and-drop on desktop.
- Accept `.gba` files initially; validate file size, extension, and ROM structure before adding them.
- Multiple-game library with cover art supplied by the user or selected from safe, user-provided local files.
- Grid/list views, search, sorting, favourites, recently played, and optional tags.
- Per-game details: title, detected game code/metadata when available, file size, date added, last played, playtime if reliably tracked, and save status.
- Custom title, cover, notes, and tags without modifying the ROM itself.
- Duplicate detection using a content hash (prefer SHA-256 through Web Crypto where available). Ask whether to keep, replace, or cancel when an identical ROM is imported.
- Clear invalid-ROM, unsupported-file, duplicate, and storage-quota messages.
- Remove-from-library action with a confirmation that explains whether associated saves/states will also be deleted. Offer export first where appropriate.
- Do not rely on a filename as the only unique game identifier. Use a stable internal ID and content hash; retain the original filename as metadata.
- Do not automatically fetch copyrighted box art from untrusted services. Make online metadata/art retrieval optional, transparent, and subject to licensing and privacy considerations.

### B. Emulator player

The player should provide:

- A stable emulator viewport and responsive layout.
- Start, pause, resume, reset, and return-to-library controls.
- Clear display of the active game title and unsaved/save activity when relevant.
- Keyboard, touch, and optional connected gamepad input.
- Configurable key mappings and button layout.
- A settings/menu overlay that does not accidentally send game inputs through to the running game.
- Fullscreen support where the browser and device allow it.
- Orientation guidance for mobile, including a comfortable landscape play layout without requiring landscape for the entire app.
- Graceful handling of tab visibility changes, browser suspension, and audio interruptions.
- No game execution before a ROM has passed validation and the user starts it.

### C. Emulator accuracy and compatibility

- Prefer a mature, maintained GBA core with a suitable license and browser/WASM support if the repository's existing core cannot meet requirements.
- Keep emulator-core integration behind a clean adapter so UI and storage do not depend on core-specific APIs.
- Preserve correct GBA timing and input behavior; do not implement speed-up by merely changing CSS animation or dropping frames.
- Test real-time clock (RTC) behavior for games that use it, including Pokémon Ruby, Sapphire, and Emerald, if supported by the selected core.
- Make core limitations visible in documentation and the compatibility matrix.
- Do not promise full compatibility until it is demonstrated by repeatable tests.
- BIOS support must be optional and must not include a BIOS download. If a core supports a legally obtained user-supplied BIOS, document the setup and fallback behavior; use the core's permitted built-in behavior where available.

## 4. Required emulator features

These features are central to the product, not optional decoration. Each must be wired to the emulator core or storage correctly, have a clear UI state, and be tested.

### A. Speed-up / fast-forward

- Add a press-and-hold fast-forward button on touch devices and a configurable keyboard shortcut on desktop.
- Support a configurable multiplier or speed target, subject to the core and device performance.
- Restore normal speed immediately when the button is released.
- Provide an optional toggle mode only if it can be distinguished clearly from hold mode.
- Show a small, unobtrusive speed indicator while active.
- Ensure fast-forward does not corrupt audio, saves, game timing, or input state.
- Test that releasing controls, pausing, resuming, and switching games do not leave the emulator stuck at an unintended speed.

### B. Adjustable emulation speed and slowdown

- Offer normal speed plus configurable faster/slower values supported by the core.
- Provide a reset-to-normal action.
- Separate normal speed configuration from the temporary fast-forward hold action.
- Keep the UI responsive when the selected speed cannot be sustained by the device; report actual behavior rather than falsely claiming the target speed was reached.
- Test that releasing controls, pausing, resuming, and switching games do not leave the emulator stuck at an unintended speed.

### C. Rewind

- Implement rewind only if the selected core exposes a safe and performant state mechanism.
- Use a bounded rolling history of emulator states or an equivalent supported mechanism.
- Provide press-and-hold rewind and a clear rewind indicator.
- Make rewind interval, history duration, and memory use configurable within safe limits.
- Default to conservative memory usage, particularly on mobile.
- Rewind must not overwrite persistent battery saves until the user resumes and the game/core commits them according to the chosen design.
- Handle games or core states that do not support rewind by disabling the control with a helpful explanation.
- Measure memory and frame-rate impact; do not silently retain unlimited snapshots.

### D. Save states and load states

Keep save states distinct from a game's normal in-game battery save.

- Support multiple named save-state slots per game, with timestamps and optional user notes.
- Include quick-save and quick-load shortcuts/buttons, with visible feedback.
- Show a screenshot thumbnail for a state when practical.
- Warn before loading a state that replaces the current in-memory session.
- Save states must be associated with the correct ROM identity and compatible core/version metadata where available.
- Detect incompatible or corrupted states and fail safely.
- Do not confuse save states with `.sav` battery-save files.
- Never load a state for a different ROM merely because the filenames match.

### E. Battery saves and save files

- Support the game's normal persistent save data through the core.
- Persist changes locally and reliably, using IndexedDB or the existing suitable storage layer.
- Provide manual save/flush where the core supports it, plus automatic persistence at safe points.
- Provide import and export of battery-save files (commonly `.sav`), with clear format/size validation.
- Back up before importing a replacement save; confirm before overwriting.
- Offer multiple backup generations or a simple recovery mechanism.
- Show the last successful save time and visible warnings when storage fails.
- Do not claim a save is safe until the persistence operation succeeds.
- Avoid racing autosaves against game switching, tab closing, or ROM removal.

### F. Cheats — configured separately for each ROM

Cheats are a first-class feature and must be isolated per game.

- Provide a Cheats panel for the currently selected game.
- Support cheat formats the chosen emulator core actually implements (for example, GameShark, Action Replay, or CodeBreaker only where supported). Do not advertise a format until verified.
- Users can add, edit, delete, enable, disable, and label individual cheat entries.
- Store cheat definitions and enabled/disabled state against the ROM's stable identity/content hash, never in a global list that accidentally affects another game.
- Show the cheat format, user-supplied code, label, and enabled state.
- Validate syntax and show actionable errors for unsupported or malformed codes.
- Support import/export of a game's cheat list in a documented format if feasible.
- Provide a clear “disable all cheats for this game” action.
- Warn that cheats can cause glitches, crashes, corrupted progress, or unexpected behavior; recommend a backup before enabling them.
- When switching games, disable/remove the previous game's active cheats before initializing the next game's cheat set.
- Never automatically download cheat databases from unknown sources. Any future database import must be optional, source-attributed, validated, and scoped to the matching ROM/game version.
- Tests must prove that game A's cheats cannot leak into game B and that a reset/reload restores the intended per-ROM configuration.

### G. Pixel-perfect rendering and display modes

- Preserve the GBA's native 240 × 160 framebuffer without smoothing by default.
- Use nearest-neighbor/integer scaling where possible for crisp pixels.
- Provide fit-to-window and fullscreen modes without distorting the aspect ratio.
- Avoid stretching the game to fill arbitrary screen dimensions.
- Offer optional smoothing only as an explicit setting.
- Test canvas sizing and rendering on high-DPI displays and mobile browsers.

### H. CRT and visual filters

- Include a small, performance-conscious set of optional filters, such as scanlines/CRT-style treatment and a subtle color adjustment if feasible.
- Filters must be off by default or have a clear default that preserves pixel clarity.
- Keep filters in the rendering pipeline so they do not modify game state or save data.
- Provide a quick toggle, intensity control where applicable, and a reset-to-default option.
- Respect reduced-motion/accessibility preferences for any animated visual effect.
- Measure performance on lower-end devices; offer a low-cost mode or disable expensive filters when needed.

### I. Screenshots

- Add a screenshot action that captures the actual game framebuffer at native resolution where possible.
- Export screenshots as PNG with a predictable filename based on game title and timestamp.
- Provide a brief confirmation and handle browser download restrictions.
- Do not include UI overlays or touch buttons in the screenshot unless the user explicitly chooses a full-app capture.
- Optional gallery of recent screenshots may be added, with explicit storage controls and delete/export actions.
- Screenshots must not pause or alter the game's emulation state.

### J. Audio

- Provide mute/unmute and a volume slider.
- Handle browsers that require a user gesture before audio can start.
- Pause or reduce audio appropriately when the emulator is paused or the page is backgrounded, according to settings.
- Avoid audio continuing after switching or closing a game.
- Keep audio behavior tied to the active emulator session.

### K. Reset and session safety

- Reset game with a confirmation or a clearly reversible UI path.
- Switching ROMs must stop the prior session, flush pending save data, detach input handlers, clear active cheats, and release resources.
- Avoid duplicate animation loops, duplicate audio contexts, stuck keys, and stale event listeners.
- When possible, warn about unsaved in-memory progress before destructive actions.

## 5. Library persistence, offline use, and sync

### A. Local-first storage

Use IndexedDB (or an existing robust equivalent) for:

- Imported ROM bytes, where browser quota and platform policy allow.
- Per-game metadata and settings.
- Battery saves and save-state files.
- Cheat lists.
- Control mappings and emulator preferences.
- Optional screenshots and rewind data, subject to user-controlled limits.

Requirements:

- Store large binary data separately from frequently updated metadata where practical.
- Handle quota errors, transaction failures, browser eviction, private browsing restrictions, and unsupported APIs.
- Display approximate storage use and provide a storage management screen.
- Allow deletion of a game's ROM and associated data independently, with clear consequences.
- Do not store ROMs in localStorage.
- Do not silently upload ROMs, saves, screenshots, or usage data.

### B. Backup and restore

- Export a single game's package containing its metadata, battery save, save states, and cheat configuration when feasible.
- Also support individual battery-save and cheat-list export/import.
- Validate imports and show a preview before overwriting existing data.
- Include version/schema information in backup manifests.
- Provide a way to back up all library metadata and saves without requiring the user to upload ROM files.
- Make clear that restoring a backup does not necessarily include the ROM itself.

### C. Offline/PWA

- Make the app installable as a Progressive Web App where supported.
- Cache the application shell and required licensed emulator assets for offline launch.
- Keep ROMs and user data in local storage rather than in the service-worker cache.
- Display an offline/online indicator only when useful.
- Provide update handling that does not unexpectedly interrupt an active session or erase local data.
- Document browser-specific limitations.

### D. Optional cross-device sync

Design for optional sync, but do not make an account/server a prerequisite for local play.

- Keep local-only use fully functional.
- Define a sync adapter/interface so a future provider can be added without rewriting the emulator.
- Sync only after explicit opt-in and explain exactly what data is uploaded.
- Never upload ROM binaries by default. Prefer syncing library metadata, settings, and user-created data; saves/states should be separately selectable.
- Use authentication, encryption in transit, server-side access controls, quota limits, and conflict resolution if a backend is implemented.
- Detect conflicting save versions and let the user choose rather than silently overwriting newer progress.
- Do not store secrets in frontend code or commit API keys.
- Treat sync as a later milestone unless a secure, maintainable backend already exists.

## 6. Controls and accessibility

### Desktop

- Default keyboard mapping for D-pad, A/B, L/R, Start, Select, and emulator shortcuts.
- Remappable keys with conflict detection.
- Support common gamepads through the browser Gamepad API when feasible.
- Prevent browser shortcuts from being hijacked unnecessarily.
- Avoid triggering a game action when a user is typing in a text field or interacting with settings.

### Mobile

- Touch controls with comfortable hit targets and spacing.
- D-pad plus A/B and shoulder buttons, Start/Select.
- Adjustable opacity, size, position, and layout presets.
- Support multi-touch so a user can hold a direction and press A/B simultaneously.
- Haptic feedback only if supported and user-enabled.
- Fullscreen/landscape player layout, with a clear exit path.
- Ensure controls do not obscure important game content more than necessary.
- Test Android Chrome and iOS Safari behavior separately where possible.

### Accessibility

- Keyboard-accessible menus and dialogs.
- Visible focus states, labels, contrast, and screen-reader names for controls.
- Avoid color as the only signal for save status, errors, or enabled cheats.
- Respect reduced-motion preferences.
- Provide scalable UI text without scaling the game's native pixels unless the user changes display settings.

## 7. UI/UX direction

Aim for a clean, modern retro aesthetic: dark or neutral surfaces, restrained pixel-art accents, readable typography, and game artwork that remains secondary to usability. Do not copy Nintendo branding or imply official affiliation.

### Suggested screens

1. **Library:** Search, import, favourites, recently played, grid/list view.
2. **Player:** Large game viewport, compact controls, pause/menu, save-state actions, speed indicator.
3. **Game details:** Metadata, playtime, battery-save status, cheats, cover art, per-game settings.
4. **Settings:** Controls, display filters, audio, speed, rewind, storage, backup, offline status.
5. **Storage manager:** Approximate use, large items, cleanup, export and recovery options.
6. **Import flow:** Validate ROM, identify duplicates, optional title/cover editing, confirm import.
7. **Error/recovery UI:** Invalid ROM, unsupported core feature, storage quota, failed save, incompatible state, unsupported cheat format.

Avoid overcrowding the player with every control at once. Put advanced features in an accessible overlay or settings panel, while keeping speed-up, save/load, rewind, screenshot, and pause easy to reach.

## 8. Technical architecture guidance

Adapt this section to the current repository rather than imposing a new stack.

Recommended boundaries:

- **Library domain:** ROM metadata, identity/hash, import, search, favourites, sorting.
- **Emulator adapter:** Core lifecycle, ROM loading, input, pause/resume, speed, save/load state, battery save, cheats, screenshot, audio, capability detection.
- **Persistence layer:** IndexedDB repositories, schema migrations, import/export, quota and failure handling.
- **Rendering layer:** Canvas/framebuffer sizing, pixel scaling, filters, fullscreen.
- **Input layer:** Keyboard, touch, gamepad, remapping, focus/blur cleanup.
- **Application UI:** Library, player, settings, dialogs, error states.
- **PWA layer:** Service worker, manifest, offline shell and update flow.
- **Optional sync layer:** Provider-neutral interface; implement a backend only when explicitly planned and secured.

Engineering requirements:

- TypeScript types at module boundaries if TypeScript is already used.
- Keep core-specific code out of UI components.
- Use a stable internal game ID plus content hash to scope data.
- Version persisted schemas and write migration tests.
- Use workers/WASM threading only when supported and worthwhile; gracefully fall back on browsers/devices without required isolation headers or capabilities.
- Manage object URLs, workers, audio contexts, event listeners, and emulator loops through explicit lifecycle cleanup.
- Do not assume all browser APIs are available.
- Use feature detection and graceful fallbacks instead of user-agent sniffing wherever possible.
- Keep dependencies minimal and review their licenses, maintenance status, bundle size, and security implications.

## 9. Security, licensing, and privacy

- Do not distribute commercial ROMs, copyrighted game artwork, BIOS files, or proprietary cheat databases.
- Provide user-driven ROM import only. Do not add a ROM download catalog.
- Respect all emulator-core and dependency licenses, including attribution and source-distribution obligations.
- Include third-party notices where required.
- Treat ROM files, imported save files, cheat text, and metadata as untrusted input. Validate sizes and structures; avoid unsafe HTML rendering or evaluation.
- Never execute user-supplied cheat text as JavaScript.
- Avoid remote scripts and remote metadata dependencies where possible.
- Do not send file names, hashes, ROM contents, saves, screenshots, or play history to analytics by default.
- If analytics are ever added, make them optional, documented, and free of ROM/save content.
- Provide clear delete/export controls and explain browser-storage limitations.
- Never commit secrets, personal data, commercial ROMs, BIOS files, or user saves.

## 10. Testing and quality gates

Tests must cover the feature behavior, not merely the presence of UI buttons.

### Automated tests

- ROM file validation, metadata extraction, hash/identity generation, and duplicate import.
- Library CRUD, search, favourites, sorting, and per-game metadata.
- IndexedDB persistence, transaction failure, quota failure, migrations, and recovery.
- Correct association of battery saves, save states, and cheats with each ROM.
- Import/export validation and overwrite confirmation logic.
- Emulator lifecycle: load, pause, resume, reset, switch game, dispose.
- Speed-up hold/release and restoration of normal speed.
- Rewind boundaries and graceful unsupported behavior.
- Save-state compatibility/error handling.
- Cheat format validation and cross-game isolation.
- Screenshot output dimensions and filename generation.
- Input remapping, multi-touch behavior where testable, and cleanup on focus loss.
- Pixel aspect ratio and scaling calculations.
- PWA offline-shell behavior where supported.
- Accessibility checks for major controls and dialogs.

### Emulator smoke tests

- Use legally redistributable homebrew or deterministic test ROM fixtures.
- Verify that a known test ROM boots, renders a nonblank framebuffer, responds to input, and advances deterministically for a bounded run.
- Test save/load using fixtures designed for this purpose.
- Do not use commercial Pokémon ROMs in CI unless the repository has explicit legal authorization; keep any personal local ROM tests local-only and out of CI.
- Separate “core boots” from “game compatibility” claims.
- Test a small range of desktop and mobile browsers if browser automation is available.

### Manual acceptance pass

- Import two different GBA ROMs.
- Play each briefly and create distinct battery saves/save states.
- Configure a cheat for game A, then launch game B and verify it is not active there.
- Test fast-forward, slowdown, rewind, filters, pixel-perfect scaling, screenshot, audio, fullscreen, and mobile controls.
- Refresh the page and verify library and save persistence.
- Export and re-import a save.
- Test offline startup after the app has been cached.
- Trigger a storage or import error and verify the user receives a useful message.

## 11. Phased implementation plan

Agents should implement in small increments, preserving a buildable application at each phase. Reorder only when repository constraints require it, and document why.

### Phase 0 — Audit and baseline

- Inspect repository, agent instructions, architecture, licenses, and existing features.
- Run baseline checks and document failures that existed before changes.
- Produce a feature/capability matrix for the current core.
- Identify the smallest useful end-to-end slice.

**Exit criteria:** A short audit is documented; current tests/build status and major risks are known.

### Phase 1 — Reliable GBA player foundation

- Load a user-selected `.gba` ROM.
- Validate input and show meaningful errors.
- Render a stable game viewport and handle input.
- Implement pause/resume/reset and safe lifecycle cleanup.
- Add minimal responsive keyboard and touch controls.

**Exit criteria:** A legal homebrew/test ROM boots and runs deterministically; no crash or runaway loop during a bounded smoke test.

### Phase 2 — Local game library and persistence

- Multi-ROM library, identity/hash, metadata, search, favourites, recent games.
- IndexedDB storage and storage/quota error handling.
- Per-game battery saves and basic import/export.
- Safe game switching and persistence across refresh.

**Exit criteria:** Two games remain distinct; library and save data persist after reload; failed storage is reported honestly.

### Phase 3 — Save states and session recovery

- Multiple save-state slots, quick-save/load, metadata and validation.
- Autosave/recovery behavior where the core supports it.
- Save status indicators and backup/export flows.

**Exit criteria:** Save states restore the correct game/session; incompatible/corrupt states fail safely; battery saves remain distinct.

### Phase 4 — Emulator enhancements

- Fast-forward, configurable speed, slowdown.
- Rewind with bounded memory use.
- Pixel-perfect scaling and fullscreen.
- CRT/scanline filter options.
- Screenshot capture and audio controls.

**Exit criteria:** Each feature is connected to actual core/rendering behavior, tested, and gracefully disabled when unsupported.

### Phase 5 — Per-ROM cheats

- Per-game cheat manager, supported formats, validation.
- Enable/disable, edit/delete, import/export where feasible.
- Cross-game isolation and backup warning.

**Exit criteria:** Automated tests prove that cheats are scoped to the right ROM and never leak across game switches.

### Phase 6 — Polished mobile experience and PWA

- Responsive player and library.
- Multi-touch controls, remapping, gamepad where feasible.
- Installable PWA and offline application shell.
- Accessibility and performance improvements.

**Exit criteria:** Core flows work on target mobile and desktop browsers; offline shell launches after initial caching; user data remains local.

### Phase 7 — Optional sync and advanced polish

- Design and document sync conflicts and security.
- Add opt-in sync only if a suitable backend and authentication model are approved.
- Add optional screenshot gallery, library backup bundle, and extra quality-of-life features.

**Exit criteria:** Local-only operation remains complete; sync is opt-in, secure, documented, and tested if shipped.

## 12. Definition of done for every task

A task is not complete merely because the UI exists.

Every task must:

1. Meet its acceptance criteria.
2. Include automated tests appropriate to the change.
3. Pass relevant lint, type-check, build, and test commands.
4. Handle errors and unsupported capabilities explicitly.
5. Avoid regressions to existing features.
6. Update documentation and the compatibility/capability matrix when needed.
7. Preserve licensing and third-party notices.
8. Report exactly what was tested and what remains unverified.
9. Avoid claiming full Pokémon or ROM-hack compatibility without evidence.
10. Leave the repository in a coherent, buildable state.

## 13. Initial-release priorities

### P0 — Required

- GBA ROM import and playback.
- Personal library for multiple ROMs.
- Local persistent battery saves.
- Save-state slots and quick save/load, if supported by the core.
- Per-ROM cheats for verified supported formats.
- Fast-forward and adjustable speed.
- Rewind if the core can support it safely.
- Pixel-perfect rendering.
- Screenshot capture.
- Basic CRT/scanline filter.
- Keyboard and mobile touch controls.
- Backup/export/import.
- Clear save/storage/error feedback.
- Automated tests and legal/licensing hygiene.

### P1 — Important polish

- Gamepad support.
- Custom covers, tags, playtime, recently played, favourites.
- Configurable control layout.
- Audio controls and fullscreen.
- Installable offline PWA.
- Storage manager and save recovery.
- Optional slowdown and filter intensity.

### P2 — Later

- Optional secure cross-device sync.
- Screenshot gallery.
- More advanced library metadata.
- Optional user-provided BIOS configuration, only if supported and legally appropriate.
- Additional performance and accessibility refinements.

## 14. Non-goals for the initial release

- Other console emulation.
- Hosting, downloading, or bundling commercial ROMs.
- Accounts or cloud storage required for basic usage.
- Multiplayer/link-cable emulation unless explicitly planned later.
- A built-in copyrighted artwork or cheat-code scraping service.
- Promising perfect compatibility with every commercial game or ROM hack.
- Replacing the emulator core without evidence that the existing core cannot meet the requirements.

## 15. Required agent handoff/report

At the end of each implementation increment, report:

- **Implemented:** Exact behavior added or changed.
- **Files changed:** Key source, test, and documentation files.
- **Verification:** Commands run and their actual results.
- **Manual checks:** Browser/device checks performed.
- **Limitations:** Unsupported features, known bugs, or untested claims.
- **Next step:** The smallest logical follow-up task.

Keep this plan current as implementation reality changes. Mark features as `NOT STARTED`, `IN PROGRESS`, `IMPLEMENTED`, or `VERIFIED`; reserve `VERIFIED` for features with reproducible test evidence.
