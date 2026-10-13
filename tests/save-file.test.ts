import { describe, it, expect, beforeEach } from 'vitest';
import { SAVE_FILE_SIZES, checkSaveFile } from '@/storage/save-file';
import { writeImportedSave } from '@/storage/save-import';
import { batterySavesRepo, type BatterySaveRecord } from '@/storage/records';
import { closeDatabase, resetDatabaseForTests } from '@/storage/db';
import { nextRecordId } from '@/storage/ids';
import { hashBytesHex } from '@/storage/hash';

/**
 * The sizes below are the whole contract of a battery save file: a cartridge
 * save is a fixed-size blob of save memory with no header, so the size is what
 * says whether a file can be handed to the emulator at all. Everything here is
 * behaviour the user sees — the messages are asserted, not just the booleans,
 * because "that file is 3 bytes" is the difference between a refusal the user
 * can act on and one they cannot.
 */
describe('battery save files the user brings in', () => {
  it('accepts every size a GBA cartridge actually shipped with', () => {
    const accepted = Object.values(SAVE_FILE_SIZES).map((size) => checkSaveFile('save.sav', size));
    expect(accepted.every((check) => check.ok)).toBe(true);
    expect(accepted.map((check) => (check.ok ? check.kind : null))).toEqual([
      'eeprom-4k',
      'eeprom-64k',
      'sram',
      'flash-512k',
      'flash-1m',
    ]);
  });

  it('names the cartridge type it recognised, so the toast can say what it loaded', () => {
    const check = checkSaveFile('pokemon.sav', 32768);
    expect(check.ok && check.label).toBe('SRAM (32 KiB)');
  });

  it('never decides from the file name', () => {
    // Real exports arrive as .sav, .srm, .bin or with no extension at all.
    for (const name of ['save.sav', 'save.srm', 'save.bin', 'save', 'SAVE.SAV']) {
      expect(checkSaveFile(name, 8192).ok).toBe(true);
    }
  });

  it('refuses an empty file with a reason that says why', () => {
    const check = checkSaveFile('empty.sav', 0);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toMatch(/empty/i);
  });

  it('refuses a file of the wrong size and lists the sizes that would work', () => {
    const check = checkSaveFile('rom.gba', 8899);
    expect(check.ok).toBe(false);
    const reason = check.ok === false ? check.reason : '';
    expect(reason).toContain('8,899 bytes');
    expect(reason).toContain('32 KiB');
    expect(reason).toMatch(/different kind of file/i);
  });

  it('refuses a save state presented as a battery save', () => {
    // Save states are a different mechanism entirely and their size is arbitrary.
    expect(checkSaveFile('state.ss0', 145_000).ok).toBe(false);
    expect(checkSaveFile('state.ss0', 1024).ok).toBe(false);
  });
});

describe('writing an imported save', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('keeps the save it replaces, so an import is reversible', async () => {
    const before = new Uint8Array(32768).fill(0xff);
    await batterySavesRepo.put(save('manual', before, 1));

    const imported = new Uint8Array(32768).fill(0x11);
    const record = await writeImportedSave({
      gameId: 'game-1',
      bytes: imported,
      note: 'imported from save.sav',
      nextId: (kind) => nextRecordId(kind, 'game-1'),
      now: () => 1000,
    });

    const all = await batterySavesRepo.listForGame('game-1');
    const backup = all.find((row) => row.kind === 'pre-overwrite');
    expect(backup?.bytes.byteLength).toBe(32768);
    expect(new Uint8Array(backup!.bytes)[0]).toBe(0xff);
    expect(record.kind).toBe('import');
    expect(new Uint8Array(record.bytes)[0]).toBe(0x11);
    await closeDatabase();
  });

  it('stores the size and hash of the bytes it actually wrote', async () => {
    const bytes = new Uint8Array(8192);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;

    const record = await writeImportedSave({
      gameId: 'game-2',
      bytes,
      note: 'imported',
      nextId: (kind) => nextRecordId(kind, 'game-2'),
      now: () => 2000,
    });

    expect(record.size).toBe(8192);
    expect(record.hash).toBe(await hashBytesHex(bytes));
    expect(record.gameId).toBe('game-2');
    expect(record.savedAt).toBe(2000);
    await closeDatabase();
  });

  it('makes the import the newest save for that game', async () => {
    await batterySavesRepo.put(save('manual', new Uint8Array(32768), 1));

    const record = await writeImportedSave({
      gameId: 'game-3',
      bytes: new Uint8Array(32768).fill(0x42),
      note: 'imported',
      nextId: (kind) => nextRecordId(kind, 'game-3'),
      now: () => 3000,
    });

    const latest = await batterySavesRepo.latest('game-3');
    expect(latest?.id).toBe(record.id);
    await closeDatabase();
  });

  it('copies the bytes instead of keeping a view into the caller’s buffer', async () => {
    const bytes = new Uint8Array(512).fill(0x0a);
    const record = await writeImportedSave({
      gameId: 'game-4',
      bytes,
      note: 'imported',
      nextId: (kind) => nextRecordId(kind, 'game-4'),
      now: () => 4000,
    });

    bytes.fill(0x00);
    expect(new Uint8Array(record.bytes)[0]).toBe(0x0a);
    await closeDatabase();
  });
});

function save(kind: BatterySaveRecord['kind'], bytes: Uint8Array, savedAt: number): BatterySaveRecord {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    id: nextRecordId(kind, 'game-1'),
    gameId: 'game-1',
    kind,
    bytes: copy.buffer,
    size: bytes.byteLength,
    savedAt,
    hash: `hash-${savedAt}`,
    note: undefined,
  };
}
