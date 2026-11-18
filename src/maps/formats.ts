import { compound, list, num, readNbt, str, unpack, type Nbt, type NbtCompound } from './nbt';
import { legacyName } from './legacy';

/**
 * Every map file read into one shape: a box of block names. Sponge schematics (.schem, WorldEdit
 * and FAWE, versions 1–3), MCEdit / old WorldEdit schematics (.schematic, numeric ids), Litematica
 * (.litematic), structure-block files (.nbt) and world regions (.mca, 1.8 up to now).
 */
export interface Voxels {
  /** Size along x, y and z. */
  w: number;
  h: number;
  l: number;
  /** Block names without the namespace and properties ("stone", "oak_stairs"); 0 is always air. */
  palette: string[];
  /** Palette index of each cell, at x + z·w + y·w·l. */
  data: Uint16Array;
  /** What the file was. */
  format: string;
}

/** A bigger box than this is refused (8 M cells: 256 × 128 × 256). */
export const MAX_CELLS = 8 * 1024 * 1024;

/** "minecraft:oak_stairs[facing=east]" → "oak_stairs". */
export function bareName(state: string): string {
  const s = state.replace(/\[.*$/, '').trim();
  const i = s.indexOf(':');
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase();
}

/** The block state's properties ("facing=east,half=top" → {facing: 'east', half: 'top'}). */
export function stateProps(state: string): Record<string, string> {
  const m = /\[(.*)\]/.exec(state);
  const out: Record<string, string> = {};
  if (m) for (const kv of m[1].split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) out[k.trim()] = v.trim();
  }
  return out;
}

class Builder {
  readonly palette: string[] = ['air'];
  private readonly index = new Map<string, number>([['air', 0]]);
  readonly data: Uint16Array;
  constructor(
    readonly w: number,
    readonly h: number,
    readonly l: number,
  ) {
    if (w <= 0 || h <= 0 || l <= 0) throw new Error('The map is empty');
    if (w * h * l > MAX_CELLS) throw new Error(`The map is too big (${w}×${h}×${l})`);
    this.data = new Uint16Array(w * h * l);
  }
  /** Palette index for a full state name (properties kept: stairs and slabs need them). */
  id(state: string): number {
    const key = state.replace(/^minecraft:/, '').toLowerCase();
    if (bareName(key) === 'air' || bareName(key) === 'cave_air' || bareName(key) === 'void_air') return 0;
    let i = this.index.get(key);
    if (i === undefined) {
      if (this.palette.length >= 65535) throw new Error('Too many kinds of block');
      i = this.palette.length;
      this.palette.push(key);
      this.index.set(key, i);
    }
    return i;
  }
  set(x: number, y: number, z: number, i: number) {
    if (x < 0 || y < 0 || z < 0 || x >= this.w || y >= this.h || z >= this.l) return;
    this.data[x + z * this.w + y * this.w * this.l] = i;
  }
  done(format: string): Voxels {
    return { w: this.w, h: this.h, l: this.l, palette: this.palette, data: this.data, format };
  }
}

/** Sponge's BlockData: one varint (7 bits a byte, low bits first) per cell. */
function* varints(bytes: Int8Array): Generator<number> {
  let v = 0;
  let shift = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 255;
    v |= (b & 127) << shift;
    if (b & 128) {
      shift += 7;
      if (shift > 28) throw new Error('Damaged block data');
    } else {
      yield v;
      v = 0;
      shift = 0;
    }
  }
}

function sponge(s: NbtCompound, version: number): Voxels {
  const w = num(s.Width);
  const h = num(s.Height);
  const l = num(s.Length);
  const b = new Builder(w & 0xffff, h & 0xffff, l & 0xffff);
  const blocks = version >= 3 ? compound(s.Blocks) : s;
  if (!blocks) throw new Error('No blocks in this schematic');
  const pal = compound(blocks.Palette);
  const raw = version >= 3 ? blocks.Data : blocks.BlockData;
  if (!pal || !(raw instanceof Int8Array)) throw new Error('No blocks in this schematic');
  const map: number[] = [];
  for (const [name, i] of Object.entries(pal)) map[num(i)] = b.id(name);
  let n = 0;
  const total = b.w * b.h * b.l;
  for (const v of varints(raw)) {
    if (n >= total) break;
    b.data[n++] = map[v] ?? 0;
  }
  return b.done(`Sponge schematic v${version}`);
}

function mcedit(s: NbtCompound): Voxels {
  const b = new Builder(num(s.Width) & 0xffff, num(s.Height) & 0xffff, num(s.Length) & 0xffff);
  const ids = s.Blocks;
  const meta = s.Data;
  const add = s.AddBlocks;
  if (!(ids instanceof Int8Array)) throw new Error('No blocks in this schematic');
  const total = Math.min(ids.length, b.w * b.h * b.l);
  const cache = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    let id = ids[i] & 255;
    if (add instanceof Int8Array) {
      const nib = add[i >> 1] ?? 0;
      id |= ((i & 1 ? nib : nib >> 4) & 15) << 8;
    }
    if (id === 0) continue;
    const m = meta instanceof Int8Array ? meta[i] & 15 : 0;
    const key = (id << 4) | m;
    let p = cache.get(key);
    if (p === undefined) cache.set(key, (p = b.id(legacyName(id, m))));
    b.data[i] = p;
  }
  return b.done('MCEdit schematic');
}

/** A packed long array: `bits` per entry, entries running across longs (Litematica, 1.13–1.15). */
function unpackCrossing(longs: BigInt64Array, bits: number, count: number, out: (i: number, v: number) => void) {
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const bit = i * bits;
    const li = Math.floor(bit / 64);
    const off = BigInt(bit % 64);
    if (li >= longs.length) return;
    let v = BigInt.asUintN(64, longs[li]) >> off;
    if (Number(off) + bits > 64 && li + 1 < longs.length) v |= BigInt.asUintN(64, longs[li + 1]) << (64n - off);
    out(i, Number(v & mask));
  }
}

/** A packed long array where entries never cross longs (1.16 and later). */
function unpackAligned(longs: BigInt64Array, bits: number, count: number, out: (i: number, v: number) => void) {
  const per = Math.floor(64 / bits);
  const mask = (1n << BigInt(bits)) - 1n;
  for (let i = 0; i < count; i++) {
    const li = Math.floor(i / per);
    if (li >= longs.length) return;
    out(i, Number((BigInt.asUintN(64, longs[li]) >> BigInt((i % per) * bits)) & mask));
  }
}

function stateString(e: NbtCompound): string {
  const name = str(e.Name);
  const props = compound(e.Properties);
  if (!props) return name;
  const kv = Object.entries(props).map(([k, v]) => `${k}=${str(v)}`);
  return kv.length ? `${name}[${kv.join(',')}]` : name;
}

function litematic(root: NbtCompound): Voxels {
  const regions = compound(root.Regions);
  if (!regions) throw new Error('No regions in this Litematica file');
  const boxes = Object.values(regions).map((r) => {
    const c = compound(r)!;
    const pos = compound(c.Position) ?? {};
    const size = compound(c.Size) ?? {};
    const sx = num(size.x);
    const sy = num(size.y);
    const sz = num(size.z);
    return {
      c,
      x0: num(pos.x) + (sx < 0 ? sx + 1 : 0),
      y0: num(pos.y) + (sy < 0 ? sy + 1 : 0),
      z0: num(pos.z) + (sz < 0 ? sz + 1 : 0),
      w: Math.abs(sx),
      h: Math.abs(sy),
      l: Math.abs(sz),
    };
  });
  if (!boxes.length) throw new Error('No regions in this Litematica file');
  const minX = Math.min(...boxes.map((r) => r.x0));
  const minY = Math.min(...boxes.map((r) => r.y0));
  const minZ = Math.min(...boxes.map((r) => r.z0));
  const b = new Builder(
    Math.max(...boxes.map((r) => r.x0 + r.w)) - minX,
    Math.max(...boxes.map((r) => r.y0 + r.h)) - minY,
    Math.max(...boxes.map((r) => r.z0 + r.l)) - minZ,
  );
  for (const r of boxes) {
    const pal = list(r.c.BlockStatePalette).map((e) => b.id(stateString(compound(e) ?? {})));
    const longs = r.c.BlockStates;
    if (!(longs instanceof BigInt64Array) || pal.length === 0) continue;
    const bits = Math.max(2, Math.ceil(Math.log2(pal.length)));
    const wl = r.w * r.l;
    unpackCrossing(longs, bits, r.w * r.h * r.l, (i, v) => {
      const y = Math.floor(i / wl);
      const z = Math.floor((i % wl) / r.w);
      const x = i % r.w;
      b.set(r.x0 - minX + x, r.y0 - minY + y, r.z0 - minZ + z, pal[v] ?? 0);
    });
  }
  return b.done('Litematica schematic');
}

function structure(root: NbtCompound): Voxels {
  const size = list(root.size).map((v) => num(v));
  const b = new Builder(size[0] ?? 0, size[1] ?? 0, size[2] ?? 0);
  const palette = list(root.palette).length ? list(root.palette) : list(list(root.palettes)[0]);
  const pal = palette.map((e) => b.id(stateString(compound(e) ?? {})));
  for (const e of list(root.blocks)) {
    const c = compound(e);
    if (!c) continue;
    const p = list(c.pos).map((v) => num(v));
    b.set(p[0], p[1], p[2], pal[num(c.state)] ?? 0);
  }
  return b.done('Structure file');
}

/** Reads any supported map file (compressed or not). */
export async function readMapFile(bytes: Uint8Array): Promise<Voxels> {
  const root = readNbt(await unpack(bytes));
  // Sponge v3 wraps everything in a "Schematic" compound; v1/v2 are the root itself.
  const inner = compound(root.Schematic);
  if (inner && compound(inner.Blocks)) return sponge(inner, 3);
  if (compound(root.Palette) && root.BlockData instanceof Int8Array) return sponge(root, num(root.Version, 2));
  if (inner && compound(inner.Palette)) return sponge(inner, num(inner.Version, 2));
  if (root.Blocks instanceof Int8Array) return mcedit(root);
  if (compound(root.Regions)) return litematic(root);
  if (Array.isArray(root.size) && Array.isArray(root.blocks)) return structure(root);
  throw new Error('Not a schematic this game can read (.schem, .schematic, .litematic or structure .nbt)');
}

// ------------------------------------------------------------------ worlds (.mca regions)

/** One chunk's sections, each a 16×16×16 cube of names. */
export interface ChunkCubes {
  cx: number;
  cz: number;
  /** Section y → 4096 names at y·256 + z·16 + x. */
  sections: Map<number, string[]>;
}

/** The chunks stored in one region file (.mca). */
export async function readRegion(bytes: Uint8Array): Promise<NbtCompound[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: NbtCompound[] = [];
  if (bytes.length < 8192) return out;
  for (let i = 0; i < 1024; i++) {
    const loc = view.getUint32(i * 4);
    const offset = (loc >>> 8) * 4096;
    if (!offset || offset + 5 > bytes.length) continue;
    const len = view.getUint32(offset);
    const kind = bytes[offset + 4];
    if (len < 1 || offset + 4 + len > bytes.length) continue;
    const body = bytes.subarray(offset + 5, offset + 4 + len);
    try {
      const raw = kind === 1 || kind === 2 ? await unpack(body) : kind === 3 ? body : null;
      if (raw) out.push(readNbt(raw));
    } catch {
      // A damaged chunk is left out.
    }
  }
  return out;
}

/** A chunk's blocks, whichever version wrote it (1.8 ids, 1.13–1.17 palettes, 1.18+ block_states). */
export function chunkCubes(chunk: NbtCompound): ChunkCubes | null {
  const level = compound(chunk.Level) ?? chunk;
  const cx = num(level.xPos);
  const cz = num(level.zPos);
  const sections = new Map<number, string[]>();
  const dataVersion = num(chunk.DataVersion);
  for (const sv of list(level.Sections ?? level.sections)) {
    const s = compound(sv);
    if (!s) continue;
    const y = num(s.Y);
    const names: string[] = new Array(4096).fill('air');
    if (s.Blocks instanceof Int8Array) {
      // 1.8–1.12: numeric ids, 4-bit metadata, optional high bits.
      const ids = s.Blocks;
      const meta = s.Data instanceof Int8Array ? s.Data : null;
      const add = s.Add instanceof Int8Array ? s.Add : null;
      for (let i = 0; i < 4096; i++) {
        let id = ids[i] & 255;
        if (add) id |= ((i & 1 ? add[i >> 1] >> 4 : add[i >> 1]) & 15) << 8;
        if (!id) continue;
        const m = meta ? (i & 1 ? meta[i >> 1] >> 4 : meta[i >> 1]) & 15 : 0;
        names[i] = legacyName(id, m);
      }
    } else {
      const bs = compound(s.block_states);
      const palette = list(bs ? bs.palette : s.Palette).map((e) => stateString(compound(e as Nbt) ?? {}));
      const longs = bs ? bs.data : s.BlockStates;
      if (palette.length === 1) names.fill(palette[0]);
      else if (palette.length > 1 && longs instanceof BigInt64Array) {
        const bits = Math.max(4, Math.ceil(Math.log2(palette.length)));
        // 1.16 (data version 2556) stopped letting entries cross longs.
        const unpackFn = dataVersion >= 2556 || bs ? unpackAligned : unpackCrossing;
        unpackFn(longs, bits, 4096, (i, v) => (names[i] = palette[v] ?? 'air'));
      } else continue;
    }
    sections.set(y, names);
  }
  return { cx, cz, sections };
}

/**
 * Cuts a box out of a world's chunks: x0..x1, y0..y1, z0..z1 in world coordinates (inclusive).
 */
export function cutWorld(chunks: ChunkCubes[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Voxels {
  const b = new Builder(x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1);
  for (const c of chunks) {
    for (const [sy, names] of c.sections) {
      for (let i = 0; i < 4096; i++) {
        const n = names[i];
        if (n === 'air' || n === 'minecraft:air') continue;
        const wx = c.cx * 16 + (i & 15);
        const wz = c.cz * 16 + ((i >> 4) & 15);
        const wy = sy * 16 + (i >> 8);
        if (wx < x0 || wx > x1 || wy < y0 || wy > y1 || wz < z0 || wz > z1) continue;
        b.set(wx - x0, wy - y0, wz - z0, b.id(n));
      }
    }
  }
  return b.done('World');
}

/** The box around every non-air block in some chunks (to cut a whole small world). */
export function worldBounds(chunks: ChunkCubes[]): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let z0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let z1 = -Infinity;
  for (const c of chunks)
    for (const [sy, names] of c.sections)
      for (let i = 0; i < 4096; i++) {
        const n = names[i];
        if (n === 'air' || n === 'minecraft:air' || n === 'minecraft:cave_air' || n === 'cave_air') continue;
        const wx = c.cx * 16 + (i & 15);
        const wz = c.cz * 16 + ((i >> 4) & 15);
        const wy = sy * 16 + (i >> 8);
        if (wx < x0) x0 = wx;
        if (wx > x1) x1 = wx;
        if (wy < y0) y0 = wy;
        if (wy > y1) y1 = wy;
        if (wz < z0) z0 = wz;
        if (wz > z1) z1 = wz;
      }
  return x0 === Infinity ? null : { x0, y0, z0, x1, y1, z1 };
}
