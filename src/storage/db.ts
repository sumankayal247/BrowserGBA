/**
 * IndexedDB access layer.
 *
 * Design rules that the rest of the app depends on:
 *
 * - Large binaries (ROM images, save files, save states, screenshots) live in
 *   their own object stores, separate from frequently-updated metadata, so a
 *   rename or a "last played" touch never rewrites megabytes.
 * - Every store is versioned through `migrations`, and every migration is a
 *   pure step from one version to the next.
 * - Failures are surfaced as typed errors with user-actionable messages; nothing
 *   here silently swallows a failed write, because the product promise is that
 *   progress is never lost silently.
 */
import { DB_SCHEMA_VERSION } from '@/version';

export const DB_NAME = 'browsergba';

export const STORE = {
  meta: 'meta',
  games: 'games',
  roms: 'roms',
  batterySaves: 'batterySaves',
  saveStates: 'saveStates',
  cheats: 'cheats',
  screenshots: 'screenshots',
  settings: 'settings',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

export type StorageErrorCode =
  | 'not-supported'
  | 'unavailable'
  | 'blocked'
  | 'quota-exceeded'
  | 'transaction-failed'
  | 'not-found'
  | 'corrupt';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }

  /** A message safe and useful to show in the UI. */
  get userMessage(): string {
    switch (this.code) {
      case 'not-supported':
        return 'This browser does not provide IndexedDB, so BrowserGBA cannot store your library. Try a current version of Chrome, Edge, Firefox, or Safari.';
      case 'unavailable':
        return 'Browser storage is unavailable right now. Private/incognito windows and some privacy settings block it.';
      case 'blocked':
        return 'Another BrowserGBA tab is using an older version of the library. Close the other tabs and reload this page.';
      case 'quota-exceeded':
        return 'The browser refused the write because the storage quota is full. Remove a game or export a backup, then try again.';
      case 'corrupt':
        return 'The stored data could not be read and may be damaged. Restoring from a backup is recommended.';
      case 'not-found':
        return 'That item is no longer in the library.';
      default:
        return 'The browser storage operation failed. Your existing data has not been changed.';
    }
  }
}

export function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function toStorageError(error: unknown, fallbackCode: StorageErrorCode = 'transaction-failed'): StorageError {
  if (error instanceof StorageError) return error;
  if (isQuotaError(error)) {
    return new StorageError('quota-exceeded', 'Storage quota exceeded while writing.', error);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new StorageError(fallbackCode, `Storage operation failed: ${message}`, error);
}

/** A single schema step. Each step moves the database from `from` to `from + 1`. */
export interface Migration {
  from: number;
  describe: string;
  apply(db: IDBDatabase, tx: IDBTransaction): void;
}

export const migrations: Migration[] = [
  {
    from: 0,
    describe: 'create game library, saves, states, cheats and settings stores',
    apply(db) {
      const games = db.createObjectStore(STORE.games, { keyPath: 'id' });
      games.createIndex('byContentHash', 'contentHash', { unique: true });
      games.createIndex('byLastPlayed', 'lastPlayedAt');
      games.createIndex('byAdded', 'addedAt');

      db.createObjectStore(STORE.roms, { keyPath: 'gameId' });

      const saves = db.createObjectStore(STORE.batterySaves, { keyPath: 'id' });
      saves.createIndex('byGame', 'gameId');
      saves.createIndex('byGameSavedAt', ['gameId', 'savedAt']);

      const states = db.createObjectStore(STORE.saveStates, { keyPath: 'id' });
      states.createIndex('byGame', 'gameId');
      states.createIndex('byGameSlot', ['gameId', 'slot']);

      const cheats = db.createObjectStore(STORE.cheats, { keyPath: 'id' });
      cheats.createIndex('byGame', 'gameId');

      const shots = db.createObjectStore(STORE.screenshots, { keyPath: 'id' });
      shots.createIndex('byGame', 'gameId');
      shots.createIndex('byCreatedAt', 'createdAt');

      db.createObjectStore(STORE.settings, { keyPath: 'key' });
      db.createObjectStore(STORE.meta, { keyPath: 'key' });
    },
  },
];

export function isIndexedDbAvailable(): boolean {
  try {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  } catch {
    // Some hardened privacy modes throw on property access.
    return false;
  }
}

export interface OpenOptions {
  /** Called when another tab requests a schema upgrade and this connection must close. */
  onVersionChange?: () => void;
}

let connection: Promise<IDBDatabase> | null = null;

/**
 * Opens (and upgrades) the database. The connection is cached; call
 * `closeDatabase()` when a version change is detected.
 */
export function openDatabase(options: OpenOptions = {}): Promise<IDBDatabase> {
  if (!isIndexedDbAvailable()) {
    return Promise.reject(
      new StorageError('not-supported', 'IndexedDB is not available in this browser or context.'),
    );
  }
  if (connection) return connection;

  connection = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = globalThis.indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    } catch (error) {
      reject(toStorageError(error, 'unavailable'));
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) {
        reject(new StorageError('corrupt', 'Upgrade transaction missing.'));
        return;
      }
      let version = event.oldVersion;
      for (const migration of migrations) {
        if (migration.from === version) {
          migration.apply(db, tx);
          version = migration.from + 1;
        }
      }
      // Written inside the upgrade transaction so the stamp is atomic with the schema.
      tx.objectStore(STORE.meta).put({ key: 'schemaVersion', value: DB_SCHEMA_VERSION });
    };

    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        // A newer tab wants to upgrade: release our connection so it is not blocked.
        db.close();
        connection = null;
        options.onVersionChange?.();
      };
      resolve(db);
    };
    request.onerror = () => reject(toStorageError(request.error, 'unavailable'));
    request.onblocked = () =>
      reject(
        new StorageError(
          'blocked',
          'The database upgrade is blocked by another open BrowserGBA tab.',
        ),
      );
  }).catch((error: unknown) => {
    connection = null;
    throw toStorageError(error);
  });

  return connection;
}

export function closeDatabase(): void {
  const pending = connection;
  connection = null;
  void pending?.then((db) => db.close()).catch(() => undefined);
}

/**
 * Drops all BrowserGBA data and forgets the cached connection.
 *
 * Used by the "delete everything" action and by tests. Callers that only want to
 * remove one game should use `gamesRepo.removeCascade` instead.
 */
export async function deleteDatabase(): Promise<void> {
  const pending = connection;
  connection = null;
  if (pending) {
    try {
      (await pending).close();
    } catch {
      /* connection never opened */
    }
  }
  if (!isIndexedDbAvailable()) return;
  await new Promise<void>((resolve, reject) => {
    const request_ = globalThis.indexedDB.deleteDatabase(DB_NAME);
    request_.onsuccess = () => resolve();
    request_.onerror = () => reject(toStorageError(request_.error));
    request_.onblocked = () =>
      reject(new StorageError('blocked', 'Another tab is holding the database open.'));
  });
}

/** Test helper: wipes the database and reopens it empty. */
export async function resetDatabaseForTests(): Promise<void> {
  await deleteDatabase();
}

/** Promisifies an IDBRequest. */
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(toStorageError(req.error));
  });
}

/**
 * Runs `work` inside a transaction over `stores` and resolves after the
 * transaction completes, so callers can never observe a write that has not been
 * durably queued.
 */
export async function transact<T>(
  stores: StoreName | StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDatabase();
  const names = Array.isArray(stores) ? stores : [stores];

  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(names, mode);
    } catch (error) {
      reject(toStorageError(error));
      return;
    }

    let result: T;
    let settled = false;

    tx.oncomplete = () => {
      if (!settled) resolve(result);
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(toStorageError(tx.error));
      }
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(toStorageError(tx.error));
      }
    };

    Promise.resolve(work(tx))
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        settled = true;
        try {
          tx.abort();
        } catch {
          /* already aborting */
        }
        reject(toStorageError(error));
      });
  });
}

/** Convenience: count records, tolerating an empty store. */
export async function count(store: StoreName): Promise<number> {
  return transact(store, 'readonly', (tx) => request(tx.objectStore(store).count()));
}
