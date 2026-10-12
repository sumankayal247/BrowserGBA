/**
 * Storage availability gate.
 *
 * Called once at startup. If IndexedDB is missing there is no honest way to run
 * a "library" app, so we stop with instructions rather than pretending to work
 * and losing the user's imports.
 */
import { StorageError, isIndexedDbAvailable, openDatabase } from './db';
import { estimateStorage, type StorageEstimate } from './quota';

export class StorageUnsupportedError extends StorageError {
  constructor() {
    super(
      'unavailable',
      'BrowserGBA needs IndexedDB to store your library, saves and save states. This browser (or this browsing mode) does not provide it.',
    );
    this.name = 'StorageUnsupportedError';
  }
}

/** Throws a typed, user-facing error when storage cannot be used at all. */
export function assertSupportedStorage(): void {
  if (!isIndexedDbAvailable()) throw new StorageUnsupportedError();
}

/**
 * Opens the database and reports storage pressure.
 *
 * Returns the estimate so the UI can warn before a large import rather than
 * after a failed one.
 */
export async function checkStorageHealth(): Promise<StorageEstimate> {
  assertSupportedStorage();
  await openDatabase();
  return estimateStorage();
}

/** True when usage is high enough that the next import may fail. */
export function isStoragePressure(estimate: StorageEstimate, threshold = 0.9): boolean {
  if (estimate.ratio === null) return false;
  return estimate.ratio >= threshold;
}

export function storagePressureMessage(estimate: StorageEstimate): string {
  const percent = estimate.ratio === null ? null : Math.round(estimate.ratio * 100);
  return percent === null
    ? 'Browser storage is nearly full. Remove a game or export a backup before importing more.'
    : `Browser storage is ${percent}% full. Remove a game or export a backup before importing more.`;
}
