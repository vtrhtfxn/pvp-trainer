/**
 * Converts Item Sumo maps from Overcast Community's CommunityMaps (CC BY-SA 4.0,
 * https://github.com/OvercastCommunity/CommunityMaps) into this game's map files.
 *
 *   git clone --depth 1 --filter=blob:none --sparse https://github.com/OvercastCommunity/CommunityMaps cm
 *   (cd cm && git sparse-checkout set arcade/item_sumo)
 *   npx vite-node scripts/convert-occ-maps.ts cm/arcade/item_sumo atomic atomic_ii calima gjoll weald
 *
 * Writes src/assets/maps/<id>.json. Only the playable circle(s) of each map are kept; map.xml gives
 * the spawns, the centre to hold and the void.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkCubes, cutWorld, readRegion, type ChunkCubes } from '../src/maps/formats';
import { encodeMap } from '../src/maps/gameMap';

const [dir, ...ids] = process.argv.slice(2);
if (!dir || !ids.length) throw new Error('usage: convert-occ-maps.ts <item_sumo dir> <map ids…>');

const nums = (s: string) => s.split(',').map(Number);

for (const id of ids) {
  const root = join(dir, id);
  const xml = readFileSync(join(root, 'map.xml'), 'utf8');
  const name = /<name>([^<]+)<\/name>/.exec(xml)![1];
  const authors = [...xml.matchAll(/<author uuid="[^"]+"\s*\/>\s*<!--\s*([^-]+?)\s*-->/g)].map((m) => m[1]);
  const voidPlane = Number(/id="void-plane">([^<]+)</.exec(xml)?.[1] ?? 50);
  const maxPlayers = Number(/<players max="(\d+)"/.exec(xml)?.[1] ?? 12);
  // The playable area: the circle(s) of the "playable-area" region (other circles are spawn rooms).
  const playable = /<complement id="playable-area">([\s\S]*?)<\/complement>/.exec(xml)?.[1] ?? '';
  const circles = [...playable.matchAll(/<circle center="([^"]+)" radius="([^"]+)"\/>/g)].map((m) => ({ c: nums(m[1]), r: Number(m[2]) }));
  const spawns = [...xml.matchAll(/<cylinder base="([^"]+)" height="2" radius="0.5"\/>/g)].map((m) => nums(m[1]));
  const centres = [...xml.matchAll(/<cuboid id="(?:center-region|point-b-region)" min="([^"]+)" max="([^"]+)"\/>/g)].map((m) => [nums(m[1]), nums(m[2])]);
  if (!circles.length || !spawns.length || !centres.length) throw new Error(`${id}: map.xml has no circle, spawns or centre`);

  const chunks: ChunkCubes[] = [];
  // A Nether map (Gjöll) keeps its blocks in DIM-1.
  let regionDir = join(root, 'region');
  try {
    readdirSync(regionDir);
  } catch {
    regionDir = join(root, 'DIM-1', 'region');
  }
  for (const f of readdirSync(regionDir)) {
    for (const c of await readRegion(new Uint8Array(readFileSync(join(regionDir, f))))) {
      const cc = chunkCubes(c);
      if (cc) chunks.push(cc);
    }
  }
  const x0 = Math.floor(Math.min(...circles.map((k) => k.c[0] - k.r)));
  const x1 = Math.ceil(Math.max(...circles.map((k) => k.c[0] + k.r)));
  const z0 = Math.floor(Math.min(...circles.map((k) => k.c[1] - k.r)));
  const z1 = Math.ceil(Math.max(...circles.map((k) => k.c[1] + k.r)));
  const box = cutWorld(chunks, x0, voidPlane + 1, z0, x1, 255, z1);
  // Keep only what's inside the playable circle(s) and at most 14 blocks over the spawns (Atomic II
  // has a floating build far above); then trim the empty layers above and below.
  const spawnTop = Math.max(...spawns.map((p) => p[1])) + 14 - (voidPlane + 1);
  let top = -1;
  let bottom = box.h;
  for (let y = 0; y < box.h; y++)
    for (let z = 0; z < box.l; z++)
      for (let x = 0; x < box.w; x++) {
        const i = x + z * box.w + y * box.w * box.l;
        if (!box.data[i]) continue;
        const wx = x0 + x + 0.5;
        const wz = z0 + z + 0.5;
        if (y > spawnTop || !circles.some((k) => Math.hypot(wx - k.c[0], wz - k.c[1]) <= k.r + 0.5)) box.data[i] = 0;
        else {
          top = Math.max(top, y);
          bottom = Math.min(bottom, y);
        }
      }
  const layer = box.w * box.l;
  const trimmed = { ...box, h: top - bottom + 1, data: box.data.slice(bottom * layer, (top + 1) * layer) };
  // The centre's floor is this game's y = 0.
  const floor = Math.min(...centres.map(([a]) => a[1]));
  const map = encodeMap(trimmed, {
    id,
    name,
    authors,
    credit: `${name} by ${authors.join(' and ')} — Overcast Community maps (github.com/OvercastCommunity/CommunityMaps)`,
    license: 'CC BY-SA 4.0',
    ox: x0,
    oy: voidPlane + 1 + bottom - floor,
    oz: z0,
    spawns: spawns.map(([x, y, z]) => [x, y - floor, z]),
    points: centres.map(([a, b]) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]) - floor, Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[1], b[1]) - floor, Math.max(a[2], b[2])]),
    voidY: voidPlane - floor,
    maxPlayers,
  });
  writeFileSync(`src/assets/maps/${id}.json`, JSON.stringify(map));
  console.log(id, name, authors.join(', '), `${map.w}×${map.h}×${map.l}`, `${spawns.length} spawns`, `${map.cells.length} chars`, `palette ${map.palette.length / 2}`);
}
