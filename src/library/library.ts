/**
 * The game library domain service.
 *
 * This is the only place that knows how a ROM becomes a library entry. It is
 * deliberately free of DOM and emulator concerns so it can be unit tested
 * against an in-memory IndexedDB.
 */
import { sha256Hex, deriveGameId } from '@/rom/hash';
import { parseGbaHeader, type GbaHeader } from '@/rom/header';
import {
  displayTitleFor,
  validateRomFile,
  validateRomFileMetadata,
  type RomValidationIssue,
} from '@/rom/validate';
import { headerFieldsFor, gamesRepo, romsRepo, type GamePatch, type GameRecord } from '@/storage/records';
import { StorageError } from '@/storage/db';

export type ImportErrorCode =
  | 'invalid-file'
  | 'duplicate-cancelled'
  | 'empty-rom'
  | 'storage-failed';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly issues: RomValidationIssue[] = [],
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ImportCandidate {
  gameId: string;
  contentHash: string;
  fileName: string;
  size: number;
  /** Title we would store; `customTitle` in the plan can override it. */
  title: string;
  header: GbaHeader | null;
  warnings: RomValidationIssue[];
  /** Existing library entry with identical bytes, if any. */
  duplicate: GameRecord | null;
  bytes: ArrayBuffer;
}

export type DuplicateStrategy = 'replace' | 'keep-both' | 'cancel';

export interface CommitOptions {
  /** How to handle an identical ROM already in the library. */
  onDuplicate?: DuplicateStrategy;
  /** Optional user-supplied title override, stored as `customTitle`. */
  customTitle?: string;
  tags?: string[];
  notes?: string;
  now?: () => number;
}

export interface CommitResult {
  game: GameRecord;
  replaced: boolean;
}

/**
 * Validates and fingerprints a file *without* writing anything.
 *
 * The UI shows this plan (title, warnings, duplicate status) and only then calls
 * `commitImport`, which is what makes "ask before replacing" possible.
 */
export async function prepareImport(file: { name: string; size: number }, bytes: Uint8Array): Promise<ImportCandidate> {
  const metadataIssues = validateRomFileMetadata(file.name, file.size);
  if (metadataIssues.some((issue) => issue.severity === 'error')) {
    throw new ImportError(
      'invalid-file',
      metadataIssues[0]?.message ?? 'That file cannot be imported.',
      metadataIssues,
    );
  }
  if (bytes.byteLength === 0) {
    throw new ImportError('empty-rom', 'That file is empty.');
  }

  const validation = validateRomFile(file.name, bytes);
  if (!validation.ok) {
    throw new ImportError(
      'invalid-file',
      validation.issues.find((issue) => issue.severity === 'error')?.message ??
        'That file is not a Game Boy Advance ROM.',
      validation.issues,
    );
  }

  const contentHash = await sha256Hex(bytes);
  const gameId = deriveGameId(contentHash);
  const header = validation.header ?? safeParseHeader(bytes);
  const duplicate = await gamesRepo.findByContentHash(contentHash);

  return {
    gameId,
    contentHash,
    fileName: file.name,
    size: bytes.byteLength,
    title: displayTitleFor(header, file.name),
    header,
    warnings: validation.issues.filter((issue) => issue.severity === 'warning'),
    duplicate,
    // Copy so later mutations of the caller's buffer cannot corrupt the stored ROM.
    bytes: bytes.slice().buffer,
  };
}

function safeParseHeader(bytes: Uint8Array): GbaHeader | null {
  try {
    return parseGbaHeader(bytes);
  } catch {
    return null;
  }
}

/** Writes a prepared import to storage. */
export async function commitImport(candidate: ImportCandidate, options: CommitOptions = {}): Promise<CommitResult> {
  const now = options.now ?? Date.now;
  const strategy = options.onDuplicate ?? (candidate.duplicate ? 'cancel' : 'replace');

  if (candidate.duplicate) {
    if (strategy === 'cancel') {
      throw new ImportError('duplicate-cancelled', 'Import cancelled: this ROM is already in your library.');
    }
    if (strategy === 'replace') {
      // Same bytes, same identity: refresh the ROM copy and metadata but keep
      // play history, so "re-import after clearing the ROM" is not destructive.
      await romsRepo.put(candidate.gameId, candidate.bytes);
      const game = await gamesRepo.patch(candidate.gameId, {
        fileName: candidate.fileName,
        ...(options.customTitle !== undefined ? { customTitle: options.customTitle } : {}),
        ...headerFieldsFor(candidate.header),
      });
      return { game, replaced: true };
    }
    // 'keep-both' cannot apply to byte-identical content — the identity *is* the
    // content hash, so there is nothing distinct to store. Surfaced as replace.
    await romsRepo.put(candidate.gameId, candidate.bytes);
    return { game: (await gamesRepo.get(candidate.gameId))!, replaced: true };
  }

  const timestamp = now();
  const game: GameRecord = {
    id: candidate.gameId,
    contentHash: candidate.contentHash,
    title: candidate.title,
    fileName: candidate.fileName,
    size: candidate.size,
    ...headerFieldsFor(candidate.header),
    warnings: candidate.warnings.map((issue) => issue.message),
    addedAt: timestamp,
    lastPlayedAt: null,
    playtimeMs: 0,
    favourite: false,
    tags: options.tags ?? [],
    notes: options.notes ?? '',
    ...(options.customTitle ? { customTitle: options.customTitle } : {}),
  };

  try {
    // ROM bytes first: if the binary fails to store, no half-imported metadata
    // entry is left behind pointing at nothing.
    await romsRepo.put(candidate.gameId, candidate.bytes);
    await gamesRepo.put(game);
  } catch (error) {
    if (error instanceof StorageError) {
      throw new ImportError('storage-failed', error.userMessage, []);
    }
    throw error;
  }

  return { game, replaced: false };
}

// --- queries ---------------------------------------------------------------

export type SortKey = 'recent' | 'added' | 'title' | 'playtime';

export interface LibraryQuery {
  search?: string;
  favouritesOnly?: boolean;
  tag?: string;
  sort?: SortKey;
}

/** Title shown in the UI: user override, then header title, then filename. */
export function titleOf(game: GameRecord): string {
  return game.customTitle?.trim() || game.title;
}

function normalise(value: string): string {
  return value.toLowerCase().trim();
}

export function matchesQuery(game: GameRecord, query: LibraryQuery): boolean {
  if (query.favouritesOnly && !game.favourite) return false;
  if (query.tag && !game.tags.includes(query.tag)) return false;
  const search = query.search?.trim();
  if (!search) return true;
  const haystack = [titleOf(game), game.fileName, game.gameCode ?? '', game.makerCode ?? '', ...game.tags]
    .map(normalise)
    .join(' ');
  return search
    .split(/\s+/)
    .map(normalise)
    .every((term) => haystack.includes(term));
}

export function sortGames(games: GameRecord[], sort: SortKey = 'recent'): GameRecord[] {
  const copy = [...games];
  const byTitle = (a: GameRecord, b: GameRecord) =>
    titleOf(a).localeCompare(titleOf(b), undefined, { numeric: true, sensitivity: 'base' });

  switch (sort) {
    case 'title':
      return copy.sort(byTitle);
    case 'added':
      return copy.sort((a, b) => b.addedAt - a.addedAt);
    case 'playtime':
      return copy.sort((a, b) => b.playtimeMs - a.playtimeMs || byTitle(a, b));
    case 'recent':
    default:
      // Never-played games sort by when they were added, not by a fake timestamp.
      return copy.sort((a, b) => (b.lastPlayedAt ?? b.addedAt) - (a.lastPlayedAt ?? a.addedAt) || byTitle(a, b));
  }
}

export async function listGames(query: LibraryQuery = {}): Promise<GameRecord[]> {
  const games = await gamesRepo.all();
  return sortGames(
    games.filter((game) => matchesQuery(game, query)),
    query.sort,
  );
}

export async function getGame(id: string): Promise<GameRecord | null> {
  return gamesRepo.get(id);
}

export async function updateGame(id: string, patch: GamePatch): Promise<GameRecord> {
  return gamesRepo.patch(id, patch);
}

export async function setFavourite(id: string, favourite: boolean): Promise<GameRecord> {
  return gamesRepo.patch(id, { favourite });
}

export async function recordPlaySession(id: string, elapsedMs: number): Promise<GameRecord> {
  const game = await gamesRepo.get(id);
  if (!game) throw new StorageError('not-found', `No game with id ${id}.`);
  return gamesRepo.patch(id, {
    lastPlayedAt: Date.now(),
    // Guard against a clock jump or a suspended tab inflating playtime.
    playtimeMs: game.playtimeMs + Math.max(0, Math.min(elapsedMs, 6 * 60 * 60 * 1000)),
  });
}

export interface RemoveOptions {
  /** Also delete battery saves, save states, cheats and screenshots. Default true. */
  deleteAssociatedData?: boolean;
}

export async function removeGame(id: string, options: RemoveOptions = {}): Promise<void> {
  const deleteAssociated = options.deleteAssociatedData ?? true;
  if (deleteAssociated) {
    await gamesRepo.removeCascade(id);
    return;
  }
  // Keep the user's progress: drop the ROM bytes and the library entry, but
  // leave saves/states/cheats addressable if the same ROM is imported again.
  await romsRepo.remove(id);
  await gamesRepo.patch(id, { warnings: ['ROM file removed; progress kept.'] });
}

export async function getRomBytes(gameId: string): Promise<ArrayBuffer | null> {
  const record = await romsRepo.get(gameId);
  return record?.bytes ?? null;
}

export async function allTags(): Promise<string[]> {
  const games = await gamesRepo.all();
  return [...new Set(games.flatMap((game) => game.tags))].sort((a, b) => a.localeCompare(b));
}
