import { B } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { Loadout } from '../kits';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, enemiesLeft, fill, freeForAll, lastStanding, noDamage, place, ring } from './party';

/** Heights of the parkour loop's platforms, one after another (the cell layer of each). */
const LOOP_HEIGHTS = [2, 2, 3, 2, 3, 3, 2, 3];
/** Seconds of the first round; each later one is a little shorter (not under MIN_ROUND). */
const FIRST_ROUND = 25;
const MIN_ROUND = 15;
/** After an explosion, a short breather before the next player is lit. */
const BREAK_TICKS = 60;

const IT_KIT: Loadout = { hotbar: [{ id: 'tnt', count: 1 }], armor: [null, null, null, null], offhand: null };

/**
 * Hot Potato: a big walled yard with a parkour loop of floating platforms over it. One player is lit — TNT in hand, a fuse ticking. Hit someone to pass it on. When the
 * fuse runs out, whoever holds it blows up and is out, and the next round lights someone new.
 * The last one standing wins. Nobody takes damage from hits; the lit player runs a little faster.
 */
export class HotPotato implements GameMode {
  readonly id = 'hotpotato' as const;
  it: Fighter | null = null;
  round = 0;
  /** Ticks left on the fuse (or of the break before the next round, when nobody is lit). */
  private left = 0;
  private out: Fighter[] = [];
  private announcements: ScoreLine[] = [];
  /** Who passed it last, and when (no tagging straight back for a second). */
  private passedBy: Fighter | null = null;
  private passedAt = -100;
  private ticks = 0;
  private rng = 0;
  /** Arena half-size (the walls stand just outside it). */
  private half = 26;

  setup(m: Match) {
    const w = m.world;
    const b = w.blocks;
    b.clear();
    // A big grassy yard (bigger with more players) with a high stone wall around it.
    const H = (this.half = Math.min(40, 20 + 2 * m.fighters.length));
    fill(b, -H, -1, -H, H, -1, H, B.GRASS);
    fill(b, -H, -2, -H, H, -3, H, B.DIRT);
    for (const s of [-1, 1]) {
      fill(b, -H - 1, -1, s * (H + 1), H + 1, 6, s * (H + 1), B.COBBLESTONE);
      fill(b, s * (H + 1), -1, -H - 1, s * (H + 1), 6, H + 1, B.COBBLESTONE);
    }
    // The parkour loop: floating 2×2 platforms in a square around the yard, two blocks apart and
    // going up and down, with room to run underneath. Each side starts at a low one with steps up.
    const Q = Math.floor(H * 0.55);
    const sides: { at: (t: number) => [number, number]; inward: [number, number] }[] = [
      { at: (t) => [t, -Q], inward: [0, 1] },
      { at: (t) => [Q, t], inward: [-1, 0] },
      { at: (t) => [-t, Q], inward: [0, -1] },
      { at: (t) => [-Q, -t], inward: [1, 0] },
    ];
    let k = 0;
    for (const side of sides) {
      for (let t = -Q; t < Q; t += 4) {
        const [x, z] = side.at(t);
        const first = t === -Q;
        const y = first ? 2 : LOOP_HEIGHTS[k++ % LOOP_HEIGHTS.length];
        fill(b, x, y, z, x + 1, y, z + 1, B.PLANKS);
        if (first) {
          // Steps up from the grass, on the inside.
          const [ix, iz] = side.inward;
          const sx = x + (ix > 0 ? 2 : ix < 0 ? -1 : 0);
          const sz = z + (iz > 0 ? 2 : iz < 0 ? -1 : 0);
          fill(b, sx, 0, sz, sx, 1, sz, B.OAK_LOG);
          b.set(sx + ix, 0, sz + iz, B.OAK_LOG);
        }
      }
    }
    // A pavilion in the middle, up on four posts, and a run of platforms out to the loop.
    fill(b, -2, 3, -2, 2, 3, 2, B.PLANKS);
    for (const px of [-2, 2]) for (const pz of [-2, 2]) fill(b, px, 0, pz, px, 2, pz, B.OAK_LOG);
    b.set(0, 4, 0, B.GLOWSTONE);
    for (let z = -6; z > -Q + 2; z -= 4) fill(b, 0, 3, z, 1, 3, z + 1, B.PLANKS);
    // Things to dodge behind on the ground (off the diagonals, where everyone spawns).
    const P = Math.floor(Q / 2);
    for (const [x, z] of [
      [-P, 0],
      [P, 0],
      [0, P],
      [-P - 6, P + 6],
      [P + 6, -P - 6],
    ])
      fill(b, x - 1, 0, z - 1, x + 1, 1, z + 1, B.COBBLESTONE);
    w.protectMap = true;
    w.placeRule = () => false;
    w.voidY = -12;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.it = null;
    this.round = 0;
    this.left = 40;
    this.passedBy = null;
    this.passedAt = -100;
    this.ticks = 0;
    this.out = [];
    this.announcements = [];
    this.rng = m.world.rng.int(1, 2 ** 30);
    const spots = ring(m.fighters.length, Math.min(8 + m.fighters.length, Q - 3));
    m.fighters.forEach((f, i) => place(f, spots[i], EMPTY_KIT));
  }

  private pick(list: Fighter[]): Fighter {
    this.rng = (Math.imul(this.rng, 1103515245) + 12345) >>> 0;
    return list[(this.rng >>> 8) % list.length];
  }

  private light(f: Fighter) {
    if (this.it && !this.it.dead) {
      this.it.inventory[0] = null;
      this.it.effects.delete('speed');
    }
    this.it = f;
    f.inventory[0] = { ...IT_KIT.hotbar[0]! };
    f.selectSlot(0);
    f.addEffect('speed', 1, 20 * 120);
  }

  tick(m: Match) {
    if (m.phase !== 'fight') {
      noDamage(m);
      return;
    }
    this.ticks++;
    for (const f of m.fighters) {
      if (f.dead && !this.out.includes(f)) this.out.push(f);
      // Everyone runs a bit: Speed I for the hunted, Speed II for the lit one (light()).
      if (!f.dead && f !== this.it && !f.effects.has('speed')) f.addEffect('speed', 0, 20 * 120);
    }
    const it = this.it;
    // Passing it on: the lit player landed a hit.
    if (it && !it.dead) {
      for (const f of m.fighters) {
        if (f === it || f.dead) continue;
        // Hit by them this tick (the hit took some health, given back below).
        if (f.health < f.maxHealth && f.lastDamage?.attacker === it && !(f === this.passedBy && this.ticks - this.passedAt < 20)) {
          this.passedBy = it;
          this.passedAt = this.ticks;
          this.light(f);
          this.announcements.push({ text: `${f.name} ${f.id === 'player' ? 'are' : 'is'} IT!`, color: '#ff5555' });
          break;
        }
      }
    }
    noDamage(m);
    if (--this.left > 0) return;
    if (this.it && !this.it.dead) {
      // The fuse ran out.
      const boom = this.it;
      m.world.emit({ type: 'explosion', x: boom.pos.x, y: boom.pos.y + 1, z: boom.pos.z, power: 3 });
      boom.inventory[0] = null;
      boom.health = 0;
      boom.die();
      this.out.push(boom);
      this.announcements.push({ text: `BOOM! ${boom.name} blew up. ${alive(m).length} left.`, color: '#ffaa00' });
      this.it = null;
      this.left = BREAK_TICKS;
      return;
    }
    const left = alive(m);
    if (left.length < 2 || lastStanding(m)) return;
    this.round++;
    this.light(this.pick(left));
    this.left = 20 * Math.max(MIN_ROUND, FIRST_ROUND - (this.round - 1) * 3);
    this.announcements.push({ text: `Round ${this.round}: ${this.it!.name} ${this.it!.id === 'player' ? 'are' : 'is'} IT! Pass it on before it blows.`, color: '#ff5555' });
  }

  winner(m: Match): Fighter | null {
    const left = alive(m);
    if (left.length === 1 && !this.it) return left[0];
    if (left.length === 1 && this.it === left[0]) return left[0];
    // 2v2: one team left (a lit potato among them can only go to an enemy, and there are none).
    if (m.partyTeams && left.length > 1) return lastStanding(m);
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const s = Math.max(0, Math.ceil(this.left / 20));
    return [
      { text: 'HOT POTATO', color: '#ff5555' },
      { text: this.it ? `Round ${this.round} · ${s}s on the fuse` : this.round ? `Next round in ${s}s` : `Lighting up in ${s}s` },
      { text: this.it ? `IT: ${this.it.name}` : 'Nobody is lit', color: '#ffaa00' },
      { text: `Players left: ${alive(m).length}` },
      { text: viewer.dead ? 'You blew up' : viewer === this.it ? 'YOU ARE IT — hit someone!' : 'Run from the lit player!', color: viewer === this.it ? '#ff5555' : viewer.dead ? '#aaaaaa' : '#55ff55' },
    ];
  }

  title(_m: Match, viewer: Fighter): { title: string; sub: string } | null {
    if (viewer.dead) return { title: 'BOOM!', sub: 'You blew up' };
    if (viewer === this.it && this.left > 0) return { title: 'YOU ARE IT!', sub: `Hit someone — ${Math.ceil(this.left / 20)}s` };
    return null;
  }

  tagStatus(_m: Match, f: Fighter): string | null {
    return f === this.it ? 'IT!' : null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }

  /** Lit: chase the nearest player and hit them. Not lit: keep away from whoever is. */
  botTick(m: Match, c: BotControl): boolean {
    const me = c.bot;
    const it = this.it;
    if (me === it) {
      c.setLabel('IT!');
      // Whoever is nearest; someone up on the parkour course only if nobody on the ground is close.
      const reach = (f: Fighter) => Math.hypot(f.pos.x - me.pos.x, f.pos.z - me.pos.z) + (f.pos.y > 1.5 ? 12 : 0);
      const near = enemiesLeft(m, me)
        .filter((f) => !(f === this.passedBy && this.ticks - this.passedAt < 20))
        .sort((a, b) => reach(a) - reach(b))[0];
      if (near) c.fight(near);
      return false;
    }
    c.setLabel('Running');
    c.emptyHand();
    // A teammate holding it can't pass it to you (hits between teammates do nothing).
    if (!it || it.dead || it.team === me.team) {
      // Between rounds: drift toward the middle.
      c.walkTo(0.5, 0.5, 4, false);
      return false;
    }
    const dx = me.pos.x - it.pos.x;
    const dz = me.pos.z - it.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    // Far enough: wander a little; close: run straight away, sliding along the walls.
    const HALF = this.half;
    const scared = 10 + c.skill * 6;
    if (d > scared) {
      c.walkTo(me.pos.x + (dx / d) * 2, me.pos.z + (dz / d) * 2, 0.5, false);
      return false;
    }
    let tx = me.pos.x + (dx / d) * 6;
    let tz = me.pos.z + (dz / d) * 6;
    // Cornered against a wall: run along it instead (whichever way is away from them).
    if (Math.abs(tx) > HALF - 1.5) tx = Math.sign(tx) * (HALF - 1.5);
    if (Math.abs(tz) > HALF - 1.5) tz = Math.sign(tz) * (HALF - 1.5);
    if (Math.hypot(tx - me.pos.x, tz - me.pos.z) < 2) {
      tx = me.pos.x + (dz / d) * 6 * (me.pos.x * dz > 0 ? -1 : 1);
      tz = me.pos.z - (dx / d) * 6 * (me.pos.x * dz > 0 ? -1 : 1);
    }
    c.walkTo(tx, tz, 0.5, true);
    return false;
  }
}
