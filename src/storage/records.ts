/**
 * Record shapes and repositories.
 *
 * Repositories exist so callers never build IndexedDB requests by hand: every
 * query the app needs has a name here, which keeps the schema knowledge in one
 * place and makes it obvious what each store is for.
 */
import type { GameLink } from '@/library/links';
import { STORE, StorageError, count, request, transact, type StoreName } from './db';

export interface GameRecord {
  /** Content-hash-derived id. Stable across re-imports of identical ROMs. */
  id: string;
  contentHash: string;
  /** Title taken from the ROM header. */
  title: string;
  /** What the user renamed it to, if anything. */
  customTitle?: string;
  fileName: string;
  size: number;
  gameCode: string | null;
  makerCode: string | null;
  softwareVersion: number | null;
  hasNintendoLogo: boolean;
  /** Non-fatal problems found at import time, kept so the UI can show them. */
  warnings: string[];
  addedAt: number;
  lastPlayedAt: number | null;
  playtimeMs: number;
  favourite: boolean;
  tags: string[];
  notes: string;
  /**
   * Links the user attached to this game, stored locally and never fetched.
   *
   * Optional so records written before this field existed (and older backup
   * bundles) load unchanged; `normalizeLinks()` fills in an empty list on read.
   */
  links?: GameLink[];
}

export interface RomRecord {
  gameId: string;
  bytes: ArrayBuffer;
  contentType: string;
  storedAt: number;
}

export type BatterySaveKind = 'auto' | 'manual' | 'import' | 'pre-overwrite';

export interface BatterySaveRecord {
  id: string;
  gameId: string;
  kind: BatterySaveKind;
  bytes: ArrayBuffer;
  size: number;
  savedAt: number;
  /** SHA-256 of the save bytes, used to skip redundant writes. */
  hash: string;
  /** Free-text note, e.g. "before the Elite Four". */
  note?: string;
}

export interface SaveStateRecord {
  id: string;
  gameId: string;
  /** Slot number: 0 is the quick slot, 1..9 are named slots. */
  slot: number;
  name: string;
  createdAt: number;
  bytes: ArrayBuffer;
  size: number;
  /** PNG thumbnail of the frame at capture time, when available. */
  thumbnail: Blob | null;
  /** Free-text note set by the user. */
  note?: string;
  /** Which emulator produced this state, so incompatible states are refused. */
  coreName: string;
  coreVersion: string;
  /** ROM content hash at capture time — the state is only valid for that ROM. */
  romHash: string;
}

export type CheatFormat = 'gameShark' | 'codeBreaker' | 'vba';

export interface CheatRecord {
  id: string;
  gameId: string;
  format: CheatFormat;
  label: string;
  /** Raw code text, one code per line. Never executed as JavaScript. */
  code: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /**
   * Set when the emulator refused this code, cleared once it accepts it.
   *
   * A code the core cannot parse is kept and marked (never silently deleted), so
   * the UI can say which one did not load instead of leaving the user guessing.
   */
  lastRejectedAt?: number;
  lastRejectedReason?: string;
}

export interface ScreenshotRecord {
  id: string;
  gameId: string;
  createdAt: number;
  width: number;
  height: number;
  blob: Blob;
}

export interface SettingRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

function stripUndefined<T extends object>(value: T): T {
  // IndexedDB structured-clones objects; `undefined` properties are dropped by
  // the clone anyway, but doing it explicitly keeps tests deterministic.
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

// --- games -----------------------------------------------------------------

export const gamesRepo = {
  async all(): Promise<GameRecord[]> {
    return transact(STORE.games, 'readonly', async (tx) => {
      const rows = await request<GameRecord[]>(tx.objectStore(STORE.games).getAll());
      return rows.map((row) => ({ ...row, tags: row.tags ?? [], warnings: row.warnings ?? [] }));
    });
  },

  async get(id: string): Promise<GameRecord | null> {
    return transact(STORE.games, 'readonly', async (tx) => {
      const row = await request<GameRecord | undefined>(tx.objectStore(STORE.games).get(id));
      return row ? { ...row, tags: row.tags ?? [], warnings: row.warnings ?? [] } : null;
    });
  },

  async findByContentHash(contentHash: string): Promise<GameRecord | null> {
    return transact(STORE.games, 'readonly', async (tx) => {
      const row = await request<GameRecord | undefined>(
        tx.objectStore(STORE.games).index('byContentHash').get(contentHash),
      );
      return row ?? null;
    });
  },

  async put(game: GameRecord): Promise<void> {
    await transact(STORE.games, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.games).put(stripUndefined(game))),
    );
  },

  async patch(id: string, patch: Partial<Omit<GameRecord, 'id'>>): Promise<GameRecord> {
    return transact(STORE.games, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.games);
      const existing = await request<GameRecord | undefined>(store.get(id));
      if (!existing) throw new StorageError('not-found', `No game with id ${id}`);
      const updated: GameRecord = { ...existing, ...stripUndefined(patch), id };
      await request(store.put(updated));
      return updated;
    });
  },

  /**
   * Removes a game and everything belonging to it in one transaction.
   *
   * A single transaction matters: a partial delete would leave save data
   * attached to nothing, which is worse than either outcome.
   */
  async removeCascade(
    id: string,
  ): Promise<{ romRemoved: boolean; saves: number; states: number; cheats: number }> {
    const stores: StoreName[] = [
      STORE.games,
      STORE.roms,
      STORE.batterySaves,
      STORE.saveStates,
      STORE.cheats,
      STORE.screenshots,
      STORE.covers,
    ];
    return transact(stores, 'readwrite', async (tx) => {
      const romRemoved = (await request<IDBValidKey | undefined>(tx.objectStore(STORE.roms).getKey(id))) !== undefined;
      await request(tx.objectStore(STORE.games).delete(id));
      await request(tx.objectStore(STORE.roms).delete(id));

      const counts: { saves: number; states: number; cheats: number } = { saves: 0, states: 0, cheats: 0 };
      for (const [storeName, key] of [
        [STORE.batterySaves, 'saves'],
        [STORE.saveStates, 'states'],
        [STORE.cheats, 'cheats'],
      ] as const) {
        const store = tx.objectStore(storeName);
        const keys = await request<IDBValidKey[]>(store.index('byGame').getAllKeys(id));
        await Promise.all(keys.map((recordKey) => request(store.delete(recordKey))));
        counts[key] = keys.length;
      }

      // Screenshots and covers go with the game, but they are not part of the
      // summary the UI shows (they are not progress).
      const shots = tx.objectStore(STORE.screenshots);
      const shotKeys = await request<IDBValidKey[]>(shots.index('byGame').getAllKeys(id));
      await Promise.all(shotKeys.map((recordKey) => request(shots.delete(recordKey))));
      await request(tx.objectStore(STORE.covers).delete(id));

      return { romRemoved, ...counts };
    });
  },
};

// --- ROM bytes --------------------------------------------------------------

export const romsRepo = {
  async get(gameId: string): Promise<RomRecord | null> {
    return transact(STORE.roms, 'readonly', async (tx) => {
      const row = await request<RomRecord | undefined>(tx.objectStore(STORE.roms).get(gameId));
      return row ?? null;
    });
  },

  async has(gameId: string): Promise<boolean> {
    return transact(STORE.roms, 'readonly', async (tx) => {
      const key = await request<IDBValidKey | undefined>(tx.objectStore(STORE.roms).getKey(gameId));
      return key !== undefined;
    });
  },

  async put(gameId: string, bytes: ArrayBuffer, contentType = 'application/octet-stream'): Promise<void> {
    const record: RomRecord = { gameId, bytes, contentType, storedAt: Date.now() };
    await transact(STORE.roms, 'readwrite', (tx) => request(tx.objectStore(STORE.roms).put(record)));
  },

  async remove(gameId: string): Promise<void> {
    await transact(STORE.roms, 'readwrite', (tx) => request(tx.objectStore(STORE.roms).delete(gameId)));
  },
};

// --- battery saves ----------------------------------------------------------

export const batterySavesRepo = {
  /** All generations for a game, newest first. */
  async listForGame(gameId: string): Promise<BatterySaveRecord[]> {
    return transact(STORE.batterySaves, 'readonly', async (tx) => {
      const rows = await request<BatterySaveRecord[]>(
        tx.objectStore(STORE.batterySaves).index('byGame').getAll(gameId),
      );
      return rows.sort((a, b) => b.savedAt - a.savedAt);
    });
  },

  /** Most recent battery save for a game, or null. */
  async latest(gameId: string): Promise<BatterySaveRecord | null> {
    const rows = await batterySavesRepo.listForGame(gameId);
    return rows[0] ?? null;
  },

  async put(record: BatterySaveRecord): Promise<void> {
    await transact(STORE.batterySaves, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.batterySaves).put(record)),
    );
  },

  async remove(id: string): Promise<void> {
    await transact(STORE.batterySaves, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.batterySaves).delete(id)),
    );
  },

  /** Number of stored generations for a game. */
  countForGame(gameId: string): Promise<number> {
    return transact(STORE.batterySaves, 'readonly', async (tx) => {
      const keys = await request<IDBValidKey[]>(
        tx.objectStore(STORE.batterySaves).index('byGame').getAllKeys(gameId),
      );
      return keys.length;
    });
  },

  /**
   * Trims automatic saves, keeping the newest `keep`.
   *
   * Manual saves, imports and pre-overwrite backups are never pruned: they only
   * exist because a person asked for them.
   */
  async pruneAuto(gameId: string, keep: number): Promise<number> {
    if (keep < 0) return 0;
    return transact(STORE.batterySaves, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.batterySaves);
      const rows = await request<BatterySaveRecord[]>(store.index('byGame').getAll(gameId));
      const autos = rows.filter((row) => row.kind === 'auto').sort((a, b) => b.savedAt - a.savedAt);
      const excess = autos.slice(keep);
      await Promise.all(excess.map((row) => request(store.delete(row.id))));
      return excess.length;
    });
  },
};

// --- save states ------------------------------------------------------------

export const saveStatesRepo = {
  async listForGame(gameId: string): Promise<SaveStateRecord[]> {
    return transact(STORE.saveStates, 'readonly', async (tx) => {
      const rows = await request<SaveStateRecord[]>(
        tx.objectStore(STORE.saveStates).index('byGame').getAll(gameId),
      );
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    });
  },

  async get(id: string): Promise<SaveStateRecord | null> {
    return transact(STORE.saveStates, 'readonly', async (tx) => {
      const row = await request<SaveStateRecord | undefined>(tx.objectStore(STORE.saveStates).get(id));
      return row ?? null;
    });
  },

  async put(record: SaveStateRecord): Promise<void> {
    await transact(STORE.saveStates, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.saveStates).put(record)),
    );
  },

  async remove(id: string): Promise<void> {
    await transact(STORE.saveStates, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.saveStates).delete(id)),
    );
  },

  /** Occupies a numbered slot: any previous state in that slot is replaced. */
  async replaceSlot(record: SaveStateRecord): Promise<void> {
    await transact(STORE.saveStates, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.saveStates);
      const existing = await request<IDBValidKey[]>(
        store.index('byGameSlot').getAllKeys([record.gameId, record.slot]),
      );
      await Promise.all(existing.map((key) => request(store.delete(key))));
      await request(store.put(record));
    });
  },

  async countAll(): Promise<number> {
    return count(STORE.saveStates);
  },
};

// --- cheats -----------------------------------------------------------------

export const cheatsRepo = {
  /** Cheats for one game only, oldest first. */
  async listForGame(gameId: string): Promise<CheatRecord[]> {
    return transact(STORE.cheats, 'readonly', async (tx) => {
      const rows = await request<CheatRecord[]>(tx.objectStore(STORE.cheats).index('byGame').getAll(gameId));
      return rows.sort((a, b) => a.createdAt - b.createdAt);
    });
  },

  async listEnabled(gameId: string): Promise<CheatRecord[]> {
    return (await cheatsRepo.listForGame(gameId)).filter((cheat) => cheat.enabled);
  },

  async put(record: CheatRecord): Promise<void> {
    await transact(STORE.cheats, 'readwrite', (tx) => request(tx.objectStore(STORE.cheats).put(record)));
  },

  async remove(id: string): Promise<void> {
    await transact(STORE.cheats, 'readwrite', (tx) => request(tx.objectStore(STORE.cheats).delete(id)));
  },

  /**
   * Toggles one cheat.
   *
   * The gameId is checked rather than trusted: this is the method that decides
   * whether a cheat applies to the session that is about to start, so it must
   * refuse to touch another game's record.
   */
  async setEnabled(gameId: string, id: string, enabled: boolean): Promise<void> {
    await transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const existing = await request<CheatRecord | undefined>(store.get(id));
      if (!existing || existing.gameId !== gameId) {
        throw new StorageError('not-found', `Cheat ${id} does not belong to game ${gameId}`);
      }
      await request(store.put({ ...existing, enabled, updatedAt: Date.now() }));
    });
  },

  async setAllEnabled(gameId: string, enabled: boolean): Promise<number> {
    return transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const rows = await request<CheatRecord[]>(store.index('byGame').getAll(gameId));
      await Promise.all(rows.map((row) => request(store.put({ ...row, enabled }))));
      return rows.length;
    });
  },

  /** Used when a game is removed, or to clear a bad set. */
  async clearForGame(gameId: string): Promise<number> {
    return transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const keys = await request<IDBValidKey[]>(store.index('byGame').getAllKeys(gameId));
      await Promise.all(keys.map((key) => request(store.delete(key))));
      return keys.length;
    });
  },
};

// --- screenshots ------------------------------------------------------------

export const screenshotsRepo = {
  async listForGame(gameId: string): Promise<ScreenshotRecord[]> {
    return transact(STORE.screenshots, 'readonly', async (tx) => {
      const rows = await request<ScreenshotRecord[]>(
        tx.objectStore(STORE.screenshots).index('byGame').getAll(gameId),
      );
      return rows.sort((a, b) => b.createdAt - a.createdAt);
    });
  },

  async put(record: ScreenshotRecord): Promise<void> {
    await transact(STORE.screenshots, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.screenshots).put(record)),
    );
  },

  async remove(id: string): Promise<void> {
    await transact(STORE.screenshots, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.screenshots).delete(id)),
    );
  },

  async countAll(): Promise<number> {
    return count(STORE.screenshots);
  },
};

// --- settings ---------------------------------------------------------------

export const settingsRepo = {
  async get<T>(key: string, fallback: T): Promise<T> {
    return transact(STORE.settings, 'readonly', async (tx) => {
      const row = await request<SettingRecord<T> | undefined>(tx.objectStore(STORE.settings).get(key));
      return row ? row.value : fallback;
    });
  },

  async set<T>(key: string, value: T): Promise<void> {
    const record: SettingRecord<T> = { key, value, updatedAt: Date.now() };
    await transact(STORE.settings, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.settings).put(record)),
    );
  },

  async all(): Promise<SettingRecord[]> {
    return transact(STORE.settings, 'readonly', (tx) =>
      request<SettingRecord[]>(tx.objectStore(STORE.settings).getAll()),
    );
  },

  async clear(): Promise<void> {
    await transact(STORE.settings, 'readwrite', (tx) => request(tx.objectStore(STORE.settings).clear()));
  },
};
