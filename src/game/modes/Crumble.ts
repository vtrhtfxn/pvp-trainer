import { B } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, fill, freeForAll, lastStanding, noDamage, place, ring } from './party';

/** The TNT floors, top to bottom (the cell layer each one sits in). */
const LAYERS = [-1, -7, -13, -19];
/** Ticks a block lasts after someone steps on it. */
const FUSE = 7;

/**
 * Crumble: four big floors of TNT stacked over the void, each with islands off its edges to
 * parkour out to when the middle is full of holes. Every block you step on drops away a moment
 * later, so you have to keep running; fall through a hole and you land on the floor below. Drop
 * out of the bottom one and you're out. No fighting; the last one still standing wins.
 */
export class Crumble implements GameMode {
  readonly id = 'crumble' as const;
  /** "x,y,z" → the tick its block drops away. */
  private fuses = new Map<string, number>();
  private out: Fighter[] = [];
  private announcements: ScoreLine[] = [];
  private ticks = 0;

  setup(m: Match) {
    const w = m.world;
    const b = w.blocks;
    b.clear();
    // Each floor is a big square (bigger with more players) with islands off its edges: a ring
    // of 5×5 ones two blocks out, and 3×3 ones a three-block jump beyond those. Every other
    // floor has them off the sides, the rest off the corners.
    const H = Math.min(26, 14 + m.fighters.length);
    LAYERS.forEach((y, layer) => {
      fill(b, -H, y, -H, H, y, H, B.TNT);
      for (const dx of [-1, 0, 1])
        for (const dz of [-1, 0, 1]) {
          if ((dx === 0 && dz === 0) || (dx !== 0 && dz !== 0) !== (layer % 2 === 1)) continue;
          const ax = dx * (H + 5);
          const az = dz * (H + 5);
          fill(b, ax - 2, y, az - 2, ax + 2, y, az + 2, B.TNT);
          const bx = dx * (H + 12);
          const bz = dz * (H + 12);
          fill(b, bx - 1, y, bz - 1, bx + 1, y, bz + 1, B.TNT);
        }
    });
    w.protectMap = true;
    w.noPvp = true;
    w.voidY = LAYERS[LAYERS.length - 1] - 4;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.fuses.clear();
    this.out = [];
    this.announcements = [];
    this.ticks = 0;
    const spots = ring(m.fighters.length, H * 0.6);
    m.fighters.forEach((f, i) => place(f, spots[i], EMPTY_KIT));
  }

  tick(m: Match) {
    noDamage(m);
    if (m.phase !== 'fight') return;
    this.ticks++;
    const b = m.world.blocks;
    // Light the blocks under everyone standing on them.
    for (const f of m.fighters) {
      if (f.dead || !f.onGround) continue;
      const y = Math.floor(f.pos.y + 0.01) - 1;
      for (const ox of [-0.3, 0.3])
        for (const oz of [-0.3, 0.3]) {
          const x = Math.floor(f.pos.x + ox);
          const z = Math.floor(f.pos.z + oz);
          const k = `${x},${y},${z}`;
          if (b.get(x, y, z) === B.TNT && !this.fuses.has(k)) this.fuses.set(k, this.ticks + FUSE);
        }
    }
    for (const [k, at] of this.fuses) {
      if (at > this.ticks) continue;
      this.fuses.delete(k);
      const [x, y, z] = k.split(',').map(Number);
      if (b.get(x, y, z) === B.TNT) {
        b.set(x, y, z, B.AIR);
        m.world.emit({ type: 'blockBreak', x, y, z, block: B.TNT });
      }
    }
    for (const f of m.fighters) {
      if (!f.dead || this.out.includes(f)) continue;
      this.out.push(f);
      const left = alive(m).length;
      this.announcements.push({ text: `${f.name} fell out! ${left} left.`, color: '#ffaa00' });
    }
  }

  winner(m: Match): Fighter | null {
    const left = alive(m);
    const last = lastStanding(m);
    if (last) return last;
    // Everyone out on the same tick: the last one to drop wins.
    if (!left.length) return this.out[this.out.length - 1] ?? null;
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const floor = LAYERS.findIndex((y) => viewer.pos.y >= y + 0.5);
    return [
      { text: 'CRUMBLE', color: '#ff5555' },
      { text: 'Keep running: the floor drops away!' },
      { text: `Players left: ${alive(m).length}` },
      { text: viewer.dead ? 'You are out' : `Floor ${floor < 0 ? '—' : floor + 1} of ${LAYERS.length}`, color: viewer.dead ? '#ff5555' : '#55ff55' },
      { text: `Time: ${Math.floor(this.ticks / 20)}s` },
    ];
  }

  title(_m: Match, viewer: Fighter): { title: string; sub: string } | null {
    return viewer.dead ? { title: 'YOU FELL OUT!', sub: 'Watching the rest' } : null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }

  /**
   * The bot never stops moving: it heads for the solid block on its floor farthest from where
   * anyone has been (the better it is, the farther it looks), jumping holes on the way.
   */
  botTick(m: Match, c: BotControl): boolean {
    const me = c.bot;
    c.setLabel('Running');
    c.emptyHand();
    const b = m.world.blocks;
    const y = Math.floor(me.pos.y + 0.01) - 1;
    const safe = (x: number, z: number) => b.get(x, y, z) === B.TNT && !this.fuses.has(`${x},${y},${z}`);
    const st = (this.plans.get(me) ?? { x: me.pos.x, z: me.pos.z, t: 0 });
    this.plans.set(me, st);
    const reached = Math.hypot(st.x - me.pos.x, st.z - me.pos.z) < 1.2;
    if (reached || --st.t <= 0 || !safe(Math.floor(st.x), Math.floor(st.z))) {
      // Look over the floor for the best spot: untouched, with untouched blocks around it, not
      // too far (low tiers look less far and less well).
      const look = 4 + Math.round(c.skill * 6);
      let best: { x: number; z: number; score: number } | null = null;
      for (let i = 0; i < 24; i++) {
        const x = Math.floor(me.pos.x) + c.rng.int(-look, look);
        const z = Math.floor(me.pos.z) + c.rng.int(-look, look);
        if (!safe(x, z)) continue;
        let around = 0;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (safe(x + dx, z + dz)) around++;
        const d = Math.hypot(x + 0.5 - me.pos.x, z + 0.5 - me.pos.z);
        const score = around * (0.5 + c.skill) + Math.min(d, 5) * 0.3 + c.rng.next() * (1.5 - c.skill);
        if (!best || score > best.score) best = { x: x + 0.5, z: z + 0.5, score };
      }
      if (best) Object.assign(st, { x: best.x, z: best.z, t: 30 });
      else Object.assign(st, { x: me.pos.x + c.rng.range(-3, 3), z: me.pos.z + c.rng.range(-3, 3), t: 10 });
    }
    c.walkTo(st.x, st.z, 0.3, true);
    // A hole right ahead with a floor beyond it: jump it.
    const yaw = me.yaw;
    const ax = Math.floor(me.pos.x - Math.sin(yaw) * 0.9);
    const az = Math.floor(me.pos.z - Math.cos(yaw) * 0.9);
    const bx = Math.floor(me.pos.x - Math.sin(yaw) * 2);
    const bz = Math.floor(me.pos.z - Math.cos(yaw) * 2);
    if (me.onGround && b.get(ax, y, az) !== B.TNT && b.get(bx, y, bz) === B.TNT && c.skill > 0.15) c.input.jump = true;
    // Never stand still: standing still is falling.
    return true;
  }

  private plans = new Map<Fighter, { x: number; z: number; t: number }>();
}
