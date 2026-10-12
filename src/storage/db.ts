/**
 * IndexedDB access layer.
 *
 * Design rules that the rest of the app depends on:
 *
 * - ROM bytes live in their own object store, never in `localStorage` and never
 *   inside a metadata record, so listing the library never loads megabytes of
 *   binary data into memory.
 * - Everything is keyed by the game's content hash (`gameId`), so saves, states
 *   and cheats cannot leak between different ROMs — a re-imported ROM keeps its
 *   progress, and a modified ROM does not inherit it.
 * - Failures are typed (`StorageError`) with messages written for the user, not
 *   for a stack trace. Running out of disk space must never look like a crash.
 * - Schema changes go through `migrations`, so an existing library survives an
 *   update instead of being silently dropped.
 */
import { DB_SCHEMA_VERSION } from '@/version';

/** The IndexedDB database name. Changing it orphans every existing library. */
export const DB_NAME = 'browsergba';

export const STORE = {
  games: 'games',
  roms: 'roms',
  batterySaves: 'batterySaves',
  saveStates: 'saveStates',
  cheats: 'cheats',
  screenshots: 'screenshots',
  covers: 'covers',
  settings: 'settings',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

export type StorageErrorCode =
  | 'unavailable'
  | 'blocked'
  | 'quota-exceeded'
  | 'transaction-failed'
  | 'not-found'
  | 'schema-too-new'
  | 'unknown';

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    /** Shown in the UI when this error escape to a user-facing surface. */
    readonly userMessage: string = message,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

/** True when this browser can use IndexedDB at all. */
export function isIndexedDbAvailable(): boolean {
  try {
    if (typeof indexedDB === 'undefined' || indexedDB === null) return false;
    // Some privacy modes expose the object but throw on open; this probe keeps
    // the failure at startup rather than at the first import.
    const probe = indexedDB.open('__browsergba_probe__');
    probe.onerror = () => probe.result?.close();
    probe.onsuccess = () => {
      probe.result.close();
      indexedDB.deleteDatabase('__browsergba_probe__');
    };
    return true;
  } catch {
    return false;
  }
}

/** Maps a raw DOMException onto our typed, user-facing errors. */
function toStorageError(error: unknown, context: string): StorageError {
  if (error instanceof StorageError) return error;
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new StorageError(
      'quota-exceeded',
      `${context}: the browser refused the write because the disk quota is full.`,
      'There is no space left for this browser to store game data. Remove a game you no longer need, or export a backup and clear space, then try again.',
      error,
    );
  }
  if (name === 'VersionError') {
    return new StorageError(
      'schema-too-new',
      `${context}: the stored database is newer than this build understands.`,
      'This library was created by a newer version of BrowserGBA. Reload the page to update, or open it in a non-private window.',
      error,
    );
  }
  return new StorageError(
    'transaction-failed',
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
    'Something went wrong while reading or writing game data. Reloading the page usually fixes it; your files are unchanged.',
    error,
  );
}

/** A single upgrade step. Steps run in order from the stored version. */
export interface Migration {
  to: number;
  describe: string;
  run: (db: IDBDatabase, tx: IDBTransaction) => void;
}

/**
 * Schema history.
 *
 * Only ever append. Changing a shipped step would corrupt databases that have
 * already run it — the version number is the contract, not the code.
 */
export const migrations: Migration[] = [
  {
    to: 1,
    describe: 'create the game library, ROM store, saves, states, cheats and settings',
    run: (db) => {
      const games = db.createObjectStore(STORE.games, { keyPath: 'id' });
      games.createIndex('byContentHash', 'contentHash', { unique: true });
      games.createIndex('byLastPlayedAt', 'lastPlayedAt');

      // Binary payloads live on their own: a library listing must never have to
      // deserialize a 16 MB ROM.
      db.createObjectStore(STORE.roms, { keyPath: 'gameId' });

      const saves = db.createObjectStore(STORE.batterySaves, { keyPath: 'id' });
      saves.createIndex('byGame', 'gameId');
      saves.createIndex('byGameSlot', ['gameId', 'slot']);

      const states = db.createObjectStore(STORE.saveStates, { keyPath: 'id' });
      states.createIndex('byGame', 'gameId');
      states.createIndex('byGameSlot', ['gameId', 'slot']);

      const cheats = db.createObjectStore(STORE.cheats, { keyPath: 'id' });
      cheats.createIndex('byGame', 'gameId');

      const screenshotsStore = db.createObjectStore(STORE.screenshots, { keyPath: 'id' });
      screenshotsStore.createIndex('byGame', 'gameId');
      screenshotsStore.createIndex('byCreatedAt', 'createdAt');

      db.createObjectStore(STORE.settings, { keyPath: 'key' });
    },
  },
  {
    to: 2,
    describe: 'add the user-supplied cover art store',
    run: (db) => {
      // One cover per game; the record is keyed by gameId so a cover cannot be
      // attached to the wrong title.
      if (!db.objectStoreNames.contains(STORE.covers)) {
        db.createObjectStore(STORE.covers, { keyPath: 'gameId' });
      }
    },
  },
];

let connection: IDBDatabase | null = null;
let openPromise: Promise<IDBDatabase> | null = null;
const closeListeners = new Set<() => void>();

/** Called when another tab upgrades or deletes the database. */
export function onDatabaseClosed(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

export async function openDatabase(): Promise<IDBDatabase> {
  if (connection) return connection;
  if (openPromise) return openPromise;
  if (!isIndexedDbAvailable()) {
    throw new StorageError(
      'unavailable',
      'IndexedDB is not available in this browser context.',
      'This browser (or private browsing mode) does not allow local storage, and BrowserGBA keeps your library on your device. Try a normal window, or a different browser.',
    );
  }

  openPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_SCHEMA_VERSION);
    } catch (error) {
      openPromise = null;
      reject(toStorageError(error, 'Opening the local database'));
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!tx) return;
      const from = event.oldVersion;
      for (const migration of migrations) {
        if (migration.to > from && migration.to <= DB_SCHEMA_VERSION) {
          migration.run(db, tx);
        }
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // A new tab with a newer schema must win; give up our connection instead
      // of blocking it forever.
      db.onversionchange = () => {
        db.close();
        connection = null;
        openPromise = null;
        for (const listener of closeListeners) listener();
      };
      connection = db;
      resolve(db);
    };

    request.onerror = () => {
      openPromise = null;
      reject(toStorageError(request.error, 'Opening the local database'));
    };

    request.onblocked = () => {
      openPromise = null;
      reject(
        new StorageError(
          'blocked',
          'Another tab is holding an older version of the database open.',
          'BrowserGBA is open in another tab. Close it (or reload it) and try again — this update needs to upgrade the database.',
        ),
      );
    };
  });

  return openPromise;
}

/** Closes the shared connection. Used by tests and by teardown paths. */
export function closeDatabase(): void {
  connection?.close();
  connection = null;
  openPromise = null;
}

/** Deletes the whole database — the "delete everything" path. */
export async function deleteDatabase(): Promise<void> {
  closeDatabase();
  if (!isIndexedDbAvailable()) return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(toStorageError(request.error, 'Deleting the local database'));
    // A blocked delete means another tab still has it open; the browser will
    // finish the deletion once that tab closes, so this is not an error state.
    request.onblocked = () => resolve();
  });
}

/**
 * Resets the database between tests.
 *
 * Deliberately separate from `deleteDatabase` so production code cannot call it
 * by accident.
 */
export async function resetDatabaseForTests(): Promise<void> {
  await deleteDatabase();
}

/** Runs `work` inside a transaction and resolves with its result. */
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
      reject(toStorageError(error, `Starting a ${mode} transaction on ${names.join(', ')}`));
      return;
    }

    let result: T;
    let failed = false;

    tx.onabort = () => {
      if (failed) return;
      failed = true;
      reject(toStorageError(tx.error, 'The database transaction was aborted'));
    };
    tx.onerror = () => {
      if (failed) return;
      failed = true;
      reject(toStorageError(tx.error, 'The database transaction failed'));
    };
    tx.oncomplete = () => {
      if (failed) return;
      resolve(result);
    };

    Promise.resolve()
      .then(() => work(tx))
      .then((value) => {
        result = value;
      })
      .catch((error) => {
        failed = true;
        try {
          tx.abort();
        } catch {
          /* already aborted */
        }
        reject(toStorageError(error, 'The database transaction failed'));
      });
  });
}

/** Promise wrapper for a single IDBRequest. */
export function request<T>(idbRequest: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(toStorageError(idbRequest.error, 'A database request failed'));
  });
}

/** Counts records in a store. */
export async function count(store: StoreName): Promise<number> {
  return transact(store, 'readonly', (tx) => request(tx.objectStore(store).count()));
}
