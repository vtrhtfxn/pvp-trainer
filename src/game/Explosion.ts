import { B, blastResistance, isSolid, type RayHit } from './Blocks';
import { damageAfterArmor, damageAfterProtection, hurt } from './combat';
import type { EndCrystal } from './EndCrystal';
import type { Fighter } from './Fighter';
import type { World } from './World';

const ray: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };

/**
 * Explosion.getSeenPercent: the share of a grid of points over the box (≈ every half block)
 * that have a clear line (no solid block collider) to the explosion centre.
 */
export function seenPercent(world: World, cx: number, cy: number, cz: number, minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): number {
  const blocks = world.blocks;
  const d0 = 1 / ((maxX - minX) * 2 + 1);
  const d1 = 1 / ((maxY - minY) * 2 + 1);
  const d2 = 1 / ((maxZ - minZ) * 2 + 1);
  const d3 = (1 - Math.floor(1 / d0) * d0) / 2;
  const d4 = (1 - Math.floor(1 / d2) * d2) / 2;
  if (d0 < 0 || d1 < 0 || d2 < 0) return 0;
  let seen = 0;
  let total = 0;
  for (let k = 0; k <= 1; k += d0)
    for (let l = 0; l <= 1; l += d1)
      for (let m = 0; m <= 1; m += d2) {
        const px = minX + (maxX - minX) * k + d3;
        const py = minY + (maxY - minY) * l;
        const pz = minZ + (maxZ - minZ) * m + d4;
        const dx = cx - px;
        const dy = cy - py;
        const dz = cz - pz;
        const len = Math.hypot(dx, dy, dz);
        // Level.clip from the sample point to the centre, block colliders only.
        if (len < 1e-6 || !blocks.raycast(px, py, pz, dx / len, dy / len, dz / len, len, 'collider', ray)) seen++;
        total++;
      }
  return total ? seen / total : 0;
}

/**
 * Damage an explosion deals to a player at `f`'s position (before armor), with the exposure:
 * impact = (1 − distance / (2 × power)) × exposure; damage = (impact² + impact) / 2 × 7 × 2·power + 1.
 * Used by the explosion itself and by the bot to judge where a crystal hurts most.
 */
export function explosionDamageAt(world: World, cx: number, cy: number, cz: number, power: number, x: number, y: number, z: number, height: number): number {
  const diameter = power * 2;
  const dist = Math.hypot(x - cx, y - cy, z - cz) / diameter;
  if (dist > 1) return 0;
  const hw = 0.3;
  const seen = seenPercent(world, cx, cy, cz, x - hw, y, z - hw, x + hw, y + height, z + hw);
  const impact = (1 - dist) * seen;
  if (impact <= 0) return 0;
  return ((impact * impact + impact) / 2) * 7 * diameter + 1;
}

/**
 * What that explosion would take off `f` standing at (x, y, z), after armor and (Blast)
 * Protection — ignoring hurt immunity and absorption.
 */
export function explosionDamageTo(world: World, f: Fighter, cx: number, cy: number, cz: number, power: number, x: number, y: number, z: number): number {
  const raw = explosionDamageAt(world, cx, cy, cz, power, x, y, z, f.height()) * world.damageMultiplier;
  if (raw <= 0) return 0;
  const a = f.armor;
  return damageAfterProtection(damageAfterArmor(raw, a.points, a.toughness), a.protectionEpf + a.blastEpf);
}

export interface ExplosionOptions {
  /** Respawn anchors set fire to a third of the air around them. */
  fire?: boolean;
  /** Who caused it (stats, and whose crystal it was). */
  source?: Fighter | null;
}

/**
 * ServerExplosion.explode: blocks, then entities, in vanilla's order.
 * 1. 16×16×16 rays from the centre, each with power × (0.7..1.3); every 0.3-block step loses
 *    (resistance + 0.3) × 0.3 plus 0.225, and every block still reached with power left is
 *    destroyed (obsidian, anchors and the floor survive).
 * 2. Every entity within 2 × power: damage and knockback scaled by distance and exposure.
 *    Crystals caught in it explode as well (after this one).
 * 3. With fire, a third of the air cells the rays reached catch fire if they sit on a solid block.
 */
export function explode(world: World, cx: number, cy: number, cz: number, power: number, opts: ExplosionOptions = {}) {
  const blocks = world.blocks;
  const rng = world.rng;
  const affected = new Set<number>();
  const key = (x: number, y: number, z: number) => ((y + 64) * 4096 + (z + 2048)) * 4096 + (x + 2048);
  for (let j = 0; j < 16; j++)
    for (let k = 0; k < 16; k++)
      for (let l = 0; l < 16; l++) {
        if (j !== 0 && j !== 15 && k !== 0 && k !== 15 && l !== 0 && l !== 15) continue;
        let dx = (j / 15) * 2 - 1;
        let dy = (k / 15) * 2 - 1;
        let dz = (l / 15) * 2 - 1;
        const len = Math.hypot(dx, dy, dz);
        dx /= len;
        dy /= len;
        dz /= len;
        let f = power * (0.7 + rng.next() * 0.6);
        let x = cx;
        let y = cy;
        let z = cz;
        for (; f > 0; f -= 0.22500001) {
          const bx = Math.floor(x);
          const by = Math.floor(y);
          const bz = Math.floor(z);
          if (by < -1 || by > blocks.height + 8) break;
          const id = blocks.get(bx, by, bz);
          if (id !== B.AIR) f -= (blastResistance(id) + 0.3) * 0.3;
          if (f > 0) affected.add(key(bx, by, bz));
          x += dx * 0.3;
          y += dy * 0.3;
          z += dz * 0.3;
        }
      }

  // Entities first (vanilla hurts entities before removing blocks).
  const diameter = power * 2;
  const chain: EndCrystal[] = [];
  for (const f of world.fighters) {
    if (f.dead) continue;
    const dist = Math.hypot(f.pos.x - cx, f.pos.y - cy, f.pos.z - cz) / diameter;
    if (dist > 1) continue;
    const bb = f.aabb();
    const seen = seenPercent(world, cx, cy, cz, bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ);
    const impact = (1 - dist) * seen;
    const damage = ((impact * impact + impact) / 2) * 7 * diameter + 1;
    // The push points from the centre to the player's eyes.
    let kx = f.pos.x - cx;
    let ky = f.pos.y + f.eyeHeight() - cy;
    let kz = f.pos.z - cz;
    const kl = Math.hypot(kx, ky, kz);
    const res = hurt(f, damage, opts.source && opts.source !== f ? opts.source : null, false, false, false, 'explosion');
    if (res.damaged && opts.source && opts.source !== f) {
      opts.source.stats.damageDealt += res.dealt;
      opts.source.stats.explosionDamage += res.dealt;
    }
    f.events.push({ type: 'explosionHit', damage: res.dealt });
    if (kl > 1e-6) {
      kx /= kl;
      ky /= kl;
      kz /= kl;
      const kb = impact * (1 - Math.min(1, Math.max(0, f.armor.explosionKnockbackResistance)));
      if (kb > 0) {
        f.vel.x += kx * kb;
        f.vel.y += ky * kb;
        f.vel.z += kz * kb;
        f.serverVel.x += kx * kb;
        f.serverVel.y += ky * kb;
        f.serverVel.z += kz * kb;
      }
    }
  }
  for (const c of world.crystals) {
    if (c.removed) continue;
    if (Math.hypot(c.x - cx, c.y - cy, c.z - cz) / diameter <= 1) {
      c.removed = true;
      chain.push(c);
    }
  }
  // Dropped items in the blast are destroyed.
  for (const it of world.items) if (Math.hypot(it.pos.x - cx, it.pos.y - cy, it.pos.z - cz) < diameter * 0.75) it.removed = true;

  // Blocks: destroy what the rays got through (placed blocks only; never the map).
  const airCells: [number, number, number][] = [];
  for (const k of affected) {
    const x = (k % 4096) - 2048;
    const z = (Math.floor(k / 4096) % 4096) - 2048;
    const y = Math.floor(k / (4096 * 4096)) - 64;
    if (!blocks.inside(x, y, z)) continue;
    const id = blocks.get(x, y, z);
    if (id === B.AIR) airCells.push([x, y, z]);
    else if (id !== B.BEDROCK) {
      blocks.set(x, y, z, B.AIR);
      airCells.push([x, y, z]);
    }
  }
  if (opts.fire) {
    for (const [x, y, z] of airCells) {
      if (rng.int(0, 2) === 0 && blocks.get(x, y, z) === B.AIR && isSolid(blocks.get(x, y - 1, z))) blocks.set(x, y, z, B.FIRE);
    }
  }
  world.emit({ type: 'explosion', x: cx, y: cy, z: cz, power });

  for (const c of chain) {
    if (opts.source) opts.source.stats.crystalsBroken++;
    explode(world, c.x, c.y, c.z, 6, { source: opts.source });
  }
}
