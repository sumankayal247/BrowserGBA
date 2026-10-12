/**
 * Storage quota helpers.
 *
 * ROM libraries are large, so the app warns *before* an import fails rather
 * than after. The numbers come straight from the browser; when it refuses to
 * report them we say so instead of inventing a figure.
 */
import { StorageError } from './db';

export interface StorageEstimate {
  /** Bytes used by this origin, or null when the browser will not say. */
  usage: number | null;
  /** Bytes available to this origin, or null when unknown. */
  quota: number | null;
  /** usage / quota, 0..1, or null when unknown. */
  ratio: number | null;
  /** True when the browser has been asked to keep this data without eviction. */
  persisted: boolean;
  /** False when the Storage API is unavailable at all. */
  supported: boolean;
}

export async function estimateStorage(): Promise<StorageEstimate> {
  const manager = globalThis.navigator?.storage;
  if (!manager?.estimate) {
    return { usage: null, quota: null, ratio: null, persisted: false, supported: false };
  }

  try {
    const estimate = await manager.estimate();
    const usage = typeof estimate.usage === 'number' ? estimate.usage : null;
    const quota = typeof estimate.quota === 'number' && estimate.quota > 0 ? estimate.quota : null;
    const persisted = manager.persisted ? await manager.persisted() : false;
    return {
      usage,
      quota,
      ratio: usage !== null && quota !== null ? Math.min(usage / quota, 1) : null,
      persisted,
      supported: true,
    };
  } catch {
    return { usage: null, quota: null, ratio: null, persisted: false, supported: false };
  }
}

/**
 * Asks the browser to keep this origin's data.
 *
 * Chrome grants this silently or after engagement; Firefox may prompt. Either
 * answer is fine — the app never depends on it, it only reports it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const manager = globalThis.navigator?.storage;
  if (!manager?.persist) return false;
  try {
    if (manager.persisted && (await manager.persisted())) return true;
    return await manager.persist();
  } catch {
    return false;
  }
}

/**
 * Turns "the last write failed" into advice.
 *
 * Called when a write throws, so the user is told which of their games is
 * taking the space rather than a generic error.
 */
export function quotaAdvice(error: unknown): string | null {
  if (error instanceof StorageError && error.code === 'quota-exceeded') {
    return 'Browser storage is full. Remove a game you no longer need, or export a backup and free space, then try again.';
  }
  return null;
}

export function formatBytes(bytes: number | null, unknownLabel = 'unknown'): string {
  if (bytes === null || !Number.isFinite(bytes)) return unknownLabel;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  if (hours < 24) return remainMinutes === 0 ? `${hours} h` : `${hours} h ${remainMinutes} min`;
  const days = Math.floor(hours / 24);
  return `${days} d ${hours % 24} h`;
}
