import { PLAYER_WIDTH } from '../core/constants';
import { Rng } from '../core/rng';
import { Arrow } from './Arrow';
import { Blocks, type CollideResult } from './Blocks';
import type { DroppedItem } from './DroppedItem';
import type { EndCrystal } from './EndCrystal';
import type { Fighter } from './Fighter';
import type { Thrown } from './Thrown';
import { XpOrb, orbSize } from './XpOrb';

/** Things the renderer and sound need to hear about that don't belong to one fighter. */
export type WorldEvent =
  | { type: 'splash'; x: number; y: number; z: number; color: number; xp: boolean }
  | { type: 'blockPlace'; x: number; y: number; z: number; block: number }
  | { type: 'blockBreak'; x: number; y: number; z: number; block: number }
  /** Water and lava meeting (hiss + smoke), or water washing a cobweb away. */
  | { type: 'blockConvert'; x: number; y: number; z: number; from: number; to: number }
  | { type: 'explosion'; x: number; y: number; z: number; power: number }
  /** A wind charge or Wind Burst gust (no damage, knockback only). */
  | { type: 'wind'; x: number; y: number; z: number; power: number }
  | { type: 'crystalPlace'; x: number; y: number; z: number }
  | { type: 'anchorCharge'; x: number; y: number; z: number; charge: number }
  | { type: 'pearl'; x: number; y: number; z: number };

/** Build limit: blocks can be placed in the 16 layers above the floor. */
export const BUILD_HEIGHT = 16;

/** Arena half-size: the fighting area is 2 × ARENA_HALF blocks square. */
export const ARENA_HALF = 40;

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

/** Flat arena: a floor at y = 0 surrounded by walls. Also owns arrows, thrown items and XP orbs. */
export class World {
  readonly floorY = 0;
  /** Everything an arrow can hit. Filled in by whoever owns the fighters. */
  readonly fighters: Fighter[] = [];
  arrows: Arrow[] = [];
  thrown: Thrown[] = [];
  orbs: XpOrb[] = [];
  items: DroppedItem[] = [];
  crystals: EndCrystal[] = [];
  readonly blocks: Blocks;
  /** Drained by the game each frame; capped so headless simulations never grow it forever. */
  events: WorldEvent[] = [];
  rng = new Rng(1);
  /** Kit rule: every hit's raw damage is multiplied by this before armor (Diamond Pot: 1.33). */
  damageMultiplier = 1;
  /** mcpvp.club "stuns": an axe disabling a shield clears the defender's hurt immunity. */
  shieldStuns = false;
  constructor(
    readonly half = ARENA_HALF,
    /** Layers of breakable ground (Crystal); 0 = the usual unbreakable floor. */
    floorDepth = 0,
  ) {
    this.blocks = new Blocks(half, BUILD_HEIGHT, floorDepth);
    this.blocks.onChange = (x, y, z, from, to) => this.emit({ type: 'blockConvert', x, y, z, from, to });
  }

  get minX() {
    return -this.half;
  }
  get maxX() {
    return this.half;
  }
  get minZ() {
    return -this.half;
  }
  get maxZ() {
    return this.half;
  }

  /**
   * Moves a box (half width `hw`, height `h`) whose feet are at (x, y, z), clipped against the
   * floor, the walls and any placed block.
   */
  move(x: number, y: number, z: number, dx: number, dy: number, dz: number, hw = PLAYER_WIDTH / 2, h = 1.8): MoveResult {
    return this.blocks.collide(x, y, z, dx, dy, dz, hw, h, { x: 0, y: 0, z: 0, hitX: false, hitY: false, hitZ: false } as CollideResult);
  }

  /** Distance from (x, z) to the nearest wall. */
  wallDistance(x: number, z: number): number {
    return Math.min(x - this.minX, this.maxX - x, z - this.minZ, this.maxZ - z);
  }

  spawnArrow(a: Arrow) {
    this.arrows.push(a);
  }

  spawnThrown(t: Thrown) {
    this.thrown.push(t);
  }

  emit(e: WorldEvent) {
    if (this.events.length >= 64) this.events.shift();
    this.events.push(e);
  }

  /** ExperienceOrb.award: splits `xp` into vanilla orb sizes at (x, y, z). */
  awardXp(x: number, y: number, z: number, xp: number) {
    while (xp > 0) {
      const v = orbSize(xp);
      xp -= v;
      this.orbs.push(new XpOrb(x, y + 0.1, z, v, this.rng));
    }
  }

  /** Runs after both fighters have ticked, like entity ticking in ServerLevel. */
  tickEntities() {
    this.blocks.tick();
    if (this.items.length) {
      for (const it of this.items) it.tick(this);
      this.items = this.items.filter((i) => !i.removed);
    }
    if (this.crystals.length) {
      for (const c of this.crystals) c.age++;
      this.crystals = this.crystals.filter((c) => !c.removed);
    }
    if (this.arrows.length) {
      for (const a of this.arrows) a.tick(this);
      this.arrows = this.arrows.filter((a) => !a.removed);
    }
    if (this.thrown.length) {
      // Index loop: an impact can't spawn more thrown items, but keep it cheap anyway.
      for (let i = 0; i < this.thrown.length; i++) this.thrown[i].tick(this);
      this.thrown = this.thrown.filter((t) => !t.removed);
    }
    if (this.orbs.length) {
      for (const o of this.orbs) o.tick(this);
      this.orbs = this.orbs.filter((o) => !o.removed);
    }
  }

  clearEntities() {
    this.arrows.length = 0;
    this.thrown.length = 0;
    this.orbs.length = 0;
    this.items.length = 0;
    this.crystals.length = 0;
    this.events.length = 0;
    this.blocks.clear();
  }
}
