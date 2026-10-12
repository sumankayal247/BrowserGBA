/**
 * Storage quota reporting and eviction protection.
 *
 * Browsers may evict an origin's data under pressure, and the user must be told
 * the truth about that. We do not promise durability we cannot deliver.
 */
import { StorageError } from './db';

export interface StorageEstimate {
  /** Best-effort bytes used by this origin, or null when the browser will not say. */
  usage: number | null;
  /** Best-effort quota, or null when unknown. */
  quota: number | null;
  /** usage / quota as a ratio in 0..1, or null when unknown. */
  ratio: number | null;
  /**
   * Whether the browser is *likely* to keep this origin's data without eviction.
   * False means "the browser may clear this at any time".
   */
  persisted: boolean;
  /** True when the Storage API itself is unavailable. */
  supported: boolean;
}

export async function estimateStorage(): Promise<StorageEstimate> {
  const manager = globalThis.navigator?.storage;
  if (!manager || typeof manager.estimate !== 'function') {
    return { usage: null, quota: null, ratio: null, persisted: false, supported: false };
  }

  let usage: number | null = null;
  let quota: number | null = null;
  try {
    const estimate = await manager.estimate();
    usage = typeof estimate.usage === 'number' ? estimate.usage : null;
    quota = typeof estimate.quota === 'number' ? estimate.quota : null;
  } catch {
    // Some browsers throw when the quota is unavailable; treat as unknown.
  }

  let persisted = false;
  try {
    persisted = typeof manager.persisted === 'function' ? await manager.persisted() : false;
  } catch {
    persisted = false;
  }

  return {
    usage,
    quota,
    ratio: usage !== null && quota ? Math.min(usage / quota, 1) : null,
    persisted,
    supported: true,
  };
}

/**
 * Asks the browser to exempt this origin from automatic eviction.
 *
 * Requires a user gesture in most browsers, so it is only ever called from an
 * explicit button press, never on load.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  const manager = globalThis.navigator?.storage;
  if (!manager || typeof manager.persist !== 'function') {
    throw new StorageError(
      'not-supported',
      'This browser has no API for requesting persistent storage.',
    );
  }
  try {
    return await manager.persist();
  } catch (error) {
    throw new StorageError('unavailable', 'The browser rejected the persistence request.', error);
  }
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/** Formats a byte count for humans; `null` becomes an explicit unknown. */
export function formatBytes(bytes: number | null | undefined, unknownLabel = 'unknown'): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return unknownLabel;
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** Formats a duration in milliseconds as a compact playtime string. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 1) return 'under a minute';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 1) return `${totalMinutes} min`;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}
