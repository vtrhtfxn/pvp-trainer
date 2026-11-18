/**
 * Minecraft's NBT format (big-endian, named tags) — enough to read maps: schematics, structure
 * files, Litematica files and world regions. The files come from anywhere, so every length is
 * checked against the bytes left and nesting is capped: a bad file throws, it never hangs.
 */

export type Nbt = number | bigint | string | Int8Array | Int32Array | BigInt64Array | Nbt[] | NbtCompound;
export interface NbtCompound {
  [key: string]: Nbt;
}

const MAX_DEPTH = 256;

class Reader {
  private p = 0;
  private readonly view: DataView;
  private readonly utf8 = new TextDecoder();
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (n < 0 || this.p + n > this.bytes.length) throw new Error('Damaged NBT data');
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.p++);
  }
  i8() {
    this.need(1);
    return this.view.getInt8(this.p++);
  }
  i16() {
    this.need(2);
    const v = this.view.getInt16(this.p);
    this.p += 2;
    return v;
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.p);
    this.p += 2;
    return v;
  }
  i32() {
    this.need(4);
    const v = this.view.getInt32(this.p);
    this.p += 4;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.view.getBigInt64(this.p);
    this.p += 8;
    return v;
  }
  f32() {
    this.need(4);
    const v = this.view.getFloat32(this.p);
    this.p += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.p);
    this.p += 8;
    return v;
  }
  str() {
    const n = this.u16();
    this.need(n);
    const s = this.utf8.decode(this.bytes.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  count(size: number) {
    const n = this.i32();
    if (n < 0) throw new Error('Damaged NBT data');
    this.need(n * size);
    return n;
  }
  payload(type: number, depth: number): Nbt {
    if (depth > MAX_DEPTH) throw new Error('NBT nested too deeply');
    switch (type) {
      case 1:
        return this.i8();
      case 2:
        return this.i16();
      case 3:
        return this.i32();
      case 4:
        return this.i64();
      case 5:
        return this.f32();
      case 6:
        return this.f64();
      case 7: {
        const n = this.count(1);
        const a = new Int8Array(this.bytes.buffer.slice(this.bytes.byteOffset + this.p, this.bytes.byteOffset + this.p + n));
        this.p += n;
        return a;
      }
      case 8:
        return this.str();
      case 9: {
        const el = this.u8();
        // An empty list may say End (0) as its type; anything else needs at least a byte each.
        const n = this.count(el === 0 ? 0 : 1);
        const out: Nbt[] = [];
        for (let i = 0; i < n; i++) out.push(this.payload(el, depth + 1));
        return out;
      }
      case 10: {
        const out: NbtCompound = {};
        for (;;) {
          const t = this.u8();
          if (t === 0) return out;
          const name = this.str();
          out[name] = this.payload(t, depth + 1);
        }
      }
      case 11: {
        const n = this.count(4);
        const a = new Int32Array(n);
        for (let i = 0; i < n; i++) a[i] = this.i32();
        return a;
      }
      case 12: {
        const n = this.count(8);
        const a = new BigInt64Array(n);
        for (let i = 0; i < n; i++) a[i] = this.i64();
        return a;
      }
      default:
        throw new Error(`Unknown NBT tag ${type}`);
    }
  }
}

/** Reads uncompressed NBT: the root compound (its name is dropped). */
export function readNbt(bytes: Uint8Array): NbtCompound {
  const r = new Reader(bytes);
  const t = r.u8();
  if (t !== 10) throw new Error('Not an NBT file');
  r.str();
  return r.payload(10, 0) as NbtCompound;
}

async function decompress(bytes: Uint8Array, format: 'gzip' | 'deflate'): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Gzip (schematics, structures, level.dat) or zlib (region chunks); plain NBT passes through. */
export async function unpack(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return decompress(bytes, 'gzip');
  if (bytes[0] === 0x78) return decompress(bytes, 'deflate');
  return bytes;
}

// ---------------------------------------------------------------- helpers for reading a tree

export function compound(v: Nbt | undefined): NbtCompound | null {
  return v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v) ? (v as NbtCompound) : null;
}

export function list(v: Nbt | undefined): Nbt[] {
  return Array.isArray(v) ? v : [];
}

export function num(v: Nbt | undefined, fallback = 0): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : fallback;
}

export function str(v: Nbt | undefined): string {
  return typeof v === 'string' ? v : '';
}

// ---------------------------------------------------------------- writing (tests, our own files)

/** Writes a root compound as NBT (uncompressed). Numbers are written as ints unless told otherwise. */
export function writeNbt(root: NbtCompound, types: Record<string, number> = {}): Uint8Array {
  const out: number[] = [];
  const u8 = (n: number) => out.push(n & 255);
  const i16 = (n: number) => (u8(n >> 8), u8(n));
  const i32 = (n: number) => (u8(n >>> 24), u8(n >>> 16), u8(n >>> 8), u8(n));
  const i64 = (n: bigint) => {
    for (let s = 56n; s >= 0n; s -= 8n) u8(Number((n >> s) & 255n));
  };
  const s = (t: string) => {
    const b = new TextEncoder().encode(t);
    i16(b.length);
    for (const x of b) u8(x);
  };
  const typeOf = (v: Nbt, key: string): number => {
    if (types[key] !== undefined) return types[key];
    if (typeof v === 'number') return 3;
    if (typeof v === 'bigint') return 4;
    if (typeof v === 'string') return 8;
    if (v instanceof Int8Array) return 7;
    if (v instanceof Int32Array) return 11;
    if (v instanceof BigInt64Array) return 12;
    if (Array.isArray(v)) return 9;
    return 10;
  };
  const payload = (t: number, v: Nbt, key: string) => {
    switch (t) {
      case 1:
        return u8(v as number);
      case 2:
        return i16(v as number);
      case 3:
        return i32(v as number);
      case 4:
        return i64(v as bigint);
      case 8:
        return s(v as string);
      case 7: {
        const a = v as Int8Array;
        i32(a.length);
        for (const x of a) u8(x);
        return;
      }
      case 11: {
        const a = v as Int32Array;
        i32(a.length);
        for (const x of a) i32(x);
        return;
      }
      case 12: {
        const a = v as BigInt64Array;
        i32(a.length);
        for (const x of a) i64(x);
        return;
      }
      case 9: {
        const a = v as Nbt[];
        const el = a.length ? typeOf(a[0], `${key}[]`) : 0;
        u8(el);
        i32(a.length);
        for (const x of a) payload(el, x, `${key}[]`);
        return;
      }
      default: {
        const c = v as NbtCompound;
        for (const [k, x] of Object.entries(c)) {
          const tt = typeOf(x, k);
          u8(tt);
          s(k);
          payload(tt, x, k);
        }
        u8(0);
      }
    }
  };
  u8(10);
  s('');
  payload(10, root, '');
  return new Uint8Array(out);
}
