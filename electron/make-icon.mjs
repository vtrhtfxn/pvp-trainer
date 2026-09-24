// Generates electron/icon.icns: a pixel-art diamond sword on a dark slate tile.
// Pure Node — the PNG encoder is here so the build needs no image dependencies.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} w @param {number} h @param {Uint8Array} rgba */
function encodePng(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- the sword sprite

const PALETTE = {
  D: [0x8c, 0xf7, 0xe8, 255], // diamond highlight
  d: [0x4a, 0xed, 0xd9, 255], // diamond
  c: [0x2e, 0xb8, 0xa8, 255], // diamond shade
  g: [0xb0, 0xb0, 0xb0, 255], // guard
  h: [0x8b, 0x5a, 0x2b, 255], // handle
  H: [0x5b, 0x3a, 0x1b, 255], // handle shade
  o: [0x1a, 0x14, 0x10, 255], // outline
};

/** 16×16 sword, built from a blade diagonal + guard + handle, then outlined like an MC item. */
function swordSprite() {
  const S = 16;
  const px = Array.from({ length: S }, () => new Array(S).fill('.'));
  const set = (x, y, ch) => {
    if (x >= 0 && x < S && y >= 0 && y < S) px[y][x] = ch;
  };

  // Blade: a 2-wide diagonal band from the guard up to the tip.
  for (let i = 0; i < 10; i++) {
    const x = 4 + i;
    const y = 11 - i;
    set(x, y, i === 9 ? 'D' : 'd');
    set(x + 1, y, i >= 8 ? 'D' : 'd');
    set(x, y - 1, i >= 8 ? 'D' : 'd');
    set(x + 1, y + 1, 'c'); // shaded lower edge
  }
  set(14, 1, 'D');
  set(13, 1, 'D');
  set(14, 2, 'd');

  // Crossguard: perpendicular to the blade, through the base.
  for (let i = -2; i <= 2; i++) set(4 + i, 11 + i, 'g');
  set(2, 9, 'g');
  set(6, 13, 'g');

  // Handle: continues the diagonal down-left from the guard.
  for (let i = 0; i < 3; i++) {
    set(3 - i, 12 + i, 'h');
    set(2 - i, 12 + i, 'H');
  }

  // Dark outline around every filled pixel, like a vanilla item texture.
  const outlined = px.map((row) => row.slice());
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      if (px[y][x] !== '.') continue;
      const touches = [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ].some(([dx, dy]) => px[y + dy]?.[x + dx] && px[y + dy][x + dx] !== '.');
      if (touches) outlined[y][x] = 'o';
    }
  return outlined;
}

// ---------------------------------------------------------------- icon composition

const SPRITE = swordSprite();

function renderIcon(size) {
  const img = new Uint8Array(size * size * 4);
  const r = Math.round(size * 0.2237); // macOS-ish corner radius
  const inside = (x, y) => {
    const cx = Math.min(Math.max(x, r), size - 1 - r);
    const cy = Math.min(Math.max(y, r), size - 1 - r);
    return Math.hypot(x - cx, y - cy) <= r;
  };

  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!inside(x, y)) continue;
      const t = y / size;
      img[i] = Math.round(0x2a - t * 0x14);
      img[i + 1] = Math.round(0x2e - t * 0x16);
      img[i + 2] = Math.round(0x36 - t * 0x1a);
      img[i + 3] = 255;
    }

  // Pixel-art sword, nearest-neighbour, centred at ~74% of the tile.
  const scale = Math.max(1, Math.floor((size * 0.74) / 16));
  const off = Math.round((size - scale * 16) / 2);
  for (let sy = 0; sy < 16; sy++)
    for (let sx = 0; sx < 16; sx++) {
      const col = PALETTE[SPRITE[sy][sx]];
      if (!col) continue;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const x = off + sx * scale + dx;
          const y = off + sy * scale + dy;
          if (x < 0 || y < 0 || x >= size || y >= size || !inside(x, y)) continue;
          const i = (y * size + x) * 4;
          img[i] = col[0];
          img[i + 1] = col[1];
          img[i + 2] = col[2];
          img[i + 3] = 255;
        }
    }
  return encodePng(size, size, img);
}

const iconset = path.join(HERE, 'icon.iconset');
fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });
for (const base of [16, 32, 128, 256, 512]) {
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}.png`), renderIcon(base));
  fs.writeFileSync(path.join(iconset, `icon_${base}x${base}@2x.png`), renderIcon(base * 2));
}

const icns = path.join(HERE, 'icon.icns');
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icns]);
fs.rmSync(iconset, { recursive: true, force: true });
console.log(`icon → ${path.relative(process.cwd(), icns)} (${fs.statSync(icns).size} bytes)`);
