/**
 * Writing an imported battery save.
 *
 * Two very different callers need the same three steps — back up the current
 * save, write the import, and remember it — but they disagree about identity:
 * a running session owns a clock and an id sequence so its records sort
 * correctly, while the library view writes with the plain wall clock. Passing
 * those two tiny functions in keeps one implementation of the *semantics* (a
 * `pre-overwrite` copy is always taken first, so an import can be undone) while
 * letting each caller stay in charge of *when* it happened.
 */
import { batterySavesRepo, type BatterySaveRecord, type BatterySaveKind } from '@/storage/records';
import { hashBytesHex } from '@/storage/hash';

export interface ImportSaveContext {
  gameId: string;
  bytes: Uint8Array;
  note: string;
  nextId: (kind: BatterySaveKind) => string;
  now: () => number;
}

export async function writeImportedSave(context: ImportSaveContext): Promise<BatterySaveRecord> {
  const { gameId, bytes, note, nextId, now } = context;

  const existing = await batterySavesRepo.latest(gameId);
  if (existing) {
    await batterySavesRepo.put({
      ...existing,
      id: nextId('pre-overwrite'),
      kind: 'pre-overwrite',
      savedAt: now(),
      note: existing.note ?? 'kept before an import',
    });
  }

  const copy = bytes.slice();
  const record: BatterySaveRecord = {
    id: nextId('import'),
    gameId,
    kind: 'import',
    bytes: copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
    size: copy.byteLength,
    savedAt: now(),
    hash: await hashBytesHex(copy),
    note,
  };
  await batterySavesRepo.put(record);
  return record;
}
