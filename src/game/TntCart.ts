import { V3, rayAABB, type AABB } from '../core/math';
import { B, isSolid, type RayHit } from './Blocks';
import { explode } from './Explosion';
import type { Fighter } from './Fighter';
import type { World } from './World';

/** Minecart size (0.98 × 0.7). */
const HALF = 0.49;
const HEIGHT = 0.7;
/** MinecartTNT.primeFuse: 80 ticks. */
export const CART_FUSE = 80;
/** MinecartTNT's base explosion power; up to +1.5 × min(5, speed) on top. */
export const CART_BASE_POWER = 4;

const tmpBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const tmpEye = new V3();
const tmpDir = new V3();
const ray: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };

/**
 * A minecart with TNT (MinecartTNT). It rolls along the rail it was put on (or falls and slides
 * off one), and blows up:
 * - at once when a burning projectile hits it (a Flame arrow, or one shot through fire), with
 *   power 4 + random × 1.5 × min(5, the arrow's speed) — a full-draw arrow makes a huge blast;
 * - after a short random fuse when an explosion or fire catches it;
 * - when it lands after falling 3+ blocks.
 * A plain hit (a sword, a cold arrow) on a cart at rest just breaks it.
 */
export class TntCart {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  /** Ticks until it explodes; -1 = not lit. */
  fuse = -1;
  removed = false;
  fallDistance = 0;
  private fireTicks = 0;
  /** Primed TNT without a cart (Bed Wars TNT): can't be hit, just waits for its fuse. */
  bare = false;
  age = 0;

  constructor(
    x: number,
    y: number,
    z: number,
    /** Who placed it (statistics, and who the blast counts for). */
    readonly owner: Fighter | null,
    /** The rail's axis when placed (0 along Z, 1 along X), for drawing. */
    public axis = 0,
  ) {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
  }

  aabbInto(out: AABB): AABB {
    out.minX = this.pos.x - HALF;
    out.minY = this.pos.y;
    out.minZ = this.pos.z - HALF;
    out.maxX = this.pos.x + HALF;
    out.maxY = this.pos.y + HEIGHT;
    out.maxZ = this.pos.z + HALF;
    return out;
  }

  /** Lit and counting down (drawn flashing). */
  get primed(): boolean {
    return this.fuse >= 0;
  }

  /** MinecartTNT.primeFuse for something that sets it off late (fire, a blast): 0–38 ticks. */
  ignite(world: World, short = true) {
    if (this.fuse >= 0) return;
    this.fuse = short ? world.rng.int(0, 19) + world.rng.int(0, 19) : CART_FUSE;
    world.emit({ type: 'cartPrimed', x: this.pos.x, y: this.pos.y, z: this.pos.z });
  }

  tick(world: World) {
    this.prevPos.copy(this.pos);
    this.age++;
    if (this.fuse > 0 && --this.fuse === 0) {
      detonateCart(world, this, Math.hypot(this.vel.x, this.vel.z), this.owner);
      return;
    }
    const blocks = world.blocks;
    const bx = Math.floor(this.pos.x);
    const by = Math.floor(this.pos.y + 0.01);
    const bz = Math.floor(this.pos.z);
    const here = blocks.get(bx, by, bz);
    const onRail = here === B.RAIL;
    const v = this.vel;
    if (onRail) {
      // Rails steer: only motion along the rail survives; slide to its middle across it.
      const axis = blocks.railAxis(bx, by, bz);
      this.axis = axis;
      if (axis === 0) {
        v.x = 0;
        this.pos.x += (bx + 0.5 - this.pos.x) * 0.5;
      } else {
        v.z = 0;
        this.pos.z += (bz + 0.5 - this.pos.z) * 0.5;
      }
    }
    v.y -= 0.04;
    const r = world.move(this.pos.x, this.pos.y, this.pos.z, v.x, v.y, v.z, HALF, HEIGHT);
    const moved = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
    const fallen = this.pos.y - r.y;
    this.pos.set(r.x, r.y, r.z);
    if (r.hitX) v.x = 0;
    if (r.hitZ) v.z = 0;
    const grounded = r.hitY && v.y < 0;
    if (grounded) {
      v.y = 0;
      // MinecartTNT.causeFallDamage: a hard landing sets it off.
      if (this.fallDistance >= 3) {
        const f = this.fallDistance / 10;
        detonateCart(world, this, f * f, this.owner);
        return;
      }
      this.fallDistance = 0;
    } else if (fallen > 0) this.fallDistance += fallen;
    // Friction: 0.96 on a rail, 0.5 on the ground, 0.95 in the air.
    const k = onRail ? 0.96 : grounded ? 0.5 : 0.95;
    v.x *= k;
    v.z *= k;
    if (moved < 1e-4 && Math.abs(v.x) < 0.003) v.x = 0;
    if (moved < 1e-4 && Math.abs(v.z) < 0.003) v.z = 0;

    // Fire or lava under it burns it up in a few hits, which lights the TNT.
    const cell = blocks.get(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z));
    if (cell === B.FIRE || cell === B.LAVA) {
      if (++this.fireTicks >= 4) this.ignite(world);
    } else this.fireTicks = 0;
    if (this.pos.y < -40) this.removed = true;
  }
}

/** Bed Wars TNT: lit as it is placed, it goes off 50 ticks later with power 4. */
export function spawnPrimedTnt(world: World, owner: Fighter, x: number, y: number, z: number): TntCart {
  const t = new TntCart(x, y, z, owner);
  t.bare = true;
  t.fuse = 50;
  world.carts.push(t);
  world.emit({ type: 'cartPrimed', x, y, z });
  return t;
}

/** Whether a TNT minecart can go on (x, y, z): a rail there, and no cart on it already. */
export function canPlaceCart(world: World, x: number, y: number, z: number): boolean {
  if (world.blocks.get(x, y, z) !== B.RAIL) return false;
  for (const c of world.carts) if (!c.removed && Math.floor(c.pos.x) === x && Math.floor(c.pos.z) === z && Math.abs(c.pos.y - y) < 1) return false;
  return true;
}

export function placeCart(world: World, owner: Fighter, x: number, y: number, z: number): TntCart {
  const c = new TntCart(x + 0.5, y, z + 0.5, owner, world.blocks.railAxis(x, y, z));
  world.carts.push(c);
  owner.stats.cartsPlaced++;
  world.emit({ type: 'cartPlace', x: c.pos.x, y: c.pos.y, z: c.pos.z });
  return c;
}

/**
 * MinecartTNT.explode: power 4 + random × 1.5 × min(5, speed), where speed is the arrow's (for a
 * burning arrow) or the cart's own. Everything else is the ordinary explosion.
 */
export function detonateCart(world: World, cart: TntCart, speed: number, source: Fighter | null) {
  if (cart.removed) return;
  cart.removed = true;
  const power = CART_BASE_POWER + world.rng.next() * 1.5 * Math.min(5, Math.max(0, speed));
  if (source) source.stats.cartsBlown++;
  explode(world, cart.pos.x, cart.pos.y + 0.35, cart.pos.z, power, { source });
}

/**
 * Something hit the cart. A burning projectile blows it up at once (with the projectile's speed);
 * anything else breaks a cart at rest, or lights one that is rolling.
 */
export function hurtCart(world: World, cart: TntCart, by: Fighter | null, burningSpeed: number | null) {
  if (cart.removed) return;
  if (burningSpeed !== null) {
    detonateCart(world, cart, burningSpeed, by);
    return;
  }
  if (Math.hypot(cart.vel.x, cart.vel.z) >= 0.1) {
    cart.ignite(world);
    return;
  }
  cart.removed = true;
  world.emit({ type: 'cartBreak', x: cart.pos.x, y: cart.pos.y, z: cart.pos.z });
}

/** The TNT minecart under `f`'s crosshair within attack reach, or null. */
export function crosshairCart(f: Fighter, reach = f.entityReach()): { cart: TntCart; t: number } | null {
  const world = f.world;
  if (!world.carts.length) return null;
  const eye = f.eyePos(tmpEye);
  const d = f.look(tmpDir);
  let best: TntCart | null = null;
  let bestT = reach;
  for (const c of world.carts) {
    if (c.removed || c.bare) continue;
    const t = rayAABB(eye, d, c.aabbInto(tmpBox));
    if (t >= 0 && t <= bestT) {
      bestT = t;
      best = c;
    }
  }
  if (!best) return null;
  if (world.blocks.count && world.blocks.raycast(eye.x, eye.y, eye.z, d.x, d.y, d.z, bestT, 'collider', ray)) return null;
  return { cart: best, t: bestT };
}

/** Punching a cart (Player.attack → AbstractMinecart.hurt). */
export function attackCart(attacker: Fighter, cart: TntCart) {
  attacker.swing();
  attacker.resetAttackStrength();
  attacker.stats.swings++;
  hurtCart(attacker.world, cart, attacker, null);
}

/** A cell fire can go in: empty, with something solid under it. */
export function canHoldFire(world: World, x: number, y: number, z: number): boolean {
  const b = world.blocks;
  return b.inside(x, y, z) && b.get(x, y, z) === B.AIR && isSolid(b.get(x, y - 1, z));
}
