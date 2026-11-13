import { B, isSolid, type Blocks } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { Loadout } from '../kits';
import type { ModeHost } from './GameMode';

/** Shared bits of the party minigames (Sumo, Crumble, Hot Potato, Whodunit). */

export function fill(b: Blocks, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number, data = 0) {
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++)
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) b.set(x, y, z, id, data);
}

/** Everyone for themselves (each on a team of their own), or two teams in a 2v2. */
export function freeForAll(m: ModeHost) {
  m.fighters.forEach((f, i) => (f.team = m.partyTeams ? i % 2 : i));
}

/** The last one standing — or in a 2v2, someone from the last team standing. */
export function lastStanding(m: ModeHost): Fighter | null {
  const left = alive(m);
  if (!left.length) return null;
  return left.every((f) => f.team === left[0].team) ? left[0] : null;
}

/** Everyone still in who is on the other side from `f`. */
export function enemiesLeft(m: ModeHost, f: Fighter): Fighter[] {
  return alive(m).filter((g) => g !== f && g.team !== f.team);
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

/** A round slab of `id` (radius `r`, one block thick) centred on (cx, cz) at height y. */
export function disc(b: Blocks, cx: number, cz: number, y: number, r: number, id: number, data = 0) {
  for (let x = -Math.ceil(r); x <= Math.ceil(r); x++)
    for (let z = -Math.ceil(r); z <= Math.ceil(r); z++) if (x * x + z * z <= (r + 0.3) * (r + 0.3)) b.set(cx + x, y, cz + z, id, data);
}

/**
 * Where bots can walk on a map that doesn't change (a house with rooms): every floor cell with
 * two blocks of air over solid ground, and the way from any of them to any other. Bots follow it
 * around walls instead of walking into them.
 */
export class NavGrid {
  private readonly size: number;
  private readonly open: Uint8Array;
  /** Steps to a goal cell from every cell (-1: no way), per goal, for the goals asked lately. */
  private readonly fields = new Map<number, Int16Array>();

  constructor(
    b: Blocks,
    private readonly half: number,
    y = 0,
  ) {
    this.size = half * 2 + 1;
    this.open = new Uint8Array(this.size * this.size);
    for (let z = -half; z <= half; z++)
      for (let x = -half; x <= half; x++) if (!isSolid(b.get(x, y, z)) && !isSolid(b.get(x, y + 1, z)) && isSolid(b.get(x, y - 1, z))) this.open[this.idx(x, z)] = 1;
  }

  private idx(x: number, z: number): number {
    return (z + this.half) * this.size + (x + this.half);
  }

  walkable(x: number, z: number): boolean {
    return Math.abs(x) <= this.half && Math.abs(z) <= this.half && this.open[this.idx(x, z)] === 1;
  }

  private field(goal: number): Int16Array {
    let f = this.fields.get(goal);
    if (f) return f;
    if (this.fields.size > 96) this.fields.clear();
    f = new Int16Array(this.open.length).fill(-1);
    f[goal] = 0;
    const queue = [goal];
    const n = this.size;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      const cx = c % n;
      for (const d of [-1, 1, -n, n]) {
        const o = c + d;
        if (o < 0 || o >= f.length || f[o] >= 0 || !this.open[o]) continue;
        if ((d === -1 && cx === 0) || (d === 1 && cx === n - 1)) continue;
        f[o] = f[c] + 1;
        queue.push(o);
      }
    }
    this.fields.set(goal, f);
    return f;
  }

  /** A body 0.6 wide can walk the straight line from a to b. */
  private clear(ax: number, az: number, bx: number, bz: number): boolean {
    const d = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(d * 4));
    for (let i = 0; i <= steps; i++) {
      const x = ax + ((bx - ax) * i) / steps;
      const z = az + ((bz - az) * i) / steps;
      for (const ox of [-0.35, 0.35]) for (const oz of [-0.35, 0.35]) if (!this.walkable(Math.floor(x + ox), Math.floor(z + oz))) return false;
    }
    return true;
  }

  /**
   * Where to walk next to get from (fx, fz) to (tx, tz): a point a few blocks along the way that
   * can be walked to in a straight line. Null when there's no way (or no need: go straight).
   */
  next(fx: number, fz: number, tx: number, tz: number): { x: number; z: number } | null {
    const sx = Math.floor(fx);
    const sz = Math.floor(fz);
    let gx = Math.floor(tx);
    let gz = Math.floor(tz);
    if (!this.walkable(sx, sz)) return null;
    if (!this.walkable(gx, gz)) {
      // The goal is on furniture or in a wall: the nearest floor next to it.
      let best = Infinity;
      let bx = gx;
      let bz = gz;
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++) {
          const d = dx * dx + dz * dz;
          if (d < best && this.walkable(gx + dx, gz + dz)) {
            best = d;
            bx = gx + dx;
            bz = gz + dz;
          }
        }
      if (best === Infinity) return null;
      gx = bx;
      gz = bz;
    }
    const f = this.field(this.idx(gx, gz));
    let c = this.idx(sx, sz);
    if (f[c] <= 0) return null;
    if (this.clear(fx, fz, tx, tz)) return null;
    const n = this.size;
    let out: { x: number; z: number } | null = null;
    for (let step = 0; step < 8 && f[c] > 0; step++) {
      let nextC = -1;
      for (const d of [-1, 1, -n, n]) {
        const o = c + d;
        if (o >= 0 && o < f.length && f[o] >= 0 && f[o] < f[c]) nextC = o;
      }
      if (nextC < 0) break;
      c = nextC;
      const px = (c % n) - this.half + 0.5;
      const pz = Math.floor(c / n) - this.half + 0.5;
      if (out && !this.clear(fx, fz, px, pz)) break;
      out = { x: px, z: pz };
    }
    return out;
  }
}
