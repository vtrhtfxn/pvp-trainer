import * as C from '../core/constants';
import { V3 } from '../core/math';
import type { Fighter } from './Fighter';
import type { World } from './World';

/** ExperienceOrb.getExperienceValue: the orb sizes a lump of experience is split into. */
const ORB_SIZES = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3, 1];
export function orbSize(xp: number): number {
  for (const s of ORB_SIZES) if (xp >= s) return s;
  return 1;
}

/**
 * An experience orb (ExperienceOrb): falls, slides, and homes in on the nearest player within
 * 8 blocks. A player absorbs at most one orb every 2 ticks, and Mending spends it on repairs.
 */
export class XpOrb {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  age = 0;
  removed = false;
  onGround = false;
  private following: Fighter | null = null;

  constructor(
    x: number,
    y: number,
    z: number,
    readonly value: number,
    rng: { next(): number },
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set((rng.next() * 0.2 - 0.1) * 2, rng.next() * 0.2 * 2, (rng.next() * 0.2 - 0.1) * 2);
  }

  tick(world: World) {
    this.prevPos.copy(this.pos);
    this.age++;
    if (this.age >= 6000) {
      this.removed = true;
      return;
    }
    const v = this.vel;
    v.y -= C.XP_ORB_GRAVITY;
    if (this.age % 20 === 1) this.scan(world);
    const f = this.following;
    if (f && f.dead) this.following = null;
    if (this.following) {
      const p = this.following;
      const dx = p.pos.x - this.pos.x;
      const dy = p.pos.y + p.eyeHeight() / 2 - this.pos.y;
      const dz = p.pos.z - this.pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 64 && d2 > 1e-9) {
        const d = Math.sqrt(d2);
        const e = 1 - d / C.XP_ORB_FOLLOW_RANGE;
        const k = (e * e * 0.1) / d;
        v.x += dx * k;
        v.y += dy * k;
        v.z += dz * k;
      }
    }
    const r = world.move(this.pos.x, this.pos.y, this.pos.z, v.x, v.y, v.z, 0.25);
    this.pos.set(r.x, r.y, r.z);
    this.onGround = r.hitY && v.y < 0;
    if (r.hitX) v.x = 0;
    if (r.hitZ) v.z = 0;
    if (r.hitY) v.y = 0;
    const fr = this.onGround ? C.BLOCK_SLIPPERINESS * 0.98 : 0.98;
    v.x *= fr;
    v.y *= 0.98;
    v.z *= fr;
    if (this.onGround) v.y *= -0.9;
    this.touch(world);
  }

  private scan(world: World) {
    if (this.following && this.distSq(this.following) < 64) return;
    let best: Fighter | null = null;
    let bestD = 64;
    for (const f of world.fighters) {
      if (f.dead) continue;
      const d = this.distSq(f);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    this.following = best;
  }

  private distSq(f: Fighter): number {
    return (f.pos.x - this.pos.x) ** 2 + (f.pos.y - this.pos.y) ** 2 + (f.pos.z - this.pos.z) ** 2;
  }

  /** Player.touch: the player's box grown by (1, 0.5, 1) against the orb's 0.5 box. */
  private touch(world: World) {
    for (const f of world.fighters) {
      if (f.dead || f.takeXpDelay > 0) continue;
      const hw = C.PLAYER_WIDTH / 2 + 1 + 0.25;
      if (
        Math.abs(this.pos.x - f.pos.x) < hw &&
        Math.abs(this.pos.z - f.pos.z) < hw &&
        this.pos.y + 0.5 > f.pos.y - 0.5 &&
        this.pos.y < f.pos.y + f.height() + 0.5
      ) {
        f.takeXpDelay = C.XP_PICKUP_DELAY;
        f.pickUpXp(this.value);
        this.removed = true;
        return;
      }
    }
  }
}
