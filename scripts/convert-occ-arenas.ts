/**
 * Turns FFA maps from Overcast Community's CommunityMaps (CC BY-SA 4.0,
 * https://github.com/OvercastCommunity/CommunityMaps) into built-in duel arenas, the same way an
 * imported world is (src/maps/arena.ts): the area around the world's spawn, its floor at ground
 * level, two spawns facing each other.
 *
 *   (cd cm && git sparse-checkout set ffa)
 *   npx vite-node scripts/convert-occ-arenas.ts cm/ffa la_piazza deadwood …
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cutAround, makeArena } from '../src/maps/arena';
import { chunkCubes, readRegion, type ChunkCubes } from '../src/maps/formats';
import { compound, num, readNbt, unpack } from '../src/maps/nbt';

const [dir, ...ids] = process.argv.slice(2);
if (!dir || !ids.length) throw new Error('usage: convert-occ-arenas.ts <ffa dir> <map ids…>');
mkdirSync('src/assets/maps/arenas', { recursive: true });

for (const id of ids) {
  const root = join(dir, id);
  const xml = readFileSync(join(root, 'map.xml'), 'utf8');
  const name = /<name>([^<]+)<\/name>/.exec(xml)![1].trim();
  const authors = [...xml.matchAll(/<(?:author|contributor) uuid="[^"]+"\s*(?:contribution="[^"]*")?\s*\/>\s*<!--\s*([^-]+?)\s*-->/g)].map((m) => m[1]);
  const level = readNbt(await unpack(new Uint8Array(readFileSync(join(root, 'level.dat')))));
  const data = compound(level.Data) ?? level;
  const sx = num(data.SpawnX);
  const sy = num(data.SpawnY, 64);
  const sz = num(data.SpawnZ);
  const chunks: ChunkCubes[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(join(root, 'region'));
  } catch {
    console.log(id, 'SKIPPED (no overworld region files)');
    continue;
  }
  for (const f of files) {
    for (const c of await readRegion(new Uint8Array(readFileSync(join(root, 'region', f))))) {
      const cc = chunkCubes(c);
      if (cc) chunks.push(cc);
    }
  }
  try {
    const box = cutAround(chunks, sx, sy, sz);
    const map = makeArena(box, { id: `occ-${id.replace(/_/g, '-')}`, name, credit: `${name} by ${authors.join(', ') || 'unknown'} — Overcast Community maps (github.com/OvercastCommunity/CommunityMaps)` });
    map.authors = authors;
    map.license = 'CC BY-SA 4.0';
    writeFileSync(`src/assets/maps/arenas/${id}.json`, JSON.stringify(map));
    console.log(id, name, `[${authors.join(', ')}]`, `${map.w}×${map.h}×${map.l}`, `${map.cells.length} chars`, 'spawns', JSON.stringify(map.spawns));
  } catch (e) {
    console.log(id, 'FAILED', String(e));
  }
}
