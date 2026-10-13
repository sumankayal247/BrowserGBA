/**
 * Battery-save files the user can bring in from outside the app.
 *
 * A cartridge save is a fixed-size blob of save memory and nothing else — no
 * header, no metadata — so the only thing that can be checked before handing it
 * to the emulator is its size, which is also how the cartridge type is
 * recognised. Guessing wrongly is not harmless: a 32 KiB file loaded as flash
 * (or the reverse) makes the game believe its save is corrupt and offer to
 * erase it, so the sizes below are the complete list of what a GBA cartridge
 * can hold and anything else is refused with an explanation.
 *
 * Exports come from this app, from other emulators (`.sav`, `.srm`, `.bin`) and
 * from real cartridges, so the extension is never inspected — only the bytes.
 */

/** Every save-memory size a GBA cartridge shipped with, in bytes. */
export const SAVE_FILE_SIZES = {
  'eeprom-4k': 512,
  'eeprom-64k': 8192,
  sram: 32768,
  'flash-512k': 65536,
  'flash-1m': 131072,
} as const;

export type SaveFileKind = keyof typeof SAVE_FILE_SIZES;

export type SaveFileCheck =
  | { ok: true; kind: SaveFileKind; label: string; size: number }
  | { ok: false; reason: string };

const LABELS: Record<SaveFileKind, string> = {
  'eeprom-4k': 'EEPROM (512 bytes)',
  'eeprom-64k': 'EEPROM (8 KiB)',
  sram: 'SRAM (32 KiB)',
  'flash-512k': 'Flash (64 KiB)',
  'flash-1m': 'Flash (128 KiB)',
};

const HUMAN_SIZES = '512 bytes, 8 KiB, 32 KiB, 64 KiB or 128 KiB';

/**
 * Decides whether a picked file can be used as a battery save.
 *
 * `size` is the only input, deliberately: the file name is reported back to the
 * user but never used to make the decision, because the same bytes arrive named
 * `.sav`, `.srm`, `.bin` or something a file manager invented.
 */
export function checkSaveFile(fileName: string, size: number): SaveFileCheck {
  if (!Number.isFinite(size) || size <= 0) {
    return { ok: false, reason: `${describe(fileName)} is empty, so there is no save data in it.` };
  }
  for (const [kind, bytes] of Object.entries(SAVE_FILE_SIZES) as Array<[SaveFileKind, number]>) {
    if (size === bytes) {
      return { ok: true, kind, label: LABELS[kind], size };
    }
  }
  return {
    ok: false,
    reason: `${describe(fileName)} is ${size.toLocaleString()} bytes. GBA save memory is always one of ${HUMAN_SIZES}, so this is a different kind of file.`,
  };
}

function describe(fileName: string): string {
  const trimmed = fileName.trim();
  return trimmed.length > 0 ? `“${trimmed}”` : 'That file';
}
