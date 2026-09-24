/**
 * The blocks players place inside the arena (UHC): solid blocks, cobwebs and water/lava with
 * vanilla-style flowing. The grass floor (y < 0) and the walls around the arena behave as
 * unbreakable solid blocks; everything in the grid was placed by a player, so it can be broken
 * ("map breaking disabled" only protects the map itself).
 */

export const B = {
  AIR: 0,
  PLANKS: 1,
  COBWEB: 2,
  COBBLESTONE: 3,
  OBSIDIAN: 4,
  STONE: 5,
  WATER: 6,
  LAVA: 7,
  GLOWSTONE: 8,
  /** Respawn anchor; its charge (0–4) lives in the amount array. */
  RESPAWN_ANCHOR: 9,
  ENDER_CHEST: 10,
  /** Fire (from respawn-anchor explosions); its age lives in the amount array. */
  FIRE: 11,
  /** A diggable floor (Crystal): grass on top, dirt below. */
  GRASS: 12,
  DIRT: 13,
  /** Floor and walls: solid, unbreakable, never stored. */
  BEDROCK: 255,
} as const;
export type FluidId = typeof B.WATER | typeof B.LAVA;

export type BlockName =
  | 'oak_planks'
  | 'cobweb'
  | 'cobblestone'
  | 'obsidian'
  | 'stone'
  | 'water'
  | 'lava'
  | 'glowstone'
  | 'respawn_anchor'
  | 'ender_chest'
  | 'fire'
  | 'grass_block'
  | 'dirt';

export const BLOCK_NAMES: Record<number, BlockName> = {
  [B.PLANKS]: 'oak_planks',
  [B.COBWEB]: 'cobweb',
  [B.COBBLESTONE]: 'cobblestone',
  [B.OBSIDIAN]: 'obsidian',
  [B.STONE]: 'stone',
  [B.WATER]: 'water',
  [B.LAVA]: 'lava',
  [B.GLOWSTONE]: 'glowstone',
  [B.RESPAWN_ANCHOR]: 'respawn_anchor',
  [B.ENDER_CHEST]: 'ender_chest',
  [B.FIRE]: 'fire',
  [B.GRASS]: 'grass_block',
  [B.DIRT]: 'dirt',
};

export interface BlockProps {
  /** Block hardness (Blocks.java). */
  hardness: number;
  /** Which tool mines it quickly. */
  tool: 'axe' | 'pickaxe' | 'sword' | null;
  /** Drops nothing unless mined with that tool (requiresCorrectToolForDrops). */
  needsTool: boolean;
  /** Item it drops (null: nothing). */
  drop: 'oak_planks' | 'cobblestone' | 'obsidian' | 'glowstone' | 'respawn_anchor' | 'ender_chest' | null;
}

/**
 * Explosion resistance (Block.getExplosionResistance). An explosion ray loses
 * (resistance + 0.3) × 0.3 per 0.3-block step through a block, so obsidian, anchors and ender
 * chests shrug off crystals while planks and glowstone are blown away.
 */
export function blastResistance(id: number): number {
  switch (id) {
    case B.AIR:
    case B.FIRE:
      return 0;
    case B.GLOWSTONE:
      return 0.3;
    case B.DIRT:
      return 0.5;
    case B.GRASS:
      return 0.6;
    case B.PLANKS:
      return 3;
    case B.COBWEB:
      return 4;
    case B.COBBLESTONE:
    case B.STONE:
      return 6;
    case B.WATER:
    case B.LAVA:
      return 100;
    case B.ENDER_CHEST:
      return 600;
    case B.OBSIDIAN:
    case B.RESPAWN_ANCHOR:
      return 1200;
    default:
      return 3600000; // the floor and the walls
  }
}

export const BLOCK_PROPS: Record<number, BlockProps> = {
  [B.PLANKS]: { hardness: 2, tool: 'axe', needsTool: false, drop: 'oak_planks' },
  // A sword breaks webs fast but they drop string, not the web: webs are used up.
  [B.COBWEB]: { hardness: 4, tool: 'sword', needsTool: true, drop: null },
  [B.COBBLESTONE]: { hardness: 2, tool: 'pickaxe', needsTool: true, drop: 'cobblestone' },
  [B.STONE]: { hardness: 1.5, tool: 'pickaxe', needsTool: true, drop: 'cobblestone' },
  [B.OBSIDIAN]: { hardness: 50, tool: 'pickaxe', needsTool: true, drop: 'obsidian' },
  [B.GLOWSTONE]: { hardness: 0.3, tool: null, needsTool: false, drop: 'glowstone' },
  [B.RESPAWN_ANCHOR]: { hardness: 50, tool: 'pickaxe', needsTool: true, drop: 'respawn_anchor' },
  // The kit's pickaxe has Silk Touch, so an ender chest comes back whole.
  [B.ENDER_CHEST]: { hardness: 22.5, tool: 'pickaxe', needsTool: true, drop: 'ender_chest' },
  // The kit has no shovel: the ground is dug by hand (grass 0.9 s, dirt 0.75 s).
  [B.GRASS]: { hardness: 0.6, tool: null, needsTool: false, drop: null },
  [B.DIRT]: { hardness: 0.5, tool: null, needsTool: false, drop: null },
};

export function isSolid(id: number): boolean {
  return (
    id === B.PLANKS ||
    id === B.COBBLESTONE ||
    id === B.OBSIDIAN ||
    id === B.STONE ||
    id === B.GLOWSTONE ||
    id === B.RESPAWN_ANCHOR ||
    id === B.ENDER_CHEST ||
    id === B.GRASS ||
    id === B.DIRT ||
    id === B.BEDROCK
  );
}
export function isFluid(id: number): boolean {
  return id === B.WATER || id === B.LAVA;
}

export interface RayHit {
  /** Distance along the (unit) ray. */
  t: number;
  x: number;
  y: number;
  z: number;
  /** Face normal of the side that was hit. */
  nx: number;
  ny: number;
  nz: number;
  id: number;
}

export type RayMode = 'collider' | 'outline' | 'source';

/** Water: every 5 ticks, 1 level per block, finds drops 4 blocks away. Lava (overworld): 30 ticks, 2 levels, 2 blocks. */
const FLUID = {
  [B.WATER]: { delay: 5, drop: 1, slope: 4 },
  [B.LAVA]: { delay: 30, drop: 2, slope: 2 },
} as const;

/** Remesh granularity: 16×16 block columns. */
export const CHUNK = 16;

const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export class Blocks {
  readonly sx: number;
  readonly sz: number;
  readonly id: Uint8Array;
  /** Fluid amount 1–8 (a source is 8). */
  readonly amount: Uint8Array;
  /** bit 0: source, bit 1: falling. */
  readonly flags: Uint8Array;
  /** Bumped on every change, so the renderer knows when to remesh. */
  version = 0;
  /** Number of non-air cells: 0 lets collision take the flat-arena fast path. */
  count = 0;
  /** Online server: indices of cells changed since the clients last heard (null = not logging). */
  changeLog: Set<number> | null = null;
  private readonly scheduled = new Map<number, number>();
  now = 0;
  /** Called when a block is replaced by fluid or converted (e.g. lava + water) — for particles/sound. */
  onChange: ((x: number, y: number, z: number, from: number, to: number) => void) | null = null;

  /** Chunks (16×16 columns) changed since the renderer last looked. */
  readonly dirty = new Set<number>();

  constructor(
    readonly half: number,
    readonly height: number,
    /** Layers of diggable ground under y = 0 (Crystal); 0 keeps the floor unbreakable. */
    readonly depth = 0,
  ) {
    this.sx = half * 2;
    this.sz = half * 2;
    const n = this.sx * this.sz * (height + depth);
    this.id = new Uint8Array(n);
    this.amount = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.clear();
  }

  clear() {
    this.id.fill(0);
    this.amount.fill(0);
    this.flags.fill(0);
    this.scheduled.clear();
    this.count = 0;
    // Ground: grass on top, dirt under it (bedrock below that).
    const layer = this.sx * this.sz;
    for (let d = 1; d <= this.depth; d++) this.id.fill(d === 1 ? B.GRASS : B.DIRT, (this.depth - d) * layer, (this.depth - d + 1) * layer);
    this.count = this.depth * layer;
    for (let cx = 0; cx < this.sx / CHUNK; cx++) for (let cz = 0; cz < this.sz / CHUNK; cz++) this.dirty.add(cx * 1024 + cz);
    this.version++;
  }

  /** Chunk key of a cell (for partial remeshing). */
  static chunkKey(x: number, z: number, half: number): number {
    return Math.floor((x + half) / CHUNK) * 1024 + Math.floor((z + half) / CHUNK);
  }

  private markDirty(x: number, z: number) {
    const h = this.half;
    this.dirty.add(Blocks.chunkKey(x, z, h));
    // Faces are culled against neighbours: a change on a chunk edge touches the next chunk too.
    const lx = (x + h) % CHUNK;
    const lz = (z + h) % CHUNK;
    if (lx === 0 && x > -h) this.dirty.add(Blocks.chunkKey(x - 1, z, h));
    if (lx === CHUNK - 1 && x < h - 1) this.dirty.add(Blocks.chunkKey(x + 1, z, h));
    if (lz === 0 && z > -h) this.dirty.add(Blocks.chunkKey(x, z - 1, h));
    if (lz === CHUNK - 1 && z < h - 1) this.dirty.add(Blocks.chunkKey(x, z + 1, h));
  }

  inside(x: number, y: number, z: number): boolean {
    return x >= -this.half && x < this.half && z >= -this.half && z < this.half && y >= -this.depth && y < this.height;
  }

  private index(x: number, y: number, z: number): number {
    return (((y + this.depth) * this.sz + (z + this.half)) * this.sx + (x + this.half)) | 0;
  }

  /** Block at a cell; below the ground and outside the walls is BEDROCK, the sky is air. */
  get(x: number, y: number, z: number): number {
    if (y < -this.depth) return B.BEDROCK;
    if (x < -this.half || x >= this.half || z < -this.half || z >= this.half) return B.BEDROCK;
    if (y >= this.height) return B.AIR;
    return this.id[this.index(x, y, z)];
  }

  isSource(x: number, y: number, z: number): boolean {
    return this.inside(x, y, z) && (this.flags[this.index(x, y, z)] & 1) !== 0;
  }
  isFalling(x: number, y: number, z: number): boolean {
    return this.inside(x, y, z) && (this.flags[this.index(x, y, z)] & 2) !== 0;
  }
  fluidAmount(x: number, y: number, z: number): number {
    return this.inside(x, y, z) ? this.amount[this.index(x, y, z)] : 0;
  }

  /** Height of the fluid surface inside its cell: source 8/9, flowing amount/9, falling 1. */
  fluidHeight(x: number, y: number, z: number): number {
    const id = this.get(x, y, z);
    if (!isFluid(id)) return 0;
    if (this.get(x, y + 1, z) === id) return 1;
    return this.fluidAmount(x, y, z) / 9;
  }

  set(x: number, y: number, z: number, id: number, amount = 0, source = false, falling = false) {
    if (!this.inside(x, y, z)) return;
    const i = this.index(x, y, z);
    const before = this.id[i];
    if (before === B.AIR && id !== B.AIR) this.count++;
    else if (before !== B.AIR && id === B.AIR) this.count--;
    this.id[i] = id;
    this.amount[i] = isFluid(id) || id === B.RESPAWN_ANCHOR || id === B.FIRE ? amount : 0;
    this.flags[i] = isFluid(id) ? (source ? 1 : 0) | (falling ? 2 : 0) : 0;
    this.version++;
    this.markDirty(x, z);
    this.changeLog?.add(i);
    // Wake up this cell's fluid and any fluid next to it.
    this.scheduleAround(x, y, z);
  }

  /**
   * Swaps a cell's id without marking anything changed, for "what if" checks (the bot's damage
   * estimates). Returns the old id; put it back with another call before anything else runs.
   */
  swapTemp(x: number, y: number, z: number, id: number): number {
    if (!this.inside(x, y, z)) return this.get(x, y, z);
    const i = this.index(x, y, z);
    const before = this.id[i];
    if (before === B.AIR && id !== B.AIR) this.count++;
    else if (before !== B.AIR && id === B.AIR) this.count--;
    this.id[i] = id;
    return before;
  }

  /** One cell as [index, id, amount, flags] for the wire. */
  cellData(i: number): [number, number, number, number] {
    return [i, this.id[i], this.amount[i], this.flags[i]];
  }

  /** Online client: writes a cell exactly as the server has it (no fluid updates scheduled). */
  applyCell(i: number, id: number, amount: number, flags: number) {
    if (!(i >= 0 && i < this.id.length)) return;
    const before = this.id[i];
    if (before === B.AIR && id !== B.AIR) this.count++;
    else if (before !== B.AIR && id === B.AIR) this.count--;
    this.id[i] = id;
    this.amount[i] = amount;
    this.flags[i] = flags;
    this.version++;
    const x = (i % this.sx) - this.half;
    const z = (Math.floor(i / this.sx) % this.sz) - this.half;
    this.markDirty(x, z);
  }

  placeSource(x: number, y: number, z: number, fluid: FluidId) {
    this.set(x, y, z, fluid, 8, true, false);
    if (fluid === B.LAVA) this.checkLavaMeetsWater(x, y, z);
    else this.wakeLavaAround(x, y, z);
  }

  /** Respawn anchor charge, 0–4. */
  anchorCharge(x: number, y: number, z: number): number {
    return this.get(x, y, z) === B.RESPAWN_ANCHOR ? this.amount[this.index(x, y, z)] : 0;
  }
  setAnchorCharge(x: number, y: number, z: number, charge: number) {
    if (this.get(x, y, z) !== B.RESPAWN_ANCHOR) return;
    const i = this.index(x, y, z);
    this.amount[i] = charge;
    this.version++;
    this.markDirty(x, z);
    this.changeLog?.add(i);
  }

  private seed = 12345;
  private rand(n: number): number {
    this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
    return (this.seed >>> 16) % n;
  }

  private schedule(x: number, y: number, z: number) {
    const id = this.get(x, y, z);
    if ((!isFluid(id) && id !== B.FIRE) || !this.inside(x, y, z)) return;
    const k = this.index(x, y, z);
    // FireBlock ticks every 30–39 ticks.
    const due = this.now + (id === B.FIRE ? 30 + this.rand(10) : FLUID[id as FluidId].delay);
    const cur = this.scheduled.get(k);
    if (cur === undefined || cur > due) this.scheduled.set(k, due);
  }

  private scheduleAround(x: number, y: number, z: number) {
    this.schedule(x, y, z);
    this.schedule(x + 1, y, z);
    this.schedule(x - 1, y, z);
    this.schedule(x, y + 1, z);
    this.schedule(x, y - 1, z);
    this.schedule(x, y, z + 1);
    this.schedule(x, y, z - 1);
  }

  private wakeLavaAround(x: number, y: number, z: number) {
    for (const [dx, dy, dz] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ]) {
      if (this.get(x + dx, y + dy, z + dz) === B.LAVA) this.checkLavaMeetsWater(x + dx, y + dy, z + dz);
    }
  }

  /**
   * LiquidBlock.shouldSpreadLiquid for lava: water beside or above it hardens a source into
   * obsidian and flowing lava into cobblestone.
   */
  private checkLavaMeetsWater(x: number, y: number, z: number): boolean {
    if (this.get(x, y, z) !== B.LAVA) return false;
    const touches =
      this.get(x + 1, y, z) === B.WATER ||
      this.get(x - 1, y, z) === B.WATER ||
      this.get(x, y, z + 1) === B.WATER ||
      this.get(x, y, z - 1) === B.WATER ||
      this.get(x, y + 1, z) === B.WATER;
    if (!touches) return false;
    const to = this.isSource(x, y, z) ? B.OBSIDIAN : B.COBBLESTONE;
    this.set(x, y, z, to);
    this.onChange?.(x, y, z, B.LAVA, to);
    return true;
  }

  // ---------------------------------------------------------------- fluid ticking

  /** Runs every game tick: processes the fluid updates that are due. */
  tick() {
    this.now++;
    if (!this.scheduled.size) return;
    const due: number[] = [];
    for (const [k, t] of this.scheduled) if (t <= this.now) due.push(k);
    if (!due.length) return;
    for (const k of due) this.scheduled.delete(k);
    for (const k of due) {
      const x = (k % this.sx) - this.half;
      const z = (Math.floor(k / this.sx) % this.sz) - this.half;
      const y = Math.floor(k / (this.sx * this.sz)) - this.depth;
      this.tickFluid(x, y, z);
    }
  }

  /**
   * FireBlock.tick on a non-flammable surface: the fire ages by 0–1 every run and goes out once
   * it is older than 3 (about 20 seconds), or at once with nothing solid under it.
   */
  private tickFire(x: number, y: number, z: number) {
    if (!isSolid(this.get(x, y - 1, z))) {
      this.set(x, y, z, B.AIR);
      return;
    }
    const i = this.index(x, y, z);
    const age = this.amount[i];
    if (age > 3) {
      this.set(x, y, z, B.AIR);
      return;
    }
    this.amount[i] = Math.min(15, age + (this.rand(3) >> 1));
    this.schedule(x, y, z);
  }

  /** FlowingFluid.tick: settle this cell's level from its neighbours, then spread. */
  private tickFluid(x: number, y: number, z: number) {
    const id = this.get(x, y, z);
    if (id === B.FIRE) {
      this.tickFire(x, y, z);
      return;
    }
    if (!isFluid(id)) return;
    if (id === B.LAVA && this.checkLavaMeetsWater(x, y, z)) return;
    if (!this.isSource(x, y, z)) {
      const next = this.newLiquid(x, y, z, id);
      if (!next) {
        this.set(x, y, z, B.AIR);
        return;
      }
      if (next.amount !== this.fluidAmount(x, y, z) || next.source !== this.isSource(x, y, z) || next.falling !== this.isFalling(x, y, z)) {
        this.set(x, y, z, id, next.amount, next.source, next.falling);
      }
    }
    this.spread(x, y, z, id);
  }

  /** FlowingFluid.getNewLiquid. */
  private newLiquid(x: number, y: number, z: number, fluid: number): { amount: number; source: boolean; falling: boolean } | null {
    const F = FLUID[fluid as FluidId];
    let best = 0;
    let sources = 0;
    for (const [dx, dz] of DIRS) {
      if (this.get(x + dx, y, z + dz) !== fluid) continue;
      if (this.isSource(x + dx, y, z + dz)) sources++;
      best = Math.max(best, this.fluidAmount(x + dx, y, z + dz));
    }
    // Infinite water: two sources beside a cell with something solid (or a source) under it.
    if (fluid === B.WATER && sources >= 2) {
      const below = this.get(x, y - 1, z);
      if (isSolid(below) || (below === B.WATER && this.isSource(x, y - 1, z))) return { amount: 8, source: true, falling: false };
    }
    if (this.get(x, y + 1, z) === fluid) return { amount: 8, source: false, falling: true };
    const k = best - F.drop;
    return k <= 0 ? null : { amount: k, source: false, falling: false };
  }

  private canHold(x: number, y: number, z: number): boolean {
    const id = this.get(x, y, z);
    return this.inside(x, y, z) && (id === B.AIR || id === B.COBWEB || id === B.FIRE || isFluid(id));
  }

  /** FlowingFluid.spread: down first; sideways only for sources or when it cannot fall. */
  private spread(x: number, y: number, z: number, fluid: number) {
    const F = FLUID[fluid as FluidId];
    const falling = this.isFalling(x, y, z);
    const amount = this.fluidAmount(x, y, z);
    let down = false;
    if (this.canHold(x, y - 1, z)) {
      down = this.spreadTo(x, y - 1, z, fluid, 8, true, true);
    }
    if (down && !this.isSource(x, y, z)) return;
    const k = (falling ? 8 : amount) - F.drop;
    if (k <= 0) return;
    for (const [dx, dz] of this.spreadDirs(x, y, z, fluid)) this.spreadTo(x + dx, y, z + dz, fluid, k, false, false);
  }

  /** Writes fluid into a neighbour if it raises it (and handles lava/water meeting). */
  private spreadTo(x: number, y: number, z: number, fluid: number, amount: number, falling: boolean, downward: boolean): boolean {
    if (!this.canHold(x, y, z)) return false;
    const cur = this.get(x, y, z);
    if (isFluid(cur) && cur !== fluid) {
      if (fluid === B.LAVA && cur === B.WATER && downward) {
        // Lava pouring down into water turns it to stone.
        this.set(x, y, z, B.STONE);
        this.onChange?.(x, y, z, B.WATER, B.STONE);
        return true;
      }
      if (fluid === B.WATER && cur === B.LAVA) this.checkLavaMeetsWater(x, y, z);
      return false;
    }
    if (cur === fluid) {
      if (this.isSource(x, y, z)) return false;
      if (!falling && (this.isFalling(x, y, z) || this.fluidAmount(x, y, z) >= amount)) return false;
      if (falling && this.isFalling(x, y, z)) return false;
    }
    if (cur === B.COBWEB) this.onChange?.(x, y, z, B.COBWEB, fluid);
    this.set(x, y, z, fluid, amount, false, falling);
    if (fluid === B.LAVA) this.checkLavaMeetsWater(x, y, z);
    else this.wakeLavaAround(x, y, z);
    return true;
  }

  /** FlowingFluid.getSpread: prefer the directions with the shortest way down (a hole). */
  private spreadDirs(x: number, y: number, z: number, fluid: number): [number, number][] {
    const F = FLUID[fluid as FluidId];
    let best = 1000;
    const out: [number, number][] = [];
    for (const [dx, dz] of DIRS) {
      const nx = x + dx;
      const nz = z + dz;
      if (!this.canHold(nx, y, nz) || (this.get(nx, y, nz) === fluid && this.isSource(nx, y, nz))) continue;
      const d = this.canHold(nx, y - 1, nz) ? 0 : this.slopeDistance(nx, y, nz, 1, -dx, -dz, F.slope);
      if (d < best) {
        best = d;
        out.length = 0;
      }
      if (d === best) out.push([dx, dz]);
    }
    return out;
  }

  private slopeDistance(x: number, y: number, z: number, depth: number, fromX: number, fromZ: number, max: number): number {
    let best = 1000;
    for (const [dx, dz] of DIRS) {
      if (dx === fromX && dz === fromZ) continue;
      const nx = x + dx;
      const nz = z + dz;
      if (!this.canHold(nx, y, nz)) continue;
      if (this.canHold(nx, y - 1, nz)) return depth;
      if (depth < max) best = Math.min(best, this.slopeDistance(nx, y, nz, depth + 1, -dx, -dz, max));
    }
    return best;
  }

  // ---------------------------------------------------------------- queries for entities

  /** True if any cell overlapping the box has this id (fluids: below their surface). */
  boxTouches(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, id: number): boolean {
    if (!this.count) return false;
    const x0 = Math.max(-this.half - 1, Math.floor(minX));
    const x1 = Math.min(this.half, Math.floor(maxX - 1e-7));
    const y0 = Math.max(-this.depth, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.floor(maxY - 1e-7));
    const z0 = Math.max(-this.half - 1, Math.floor(minZ));
    const z1 = Math.min(this.half, Math.floor(maxZ - 1e-7));
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (this.get(x, y, z) !== id) continue;
          if (!isFluid(id) || minY < y + this.fluidHeight(x, y, z)) return true;
        }
    return false;
  }

  /** True if a solid block (or the floor / a wall) overlaps the box. */
  boxHasSolid(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): boolean {
    for (let y = Math.floor(minY); y <= Math.floor(maxY - 1e-7); y++)
      for (let z = Math.floor(minZ); z <= Math.floor(maxZ - 1e-7); z++)
        for (let x = Math.floor(minX); x <= Math.floor(maxX - 1e-7); x++) if (isSolid(this.get(x, y, z))) return true;
    return false;
  }

  /**
   * Average water/lava flow over the cells the box touches (Entity.updateFluidHeightAndDoFluidPushing):
   * each cell pushes from higher neighbours toward lower ones. Returns the summed flow and the
   * number of cells, and writes the deepest submersion into `depth`.
   */
  fluidPush(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, fluid: number, out: { x: number; z: number; n: number; depth: number }) {
    out.x = out.z = out.depth = 0;
    out.n = 0;
    if (!this.count) return out;
    const x0 = Math.max(-this.half - 1, Math.floor(minX));
    const x1 = Math.min(this.half, Math.floor(maxX - 1e-7));
    const y0 = Math.max(-this.depth, Math.floor(minY));
    const y1 = Math.min(this.height - 1, Math.floor(maxY - 1e-7));
    const z0 = Math.max(-this.half - 1, Math.floor(minZ));
    const z1 = Math.min(this.half, Math.floor(maxZ - 1e-7));
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) {
          if (this.get(x, y, z) !== fluid) continue;
          const h = this.fluidHeight(x, y, z);
          const top = y + h;
          if (top < minY) continue;
          out.depth = Math.max(out.depth, top - minY);
          let fx = 0;
          let fz = 0;
          for (const [dx, dz] of DIRS) {
            const n = this.get(x + dx, y, z + dz);
            let nh: number;
            if (n === fluid) nh = this.fluidHeight(x + dx, y, z + dz);
            else if (!isSolid(n) && this.get(x + dx, y - 1, z + dz) === fluid) nh = this.fluidHeight(x + dx, y - 1, z + dz) - 0.8888889;
            else if (!isSolid(n)) nh = 0;
            else continue;
            const d = h - nh;
            fx += dx * d;
            fz += dz * d;
          }
          const len = Math.hypot(fx, fz);
          if (len > 1e-6 && !this.isSource(x, y, z)) {
            out.x += fx / len;
            out.z += fz / len;
            out.n++;
          } else out.n++;
        }
    return out;
  }

  // ---------------------------------------------------------------- collision

  /**
   * Entity.collide: clips a movement against every solid block (plus the floor and walls), Y
   * first, then the larger horizontal axis. `hw` is half the box width, `h` its height.
   */
  collide(x: number, y: number, z: number, dx: number, dy: number, dz: number, hw: number, h: number, out: CollideResult): CollideResult {
    let minX = x - hw;
    let maxX = x + hw;
    let minY = y;
    let maxY = y + h;
    let minZ = z - hw;
    let maxZ = z + hw;
    const ox = dx;
    const oy = dy;
    const oz = dz;
    // Candidate cells: the box grown by the whole movement.
    const cx0 = Math.floor(Math.min(minX, minX + dx)) - 1;
    const cx1 = Math.floor(Math.max(maxX, maxX + dx));
    const cy0 = Math.floor(Math.min(minY, minY + dy)) - 1;
    const cy1 = Math.floor(Math.max(maxY, maxY + dy));
    const cz0 = Math.floor(Math.min(minZ, minZ + dz)) - 1;
    const cz1 = Math.floor(Math.max(maxZ, maxZ + dz));
    const boxes = tmpBoxes;
    boxes.length = 0;
    const hf = this.half;
    for (let cy = cy0; cy <= cy1; cy++) {
      // Above build height only the arena walls remain: they go up forever, so a Wind Burst or
      // an elytra can't carry anyone out of the arena.
      const above = cy >= this.height;
      for (let cz = cz0; cz <= cz1; cz++)
        for (let cx = cx0; cx <= cx1; cx++) {
          if (above) {
            if (cx >= -hf && cx < hf && cz >= -hf && cz < hf) continue;
          } else if (!isSolid(this.get(cx, cy, cz))) continue;
          // The floor and the walls are merged per cell; fine at this scale.
          boxes.push(cx, cy, cz);
        }
    }
    // Y
    if (dy !== 0) {
      for (let i = 0; i < boxes.length; i += 3) {
        const bx = boxes[i];
        const by = boxes[i + 1];
        const bz = boxes[i + 2];
        if (maxX <= bx || minX >= bx + 1 || maxZ <= bz || minZ >= bz + 1) continue;
        if (dy > 0 && maxY <= by + 1e-7) dy = Math.min(dy, by - maxY);
        else if (dy < 0 && minY >= by + 1 - 1e-7) dy = Math.max(dy, by + 1 - minY);
      }
      minY += dy;
      maxY += dy;
    }
    const xFirst = Math.abs(dx) >= Math.abs(dz);
    for (let pass = 0; pass < 2; pass++) {
      const doX = xFirst ? pass === 0 : pass === 1;
      if (doX && dx !== 0) {
        for (let i = 0; i < boxes.length; i += 3) {
          const bx = boxes[i];
          const by = boxes[i + 1];
          const bz = boxes[i + 2];
          if (maxY <= by || minY >= by + 1 || maxZ <= bz || minZ >= bz + 1) continue;
          if (dx > 0 && maxX <= bx + 1e-7) dx = Math.min(dx, bx - maxX);
          else if (dx < 0 && minX >= bx + 1 - 1e-7) dx = Math.max(dx, bx + 1 - minX);
        }
        minX += dx;
        maxX += dx;
      } else if (!doX && dz !== 0) {
        for (let i = 0; i < boxes.length; i += 3) {
          const bx = boxes[i];
          const by = boxes[i + 1];
          const bz = boxes[i + 2];
          if (maxY <= by || minY >= by + 1 || maxX <= bx || minX >= bx + 1) continue;
          if (dz > 0 && maxZ <= bz + 1e-7) dz = Math.min(dz, bz - maxZ);
          else if (dz < 0 && minZ >= bz + 1 - 1e-7) dz = Math.max(dz, bz + 1 - minZ);
        }
        minZ += dz;
        maxZ += dz;
      }
    }
    out.x = x + dx;
    out.y = y + dy;
    out.z = z + dz;
    out.hitX = dx !== ox;
    out.hitY = dy !== oy;
    out.hitZ = dz !== oz;
    return out;
  }

  /** Whether a solid block may be placed here without overlapping this box. */
  static boxOverlapsCell(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, x: number, y: number, z: number): boolean {
    return maxX > x && minX < x + 1 && maxY > y && minY < y + 1 && maxZ > z && minZ < z + 1;
  }

  // ---------------------------------------------------------------- raycast

  /**
   * Voxel DDA along a unit direction. 'collider' stops at solid blocks (arrows, potions);
   * 'outline' also at cobwebs (the crosshair, placing, mining); 'source' also at fluid
   * sources (an empty bucket).
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, mode: RayMode, out: RayHit): RayHit | null {
    let x = Math.floor(ox);
    let y = Math.floor(oy);
    let z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1;
    const stepY = dy > 0 ? 1 : -1;
    const stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
    let t = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < 256; i++) {
      const id = this.get(x, y, z);
      const hit =
        isSolid(id) || (mode !== 'collider' && id === B.COBWEB) || (mode === 'source' && isFluid(id) && this.isSource(x, y, z));
      if (hit) {
        out.t = t;
        out.x = x;
        out.y = y;
        out.z = z;
        out.nx = nx;
        out.ny = ny;
        out.nz = nz;
        out.id = id;
        return out;
      }
      if (tmx < tmy && tmx < tmz) {
        t = tmx;
        tmx += tdx;
        x += stepX;
        nx = -stepX;
        ny = nz = 0;
      } else if (tmy < tmz) {
        t = tmy;
        tmy += tdy;
        y += stepY;
        ny = -stepY;
        nx = nz = 0;
      } else {
        t = tmz;
        tmz += tdz;
        z += stepZ;
        nz = -stepZ;
        nx = ny = 0;
      }
      // Entering a block exactly where the ray ends is not a hit (AABB.clip needs t < 1): an
      // explosion centred on a crystal's obsidian is still visible from above.
      if (t >= maxT - 1e-7) return null;
    }
    return null;
  }
}

export interface CollideResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

const tmpBoxes: number[] = [];
