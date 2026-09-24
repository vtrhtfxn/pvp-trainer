import * as C from '../core/constants';
import { V3, rayAABB, type AABB } from '../core/math';
import { B, type RayHit } from './Blocks';
import { EndCrystal } from './EndCrystal';
import { explode } from './Explosion';
import type { Fighter } from './Fighter';
import type { World } from './World';

const tmpBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const tmpEye = new V3();
const tmpDir = new V3();
const ray: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };

/** End crystals explode with power 6; respawn anchors with power 5 and fire. */
export const CRYSTAL_POWER = 6;
export const ANCHOR_POWER = 5;

/**
 * EndCrystalItem.useOn: the clicked block (any face) must be obsidian (the floor here is grass,
 * not bedrock), the block above it empty, and no entity — player or crystal — may overlap the
 * 1×2×1 space above it.
 */
export function canPlaceCrystal(world: World, x: number, y: number, z: number): boolean {
  const blocks = world.blocks;
  if (blocks.get(x, y, z) !== B.OBSIDIAN) return false;
  if (!blocks.inside(x, y + 1, z) || blocks.get(x, y + 1, z) !== B.AIR) return false;
  const minY = y + 1;
  const maxY = y + 3;
  const overlaps = (b: AABB) => b.maxX > x && b.minX < x + 1 && b.maxY > minY && b.minY < maxY && b.maxZ > z && b.minZ < z + 1;
  for (const f of world.fighters) if (!f.dead && overlaps(f.aabbInto(tmpBox))) return false;
  for (const c of world.crystals) if (!c.removed && overlaps(c.aabbInto(tmpBox))) return false;
  return true;
}

export function placeCrystal(world: World, owner: Fighter, x: number, y: number, z: number): EndCrystal {
  const c = new EndCrystal(x + 0.5, y + 1, z + 0.5, owner);
  world.crystals.push(c);
  owner.stats.crystalsPlaced++;
  world.emit({ type: 'crystalPlace', x: c.x, y: c.y, z: c.z });
  return c;
}

/** The crystal under `f`'s crosshair within attack reach (and not behind a block), or null. */
export function crosshairCrystal(f: Fighter, reach = C.ATTACK_REACH): { crystal: EndCrystal; t: number } | null {
  const world = f.world;
  if (!world.crystals.length) return null;
  const eye = f.eyePos(tmpEye);
  const d = f.look(tmpDir);
  let best: EndCrystal | null = null;
  let bestT = reach;
  for (const c of world.crystals) {
    if (c.removed) continue;
    const t = rayAABB(eye, d, c.aabbInto(tmpBox));
    if (t >= 0 && t <= bestT) {
      bestT = t;
      best = c;
    }
  }
  if (!best) return null;
  if (world.blocks.count && world.blocks.raycast(eye.x, eye.y, eye.z, d.x, d.y, d.z, bestT, 'outline', ray)) return null;
  return { crystal: best, t: bestT };
}

/**
 * Hitting a crystal (Player.attack → EndCrystal.hurt): any damage at all blows it up. The swing
 * still resets the attack cooldown like any attack.
 */
export function attackCrystal(attacker: Fighter, crystal: EndCrystal) {
  attacker.swing();
  attacker.resetAttackStrength();
  attacker.stats.swings++;
  detonateCrystal(attacker.world, crystal, attacker);
}

export function detonateCrystal(world: World, crystal: EndCrystal, source: Fighter | null) {
  if (crystal.removed) return;
  crystal.removed = true;
  if (source) source.stats.crystalsBroken++;
  explode(world, crystal.x, crystal.y, crystal.z, CRYSTAL_POWER, { source });
}

/** RespawnAnchorBlock.explode: the anchor goes and a power-5 blast with fire takes its place. */
export function detonateAnchor(world: World, x: number, y: number, z: number, source: Fighter | null) {
  world.blocks.set(x, y, z, B.AIR);
  if (source) source.stats.anchorsBlown++;
  explode(world, x + 0.5, y + 0.5, z + 0.5, ANCHOR_POWER, { fire: true, source });
}
