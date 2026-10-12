/**
 * Backups: portable JSON bundles of a game's progress.
 *
 * What goes in: battery saves, save states, cheats and the library metadata for
 * one game. What never goes in: the ROM itself. A backup is metadata and
 * progress, so it stays small and cannot be used to redistribute a cartridge
 * image.
 *
 * Import is defensive — a bundle is untrusted input that may have been edited,
 * hand-written or produced by a different version. Every field is type-checked,
 * sizes are bounded, and records are re-keyed on import so a bundle can never
 * overwrite a record it does not own.
 */
import { BACKUP_FORMAT_VERSION, APP_VERSION } from '@/version';
import { STORE, request, transact } from './db';
import { nextRecordId } from './ids';
import { hashBytesHex } from './hash';
import { gamesRepo } from './records';
import type {
  BatterySaveRecord,
  CheatFormat,
  CheatRecord,
  GameRecord,
  SaveStateRecord,
} from './records';

export const BACKUP_FORMAT = 'browsergba.backup';
export const BACKUP_STATE_THUMBNAIL_LIMIT = 256 * 1024;

export interface BackupSave {
  kind: BatterySaveRecord['kind'];
  savedAt: number;
  note?: string;
  size: number;
  hash: string;
  data: string;
}

export interface BackupState {
  slot: number;
  name: string;
  note?: string;
  createdAt: number;
  coreName: string;
  coreVersion: string;
  romHash: string;
  size: number;
  data: string;
  thumbnail: string | null;
}

export interface BackupCheat {
  format: CheatFormat;
  label: string;
  code: string;
  enabled: boolean;
}

export interface BackupBundle {
  format: typeof BACKUP_FORMAT;
  version: number;
  appVersion: string;
  exportedAt: number;
  game: {
    contentHash: string;
    title: string;
    customTitle?: string;
    fileName: string;
    size: number;
    gameCode: string | null;
    makerCode: string | null;
    tags: string[];
    notes: string;
    playtimeMs: number;
    addedAt: number;
  };
  saves: BackupSave[];
  states: BackupState[];
  cheats: BackupCheat[];
}

export class BackupError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'BackupError';
  }
}

// --- base64 ----------------------------------------------------------------
//
// A dependency-free base64 codec that works on the main thread in any browser
// (no Node Buffer, no btoa() on binary strings with code points above 0xFF).

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '').replace(/=+$/, '');
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let byteIndex = 0;
  let buffer = 0;
  let bits = 0;
  for (const char of clean) {
    const value = B64_ALPHABET.indexOf(char);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[byteIndex++] = (buffer >> bits) & 0xff;
    }
  }
  return byteIndex === length ? bytes : bytes.subarray(0, byteIndex);
}

// --- export ----------------------------------------------------------------

/**
 * Builds a backup bundle for one game.
 *
 * The thumbnail is stored as base64 only when it is small; a state with a large
 * thumbnail still exports, just without the picture.
 */
export async function buildBackupBundle(gameId: string): Promise<BackupBundle> {
  const game = await gamesRepo.get(gameId);
  if (!game) throw new BackupError('That game is no longer in your library.', 'game-missing');

  const [saves, states, cheats] = await Promise.all([
    transact(STORE.batterySaves, 'readonly', (tx) =>
      request<BatterySaveRecord[]>(tx.objectStore(STORE.batterySaves).index('byGame').getAll(gameId)),
    ),
    transact(STORE.saveStates, 'readonly', (tx) =>
      request<SaveStateRecord[]>(tx.objectStore(STORE.saveStates).index('byGame').getAll(gameId)),
    ),
    transact(STORE.cheats, 'readonly', (tx) =>
      request<CheatRecord[]>(tx.objectStore(STORE.cheats).index('byGame').getAll(gameId)),
    ),
  ]);

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: Date.now(),
    game: {
      contentHash: game.contentHash,
      title: game.title,
      ...(game.customTitle ? { customTitle: game.customTitle } : {}),
      fileName: game.fileName,
      size: game.size,
      gameCode: game.gameCode,
      makerCode: game.makerCode,
      tags: [...game.tags],
      notes: game.notes,
      playtimeMs: game.playtimeMs,
      addedAt: game.addedAt,
    },
    saves: saves
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((save) => ({
        kind: save.kind,
        savedAt: save.savedAt,
        ...(save.note ? { note: save.note } : {}),
        size: save.size,
        hash: save.hash,
        data: bytesToBase64(new Uint8Array(save.bytes)),
      })),
    states: await Promise.all(
      states
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(async (state) => ({
          slot: state.slot,
          name: state.name,
          ...(state.note ? { note: state.note } : {}),
          createdAt: state.createdAt,
          coreName: state.coreName,
          coreVersion: state.coreVersion,
          romHash: state.romHash,
          size: state.size,
          data: bytesToBase64(new Uint8Array(state.bytes)),
          thumbnail: await encodeThumbnail(state.thumbnail),
        })),
    ),
    cheats: cheats
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((cheat) => ({
        format: cheat.format,
        label: cheat.label,
        code: cheat.code,
        enabled: cheat.enabled,
      })),
  };
}

async function encodeThumbnail(blob: Blob | null): Promise<string | null> {
  if (!blob || blob.size === 0 || blob.size > BACKUP_STATE_THUMBNAIL_LIMIT) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return bytesToBase64(bytes);
}

export function backupFileName(title: string): string {
  const safe = title.replace(/[^\w\d\-() ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'game';
  const stamp = new Date().toISOString().slice(0, 10);
  return `${safe} - BrowserGBA backup ${stamp}.json`;
}

// --- validation ------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new BackupError(`The backup is missing or has an invalid “${field}”.`, 'invalid-bundle');
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BackupError(`The backup has an invalid “${field}”.`, 'invalid-bundle');
  }
  return value;
}

const SAVE_KINDS: BatterySaveRecord['kind'][] = ['auto', 'manual', 'import', 'pre-overwrite'];
const CHEAT_FORMAT_IDS: CheatFormat[] = ['gameShark', 'codeBreaker', 'vba'];
/** Upper bound for a single record: 1 MiB is far beyond any GBA state or save. */
const MAX_RECORD_BYTES = 1024 * 1024;

/** Parses untrusted JSON text into a validated bundle. */
export function parseBackupBundle(text: string): BackupBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('That file is not valid JSON, so it is not a BrowserGBA backup.', 'not-json');
  }
  if (!isRecord(parsed)) throw new BackupError('That file does not contain a backup object.', 'invalid-bundle');
  if (parsed.format !== BACKUP_FORMAT) {
    throw new BackupError('That file is not a BrowserGBA backup.', 'wrong-format');
  }
  const version = requireNumber(parsed.version, 'version');
  if (version > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `This backup was written by a newer version of BrowserGBA (backup format ${version}, this build understands ${BACKUP_FORMAT_VERSION}).`,
      'newer-version',
    );
  }

  const game = parsed.game;
  if (!isRecord(game)) throw new BackupError('The backup has no game information.', 'invalid-bundle');

  const saves = Array.isArray(parsed.saves) ? parsed.saves : [];
  const states = Array.isArray(parsed.states) ? parsed.states : [];
  const cheats = Array.isArray(parsed.cheats) ? parsed.cheats : [];

  const bundle: BackupBundle = {
    format: BACKUP_FORMAT,
    version,
    appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : 'unknown',
    exportedAt: typeof parsed.exportedAt === 'number' ? parsed.exportedAt : Date.now(),
    game: {
      contentHash: requireString(game.contentHash, 'game.contentHash'),
      title: requireString(game.title, 'game.title'),
      ...(optionalString(game.customTitle) ? { customTitle: optionalString(game.customTitle)! } : {}),
      fileName: typeof game.fileName === 'string' ? game.fileName : 'restored.gba',
      size: typeof game.size === 'number' ? game.size : 0,
      gameCode: typeof game.gameCode === 'string' ? game.gameCode : null,
      makerCode: typeof game.makerCode === 'string' ? game.makerCode : null,
      tags: Array.isArray(game.tags) ? game.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20) : [],
      notes: typeof game.notes === 'string' ? game.notes.slice(0, 2000) : '',
      playtimeMs: typeof game.playtimeMs === 'number' ? game.playtimeMs : 0,
      addedAt: typeof game.addedAt === 'number' ? game.addedAt : Date.now(),
    },
    saves: saves.map((save, index) => {
      if (!isRecord(save)) throw new BackupError(`Save ${index + 1} is not an object.`, 'invalid-bundle');
      const kind = SAVE_KINDS.includes(save.kind as BatterySaveRecord['kind'])
        ? (save.kind as BatterySaveRecord['kind'])
        : 'import';
      const data = decodeChecked(requireString(save.data, `saves[${index}].data`), `save ${index + 1}`);
      return {
        kind,
        savedAt: typeof save.savedAt === 'number' ? save.savedAt : Date.now(),
        ...(optionalString(save.note) ? { note: optionalString(save.note)! } : {}),
        size: data.byteLength,
        hash: typeof save.hash === 'string' ? save.hash : '',
        data: bytesToBase64(data),
      };
    }),
    states: states.map((state, index) => {
      if (!isRecord(state)) throw new BackupError(`Save state ${index + 1} is not an object.`, 'invalid-bundle');
      const data = decodeChecked(requireString(state.data, `states[${index}].data`), `save state ${index + 1}`);
      const thumbnailText = optionalString(state.thumbnail);
      const thumbnail = thumbnailText ? bytesToBase64(decodeChecked(thumbnailText, `state ${index + 1} thumbnail`)) : null;
      return {
        slot: Math.max(0, Math.round(requireNumber(state.slot, `states[${index}].slot`))),
        name: typeof state.name === 'string' && state.name.trim() ? state.name.trim().slice(0, 64) : `Restored state ${index + 1}`,
        ...(optionalString(state.note) ? { note: optionalString(state.note)! } : {}),
        createdAt: typeof state.createdAt === 'number' ? state.createdAt : Date.now(),
        coreName: typeof state.coreName === 'string' ? state.coreName : 'mGBA',
        coreVersion: typeof state.coreVersion === 'string' ? state.coreVersion : 'unknown',
        romHash: typeof state.romHash === 'string' ? state.romHash : '',
        size: data.byteLength,
        data: bytesToBase64(data),
        thumbnail,
      };
    }),
    cheats: cheats.map((cheat, index) => {
      if (!isRecord(cheat)) throw new BackupError(`Cheat ${index + 1} is not an object.`, 'invalid-bundle');
      return {
        format: CHEAT_FORMAT_IDS.includes(cheat.format as CheatFormat) ? (cheat.format as CheatFormat) : 'gameShark',
        label: requireString(cheat.label, `cheats[${index}].label`).slice(0, 64),
        code: requireString(cheat.code, `cheats[${index}].code`).slice(0, 4000),
        enabled: cheat.enabled === true,
      };
    }),
  };

  return bundle;
}

function decodeChecked(text: string, what: string): Uint8Array {
  const bytes = base64ToBytes(text);
  if (bytes.byteLength === 0) throw new BackupError(`The ${what} has no data.`, 'invalid-bundle');
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    throw new BackupError(`The ${what} is larger than the 1 MiB this app will store.`, 'too-large');
  }
  return bytes;
}

// --- import ----------------------------------------------------------------

export interface RestoreResult {
  gameId: string;
  saves: number;
  states: number;
  cheats: number;
  /** True when the ROM hash matched an existing library entry. */
  matched: boolean;
}

/**
 * Restores a bundle into the library.
 *
 * A bundle is matched to a game by ROM content hash. When the exact ROM is not
 * present the progress is still imported, attached to the closest match the
 * caller supplies — or, if there is none, to a placeholder entry that says so.
 * Imports never delete existing records; they add new ones.
 */
export async function restoreBackupBundle(
  bundle: BackupBundle,
  options: { targetGameId?: string } = {},
): Promise<RestoreResult> {
  const existing = await gamesRepo.findByContentHash(bundle.game.contentHash);
  const target = options.targetGameId ? await gamesRepo.get(options.targetGameId) : existing;

  if (options.targetGameId && !target) {
    throw new BackupError('The game you chose is no longer in your library.', 'game-missing');
  }
  if (target && target.contentHash !== bundle.game.contentHash) {
    throw new BackupError(
      'This backup belongs to a different ROM (the content hashes do not match), so importing it could corrupt your progress.',
      'rom-mismatch',
    );
  }
  if (!target) {
    throw new BackupError(
      'Import this game’s ROM first: BrowserGBA matches backups by ROM content hash so progress cannot be applied to the wrong game.',
      'rom-required',
    );
  }

  const gameId = target.id;
  const now = Date.now();

  await transact([STORE.batterySaves, STORE.saveStates, STORE.cheats], 'readwrite', async (tx) => {
    const saveStore = tx.objectStore(STORE.batterySaves);
    for (const save of bundle.saves) {
      const bytes = base64ToBytes(save.data);
      const record: BatterySaveRecord = {
        id: nextRecordId('restore', gameId, now),
        gameId,
        kind: save.kind === 'auto' ? 'import' : save.kind,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        size: bytes.byteLength,
        savedAt: save.savedAt,
        hash: save.hash || (await hashBytesHex(bytes)),
        note: save.note ?? 'restored from backup',
      };
      await request(saveStore.put(record));
    }

    const stateStore = tx.objectStore(STORE.saveStates);
    for (const state of bundle.states) {
      const bytes = base64ToBytes(state.data);
      const thumbnail = state.thumbnail ? base64ToBytes(state.thumbnail) : null;
      const record: SaveStateRecord = {
        id: nextRecordId('state', gameId, now),
        gameId,
        slot: state.slot,
        name: state.name,
        ...(state.note ? { note: state.note } : {}),
        createdAt: state.createdAt,
        bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        size: bytes.byteLength,
        thumbnail: thumbnail ? new Blob([thumbnail as unknown as BlobPart], { type: 'image/png' }) : null,
        coreName: state.coreName,
        coreVersion: state.coreVersion,
        romHash: bundle.game.contentHash,
      };
      await request(stateStore.put(record));
    }

    const cheatStore = tx.objectStore(STORE.cheats);
    for (const cheat of bundle.cheats) {
      const record: CheatRecord = {
        id: nextRecordId('cheat', gameId, now),
        gameId,
        format: cheat.format,
        label: cheat.label,
        code: cheat.code,
        enabled: cheat.enabled,
        createdAt: now,
        updatedAt: now,
      };
      await request(cheatStore.put(record));
    }
  });

  // Merge metadata without destroying anything the user set locally.
  const patch: Partial<GameRecord> = {
    tags: [...new Set([...target.tags, ...bundle.game.tags])].slice(0, 20),
    playtimeMs: Math.max(target.playtimeMs, bundle.game.playtimeMs),
  };
  if (bundle.game.customTitle && !target.customTitle) patch.customTitle = bundle.game.customTitle;
  await gamesRepo.patch(gameId, patch);

  return {
    gameId,
    saves: bundle.saves.length,
    states: bundle.states.length,
    cheats: bundle.cheats.length,
    matched: existing !== null,
  };
}
