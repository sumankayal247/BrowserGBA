/**
 * User-supplied cover art.
 *
 * Covers are optional images the user picks from their own device. BrowserGBA
 * never downloads box art: commercial artwork is copyrighted, and fetching it
 * from third-party services would leak which games a user owns.
 *
 * Exactly one cover per game, stored as a blob in its own store so metadata
 * writes stay small.
 */
import { STORE, StorageError, request, transact } from './db';
import { hashBytesHex } from './hash';

export interface CoverRecord {
  gameId: string;
  blob: Blob;
  width: number;
  height: number;
  mimeType: string;
  size: number;
  hash: string;
  addedAt: number;
}

/** Covers are shown at a few hundred pixels; anything larger is wasted quota. */
export const MAX_COVER_BYTES = 4 * 1024 * 1024;
export const MAX_COVER_DIMENSION = 2048;

const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

export class CoverError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'CoverError';
  }
}

/**
 * Rejects anything that is not a small, web-safe image.
 *
 * The type is checked from the file's own signature as well as its MIME type:
 * a `.png` file that is really a script is rejected here rather than handed to
 * the browser as an image.
 */
export async function validateCoverFile(file: File): Promise<void> {
  if (file.size === 0) throw new CoverError('That image file is empty.', 'empty');
  if (file.size > MAX_COVER_BYTES) {
    throw new CoverError(
      `Cover images must be smaller than ${Math.round(MAX_COVER_BYTES / 1024 / 1024)} MiB.`,
      'too-large',
    );
  }
  if (file.type && !ACCEPTED_TYPES.has(file.type)) {
    throw new CoverError('Choose a PNG, JPEG, WebP, GIF or AVIF image.', 'unsupported-type');
  }

  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!looksLikeImage(head)) {
    throw new CoverError('That file is not a recognised image.', 'not-an-image');
  }
}

function looksLikeImage(bytes: Uint8Array): boolean {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return true; // PNG
  if (starts(0xff, 0xd8, 0xff)) return true; // JPEG
  if (starts(0x47, 0x49, 0x46, 0x38)) return true; // GIF8
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45) return true;
  // ....ftyp (AVIF/HEIF are detected loosely, as the browser will reject a bad one anyway)
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return true;
  return false;
}

/** Decodes the image to learn its size and reject anything unreadable. */
export async function readImageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      throw new CoverError('That image could not be decoded.', 'decode-failed');
    }
  }
  // Fallback: let the browser decode through an <img>.
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
      URL.revokeObjectURL(url);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new CoverError('That image could not be decoded.', 'decode-failed'));
    };
    image.src = url;
  });
}

export async function setCover(gameId: string, file: File): Promise<CoverRecord> {
  await validateCoverFile(file);
  const { width, height } = await readImageDimensions(file);
  if (width > MAX_COVER_DIMENSION || height > MAX_COVER_DIMENSION) {
    throw new CoverError(
      `Cover images must be at most ${MAX_COVER_DIMENSION}×${MAX_COVER_DIMENSION} pixels (that one is ${width}×${height}).`,
      'too-large',
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const record: CoverRecord = {
    gameId,
    blob: new Blob([bytes], { type: file.type || 'image/png' }),
    width,
    height,
    mimeType: file.type || 'image/png',
    size: file.size,
    hash: await hashBytesHex(bytes),
    addedAt: Date.now(),
  };

  try {
    await transact(STORE.covers, 'readwrite', (tx) => request(tx.objectStore(STORE.covers).put(record)));
  } catch (error) {
    if (error instanceof StorageError) throw new CoverError(error.userMessage, error.code);
    throw error;
  }

  invalidateCoverUrl(gameId);
  return record;
}

export async function getCover(gameId: string): Promise<CoverRecord | null> {
  const record = await transact(STORE.covers, 'readonly', (tx) =>
    request<CoverRecord | undefined>(tx.objectStore(STORE.covers).get(gameId)),
  );
  return record ?? null;
}

export async function removeCover(gameId: string): Promise<void> {
  await transact(STORE.covers, 'readwrite', (tx) => request(tx.objectStore(STORE.covers).delete(gameId)));
  invalidateCoverUrl(gameId);
}

// --- object URL cache ------------------------------------------------------
//
// Covers are shown in grid and list views that re-render often; creating a new
// object URL per render would leak them, so URLs are cached per game and
// revoked explicitly when a cover changes or the app tears down.

const urlCache = new Map<string, string>();

export function invalidateCoverUrl(gameId: string): void {
  const existing = urlCache.get(gameId);
  if (!existing) return;
  URL.revokeObjectURL(existing);
  urlCache.delete(gameId);
}

export function releaseCoverUrls(): void {
  for (const url of urlCache.values()) URL.revokeObjectURL(url);
  urlCache.clear();
}

/**
 * Synchronous accessor used by the library renderer.
 *
 * Returns the cached URL when one exists; callers that need a fresh cover first
 * call `primeCoverUrl` (which is async) and re-render.
 */
export function peekCoverUrl(gameId: string): string | null {
  return urlCache.get(gameId) ?? null;
}

export async function primeCoverUrl(gameId: string): Promise<string | null> {
  const cached = urlCache.get(gameId);
  if (cached) return cached;
  const record = await getCover(gameId);
  if (!record) return null;
  const url = URL.createObjectURL(record.blob);
  urlCache.set(gameId, url);
  return url;
}

/** Primes every cover the library is about to show, in parallel. */
export async function primeCoversFor(gameIds: string[]): Promise<void> {
  await Promise.all(gameIds.map((id) => primeCoverUrl(id).catch(() => null)));
}
