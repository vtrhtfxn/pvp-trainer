import type { AABB } from '../core/math';
import type { Fighter } from './Fighter';

/**
 * A placed end crystal (EndCrystal with showBottom = false). It sits on top of obsidian with
 * its feet at the block's top face, has a 2×2×2 hitbox, blocks nothing, and explodes (power 6)
 * the moment anything damages it — a hit, an arrow or another explosion.
 */
export class EndCrystal {
  /** Ticks alive (spins the model). */
  age = 0;
  removed = false;

  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
    /** Who placed it (for statistics). */
    readonly owner: Fighter | null,
  ) {}

  aabbInto(out: AABB): AABB {
    out.minX = this.x - 1;
    out.minY = this.y;
    out.minZ = this.z - 1;
    out.maxX = this.x + 1;
    out.maxY = this.y + 2;
    out.maxZ = this.z + 1;
    return out;
  }
}
