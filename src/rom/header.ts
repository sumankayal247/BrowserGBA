/**
 * Game Boy Advance cartridge header parsing.
 *
 * Layout per GBATEK (https://mgba-emu.github.io/gbatek/): the first 192 bytes of
 * a ROM at 0x08000000 are the cartridge header, and the complement check at
 * 0xBD is computed over 0xA0..0xBC.
 *
 * We only read; nothing here writes to or "fixes" a user's ROM.
 */

export const HEADER_SIZE = 0xc0;

export interface GbaHeader {
  /** Game title, 0xA0..0xAB, space/NUL padded. */
  title: string;
  /** Raw 12-byte title field (may contain padding). */
  titleRaw: string;
  /** 4-character game code, 0xAC..0xAF. */
  gameCode: string;
  /** 2-character maker code, 0xB0..0xB1. */
  makerCode: string;
  /** Fixed value at 0xB2 — must be 0x96 on real cartridges. */
  fixedValue: number;
  /** Bit 7 marks DACS/debug hardware. */
  deviceType: number;
  /** Software version at 0xBC. */
  softwareVersion: number;
  /** Complement check stored at 0xBD, if present. */
  complementCheck: number | null;
  /** Complement check recomputed from the header bytes. */
  computedComplementCheck: number | null;
  /** True when the stored and computed complement checks agree. */
  complementCheckValid: boolean;
  /** ARM branch instruction at 0x00, decoded into a relative offset in bytes. */
  entryPointBranchOffset: number | null;
  /** True when the Nintendo logo region is not all zero. */
  hasNintendoLogo: boolean;
  /** True when the release date / debug fields look like a retail build. */
  looksCommercial: boolean;
}

const GAME_TITLE_LENGTH = 12;
const GAME_CODE_LENGTH = 4;
const MAKER_CODE_LENGTH = 2;

/** True for the ASCII subset that GBA titles and codes legitimately use. */
function isPrintableHeaderChar(code: number): boolean {
  return code >= 0x20 && code <= 0x7e;
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i] ?? 0);
  }
  return out;
}

/** Shows control characters as `?` so a malformed header cannot inject text. */
function toSafeDisplayString(raw: string): string {
  let value = '';
  for (const char of raw) {
    const code = char.charCodeAt(0);
    // The field is NUL-padded; spaces inside a title are meaningful
    // (e.g. "POKEMON EMER"), so only NUL terminates it.
    if (code === 0) break;
    value += isPrintableHeaderChar(code) ? char : '?';
  }
  return value.trim();
}

/**
 * GBATEK complement check:
 * `chk = 0; for i = 0xA0..0xBC: chk -= rom[i]; chk = (chk - 0x19) & 0xFF`
 */
export function computeComplementCheck(bytes: Uint8Array): number {
  let check = 0;
  for (let i = 0xa0; i <= 0xbc; i++) {
    check = (check - (bytes[i] ?? 0)) & 0xff;
  }
  return (check - 0x19) & 0xff;
}

export class RomTooSmallError extends Error {
  constructor(readonly size: number) {
    super(`File is ${size} bytes; a GBA ROM header alone needs ${HEADER_SIZE}.`);
    this.name = 'RomTooSmallError';
  }
}

export function parseGbaHeader(bytes: Uint8Array): GbaHeader {
  if (bytes.length < HEADER_SIZE) throw new RomTooSmallError(bytes.length);

  const titleRaw = readAscii(bytes, 0xa0, GAME_TITLE_LENGTH);
  const codeRaw = readAscii(bytes, 0xac, GAME_CODE_LENGTH);
  const makerRaw = readAscii(bytes, 0xb0, MAKER_CODE_LENGTH);
  const complementCheck = bytes[0xbd] ?? null;
  const computedComplementCheck = computeComplementCheck(bytes);

  // Decode `B <offset>` at 0x00: cond bits must be AL (0xE), opcode bits 27..25
  // must be 0b101 (branch).
  const entry = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 24);
  // Condition is the top nibble (bits 31..28); the branch opcode is bits 27..25.
  const isBranch = ((entry >>> 28) & 0x0f) === 0x0e && ((entry >>> 25) & 0x07) === 0x05;
  let entryPointBranchOffset: number | null = null;
  if (isBranch) {
    let offset = entry & 0x00ffffff;
    if (offset & 0x00800000) offset -= 0x01000000; // sign-extend the 24-bit field
    entryPointBranchOffset = offset * 4 + 8;
  }

  let logoBytes = 0;
  for (let i = 4; i < 0xa0; i++) {
    if (bytes[i] !== 0) logoBytes++;
  }

  const deviceType = bytes[0xb4] ?? 0;

  return {
    title: toSafeDisplayString(titleRaw),
    titleRaw,
    gameCode: toSafeDisplayString(codeRaw),
    makerCode: toSafeDisplayString(makerRaw),
    fixedValue: bytes[0xb2] ?? 0,
    deviceType,
    softwareVersion: bytes[0xbc] ?? 0,
    complementCheck,
    computedComplementCheck,
    complementCheckValid: complementCheck === computedComplementCheck,
    entryPointBranchOffset,
    hasNintendoLogo: logoBytes > 0,
    // A DACS/debug bit plus a valid entry point is a reasonable proxy for a
    // retail cartridge versus homebrew; it is advisory only.
    looksCommercial: logoBytes > 0 && (deviceType & 0x80) === 0,
  };
}
