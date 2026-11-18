import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { B } from '../src/game/Blocks';
import { Match } from '../src/game/Match';
import { performAttack } from '../src/game/combat';
import { kitById } from '../src/game/kits';
import { ITEM_SUMO_MAPS, ItemSumo } from '../src/game/modes/ItemSumo';
import { MAP_MATERIALS, mapCell } from '../src/maps/blocks';
import { readMapFile } from '../src/maps/formats';
import { encodeMap, mapCells } from '../src/maps/gameMap';
import { legacyName } from '../src/maps/legacy';
import { writeNbt, type NbtCompound } from '../src/maps/nbt';

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** A 3×2×2 test box: stone floor, a stair and an oak log on top, air elsewhere. */
const W = 3;
const H = 2;
const L = 2;
const expected = (x: number, y: number, z: number) => (y === 0 ? 'stone' : x === 0 && z === 0 ? 'oak_stairs' : x === 2 && z === 1 ? 'oak_log' : 'air');

function varints(values: number[]): Int8Array {
  const out: number[] = [];
  for (let v of values) {
    while (v >= 128) {
      out.push((v & 127) | 128);
      v >>= 7;
    }
    out.push(v);
  }
  return new Int8Array(out);
}

function cells(): string[] {
  const out: string[] = [];
  for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) out.push(expected(x, y, z));
  return out;
}

function check(v: { w: number; h: number; l: number; palette: string[]; data: Uint16Array }) {
  expect([v.w, v.h, v.l]).toEqual([W, H, L]);
  for (let y = 0; y < H; y++)
    for (let z = 0; z < L; z++)
      for (let x = 0; x < W; x++) expect(v.palette[v.data[x + z * W + y * W * L]].replace(/\[.*/, '')).toBe(expected(x, y, z));
}

describe('reading map files', () => {
  it('Sponge schematics v2 and v3', async () => {
    const names = ['minecraft:air', 'minecraft:stone', 'minecraft:oak_stairs[facing=east,half=bottom]', 'minecraft:oak_log[axis=y]'];
    const pal: NbtCompound = Object.fromEntries(names.map((n, i) => [n, i]));
    const data = varints(cells().map((c) => names.findIndex((n) => n.includes(`:${c}`))));
    const v2 = writeNbt({ Version: 2, Width: W, Height: H, Length: L, Palette: pal, BlockData: data }, { Width: 2, Height: 2, Length: 2 });
    check(await readMapFile(await gzip(v2)));
    const v3 = writeNbt({ Schematic: { Version: 3, Width: W, Height: H, Length: L, Blocks: { Palette: pal, Data: data } } }, { Width: 2, Height: 2, Length: 2 });
    check(await readMapFile(await gzip(v3)));
  });

  it('MCEdit schematics (numeric ids)', async () => {
    const ids = cells().map((c) => (c === 'stone' ? 1 : c === 'oak_stairs' ? 53 : c === 'oak_log' ? 17 : 0));
    const nbt = writeNbt({ Width: W, Height: H, Length: L, Materials: 'Alpha', Blocks: new Int8Array(ids), Data: new Int8Array(ids.length) }, { Width: 2, Height: 2, Length: 2 });
    check(await readMapFile(await gzip(nbt)));
  });

  it('Litematica (bits packed across longs) and structure files', async () => {
    const pal = ['air', 'stone', 'oak_stairs', 'oak_log'];
    const idx = cells().map((c) => pal.indexOf(c));
    const bits = 2;
    const longs = new BigInt64Array(Math.ceil((idx.length * bits) / 64));
    idx.forEach((v, i) => {
      const bit = i * bits;
      longs[bit >> 6] |= BigInt(v) << BigInt(bit & 63);
    });
    const lit = writeNbt({
      Version: 6,
      Regions: { main: { Position: { x: 0, y: 0, z: 0 }, Size: { x: W, y: H, z: L }, BlockStatePalette: pal.map((n) => ({ Name: `minecraft:${n}` })), BlockStates: longs } },
    });
    check(await readMapFile(await gzip(lit)));
    const blocks: NbtCompound[] = [];
    for (let y = 0; y < H; y++) for (let z = 0; z < L; z++) for (let x = 0; x < W; x++) if (expected(x, y, z) !== 'air') blocks.push({ pos: [x, y, z], state: pal.indexOf(expected(x, y, z)) });
    const st = writeNbt({ size: [W, H, L], palette: pal.map((n) => ({ Name: `minecraft:${n}` })), blocks });
    check(await readMapFile(await gzip(st)));
  });

  it('refuses junk instead of hanging', async () => {
    await expect(readMapFile(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
    await expect(readMapFile(writeNbt({ Width: 9000, Height: 9000, Length: 9000, Blocks: new Int8Array(4) }, { Width: 2, Height: 2, Length: 2 }))).rejects.toThrow(/too big/);
  });
});

describe('map blocks', () => {
  it('keeps the blocks the game has and colours the rest', () => {
    expect(mapCell('minecraft:stone')).toEqual({ id: B.STONE, data: 0 });
    expect(mapCell('minecraft:oak_stairs[half=bottom]')).toEqual({ id: B.PLANKS, data: 0 });
    expect(mapCell('minecraft:red_wool')).toEqual({ id: B.WOOL, data: 0 });
    expect(mapCell('minecraft:light_blue_stained_glass_pane')).toEqual({ id: B.GLASS, data: 0 });
    // Walk-through decoration and floor slabs are left out; a top slab is a block.
    for (const n of ['poppy', 'torch', 'white_carpet', 'oak_sign', 'rail', 'short_grass', 'stone_slab[type=bottom]', 'barrier']) expect(mapCell(n).id, n).toBe(B.AIR);
    expect(mapCell('stone_brick_slab[type=top]').id).toBe(B.MAP);
    // Coloured and wooden blocks become map blocks of the right material.
    const mat = (n: string) => MAP_MATERIALS[mapCell(n).data].key;
    expect(mat('lime_concrete')).toBe('lime_concrete');
    expect(mat('cyan_glazed_terracotta')).toBe('cyan_terracotta');
    expect(mat('spruce_fence')).toBe('spruce_planks');
    expect(mat('crimson_stem')).toBe('crimson_log');
    expect(mat('flowering_azalea_leaves')).toBe('azalea_leaves');
    expect(mat('sea_lantern')).toBe('sea_lantern');
    expect(mat('polished_blackstone_brick_stairs')).toBe('polished_blackstone_bricks');
    expect(mat('end_stone_brick_wall')).toBe('end_stone_bricks');
    expect(mat('something_new_from_2030')).toBe('generic');
    expect(MAP_MATERIALS.length).toBeLessThan(256);
  });

  it('reads old numeric ids', () => {
    expect(legacyName(35, 14)).toBe('red_wool');
    expect(legacyName(159, 11)).toBe('blue_terracotta');
    expect(legacyName(5, 1)).toBe('spruce_planks');
    expect(legacyName(44, 8)).toBe('smooth_stone_slab[type=top]');
  });

  it('a map survives being packed and unpacked', () => {
    const data = new Uint16Array(W * H * L);
    const palette = ['air', 'stone', 'oak_stairs[half=bottom]', 'oak_log'];
    cells().forEach((c, i) => (data[i] = palette.findIndex((p) => p.startsWith(c))));
    const m = encodeMap({ w: W, h: H, l: L, palette, data, format: 'test' }, { id: 't', name: 'T', authors: [], credit: '', license: '', ox: 0, oy: 0, oz: 0, spawns: [], points: [], voidY: -10, maxPlayers: 2 });
    const back = mapCells(m);
    for (let i = 0; i < data.length; i++) expect(m.palette[back[i] * 2]).toBe(mapCell(palette[data[i]]).id);
  });
});

describe('Item Sumo', () => {
  it('builds each shipped map with every spawn on solid ground', () => {
    for (const map of ITEM_SUMO_MAPS) {
      const m = new Match(kitById('itemsumo'), DIFFICULTIES.lt3, 1, undefined, 12);
      (m as unknown as { mode: ItemSumo }).mode = new ItemSumo(map.id);
      m.mode!.setup(m);
      expect(map.license).toBe('CC BY-SA 4.0');
      for (const [x, y, z] of map.spawns) expect(m.world.blocks.get(Math.floor(x), y - 1, Math.floor(z)), `${map.id} ${x},${y},${z}`).not.toBe(B.AIR);
      for (const p of map.points) expect(m.world.blocks.get(p[0], p[1] - 1, p[2]), `${map.id} centre`).not.toBe(B.AIR);
    }
  });

  it('a replay gets the same map back from the seed', () => {
    for (let seed = 1; seed < 6; seed++) {
      const a = new Match(kitById('itemsumo'), DIFFICULTIES.lt3, seed).mode as ItemSumo;
      const b = new Match(kitById('itemsumo'), DIFFICULTIES.lt3, seed).mode as ItemSumo;
      expect(a.mapId).toBe(b.mapId);
    }
  });

  it('games end with a winner, the bots playing every side, with items handed out', () => {
    for (const [seed, players] of [
      [1, 2],
      [2, 6],
      [3, 12],
    ]) {
      const m = new Match(kitById('itemsumo'), DIFFICULTIES.ht3, seed, undefined, players);
      m.externalMining = true;
      const pb: BotBrain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.ht3, new Rng(seed + 99), () => performAttack(m.player, pb.opponent));
      pb.attachSky(m);
      pb.resetRound();
      let items = 0;
      while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 6) {
        if (m.phase === 'fight') {
          pb.chooseTarget(m.enemiesOf(m.player));
          pb.tick();
          m.useHeld = pb.useHeld;
        }
        m.tick();
        for (const f of m.fighters) f.events.length = 0;
        m.world.events.length = 0;
        for (const a of m.mode!.takeAnnouncements()) if (a.text.includes('got an item')) items++;
      }
      expect(m.phase, `${players}`).toBe('ended');
      expect(m.winner, `${players}`).not.toBeNull();
      expect(items).toBeGreaterThan(0);
    }
  }, 600_000);
});

describe('duel arenas', () => {
  it('a box with a floor and a wall becomes an arena: floor at ground level, spawns facing each other in the open', async () => {
    const { makeArena } = await import('../src/maps/arena');
    const w = 40;
    const h = 12;
    const l = 40;
    const palette = ['air', 'grass_block', 'stone_bricks', 'oak_planks'];
    const data = new Uint16Array(w * h * l);
    const set = (x: number, y: number, z: number, i: number) => (data[x + z * w + y * w * l] = i);
    for (let z = 0; z < l; z++) for (let x = 0; x < w; x++) for (let y = 0; y <= 3; y++) set(x, y, z, 1);
    // A hut in the very middle: spawns must not end up inside it.
    for (let y = 4; y < 8; y++) for (let z = 17; z < 23; z++) for (let x = 17; x < 23; x++) set(x, y, z, x === 17 || x === 22 || z === 17 || z === 22 || y === 7 ? 3 : 0);
    const m = makeArena({ w, h, l, palette, data, format: 'test' }, { id: 't', name: 'T', credit: '' });
    const [a, b] = m.spawns;
    expect(a[1]).toBe(0);
    expect(b[1]).toBe(0);
    expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThanOrEqual(8);
    for (const s of [a, b]) expect(Math.max(Math.abs(s[0]), Math.abs(s[2])) > 3.5 || Math.min(Math.abs(s[0]), Math.abs(s[2])) > 3.5).toBe(true);
    expect(() => makeArena({ w: 4, h: 4, l: 4, palette: ['air'], data: new Uint16Array(64), format: 'test' }, { id: 'e', name: 'E', credit: '' })).toThrow();
  });

  it('a duel on each built-in arena: both on solid ground, and the bots fight it out', async () => {
    const { BUILTIN_ARENAS } = await import('../src/maps/builtinArenas');
    expect(BUILTIN_ARENAS.length).toBeGreaterThanOrEqual(5);
    for (const arena of BUILTIN_ARENAS) {
      expect(arena.license).toBe('CC BY-SA 4.0');
      const m = new Match(kitById('sword'), DIFFICULTIES.ht3, 3, undefined, undefined, arena);
      expect(m.arena).toBe(arena);
      for (const f of [m.player, m.bot]) expect(m.world.blocks.get(Math.floor(f.pos.x), Math.floor(f.pos.y) - 1, Math.floor(f.pos.z)), arena.id).not.toBe(B.AIR);
      const pb: BotBrain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.ht3, new Rng(7), () => performAttack(m.player, m.bot));
      pb.resetRound();
      while (m.phase !== 'ended' && m.tickCount < 20 * 120) {
        if (m.phase === 'fight') {
          pb.tick();
          m.useHeld = pb.useHeld;
        }
        m.tick();
        for (const f of m.fighters) f.events.length = 0;
        m.world.events.length = 0;
      }
      expect(m.phase, arena.id).toBe('ended');
    }
  }, 300_000);
});
