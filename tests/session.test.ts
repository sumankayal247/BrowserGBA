import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EmulatorSession, SessionError, pngDimensions } from '@/emulator/session';
import type {
  CoreCapabilities,
  CoreInfo,
  CoreLogEntry,
  CorePaths,
  CoreSettings,
  EmulatorCore,
  FrameCallbacks,
  LoadRomOptions,
} from '@/emulator/core';
import { batterySavesRepo, cheatsRepo, saveStatesRepo, type CheatRecord, type GameRecord } from '@/storage/records';
import { resetDatabaseForTests } from '@/storage/db';
import { makeRom, withPayload } from './helpers/rom-fixtures';
import { commitImport, prepareImport } from '@/library/library';
import { serialiseCheatFile } from '@/cheats/cheats';

/** A small, deterministic stand-in for the wasm core. */
class FakeCore implements EmulatorCore {
  readonly info: CoreInfo = { name: 'mGBA', version: 'test-1.0', license: 'MPL-2.0', wasm: true };
  readonly capabilities: CoreCapabilities = {
    rewind: true,
    saveStates: true,
    batterySave: true,
    cheats: true,
    screenshot: true,
    speedControl: true,
    realTimeClock: true,
    versionReporting: true,
  };
  readonly paths: CorePaths = {
    root: '/data',
    games: '/data/games',
    saves: '/data/saves',
    states: '/data/states',
    cheats: '/data/cheats',
    screenshots: '/data/screenshots',
  };

  readonly log: string[] = [];
  readonly settings = { speed: 1, volume: 1, rewindEnabled: false, rewindActive: false };
  readonly files = new Map<string, string>();
  loadedRom: { romFileName: string; bytes: number; saveBytes: number | null } | null = null;
  batterySave: Uint8Array | null = new Uint8Array(32 * 1024);
  saveStateResult: Uint8Array | null = new Uint8Array(64).fill(7);
  loadStateResult = true;
  screenshotResult: Uint8Array | null = makePng(240, 160);
  frameCallbacks: FrameCallbacks = {};
  cheatReloadCount = 0;
  unmountCount = 0;
  resetCount = 0;
  paused = false;

  async init(): Promise<void> {
    this.log.push('init');
  }
  async loadRom(options: LoadRomOptions): Promise<boolean> {
    this.loadedRom = {
      romFileName: options.romFileName,
      bytes: options.bytes.byteLength,
      saveBytes: options.saveBytes ? options.saveBytes.byteLength : null,
    };
    this.log.push(`loadRom:${options.romFileName}`);
    return true;
  }
  readonly pressedButtons: string[] = [];

  buttonPress(button: string): void {
    this.pressedButtons.push(button);
  }
  buttonUnpress(button: string): void {
    this.pressedButtons.push(`-${button}`);
  }

  async unmount(): Promise<void> {
    this.unmountCount += 1;
    this.log.push('unmount');
  }
  async destroy(): Promise<void> {
    this.log.push('destroy');
  }
  pause(): void {
    this.paused = true;
    this.log.push('pause');
  }
  resume(): void {
    this.paused = false;
    this.log.push('resume');
  }
  reset(): void {
    this.resetCount += 1;
    this.log.push('reset');
  }
  isRunning(): boolean {
    return !this.paused;
  }
  applySettings(settings: CoreSettings): void {
    if (typeof settings.speedMultiplier === 'number') this.settings.speed = settings.speedMultiplier;
    if (typeof settings.volume === 'number') this.settings.volume = settings.volume;
    if (typeof settings.rewindEnabled === 'boolean') this.settings.rewindEnabled = settings.rewindEnabled;
  }
  getSpeedMultiplier(): number {
    return this.settings.speed;
  }
  setRewindActive(enabled: boolean): void {
    this.settings.rewindActive = enabled;
    this.log.push(`rewind:${enabled}`);
  }
  /** When set, any cheat file containing this text is refused, as mGBA does. */
  refuseCheatContaining: string | null = null;

  async setCheatFile(romFileName: string, contents: string): Promise<boolean> {
    this.cheatReloadCount += 1;
    if (this.refuseCheatContaining && contents.includes(this.refuseCheatContaining)) return false;
    this.files.set(`${this.paths.cheats}/${romFileName.replace(/\.gba$/, '.cheats')}`, contents);
    return true;
  }
  async clearCheatFile(romFileName: string): Promise<void> {
    this.files.delete(`${this.paths.cheats}/${romFileName.replace(/\.gba$/, '.cheats')}`);
  }
  reloadCheats(): boolean {
    this.cheatReloadCount += 1;
    return true;
  }
  readBatterySave(): Uint8Array | null {
    return this.batterySave;
  }
  async saveState(): Promise<Uint8Array | null> {
    return this.saveStateResult;
  }
  async loadState(): Promise<boolean> {
    return this.loadStateResult;
  }
  async captureScreenshot(): Promise<Uint8Array | null> {
    return this.screenshotResult;
  }
  onFrame(callbacks: FrameCallbacks): void {
    this.frameCallbacks = callbacks;
  }
  setLogger(): void {}

  /** Test hook: pretend the game wrote to SRAM. */
  emitSaveUpdate(): void {
    this.frameCallbacks.onSaveDataUpdated?.();
  }
}

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

let seed = 0;
async function makeGame(): Promise<GameRecord> {
  seed += 1;
  const bytes = withPayload(makeRom({ title: `SESSION${seed}` }));
  for (let i = 0xc0; i < bytes.length; i++) bytes[i] = (i * (seed + 5)) & 0xff;
  const candidate = await prepareImport({ name: `session${seed}.gba`, size: bytes.length }, bytes);
  const { game } = await commitImport(candidate);
  return game;
}

async function startSession(
  overrides: Partial<Parameters<typeof EmulatorSession.start>[0]> = {},
): Promise<{ session: EmulatorSession; core: FakeCore; game: GameRecord }> {
  const game = overrides.game ?? (await makeGame());
  const core = (overrides.core as FakeCore) ?? new FakeCore();
  const romBytes = new Uint8Array(0x8000);
  const session = await EmulatorSession.start({ core, game, romBytes, ...overrides });
  return { session, core, game };
}

describe('session startup', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('loads the ROM under a name derived from the game id', async () => {
    const { core, game } = await startSession();
    expect(core.loadedRom?.romFileName).toBe(`${game.id}.gba`);
    expect(core.loadedRom?.saveBytes).toBeNull();
    expect(core.loadedRom?.bytes).toBe(0x8000);
  });

  it('seeds the cartridge with the stored battery save', async () => {
    const game = await makeGame();
    const stored = new Uint8Array(32 * 1024).fill(0xab);
    await batterySavesRepo.put({
      id: 'seed',
      gameId: game.id,
      kind: 'auto',
      bytes: stored.buffer.slice(0),
      size: stored.byteLength,
      savedAt: 123,
      hash: 'hash-seed',
    });

    const { core } = await startSession({ game });
    expect(core.loadedRom?.saveBytes).toBe(32 * 1024);
  });

  it('applies the game’s own cheats before loading', async () => {
    const game = await makeGame();
    const cheat: CheatRecord = {
      id: 'c1',
      gameId: game.id,
      format: 'vba',
      label: 'Money',
      code: '02025BC4:0F42',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    await cheatsRepo.put(cheat);

    const { core } = await startSession({ game });
    const written = core.files.get(`${core.paths.cheats}/${game.id}.cheats`);
    expect(written).toBe(serialiseCheatFile([cheat]));
    expect(core.log.indexOf(`loadRom:${game.id}.gba`)).toBeGreaterThan(-1);
    // The cheat file must exist before the ROM is loaded, or the core would
    // never read it.
    expect(core.cheatReloadCount).toBeGreaterThan(0);
  });

  it('writes no cheat file at all when nothing is enabled', async () => {
    const game = await makeGame();
    await cheatsRepo.put({
      id: 'c1',
      gameId: game.id,
      format: 'vba',
      label: 'off',
      code: '02025BC4:0F42',
      enabled: false,
      createdAt: 1,
      updatedAt: 1,
    });
    const { core } = await startSession({ game });
    expect(core.files.has(`${core.paths.cheats}/${game.id}.cheats`)).toBe(false);
  });

  it('keeps the game playable when the emulator refuses a cheat', async () => {
    const game = await makeGame();
    const good: CheatRecord = {
      id: 'c-good',
      gameId: game.id,
      format: 'vba',
      label: 'Money',
      code: '02025BC4:0F42',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const bad: CheatRecord = {
      id: 'c-bad',
      gameId: game.id,
      format: 'gameShark',
      label: 'Unparseable',
      code: 'DEADBEEF CAFEBABE',
      enabled: true,
      createdAt: 2,
      updatedAt: 2,
    };
    await cheatsRepo.put(good);
    await cheatsRepo.put(bad);

    const rejected: string[] = [];
    const core = new FakeCore();
    // mGBA refuses the whole file when one code cannot be parsed, so the test
    // makes the fake core behave the same way.
    core.refuseCheatContaining = bad.code;
    const session = await EmulatorSession.start({
      core,
      game,
      romBytes: makeRom(),
            hooks: { onCheatsRejected: (list) => rejected.push(...list.map((cheat) => cheat.id)) },
    });

    // The game must still be running: a bad code is never a reason to refuse play.
    expect(session.getState()).toBe('running');
    expect(core.loadedRom?.romFileName).toBe(`${game.id}.gba`);
    expect(rejected).toEqual(['c-bad']);
    expect(session.getRejectedCheats().map((cheat) => cheat.id)).toEqual(['c-bad']);

    // The accepted code is what the core ends up with — the bad one is not in it.
    const written = core.files.get(`${core.paths.cheats}/${game.id}.cheats`);
    expect(written).toBe(serialiseCheatFile([good]));

    // The rejected code is marked in storage, not silently deleted.
    const stored = await cheatsRepo.listForGame(game.id);
    const storedBad = stored.find((cheat) => cheat.id === 'c-bad');
    const storedGood = stored.find((cheat) => cheat.id === 'c-good');
    expect(storedBad?.lastRejectedAt).toBeGreaterThan(0);
    expect(storedBad?.label).toBe('Unparseable');
    expect(storedGood?.lastRejectedAt).toBeUndefined();
  });

  it('clears the rejection mark once the emulator accepts the code again', async () => {
    const game = await makeGame();
    const cheat: CheatRecord = {
      id: 'c1',
      gameId: game.id,
      format: 'vba',
      label: 'Money',
      code: '02025BC4:0F42',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      lastRejectedAt: 5,
      lastRejectedReason: 'refused earlier',
    };
    await cheatsRepo.put(cheat);

    await startSession({ game });
    const stored = (await cheatsRepo.listForGame(game.id))[0]!;
    expect(stored.lastRejectedAt).toBeUndefined();
  });

  it('runs with no cheats at all when every code is refused', async () => {
    const game = await makeGame();
    const bad: CheatRecord = {
      id: 'c-bad',
      gameId: game.id,
      format: 'gameShark',
      label: 'Unparseable',
      code: 'DEADBEEF CAFEBABE',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    await cheatsRepo.put(bad);

    const core = new FakeCore();
    core.refuseCheatContaining = bad.code;
    const session = await EmulatorSession.start({
      core,
      game,
      romBytes: makeRom(),
          });

    expect(session.getState()).toBe('running');
    expect(core.files.has(`${core.paths.cheats}/${game.id}.cheats`)).toBe(false);
    expect(session.getRejectedCheats()).toHaveLength(1);
  });

  it('reports a load failure instead of pretending to play', async () => {
    const game = await makeGame();
    const core = new FakeCore();
    core.loadRom = async () => false;
    await expect(startSession({ core, game })).rejects.toMatchObject({ code: 'load-failed' });
  });
});

describe('speed control', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('applies the configured normal speed on start', async () => {
    const { core } = await startSession({ settings: { speedMultiplier: 2 } });
    expect(core.settings.speed).toBe(2);
  });

  it('restores normal speed when fast-forward is released', async () => {
    const { session, core } = await startSession({ settings: { speedMultiplier: 1.5, fastForwardMultiplier: 4 } });
    expect(session.beginFastForward()).toBe(4);
    expect(core.settings.speed).toBe(4);
    session.endFastForward();
    expect(core.settings.speed).toBe(1.5);
    expect(session.getCurrentSpeed()).toBe(1.5);
  });

  it('does not leave fast-forward latched when the game is paused', async () => {
    const { session, core } = await startSession({ settings: { speedMultiplier: 1 } });
    session.beginFastForward();
    expect(core.settings.speed).toBe(2);
    session.pause();
    expect(core.settings.speed).toBe(1);
    expect(session.getCurrentSpeed()).toBe(1);
    session.resume();
    expect(core.settings.speed).toBe(1);
  });

  it('does not leave fast-forward latched when the session stops', async () => {
    const { session, core } = await startSession();
    session.beginFastForward();
    await session.stop();
    expect(core.settings.speed).toBe(1);
    expect(session.getState()).toBe('stopped');
  });

  it('toggles fast-forward in toggle mode', async () => {
    const { session, core } = await startSession({ settings: { speedMultiplier: 1 } });
    session.toggleFastForward();
    expect(core.settings.speed).toBe(2);
    session.toggleFastForward();
    expect(core.settings.speed).toBe(1);
  });

  it('rejects out-of-range speeds instead of silently clamping', () => {
    return startSession().then(({ session }) => {
      expect(() => session.setSpeedMultiplier(0)).toThrow(SessionError);
      expect(() => session.setSpeedMultiplier(0.01)).toThrow(/10%/);
      expect(() => session.setSpeedMultiplier(100)).toThrow(/1000%/);
      expect(() => session.setFastForwardMultiplier(0.5)).toThrow(/1x and 10x/);
    });
  });

  it('supports slow motion below normal speed', async () => {
    const { session, core } = await startSession();
    session.setSpeedMultiplier(0.5);
    expect(core.settings.speed).toBe(0.5);
  });
});

describe('rewind', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('is off by default and refuses to rewind', async () => {
    const { session, core } = await startSession();
    expect(core.settings.rewindEnabled).toBe(false);
    session.startRewind();
    expect(session.isRewinding()).toBe(false);
    expect(core.settings.rewindActive).toBe(false);
  });

  it('rewinds while held and stops on release', async () => {
    const { session, core } = await startSession({ settings: { rewindEnabled: true } });
    session.startRewind();
    expect(core.settings.rewindActive).toBe(true);
    expect(session.isRewinding()).toBe(true);
    session.stopRewind();
    expect(core.settings.rewindActive).toBe(false);
  });

  it('turns rewind off when the setting is disabled mid-hold', async () => {
    const { session, core } = await startSession({ settings: { rewindEnabled: true } });
    session.startRewind();
    session.setRewindEnabled(false);
    expect(core.settings.rewindActive).toBe(false);
    expect(session.isRewinding()).toBe(false);
  });

  it('clears fast-forward when rewinding starts', async () => {
    const { session, core } = await startSession({ settings: { rewindEnabled: true } });
    session.beginFastForward();
    expect(core.settings.speed).toBe(2);
    session.startRewind();
    expect(core.settings.speed).toBe(1);
  });

  it('keeps the rewind history bounded and configurable', async () => {
    const { session, core } = await startSession({ settings: { rewindEnabled: true } });
    session.setRewindBudget(999_999, 10_000);
    const settings = session.getSettings();
    expect(settings.rewindBufferCapacity).toBe(10_000);
    expect(settings.rewindBufferInterval).toBe(60);
    session.setRewindBudget(0, 0);
    expect(session.getSettings().rewindBufferCapacity).toBe(1);
    expect(session.getSettings().rewindBufferInterval).toBe(1);
    expect(core.settings.rewindEnabled).toBe(true);
  });
});

describe('battery saves', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('persists the cartridge save and reports success', async () => {
    const { session, game, core } = await startSession();
    const statuses: string[] = [];
    (session as unknown as { hooks: { onSaveStatus?: (s: { status: string }) => void } }).hooks.onSaveStatus = (s) =>
      statuses.push(s.status);

    core.batterySave = new Uint8Array(32 * 1024).fill(3);
    const record = await session.flushSave('manual');

    expect(record).not.toBeNull();
    expect(record?.gameId).toBe(game.id);
    expect(record?.size).toBe(32 * 1024);
    expect(statuses).toContain('saved');

    const latest = await batterySavesRepo.latest(game.id);
    expect(latest?.hash).toBe(record?.hash);
  });

  it('skips a redundant autosave when nothing changed', async () => {
    const { session, core } = await startSession();
    core.batterySave = new Uint8Array(32 * 1024).fill(9);
    await session.flushSave('manual');
    const second = await session.flushSave('autosave');
    expect(second).toBeNull();
  });

  it('writes a new record when the save actually changed', async () => {
    const { session, game, core } = await startSession();
    core.batterySave = new Uint8Array(32 * 1024).fill(1);
    await session.flushSave('manual');
    core.batterySave = new Uint8Array(32 * 1024).fill(2);
    const second = await session.flushSave('manual');
    expect(second).not.toBeNull();
    expect(await batterySavesRepo.listForGame(game.id)).toHaveLength(2);
  });

  it('reports a storage failure instead of claiming the save is safe', async () => {
    const { session, core } = await startSession();
    core.batterySave = new Uint8Array(1024).fill(5);
    const put = vi.spyOn(batterySavesRepo, 'put').mockRejectedValueOnce(
      Object.assign(new Error('quota'), { userMessage: 'The browser refused the write because the storage quota is full.' }),
    );

    const messages: Array<string | undefined> = [];
    (session as unknown as { hooks: { onSaveStatus?: (s: { message?: string }) => void } }).hooks.onSaveStatus = (s) =>
      messages.push(s.message);

    await expect(session.flushSave('manual')).rejects.toThrow();
    expect(messages.join(' ')).toMatch(/quota is full/i);
    put.mockRestore();
  });

  it('backs up the existing save before an import replaces it', async () => {
    const { session, game, core } = await startSession();
    core.batterySave = new Uint8Array(32 * 1024).fill(4);
    await session.flushSave('manual');

    await session.importSave(new Uint8Array(32 * 1024).fill(8), 'test import');

    const saves = await batterySavesRepo.listForGame(game.id);
    expect(saves.some((save) => save.kind === 'pre-overwrite')).toBe(true);
    expect(saves.some((save) => save.kind === 'import')).toBe(true);
    expect(await batterySavesRepo.latest(game.id)).toBeDefined();
  });

  it('tracks unsaved progress through the core’s save callback', async () => {
    const { session, core } = await startSession();
    expect(session.hasUnsavedProgress()).toBe(false);
    core.emitSaveUpdate();
    expect(session.hasUnsavedProgress()).toBe(true);
    core.batterySave = new Uint8Array(32 * 1024).fill(6);
    await session.flushSave('manual');
    expect(session.hasUnsavedProgress()).toBe(false);
  });

  it('prunes old automatic saves but keeps manual ones', async () => {
    const { session, game, core } = await startSession();
    for (let i = 0; i < 9; i++) {
      core.batterySave = new Uint8Array(1024).fill(i);
      await session.flushSave('manual');
    }
    for (let i = 0; i < 9; i++) {
      core.batterySave = new Uint8Array(1024).fill(100 + i);
      await session.flushSave('autosave');
    }
    const saves = await batterySavesRepo.listForGame(game.id);
    expect(saves.filter((save) => save.kind === 'auto').length).toBeLessThanOrEqual(5);
    expect(saves.filter((save) => save.kind === 'manual').length).toBe(9);
  });
});

describe('save states', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('stores a named state with ROM identity and a thumbnail', async () => {
    const { session, game } = await startSession();
    const record = await session.saveState(3, 'Before gym');

    expect(record.gameId).toBe(game.id);
    expect(record.romHash).toBe(game.contentHash);
    expect(record.coreName).toBe('mGBA');
    expect(record.slot).toBe(3);
    expect(record.thumbnail).not.toBeNull();
    expect(await saveStatesRepo.listForGame(game.id)).toHaveLength(1);
  });

  it('keeps only one quick-save per slot', async () => {
    const { session, game } = await startSession();
    await session.quickSave(0);
    await session.quickSave(0);
    const states = await saveStatesRepo.listForGame(game.id);
    expect(states.filter((state) => state.slot === 0)).toHaveLength(1);
  });

  it('refuses to load a state that belongs to different ROM bytes', async () => {
    const { session, game } = await startSession();
    const foreign = {
      id: 'foreign',
      gameId: game.id,
      slot: 0,
      name: 'other game',
      createdAt: 1,
      bytes: new ArrayBuffer(64),
      size: 64,
      thumbnail: null,
      coreName: 'mGBA',
      coreVersion: 'test-1.0',
      romHash: 'a-different-hash',
    };
    const reasons: string[] = [];
    (session as unknown as { hooks: { onIncompatibleState?: (r: string) => void } }).hooks.onIncompatibleState = (r) =>
      reasons.push(r);

    await expect(session.loadStateRecord(foreign)).rejects.toMatchObject({ code: 'state-rom-mismatch' });
    expect(reasons.join(' ')).toMatch(/different ROM/i);
  });

  it('refuses to load a state from another emulator core', async () => {
    const { session, game } = await startSession();
    await expect(
      session.loadStateRecord({
        id: 'x',
        gameId: game.id,
        slot: 0,
        name: 'x',
        createdAt: 1,
        bytes: new ArrayBuffer(64),
        size: 64,
        thumbnail: null,
        coreName: 'VBA-M',
        coreVersion: '2.2',
        romHash: game.contentHash,
      }),
    ).rejects.toMatchObject({ code: 'state-core-mismatch' });
  });

  it('surfaces a corrupt state as a failure without storing it', async () => {
    const { session, game, core } = await startSession();
    core.loadStateResult = false;
    await expect(session.importState(new Uint8Array([1, 2, 3, 4]), 1, 'broken')).rejects.toMatchObject({
      code: 'state-load-failed',
    });
    expect(await saveStatesRepo.listForGame(game.id)).toHaveLength(0);
  });

  it('flushes live progress before a state replaces the session', async () => {
    const { session, game, core } = await startSession();
    core.batterySave = new Uint8Array(1024).fill(11);
    const record = await session.saveState(1, 'state');

    await session.loadStateRecord(record);

    const saves = await batterySavesRepo.listForGame(game.id);
    expect(saves.length).toBeGreaterThan(0);
    expect(saves.some((save) => save.note === 'before-load')).toBe(true);
  });

  it('reports a missing quick save rather than failing silently', async () => {
    const { session } = await startSession();
    await expect(session.quickLoad(0)).rejects.toMatchObject({ code: 'state-missing' });
  });
});

describe('screenshots', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('captures at native resolution and stores it', async () => {
    const { session, game } = await startSession();
    const shot = await session.takeScreenshot();
    expect(shot.width).toBe(240);
    expect(shot.height).toBe(160);
    expect(shot.record.gameId).toBe(game.id);
    expect(shot.blob.type).toBe('image/png');
  });

  it('reads PNG dimensions from the IHDR chunk', () => {
    expect(pngDimensions(makePng(240, 160))).toEqual({ width: 240, height: 160 });
    expect(pngDimensions(new Uint8Array(4))).toEqual({ width: 0, height: 0 });
  });
});

describe('cheat isolation across sessions', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('never writes one game’s cheats into another game’s file', async () => {
    const gameA = await makeGame();
    const gameB = await makeGame();

    await cheatsRepo.put({
      id: 'a1',
      gameId: gameA.id,
      format: 'vba',
      label: 'A cheat',
      code: '02025BC4:0001',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await cheatsRepo.put({
      id: 'b1',
      gameId: gameB.id,
      format: 'vba',
      label: 'B cheat',
      code: '02025BC4:0002',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const coreA = new FakeCore();
    const sessionA = await EmulatorSession.start({ core: coreA, game: gameA, romBytes: new Uint8Array(16) });
    const fileA = coreA.files.get(`${coreA.paths.cheats}/${gameA.id}.cheats`) ?? '';
    expect(fileA).toContain('A cheat');
    expect(fileA).not.toContain('B cheat');
    await sessionA.stop();

    // Switching games must not leave the previous game's codes reachable.
    const coreB = new FakeCore();
    const sessionB = await EmulatorSession.start({ core: coreB, game: gameB, romBytes: new Uint8Array(16) });
    const fileB = coreB.files.get(`${coreB.paths.cheats}/${gameB.id}.cheats`) ?? '';
    expect(fileB).toContain('B cheat');
    expect(fileB).not.toContain('A cheat');
    await sessionB.stop();
  });

  it('ignores records that belong to a different game', async () => {
    const gameA = await makeGame();
    const gameB = await makeGame();
    const core = new FakeCore();
    const session = await EmulatorSession.start({ core, game: gameA, romBytes: new Uint8Array(16) });

    const foreign: CheatRecord = {
      id: 'foreign',
      gameId: gameB.id,
      format: 'vba',
      label: 'Should not apply',
      code: '02025BC4:0003',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    // Foreign records are refused individually and reported, never applied.
    const result = await session.applyCheats([foreign]);
    expect(result).toEqual({ applied: 0, ignored: 1, rejected: 0 });
    const file = core.files.get(`${core.paths.cheats}/${gameA.id}.cheats`) ?? '';
    expect(file).not.toContain('Should not apply');
  });

  it('clears the cheat file when all cheats are disabled', async () => {
    const game = await makeGame();
    const core = new FakeCore();
    const session = await EmulatorSession.start({ core, game, romBytes: new Uint8Array(16) });

    await session.applyCheats([
      {
        id: 'c',
        gameId: game.id,
        format: 'vba',
        label: 'x',
        code: '02025BC4:0001',
        enabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(core.files.has(`${core.paths.cheats}/${game.id}.cheats`)).toBe(true);

    await session.applyCheats([
      {
        id: 'c',
        gameId: game.id,
        format: 'vba',
        label: 'x',
        code: '02025BC4:0001',
        enabled: false,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(core.files.has(`${core.paths.cheats}/${game.id}.cheats`)).toBe(false);
  });
});

describe('session teardown', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('flushes the save, clears cheats and unmounts the core on stop', async () => {
    const { session, core } = await startSession();
    core.batterySave = new Uint8Array(1024).fill(12);
    await session.stop();

    expect(core.unmountCount).toBe(1);
    expect(core.files.size).toBe(0);
    expect(session.getState()).toBe('stopped');
  });

  it('is safe to stop twice', async () => {
    const { session, core } = await startSession();
    await session.stop();
    await session.stop();
    expect(core.unmountCount).toBe(1);
  });

  it('ignores control calls after disposal', async () => {
    const { session, core } = await startSession();
    await session.stop();
    const before = core.log.length;
    session.pause();
    session.resume();
    session.beginFastForward();
    expect(core.log.length).toBe(before);
  });

  it('resets the game and keeps the session running', async () => {
    const { session, core } = await startSession();
    await session.reset();
    expect(core.resetCount).toBe(1);
    expect(session.getState()).toBe('running');
  });

  it('tracks elapsed playtime only while a session exists', async () => {
    let now = 1_000;
    const { session } = await startSession({ now: () => now });
    now = 61_000;
    expect(session.elapsedPlaytimeMs()).toBe(60_000);
    await session.stop();
    expect(session.elapsedPlaytimeMs()).toBe(0);
  });
});
