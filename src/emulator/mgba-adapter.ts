/**
 * mGBA (WebAssembly) implementation of the `EmulatorCore` adapter.
 *
 * This is the only module allowed to know mGBA's API. Everything it does is
 * derived from the vendored build's own contract (`dist/mgba.d.ts`) and from
 * mGBA's source, not from guesswork:
 *
 * - ROM bytes are written to `<gamePath>/<romFileName>`; the core derives its
 *   save file (`<savePath>/<base>.sav`) and state files
 *   (`<statePath>/<base>.ss<slot>`) from that base name, which is why we name
 *   ROMs after the stable game id rather than the user's file name.
 * - `autoLoadCheats()` reads `<cheatPath>/<base>.cheats` — again per game.
 * - Input is driven entirely through `buttonPress`/`buttonUnpress` after
 *   `toggleInput(false)` disables the core's own SDL keyboard handling, so key
 *   remapping, gamepads and touch share one code path and typed text never
 *   reaches the running game.
 */
import { GBA_BUTTONS } from '@/input/bindings';
import {
  CORE_SCRIPT_URL,
  CoreUnavailableError,
  MGBA_CAPABILITIES,
  MGBA_CORE_INFO,
  type CoreCapabilities,
  type CoreInfo,
  type CoreLogEntry,
  type CorePaths,
  type CoreSettings,
  type EmulatorCore,
  type FrameCallbacks,
  type LoadRomOptions,
} from './core';

/** The slice of the Emscripten module we actually use. */
interface MgbaModule {
  version: { projectName: string; projectVersion: string };
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    mkdir(path: string): void;
    analyzePath(path: string): { exists: boolean };
  };
  filePaths(): {
    root: string;
    cheatsPath: string;
    gamePath: string;
    savePath: string;
    saveStatePath: string;
    screenshotsPath: string;
    patchPath: string;
    autosave: string;
  };
  FSInit(): Promise<void>;
  FSSync(): Promise<void>;
  loadGame(romPath: string, savePathOverride?: string): boolean;
  quickReload(): void;
  quitGame(): void;
  quitMgba(): void;
  pauseGame(): void;
  resumeGame(): void;
  pauseAudio(): void;
  resumeAudio(): void;
  getSave(): Uint8Array | null;
  saveState(slot: number): boolean;
  loadState(slot: number): boolean;
  screenshot(fileName?: string): boolean;
  autoLoadCheats(): boolean;
  setVolume(percent: number): void;
  getVolume(): number;
  setFastForwardMultiplier(multiplier: number): void;
  getFastForwardMultiplier(): number;
  setCoreSettings(settings: Record<string, unknown>): void;
  toggleRewind(enabled: boolean): void;
  toggleInput(enabled: boolean): void;
  bindKey(bindingName: string, inputCode: number): void;
  buttonPress(name: string): void;
  buttonUnpress(name: string): void;
  addCoreCallbacks(callbacks: Record<string, unknown>): void;
  setLogger(callback: ((entry: CoreLogEntry) => void) | null): void;
  gameName?: string;
  saveName?: string;
}

function isRunningInIsolatedContext(): boolean {
  return (
    typeof SharedArrayBuffer === 'function' &&
    Boolean((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)
  );
}

export class MgbaCore implements EmulatorCore {
  readonly info: CoreInfo = MGBA_CORE_INFO;
  readonly capabilities: CoreCapabilities = MGBA_CAPABILITIES;

  private module: MgbaModule | null = null;
  private canonicalPaths: CorePaths = {
    root: '/data',
    games: '/data/games',
    saves: '/data/saves',
    states: '/data/states',
    cheats: '/data/cheats',
    screenshots: '/data/screenshots',
  };
  private initialised = false;
  private running = false;
  private baseName: string | null = null;
  private frameCallbacks: FrameCallbacks = {};
  private logger: ((entry: CoreLogEntry) => void) | null = null;
  private volume = 1;
  private muted = false;
  private speed = 1;
  private lastSaveAt: number | null = null;
  private screenshotCounter = 0;

  get paths(): CorePaths {
    return this.canonicalPaths;
  }

  /** Timestamp of the most recent core-side save write, if any. */
  get lastSaveTimestamp(): number | null {
    return this.lastSaveAt;
  }

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (this.initialised) return;
    if (!isRunningInIsolatedContext()) {
      // Instantiating anyway would fail deep inside the wasm loader with an
      // unhelpful message about SharedArrayBuffer; say something useful instead.
      throw new CoreUnavailableError(
        'The emulator needs a cross-origin isolated page. Open BrowserGBA in its own tab, or serve it with the COOP/COEP headers described in docs/DEPLOYMENT.md.',
      );
    }

    let factory: (options: { canvas: HTMLCanvasElement }) => Promise<MgbaModule>;
    try {
      // Served verbatim from /mgba/ so the pthread worker URL inside the module
      // still resolves. See scripts/sync-core.mjs and docs/ARCHITECTURE.md.
      const imported = (await import(/* @vite-ignore */ CORE_SCRIPT_URL)) as {
        default?: unknown;
      };
      factory = (imported.default ?? imported) as typeof factory;
      if (typeof factory !== 'function') {
        throw new Error('the module did not export a factory function');
      }
    } catch (error) {
      throw new CoreUnavailableError(
        'The emulator core could not be downloaded. Run `npm run sync:core` and reload, and check that /mgba/mgba.js is reachable.',
        error,
      );
    }

    const module = await factory({ canvas });
    this.module = module;

    module.setLogger((entry) => {
      this.logger?.(entry);
    });

    // Disable the core's own SDL key/mouse handling before any input arrives:
    // the app maps every input itself.
    module.toggleInput(false);

    await module.FSInit();

    const paths = module.filePaths();
    this.canonicalPaths = {
      root: paths.root,
      games: paths.gamePath,
      saves: paths.savePath,
      states: paths.saveStatePath,
      cheats: paths.cheatsPath,
      screenshots: paths.screenshotsPath,
    };

    for (const dir of Object.values(this.canonicalPaths)) {
      try {
        if (!module.FS.analyzePath(dir).exists) module.FS.mkdir(dir);
      } catch {
        // FSInit already creates these; a mkdir failure here is not fatal.
      }
    }

    this.initialised = true;
    this.applyFrameCallbacks();
  }

  private require(): MgbaModule {
    if (!this.module) throw new CoreUnavailableError('The emulator core has not been initialised.');
    return this.module;
  }

  private applyFrameCallbacks(): void {
    const module = this.require();
    module.addCoreCallbacks({
      videoFrameStartedCallback: () => this.frameCallbacks.onFrameStart?.(),
      videoFrameEndedCallback: () => this.frameCallbacks.onFrameEnd?.(),
      coreCrashedCallback: () => this.frameCallbacks.onCoreCrashed?.(),
      saveDataUpdatedCallback: () => {
        this.lastSaveAt = Date.now();
        this.frameCallbacks.onSaveDataUpdated?.();
      },
      alarmCallback: () => this.frameCallbacks.onAlarm?.(),
    });
  }

  async loadRom(options: LoadRomOptions): Promise<boolean> {
    const module = this.require();
    const base = options.romFileName.replace(/\.[^.]+$/, '');
    const romPath = `${this.canonicalPaths.games}/${options.romFileName}`;
    const savePath = `${this.canonicalPaths.saves}/${base}.sav`;

    // Always write the ROM bytes we were given: the core may still hold a
    // previous game's files in its own IDBFS-backed filesystem.
    module.FS.writeFile(romPath, options.bytes);

    if (options.saveBytes && options.saveBytes.byteLength > 0) {
      module.FS.writeFile(savePath, options.saveBytes);
    } else if (module.FS.analyzePath(savePath).exists) {
      // No stored save for this game: drop any leftover file so the cartridge
      // starts empty rather than inheriting another session's data.
      module.FS.unlink(savePath);
    }

    const loaded = module.loadGame(romPath, savePath);
    if (!loaded) return false;

    this.baseName = base;
    this.running = true;
    module.resumeGame();
    // Apply whatever cheat file exists for this game id.
    module.autoLoadCheats();
    return true;
  }

  async unmount(): Promise<void> {
    const module = this.module;
    if (!module) return;
    try {
      module.pauseGame();
    } catch {
      /* core already idle */
    }
    module.quitGame();
    this.running = false;
    this.baseName = null;
  }

  async destroy(): Promise<void> {
    const module = this.module;
    if (!module) return;
    try {
      await this.unmount();
    } catch {
      /* best effort */
    }
    try {
      module.quitMgba();
    } catch {
      /* the runtime may already be torn down */
    }
    module.setLogger(null);
    this.module = null;
    this.initialised = false;
  }

  pause(): void {
    this.require().pauseGame();
    this.running = false;
  }

  resume(): void {
    this.require().resumeGame();
    this.running = true;
  }

  reset(): void {
    // quickReload re-reads the ROM from the filesystem and restarts it, which
    // also re-runs cartridge detection.
    this.require().quickReload();
  }

  isRunning(): boolean {
    return this.running;
  }

  applySettings(settings: CoreSettings): void {
    const module = this.require();

    if (typeof settings.speedMultiplier === 'number' && Number.isFinite(settings.speedMultiplier)) {
      const multiplier = settings.speedMultiplier;
      // mGBA encodes slow motion as a negative multiplier: -2 means half speed.
      module.setFastForwardMultiplier(multiplier >= 1 ? multiplier : -1 / multiplier);
      this.speed = multiplier;
    }
    if (typeof settings.volume === 'number') {
      this.volume = Math.min(Math.max(settings.volume, 0), 2);
    }
    if (typeof settings.muted === 'boolean') {
      this.muted = settings.muted;
    }
    module.setVolume(this.muted ? 0 : this.volume);

    const coreSettings: Record<string, unknown> = {};
    if (typeof settings.rewindEnabled === 'boolean') coreSettings.rewindEnable = settings.rewindEnabled;
    if (settings.rewindBufferCapacity) coreSettings.rewindBufferCapacity = settings.rewindBufferCapacity;
    if (settings.rewindBufferInterval) coreSettings.rewindBufferInterval = settings.rewindBufferInterval;
    if (typeof settings.frameSkip === 'number') coreSettings.frameSkip = settings.frameSkip;
    if (typeof settings.videoSync === 'boolean') coreSettings.videoSync = settings.videoSync;
    if (typeof settings.threadedVideo === 'boolean') coreSettings.threadedVideo = settings.threadedVideo;
    if (typeof settings.showFpsCounter === 'boolean') coreSettings.showFpsCounter = settings.showFpsCounter;
    if (typeof settings.autoSaveStateEnable === 'boolean') {
      // BrowserGBA keeps its own save states in IndexedDB, so the core's
      // periodic auto-state is left off unless the user asks for it.
      coreSettings.autoSaveStateEnable = settings.autoSaveStateEnable;
      // Never silently restore a core auto-state on top of a user's session.
      coreSettings.restoreAutoSaveStateOnLoad = false;
    }
    if (settings.audioSampleRate) coreSettings.audioSampleRate = settings.audioSampleRate;
    if (settings.audioBufferSize) coreSettings.audioBufferSize = settings.audioBufferSize;
    if (Object.keys(coreSettings).length > 0) module.setCoreSettings(coreSettings);
  }

  buttonPress(button: string): void {
    if (!this.knownButton(button)) return;
    this.require().buttonPress(button);
  }

  buttonUnpress(button: string): void {
    if (!this.knownButton(button)) return;
    this.require().buttonUnpress(button);
  }

  /**
   * Guards against passing anything but a real button name into the core.
   *
   * The core looks names up in its own table, so an unknown string is a no-op
   * there — but validating here means a typo in our mapping surfaces in a unit
   * test rather than as a silently dead key.
   */
  private knownButton(button: string): boolean {
    return (GBA_BUTTONS as readonly string[]).includes(button);
  }

  /** Releases every button the core may still think is held. */
  releaseAllButtons(): void {
    const module = this.module;
    if (!module) return;
    for (const button of GBA_BUTTONS) module.buttonUnpress(button);
  }

  getSpeedMultiplier(): number {
    return this.speed;
  }

  setRewindActive(enabled: boolean): void {
    // The core expects rewind to be enabled in settings *and* toggled at
    // runtime: the setting allocates the bounded history buffer, the toggle
    // starts and stops stepping backwards through it.
    this.require().toggleRewind(enabled);
  }

  async setCheatFile(romFileName: string, contents: string): Promise<boolean> {
    const module = this.require();
    const base = romFileName.replace(/\.[^.]+$/, '');
    const path = `${this.canonicalPaths.cheats}/${base}.cheats`;
    module.FS.writeFile(path, new TextEncoder().encode(contents));
    return this.reloadCheats();
  }

  async clearCheatFile(romFileName: string): Promise<void> {
    const module = this.require();
    const base = romFileName.replace(/\.[^.]+$/, '');
    const path = `${this.canonicalPaths.cheats}/${base}.cheats`;
    if (module.FS.analyzePath(path).exists) module.FS.unlink(path);
  }

  reloadCheats(): boolean {
    const module = this.require();
    return module.autoLoadCheats();
  }

  readBatterySave(): Uint8Array | null {
    const save = this.require().getSave();
    return save && save.byteLength > 0 ? save : null;
  }

  async saveState(slot: number): Promise<Uint8Array | null> {
    const module = this.require();
    const base = this.baseName;
    if (!base) return null;
    if (!module.saveState(slot)) return null;
    const path = `${this.canonicalPaths.states}/${base}.ss${slot}`;
    if (!module.FS.analyzePath(path).exists) return null;
    return module.FS.readFile(path);
  }

  async loadState(slot: number, bytes: Uint8Array): Promise<boolean> {
    const module = this.require();
    const base = this.baseName;
    if (!base) return false;
    const path = `${this.canonicalPaths.states}/${base}.ss${slot}`;
    module.FS.writeFile(path, bytes);
    return module.loadState(slot);
  }

  async captureScreenshot(): Promise<Uint8Array | null> {
    const module = this.require();
    // A unique name per capture, so a rapid sequence of screenshots cannot
    // overwrite the file we are about to read.
    this.screenshotCounter += 1;
    const name = `browsergba-${Date.now()}-${this.screenshotCounter}.png`;
    if (!module.screenshot(name)) return null;
    const path = `${this.canonicalPaths.screenshots}/${name}`;
    if (!module.FS.analyzePath(path).exists) return null;
    const bytes = module.FS.readFile(path);
    try {
      module.FS.unlink(path);
    } catch {
      /* leaving the file in the core FS is harmless */
    }
    return bytes;
  }

  onFrame(callbacks: FrameCallbacks): void {
    this.frameCallbacks = callbacks;
    if (this.initialised) this.applyFrameCallbacks();
  }

  setLogger(handler: ((entry: CoreLogEntry) => void) | null): void {
    this.logger = handler;
  }

  /** Exposed for diagnostics: flushes the core's own filesystem to its backing store. */
  async syncFileSystem(): Promise<void> {
    await this.module?.FSSync();
  }
}
