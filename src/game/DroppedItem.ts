import { V3 } from '../core/math';
import type { ItemStack } from './items';
import type { World } from './World';

/**
 * An item lying in the world (ItemEntity): pops out of a broken block, falls (gravity 0.04,
 * drag 0.98, ground friction 0.6 × 0.98) and is picked up by the first player to touch it
 * once its 10-tick pickup delay is over.
 */
export class DroppedItem {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  age = 0;
  pickupDelay = 10;
  removed = false;
  onGround = false;

  constructor(
    readonly stack: ItemStack,
    x: number,
    y: number,
    z: number,
    rng: { next(): number },
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.vel.set(rng.next() * 0.2 - 0.1, 0.2, rng.next() * 0.2 - 0.1);
  }

  tick(world: World) {
    this.prevPos.copy(this.pos);
    this.age++;
    if (this.pickupDelay > 0) this.pickupDelay--;
    if (this.age >= 6000) {
      this.removed = true;
      return;
    }
    const v = this.vel;
    v.y -= 0.04;
    const r = world.move(this.pos.x, this.pos.y, this.pos.z, v.x, v.y, v.z, 0.125, 0.25);
    this.pos.set(r.x, r.y, r.z);
    this.onGround = r.hitY && v.y < 0;
    if (r.hitX) v.x = 0;
    if (r.hitZ) v.z = 0;
    if (r.hitY) v.y = 0;
    const f = this.onGround ? 0.6 * 0.98 : 0.98;
    v.x *= f;
    v.y *= 0.98;
    v.z *= f;
    if (this.onGround) v.y *= -0.5;
    if (this.pickupDelay > 0) return;
    for (const p of world.fighters) {
      if (p.dead) continue;
      if (
        Math.abs(this.pos.x - p.pos.x) < 0.3 + 1 + 0.125 &&
        Math.abs(this.pos.z - p.pos.z) < 0.3 + 1 + 0.125 &&
        this.pos.y + 0.25 > p.pos.y - 0.5 &&
        this.pos.y < p.pos.y + p.height() + 0.5
      ) {
        const n = this.stack.count;
        p.addItem(this.stack);
        if (this.stack.count < n) p.events.push({ type: 'pickup' });
        if (this.stack.count <= 0) {
          this.removed = true;
          return;
        }
      }
    }
  }
}
