#!/usr/bin/env node
/**
 * Builds `fixtures/test-rom.gba`, a tiny, fully original Game Boy Advance
 * program used by the automated smoke tests.
 *
 * Why hand-assemble instead of downloading a homebrew ROM?  Licensing.  This
 * file contains no third-party code, no Nintendo logo, and no copyrighted data:
 * it is MIT licensed along with the rest of BrowserGBA.  That lets us exercise
 * the *real* emulator core in CI without shipping or fetching someone else's
 * cartridge image.
 *
 * The ROM deliberately makes every behaviour the smoke test cares about
 * observable through the framebuffer:
 *
 *  1. On boot it fills mode 3 VRAM with a fixed ramp where
 *     `pixel(i) == i & 0xFFFF`, so a screenshot can be verified pixel by pixel
 *     (this proves the core actually renders, not just that it loads).
 *  2. Each VBlank it writes `((frameCounter & 31) << 10)` to pixel (0,0), so the
 *     framebuffer advances deterministically, frame by frame.  That gives the
 *     save-state and rewind tests something real to compare.
 *  3. While the A button is held it writes `0x001F` (red) to pixel (239,159),
 *     so input handling is verifiable from a screenshot.
 *  4. It uses cartridge save memory once: 0xA5 is written to SRAM[0] at boot and
 *     copied into the green channel of pixel (238,0) every frame. Saving once (not
 *     every frame) is what lets the core settle and flush a .sav file, so this one
 *     probe covers both "the cartridge accepted the write" and "the host can export
 *     the save".
 *
 * Header fields follow GBATEK: the complement check at 0xBD is computed over
 * 0xA0..0xBC, and 0xBE..0xBF is reserved (zero).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'fixtures', 'test-rom.gba');

const ROM_BASE = 0x08000000;
const VRAM = 0x06000000;
const IO = 0x04000000;
const SRAM = 0x0e000000;
const ROM_SIZE = 0x8000; // 32 KiB — a realistic minimum cartridge size

// --- ARM (ARMv4T) instruction encoders -------------------------------------

const CONDITIONS = {
  EQ: 0x0, NE: 0x1, CS: 0x2, CC: 0x3, MI: 0x4, PL: 0x5, VS: 0x6, VC: 0x7,
  HI: 0x8, LS: 0x9, GE: 0xa, LT: 0xb, GT: 0xc, LE: 0xd, AL: 0xe,
};

/**
 * Finds an encoding for an ARM data-processing immediate, or null.
 *
 * The operand is `imm8 ROR (2 * rot)`, so the 8-bit field is `ROL(value, 2*rot)`.
 */
function tryImm(rawValue) {
  const value = rawValue >>> 0;
  for (let rot = 0; rot < 16; rot++) {
    const k = rot * 2;
    const rol = k === 0 ? value : ((value << k) | (value >>> (32 - k))) >>> 0;
    if (rol <= 0xff) return { imm8: rol, rot };
  }
  return null;
}

/**
 * A very small, purpose-built assembler.  Only the handful of ARM instructions
 * this fixture needs are implemented; anything unsupported throws rather than
 * silently emitting a wrong encoding.
 */
class ArmEmitter {
  constructor(origin) {
    this.origin = origin;
    this.words = [];
    this.labels = new Map();
    this.fixups = []; // { index, kind, label }
    this.pool = []; // { index, value }
  }

  get pc() {
    return this.origin + this.words.length * 4;
  }

  label(name) {
    if (this.labels.has(name)) throw new Error(`duplicate label ${name}`);
    this.labels.set(name, this.pc);
  }

  emit(word) {
    this.words.push(word >>> 0);
    return this.words.length - 1;
  }

  /** `B label` / `B<cond> label` */
  branch(label, cond = 'AL') {
    const index = this.emit((CONDITIONS[cond] << 28) | 0x0a000000);
    this.fixups.push({ index, kind: 'branch', label });
  }

  /** `LDR Rd, =value` — materialises a constant via MOV or the literal pool. */
  loadConst(rd, value) {
    const imm = tryImm(value);
    if (imm) {
      this.emit(0xe3a00000 | (rd << 12) | (imm.rot << 8) | imm.imm8);
      return;
    }
    const index = this.emit(0xe59f0000 | (rd << 12)); // LDR Rd, [pc, #imm12]
    this.pool.push({ index, value });
  }

  /** `MOV Rd, Rm, LSL #shift` */
  movShifted(rd, rm, shift) {
    this.emit(0xe1a00000 | (rd << 12) | (shift << 7) | rm);
  }

  /** Data-processing with an immediate operand. */
  imm(opcode, rd, rn, value, { setFlags = false, cond = 'AL' } = {}) {
    const imm = tryImm(value);
    if (!imm) throw new Error(`0x${value.toString(16)} is not encodable as an ARM immediate`);
    this.emit(
      (CONDITIONS[cond] << 28) |
        0x02000000 |
        (opcode << 21) |
        (setFlags ? 1 << 20 : 0) |
        (rn << 16) |
        (rd << 12) |
        (imm.rot << 8) |
        imm.imm8,
    );
  }

  mov(rd, value, opts) {
    this.imm(0xd, rd, 0, value, opts);
  }
  cmp(rn, value, opts) {
    this.imm(0xa, 0, rn, value, { ...opts, setFlags: true });
  }
  tst(rn, value, opts) {
    this.imm(0x8, 0, rn, value, { ...opts, setFlags: true });
  }
  and(rd, rn, value, opts) {
    this.imm(0x0, rd, rn, value, opts);
  }
  add(rd, rn, value, opts) {
    this.imm(0x4, rd, rn, value, opts);
  }
  sub(rd, rn, value, opts) {
    this.imm(0x2, rd, rn, value, opts);
  }

  /**
   * `LDR|STR` with optional pre/post indexing and byte/halfword/word width.
   *
   * Post-indexed forms are supported for both word and halfword transfers; the
   * emitter throws rather than silently producing the wrong addressing mode.
   */
  mem(
    op,
    rd,
    rn,
    offset,
    { byte = false, half = false, add = true, writeback = false, post = false } = {},
  ) {
    const P = post ? 0 : 1;
    const W = post ? 0 : writeback ? 1 : 0;
    const U = add ? 1 : 0;
    const L = op === 'ldr' ? 1 : 0;

    if (half) {
      if (offset > 0xff) throw new Error('halfword offset too large');
      const imm4H = (offset >> 4) & 0xf;
      const imm4L = offset & 0xf;
      this.emit(
        0xe0000000 |
          (P << 24) |
          (U << 23) |
          (1 << 22) |
          (W << 21) |
          (L << 20) |
          (rn << 16) |
          (rd << 12) |
          (imm4H << 8) |
          0xb0 |
          imm4L,
      );
      return;
    }

    if (byte && offset > 0xfff) throw new Error('byte offset too large');
    if (!byte && offset > 0xfff) throw new Error('word offset too large (use a register base)');
    this.emit(
      0xe4000000 |
        (P << 24) |
        (U << 23) |
        (byte ? 1 << 22 : 0) |
        (W << 21) |
        (L << 20) |
        (rn << 16) |
        (rd << 12) |
        offset,
    );
  }

  /** Resolves branches and patches the literal pool. Must be called last. */
  finish() {
    for (const { index, kind, label } of this.fixups) {
      const target = this.labels.get(label);
      if (target === undefined) throw new Error(`undefined label ${label}`);
      const at = this.origin + index * 4;
      const delta = target - (at + 8);
      if (delta % 4 !== 0) throw new Error(`unaligned branch to ${label}`);
      this.words[index] = (this.words[index] | ((delta >> 2) & 0xffffff)) >>> 0;
    }

    // Literal pool lives immediately after the code; every entry is reachable
    // because the generated code never falls through into it.
    const poolBase = this.origin + this.words.length * 4;
    const words = [...this.words];
    this.pool.forEach((entry, i) => {
      const at = this.origin + entry.index * 4;
      const literalAddress = poolBase + i * 4;
      const delta = literalAddress - (at + 8);
      if (delta < 0 || delta > 0xfff) throw new Error('literal pool out of range');
      words[entry.index] = (0xe59f0000 | (words[entry.index] & 0x0000f000) | delta) >>> 0;
      words.push(entry.value >>> 0);
    });

    return words;
  }
}

// --- the fixture program ----------------------------------------------------

function buildCode() {
  const asm = new ArmEmitter(ROM_BASE + 0xc0);

  asm.label('start');
  asm.loadConst(0, VRAM); // r0  → framebuffer base
  asm.loadConst(1, IO); //   r1  → I/O registers
  asm.loadConst(7, VRAM + (159 * 240 + 239) * 2); // r7 → pixel (239,159)
  asm.loadConst(8, SRAM); // r8  → cartridge SRAM
  asm.loadConst(6, IO + 0x130); // r6 → KEYINPUT (offset exceeds the 8-bit field)
  asm.loadConst(12, 0xa5); // r12 → save-memory marker, written to SRAM[0] once
  asm.mem('str', 12, 8, 0, { byte: true });
  asm.loadConst(2, 0x0403); // r2  → mode 3, BG2 enabled
  asm.mem('str', 2, 1, 0);
  asm.loadConst(2, VRAM + 238 * 2); // r2 → probe pixel (238,0), reused after DISPCNT

  // Paint a deterministic ramp across all 240x160 pixels: pixel(i) = i.
  asm.loadConst(4, 0); //     r4 = colour counter
  asm.loadConst(3, 240 * 160, {}); // r3 = remaining pixel count
  asm.label('fill');
  asm.mem('str', 4, 0, 2, { half: true, post: true });
  asm.add(4, 4, 1);
  asm.sub(3, 3, 1, { setFlags: true });
  asm.branch('fill', 'NE');

  // r0 must point at VRAM again for the per-frame single-pixel writes.
  asm.loadConst(0, VRAM);
  asm.loadConst(9, 0); // r9 = frame counter

  asm.label('frame');
  // Wait for the start of VBlank (VCOUNT >= 160).
  asm.label('waitVblank');
  asm.mem('ldr', 5, 1, 6, { half: true });
  asm.cmp(5, 160);
  asm.branch('waitVblank', 'LT');

  // Advance the frame counter and animate pixel (0,0): blue ramp, 32 steps.
  asm.add(9, 9, 1);
  asm.and(10, 9, 0x1f);
  asm.movShifted(10, 10, 10); // (counter & 31) << 10
  // Halfword store: a word store here would clobber the neighbouring pixel.
  asm.mem('str', 10, 0, 0, { half: true });

  // Input probe: paint pixel (239,159) red while A is held.
  asm.mem('ldr', 5, 6, 0, { half: true }); // KEYINPUT
  asm.tst(5, 1); // A == bit 0, active low
  asm.mov(11, 0, { cond: 'NE' });
  asm.mov(11, 0x1f, { cond: 'EQ' });
  asm.mem('str', 11, 7, 0, { half: true });

  // Cartridge save memory. 0xA5 was written once at boot, deliberately *not*
  // every frame: the core flushes a save file only after the save data settles
  // (a few frames without further writes — see GBASavedataClean in mGBA's
  // savedata.c), so a ROM that wrote every frame would never produce a file and
  // would make every battery-save test fail for the wrong reason. Reading does not
  // dirty anything, so this read-back is free.
  //
  // The value is painted into the green channel of pixel (238,0) — the only way a
  // test can observe cartridge memory from outside — which separates "the
  // cartridge accepted the write" from "the host's save file is stale".
  asm.mem('ldr', 12, 8, 0, { byte: true });
  asm.movShifted(12, 12, 5); // green channel of a 15-bit colour word
  asm.mem('str', 12, 2, 0, { half: true });

  // Spin until VBlank ends, then start the next frame.
  asm.label('waitVisible');
  asm.mem('ldr', 5, 1, 6, { half: true });
  asm.cmp(5, 160);
  asm.branch('waitVisible', 'GE');
  asm.branch('frame');

  return asm.finish();
}

function buildHeader(codeStartOffset, options = {}) {
  const header = Buffer.alloc(0xc0, 0);
  // 0x00: entry point — `B start`
  const delta = codeStartOffset - 8;
  header.writeUInt32LE((0xea000000 | ((delta >> 2) & 0xffffff)) >>> 0, 0);
  // 0x04..0x9F: the Nintendo logo is intentionally left zero. We do not ship or
  // reproduce it; mGBA's HLE BIOS does not require it.
  // Title and codes are parameters so tests can build a second, distinguishable
  // cartridge without another copy of the emulator logic.
  const title = (options.title ?? 'BGTESTROM').padEnd(12, '\0').slice(0, 12);
  const gameCode = (options.gameCode ?? 'BGT1').padEnd(4, '\0').slice(0, 4);
  const makerCode = (options.makerCode ?? '01').padEnd(2, '\0').slice(0, 2);
  header.write(title, 0xa0, 'ascii'); //   0x0A0 game title (12 bytes)
  header.write(gameCode, 0xac, 'ascii'); // 0x0AC game code
  header.write(makerCode, 0xb0, 'ascii'); // 0x0B0 maker code
  header.writeUInt8(0x96, 0xb2); //                 0x0B2 fixed value
  header.writeUInt8(0x00, 0xb3); //                 0x0B3 main unit code
  header.writeUInt8(0x00, 0xb4); //                 0x0B4 device type
  header.writeUInt8(0x00, 0xbc); //                 0x0BC software version

  // 0x0BD complement check: chk = 0; for i = 0xA0..0xBC: chk -= rom[i]
  //                      chk = (chk - 0x19) & 0xFF
  let chk = 0;
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - header[i]) & 0xff;
  header.writeUInt8((chk - 0x19) & 0xff, 0xbd);
  // 0x0BE..0x0BF is reserved and stays zero.
  return header;
}

export function buildRom(options = {}) {
  const header = buildHeader(0xc0, options);
  const code = buildCode();
  const codeBytes = Buffer.alloc(code.length * 4);
  code.forEach((word, i) => codeBytes.writeUInt32LE(word, i * 4));

  const rom = Buffer.alloc(ROM_SIZE, 0);
  header.copy(rom, 0);
  codeBytes.copy(rom, 0xc0);
  return rom;
}

async function main() {
  const rom = buildRom();
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, rom);

  const title = rom.subarray(0xa0, 0xac).toString('ascii').replace(/\0+$/, '');
  console.log(`Wrote ${path.relative(root, outFile)} (${rom.length} bytes)`);
  console.log(`  title            ${title}`);
  console.log(`  entry point      0x${rom.readUInt32LE(0).toString(16).padStart(8, '0')}`);
  console.log(`  complement chk   0x${rom[0xbd].toString(16).padStart(2, '0')}`);
}

// Only run when invoked directly, so tests can import `buildRom` without
// writing files as a side effect.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
