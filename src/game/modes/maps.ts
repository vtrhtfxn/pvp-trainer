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

export interface BedwarsTeamLayout {
  spawn: SpawnSpot;
  /** Bed cells: foot, then head (toward the middle). */
  bed: [Spot, Spot];
  /** Where the island forge drops iron and gold. */
  gen: Spot;
  shop: Spot;
}

export interface BedwarsLayout {
  teams: [BedwarsTeamLayout, BedwarsTeamLayout];
  diamonds: Spot[];
  emeralds: Spot[];
}

/**
 * "Twin Isles", a 1v1 Bed Wars map: two bases 44 blocks apart with a bed at the front, the
 * forge at the back and the shop on the side; a middle island with the emerald generator and
 * two diamond islands off to the sides. Everything between is void — bridge across.
 */
export function buildBedwarsMap(b: Blocks): BedwarsLayout {
  b.clear();
  const base = (sign: 1 | -1): BedwarsTeamLayout => {
    // Red is +z, blue −z; every z is mirrored as z → −z−1 so the halves match cell for cell.
    const Z = (z: number) => (sign > 0 ? z : -z - 1);
    island(b, -5, Math.min(Z(22), Z(30)), 5, Math.max(Z(22), Z(30)), 5);
    // Forge pad at the back.
    fill(b, -1, -1, Math.min(Z(29), Z(30)), 1, -1, Math.max(Z(29), Z(30)), B.COBBLESTONE);
    // The bed at the front, head toward the middle.
    const foot = { x: 0, y: 0, z: Z(24) };
    const head = { x: 0, y: 0, z: Z(23) };
    const team = sign > 0 ? 0 : 1;
    const neg = sign > 0 ? 8 : 0; // red's head points to −z, blue's to +z
    b.set(foot.x, foot.y, foot.z, B.BED, team | neg);
    b.set(head.x, head.y, head.z, B.BED, team | 2 | neg);
    const shop = { x: 4, y: 0, z: Z(27) };
    b.set(shop.x, shop.y, shop.z, B.SHOP);
    return {
      spawn: { x: 0.5, y: 0, z: Z(27) + 0.5, yaw: sign > 0 ? 0 : Math.PI },
      bed: [foot, head],
      gen: { x: 0.5, y: 0.05, z: Z(29) + 0.5 + (sign > 0 ? 0.5 : -0.5) },
      shop,
    };
  };
  const red = base(1);
  const blue = base(-1);
  // Middle: emeralds, with a pillar at each corner to fight around.
  island(b, -4, -5, 4, 4, 5);
  for (const [x, z] of [
    [-3, -4],
    [3, -4],
    [-3, 3],
    [3, 3],
  ])
    fill(b, x, 0, z, x, 2, z, B.STONE);
  fill(b, -1, -1, -2, 1, -1, 1, B.COBBLESTONE);
  // Diamond islands.
  for (const sx of [-1, 1]) {
    const cx = sx * 18;
    island(b, cx - 2, -3, cx + 2, 2, 3);
    b.set(cx, -1, -1, B.COBBLESTONE);
    b.set(cx, -1, 0, B.COBBLESTONE);
  }
  return {
    teams: [red, blue],
    diamonds: [
      { x: -17.5, y: 0.05, z: 0 },
      { x: 18.5, y: 0.05, z: 0 },
    ],
    emeralds: [{ x: 0.5, y: 0.05, z: 0 }],
  };
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
 * "Floating Pair", a 1v1 SkyWars map: two spawn islands with three chests each, a middle island
 * with four better chests on a raised centre, and two small side islands with one chest each
 * (counted as middle loot). Players start in glass cages that open when the countdown ends.
 */
export function buildSkywarsMap(b: Blocks): SkywarsLayout {
  b.clear();
  const spawnIsland = (sign: 1 | -1) => {
    const Z = (z: number) => (sign > 0 ? z : -z - 1);
    island(b, -3, Math.min(Z(19), Z(25)), 3, Math.max(Z(19), Z(25)), 4);
    // A little tree at the back corner.
    fill(b, -3, 0, Z(25), -3, 3, Z(25), B.OAK_LOG);
    const chests = [
      { x: -2, y: 0, z: Z(24) },
      { x: 2, y: 0, z: Z(24) },
      { x: 3, y: 0, z: Z(20) },
    ];
    for (const c of chests) b.set(c.x, c.y, c.z, B.CHEST);
    // Glass cage above the middle of the island: floor at y = 1, walls, roof at y = 4.
    const cz = Z(22);
    const cage: Spot[] = [];
    for (let y = 1; y <= 4; y++)
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const wall = dx !== 0 || dz !== 0;
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
  // Middle: 11 × 11 with a raised 3 × 3 centre.
  island(b, -5, -6, 5, 5, 6);
  fill(b, -1, 0, -2, 1, 0, 1, B.STONE);
  const midChests = [
    { x: -3, y: 0, z: -4 },
    { x: 3, y: 0, z: 3 },
    { x: -3, y: 0, z: 3 },
    { x: 3, y: 0, z: -4 },
  ];
  for (const sx of [-1, 1]) {
    const cx = sx * 16;
    island(b, cx - 2, -3, cx + 2, 2, 3);
    midChests.push({ x: cx, y: 0, z: -1 });
  }
  for (const c of midChests) b.set(c.x, c.y, c.z, B.CHEST);
  return {
    spawns: [red.spawn, blue.spawn],
    cages: [red.cage, blue.cage],
    islandChests: [red.chests, blue.chests],
    midChests,
  };
}
