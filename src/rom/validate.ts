/**
 * ROM import validation.
 *
 * The goal is to reject things that clearly are not a GBA ROM with a message the
 * user can act on, while never rejecting a legitimate ROM just because it is
 * homebrew (no Nintendo logo), trimmed, overdumped, or zero-padded. Validation
 * never mutates the file.
 */
import { HEADER_SIZE, parseGbaHeader, type GbaHeader } from './header';

/** Largest GBA cartridge image we accept: 32 MiB (the hardware address limit). */
export const MAX_ROM_BYTES = 32 * 1024 * 1024;

/** Smallest plausible cartridge image. Real carts start at 4 MiB; homebrew can be tiny. */
export const MIN_ROM_BYTES = 0xc0;

export type RomValidationCode =
  | 'ok'
  | 'empty-file'
  | 'unsupported-extension'
  | 'too-small'
  | 'too-large'
  | 'not-gba-header'
  | 'header-checksum-mismatch'
  | 'game-code-missing';

export interface RomValidationIssue {
  code: RomValidationCode;
  severity: 'error' | 'warning';
  message: string;
}

export interface RomValidationResult {
  /** True when the file may be imported. Warnings do not block import. */
  ok: boolean;
  issues: RomValidationIssue[];
  header: GbaHeader | null;
  size: number;
  fileName: string;
  /** Normalised extension including the dot, lowercased. */
  extension: string;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index <= 0 ? '' : fileName.slice(index).toLowerCase();
}

const ACCEPTED_EXTENSIONS = new Set(['.gba']);

/**
 * Validates a user-selected file for import.
 *
 * `bytes` must be the full file contents; use `validateRomFileSize` first if the
 * file is large enough that reading it is a decision of its own.
 */
export function validateRomFile(fileName: string, bytes: Uint8Array): RomValidationResult {
  const issues: RomValidationIssue[] = [];
  const extension = extensionOf(fileName);
  const size = bytes.byteLength;

  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    issues.push({
      code: 'unsupported-extension',
      severity: 'error',
      message:
        extension === ''
          ? `“${fileName}” has no file extension. This release imports Game Boy Advance ROMs (.gba) only.`
          : `“${fileName}” is a ${extension} file. This release imports Game Boy Advance ROMs (.gba) only.`,
    });
  }

  if (size === 0) {
    issues.push({ code: 'empty-file', severity: 'error', message: 'The file is empty.' });
    return { ok: false, issues, header: null, size, fileName, extension };
  }

  if (size < MIN_ROM_BYTES) {
    issues.push({
      code: 'too-small',
      severity: 'error',
      message: `The file is ${size} bytes, which is too small to contain a GBA header (${HEADER_SIZE} bytes).`,
    });
    return { ok: false, issues, header: null, size, fileName, extension };
  }

  if (size > MAX_ROM_BYTES) {
    issues.push({
      code: 'too-large',
      severity: 'error',
      message: `The file is ${(size / (1024 * 1024)).toFixed(1)} MiB. Game Boy Advance cartridges max out at 32 MiB, so this is probably not a GBA ROM.`,
    });
    return { ok: false, issues, header: null, size, fileName, extension };
  }

  let header: GbaHeader;
  try {
    header = parseGbaHeader(bytes);
  } catch {
    issues.push({
      code: 'not-gba-header',
      severity: 'error',
      message: 'The file is too small to contain a GBA cartridge header.',
    });
    return { ok: false, issues, header: null, size, fileName, extension };
  }

  // Structural signals. A file that fails *both* the entry point and the header
  // checksum is treated as "not a GBA ROM" rather than quietly imported.
  const entryPointLooksValid = header.entryPointBranchOffset !== null;
  const fixedValueLooksValid = header.fixedValue === 0x96;

  if (!entryPointLooksValid && !fixedValueLooksValid) {
    issues.push({
      code: 'not-gba-header',
      severity: 'error',
      message:
        'This does not look like a Game Boy Advance ROM: the entry point is not an ARM branch and the header is missing the required 0x96 marker.',
    });
  } else if (!entryPointLooksValid) {
    issues.push({
      code: 'not-gba-header',
      severity: 'warning',
      message: 'The ROM entry point is not an ARM branch instruction; the game may not start.',
    });
  }

  if (!header.complementCheckValid) {
    issues.push({
      code: 'header-checksum-mismatch',
      severity: entryPointLooksValid || fixedValueLooksValid ? 'warning' : 'error',
      message: `The header complement check does not match (stored 0x${(header.complementCheck ?? 0).toString(16).padStart(2, '0')}, computed 0x${(header.computedComplementCheck ?? 0).toString(16).padStart(2, '0')}). Trimmed or patched ROMs often trip this; the game may still run.`,
    });
  }

  if (!header.hasNintendoLogo) {
    // Informational only: homebrew and test ROMs legitimately omit the logo, and
    // BrowserGBA does not reproduce Nintendo's logo anywhere.
    issues.push({
      code: 'game-code-missing',
      severity: 'warning',
      message:
        'The Nintendo logo area is blank. This is normal for homebrew and ROM-test builds; commercial dumps include it.',
    });
  }

  const ok = !issues.some((issue) => issue.severity === 'error');
  return { ok, issues, header, size, fileName, extension };
}

/**
 * Cheap pre-check run before reading a file into memory, so a user who picks a
 * 400 MB file gets an immediate answer instead of a browser hang.
 */
export function validateRomFileMetadata(fileName: string, size: number): RomValidationIssue[] {
  const issues: RomValidationIssue[] = [];
  const extension = extensionOf(fileName);
  if (!ACCEPTED_EXTENSIONS.has(extension)) {
    issues.push({
      code: 'unsupported-extension',
      severity: 'error',
      message: `“${fileName}” is not a .gba file.`,
    });
  }
  if (size > MAX_ROM_BYTES) {
    issues.push({
      code: 'too-large',
      severity: 'error',
      message: `“${fileName}” is ${(size / (1024 * 1024)).toFixed(1)} MiB, larger than the 32 MiB GBA address space.`,
    });
  }
  if (size === 0) {
    issues.push({ code: 'empty-file', severity: 'error', message: `“${fileName}” is empty.` });
  }
  return issues;
}

/** A title we are willing to show in the UI when the header has none. */
export function displayTitleFor(header: GbaHeader | null, fileName: string): string {
  const headerTitle = header?.title.trim();
  if (headerTitle) return headerTitle;
  const base = fileName.replace(/\.[^.]+$/, '');
  return base.trim() || 'Untitled ROM';
}
