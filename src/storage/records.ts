/**
 * Persisted record shapes and per-store repositories.
 *
 * Everything is scoped by `gameId`, which is derived from the ROM content hash,
 * so a game's saves, states and cheats follow the ROM bytes rather than a
 * filename. That is what makes cross-game leakage impossible by construction.
 */
import {
  STORE,
  StorageError,
  request,
  transact,
  type StoreName,
} from './db';
import type { GbaHeader } from '@/rom/header';

export interface GameRecord {
  /** Stable id derived from the ROM content hash. */
  id: string;
  /** SHA-256 of the ROM bytes. */
  contentHash: string;
  /** Title from the ROM header, or the filename when the header has none. */
  title: string;
  /** User override; shown instead of `title` when present. */
  customTitle?: string;
  /** Original filename, kept as metadata only. */
  fileName: string;
  size: number;
  /** Header fields worth showing in the library and duplicates UI. */
  gameCode: string | null;
  makerCode: string | null;
  softwareVersion: number | null;
  /** True when the ROM carries a Nintendo logo region (i.e. likely a retail dump). */
  hasNintendoLogo: boolean;
  /** Validation warnings captured at import time, so the UI can still show them. */
  warnings: string[];
  addedAt: number;
  lastPlayedAt: number | null;
  /** Accumulated playtime in milliseconds; only incremented from real sessions. */
  playtimeMs: number;
  favourite: boolean;
  tags: string[];
  notes: string;
}

export interface RomRecord {
  gameId: string;
  /** Raw ROM bytes. Stored separately from metadata so metadata writes stay cheap. */
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
  note?: string;
}

export interface SaveStateRecord {
  id: string;
  gameId: string;
  /** Named slot: 0 is the quick slot, the rest are user slots. */
  slot: number;
  name: string;
  note?: string;
  createdAt: number;
  bytes: ArrayBuffer;
  size: number;
  /** PNG thumbnail of the frame at capture time, when available. */
  thumbnail: Blob | null;
  /** Core identity the state was captured with, for compatibility checks. */
  coreName: string;
  coreVersion: string;
  /** ROM content hash at capture time; a mismatch means "do not load". */
  romHash: string;
}

/**
 * Cheat formats the emulator core actually implements for GBA. Action Replay
 * (PAR v3) codes are covered by `gameShark`: mGBA auto-detects the encrypted
 * GameShark and PAR variants from the same `XXXXXXXX YYYYYYYY` line shape.
 */
export type CheatFormat = 'gameShark' | 'codeBreaker' | 'vba';

export interface CheatRecord {
  id: string;
  gameId: string;
  format: CheatFormat;
  label: string;
  code: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
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

export type GamePatch = Partial<Omit<GameRecord, 'id' | 'contentHash'>>;

// --- games -----------------------------------------------------------------

export const gamesRepo = {
  async all(): Promise<GameRecord[]> {
    return transact(STORE.games, 'readonly', (tx) => request(tx.objectStore(STORE.games).getAll()));
  },

  async get(id: string): Promise<GameRecord | null> {
    const record = await transact(STORE.games, 'readonly', (tx) =>
      request<GameRecord | undefined>(tx.objectStore(STORE.games).get(id)),
    );
    return record ?? null;
  },

  async findByContentHash(contentHash: string): Promise<GameRecord | null> {
    const record = await transact(STORE.games, 'readonly', (tx) =>
      request<GameRecord | undefined>(
        tx.objectStore(STORE.games).index('byContentHash').get(contentHash),
      ),
    );
    return record ?? null;
  },

  async put(game: GameRecord): Promise<void> {
    await transact(STORE.games, 'readwrite', (tx) => request(tx.objectStore(STORE.games).put(game)));
  },

  async patch(id: string, patch: GamePatch): Promise<GameRecord> {
    return transact(STORE.games, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.games);
      const existing = await request<GameRecord | undefined>(store.get(id));
      if (!existing) throw new StorageError('not-found', `No game with id ${id}.`);
      const updated: GameRecord = { ...existing, ...patch, id: existing.id };
      await request(store.put(updated));
      return updated;
    });
  },

  /** Removes the game record plus everything scoped to it, in one transaction. */
  async removeCascade(id: string): Promise<{ romRemoved: boolean; saves: number; states: number; cheats: number }> {
    const scoped: StoreName[] = [STORE.games, STORE.roms, STORE.batterySaves, STORE.saveStates, STORE.cheats, STORE.screenshots];
    return transact(scoped, 'readwrite', async (tx) => {
      const romStore = tx.objectStore(STORE.roms);
      const romRemoved = (await request<RomRecord | undefined>(romStore.get(id))) !== undefined;
      await request(romStore.delete(id));
      await request(tx.objectStore(STORE.games).delete(id));

      const counts = { saves: 0, states: 0, cheats: 0 };
      for (const [storeName, key] of [
        [STORE.batterySaves, 'saves'],
        [STORE.saveStates, 'states'],
        [STORE.cheats, 'cheats'],
        [STORE.screenshots, 'screenshots'],
      ] as const) {
        const store = tx.objectStore(storeName);
        const keys = await request(store.index('byGame').getAllKeys(id));
        await Promise.all(keys.map((k) => request(store.delete(k))));
        if (key !== 'screenshots') counts[key] = keys.length;
      }
      return { romRemoved, ...counts };
    });
  },
};

// --- rom bytes -------------------------------------------------------------

export const romsRepo = {
  async get(gameId: string): Promise<RomRecord | null> {
    const record = await transact(STORE.roms, 'readonly', (tx) =>
      request<RomRecord | undefined>(tx.objectStore(STORE.roms).get(gameId)),
    );
    return record ?? null;
  },

  async put(gameId: string, bytes: ArrayBuffer, contentType = 'application/octet-stream'): Promise<void> {
    const record: RomRecord = { gameId, bytes, contentType, storedAt: Date.now() };
    await transact(STORE.roms, 'readwrite', (tx) => request(tx.objectStore(STORE.roms).put(record)));
  },

  async remove(gameId: string): Promise<void> {
    await transact(STORE.roms, 'readwrite', (tx) => request(tx.objectStore(STORE.roms).delete(gameId)));
  },
};

// --- battery saves ---------------------------------------------------------

export const batterySavesRepo = {
  /** Newest first. */
  async listForGame(gameId: string): Promise<BatterySaveRecord[]> {
    return transact(STORE.batterySaves, 'readonly', async (tx) => {
      const rows = await request<BatterySaveRecord[]>(
        tx.objectStore(STORE.batterySaves).index('byGame').getAll(gameId),
      );
      return rows.sort((a, b) => b.savedAt - a.savedAt);
    });
  },

  async latest(gameId: string): Promise<BatterySaveRecord | null> {
    const rows = await this.listForGame(gameId);
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

  /**
   * Trims automatic backups, keeping the newest `keep` of a given kind.
   * Manual saves and imports are never deleted automatically.
   */
  async pruneAuto(gameId: string, keep = 3): Promise<number> {
    const rows = (await this.listForGame(gameId)).filter((row) => row.kind === 'auto');
    const excess = rows.slice(keep);
    for (const row of excess) await this.remove(row.id);
    return excess.length;
  },
};

// --- save states -----------------------------------------------------------

export const saveStatesRepo = {
  async listForGame(gameId: string): Promise<SaveStateRecord[]> {
    return transact(STORE.saveStates, 'readonly', async (tx) => {
      const rows = await request<SaveStateRecord[]>(
        tx.objectStore(STORE.saveStates).index('byGame').getAll(gameId),
      );
      return rows.sort((a, b) => b.createdAt - a.createdAt);
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

  /** Quick-save style slots keep a single state per (game, slot). */
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
    return transact(STORE.saveStates, 'readonly', (tx) => request(tx.objectStore(STORE.saveStates).count()));
  },
};

// --- cheats ----------------------------------------------------------------

export const cheatsRepo = {
  async listForGame(gameId: string): Promise<CheatRecord[]> {
    return transact(STORE.cheats, 'readonly', async (tx) => {
      const rows = await request<CheatRecord[]>(tx.objectStore(STORE.cheats).index('byGame').getAll(gameId));
      return rows.sort((a, b) => a.createdAt - b.createdAt);
    });
  },

  async put(record: CheatRecord): Promise<void> {
    await transact(STORE.cheats, 'readwrite', (tx) => request(tx.objectStore(STORE.cheats).put(record)));
  },

  async remove(id: string): Promise<void> {
    await transact(STORE.cheats, 'readwrite', (tx) => request(tx.objectStore(STORE.cheats).delete(id)));
  },

  async setEnabled(gameId: string, id: string, enabled: boolean): Promise<void> {
    await transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const existing = await request<CheatRecord | undefined>(store.get(id));
      if (!existing || existing.gameId !== gameId) {
        throw new StorageError('not-found', 'That cheat is not part of the selected game.');
      }
      await request(store.put({ ...existing, enabled, updatedAt: Date.now() }));
    });
  },

  async setAllEnabled(gameId: string, enabled: boolean): Promise<number> {
    return transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const rows = await request<CheatRecord[]>(store.index('byGame').getAll(gameId));
      await Promise.all(
        rows.map((row) => request(store.put({ ...row, enabled, updatedAt: Date.now() }))),
      );
      return rows.length;
    });
  },

  async clearForGame(gameId: string): Promise<number> {
    return transact(STORE.cheats, 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.cheats);
      const keys = await request<IDBValidKey[]>(store.index('byGame').getAllKeys(gameId));
      await Promise.all(keys.map((key) => request(store.delete(key))));
      return keys.length;
    });
  },
};

// --- screenshots -----------------------------------------------------------

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
};

// --- settings --------------------------------------------------------------

export const settingsRepo = {
  async get<T>(key: string, fallback: T): Promise<T> {
    const record = await transact(STORE.settings, 'readonly', (tx) =>
      request<SettingRecord<T> | undefined>(tx.objectStore(STORE.settings).get(key)),
    );
    return record ? record.value : fallback;
  },

  async set<T>(key: string, value: T): Promise<void> {
    await transact(STORE.settings, 'readwrite', (tx) =>
      request(tx.objectStore(STORE.settings).put({ key, value, updatedAt: Date.now() })),
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

export function headerFieldsFor(header: GbaHeader | null): Pick<
  GameRecord,
  'gameCode' | 'makerCode' | 'softwareVersion' | 'hasNintendoLogo'
> {
  return {
    gameCode: header?.gameCode ?? null,
    makerCode: header?.makerCode ?? null,
    softwareVersion: header?.softwareVersion ?? null,
    hasNintendoLogo: header?.hasNintendoLogo ?? false,
  };
}
