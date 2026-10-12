/**
 * An emulator session: one core, one game, and all the rules that keep the two
 * honest with each other.
 *
 * Guarantees this module is responsible for (each has tests):
 *
 * - A session only ever touches data belonging to its own `gameId`/content hash.
 * - Battery saves are read back from the core and persisted; a save is never
 *   reported as safe before the write has completed.
 * - Temporary speed changes (fast-forward / rewind hold) never outlive the hold,
 *   pausing, or stopping the session.
 * - Save states are validated against the ROM they belong to before loading.
 * - Stopping flushes pending saves, unmounts the core and detaches callbacks.
 */
import type { GameRecord, BatterySaveRecord, CheatRecord, SaveStateRecord, ScreenshotRecord } from '@/storage/records';
import { batterySavesRepo, cheatsRepo, saveStatesRepo, screenshotsRepo } from '@/storage/records';
import { hashBytesHex } from '@/storage/hash';
import { nextRecordId } from '@/storage/ids';
import { serialiseCheatFile } from '@/cheats/cheats';
import { GBA_BUTTONS, isGbaButton, type GbaButton } from '@/input/bindings';
import type { EmulatorCore } from './core';

export type SessionState = 'preparing' | 'running' | 'paused' | 'stopped';

export interface SessionSettings {
  /** Normal (non-hold) speed multiplier. 1 = 100%. */
  speedMultiplier: number;
  /** Multiplier applied while fast-forward is held. */
  fastForwardMultiplier: number;
  fastForwardMode: 'hold' | 'toggle';
  volume: number;
  muted: boolean;
  rewindEnabled: boolean;
  /** Number of rewind snapshots retained by the core. */
  rewindBufferCapacity: number;
  /** Frames between rewind snapshots. */
  rewindBufferInterval: number;
  filterId: string;
  /** Integer scaling for pixel-perfect display; 'fit' lets the viewport decide. */
  scaling: 'integer' | 'fit';
  screenshotFormat: 'native' | 'scaled';
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  speedMultiplier: 1,
  fastForwardMultiplier: 2,
  fastForwardMode: 'hold',
  volume: 0.8,
  muted: false,
  rewindEnabled: false,
  // Conservative default: roughly 10 seconds of history at 60 fps.
  rewindBufferCapacity: 600,
  rewindBufferInterval: 1,
  filterId: 'none',
  scaling: 'integer',
  screenshotFormat: 'native',
};

export type SaveStatus = 'idle' | 'pending' | 'saved' | 'error';

export interface SaveStateFeedback {
  status: SaveStatus;
  lastSavedAt: number | null;
  message?: string;
}

export interface SessionHooks {
  onStateChange?: (state: SessionState) => void;
  onSpeedChange?: (current: number, isHold: boolean) => void;
  onSaveStatus?: (status: SaveStateFeedback) => void;
  onCheatsApplied?: (applied: number, ignored: number) => void;
  /**
   * Cheats the core refused. The session keeps running without them — a bad
   * code must never make a game unplayable — and reports them so the UI can
   * point the user at the code that needs fixing.
   */
  onCheatsRejected?: (rejected: CheatRecord[], applied: number) => void;
  onIncompatibleState?: (reason: string) => void;
}

export class SessionError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'SessionError';
  }
}

/** Autosave debounce: long enough to coalesce a burst of SRAM writes. */
const AUTOSAVE_DEBOUNCE_MS = 4000;

export interface CreateSessionOptions {
  core: EmulatorCore;
  game: GameRecord;
  romBytes: Uint8Array;
  settings?: Partial<SessionSettings>;
  hooks?: SessionHooks;
  now?: () => number;
}

export class EmulatorSession {
  readonly game: GameRecord;
  private readonly core: EmulatorCore;
  private readonly romBytes: Uint8Array;
  private readonly hooks: SessionHooks;
  private readonly now: () => number;
  private settings: SessionSettings;

  private state: SessionState = 'preparing';
  private rejectedCheats: CheatRecord[] = [];
  private speedOverride: number | null = null;
  private rewinding = false;
  private pendingSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveDirty = false;
  private lastSavedHash: string | null = null;
  private disposed = false;
  private playStartedAt: number | null = null;
  /** Timestamp of the last state we know is durable in IndexedDB. */
  lastPersistedSaveAt: number | null = null;

  /** `<gameId>:<kind>:<timestamp>:<sequence>` — unique and sortable. */
  private recordId(kind: string): string {
    return nextRecordId(kind, this.game.id, this.now());
  }

  private constructor(options: CreateSessionOptions, settings: SessionSettings) {
    this.core = options.core;
    this.game = options.game;
    this.romBytes = options.romBytes;
    this.hooks = options.hooks ?? {};
    this.now = options.now ?? Date.now;
    this.settings = settings;
  }

  /** Boots the game: seeds the cartridge with the stored save and applies cheats. */
  static async start(options: CreateSessionOptions): Promise<EmulatorSession> {
    const settings = { ...DEFAULT_SESSION_SETTINGS, ...options.settings };
    const session = new EmulatorSession(options, settings);
    const romFileName = session.romFileName();

    const storedSave = await batterySavesRepo.latest(options.game.id);
    session.lastSavedHash = storedSave?.hash ?? null;
    session.lastPersistedSaveAt = storedSave?.savedAt ?? null;

    // Cheats first: the core reads the file during `loadRom`. A refusal here is
    // reported and skipped — it must never stop the game from starting.
    await session.applyCheats(await session.loadCheats());

    const loaded = await session.core.loadRom({
      romFileName,
      bytes: session.romBytes,
      saveBytes: storedSave ? new Uint8Array(storedSave.bytes) : null,
    });
    if (!loaded) {
      throw new SessionError(
        'The emulator could not start this ROM. It may be corrupt or an unsupported cartridge type.',
        'load-failed',
      );
    }

    session.core.applySettings({
      volume: settings.volume,
      muted: settings.muted,
      speedMultiplier: settings.speedMultiplier,
      rewindEnabled: settings.rewindEnabled,
      rewindBufferCapacity: settings.rewindBufferCapacity,
      rewindBufferInterval: settings.rewindBufferInterval,
    });

    session.core.onFrame({
      onSaveDataUpdated: () => {
        session.saveDirty = true;
        session.hooks.onSaveStatus?.({ status: 'pending', lastSavedAt: session.lastPersistedSaveAt });
        session.scheduleAutosave();
      },
      onCoreCrashed: () => {
        session.hooks.onSaveStatus?.({
          status: 'error',
          lastSavedAt: session.lastPersistedSaveAt,
          message: 'The emulator core reported a crash. Reset the game to continue.',
        });
      },
    });

    session.setState('running');
    session.playStartedAt = session.now();
    return session;
  }

  /** File name inside the emulated filesystem — derived from the content hash. */
  romFileName(): string {
    return `${this.game.id}.gba`;
  }

  getSettings(): SessionSettings {
    return { ...this.settings };
  }

  getState(): SessionState {
    return this.state;
  }

  /** Milliseconds of active play in this session, for playtime accounting. */
  elapsedPlaytimeMs(): number {
    if (this.playStartedAt === null) return 0;
    return Math.max(0, this.now() - this.playStartedAt);
  }

  getCurrentSpeed(): number {
    return this.speedOverride ?? this.settings.speedMultiplier;
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onStateChange?.(state);
  }

  // --- playback control ----------------------------------------------------

  pause(): void {
    if (this.disposed || this.state !== 'running') return;
    // Never leave a temporary speed latched while paused.
    this.releaseSpeedOverrides();
    this.core.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.disposed || this.state !== 'paused') return;
    this.core.resume();
    this.setState('running');
  }

  togglePause(): void {
    if (this.state === 'running') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  /** Restarts the ROM. Battery saves survive a reset; in-memory progress does not. */
  async reset(): Promise<void> {
    if (this.disposed) return;
    this.releaseSpeedOverrides();
    await this.flushSave('reset');
    this.core.reset();
    if (this.state === 'paused') this.core.resume();
    this.setState('running');
  }

  // --- speed ---------------------------------------------------------------

  /** Applies the configured normal-speed value. */
  setSpeedMultiplier(multiplier: number): void {
    if (this.disposed) return;
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      throw new SessionError('Speed must be a positive number.', 'invalid-speed');
    }
    if (multiplier < 0.1 || multiplier > 10) {
      throw new SessionError('Speed is limited to between 10% and 1000%.', 'speed-out-of-range');
    }
    this.settings.speedMultiplier = multiplier;
    this.core.applySettings({ speedMultiplier: this.getCurrentSpeed() });
    this.hooks.onSpeedChange?.(this.getCurrentSpeed(), this.speedOverride !== null);
  }

  setFastForwardMultiplier(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
      throw new SessionError('Fast-forward must be between 1x and 10x.', 'invalid-fast-forward');
    }
    this.settings.fastForwardMultiplier = multiplier;
  }

  /**
   * Applies the fast-forward multiplier for the duration of a hold.
   * Returns the multiplier now in effect.
   */
  beginFastForward(): number {
    if (this.disposed || this.state === 'stopped') return this.getCurrentSpeed();
    this.speedOverride = this.settings.fastForwardMultiplier;
    this.core.applySettings({ speedMultiplier: this.speedOverride });
    this.hooks.onSpeedChange?.(this.speedOverride, true);
    return this.speedOverride;
  }

  /** Toggle mode: alternate between fast-forward and normal speed. */
  toggleFastForward(): number {
    if (this.speedOverride !== null) {
      this.endFastForward();
      return this.getCurrentSpeed();
    }
    return this.beginFastForward();
  }

  endFastForward(): void {
    if (this.speedOverride === null) return;
    this.speedOverride = null;
    this.core.applySettings({ speedMultiplier: this.settings.speedMultiplier });
    this.hooks.onSpeedChange?.(this.settings.speedMultiplier, false);
  }

  /** Clears fast-forward and rewind holds. Safe to call at any time. */
  /**
   * Presses or releases a game button.
   *
   * Input goes through the session (not straight to the core) so that it is
   * refused once the session has stopped, it is recorded for teardown, and
   * temporary speed holds are cleared when the user pauses.
   */
  sendInput(button: GbaButton, pressed: boolean): void {
    if (this.state === 'stopped' || this.state === 'preparing') return;
    if (!isGbaButton(button)) return;
    if (pressed) this.core.buttonPress(button);
    else this.core.buttonUnpress(button);
  }

  /** Releases every button; used on blur and teardown so keys cannot stick. */
  releaseAllInputs(): void {
    for (const button of GBA_BUTTONS) this.core.buttonUnpress(button);
  }

  releaseSpeedOverrides(): void {
    this.endFastForward();
    if (this.rewinding) this.stopRewind();
  }

  // --- rewind --------------------------------------------------------------

  setRewindEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.settings.rewindEnabled = enabled;
    this.core.applySettings({
      rewindEnabled: enabled,
      rewindBufferCapacity: this.settings.rewindBufferCapacity,
      rewindBufferInterval: this.settings.rewindBufferInterval,
    });
    if (!enabled) this.stopRewind();
  }

  setRewindBudget(capacity: number, interval: number): void {
    this.settings.rewindBufferCapacity = Math.min(Math.max(Math.round(capacity), 1), 10000);
    this.settings.rewindBufferInterval = Math.min(Math.max(Math.round(interval), 1), 60);
    if (this.settings.rewindEnabled) {
      this.core.applySettings({
        rewindBufferCapacity: this.settings.rewindBufferCapacity,
        rewindBufferInterval: this.settings.rewindBufferInterval,
      });
    }
  }

  hasRewind(): boolean {
    return this.core.capabilities.rewind;
  }

  /**
   * Starts stepping backwards through the rewind history.
   *
   * Fast-forward is cleared first: running backwards *and* fast-forwarded is
   * meaningless and could leave the core in a state the user did not ask for.
   */
  startRewind(): void {
    if (this.disposed || !this.settings.rewindEnabled || this.rewinding) return;
    this.rewinding = true;
    this.endFastForward();
    this.core.setRewindActive(true);
  }

  stopRewind(): void {
    if (!this.rewinding) return;
    this.rewinding = false;
    this.core.setRewindActive(false);
  }

  isRewinding(): boolean {
    return this.rewinding;
  }

  // --- cheats --------------------------------------------------------------

  private async loadCheats(): Promise<CheatRecord[]> {
    return cheatsRepo.listForGame(this.game.id);
  }

  /**
   * Replaces the core's cheat set for this game.
   *
   * Records belonging to another game are never written — they are counted and
   * reported instead, so a caller bug cannot silently apply someone else's codes
   * to this ROM. When nothing is enabled the cheat file is removed entirely:
   * "no cheats" must mean no file, not a stale one.
   *
   * If the core refuses the set (one unparseable code poisons the whole file for
   * GBA cheat engines), the session falls back to applying the codes one at a
   * time and keeps the ones that work. Playing the game always wins over
   * applying a cheat.
   */
  async applyCheats(cheats: CheatRecord[]): Promise<{ applied: number; ignored: number; rejected: number }> {
    const own = cheats.filter((cheat) => cheat.enabled && cheat.gameId === this.game.id);
    const ignored = cheats.length - cheats.filter((cheat) => cheat.gameId === this.game.id).length;

    if (ignored > 0) {
      this.hooks.onIncompatibleState?.(
        `${ignored} cheat ${ignored === 1 ? 'entry belongs' : 'entries belong'} to a different game and ${ignored === 1 ? 'was' : 'were'} not applied.`,
      );
    }

    const contents = serialiseCheatFile(own);
    if (contents.trim().length === 0) {
      await this.core.clearCheatFile(this.romFileName());
      this.hooks.onCheatsApplied?.(0, ignored);
      return { applied: 0, ignored, rejected: 0 };
    }

    if (await this.core.setCheatFile(this.romFileName(), contents)) {
      this.hooks.onCheatsApplied?.(own.length, ignored);
      await this.markCheatsAccepted(own);
      return { applied: own.length, ignored, rejected: 0 };
    }

    // The core refused the set; find out which codes it will take.
    const { accepted, rejected } = await this.triageCheats(own);
    if (accepted.length > 0) {
      await this.core.setCheatFile(this.romFileName(), serialiseCheatFile(accepted));
    } else {
      await this.core.clearCheatFile(this.romFileName());
    }

    this.rejectedCheats = rejected;
    await this.markCheatsRejected(rejected, accepted);
    this.hooks.onCheatsApplied?.(accepted.length, ignored);
    if (rejected.length > 0) {
      this.hooks.onCheatsRejected?.(rejected, accepted.length);
    }
    return { applied: accepted.length, ignored, rejected: rejected.length };
  }

  /** Tests each cheat on its own, so one bad code cannot hide the good ones. */
  private async triageCheats(cheats: CheatRecord[]): Promise<{ accepted: CheatRecord[]; rejected: CheatRecord[] }> {
    const accepted: CheatRecord[] = [];
    const rejected: CheatRecord[] = [];
    for (const cheat of cheats) {
      const single = serialiseCheatFile([cheat]);
      const ok = await this.core.setCheatFile(this.romFileName(), single);
      if (ok) accepted.push(cheat);
      else rejected.push(cheat);
    }
    return { accepted, rejected };
  }

  private async markCheatsRejected(rejected: CheatRecord[], accepted: CheatRecord[]): Promise<void> {
    const reason = 'The emulator could not parse this code, so it was skipped.';
    for (const cheat of rejected) {
      try {
        await cheatsRepo.put({ ...cheat, lastRejectedAt: this.now(), lastRejectedReason: reason });
      } catch {
        /* reporting is best-effort; the game must still start */
      }
    }
    for (const cheat of accepted) {
      if (!cheat.lastRejectedAt) continue;
      try {
        const { lastRejectedAt: _at, lastRejectedReason: _reason, ...clean } = cheat;
        await cheatsRepo.put(clean);
      } catch {
        /* best-effort */
      }
    }
  }

  private async markCheatsAccepted(cheats: CheatRecord[]): Promise<void> {
    await this.markCheatsRejected([], cheats);
  }

  /** Cheats the core refused during startup, newest attempt only. */
  getRejectedCheats(): CheatRecord[] {
    return [...this.rejectedCheats];
  }

  async clearCheats(): Promise<void> {
    await this.core.clearCheatFile(this.romFileName());
    this.hooks.onCheatsApplied?.(0, 0);
  }

  // --- battery saves -------------------------------------------------------

  private scheduleAutosave(): void {
    if (this.pendingSaveTimer) clearTimeout(this.pendingSaveTimer);
    this.pendingSaveTimer = setTimeout(() => {
      this.pendingSaveTimer = null;
      void this.flushSave('autosave');
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Reads the cartridge save out of the core and stores it.
   *
   * Returns the persisted record, or null when there was nothing to write. The
   * `reason` distinguishes automatic from user-triggered writes so the UI can
   * label backups honestly.
   */
  async flushSave(reason: 'autosave' | 'manual' | 'pause' | 'reset' | 'stop' | 'before-load' = 'manual'): Promise<BatterySaveRecord | null> {
    if (this.pendingSaveTimer) {
      clearTimeout(this.pendingSaveTimer);
      this.pendingSaveTimer = null;
    }
    if (this.disposed && reason !== 'stop') return null;

    const bytes = this.core.readBatterySave();
    if (!bytes || bytes.byteLength === 0) {
      this.hooks.onSaveStatus?.({ status: 'idle', lastSavedAt: this.lastPersistedSaveAt });
      return null;
    }

    const copy = bytes.slice();
    const hash = await hashBytesHex(copy);
    if (hash === this.lastSavedHash && reason === 'autosave') {
      this.saveDirty = false;
      this.hooks.onSaveStatus?.({ status: 'saved', lastSavedAt: this.lastPersistedSaveAt });
      return null;
    }

    const record: BatterySaveRecord = {
      id: this.recordId(reason),
      gameId: this.game.id,
      kind: reason === 'autosave' || reason === 'pause' || reason === 'stop' ? 'auto' : 'manual',
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      size: copy.byteLength,
      savedAt: this.now(),
      hash,
      note: reason,
    };

    try {
      await batterySavesRepo.put(record);
      // Keep a short history of automatic saves so a bad save can be walked back.
      if (record.kind === 'auto') await batterySavesRepo.pruneAuto(this.game.id, 5);
      this.lastSavedHash = hash;
      this.lastPersistedSaveAt = record.savedAt;
      this.saveDirty = false;
      this.hooks.onSaveStatus?.({ status: 'saved', lastSavedAt: record.savedAt });
      return record;
    } catch (error) {
      this.hooks.onSaveStatus?.({
        status: 'error',
        lastSavedAt: this.lastPersistedSaveAt,
        message:
          error instanceof Error && 'userMessage' in error
            ? String((error as { userMessage: string }).userMessage)
            : 'The save could not be written to browser storage.',
      });
      throw error;
    }
  }

  hasUnsavedProgress(): boolean {
    return this.saveDirty;
  }

  getSaveStatus(): SaveStateFeedback {
    return {
      status: this.saveDirty ? 'pending' : this.lastPersistedSaveAt ? 'saved' : 'idle',
      lastSavedAt: this.lastPersistedSaveAt,
    };
  }

  /**
   * Replaces the cartridge save with imported bytes.
   *
   * The existing save is copied to a `pre-overwrite` backup first, so an import
   * over live progress is always reversible.
   */
  async importSave(bytes: Uint8Array, note = 'imported save'): Promise<BatterySaveRecord> {
    const existing = await batterySavesRepo.latest(this.game.id);
    if (existing) {
      await batterySavesRepo.put({ ...existing, id: this.recordId('pre-overwrite'), kind: 'pre-overwrite' });
    }

    const copy = bytes.slice();
    const record: BatterySaveRecord = {
      id: this.recordId('import'),
      gameId: this.game.id,
      kind: 'import',
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      size: copy.byteLength,
      savedAt: this.now(),
      hash: await hashBytesHex(copy),
      note,
    };
    await batterySavesRepo.put(record);
    this.lastSavedHash = record.hash;
    this.lastPersistedSaveAt = record.savedAt;
    return record;
  }

  // --- save states ---------------------------------------------------------

  async saveState(slot: number, name: string, note?: string): Promise<SaveStateRecord> {
    const bytes = await this.core.saveState(slot);
    if (!bytes || bytes.byteLength === 0) {
      throw new SessionError('The emulator did not produce a save state.', 'state-empty');
    }

    const copy = bytes.slice();
    const record: SaveStateRecord = {
      id: `${this.game.id}:${slot}:${this.now()}`,
      gameId: this.game.id,
      slot,
      name,
      createdAt: this.now(),
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      size: copy.byteLength,
      thumbnail: await this.captureThumbnail(),
      coreName: this.core.info.name,
      coreVersion: this.core.info.version,
      romHash: this.game.contentHash,
      ...(note ? { note } : {}),
    };
    await saveStatesRepo.put(record);
    return record;
  }

  /** Quick-save: one state per game in slot 0 unless a slot is supplied. */
  async quickSave(slot = 0): Promise<SaveStateRecord> {
    const bytes = await this.core.saveState(slot);
    if (!bytes || bytes.byteLength === 0) {
      throw new SessionError('The emulator did not produce a save state.', 'state-empty');
    }
    const copy = bytes.slice();
    const record: SaveStateRecord = {
      id: this.recordId(`state-${slot}`),
      gameId: this.game.id,
      slot,
      name: slot === 0 ? 'Quick save' : `Slot ${slot}`,
      createdAt: this.now(),
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      size: copy.byteLength,
      thumbnail: await this.captureThumbnail(),
      coreName: this.core.info.name,
      coreVersion: this.core.info.version,
      romHash: this.game.contentHash,
    };
    await saveStatesRepo.replaceSlot(record);
    return record;
  }

  /**
   * Loads a save state, refusing states that belong to different ROM bytes.
   *
   * A mismatch means the user picked a state for a different game (or a
   * different revision of the same game); loading it would corrupt the session,
   * so it is rejected with an explanation instead.
   */
  async loadStateRecord(record: SaveStateRecord): Promise<void> {
    if (record.romHash !== this.game.contentHash) {
      const reason =
        'That save state belongs to a different ROM than the one running. Loading it could corrupt this session, so it was not applied.';
      this.hooks.onIncompatibleState?.(reason);
      throw new SessionError(reason, 'state-rom-mismatch');
    }
    if (record.coreName !== this.core.info.name) {
      const reason = `That save state was created with a different emulator core (${record.coreName}).`;
      this.hooks.onIncompatibleState?.(reason);
      throw new SessionError(reason, 'state-core-mismatch');
    }
    if (record.size === 0) {
      throw new SessionError('That save state file is empty.', 'state-empty');
    }

    // Persist live progress before it is replaced by the state.
    await this.flushSave('before-load');

    const loaded = await this.core.loadState(record.slot, new Uint8Array(record.bytes));
    if (!loaded) {
      throw new SessionError(
        'The emulator could not load that save state. It may be corrupt or created by an incompatible version.',
        'state-load-failed',
      );
    }
  }

  async quickLoad(slot = 0): Promise<SaveStateRecord> {
    const states = await saveStatesRepo.listForGame(this.game.id);
    const match = states.find((state) => state.slot === slot);
    if (!match) throw new SessionError('There is no quick save for this game yet.', 'state-missing');
    await this.loadStateRecord(match);
    return match;
  }

  /** Save states can be exported and re-imported as raw files. */
  async exportState(record: SaveStateRecord): Promise<Uint8Array> {
    return new Uint8Array(record.bytes);
  }

  /**
   * Imports a raw state file.
   *
   * The bytes are written into the core's filesystem and loaded; only if the
   * core accepts them is the state stored, so a bad file cannot leave a broken
   * entry in the user's list.
   */
  async importState(bytes: Uint8Array, slot: number, name: string): Promise<SaveStateRecord> {
    if (bytes.byteLength === 0) {
      throw new SessionError('That file is empty.', 'state-empty');
    }
    await this.flushSave('before-load');
    const loaded = await this.core.loadState(slot, bytes);
    if (!loaded) {
      throw new SessionError(
        'The emulator rejected that save state. It may belong to a different game or core version.',
        'state-load-failed',
      );
    }
    const copy = bytes.slice();
    const record: SaveStateRecord = {
      id: `${this.game.id}:${slot}:${this.now()}`,
      gameId: this.game.id,
      slot,
      name,
      createdAt: this.now(),
      bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      size: copy.byteLength,
      thumbnail: await this.captureThumbnail(),
      coreName: this.core.info.name,
      coreVersion: this.core.info.version,
      romHash: this.game.contentHash,
    };
    await saveStatesRepo.put(record);
    return record;
  }

  // --- screenshots ---------------------------------------------------------

  private async captureThumbnail(): Promise<Blob | null> {
    try {
      const png = await this.core.captureScreenshot();
      if (!png) return null;
      return new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' });
    } catch {
      // A missing thumbnail must never fail a save-state write.
      return null;
    }
  }

  /** Captures the framebuffer (no UI chrome) and stores it in the gallery. */
  async takeScreenshot(): Promise<{ blob: Blob; width: number; height: number; record: ScreenshotRecord }> {
    const png = await this.core.captureScreenshot();
    if (!png) throw new SessionError('The emulator could not capture a screenshot.', 'screenshot-failed');

    const dimensions = pngDimensions(png);
    const blob = new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' });
    const record: ScreenshotRecord = {
      id: this.recordId('shot'),
      gameId: this.game.id,
      createdAt: this.now(),
      width: dimensions.width,
      height: dimensions.height,
      blob,
    };
    await screenshotsRepo.put(record);
    return { blob, width: dimensions.width, height: dimensions.height, record };
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Ends the session: flush the save, drop the game, detach callbacks.
   *
   * Called on game switch, on navigating back to the library, and from the
   * `pagehide` handler. It is idempotent.
   */
  async stop(options: { keepCore?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    this.releaseSpeedOverrides();
    try {
      await this.flushSave('stop');
    } catch {
      // Already reported through onSaveStatus; never block teardown.
    }
    try {
      await this.core.clearCheatFile(this.romFileName());
    } catch {
      /* nothing to clear */
    }
    this.core.onFrame({});
    if (!options.keepCore) {
      await this.core.unmount();
    }
    this.disposed = true;
    this.playStartedAt = null;
    this.setState('stopped');
  }

  isDisposed(): boolean {
    return this.disposed;
  }
}

/** Reads PNG dimensions from the IHDR chunk without decoding the image. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 24) return { width: 0, height: 0 };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
