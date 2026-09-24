import { PLAYER_WIDTH } from '../core/constants';
import { Rng } from '../core/rng';
import { Arrow } from './Arrow';
import type { Fighter } from './Fighter';

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

/** Flat arena: a floor at y = 0 surrounded by walls. Also owns the arrows in flight. */
export class World {
  readonly floorY = 0;
  /** Everything an arrow can hit. Filled in by whoever owns the fighters. */
  readonly fighters: Fighter[] = [];
  arrows: Arrow[] = [];
  rng = new Rng(1);
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

  /** Runs after both fighters have ticked, like entity ticking in ServerLevel. */
  tickArrows() {
    if (!this.arrows.length) return;
    for (const a of this.arrows) a.tick(this);
    this.arrows = this.arrows.filter((a) => !a.removed);
  }

  clearArrows() {
    this.arrows.length = 0;
  }
}
