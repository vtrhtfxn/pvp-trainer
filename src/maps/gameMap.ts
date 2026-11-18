import { B, isFluid, type Blocks } from '../game/Blocks';
import { mapCell } from './blocks';
import type { Voxels } from './formats';

/**
 * A map in this game's own compact form: the box of cells (run-length coded), where it sits in
 * the world, its spawns and the spots that matter to its mode. Shipped maps are stored like this
 * (src/assets/maps), and so are maps you import.
 */
export interface GameMap {
  v: 1;
  id: string;
  name: string;
  authors: string[];
  /** Where it comes from, and its licence (shown with the map). */
  credit: string;
  license: string;
  w: number;
  h: number;
  l: number;
  /** World position of the box's lowest corner. */
  ox: number;
  oy: number;
  oz: number;
  /** Cells by palette index: block id, data, block id, data… */
  palette: number[];
  /** Base64 of (run length, palette index) varint pairs, in x + z·w + y·w·l order. */
  cells: string;
  /** Where players start (feet), facing the middle. */
  spawns: [number, number, number][];
  /** Spots to stand on (inclusive boxes x0,y0,z0,x1,y1,z1), e.g. Item Sumo's centre. */
  points: [number, number, number, number, number, number][];
  /** Falling below this kills. */
  voidY: number;
  maxPlayers: number;
}

// ------------------------------------------------------------------ base64 + varints

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64[n & 63] : '=');
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (B64.indexOf(clean[i]) << 18) | (B64.indexOf(clean[i + 1]) << 12) | ((B64.indexOf(clean[i + 2] ?? 'A') & 63) << 6) | (B64.indexOf(clean[i + 3] ?? 'A') & 63);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  return out;
}

function pushVarint(out: number[], v: number) {
  while (v >= 128) {
    out.push((v & 127) | 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

/** Cell palette indices of a map, decoded (x + z·w + y·w·l). */
export function mapCells(m: GameMap): Uint16Array {
  const total = m.w * m.h * m.l;
  const out = new Uint16Array(total);
  const bytes = fromBase64(m.cells);
  let p = 0;
  let n = 0;
  const read = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      if (p >= bytes.length) throw new Error('Damaged map data');
      const b = bytes[p++];
      v += (b & 127) * mul;
      if (!(b & 128)) return v;
      mul *= 128;
      if (mul > 2 ** 35) throw new Error('Damaged map data');
    }
  };
  while (n < total && p < bytes.length) {
    const run = read();
    const idx = read();
    out.fill(idx, n, Math.min(total, n + run));
    n += run;
  }
  return out;
}

/**
 * A box of block names turned into a map: names become this game's cells, and the box is placed
 * with its corner at (ox, oy, oz).
 */
export function encodeMap(v: Voxels, meta: Omit<GameMap, 'v' | 'w' | 'h' | 'l' | 'palette' | 'cells'>): GameMap {
  const palette: number[] = [];
  const index = new Map<number, number>();
  const cellOf = v.palette.map((name) => {
    const c = mapCell(name);
    const key = c.id === B.AIR ? 0 : c.id * 256 + c.data;
    let i = index.get(key);
    if (i === undefined) {
      i = palette.length / 2;
      index.set(key, i);
      palette.push(c.id === B.AIR ? 0 : c.id, c.id === B.AIR ? 0 : c.data);
    }
    return i;
  });
  // Air must be palette entry 0 (decoding fills with 0).
  if (palette[0] !== 0) {
    palette.unshift(0, 0);
    for (let i = 0; i < cellOf.length; i++) cellOf[i]++;
  }
  const out: number[] = [];
  let run = 0;
  let cur = -1;
  for (let i = 0; i < v.data.length; i++) {
    const c = cellOf[v.data[i]];
    if (c === cur) run++;
    else {
      if (run) (pushVarint(out, run), pushVarint(out, cur));
      cur = c;
      run = 1;
    }
  }
  if (run) (pushVarint(out, run), pushVarint(out, cur));
  return { v: 1, ...meta, w: v.w, h: v.h, l: v.l, palette, cells: toBase64(new Uint8Array(out)) };
}

/** World size a map needs: half-width, layers below y = 0 and layers above (room to build). */
export function mapWorldSize(m: GameMap): { half: number; depth: number; height: number } {
  const reach = Math.max(Math.abs(m.ox), Math.abs(m.ox + m.w), Math.abs(m.oz), Math.abs(m.oz + m.l));
  return {
    half: Math.max(16, Math.ceil(reach / 16) * 16),
    depth: Math.max(1, -m.oy),
    height: Math.max(16, m.oy + m.h + 6),
  };
}

/** Builds the map into `b` (cleared first; the map is protected from breaking by its mode). */
export function placeMap(b: Blocks, m: GameMap) {
  b.voidWorld = true;
  b.clear();
  const cells = mapCells(m);
  const wl = m.w * m.l;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    if (!c) continue;
    const id = m.palette[c * 2];
    if (!id) continue;
    const y = Math.floor(i / wl);
    const z = Math.floor((i % wl) / m.w);
    const x = i % m.w;
    // Water and lava in a map are still sources (flows come back from them).
    if (isFluid(id)) b.set(m.ox + x, m.oy + y, m.oz + z, id, 8, true);
    else b.set(m.ox + x, m.oy + y, m.oz + z, id, m.palette[c * 2 + 1]);
  }
}
