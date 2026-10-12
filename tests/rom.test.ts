import { describe, it, expect } from 'vitest';
import { computeComplementCheck, parseGbaHeader, RomTooSmallError } from '@/rom/header';
import { validateRomFile, validateRomFileMetadata, displayTitleFor, MAX_ROM_BYTES } from '@/rom/validate';
import { sha256Hex, deriveGameId, hasWebCryptoDigest } from '@/rom/hash';
import { makeRom, withPayload } from './helpers/rom-fixtures';
// @ts-expect-error - the fixture generator is plain JavaScript tooling
import { buildRom } from '../tools/make-test-rom.mjs';

describe('sha256', () => {
  it('matches the published test vectors used by Web Crypto and the fallback', async () => {
    const vectors: Array<[string, string]> = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      ],
    ];
    for (const [input, expected] of vectors) {
      expect(await sha256Hex(new TextEncoder().encode(input))).toBe(expected);
    }
  });

  it('reports whether the native digest is available in this environment', () => {
    expect(typeof hasWebCryptoDigest()).toBe('boolean');
  });

  it('derives a stable game id from the content hash', () => {
    const hash = 'a'.repeat(64);
    expect(deriveGameId(hash)).toBe(deriveGameId(hash));
    expect(deriveGameId(hash)).toMatch(/^g_[0-9a-f]{32}$/);
    expect(deriveGameId(hash)).not.toBe(deriveGameId('b'.repeat(64)));
  });

  it('produces the same id for identical content regardless of filename', async () => {
    const bytes = makeRom({ title: 'SAMECONTENT' });
    const a = deriveGameId(await sha256Hex(bytes));
    const b = deriveGameId(await sha256Hex(new Uint8Array(bytes)));
    expect(a).toBe(b);
  });
});

describe('GBA header parsing', () => {
  it('reads title, codes and sizes from a synthetic ROM', () => {
    const header = parseGbaHeader(makeRom({ title: 'POKEMON EM', gameCode: 'BPEE', makerCode: '01' }));
    expect(header.title).toBe('POKEMON EM');
    expect(header.gameCode).toBe('BPEE');
    expect(header.makerCode).toBe('01');
    expect(header.fixedValue).toBe(0x96);
    expect(header.complementCheckValid).toBe(true);
    expect(header.hasNintendoLogo).toBe(false);
  });

  it('decodes the ARM entry point branch', () => {
    const header = parseGbaHeader(makeRom());
    // The fixture branch `B +0xb8` at 0x00 jumps to 0xC0.
    expect(header.entryPointBranchOffset).toBe(0xc0);
  });

  it('flags an invalid entry point and an invalid checksum', () => {
    const broken = parseGbaHeader(makeRom({ validEntryPoint: false, corruptChecksum: true }));
    expect(broken.entryPointBranchOffset).toBeNull();
    expect(broken.complementCheckValid).toBe(false);
  });

  it('detects a present logo region (header offset 0x04..0x9F)', () => {
    expect(parseGbaHeader(makeRom({ withLogo: true })).hasNintendoLogo).toBe(true);
    expect(parseGbaHeader(makeRom({ withLogo: false })).hasNintendoLogo).toBe(false);
  });

  it('refuses files shorter than the header', () => {
    expect(() => parseGbaHeader(new Uint8Array(16))).toThrow(RomTooSmallError);
  });

  it('sanitises control characters in the title', () => {
    const rom = makeRom({ title: 'AB' });
    rom[0xa2] = 0x07; // bell
    const header = parseGbaHeader(rom);
    expect(header.title).not.toContain('\u0007');
    expect(header.title).toBe('AB?');
  });

  it('agrees with the generated emulator fixture ROM', () => {
    const rom: Uint8Array = buildRom();
    const header = parseGbaHeader(rom);
    expect(header.title).toBe('BGTESTROM');
    expect(header.gameCode).toBe('BGT1');
    expect(header.makerCode).toBe('01');
    expect(header.fixedValue).toBe(0x96);
    expect(header.complementCheckValid).toBe(true);
    expect(header.entryPointBranchOffset).toBe(0xc0);
    // The fixture deliberately omits the Nintendo logo.
    expect(header.hasNintendoLogo).toBe(false);
  });

  it('implements the GBATEK complement check algorithm', () => {
    const rom = makeRom({ title: 'CHECKSUM' });
    let expected = 0;
    for (let i = 0xa0; i <= 0xbc; i++) expected = (expected - (rom[i] ?? 0)) & 0xff;
    expected = (expected - 0x19) & 0xff;
    expect(computeComplementCheck(rom)).toBe(expected);
    expect(rom[0xbd]).toBe(expected);
  });
});

describe('ROM validation', () => {
  it('accepts a well-formed .gba file', () => {
    const result = validateRomFile('game.gba', withPayload(makeRom()));
    expect(result.ok).toBe(true);
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('accepts the generated fixture ROM', () => {
    const result = validateRomFile('test-rom.gba', buildRom());
    expect(result.ok).toBe(true);
  });

  it('rejects non-.gba extensions with an explanatory message', () => {
    const result = validateRomFile('game.zip', makeRom());
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe('unsupported-extension');
    expect(result.issues[0]?.message).toContain('.gba');
  });

  it('rejects files with no extension', () => {
    const result = validateRomFile('game', makeRom());
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.message).toContain('no file extension');
  });

  it('rejects empty files', () => {
    const result = validateRomFile('empty.gba', new Uint8Array(0));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('empty-file');
  });

  it('rejects files that are too small to hold a header', () => {
    const result = validateRomFile('tiny.gba', new Uint8Array(64));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('too-small');
  });

  it('rejects files larger than the GBA address space', () => {
    const result = validateRomFile('huge.gba', new Uint8Array(MAX_ROM_BYTES + 1));
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain('too-large');
  });

  it('rejects data that is not a GBA ROM', () => {
    const notARom = new Uint8Array(0x1000).fill(0x41);
    const result = validateRomFile('nope.gba', notARom);
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'not-gba-header' && i.severity === 'error')).toBe(true);
  });

  it('warns but still imports when the complement check is wrong', () => {
    const result = validateRomFile('patched.gba', withPayload(makeRom({ corruptChecksum: true })));
    expect(result.ok).toBe(true);
    const issue = result.issues.find((i) => i.code === 'header-checksum-mismatch');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('may still run');
  });

  it('warns about a missing Nintendo logo without blocking import', () => {
    const result = validateRomFile('homebrew.gba', withPayload(makeRom({ withLogo: false })));
    expect(result.ok).toBe(true);
    expect(result.issues.some((i) => i.message.includes('homebrew'))).toBe(true);
  });

  it('does not warn about the logo when one is present', () => {
    const result = validateRomFile('retail.gba', withPayload(makeRom({ withLogo: true })));
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects a file whose entry point and 0x96 marker are both missing', () => {
    const result = validateRomFile('broken.gba', makeRom({ validEntryPoint: false, fixedValue: 0x00 }));
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'not-gba-header')).toBe(true);
  });

  it('never mutates the input buffer', () => {
    const rom = withPayload(makeRom({ corruptChecksum: true }));
    const before = Uint8Array.from(rom);
    validateRomFile('x.gba', rom);
    expect(Array.from(rom)).toEqual(Array.from(before));
  });
});

describe('ROM metadata pre-check', () => {
  it('stops oversized files before they are read into memory', () => {
    const issues = validateRomFileMetadata('huge.gba', MAX_ROM_BYTES + 1);
    expect(issues.map((i) => i.code)).toContain('too-large');
  });

  it('passes a plausible file', () => {
    expect(validateRomFileMetadata('game.gba', 8 * 1024 * 1024)).toHaveLength(0);
  });
});

describe('display title', () => {
  it('prefers the header title', () => {
    expect(displayTitleFor(parseGbaHeader(makeRom({ title: 'HEADERNAME' })), 'file.gba')).toBe('HEADERNAME');
  });

  it('falls back to the filename without its extension', () => {
    expect(displayTitleFor(null, 'My Hack.gba')).toBe('My Hack');
  });

  it('never returns an empty title', () => {
    expect(displayTitleFor(null, '.gba')).toBe('Untitled ROM');
  });
});
