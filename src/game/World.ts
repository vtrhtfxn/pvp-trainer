import { PLAYER_WIDTH } from '../core/constants';

export interface MoveResult {
  x: number;
  y: number;
  z: number;
  hitX: boolean;
  hitY: boolean;
  hitZ: boolean;
}

/** Flat arena: a floor at y = 0 surrounded by walls. */
export class World {
  readonly floorY = 0;
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
  move(x: number, y: number, z: number, dx: number, dy: number, dz: number): MoveResult {
    const hw = PLAYER_WIDTH / 2;
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
}
