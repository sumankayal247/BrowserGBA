/**
 * Synthetic ROM builders for unit tests.
 *
 * These produce structurally valid (but intentionally inert) cartridge images so
 * header/validation behaviour can be tested without any copyrighted data.
 */
import { computeComplementCheck } from '@/rom/header';

export interface FixtureRomOptions {
  title?: string;
  gameCode?: string;
  makerCode?: string;
  size?: number;
  /** Include a non-zero fill where the Nintendo logo lives. */
  withLogo?: boolean;
  /** Overwrite the stored complement check with a wrong value. */
  corruptChecksum?: boolean;
  /** Overwrite the 0x96 fixed-value marker. */
  fixedValue?: number;
  /** Skip the ARM branch at the entry point. */
  validEntryPoint?: boolean;
}

const ENTRY_BRANCH = 0xea00002e;

export function makeRom(options: FixtureRomOptions = {}): Uint8Array {
  const {
    title = 'TESTGAME',
    gameCode = 'TEST',
    makerCode = '01',
    size = 0x8000,
    withLogo = false,
    corruptChecksum = false,
    fixedValue = 0x96,
    validEntryPoint = true,
  } = options;

  const rom = new Uint8Array(size);
  const view = new DataView(rom.buffer);

  if (validEntryPoint) view.setUint32(0, ENTRY_BRANCH, true);

  if (withLogo) {
    // A recognisable, deliberately non-Nintendo pattern.
    for (let i = 4; i < 0xa0; i++) rom[i] = (i * 7) & 0xff;
  }

  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) rom[offset + i] = text.charCodeAt(i);
  };

  write(0xa0, title.slice(0, 12));
  write(0xac, gameCode.slice(0, 4));
  write(0xb0, makerCode.slice(0, 2));
  rom[0xb2] = fixedValue;
  rom[0xb3] = 0x00;
  rom[0xb4] = 0x00;
  rom[0xbc] = 0x00;
  rom[0xbd] = corruptChecksum ? (computeComplementCheck(rom) + 1) & 0xff : computeComplementCheck(rom);

  return rom;
}

/** Fills the body of a ROM with a deterministic, non-zero payload. */
export function withPayload(rom: Uint8Array, offset = 0xc0): Uint8Array {
  for (let i = offset; i < rom.length; i++) rom[i] = (i * 31 + 7) & 0xff;
  return rom;
}
