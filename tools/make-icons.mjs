#!/usr/bin/env node
/**
 * Generates BrowserGBA's app icons.
 *
 * The artwork is original pixel art defined below as a 16x16 grid: a generic
 * handheld silhouette with a D-pad and two buttons. Nothing here is derived from
 * Nintendo trade dress, and no third-party artwork is downloaded.
 *
 * Output is written with a tiny built-in PNG encoder (zlib + CRC32 from Node)
 * to avoid pulling a rasteriser dependency into the project.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'public', 'icons');

/** Palette: `.` is transparent, everything else is an opaque RGBA colour. */
const PALETTE = {
  '.': [0, 0, 0, 0],
  L: [0x33, 0x3f, 0x55, 255], // body highlight edge
  B: [0x1a, 0x21, 0x2e, 255], // body
  s: [0x0a, 0x0e, 0x15, 255], // screen bezel
  g: [0x8b, 0xf7, 0xbd, 255], // screen glow (top rows)
  h: [0x4e, 0xd1, 0x8f, 255], // screen glow (bottom rows)
  d: [0x46, 0x55, 0x70, 255], // d-pad
  p: [0xf2, 0xa3, 0x3c, 255], // primary button
  q: [0x38, 0xbd, 0xf8, 255], // secondary button
};

/** 16x16 source art. Every row must be exactly 16 characters. */
const ART = [
  '................',
  '.LLLLLLLLLLLLLL.',
  '.LBBBBBBBBBBBBL.',
  '.LBBssssssssBBL.',
  '.LBBsggggggsBBL.',
  '.LBBsggggggsBBL.',
  '.LBBshhhhhhsBBL.',
  '.LBBshhhhhhsBBL.',
  '.LBBssssssssBBL.',
  '.LBBBBBBBBBBBBL.',
  '.LBBdBBBBBBBqqL.',
  '.LBdddBBBppBqqL.',
  '.LBBdBBBBppBBBL.',
  '.LBBBBBBBBBBBBL.',
  '.LLLLLLLLLLLLLL.',
  '................',
];

const SIZE = 16;

function assertArt() {
  if (ART.length !== SIZE) throw new Error(`art must have ${SIZE} rows, got ${ART.length}`);
  ART.forEach((row, y) => {
    if (row.length !== SIZE) throw new Error(`row ${y} must be ${SIZE} chars, got ${row.length}`);
    for (const ch of row) {
      if (!(ch in PALETTE)) throw new Error(`row ${y} uses unknown colour '${ch}'`);
    }
  });
}

/** Nearest-neighbour upscale so pixels stay crisp at every size. */
function renderPixels(scale, padding = 0) {
  const inner = SIZE * scale;
  const size = inner + padding * 2;
  const px = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = PALETTE[ART[y][x]];
      if (a === 0) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const py = padding + y * scale + dy;
          const pxx = padding + x * scale + dx;
          const i = (py * size + pxx) * 4;
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
          px[i + 3] = a;
        }
      }
    }
  }
  return { px, size };
}

// --- minimal PNG writer -----------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(px, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type: none
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Vector version of the same art, for browsers and the manifest. */
function buildSvg() {
  const rects = [];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b, a] = PALETTE[ART[y][x]];
      if (a === 0) continue;
      rects.push(
        `<rect x="${x}" y="${y}" width="1" height="1" fill="#${[r, g, b]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('')}"/>`,
      );
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" shape-rendering="crispEdges" role="img" aria-label="BrowserGBA">
${rects.join('\n')}
</svg>
`;
}

async function main() {
  assertArt();
  await mkdir(outDir, { recursive: true });

  const targets = [
    { name: 'icon-192.png', scale: 12, padding: 0 },
    { name: 'icon-512.png', scale: 32, padding: 0 },
    // Maskable icons need a safe zone; pad so the art survives circular crops.
    { name: 'icon-maskable-512.png', scale: 24, padding: 48 },
  ];

  for (const { name, scale, padding } of targets) {
    const { px, size } = renderPixels(scale, padding);
    await writeFile(path.join(outDir, name), encodePng(px, size));
    console.log(`  ${name.padEnd(24)} ${size}x${size}`);
  }

  await writeFile(path.join(outDir, 'icon.svg'), buildSvg());
  console.log('  icon.svg                 vector');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
