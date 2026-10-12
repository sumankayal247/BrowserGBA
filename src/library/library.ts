/**
 * Library service: everything that happens between "the user picked a file"
 * and "the game appears in the library".
 *
 * The import path is deliberately two-phase:
 *
 *   prepareImport()  — read, validate, hash, look for an existing entry.
 *                      Nothing is written; the caller can show the user what
 *                      they are about to add.
 *   commitImport()   — write the ROM bytes and the library record together.
 *
 * Duplicates are decided by content hash, so the same ROM from a different
 * download still lands on the same library entry and keeps its saves — while a
 * *modified* ROM (a different hack) is a different game, even if it has the
 * same title in its header.
 */
import { hashBytesHex } from '@/storage/hash';
import { romsRepo, gamesRepo, type GameRecord } from '@/storage/records';
import { STORE, StorageError, request, transact } from '@/storage/db';
import { nextRecordId } from '@/storage/ids';
import type { GbaHeader } from '@/rom/header';
import {
  displayTitleFor,
  validateRomFile,
  validateRomFileMetadata,
  type RomValidationIssue,
  type RomValidationResult,
} from '@/rom/validate';

export type ImportErrorCode =
  | 'invalid-file'
  | 'too-large'
  | 'read-failed'
  | 'cancelled'
  | 'storage-failed';

export class ImportError extends Error {
  constructor(
    message: string,
    readonly code: ImportErrorCode,
    /** Every problem found, so the UI can list them instead of guessing. */
    readonly issues: RomValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

/** Turns any import failure into text a user can act on. */
export function importErrorMessage(error: unknown): string {
  if (error instanceof ImportError) return error.message;
  if (error instanceof StorageError) return error.userMessage;
  return error instanceof Error ? error.message : 'The import failed for an unknown reason.';
}

export type DuplicateStrategy = 'replace' | 'keep-both' | 'cancel';

export interface ImportCandidate {
  gameId: string;
  contentHash: string;
  fileName: string;
  size: number;
  /** Title from the ROM header, after cleanup. */
  title: string;
  header: GbaHeader | null;
  validation: RomValidationResult;
  /** Non-fatal problems; shown but not blocking. */
  warnings: string[];
  /** An existing library entry with the same content, if there is one. */
  duplicate: GameRecord | null;
  bytes: Uint8Array;
}

export interface CommitOptions {
  /** What to do when an entry with the same content already exists. */
  onDuplicate?: DuplicateStrategy;
  /** User-supplied title, overriding the ROM header. */
  customTitle?: string;
  tags?: string[];
  notes?: string;
}

export interface CommitResult {
  game: GameRecord;
  /** True when this replaced the bytes of an existing entry. */
  replaced: boolean;
}

/** Longest play session counted from a single sitting: six hours. */
export const MAX_SESSION_MS = 6 * 60 * 60 * 1000;

function slugFromHash(contentHash: string): string {
  // Short, stable, and safe as a filename inside the emulator's filesystem.
  return `g_${contentHash.slice(0, 32)}`;
}

/** Everything that can be checked before writing anything. */
export async function prepareImport(
  file: { name: string; size: number },
  bytes: Uint8Array,
): Promise<ImportCandidate> {
  // Size and extension are checked before the file is fully parsed: a user who
  // picked a 400 MB file should get an answer immediately.
  const preflight = validateRomFileMetadata(file.name, file.size).filter((issue) => issue.severity === 'error');
  if (preflight.length > 0) {
    throw new ImportError(preflight[0]!.message, 'invalid-file', preflight);
  }

  const validation = validateRomFile(file.name, bytes);
  const header = validation.header;

  if (!validation.ok) {
    const errors = validation.issues.filter((issue) => issue.severity === 'error');
    throw new ImportError(
      errors[0]?.message ?? 'That file does not look like a Game Boy Advance ROM.',
      'invalid-file',
      errors,
    );
  }

  const contentHash = await hashBytesHex(bytes);
  const gameId = slugFromHash(contentHash);
  const duplicate = await gamesRepo.findByContentHash(contentHash);

  return {
    gameId,
    contentHash,
    fileName: file.name,
    size: bytes.byteLength,
    title: displayTitleFor(header, file.name),
    header,
    validation,
    warnings: validation.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
    duplicate,
    bytes,
  };
}

/** Writes a prepared import. Never partially: bytes and record go together. */
export async function commitImport(
  candidate: ImportCandidate,
  options: CommitOptions = {},
): Promise<CommitResult> {
  const strategy = options.onDuplicate ?? 'replace';

  if (candidate.duplicate && strategy === 'cancel') {
    throw new ImportError('Import cancelled.', 'cancelled');
  }

  const now = Date.now();
  const keepExisting = candidate.duplicate !== null && strategy === 'keep-both';
  const id = keepExisting ? nextRecordId('dupe', candidate.gameId, now) : candidate.gameId;

  const existing = candidate.duplicate;
  const game: GameRecord = {
    id,
    contentHash: candidate.contentHash,
    // A duplicate import brings the same bytes, so it keeps the user's name,
    // tags, notes and play stats rather than resetting them.
    title: candidate.title,
    ...(existing?.customTitle ? { customTitle: existing.customTitle } : {}),
    fileName: candidate.fileName,
    size: candidate.size,
    gameCode: candidate.header?.gameCode ?? null,
    makerCode: candidate.header?.makerCode ?? null,
    softwareVersion: candidate.header?.softwareVersion ?? null,
    hasNintendoLogo: candidate.header?.hasNintendoLogo ?? false,
    warnings: candidate.warnings,
    addedAt: existing?.addedAt ?? now,
    lastPlayedAt: existing?.lastPlayedAt ?? null,
    playtimeMs: existing?.playtimeMs ?? 0,
    favourite: existing?.favourite ?? false,
    tags: existing?.tags ?? [],
    notes: existing?.notes ?? '',
  };

  if (options.customTitle !== undefined) {
    game.customTitle = options.customTitle.trim() || undefined;
  }
  if (options.tags) game.tags = [...new Set(options.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
  if (options.notes !== undefined) game.notes = options.notes;

  try {
    // Bytes first: a library entry without its ROM would be a broken game.
    await romsRepo.put(id, candidate.bytes.slice().buffer as ArrayBuffer);
    await gamesRepo.put(game);
  } catch (error) {
    throw new ImportError(
      error instanceof StorageError ? error.userMessage : 'The ROM could not be stored on this device.',
      'storage-failed',
    );
  }

  return { game, replaced: existing !== null && !keepExisting };
}

// --- queries ---------------------------------------------------------------

export type SortKey = 'recent' | 'added' | 'title' | 'playtime';

export interface LibraryQuery {
  search?: string;
  sort?: SortKey;
  /** All of these tags must be present. */
  tags?: string[];
  /** Convenience for the UI's single-tag filter. */
  tag?: string;
  favouritesOnly?: boolean;
  limit?: number;
}

/** The title to show: the user's own name wins over the ROM header. */
export function titleOf(game: GameRecord): string {
  const custom = game.customTitle?.trim();
  if (custom) return custom;
  const header = game.title?.trim();
  if (header) return header;
  return game.fileName.replace(/\.gba$/i, '');
}

export function matchesQuery(game: GameRecord, query: LibraryQuery): boolean {
  if (query.favouritesOnly && !game.favourite) return false;
  const wanted = query.tags?.length ? query.tags : query.tag ? [query.tag] : [];
  if (wanted.length) {
    const tags = new Set(game.tags.map((tag) => tag.toLowerCase()));
    if (!wanted.every((tag) => tags.has(tag.toLowerCase()))) return false;
  }
  const search = query.search?.trim().toLowerCase();
  if (search) {
    const haystack = [titleOf(game), game.fileName, game.gameCode ?? '', game.contentHash, ...game.tags]
      .join(' ')
      .toLowerCase();
    if (!search.split(/\s+/).every((token) => haystack.includes(token))) return false;
  }
  return true;
}

export function sortGames(games: GameRecord[], sort: SortKey = 'recent'): GameRecord[] {
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  const rows = [...games];
  // Every comparison ends in an id comparison: a stable, predictable order means
  // the grid never reshuffles between two renders of the same data.
  const byId = (a: GameRecord, b: GameRecord) => a.id.localeCompare(b.id);
  switch (sort) {
    case 'title':
      return rows.sort((a, b) => collator.compare(titleOf(a), titleOf(b)) || byId(a, b));
    case 'added':
      return rows.sort((a, b) => b.addedAt - a.addedAt || byId(a, b));
    case 'playtime':
      return rows.sort((a, b) => b.playtimeMs - a.playtimeMs || byId(a, b));
    case 'recent':
    default:
      return rows.sort(
        (a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.addedAt - a.addedAt || byId(a, b),
      );
  }
}

export async function listGames(query: LibraryQuery = {}): Promise<GameRecord[]> {
  const games = await gamesRepo.all();
  const filtered = games.filter((game) => matchesQuery(game, query));
  const sorted = sortGames(filtered, query.sort);
  return query.limit ? sorted.slice(0, query.limit) : sorted;
}

export async function getGame(id: string): Promise<GameRecord | null> {
  return gamesRepo.get(id);
}

export async function updateGame(id: string, patch: Partial<Omit<GameRecord, 'id'>>): Promise<GameRecord> {
  return gamesRepo.patch(id, patch);
}

export async function setFavourite(id: string, favourite: boolean): Promise<GameRecord> {
  return gamesRepo.patch(id, { favourite });
}

/** All tags in use, sorted, for the filter menu. */
export async function allTags(): Promise<string[]> {
  const games = await gamesRepo.all();
  return [...new Set(games.flatMap((game) => game.tags))].sort((a, b) => a.localeCompare(b));
}

export async function getRomBytes(gameId: string): Promise<ArrayBuffer | null> {
  const record = await romsRepo.get(gameId);
  return record?.bytes ?? null;
}

/**
 * Records a play session.
 *
 * Playtime accumulates and `lastPlayedAt` is stamped once per session, so the
 * "recently played" order reflects when the user last opened the game rather
 * than how long they played.
 */
export async function recordPlaySession(gameId: string, elapsedMs: number, when = Date.now()): Promise<GameRecord> {
  const game = await gamesRepo.get(gameId);
  if (!game) throw new StorageError('not-found', `No game with id ${gameId}`);
  // A tab that was suspended (or a laptop that slept) can report an absurd
  // session length. Counting it would make the library lie about playtime, so
  // each session is capped and negative values are ignored.
  const elapsed = Number.isFinite(elapsedMs) ? Math.min(Math.max(0, elapsedMs), MAX_SESSION_MS) : 0;
  return gamesRepo.patch(gameId, {
    playtimeMs: game.playtimeMs + Math.round(elapsed),
    lastPlayedAt: when,
  });
}

export interface RemoveOptions {
  /** Also delete saves, states and cheats. Defaults to true. */
  deleteAssociatedData?: boolean;
}

/**
 * Removes a game.
 *
 * With `deleteAssociatedData: false` the ROM bytes go but the library entry,
 * saves, states and cheats stay: the game is marked as missing its ROM, and
 * importing that same ROM again re-attaches it instantly (the content hash is
 * unchanged). Nothing the user earned is thrown away by accident.
 */
export async function removeGame(id: string, options: RemoveOptions = {}): Promise<void> {
  const deleteAssociated = options.deleteAssociatedData ?? true;
  if (deleteAssociated) {
    await gamesRepo.removeCascade(id);
    return;
  }

  const game = await gamesRepo.get(id);
  if (!game) throw new StorageError('not-found', `No game with id ${id}`);

  const warning = 'ROM file removed; saves, states and cheats were kept.';
  await transact([STORE.games, STORE.roms], 'readwrite', async (tx) => {
    await request(tx.objectStore(STORE.roms).delete(id));
    await request(
      tx.objectStore(STORE.games).put({
        ...game,
        warnings: [...new Set([...game.warnings, warning])],
      }),
    );
  });
}

/** True when the ROM bytes for a game are no longer stored. */
export async function isRomMissing(gameId: string): Promise<boolean> {
  return getRomBytes(gameId).then((bytes) => bytes === null);
}
