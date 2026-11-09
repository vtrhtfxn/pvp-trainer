import { B, type Blocks } from '../Blocks';

export interface Spot {
  x: number;
  y: number;
  z: number;
}

export interface SpawnSpot extends Spot {
  yaw: number;
}

function fill(b: Blocks, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, data = 0) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) b.set(x, y, z, id, data);
}

/**
 * A floating island: grass on top (y = -1), dirt under it, then stone that narrows into a
 * point underneath, like the islands on minigame maps. (x0..x1, z0..z1) is its top.
 */
export function island(b: Blocks, x0: number, z0: number, x1: number, z1: number, depth = 4) {
  fill(b, x0, -1, z0, x1, -1, z1, B.GRASS);
  fill(b, x0, -2, z0, x1, -2, z1, B.DIRT);
  for (let d = 3; d <= depth + 1; d++) {
    const inset = d - 2;
    if (x0 + inset > x1 - inset || z0 + inset > z1 - inset) break;
    fill(b, x0 + inset, -d, z0 + inset, x1 - inset, -d, z1 - inset, d === 3 ? B.DIRT : B.STONE);
  }
}

/** The mirror of a cell across the middle (z → −z−1): the blue side of a symmetric map. */
export function mirror(s: Spot): Spot {
  return { x: s.x, y: s.y, z: -s.z - 1 };
}

// ------------------------------------------------------------------ Bed Wars

/** Half-width of the world the minigames are built in (bigger than the 80×80 duel arena). */
export const MODE_WORLD_HALF = 64;

export interface BedwarsTeamLayout {
  spawn: SpawnSpot;
  /** Bed cells: foot, then head (toward the middle). */
  bed: [Spot, Spot];
  /** Where the island forge drops iron and gold. */
  gen: Spot;
  shop: Spot;
  /** The team's ender chest, beside the spawn (every ender chest opens your own storage). */
  enderChest: Spot;
}

export interface BedwarsLayout {
  teams: [BedwarsTeamLayout, BedwarsTeamLayout];
  diamonds: Spot[];
  emeralds: Spot[];
}

/**
 * "Far Shores", the Bed Wars map: two 13 × 13 bases 80 blocks apart, the bed tucked in at the
 * back behind the spawn, the forge at the front, the shop and an ender chest by the spawn. Four
 * diamond islands sit out to the sides, and a big middle island has two emerald generators and
 * pillars to fight around. Everything between is void: bridge across.
 */
export function buildBedwarsMap(b: Blocks): BedwarsLayout {
  b.clear();
  const base = (sign: 1 | -1): BedwarsTeamLayout => {
    // Red is +z, blue −z; every z is mirrored as z → −z−1 so the halves match cell for cell.
    const Z = (z: number) => (sign > 0 ? z : -z - 1);
    island(b, -6, Math.min(Z(40), Z(52)), 6, Math.max(Z(40), Z(52)), 6);
    // Forge pad at the front corner.
    fill(b, -5, -1, Math.min(Z(41), Z(42)), -3, -1, Math.max(Z(41), Z(42)), B.COBBLESTONE);
    // The bed at the back, head toward the middle: you have to cross the whole base for it.
    const foot = { x: 0, y: 0, z: Z(50) };
    const head = { x: 0, y: 0, z: Z(49) };
    const team = sign > 0 ? 0 : 1;
    const neg = sign > 0 ? 8 : 0; // red's head points to −z, blue's to +z
    b.set(foot.x, foot.y, foot.z, B.BED, team | neg);
    b.set(head.x, head.y, head.z, B.BED, team | 2 | neg);
    const shop = { x: 4, y: 0, z: Z(45) };
    b.set(shop.x, shop.y, shop.z, B.SHOP);
    const enderChest = { x: -4, y: 0, z: Z(45) };
    b.set(enderChest.x, enderChest.y, enderChest.z, B.ENDER_CHEST);
    return {
      spawn: { x: 0.5, y: 0, z: Z(45) + 0.5, yaw: sign > 0 ? 0 : Math.PI },
      bed: [foot, head],
      gen: { x: -3.5, y: 0.05, z: Z(41) + 0.5 + (sign > 0 ? 0.5 : -0.5) },
      shop,
      enderChest,
    };
  };
  const red = base(1);
  const blue = base(-1);
  // Middle: two emerald generators, with pillars to fight around.
  island(b, -8, -9, 8, 8, 6);
  for (const [x, z] of [
    [-6, -7],
    [6, -7],
    [-6, 6],
    [6, 6],
    [-2, -4],
    [2, 3],
  ])
    fill(b, x, 0, z, x, 2, z, B.STONE);
  const emeralds: Spot[] = [];
  for (const x of [-4, 4]) {
    fill(b, x - 1, -1, -1, x, -1, 0, B.COBBLESTONE);
    emeralds.push({ x, y: 0.05, z: 0 });
  }
  // Four diamond islands, two on each side, out of the way of the straight line between bases.
  const diamonds: Spot[] = [];
  for (const sx of [-1, 1])
    for (const sign of [1, -1] as const) {
      const Z = (z: number) => (sign > 0 ? z : -z - 1);
      const cx = sx * 26;
      island(b, cx - 3, Math.min(Z(20), Z(25)), cx + 3, Math.max(Z(20), Z(25)), 4);
      fill(b, cx - 1, -1, Math.min(Z(22), Z(23)), cx, -1, Math.max(Z(22), Z(23)), B.COBBLESTONE);
      diamonds.push({ x: cx, y: 0.05, z: Z(22) + (sign > 0 ? 1 : 0) });
    }
  return { teams: [red, blue], diamonds, emeralds };
}

// ------------------------------------------------------------------ SkyWars

export interface SkywarsLayout {
  /** Where each fighter waits in its glass cage. */
  spawns: [SpawnSpot, SpawnSpot];
  /** Cage cells per team (removed when the game starts). */
  cages: [Spot[], Spot[]];
  /** Island chests (3 per spawn island), then the middle's. */
  islandChests: [Spot[], Spot[]];
  midChests: Spot[];
}

/**
 * "Sky Archipelago", the SkyWars map: two spawn islands 64 blocks apart with three chests each;
 * a big middle island with four better chests on a raised centre; and six small islands (two
 * beside the middle, four out on the corners) with a chest each, counted as middle loot. Players
 * start in glass cages that open when the countdown ends.
 */
export function buildSkywarsMap(b: Blocks, wide = false): SkywarsLayout {
  b.clear();
  const spawnIsland = (sign: 1 | -1) => {
    const Z = (z: number) => (sign > 0 ? z : -z - 1);
    island(b, -4, Math.min(Z(29), Z(37)), 4, Math.max(Z(29), Z(37)), 5);
    // A little tree at the back corner.
    fill(b, -4, 0, Z(37), -4, 3, Z(37), B.OAK_LOG);
    const chests = [
      { x: -3, y: 0, z: Z(36) },
      { x: 3, y: 0, z: Z(36) },
      { x: 4, y: 0, z: Z(30) },
    ];
    for (const c of chests) b.set(c.x, c.y, c.z, B.CHEST);
    // Glass cage above the middle of the island: floor at y = 1, walls, roof at y = 4. A 2v2
    // team's cage is two wide, one player in each half.
    const cz = Z(33);
    const cage: Spot[] = [];
    const x1 = wide ? 2 : 1;
    for (let y = 1; y <= 4; y++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= x1; dx++) {
          const wall = dx === -1 || dx === x1 || dz !== 0;
          if ((y === 1 || y === 4) || wall) {
            if (y > 1 && y < 4 && !wall) continue;
            b.set(dx, y, cz + dz, B.GLASS);
            cage.push({ x: dx, y, z: cz + dz });
          }
        }
    return { spawn: { x: 0.5, y: 2, z: cz + 0.5, yaw: sign > 0 ? 0 : Math.PI }, chests, cage };
  };
  const red = spawnIsland(1);
  const blue = spawnIsland(-1);
  // Middle: 15 × 15 with a raised 3 × 3 centre.
  island(b, -7, -8, 7, 7, 7);
  fill(b, -1, 0, -2, 1, 0, 1, B.STONE);
  const midChests = [
    { x: -4, y: 0, z: -5 },
    { x: 4, y: 0, z: 4 },
    { x: -4, y: 0, z: 4 },
    { x: 4, y: 0, z: -5 },
  ];
  // Beside the middle…
  for (const sx of [-1, 1]) {
    const cx = sx * 20;
    island(b, cx - 2, -3, cx + 2, 2, 3);
    midChests.push({ x: cx, y: 0, z: -1 });
  }
  // …and out on the four corners, halfway to the spawns.
  for (const sx of [-1, 1])
    for (const sign of [1, -1]) {
      const cx = sx * 24;
      const z = sign > 0 ? 18 : -19;
      island(b, cx - 2, z - 2, cx + 2, z + 2, 3);
      midChests.push({ x: cx, y: 0, z });
    }
  for (const c of midChests) b.set(c.x, c.y, c.z, B.CHEST);
  return {
    spawns: [red.spawn, blue.spawn],
    cages: [red.cage, blue.cage],
    islandChests: [red.chests, blue.chests],
    midChests,
  };
}
