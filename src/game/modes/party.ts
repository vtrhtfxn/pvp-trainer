import { B, type Blocks } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { Loadout } from '../kits';
import type { ModeHost } from './GameMode';

/** Shared bits of the party minigames (Sumo, Crumble, Hot Potato, Whodunit). */

export function fill(b: Blocks, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, data = 0) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) b.set(x, y, z, id, data);
}

/** Everyone for themselves: each fighter on a team of their own. */
export function freeForAll(m: ModeHost) {
  m.fighters.forEach((f, i) => (f.team = i));
}

/** `n` spawn points on a circle of radius `r` around the middle, facing in. */
export function ring(n: number, r: number, y = 0): { x: number; y: number; z: number; yaw: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 + Math.PI / 4;
    const x = Math.sin(a) * r;
    const z = Math.cos(a) * r;
    // yaw 0 faces −z; face the middle.
    return { x: x + 0.5, y, z: z + 0.5, yaw: Math.atan2(x, z) };
  });
}

export const EMPTY_KIT: Loadout = { hotbar: [], armor: [null, null, null, null], offhand: null };

/** Puts `f` at `s` with `kit`, hunger off. */
export function place(f: Fighter, s: { x: number; y: number; z: number; yaw: number }, kit: Loadout) {
  f.respawn(s.x, s.y, s.z, s.yaw, kit);
  f.food.locked = true;
}

export function alive(m: ModeHost): Fighter[] {
  return m.fighters.filter((f) => !f.dead);
}

/** Nobody takes real damage: whatever a hit or a fall took is given straight back. */
export function noDamage(m: ModeHost) {
  for (const f of m.fighters) {
    if (f.dead) continue;
    f.health = f.maxHealth;
    f.absorption = 0;
  }
}

/** A floor of `id` over x0..x1, z0..z1 at height y (one block thick). */
export function floor(b: Blocks, x0: number, z0: number, x1: number, z1: number, y: number, id: number) {
  fill(b, x0, y, z0, x1, y, z1, id);
}

export const STONE = B.STONE;
