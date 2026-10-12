/**
 * Per-ROM cheat handling.
 *
 * Scope rules that the rest of the app relies on:
 *
 * - A cheat always belongs to exactly one `gameId`. There is no global list.
 * - The serialised `.cheats` file is named after the ROM's internal file name on
 *   the emulated filesystem, which is derived from `gameId`, so the emulator
 *   itself can only ever load the cheats for the game it just booted.
 *
 * The formats below are the ones mGBA actually implements for GBA (verified
 * against mGBA's `src/gba/cheats/` and `src/core/cheats.c`). Nothing else is
 * advertised, because advertising an unverified format would mean silently
 * ignoring a user's codes.
 *
 * Supported line syntax:
 *  - GameShark Advance / Action Replay (PAR v3): `XXXXXXXX YYYYYYYY`
 *    (8 hex + space + 8 hex; the core auto-detects the encrypted GSA/PAR
 *    variants, and `!GSAv1`/`!PARv3` directives are emitted when the user picks
 *    a specific encoding).
 *  - CodeBreaker: `XXXXXXXX YYYY` (8 hex + space + 4 hex)
 *  - Raw / VBA: `XXXXXXXX:YY` or `XXXXXXXX:VVVV` (mGBA rejects a 6-digit body)
 */
import type { CheatFormat, CheatRecord } from '@/storage/records';

export type { CheatFormat } from '@/storage/records';

export interface CheatFormatInfo {
  id: CheatFormat;
  label: string;
  /** Shown in the UI next to the format picker. */
  hint: string;
  /** mGBA directive emitted before the codes, when the format needs one. */
  directive: string | null;
  example: string;
}

export const CHEAT_FORMATS: Record<CheatFormat, CheatFormatInfo> = {
  gameShark: {
    id: 'gameShark',
    label: 'GameShark / Action Replay',
    hint: '8 hex digits, a space, then 8 more. The emulator detects GameShark Advance v1–v3 and Action Replay (PAR v3) encodings.',
    directive: null,
    example: '82025BC4 000F423F',
  },
  codeBreaker: {
    id: 'codeBreaker',
    label: 'CodeBreaker',
    hint: '8 hex digits, a space, then 4 more.',
    directive: null,
    example: '82025BC4 423F',
  },
  vba: {
    id: 'vba',
    label: 'Raw / VBA',
    hint: 'An 8-digit hex address, a colon, then 2, 4 or 8 hex digits.',
    directive: null,
    example: '02025BC4:0F423F',
  },
};

export const MAX_CHEAT_LINES = 200;
export const MAX_LABEL_LENGTH = 64;
export const MAX_CODE_LINE_LENGTH = 64;

export interface CheatLineError {
  /** 1-based line number within the code block. */
  line: number;
  message: string;
}

export interface CheatValidationResult {
  ok: boolean;
  errors: CheatLineError[];
  /** Non-fatal notes, e.g. "leading and trailing spaces removed". */
  notices: string[];
}

const PATTERNS: Record<CheatFormat, RegExp> = {
  // Two 32-bit hex words.
  gameShark: /^[0-9a-fA-F]{8}\s+[0-9a-fA-F]{8}$/,
  // 32-bit address plus a 16-bit value.
  codeBreaker: /^[0-9a-fA-F]{8}\s+[0-9a-fA-F]{4}$/,
  // Address:value where the value is 2, 4 or 8 hex digits (not 3 bytes).
  vba: /^[0-9a-fA-F]{8}:(?:[0-9a-fA-F]{2}|[0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/,
};

/** Removes control characters and caps length before anything is persisted. */
export function sanitiseLabel(label: string): string {
  return label
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, MAX_LABEL_LENGTH);
}

export function sanitiseCode(code: string): string {
  return code
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_CODE_LINE_LENGTH))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function splitCodeLines(code: string): string[] {
  return sanitiseCode(code)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Validates a cheat's code block for a given format.
 *
 * Every non-empty line must parse; a single bad line would otherwise be dropped
 * silently by the emulator, which is exactly the kind of quiet failure the
 * product rules forbid.
 */
export function validateCheatCode(format: CheatFormat, code: string): CheatValidationResult {
  const errors: CheatLineError[] = [];
  const notices: string[] = [];
  const rawLines = code.replace(/\r\n?/g, '\n').split('\n');

  if (rawLines.every((line) => line.trim() === '')) {
    errors.push({ line: 1, message: 'Enter at least one code line.' });
    return { ok: false, errors, notices };
  }
  if (rawLines.length > MAX_CHEAT_LINES) {
    errors.push({ line: MAX_CHEAT_LINES + 1, message: `A cheat cannot have more than ${MAX_CHEAT_LINES} lines.` });
  }
  if (!(format in PATTERNS)) {
    errors.push({ line: 1, message: `Unsupported cheat format “${format}”.` });
    return { ok: false, errors, notices };
  }

  const pattern = PATTERNS[format];

  rawLines.forEach((raw, index) => {
    const lineNumber = index + 1;
    const line = raw.trim();
    if (line === '') return;

    if (raw !== line) notices.push(`Line ${lineNumber}: whitespace was trimmed.`);
    if (/^[#!]/.test(line)) {
      errors.push({ line: lineNumber, message: 'Comments and directives are not allowed in a code block.' });
      return;
    }
    // Raw/VBA codes are shape-checked first so the most common mistake — a
    // 3-byte payload, which mGBA itself rejects — gets its own explanation.
    if (format === 'vba') {
      const raw = /^[0-9a-fA-F]{8}:(.*)$/.exec(line);
      if (raw) {
        const body = raw[1] ?? '';
        if (body.length === 6) {
          errors.push({
            line: lineNumber,
            message:
              'Raw/VBA codes accept 1, 2 or 4 byte values; a 3-byte value is not valid. Write it as two separate codes.',
          });
          return;
        }
        if ([2, 4, 8].includes(body.length) && /^[0-9a-fA-F]+$/.test(body)) return;
      }
    }

    if (pattern.test(line)) return;

    errors.push({
      line: lineNumber,
      message: `${CHEAT_FORMATS[format].label} codes look like “${CHEAT_FORMATS[format].example}”. ` +
        'Check for missing characters, stray punctuation or a code copied from a different format.',
    });
  });

  return { ok: errors.length === 0, errors, notices };
}

/** What actually gets written into the `.cheats` file. */
export function serialiseCheatFile(cheats: CheatRecord[]): string {
  const enabled = cheats.filter((cheat) => cheat.enabled);
  const blocks: string[] = [];

  for (const cheat of enabled) {
    const lines = splitCodeLines(cheat.code);
    if (lines.length === 0) continue;
    const label = sanitiseLabel(cheat.label) || 'Unnamed cheat';
    const directive = CHEAT_FORMATS[cheat.format]?.directive;
    // mGBA reads `# name` as "start a new cheat set"; `!` lines are directives
    // that must appear before the set they apply to.
    blocks.push([...(directive ? [`!${directive}`] : []), `# ${label}`, ...lines].join('\n'));
  }

  return blocks.length ? `${blocks.join('\n')}\n` : '';
}

/** True when this game has at least one enabled, non-empty cheat. */
export function hasActiveCheats(cheats: CheatRecord[]): boolean {
  return cheats.some((cheat) => cheat.enabled && splitCodeLines(cheat.code).length > 0);
}

// --- import / export -------------------------------------------------------

export const CHEAT_EXPORT_FORMAT = 'browsergba.cheats';
export const CHEAT_EXPORT_VERSION = 1;

export interface CheatExportFile {
  format: typeof CHEAT_EXPORT_FORMAT;
  version: number;
  gameId: string;
  contentHash: string;
  exportedAt: string;
  cheats: Array<{
    label: string;
    format: CheatFormat;
    code: string;
    enabled: boolean;
  }>;
}

export function exportCheatList(
  game: { id: string; contentHash: string; title: string },
  cheats: CheatRecord[],
  now: () => Date = () => new Date(),
): CheatExportFile {
  return {
    format: CHEAT_EXPORT_FORMAT,
    version: CHEAT_EXPORT_VERSION,
    gameId: game.id,
    contentHash: game.contentHash,
    exportedAt: now().toISOString(),
    cheats: cheats.map((cheat) => ({
      label: cheat.label,
      format: cheat.format,
      code: cheat.code,
      enabled: cheat.enabled,
    })),
  };
}

export interface CheatImportResult {
  cheats: Array<{ label: string; format: CheatFormat; code: string; enabled: boolean }>;
  /** Problems that did not stop the import. */
  warnings: string[];
  /** True when the export came from a different ROM than the one selected. */
  foreignGame: boolean;
}

/**
 * Parses an exported cheat list.
 *
 * Importing another game's cheat list is allowed, but it is reported so the UI
 * can ask for confirmation — codes are address-based and can corrupt the wrong
 * game's save data.
 */
export function importCheatList(
  text: string,
  target: { id: string; contentHash: string },
): CheatImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }

  const file = parsed as Partial<CheatExportFile>;
  if (!file || file.format !== CHEAT_EXPORT_FORMAT) {
    throw new Error('That file is not a BrowserGBA cheat list.');
  }
  if (typeof file.version !== 'number' || file.version > CHEAT_EXPORT_VERSION) {
    throw new Error('That cheat list was written by a newer version of BrowserGBA.');
  }
  if (!Array.isArray(file.cheats)) {
    throw new Error('That cheat list has no cheats.');
  }

  const warnings: string[] = [];
  const cheats: CheatImportResult['cheats'] = [];

  for (const [index, entry] of file.cheats.entries()) {
    const candidate = entry as Partial<CheatExportFile['cheats'][number]>;
    const format = candidate.format as CheatFormat;
    if (!format || !(format in CHEAT_FORMATS)) {
      warnings.push(`Skipped entry ${index + 1}: unknown cheat format.`);
      continue;
    }
    const code = sanitiseCode(String(candidate.code ?? ''));
    const validation = validateCheatCode(format, code);
    if (!validation.ok) {
      warnings.push(`Skipped “${sanitiseLabel(String(candidate.label ?? '')) || `entry ${index + 1}`}”: ${validation.errors[0]?.message ?? 'invalid code'}`);
      continue;
    }
    cheats.push({
      label: sanitiseLabel(String(candidate.label ?? '')) || `Imported cheat ${index + 1}`,
      format,
      code,
      enabled: Boolean(candidate.enabled),
    });
  }

  return {
    cheats,
    warnings,
    foreignGame: Boolean(file.gameId && file.gameId !== target.id),
  };
}

/** Suggested filename for an exported cheat list. */
export function cheatExportFileName(title: string): string {
  const safe = title
    .replace(/[^\w\d\-() ]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return `${safe || 'game'} cheats.json`;
}
