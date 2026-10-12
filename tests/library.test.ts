import { describe, it, expect, beforeEach } from 'vitest';
import {
  ImportError,
  allTags,
  commitImport,
  getGame,
  getRomBytes,
  listGames,
  matchesQuery,
  prepareImport,
  recordPlaySession,
  removeGame,
  setFavourite,
  sortGames,
  titleOf,
  updateGame,
} from '@/library/library';
import { batterySavesRepo, cheatsRepo, gamesRepo, saveStatesRepo, type GameRecord } from '@/storage/records';
import { closeDatabase, resetDatabaseForTests, STORE, transact, request } from '@/storage/db';
import { makeRom, withPayload } from './helpers/rom-fixtures';
import { deriveGameId, sha256Hex } from '@/rom/hash';

async function importRom(
  name: string,
  bytes: Uint8Array,
  options?: Parameters<typeof commitImport>[1],
): Promise<GameRecord> {
  const candidate = await prepareImport({ name, size: bytes.byteLength }, bytes);
  const { game } = await commitImport(candidate, options);
  return game;
}

function romBuffer(seed: number, size = 0x8000): Uint8Array {
  const rom = withPayload(makeRom({ title: `GAME${seed}` }), 0xc0);
  for (let i = 0xc0; i < rom.length; i++) rom[i] = (i * (seed + 1) + seed) & 0xff;
  return rom.subarray(0, size);
}

describe('library import and identity', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('imports a ROM and records header metadata', async () => {
    const bytes = withPayload(makeRom({ title: 'METROID F', gameCode: 'AMTE', makerCode: '01' }));
    const game = await importRom('metroid.gba', bytes);

    expect(game.title).toBe('METROID F');
    expect(game.gameCode).toBe('AMTE');
    expect(game.makerCode).toBe('01');
    expect(game.fileName).toBe('metroid.gba');
    expect(game.size).toBe(bytes.byteLength);
    expect(game.playtimeMs).toBe(0);
    expect(game.lastPlayedAt).toBeNull();
    expect(await getRomBytes(game.id)).not.toBeNull();
  });

  it('derives the game id from content, not the filename', async () => {
    const bytes = withPayload(makeRom({ title: 'SAME BYTES' }));
    const first = await importRom('a.gba', bytes);
    // Re-importing identical bytes is a duplicate; the caller decides.
    const same = await importRom('totally-different-name.gba', bytes, { onDuplicate: 'replace' });
    expect(same.id).toBe(first.id);
    expect((await listGames()).length).toBe(1);
  });

  it('keeps two different ROMs distinct even with identical filenames', async () => {
    const a = await importRom('pokemon.gba', romBuffer(1));
    const b = await importRom('pokemon.gba', romBuffer(2));
    expect(a.id).not.toBe(b.id);
    const games = await listGames();
    expect(games).toHaveLength(2);
    expect(new Set(games.map((g) => g.id)).size).toBe(2);
  });

  it('detects duplicates by content hash before writing anything', async () => {
    const bytes = withPayload(makeRom({ title: 'DUPES' }));
    const first = await importRom('first.gba', bytes);

    const candidate = await prepareImport({ name: 'second.gba', size: bytes.byteLength }, bytes);
    expect(candidate.duplicate?.id).toBe(first.id);
    // Preparing must not have written a second copy.
    expect((await listGames()).length).toBe(1);
  });

  it('cancels a duplicate import when asked to', async () => {
    const bytes = withPayload(makeRom({ title: 'DUPES' }));
    await importRom('first.gba', bytes);
    const candidate = await prepareImport({ name: 'second.gba', size: bytes.byteLength }, bytes);
    await expect(commitImport(candidate, { onDuplicate: 'cancel' })).rejects.toBeInstanceOf(ImportError);
    expect((await listGames()).length).toBe(1);
  });

  it('preserves play history when a duplicate is replaced', async () => {
    const bytes = withPayload(makeRom({ title: 'DUPES' }));
    const game = await importRom('first.gba', bytes);
    await recordPlaySession(game.id, 60_000);

    const candidate = await prepareImport({ name: 'second.gba', size: bytes.byteLength }, bytes);
    const result = await commitImport(candidate, { onDuplicate: 'replace' });

    expect(result.replaced).toBe(true);
    expect(result.game.playtimeMs).toBeGreaterThanOrEqual(60_000);
    expect(result.game.fileName).toBe('second.gba');
    expect((await listGames()).length).toBe(1);
  });

  it('rejects non-GBA files with an actionable message', async () => {
    await expect(prepareImport({ name: 'song.mp3', size: 1000 }, new Uint8Array(1000))).rejects.toMatchObject({
      code: 'invalid-file',
    });
    try {
      await prepareImport({ name: 'junk.gba', size: 4096 }, new Uint8Array(4096).fill(0x41));
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ImportError);
      expect((error as ImportError).issues.length).toBeGreaterThan(0);
      expect((error as ImportError).message).toMatch(/does not look like a Game Boy Advance ROM/i);
    }
  });

  it('rejects an oversized file before reading it', async () => {
    await expect(
      prepareImport({ name: 'huge.gba', size: 33 * 1024 * 1024 }, new Uint8Array(16)),
    ).rejects.toMatchObject({ code: 'invalid-file' });
  });

  it('records validation warnings on the game so they are not lost', async () => {
    const bytes = withPayload(makeRom({ corruptChecksum: true }));
    const game = await importRom('patched.gba', bytes);
    expect(game.warnings.length).toBeGreaterThan(0);
    expect(game.warnings.join(' ')).toMatch(/complement check/i);
  });

  it('stores a custom title override without touching the ROM bytes', async () => {
    const bytes = withPayload(makeRom({ title: 'ORIGINAL' }));
    const game = await importRom('x.gba', bytes, { customTitle: 'My Renamed Hack' });
    expect(titleOf(game)).toBe('My Renamed Hack');
    expect(game.title).toBe('ORIGINAL');

    const updated = await updateGame(game.id, { customTitle: '' });
    expect(titleOf(updated)).toBe('ORIGINAL');
  });
});

describe('library queries', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('searches by title, filename, code and tag', async () => {
    const a = await importRom('alpha.gba', romBuffer(1), { tags: ['rpg'] });
    const b = await importRom('beta.gba', romBuffer(2));

    expect((await listGames({ search: 'game1' })).map((g) => g.id)).toEqual([a.id]);
    expect((await listGames({ search: 'beta' })).map((g) => g.id)).toEqual([b.id]);
    expect((await listGames({ search: 'rpg' })).map((g) => g.id)).toEqual([a.id]);
    expect(await listGames({ search: 'nothing-matches-this' })).toHaveLength(0);
  });

  it('treats multiple search terms as AND', async () => {
    const a = await importRom('alpha.gba', romBuffer(1), { customTitle: 'Pokemon Emerald' });
    await importRom('beta.gba', romBuffer(2), { customTitle: 'Pokemon FireRed' });
    const results = await listGames({ search: 'pokemon emerald' });
    expect(results.map((g) => g.id)).toEqual([a.id]);
  });

  it('filters favourites and tags', async () => {
    const a = await importRom('a.gba', romBuffer(3), { tags: ['homebrew', 'demo'] });
    const b = await importRom('b.gba', romBuffer(4), { tags: ['homebrew'] });
    await setFavourite(b.id, true);

    expect((await listGames({ favouritesOnly: true })).map((g) => g.id)).toEqual([b.id]);
    expect((await listGames({ tag: 'demo' })).map((g) => g.id)).toEqual([a.id]);
    expect((await allTags()).sort()).toEqual(['demo', 'homebrew']);
  });

  it('sorts never-played games by the date they were added', async () => {
    const old = await importRom('old.gba', romBuffer(5));
    await gamesRepo.patch(old.id, { addedAt: 1000 });
    const recent = await importRom('recent.gba', romBuffer(6));
    await gamesRepo.patch(recent.id, { addedAt: 2000 });

    const byRecent = await listGames({ sort: 'recent' });
    expect(byRecent.map((g) => g.id)).toEqual([recent.id, old.id]);
  });

  it('sorts played games ahead of untouched ones in recent order', async () => {
    const a = await importRom('a.gba', romBuffer(7));
    const b = await importRom('b.gba', romBuffer(8));
    await gamesRepo.patch(a.id, { addedAt: 5000 });
    await gamesRepo.patch(b.id, { addedAt: 1000 });
    await recordPlaySession(b.id, 1000);

    const byRecent = await listGames({ sort: 'recent' });
    expect(byRecent[0]!.id).toBe(b.id);
  });

  it('sorts by title and playtime', async () => {
    const zebra = await importRom('z.gba', romBuffer(9), { customTitle: 'Zebra' });
    const apple = await importRom('a.gba', romBuffer(10), { customTitle: 'Apple' });
    await recordPlaySession(zebra.id, 120_000);

    expect((await listGames({ sort: 'title' })).map((g) => g.id)).toEqual([apple.id, zebra.id]);
    expect((await listGames({ sort: 'playtime' }))[0]!.id).toBe(zebra.id);
  });
});

describe('playtime tracking', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('accumulates playtime and stamps last played', async () => {
    const game = await importRom('a.gba', romBuffer(11));
    await recordPlaySession(game.id, 30_000);
    await recordPlaySession(game.id, 45_000);
    const updated = await getGame(game.id);
    expect(updated?.playtimeMs).toBe(75_000);
    expect(updated?.lastPlayedAt).toBeGreaterThan(0);
  });

  it('clamps absurd session lengths from a suspended tab', async () => {
    const game = await importRom('a.gba', romBuffer(12));
    const updated = await recordPlaySession(game.id, 48 * 60 * 60 * 1000);
    expect(updated.playtimeMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000);
  });

  it('ignores negative durations', async () => {
    const game = await importRom('a.gba', romBuffer(13));
    const updated = await recordPlaySession(game.id, -5000);
    expect(updated.playtimeMs).toBe(0);
  });
});

describe('removal semantics', () => {
  beforeEach(async () => {
    await resetDatabaseForTests();
  });

  it('deletes associated saves, states and cheats when asked', async () => {
    const game = await importRom('a.gba', romBuffer(14));
    await batterySavesRepo.put({
      id: 's1',
      gameId: game.id,
      kind: 'auto',
      bytes: new ArrayBuffer(8),
      size: 8,
      savedAt: 1,
      hash: 'h',
    });
    await saveStatesRepo.put({
      id: 'st1',
      gameId: game.id,
      slot: 1,
      name: 'slot',
      createdAt: 1,
      bytes: new ArrayBuffer(4),
      size: 4,
      thumbnail: null,
      coreName: 'mGBA',
      coreVersion: '2.5.1',
      romHash: game.contentHash,
    });
    await cheatsRepo.put({
      id: 'c1',
      gameId: game.id,
      format: 'gameShark',
      label: 'l',
      code: 'AAAAAAAA BBBBBBBB',
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });

    const summary = await gamesRepo.removeCascade(game.id);
    expect(summary.romRemoved).toBe(true);
    expect(summary.saves).toBe(1);
    expect(summary.states).toBe(1);
    expect(summary.cheats).toBe(1);
    expect(await getGame(game.id)).toBeNull();
  });

  it('can keep progress when only the ROM is removed', async () => {
    const game = await importRom('a.gba', romBuffer(15));
    await batterySavesRepo.put({
      id: 'keep-me',
      gameId: game.id,
      kind: 'manual',
      bytes: new ArrayBuffer(8),
      size: 8,
      savedAt: 1,
      hash: 'h',
    });

    await removeGame(game.id, { deleteAssociatedData: false });

    expect(await getRomBytes(game.id)).toBeNull();
    expect(await batterySavesRepo.latest(game.id)).not.toBeNull();
    expect(await getGame(game.id)).not.toBeNull();
  });
});

describe('query helpers', () => {
  const base: GameRecord = {
    id: 'g1',
    contentHash: 'hash',
    title: 'Base Game',
    fileName: 'base.gba',
    size: 10,
    gameCode: 'BAAA',
    makerCode: '01',
    softwareVersion: 0,
    hasNintendoLogo: false,
    warnings: [],
    addedAt: 1,
    lastPlayedAt: null,
    playtimeMs: 0,
    favourite: false,
    tags: [],
    notes: '',
  };

  it('matches an empty query', () => {
    expect(matchesQuery(base, {})).toBe(true);
  });

  it('is case insensitive', () => {
    expect(matchesQuery(base, { search: 'BASE GAME' })).toBe(true);
  });

  it('matches the game code', () => {
    expect(matchesQuery(base, { search: 'baaa' })).toBe(true);
  });

  it('sorts deterministically for equal timestamps', () => {
    const a = { ...base, id: 'a', title: 'Alpha', addedAt: 5 };
    const b = { ...base, id: 'b', title: 'Beta', addedAt: 5 };
    expect(sortGames([b, a], 'recent').map((g) => g.id)).toEqual(['a', 'b']);
  });
});

// Keep the exported test helpers referenced so tree-shaking/lint stay honest.
void closeDatabase;
void transact;
void request;
void STORE;
void sha256Hex;
void deriveGameId;
