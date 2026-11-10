import { B } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, disc, freeForAll, noDamage, place, ring } from './party';

/** The four ways out to the outposts. */
const DIRS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
/** Seconds until the outposts fall, and then between each ring of the platform dropping away. */
const OUTPOSTS_FALL = 75;
const SHRINK_EVERY = 12;
/** The platform never shrinks below this radius. */
const MIN_RADIUS = 5;

/**
 * Sumo: a big round platform over the void, bare hands, no damage — only knockback. Knock the
 * others off; whoever falls is out, last one on wins. Four outposts float off the edge, each
 * reached by a parkour run of rising stepping stones. After a while the outposts fall, and then
 * the platform itself shrinks ring by ring, so nobody can hide.
 */
export class Sumo implements GameMode {
  readonly id = 'sumo' as const;
  private announcements: ScoreLine[] = [];
  private fallen: Fighter[] = [];
  /** The platform's radius now (it grows with the number of players, then shrinks late on). */
  private radius = 11;
  private outposts = true;
  private ticks = 0;

  setup(m: Match) {
    const w = m.world;
    const b = w.blocks;
    b.clear();
    const R = (this.radius = 9 + m.fighters.length);
    disc(b, 0, 0, -2, R, B.STONE);
    disc(b, 0, 0, -1, R, B.WOOL, 0);
    disc(b, 0, 0, -1, R - 1.5, B.STONE);
    // A red spot in the middle to fight over.
    disc(b, 0, 0, -1, 1.5, B.WOOL, 14);
    for (const [dx, dz] of DIRS) {
      // Three stepping stones, two blocks apart, each one higher; then the outpost.
      for (let k = 0; k < 3; k++) b.set(dx * (R + 3 + k * 3), -1 + k, dz * (R + 3 + k * 3), B.WOOL, 4);
      disc(b, dx * (R + 13), dz * (R + 13), 1, 3, B.PLANKS);
      b.set(dx * (R + 13), 2, dz * (R + 13), B.GLOWSTONE);
    }
    w.protectMap = true;
    w.voidY = -6;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.fallen = [];
    this.announcements = [];
    this.outposts = true;
    this.ticks = 0;
    const spots = ring(m.fighters.length, Math.max(2.5, R * 0.45));
    m.fighters.forEach((f, i) => place(f, spots[i], EMPTY_KIT));
  }

  tick(m: Match) {
    noDamage(m);
    if (m.phase !== 'fight') return;
    this.ticks++;
    const b = m.world.blocks;
    const R = 9 + m.fighters.length;
    if (this.outposts && this.ticks >= OUTPOSTS_FALL * 20) {
      // The outposts and their stepping stones drop away.
      this.outposts = false;
      for (const [dx, dz] of DIRS) {
        for (let k = 0; k < 3; k++) b.set(dx * (R + 3 + k * 3), -1 + k, dz * (R + 3 + k * 3), B.AIR);
        disc(b, dx * (R + 13), dz * (R + 13), 1, 3, B.AIR);
        b.set(dx * (R + 13), 2, dz * (R + 13), B.AIR);
      }
      this.announcements.push({ text: 'The outposts have fallen! The platform shrinks next.', color: '#ff5555' });
    }
    const since = this.ticks - OUTPOSTS_FALL * 20;
    if (since > 0 && since % (SHRINK_EVERY * 20) === 0 && this.radius > MIN_RADIUS) {
      // The outer ring drops away.
      const old = this.radius;
      this.radius--;
      for (let x = -old - 1; x <= old + 1; x++)
        for (let z = -old - 1; z <= old + 1; z++) {
          if (x * x + z * z <= (this.radius + 0.3) * (this.radius + 0.3)) continue;
          if (b.get(x, -1, z) !== B.AIR) b.set(x, -1, z, B.AIR);
          if (b.get(x, -2, z) !== B.AIR) b.set(x, -2, z, B.AIR);
        }
      disc(b, 0, 0, -1, this.radius, B.WOOL, 0);
      disc(b, 0, 0, -1, this.radius - 1.5, B.STONE);
      disc(b, 0, 0, -1, 1.5, B.WOOL, 14);
      this.announcements.push({ text: 'The platform is shrinking!', color: '#ffaa00' });
    }
    for (const f of m.fighters) {
      if (f.dead && !this.fallen.includes(f)) {
        this.fallen.push(f);
        const by = f.lastDamage?.attacker;
        this.announcements.push({ text: by && by !== f ? `${f.name} ${f.id === 'player' ? 'were' : 'was'} knocked off by ${by.name}!` : `${f.name} fell off!`, color: '#ffaa00' });
      }
    }
  }

  winner(m: Match): Fighter | null {
    const left = alive(m);
    return left.length === 1 ? left[0] : null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    return [
      { text: 'SUMO', color: '#ffff55' },
      { text: 'Knock them off the platform!' },
      { text: this.outposts ? `Outposts fall in ${Math.max(0, OUTPOSTS_FALL - Math.floor(this.ticks / 20))}s` : `Platform radius: ${this.radius}`, color: '#ffaa00' },
      { text: `Still on: ${alive(m).length} of ${m.fighters.length}` },
      { text: viewer.dead ? 'You fell off' : 'You are still on', color: viewer.dead ? '#ff5555' : '#55ff55' },
    ];
  }

  title(_m: Match, viewer: Fighter): { title: string; sub: string } | null {
    return viewer.dead ? { title: 'YOU FELL!', sub: 'Watching the rest' } : null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }

  /** The bot boxes the nearest opponent and keeps itself off the edge. */
  botTick(m: Match, c: BotControl): boolean {
    const me = c.bot;
    const target = alive(m)
      .filter((f) => f !== me)
      .sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) - Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z))[0];
    if (!target) return false;
    c.setLabel('Sumo');
    c.emptyHand();
    // Too close to the edge: step back toward the middle first.
    if (Math.hypot(me.pos.x - 0.5, me.pos.z - 0.5) > this.radius - 1.6 && Math.hypot(target.pos.x - me.pos.x, target.pos.z - me.pos.z) > 2.5) {
      c.walkTo(0.5, 0.5, 1, false);
      return false;
    }
    c.fight(target);
    c.keepOffEdge();
    return false;
  }
}
