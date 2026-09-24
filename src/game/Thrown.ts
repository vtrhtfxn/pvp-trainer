import * as C from '../core/constants';
import { V3, rayAABB, type AABB } from '../core/math';
import type { Fighter } from './Fighter';
import { POTIONS, type PotionId } from './items';
import type { RayHit } from './Blocks';
import { detonateCrystal } from './crystals';
import { hurt } from './combat';
import { windExplosion } from './Explosion';
import type { EndCrystal } from './EndCrystal';
import type { World } from './World';

const tmpDir = new V3();
const rayHit: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };
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
    readonly kind: 'potion' | 'xp' | 'pearl' | 'wind',
    readonly potion: PotionId | null,
    x: number,
    y: number,
    z: number,
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
  }

  get gravity() {
    if (this.kind === 'wind') return 0;
    return this.kind === 'potion' ? C.POTION_GRAVITY : this.kind === 'pearl' ? C.PEARL_GRAVITY : C.XP_BOTTLE_GRAVITY;
  }

  /**
   * Projectile.shootFromRotation(shooter, xRot, yRot, -20, speed, 1): the vertical part is
   * aimed 20° higher than the crosshair, then the thrower's own motion is added on top.
   */
  throwFrom(f: Fighter, speed: number, rng: { next(): number }, pitchOffsetDeg = C.THROW_PITCH_OFFSET_DEG) {
    const off = pitchOffsetDeg * (Math.PI / 180);
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
    // Blocks: the floor, the walls and anything placed (voxel ray through this tick's motion).
    let tBlock = Infinity;
    if (speed > 1e-6) {
      const h = world.blocks.raycast(this.pos.x, this.pos.y, this.pos.z, v.x / speed, v.y / speed, v.z / speed, speed, 'collider', rayHit);
      if (h) tBlock = h.t / speed;
    }
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
    // Pearls (like snowballs) "hurt" what they hit for 0 — enough to set off an end crystal.
    let crystal: EndCrystal | null = null;
    if (this.kind === 'pearl' && speed > 1e-6 && world.crystals.length) {
      for (const c of world.crystals) {
        if (c.removed) continue;
        const t = rayAABB(this.pos, tmpDir, c.aabbInto(tmpBox));
        if (t >= 0 && t / speed <= travel) {
          travel = t / speed;
          crystal = c;
          victim = null;
        }
      }
    }
    if (victim || hitsBlock || crystal) {
      // Where it was at the start of this tick: a pearl teleports you there, not into the wall.
      const lastX = this.pos.x;
      const lastY = this.pos.y;
      const lastZ = this.pos.z;
      this.pos.set(this.pos.x + v.x * travel, this.pos.y + v.y * travel, this.pos.z + v.z * travel);
      if (crystal) detonateCrystal(world, crystal, this.owner);
      if (this.kind === 'pearl') {
        this.removed = true;
        this.owner.pearlTeleport(lastX, lastY, lastZ);
        world.emit({ type: 'pearl', x: lastX, y: lastY, z: lastZ });
        return;
      }
      this.impact(world, victim);
      return;
    }
    this.pos.set(this.pos.x + v.x, this.pos.y + v.y, this.pos.z + v.z);
    // Wind charges (AbstractHurtingProjectile with no acceleration) keep their speed.
    if (this.kind === 'wind') return;
    v.x *= C.THROWN_DRAG;
    v.y *= C.THROWN_DRAG;
    v.z *= C.THROWN_DRAG;
    v.y -= this.gravity;
  }

  private impact(world: World, direct: Fighter | null) {
    this.removed = true;
    if (this.kind === 'wind') {
      // WindCharge.onHitEntity: 1 damage to whoever it hits, then the burst where it is.
      if (direct) hurt(direct, 1, this.owner, false);
      windExplosion(world, this.pos.x, this.pos.y, this.pos.z, C.WIND_CHARGE_POWER, C.WIND_CHARGE_KNOCKBACK);
      return;
    }
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
