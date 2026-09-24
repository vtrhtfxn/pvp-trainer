import * as C from '../core/constants';
import { V3, rayAABB, type AABB } from '../core/math';
import type { Fighter } from './Fighter';
import { POTIONS, type PotionId } from './items';
import type { World } from './World';

const tmpDir = new V3();
const tmpBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const ownerBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const HALF = 0.125; // 0.25-block projectile box

/**
 * A thrown splash potion or Bottle o' Enchanting (ThrowableProjectile). Each tick it checks the
 * segment it is about to travel for a hit, then moves, drags (×0.99) and falls. It cannot hit
 * its thrower until it has left their hitbox, so a potion thrown at your own feet splashes on
 * the ground under you.
 */
export class Thrown {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  age = 0;
  removed = false;
  private leftOwner = false;

  constructor(
    readonly owner: Fighter,
    readonly kind: 'potion' | 'xp',
    readonly potion: PotionId | null,
    x: number,
    y: number,
    z: number,
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
  }

  get gravity() {
    return this.kind === 'potion' ? C.POTION_GRAVITY : C.XP_BOTTLE_GRAVITY;
  }

  /**
   * Projectile.shootFromRotation(shooter, xRot, yRot, -20, speed, 1): the vertical part is
   * aimed 20° higher than the crosshair, then the thrower's own motion is added on top.
   */
  throwFrom(f: Fighter, speed: number, rng: { next(): number }) {
    const off = C.THROW_PITCH_OFFSET_DEG * (Math.PI / 180);
    const cp = Math.cos(f.pitch);
    let dx = -Math.sin(f.yaw) * cp;
    let dy = Math.sin(f.pitch + off);
    let dz = -Math.cos(f.yaw) * cp;
    const len = Math.hypot(dx, dy, dz) || 1;
    const tri = () => (rng.next() - rng.next()) * C.ARROW_INACCURACY;
    dx = (dx / len + tri()) * speed;
    dy = (dy / len + tri()) * speed;
    dz = (dz / len + tri()) * speed;
    const mx = f.networked ? f.pos.x - f.prevPos.x : f.vel.x;
    const mz = f.networked ? f.pos.z - f.prevPos.z : f.vel.z;
    this.vel.set(dx + mx, dy + (f.onGround ? 0 : f.vel.y), dz + mz);
  }

  tick(world: World) {
    this.prevPos.copy(this.pos);
    this.age++;
    if (this.age > 200) {
      this.removed = true;
      return;
    }
    if (!this.leftOwner) {
      // Projectile.checkLeftOwner: clear of the thrower's box (grown by 1).
      this.owner.aabbInto(ownerBox, 1);
      const p = this.pos;
      this.leftOwner = !(
        p.x + HALF > ownerBox.minX &&
        p.x - HALF < ownerBox.maxX &&
        p.y + HALF > ownerBox.minY &&
        p.y - HALF < ownerBox.maxY &&
        p.z + HALF > ownerBox.minZ &&
        p.z - HALF < ownerBox.maxZ
      );
    }

    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    let travel = 1;
    const tFloor = v.y < 0 ? (world.floorY - this.pos.y) / v.y : Infinity;
    const tX = v.x > 0 ? (world.maxX - this.pos.x) / v.x : v.x < 0 ? (world.minX - this.pos.x) / v.x : Infinity;
    const tZ = v.z > 0 ? (world.maxZ - this.pos.z) / v.z : v.z < 0 ? (world.minZ - this.pos.z) / v.z : Infinity;
    const tBlock = Math.min(tFloor, tX, tZ);
    const hitsBlock = tBlock >= 0 && tBlock <= 1;
    if (hitsBlock) travel = tBlock;

    let victim: Fighter | null = null;
    if (speed > 1e-6) {
      tmpDir.set(v.x / speed, v.y / speed, v.z / speed);
      for (const f of world.fighters) {
        if (f.dead || (f === this.owner && !this.leftOwner)) continue;
        f.aabbInto(tmpBox, 0.3);
        const t = rayAABB(this.pos, tmpDir, tmpBox);
        if (t >= 0 && t / speed <= travel) {
          travel = t / speed;
          victim = f;
        }
      }
    }
    if (victim || hitsBlock) {
      this.pos.set(this.pos.x + v.x * travel, this.pos.y + v.y * travel, this.pos.z + v.z * travel);
      this.impact(world, victim);
      return;
    }
    this.pos.set(this.pos.x + v.x, this.pos.y + v.y, this.pos.z + v.z);
    v.x *= C.THROWN_DRAG;
    v.y *= C.THROWN_DRAG;
    v.z *= C.THROWN_DRAG;
    v.y -= this.gravity;
  }

  private impact(world: World, direct: Fighter | null) {
    this.removed = true;
    if (this.kind === 'xp') {
      // ThrownExperienceBottle: 3 + rand(5) + rand(5) experience, split into orbs.
      const xp = 3 + world.rng.int(0, 4) + world.rng.int(0, 4);
      world.awardXp(this.pos.x, this.pos.y, this.pos.z, xp);
      world.emit({ type: 'splash', x: this.pos.x, y: this.pos.y, z: this.pos.z, color: 0x7fd4ff, xp: true });
      return;
    }
    const def = POTIONS[this.potion!];
    world.emit({ type: 'splash', x: this.pos.x, y: this.pos.y, z: this.pos.z, color: def.color, xp: false });
    splashPotion(world, this.pos, this.potion!, direct, this.owner);
  }
}

/**
 * ThrownSplashPotion.applySplash: every living entity whose box is within 4×2×4 of the impact
 * and whose feet are within 4 blocks gets the effect, scaled by 1 − distance / 4 (a direct hit
 * is always full strength). Instant health heals round(scale × (4 << amplifier)); timed effects
 * last round(scale × duration) ticks and are skipped below one second.
 */
export function splashPotion(world: World, at: V3, potion: PotionId, direct: Fighter | null, thrower: Fighter) {
  const def = POTIONS[potion];
  for (const f of world.fighters) {
    if (f.dead) continue;
    f.aabbInto(tmpBox);
    if (
      tmpBox.maxX < at.x - C.SPLASH_RADIUS ||
      tmpBox.minX > at.x + C.SPLASH_RADIUS ||
      tmpBox.maxY < at.y - 2 ||
      tmpBox.minY > at.y + 2 ||
      tmpBox.maxZ < at.z - C.SPLASH_RADIUS ||
      tmpBox.minZ > at.z + C.SPLASH_RADIUS
    ) {
      continue;
    }
    const d2 = (f.pos.x - at.x) ** 2 + (f.pos.y - at.y) ** 2 + (f.pos.z - at.z) ** 2;
    if (d2 >= C.SPLASH_RADIUS * C.SPLASH_RADIUS) continue;
    const scale = f === direct ? 1 : 1 - Math.sqrt(d2) / C.SPLASH_RADIUS;
    if (def.effect === 'instant_health') {
      const amount = Math.floor(scale * (4 << def.amplifier) + 0.5);
      f.heal(amount);
    } else {
      const ticks = Math.floor(scale * def.duration + 0.5);
      if (ticks > 20) f.addEffect(def.effect, def.amplifier, ticks);
    }
    f.events.push({ type: 'splashed', potion, scale, own: f === thrower });
  }
}
