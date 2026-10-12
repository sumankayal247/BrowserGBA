/**
 * Emulator-core adapter.
 *
 * Everything that knows about mGBA's specific API lives behind this interface,
 * so the UI, storage and library layers never import the core. If the core is
 * ever replaced, only this file changes.
 *
 * The vendored core is served verbatim from `/mgba/mgba.js` because the threaded
 * Emscripten runtime spawns its pthread worker with
 * `new Worker(new URL('mgba.js', import.meta.url))` — bundling or hashing the
 * file would break that URL. See scripts/sync-core.mjs.
 */

export interface CoreCapabilities {
  /** Bounded rewind history is available. */
  rewind: boolean;
  /** In-memory save states with slot addressing. */
  saveStates: boolean;
  /** Cartridge battery saves can be read back as bytes. */
  batterySave: boolean;
  /** `.cheats` files are parsed and applied per ROM. */
  cheats: boolean;
  /** Native-resolution framebuffer screenshots. */
  screenshot: boolean;
  /** Speed multiplier control, including slow motion (< 1). */
  speedControl: boolean;
  /** Real-time clock emulation for games that use it. */
  realTimeClock: boolean;
  /** The core can report its own version. */
  versionReporting: boolean;
}

export interface CoreInfo {
  name: string;
  version: string;
  license: string;
  /** True when this is a WebAssembly build (i.e. threaded and isolated). */
  wasm: boolean;
}

export interface FrameCallbacks {
  onFrameStart?: () => void;
  onFrameEnd?: () => void;
  onCoreCrashed?: () => void;
  onSaveDataUpdated?: () => void;
  onAlarm?: () => void;
}

export interface CoreLogEntry {
  level: string;
  category: string;
  message: string;
}

export interface CorePaths {
  root: string;
  games: string;
  saves: string;
  states: string;
  cheats: string;
  screenshots: string;
}

export interface LoadRomOptions {
  /** File name inside the emulated filesystem; must be derived from the game id. */
  romFileName: string;
  bytes: Uint8Array;
  /** Existing battery save to seed the cartridge with, if any. */
  saveBytes?: Uint8Array | null;
}

export interface CoreSettings {
  volume?: number;
  muted?: boolean;
  /** 1 = normal, > 1 = fast forward, < 1 = slow motion. */
  speedMultiplier?: number;
  rewindEnabled?: boolean;
  rewindBufferCapacity?: number;
  rewindBufferInterval?: number;
  frameSkip?: number;
  /** Sync video to the display refresh rate; can reduce tearing at a CPU cost. */
  videoSync?: boolean;
  /** Run rendering on a separate thread when the browser allows it. */
  threadedVideo?: boolean;
  showFpsCounter?: boolean;
  autoSaveStateEnable?: boolean;
  audioSampleRate?: number;
  audioBufferSize?: number;
}

/** The only surface the application depends on. */
export interface EmulatorCore {
  readonly info: CoreInfo;
  readonly capabilities: CoreCapabilities;
  readonly paths: CorePaths;

  init(canvas: HTMLCanvasElement): Promise<void>;
  loadRom(options: LoadRomOptions): Promise<boolean>;
  /** Stops the current game and releases core-side state. */
  unmount(): Promise<void>;
  /** Tears down the whole runtime. The instance is unusable afterwards. */
  destroy(): Promise<void>;

  pause(): void;
  resume(): void;
  /** Restarts the loaded ROM without reloading its bytes. */
  reset(): void;
  isRunning(): boolean;

  /** Presses a game button by name (GBA_BUTTONS). */
  buttonPress(button: string): void;
  buttonUnpress(button: string): void;

  applySettings(settings: CoreSettings): void;
  getSpeedMultiplier(): number;
  /** Turns the core's backwards-stepping rewind on or off. */
  setRewindActive(enabled: boolean): void;

  setCheatFile(romFileName: string, contents: string): Promise<boolean>;
  clearCheatFile(romFileName: string): Promise<void>;
  /** Re-reads the cheat file for the currently loaded ROM. */
  reloadCheats(): boolean;

  readBatterySave(): Uint8Array | null;
  saveState(slot: number): Promise<Uint8Array | null>;
  loadState(slot: number, bytes: Uint8Array): Promise<boolean>;

  /** Captures the framebuffer at native resolution as PNG bytes. */
  captureScreenshot(): Promise<Uint8Array | null>;

  onFrame(callbacks: FrameCallbacks): void;
  setLogger(handler: ((entry: CoreLogEntry) => void) | null): void;
}

/** mGBA compiled to WebAssembly, as published in @thenick775/mgba-wasm. */
export const MGBA_CORE_INFO: CoreInfo = {
  name: 'mGBA',
  version: '2.5.1',
  license: 'MPL-2.0',
  wasm: true,
};

export const MGBA_CAPABILITIES: CoreCapabilities = {
  rewind: true,
  saveStates: true,
  batterySave: true,
  cheats: true,
  screenshot: true,
  speedControl: true,
  realTimeClock: true,
  versionReporting: true,
};

/** Where the vendored core is served from. */
export const CORE_SCRIPT_URL = '/mgba/mgba.js';

export class CoreUnavailableError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'CoreUnavailableError';
  }
}
