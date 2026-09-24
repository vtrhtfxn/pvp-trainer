import * as C from '../core/constants';
import { V3, rayAABB, type AABB } from '../core/math';
import { hurt, shieldFaces } from './combat';
import { applyKnockback, type Fighter } from './Fighter';
import type { World } from './World';

const tmpDir = new V3();
const tmpBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/**
 * An arrow in flight or stuck in the ground (AbstractArrow). Moves, then drags and falls:
 * pos += vel; vel *= 0.99; vel.y -= 0.05. Damage is ceil(speed × 2), plus a random bonus of up
 * to half that again for a critical (fully drawn bow, or any crossbow) arrow.
 */
export class Arrow {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  yaw = 0;
  pitch = 0;
  prevYaw = 0;
  prevPitch = 0;
  inGround = false;
  /** Ticks since it stuck (for despawn and the pickup delay). */
  groundTicks = 0;
  age = 0;
  removed = false;

  constructor(
    readonly owner: Fighter,
    x: number,
    y: number,
    z: number,
    readonly crit: boolean,
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
  }

  /** Projectile.shoot: normalise, add a little triangular spread, scale to `speed`. */
  shoot(dx: number, dy: number, dz: number, speed: number, inaccuracy: number, rng: { next(): number }) {
    const len = Math.hypot(dx, dy, dz) || 1;
    const tri = () => (rng.next() - rng.next()) * C.ARROW_INACCURACY * inaccuracy;
    this.vel.set((dx / len + tri()) * speed, (dy / len + tri()) * speed, (dz / len + tri()) * speed);
    this.updateRotation();
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
  }

  private updateRotation() {
    const v = this.vel;
    const h = Math.hypot(v.x, v.z);
    if (h > 1e-6 || Math.abs(v.y) > 1e-6) {
      this.yaw = Math.atan2(-v.x, -v.z);
      this.pitch = Math.atan2(v.y, h);
    }
  }

  tick(world: World) {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.age++;
    if (this.inGround) {
      this.groundTicks++;
      if (this.groundTicks >= C.ARROW_DESPAWN_TICKS) this.removed = true;
      else if (this.groundTicks > 7) this.tryPickup(world);
      return;
    }
    if (this.age > 400) {
      this.removed = true;
      return;
    }

    const v = this.vel;
    const speed = Math.hypot(v.x, v.y, v.z);
    let travel = 1; // fraction of this tick's motion before hitting something

    // Blocks: the floor and the four walls.
    const tFloor = v.y < 0 ? (world.floorY - this.pos.y) / v.y : Infinity;
    const tX = v.x > 0 ? (world.maxX - this.pos.x) / v.x : v.x < 0 ? (world.minX - this.pos.x) / v.x : Infinity;
    const tZ = v.z > 0 ? (world.maxZ - this.pos.z) / v.z : v.z < 0 ? (world.minZ - this.pos.z) / v.z : Infinity;
    const tBlock = Math.min(tFloor, tX, tZ);
    const hitsBlock = tBlock >= 0 && tBlock <= 1;
    if (hitsBlock) travel = tBlock;

    // Entities: the target's box grown by 0.3, tested along the same segment.
    let victim: Fighter | null = null;
    if (speed > 1e-6) {
      tmpDir.set(v.x / speed, v.y / speed, v.z / speed);
      for (const f of world.fighters) {
        if (f === this.owner || f.dead) continue;
        f.aabbInto(tmpBox, 0.3);
        const t = rayAABB(this.pos, tmpDir, tmpBox);
        if (t >= 0 && t / speed <= travel) {
          travel = t / speed;
          victim = f;
        }
      }
    }

    if (victim) {
      this.pos.set(this.pos.x + v.x * travel, this.pos.y + v.y * travel, this.pos.z + v.z * travel);
      this.hitEntity(victim, speed, world);
      return;
    }
    if (hitsBlock) {
      // Stop just short of the surface so it renders poking out of it.
      const back = speed > 1e-6 ? 0.05 / speed : 0;
      const t = Math.max(0, travel - back);
      this.pos.set(this.pos.x + v.x * t, this.pos.y + v.y * t, this.pos.z + v.z * t);
      this.inGround = true;
      this.vel.set(0, 0, 0);
      return;
    }
    this.pos.set(this.pos.x + v.x, this.pos.y + v.y, this.pos.z + v.z);
    v.x *= C.ARROW_DRAG;
    v.y *= C.ARROW_DRAG;
    v.z *= C.ARROW_DRAG;
    v.y -= C.ARROW_GRAVITY;
    this.updateRotation();
  }

  private hitEntity(target: Fighter, speed: number, world: World) {
    const owner = this.owner;
    let dmg = Math.ceil(Math.max(0, speed * C.ARROW_BASE_DAMAGE));
    if (this.crit) dmg += Math.floor(world.rng.next() * (Math.floor(dmg / 2) + 2));

    // A raised shield facing the arrow stops it dead; it drops to the floor.
    if (target.isBlocking() && shieldFaces(target, this.pos.x, this.pos.z)) {
      target.events.push({ type: 'shieldBlock', attacker: owner });
      target.stats.blocked++;
      this.bounce();
      return;
    }

    const kbVel = target.serverVel.clone();
    const res = hurt(target, dmg, owner, false);
    if (!res.damaged) {
      this.bounce();
      return;
    }
    if (res.fullHit) {
      // Projectile knockback pushes along the arrow's flight, not away from the shooter.
      applyKnockback(kbVel, C.BASE_KNOCKBACK * (1 - target.armor.knockbackResistance), -this.vel.x, -this.vel.z, target.onGround);
      const vy = target.onGround ? kbVel.y : target.vel.y;
      target.vel.set(kbVel.x, vy, kbVel.z);
      target.serverVel.set(kbVel.x, vy, kbVel.z);
    }
    owner.stats.arrowHits++;
    owner.stats.damageDealt += res.dealt;
    owner.events.push({ type: 'arrowHit', target, damage: res.dealt, crit: this.crit });
    this.removed = true;
  }

  /** What an arrow does when it cannot hurt what it hit: loses almost all speed and falls. */
  private bounce() {
    this.vel.set(this.vel.x * -0.1, this.vel.y * -0.1, this.vel.z * -0.1);
    this.updateRotation();
  }

  private tryPickup(world: World) {
    for (const f of world.fighters) {
      if (f.dead) continue;
      const hw = 0.3 + 1;
      if (
        Math.abs(this.pos.x - f.pos.x) <= hw + 0.25 &&
        Math.abs(this.pos.z - f.pos.z) <= hw + 0.25 &&
        this.pos.y >= f.pos.y - 0.5 - 0.25 &&
        this.pos.y <= f.pos.y + f.height() + 0.5 + 0.25 &&
        f.addItem({ id: 'arrow', count: 1 })
      ) {
        f.events.push({ type: 'pickup' });
        this.removed = true;
        return;
      }
    }
  }
}
