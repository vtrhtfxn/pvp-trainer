import { isFluid, isSolid } from '../game/Blocks';
import { readZip } from '../render/zip';
import { mapCell } from './blocks';
import { chunkCubes, cutWorld, readMapFile, readRegion, worldBounds, type ChunkCubes, type Voxels } from './formats';
import { encodeMap, type GameMap } from './gameMap';
import { compound, list, num, readNbt, unpack } from './nbt';

/**
 * A map you bring (a schematic or a world save) turned into a duel arena: cropped to fit, set so
 * its main floor is this game's ground level, and two spawns found facing each other across it.
 */

/** The biggest arena: 112 × 112 blocks, 64 high. */
const MAX_SIDE = 112;
const MAX_HEIGHT = 64;

function crop(v: Voxels, x0: number, y0: number, z0: number, w: number, h: number, l: number): Voxels {
  const data = new Uint16Array(w * h * l);
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const sx = x0 + x;
        const sy = y0 + y;
        const sz = z0 + z;
        if (sx < 0 || sy < 0 || sz < 0 || sx >= v.w || sy >= v.h || sz >= v.l) continue;
        data[x + z * w + y * w * l] = v.data[sx + sz * v.w + sy * v.w * v.l];
      }
  return { ...v, w, h, l, data };
}

/** Where things stand in a box: solid cells as this game sees them. */
function solidGrid(v: Voxels): Uint8Array {
  const solid = v.palette.map((n) => {
    const c = mapCell(n);
    return isSolid(c.id) ? 1 : isFluid(c.id) ? 2 : 0;
  });
  const out = new Uint8Array(v.data.length);
  for (let i = 0; i < out.length; i++) out[i] = solid[v.data[i]];
  return out;
}

/**
 * Builds a duel arena from any box of blocks. Throws if there's nowhere to stand.
 */
export function makeArena(src: Voxels, meta: { id: string; name: string; credit: string }): GameMap {
  // Too wide or tall: keep the middle.
  const w = Math.min(src.w, MAX_SIDE);
  const l = Math.min(src.l, MAX_SIDE);
  let v = crop(src, Math.floor((src.w - w) / 2), 0, Math.floor((src.l - l) / 2), w, src.h, l);
  const grid0 = solidGrid(v);
  // The main floor: the commonest top-of-ground height near the middle.
  const counts = new Map<number, number>();
  const tops: number[] = new Array(w * l).fill(-1);
  for (let z = 0; z < l; z++)
    for (let x = 0; x < w; x++) {
      for (let y = v.h - 1; y >= 0; y--) {
        if (grid0[x + z * w + y * w * l] === 1) {
          tops[x + z * w] = y;
          break;
        }
      }
      const inner = Math.abs(x - w / 2) < w / 3 && Math.abs(z - l / 2) < l / 3;
      const t = tops[x + z * w];
      if (inner && t >= 0) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  if (!counts.size) throw new Error('There is no ground in this map to fight on');
  const floor = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  // Not more than MAX_HEIGHT: a little below the floor, the rest above it.
  const below = Math.min(floor, 16);
  const h = Math.min(v.h - (floor - below), MAX_HEIGHT);
  v = crop(v, 0, floor - below, 0, w, h, l);
  const grid = solidGrid(v);
  const at = (x: number, y: number, z: number) => (x < 0 || z < 0 || x >= w || z >= l || y < 0 || y >= h ? 0 : grid[x + z * w + y * w * l]);
  // Standing spots: ground under, room for a player, near the floor's level.
  const standY = (x: number, z: number): number | null => {
    for (let y = Math.min(h - 2, below + 4); y >= Math.max(1, below - 3); y--) if (at(x, y - 1, z) === 1 && at(x, y, z) === 0 && at(x, y + 1, z) === 0) return y;
    return null;
  };
  const roomy = (x: number, z: number, y: number) => [-1, 0, 1].every((dx) => [-1, 0, 1].every((dz) => standY(x + dx, z + dz) === y));
  /** Open above: sky (nothing solid overhead), or at least four blocks of headroom. */
  const open = (x: number, z: number, y: number, sky: boolean) => {
    const top = sky ? h : Math.min(h, y + 4);
    for (let yy = y; yy < top; yy++) if (at(x, yy, z) === 1) return false;
    return true;
  };
  /** Walkable straight line between two spots: no wall in the way, ground under the whole path. */
  const clearLine = (ax: number, az: number, bx: number, bz: number, y: number) => {
    const d = Math.hypot(bx - ax, bz - az);
    for (let t = 0; t <= d; t += 0.5) {
      const x = Math.floor(ax + ((bx - ax) * t) / d + 0.5);
      const z = Math.floor(az + ((bz - az) * t) / d + 0.5);
      if (at(x, y, z) === 1 || at(x, y + 1, z) === 1) return false;
      if (at(x, y - 1, z) !== 1 && at(x, y - 2, z) !== 1) return false;
    }
    return true;
  };
  const cx = Math.floor(w / 2);
  const cz = Math.floor(l / 2);
  let spawns: [number, number, number][] | null = null;
  // Two open spots 8–14 apart with a clear line between them, as near the middle as can be
  // (sky overhead first, then just headroom).
  const DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 8), Math.sin((i * Math.PI) / 8)]);
  for (const sky of [true, false]) {
    let best = Infinity;
    for (let z = 2; z < l - 2; z += 2)
      for (let x = 2; x < w - 2; x += 2) {
        const ya = standY(x, z);
        if (ya === null || !roomy(x, z, ya) || !open(x, z, ya, sky)) continue;
        for (const dist of [12, 10, 8]) {
          for (const [dx, dz] of DIRS) {
            const bx = Math.round(x + dx * dist);
            const bz = Math.round(z + dz * dist);
            const yb = standY(bx, bz);
            if (yb !== ya || !roomy(bx, bz, yb) || !open(bx, bz, yb, sky)) continue;
            const score = Math.hypot((x + bx) / 2 - cx, (z + bz) / 2 - cz) - dist * 0.3;
            if (score >= best || !clearLine(x + 0.5, z + 0.5, bx + 0.5, bz + 0.5, ya)) continue;
            best = score;
            spawns = [
              [x + 0.5, ya, z + 0.5],
              [bx + 0.5, yb, bz + 0.5],
            ];
          }
        }
      }
    if (spawns) break;
  }
  if (!spawns) {
    // Nothing that open: the two standing spots nearest the middle at least 4 apart.
    const spots: [number, number, number][] = [];
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const y = standY(x, z);
        if (y !== null) spots.push([x + 0.5, y, z + 0.5]);
      }
    spots.sort((p, q) => Math.hypot(p[0] - cx, p[2] - cz) - Math.hypot(q[0] - cx, q[2] - cz));
    const a = spots[0];
    const b = a && spots.find((p) => Math.hypot(p[0] - a[0], p[2] - a[2]) >= 4);
    if (!a || !b) throw new Error('There is nowhere in this map for two players to stand');
    spawns = [a, b];
  }
  // In this game's coordinates the middle is (0, 0) and the floor's top is y = -1.
  const ox = -cx;
  const oz = -cz;
  // (Box layer `below` is the floor's top block.)
  const oy = -below - 1;
  return encodeMap(v, {
    id: meta.id,
    name: meta.name,
    authors: [],
    credit: meta.credit,
    license: '',
    ox,
    oy,
    oz,
    spawns: spawns.map(([x, y, z]) => [x + ox, y + oy, z + oz]),
    points: [],
    voidY: oy - 8,
    maxPlayers: 2,
  });
}

/** A world save (.zip): the area around its spawn point. */
async function worldFromZip(bytes: Uint8Array): Promise<Voxels> {
  const entries = readZip(bytes);
  const level = entries.find((e) => /(^|\/)level\.dat$/i.test(e.name) && !/\/(DIM-?1|DIM1)\//.test(e.name));
  const regions = entries.filter((e) => /(^|\/)region\/r\.-?\d+\.-?\d+\.mca$/i.test(e.name) && !/DIM-?1\/|DIM1\//.test(e.name));
  if (!regions.length) throw new Error('No world in this .zip (no region files)');
  let sx = 0;
  let sy = 64;
  let sz = 0;
  if (level) {
    try {
      const root = readNbt(await unpack(await level.read()));
      const data = compound(root.Data) ?? root;
      // 1.21.5 moved the spawn into a "spawn" compound with a position list.
      const sp = compound(data.spawn);
      const pos = sp ? list(sp.pos).map((n) => num(n)) : [];
      sx = pos.length ? pos[0] : num(data.SpawnX);
      sy = pos.length ? pos[1] : num(data.SpawnY, 64);
      sz = pos.length ? pos[2] : num(data.SpawnZ);
    } catch {
      // Without level.dat, the world's middle.
    }
  }
  const half = MAX_SIDE / 2;
  // Only the region files that the area around spawn touches.
  const want = new Set<string>();
  for (const x of [sx - half, sx + half]) for (const z of [sz - half, sz + half]) want.add(`${Math.floor(x / 512)}.${Math.floor(z / 512)}`);
  const chunks: ChunkCubes[] = [];
  for (const e of regions) {
    const m = /r\.(-?\d+)\.(-?\d+)\.mca$/i.exec(e.name)!;
    if (!want.has(`${m[1]}.${m[2]}`)) continue;
    for (const c of await readRegion(await e.read())) {
      const cc = chunkCubes(c);
      if (cc) chunks.push(cc);
    }
  }
  return cutAround(chunks, sx, sy, sz);
}

/** The arena-sized box of a world around (sx, sy, sz). */
export function cutAround(all: ChunkCubes[], sx: number, sy: number, sz: number): Voxels {
  const half = MAX_SIDE / 2;
  const chunks = all.filter((cc) => Math.abs(cc.cx * 16 + 8 - sx) <= half + 16 && Math.abs(cc.cz * 16 + 8 - sz) <= half + 16);
  const b = worldBounds(chunks);
  if (!b) throw new Error('The world around its spawn is empty');
  // Height: from a little under the spawn to what's above it, at most MAX_HEIGHT.
  const y0 = Math.max(b.y0, sy - 24);
  const y1 = Math.min(b.y1, y0 + MAX_HEIGHT + 16);
  return cutWorld(chunks, Math.floor(sx - half), y0, Math.floor(sz - half), Math.floor(sx + half) - 1, y1, Math.floor(sz + half) - 1);
}

/** Reads a map file you picked (a schematic, a structure, or a world save .zip) as an arena. */
export async function importMap(fileName: string, bytes: Uint8Array): Promise<GameMap> {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const v = isZip ? await worldFromZip(bytes) : await readMapFile(bytes);
  const name = fileName.replace(/\.(schem|schematic|litematic|nbt|zip)$/i, '').slice(0, 40) || 'Map';
  return makeArena(v, { id: `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`, name, credit: `Imported from ${fileName.slice(0, 80)} (${v.format})` });
}
