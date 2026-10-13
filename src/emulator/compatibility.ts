/**
 * The capability matrix.
 *
 * This is the honest ledger the product plan asks for: every claim about
 * emulator support is either backed by an automated test in this repository or
 * explicitly marked as unverified. It drives the in-app "Compatibility" screen
 * and the README, so the two cannot drift apart.
 */

export type SupportLevel = 'implemented' | 'experimental' | 'unsupported' | 'not-applicable';

export interface CapabilityRow {
  id: string;
  feature: string;
  level: SupportLevel;
  notes: string;
  /** How this is verified, or why it cannot be. */
  evidence: string;
}

export interface CapabilityGroup {
  id: string;
  title: string;
  summary: string;
  rows: CapabilityRow[];
}

export const CORE_IDENTITY = {
  name: 'mGBA',
  version: '2.5.1',
  license: 'MPL-2.0',
  upstream: 'https://github.com/thenick775/mgba (feature/wasm branch)',
  project: 'https://mgba.io/',
  build: 'WebAssembly, threads enabled (requires cross-origin isolation)',
};

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: 'core',
    title: 'Emulator core',
    summary: 'What the vendored mGBA build provides on Game Boy Advance.',
    rows: [
      {
        id: 'gba-boot',
        feature: 'Game Boy Advance ROM boot and rendering',
        level: 'implemented',
        notes:
          'Cartridge images up to 32 MiB. The core runs without a BIOS file by falling back to its high-level BIOS emulation.',
        evidence:
          'Automated browser smoke test boots a generated fixture ROM and verifies all 38,400 pixels of the framebuffer against a deterministic pattern.',
      },
      {
        id: 'battery-save',
        feature: 'Cartridge battery saves (SRAM / Flash / EEPROM)',
        level: 'implemented',
        notes:
          'Save data is read back from the core and stored in IndexedDB per game, with manual and automatic generations.',
        evidence:
          'Smoke test reads a 32 KiB SRAM image back from the fixture cartridge, whose contents match what the ROM wrote (0xA5 in SRAM[0]); the app-level test asserts the same bytes reach IndexedDB. Flash and EEPROM carts take the same mGBA code path but have not been verified against a real commercial cartridge.',
      },
      {
        id: 'save-states',
        feature: 'Save states',
        level: 'implemented',
        notes:
          'Multiple slots per game with thumbnails, ROM-hash association and core-version metadata. States are stored separately from battery saves.',
        evidence:
          'Smoke test writes and loads a state; unit tests cover ROM-hash mismatch, foreign-core states and corrupt files.',
      },
      {
        id: 'rewind',
        feature: 'Rewind',
        level: 'implemented',
        notes:
          'Bounded rolling history. Capacity and interval are configurable; the default is ~10 seconds of history to stay mobile-friendly.',
        evidence: 'Smoke test toggles the rewind path; unit tests cover budget clamping and that a hold cannot latch.',
      },
      {
        id: 'rtc',
        feature: 'Real-time clock (games that read a clock)',
        level: 'implemented',
        notes:
          'mGBA emulates the cartridge RTC. Time-based events depend on the host clock, so a game may behave differently from a cartridge that has been running for years.',
        evidence:
          'Core capability only. No automated test with a clock-dependent commercial game, and none is planned, because that would require a copyrighted ROM.',
      },
      {
        id: 'bios',
        feature: 'User-supplied BIOS file',
        level: 'unsupported',
        notes:
          'The core can use a real BIOS, but BrowserGBA never ships or downloads one, and this release has no BIOS picker. Playback always uses the core’s built-in HLE BIOS.',
        evidence: 'No BIOS UI exists in this release; the core is configured for HLE only.',
      },
      {
        id: 'cheats',
        feature: 'Per-game cheat codes',
        level: 'implemented',
        notes:
          'GameShark/Action Replay (8+8), CodeBreaker (8+4) and raw/VBA address:value codes — the three families this core implements for GBA.',
        evidence:
          'Unit tests prove per-ROM isolation, format validation against mGBA’s parsers, and that no file is written when nothing is enabled.',
      },
      {
        id: 'link',
        feature: 'Link cable / multiplayer',
        level: 'unsupported',
        notes: 'Not implemented in this release; planned only if it can be done without a server.',
        evidence: 'No implementation.',
      },
      {
        id: 'other-consoles',
        feature: 'NES, SNES, GB/GBC, DS and other consoles',
        level: 'unsupported',
        notes:
          'BrowserGBA is Game Boy Advance only by design. The core could load other systems, but the import path rejects anything that is not a .gba cartridge image.',
        evidence: 'Import validation rejects non-.gba files and non-GBA headers; unit tested.',
      },
    ],
  },
  {
    id: 'compat',
    title: 'Game compatibility',
    summary: 'What we can and cannot claim about specific games.',
    rows: [
      {
        id: 'pokemon',
        feature: 'Pokémon GBA games and ROM hacks',
        level: 'experimental',
        notes:
          'These are the priority target and mGBA is a mature, high-accuracy core, but this project has not run automated compatibility tests against commercial Pokémon titles — that would require shipping copyrighted ROMs.',
        evidence:
          'No commercial-ROM testing in CI. Compatibility claims here are limited to what the core itself documents.',
      },
      {
        id: 'romhacks',
        feature: 'ROM hacks in general',
        level: 'experimental',
        notes:
          'Hacks are ordinary GBA cartridges to the emulator, so most should run. Hacks that use unusual mapper/hardware tricks or exceed 32 MiB are rejected at import.',
        evidence: 'Import validation enforces the 32 MiB limit and valid header structure; unit tested.',
      },
      {
        id: 'homebrew',
        feature: 'Homebrew and test ROMs',
        level: 'implemented',
        notes: 'Homebrew without a Nintendo logo imports fine; the missing-logo case is a warning, not an error.',
        evidence: 'Unit tested, and the CI fixture ROM is itself homebrew with a blank logo area.',
      },
    ],
  },
  {
    id: 'platform',
    title: 'Browser platform',
    summary: 'Features that depend on browser support, detected at runtime.',
    rows: [
      {
        id: 'coi',
        feature: 'Cross-origin isolation (required for playback)',
        level: 'implemented',
        notes:
          'The threaded core needs SharedArrayBuffer, which browsers grant only to cross-origin isolated pages. This is why playback can be blocked inside an embedded frame while the rest of the app still works.',
        evidence: 'Runtime detection with an explanatory UI; a browser test asserts isolation is granted by the documented headers.',
      },
      {
        id: 'self-isolation',
        feature: 'Working on a host that sends no isolation headers',
        level: 'implemented',
        notes:
          'A static host that cannot be configured (GitHub Pages, a plain file server, a deployment you cannot change the headers of) can still run the emulator: the app\u2019s service worker re-serves its own responses with the two headers browsers require. The app reloads itself once to activate that, having said why first, and never more than once per tab, so a host where it cannot work is asked to be fixed rather than reloaded forever. Inside an embedded frame it does not try at all, because browsers never grant cross-origin isolation to a nested document \u2014 there the app says so and offers to open in a new tab instead.',
        evidence:
          'App-level browser tests drive five origins, including one served with the headers, two with none (one of them the repository sub-path layout GitHub Pages produces) and one embedding the app cross-origin. On the header-less origins they assert that the app starts un-isolated, repairs itself with no user action, counts exactly two document loads (so a repair loop cannot hide), announces the reload, plays the game afterwards with frames matching the test ROM, and \u2014 on a cold origin with the attempt flag pre-seeded \u2014 stops and offers a one-click Reload instead of looping. The framed copy is asserted never to be offered a repair it could not complete. The worker is also asserted to send COOP: same-origin and COEP: require-corp on its own responses, and unit tests pin the decision table including blocked storage.',
      },
      {
        id: 'indexeddb',
        feature: 'Local library, saves and states',
        level: 'implemented',
        notes: 'IndexedDB with schema migrations and quota errors surfaced to the user.',
        evidence: 'Unit tests run against a real IndexedDB implementation (fake-indexeddb) including failure paths.',
      },
      {
        id: 'pwa',
        feature: 'Installable app and offline shell',
        level: 'implemented',
        notes:
          'The shell and the emulator core are cached for offline launch. ROMs, saves and states stay in IndexedDB, never in the service-worker cache.',
        evidence:
          'The app-level browser test waits for the worker to reach `activated` and asserts it precached the shell; the build fails if a service-worker placeholder is left unsubstituted. See docs/DEPLOYMENT.md.',
      },
      {
        id: 'engines',
        feature: 'Browser engines (Chromium, Firefox, Safari)',
        level: 'implemented',
        notes:
          'BrowserGBA targets the Web platform rather than one engine: no Chromium-only APIs, files downloaded through an ordinary link, and the threaded core gated on cross-origin isolation, which Chromium, Firefox and Safari all implement. Default shortcuts deliberately steer clear of keys a browser claims first (F5 reloads the page, F9 is Reader View in Firefox), and Firefox is detected explicitly \u2014 including Firefox for iOS, which identifies itself as Firefox but runs WebKit.',
        evidence:
          'Automated: the unit and browser suites run the app in Chromium, including engine detection, and the input tests assert that no default shortcut is a reserved browser key. Firefox: the browser harness accepts a Firefox binary (BROWSERGBA_FIREFOX) and drives the same smoke test, but no Firefox build was available in the environment where this release was prepared, so Firefox is not yet covered by an automated run \u2014 it is untested, not known-bad. Safari: engine detection reports it, no automated run.',
      },
      {
        id: 'vibration',
        feature: 'Haptic feedback on touch controls',
        level: 'implemented',
        notes:
          'Optional short pulse when a touch button is pressed, using the Vibration API. It is off by default, only fires for touch input, and is silently skipped where there is no motor or the browser does not implement the API (desktop Firefox and Chrome, and iOS Safari, do not).',
        evidence:
          'Unit tests cover the on/off switch and that a missing or refusing implementation is ignored instead of surfacing an error. The pulse itself cannot be observed by an automated test and has not been verified on a physical device.',
      },
      {
        id: 'gamepad',
        feature: 'Gamepads',
        level: 'implemented',
        notes:
          'Standard-mapping pads (Xbox, DualSense/DualShock, most 8BitDo in XInput mode). Non-standard pads fall back to the common first four buttons.',
        evidence: 'Mapping unit tests; the browser Gamepad API cannot be driven from automated tests.',
      },
      {
        id: 'multitouch',
        feature: 'Multi-touch controls',
        level: 'implemented',
        notes:
          'Independent pointer tracking per button, so a direction can be held while a second finger presses A or B. Layout, size and opacity are configurable.',
        evidence: 'Pointer tracking unit tests; manual testing on Android Chrome and iOS Safari is recommended for each device family.',
      },
      {
        id: 'audio',
        feature: 'Audio',
        level: 'implemented',
        notes:
          'Volume control and mute, plus the browser requirement for a user gesture before audio starts. Audio is muted while the tab is hidden or the session is paused.',
        evidence: 'Core API is exercised in the smoke test (silent mode); gesture handling is manual.',
      },
      {
        id: 'sync',
        feature: 'Optional cross-device sync',
        level: 'unsupported',
        notes:
          'Designed for but not implemented in this release. Local-only use is complete, and no account is required.',
        evidence: 'No implementation; the sync boundary is documented in docs/ARCHITECTURE.md.',
      },
      {
        id: 'catalog',
        feature: 'Online community catalog',
        level: 'unsupported',
        notes:
          'Not implemented in this release. When it is, it will be a separate, optional metadata/links service that never hosts ROMs, BIOS files or saves, and local play will keep working without it.',
        evidence: 'No backend, no database, no network calls from the app.',
      },
    ],
  },
];

/** Every claim that currently lacks automated evidence, for the docs. */
export function unverifiedClaims(): CapabilityRow[] {
  return CAPABILITY_GROUPS.flatMap((group) => group.rows).filter(
    (row) => row.level === 'experimental' || row.evidence.startsWith('No '),
  );
}
