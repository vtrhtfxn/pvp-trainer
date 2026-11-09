import { B } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, freeForAll, noDamage, place, ring } from './party';

/** Radius of the round platform. */
const RADIUS = 7;

/**
 * Sumo: a round platform over the void, bare hands, no damage — only knockback. Knock the other
 * one off; whoever falls loses. With four players it's every one for themselves, last on the
 * platform wins.
 */
export class Sumo implements GameMode {
  readonly id = 'sumo' as const;
  private announcements: ScoreLine[] = [];
  private fallen: Fighter[] = [];

  setup(m: Match) {
    const w = m.world;
    const b = w.blocks;
    b.clear();
    for (let x = -RADIUS; x <= RADIUS; x++)
      for (let z = -RADIUS; z <= RADIUS; z++) {
        const d = Math.hypot(x + 0.5 - 0.5, z + 0.5 - 0.5);
        if (d > RADIUS + 0.3) continue;
        // A white ring at the edge so you can see where it ends.
        b.set(x, -1, z, d > RADIUS - 1.2 ? B.WOOL : B.STONE, d > RADIUS - 1.2 ? 0 : 0);
        b.set(x, -2, z, B.STONE);
      }
    w.protectMap = true;
    w.voidY = -5;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.fallen = [];
    this.announcements = [];
    const spots = ring(m.fighters.length, 2.5);
    m.fighters.forEach((f, i) => place(f, spots[i], EMPTY_KIT));
  }

  tick(m: Match) {
    noDamage(m);
    if (m.phase !== 'fight') return;
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
    if (Math.hypot(me.pos.x - 0.5, me.pos.z - 0.5) > RADIUS - 1.6 && Math.hypot(target.pos.x - me.pos.x, target.pos.z - me.pos.z) > 2.5) {
      c.walkTo(0.5, 0.5, 1, false);
      return false;
    }
    c.fight(target);
    c.keepOffEdge();
    return false;
  }
}
