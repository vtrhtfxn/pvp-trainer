import { PLAYER_WIDTH } from '../core/constants';
import { Rng } from '../core/rng';
import { Arrow } from './Arrow';
import type { Fighter } from './Fighter';
import type { Thrown } from './Thrown';
import { XpOrb, orbSize } from './XpOrb';

/** Things the renderer and sound need to hear about that don't belong to one fighter. */
export type WorldEvent =
  | { type: 'splash'; x: number; y: number; z: number; color: number; xp: boolean };

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
  /** Drained by the game each frame; capped so headless simulations never grow it forever. */
  events: WorldEvent[] = [];
  rng = new Rng(1);
  /** Kit rule: every hit's raw damage is multiplied by this before armor (Diamond Pot: 1.33). */
  damageMultiplier = 1;
  constructor(readonly half = 24) {}

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

  /** Moves a player-sized box whose feet are at (x, y, z) and resolves collisions. */
  move(x: number, y: number, z: number, dx: number, dy: number, dz: number, hw = PLAYER_WIDTH / 2): MoveResult {
    let nx = x + dx;
    let ny = y + dy;
    let nz = z + dz;
    let hitX = false;
    let hitY = false;
    let hitZ = false;
    if (ny < this.floorY) {
      ny = this.floorY;
      hitY = true;
    }
    if (nx < this.minX + hw) {
      nx = this.minX + hw;
      hitX = true;
    } else if (nx > this.maxX - hw) {
      nx = this.maxX - hw;
      hitX = true;
    }
    if (nz < this.minZ + hw) {
      nz = this.minZ + hw;
      hitZ = true;
    } else if (nz > this.maxZ - hw) {
      nz = this.maxZ - hw;
      hitZ = true;
    }
    return { x: nx, y: ny, z: nz, hitX, hitY, hitZ };
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
    this.events.length = 0;
  }
}
