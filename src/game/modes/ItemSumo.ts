import atomic from '../../assets/maps/atomic.json';
import atomicII from '../../assets/maps/atomic_ii.json';
import calima from '../../assets/maps/calima.json';
import gjoll from '../../assets/maps/gjoll.json';
import weald from '../../assets/maps/weald.json';
import { placeMap, type GameMap } from '../../maps/gameMap';
import { B, isSolid } from '../Blocks';
import type { Fighter } from '../Fighter';
import type { ItemStack } from '../items';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, enemiesLeft, freeForAll, noDamage, place } from './party';

/**
 * Item Sumo, on Overcast Community's Item Sumo maps (by zzuf, CC BY-SA 4.0): everyone starts on
 * a pillar of their own around a floating centre, with wool to bridge out. No damage, only
 * knockback; everyone gets a random item every few seconds (knockback sticks, snowballs, wind
 * charges, pearls, fireballs, potions, more wool). Three lives each — fall into the void and
 * you're back on a pillar three seconds later. Stand on the centre for 20 seconds in a row and
 * you win outright; otherwise the last one with lives left wins. After two and a half minutes the
 * edge starts crumbling toward the middle.
 */
export const ITEM_SUMO_MAPS = [atomic, atomicII, calima, gjoll, weald] as GameMap[];

const LIVES = 3;
/** What everyone starts (and respawns) with: wool to bridge out. */
const START: ItemStack[] = [{ id: 'red_wool', count: 48 }];
const RESPAWN_TICKS = 60;
/** The first item comes 5 s in, then one every 8 s. */
const FIRST_ITEM = 100;
const ITEM_EVERY = 160;
/** Ticks on the centre (in a row) to win. */
const HOLD_TICKS = 400;
/** The edge starts crumbling after this, one block every 1.5 s. */
const CRUMBLE_AT = 150 * 20;
const CRUMBLE_EVERY = 30;
/** Time's up at 5:00: most lives left wins (then most knock-offs). */
const TIME_LIMIT = 300 * 20;

type Drop = { stack: ItemStack; name: string; weight: number };
const DROPS: Drop[] = [
  { stack: { id: 'stick', count: 1, ench: { knockback: 2 } }, name: 'a Knockback Stick', weight: 4 },
  { stack: { id: 'snowball', count: 6 }, name: '6 Snowballs', weight: 4 },
  { stack: { id: 'egg', count: 6 }, name: '6 Eggs', weight: 2 },
  { stack: { id: 'wind_charge', count: 3 }, name: '3 Wind Charges', weight: 3 },
  { stack: { id: 'ender_pearl', count: 1 }, name: 'an Ender Pearl', weight: 2 },
  { stack: { id: 'fire_charge', count: 2 }, name: '2 Fireballs', weight: 2 },
  { stack: { id: 'red_wool', count: 12 }, name: '12 Wool', weight: 3 },
  { stack: { id: 'potion', count: 1, potion: 'bw_jump' }, name: 'a Jump Potion', weight: 1 },
  { stack: { id: 'potion', count: 1, potion: 'bw_speed' }, name: 'a Speed Potion', weight: 1 },
];

interface Life {
  lives: number;
  respawnAt: number | null;
  handled: boolean;
  /** Ticks on the centre in a row. */
  hold: number;
  /** People this one knocked off. */
  kos: number;
}

export class ItemSumo implements GameMode {
  readonly id = 'itemsumo' as const;
  readonly map: GameMap;
  private announcements: ScoreLine[] = [];
  private lives = new Map<Fighter, Life>();
  private ticks = 0;
  private holder: Fighter | null = null;
  /** Whoever lost their last life last (wins if everyone is out at once). */
  private lastOut: Fighter | null = null;
  /** Who won when time ran out. */
  private timeWinner: Fighter | null = null;
  /** The crumbling edge's radius (null until it starts). */
  private edge: number | null = null;
  private readonly minEdge: number;

  constructor(mapId?: string, pick = Math.random()) {
    this.map = ITEM_SUMO_MAPS.find((m) => m.id === mapId) ?? ITEM_SUMO_MAPS[Math.floor(pick * ITEM_SUMO_MAPS.length) % ITEM_SUMO_MAPS.length];
    // The edge stops a little outside the centre spot(s).
    this.minEdge = Math.max(...this.map.points.map((p) => Math.hypot((p[0] + p[3] + 1) / 2, (p[2] + p[5] + 1) / 2))) + 4;
  }

  get mapId(): string {
    return this.map.id;
  }

  private life(f: Fighter): Life {
    let l = this.lives.get(f);
    if (!l) this.lives.set(f, (l = { lives: LIVES, respawnAt: null, handled: false, hold: 0, kos: 0 }));
    return l;
  }

  /**
   * A spawn spread out from the others (`i` of `n`), facing the middle; once the edge has taken a
   * pillar, the next one still standing, and with none left, the centre.
   */
  private spawnSpot(m: Match, i: number, n: number) {
    const s = this.map.spawns;
    const b = m.world.blocks;
    const first = Math.floor((i * s.length) / Math.max(1, n));
    for (let k = 0; k < s.length; k++) {
      const [x, y, z] = s[(first + k) % s.length];
      if (isSolid(b.get(Math.floor(x), y - 1, Math.floor(z)))) return { x, y, z, yaw: Math.atan2(x, z) };
    }
    const p = this.map.points[0];
    return { x: (p[0] + p[3] + 1) / 2, y: p[1], z: (p[2] + p[5] + 1) / 2, yaw: 0 };
  }

  private kit() {
    return { ...EMPTY_KIT, hotbar: START.map((x) => ({ ...x })) };
  }

  setup(m: Match) {
    const w = m.world;
    placeMap(w.blocks, this.map);
    w.protectMap = true;
    w.voidY = this.map.voidY;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.lives = new Map();
    this.announcements = [];
    this.ticks = 0;
    this.holder = null;
    this.lastOut = null;
    this.timeWinner = null;
    this.edge = null;
    m.fighters.forEach((f, i) => place(f, this.spawnSpot(m, i, m.fighters.length), this.kit()));
  }

  /** Standing on one of the map's centre spots. */
  private onCentre(f: Fighter): boolean {
    if (f.dead || !f.onGround) return false;
    const x = Math.floor(f.pos.x);
    const y = Math.floor(f.pos.y + 0.01);
    const z = Math.floor(f.pos.z);
    return this.map.points.some((p) => x >= p[0] && x <= p[3] && z >= p[2] && z <= p[5] && y >= p[1] && y <= p[4] + 1);
  }

  tick(m: Match) {
    noDamage(m);
    if (m.phase !== 'fight') return;
    const t = ++this.ticks;
    const rng = m.world.rng;

    for (const [i, f] of m.fighters.entries()) {
      const life = this.life(f);
      if (f.dead && !life.handled) {
        life.handled = true;
        life.lives--;
        life.hold = 0;
        const by = f.lastDamage?.attacker;
        if (by && by !== f && by.team !== f.team) this.life(by).kos++;
        const how = by && by !== f ? `${f.name} ${f.id === 'player' ? 'were' : 'was'} knocked off by ${by.name}` : `${f.name} fell off`;
        if (life.lives > 0) {
          life.respawnAt = t + RESPAWN_TICKS;
          this.announcements.push({ text: `${how}! ${life.lives} ${life.lives === 1 ? 'life' : 'lives'} left.`, color: '#ffaa00' });
        } else {
          this.lastOut = f;
          this.announcements.push({ text: `${how}! OUT OF LIVES.`, color: '#ff5555' });
        }
      }
      if (f.dead && life.respawnAt !== null && t >= life.respawnAt) {
        life.respawnAt = null;
        life.handled = false;
        place(f, this.spawnSpot(m, i, m.fighters.length), this.kit());
        m.onRespawn?.(f);
      }
    }

    // Everyone still in gets an item.
    if (t >= FIRST_ITEM && (t - FIRST_ITEM) % ITEM_EVERY === 0) {
      const total = DROPS.reduce((a, d) => a + d.weight, 0);
      for (const f of alive(m)) {
        let r = rng.next() * total;
        const d = DROPS.find((x) => (r -= x.weight) < 0) ?? DROPS[0];
        f.addItem({ ...d.stack, ench: d.stack.ench ? { ...d.stack.ench } : undefined });
        // And always a few more blocks to bridge with.
        f.addItem({ id: 'red_wool', count: 8 });
      }
      this.announcements.push({ text: 'Everyone got an item!', color: '#55ffff' });
    }

    // The centre: 20 s on it in a row wins.
    for (const f of m.fighters) {
      const life = this.life(f);
      life.hold = this.onCentre(f) ? life.hold + 1 : 0;
      if (life.hold === 100) this.announcements.push({ text: `${f.name} ${f.id === 'player' ? 'are' : 'is'} holding the centre!`, color: '#55ff55' });
      if (life.hold >= HOLD_TICKS && !this.holder) this.holder = f;
    }

    if (t === TIME_LIMIT - 60 * 20) this.announcements.push({ text: 'One minute left! Most lives wins.', color: '#ffaa00' });
    if (t >= TIME_LIMIT && !this.timeWinner) {
      const score = (f: Fighter) => this.life(f).lives * 1000 + this.life(f).kos * 10 + (f.dead ? 0 : 1);
      this.timeWinner = [...m.fighters].sort((a, b) => score(b) - score(a))[0];
      this.announcements.push({ text: `Time's up! ${this.timeWinner.name} ${this.timeWinner.id === 'player' ? 'have' : 'has'} the most lives left.`, color: '#ffff55' });
    }

    // Late on, the edge crumbles toward the middle.
    if (t === CRUMBLE_AT) {
      this.edge = Math.ceil(Math.max(Math.abs(this.map.ox), Math.abs(this.map.ox + this.map.w), Math.abs(this.map.oz), Math.abs(this.map.oz + this.map.l)) * Math.SQRT2);
      this.announcements.push({ text: 'The edge is crumbling!', color: '#ff5555' });
    }
    if (this.edge !== null && t > CRUMBLE_AT && (t - CRUMBLE_AT) % CRUMBLE_EVERY === 0 && this.edge > this.minEdge) {
      this.edge--;
      this.crumble(m, this.edge);
    }
  }

  /** Drops every block further than `r` from the middle. */
  private crumble(m: Match, r: number) {
    const b = m.world.blocks;
    const R = r + 1.5;
    const y0 = this.map.oy;
    const y1 = this.map.oy + this.map.h + 4;
    for (let x = -Math.ceil(R); x <= Math.ceil(R); x++)
      for (let z = -Math.ceil(R); z <= Math.ceil(R); z++) {
        const d = Math.hypot(x + 0.5, z + 0.5);
        if (d <= r || d > R + 1) continue;
        for (let y = y0; y < y1; y++) if (b.get(x, y, z) !== B.AIR) b.set(x, y, z, B.AIR);
      }
  }

  winner(m: Match): Fighter | null {
    if (this.holder) return this.holder;
    if (this.timeWinner) return this.timeWinner;
    const left = m.fighters.filter((f) => this.life(f).lives > 0);
    if (left.length === 1) return left[0];
    // In a 2v2, a team wins once the other has no lives left.
    if (left.length > 1 && left.every((f) => f.team === left[0].team)) return left[0];
    // Everyone went out on the same tick: the last to fall.
    if (!left.length) return this.lastOut ?? m.fighters[0];
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const lines: ScoreLine[] = [
      { text: 'ITEM SUMO', color: '#ffff55' },
      { text: `Map: ${this.map.name}`, color: '#aaaaaa' },
    ];
    const next = this.ticks < FIRST_ITEM ? FIRST_ITEM - this.ticks : ITEM_EVERY - ((this.ticks - FIRST_ITEM) % ITEM_EVERY);
    lines.push({ text: `Next item in ${Math.ceil(next / 20)}s`, color: '#55ffff' });
    const best = [...m.fighters].sort((a, b) => this.life(b).hold - this.life(a).hold)[0];
    if (best && this.life(best).hold > 0) lines.push({ text: `Centre: ${best.name} ${Math.floor(this.life(best).hold / 20)}/20s`, color: '#55ff55' });
    else lines.push({ text: 'Hold the centre 20s to win' });
    const left = Math.max(0, Math.ceil((TIME_LIMIT - this.ticks) / 20));
    lines.push({ text: `Time left: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    if (this.edge !== null) lines.push({ text: `Edge: ${this.edge} blocks`, color: '#ff5555' });
    else lines.push({ text: `Edge crumbles in ${Math.max(0, Math.ceil((CRUMBLE_AT - this.ticks) / 20))}s`, color: '#ffaa00' });
    const shown = [...m.fighters].sort((a, b) => this.life(b).lives - this.life(a).lives).slice(0, 6);
    for (const f of shown) {
      const l = this.life(f).lives;
      lines.push({ text: `${f === viewer ? '» ' : ''}${f.name}: ${l > 0 ? '❤'.repeat(l) : 'out'}`, color: l > 0 ? (f === viewer ? '#ffffff' : '#cccccc') : '#777777' });
    }
    return lines;
  }

  title(m: Match, viewer: Fighter): { title: string; sub: string } | null {
    const life = this.life(viewer);
    if (viewer.dead && life.respawnAt !== null) return { title: 'YOU FELL!', sub: `Back in ${Math.max(1, Math.ceil((life.respawnAt - this.ticks) / 20))}s · ${life.lives} ${life.lives === 1 ? 'life' : 'lives'} left` };
    if (viewer.dead && life.lives <= 0) return { title: 'OUT!', sub: 'Watching the rest' };
    void m;
    return null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }

  /**
   * The bot: bridges out from its pillar (or drops onto lower ground) toward whoever is closest or
   * the centre, throws what it has at people in range, knocks them off with the stick up close,
   * and goes straight for anyone about to win on the centre.
   */
  botTick(m: Match, c: BotControl): boolean {
    const me = c.bot;
    const foes = enemiesLeft(m, me).sort((a, b) => dist(a, me) - dist(b, me));
    const target = foes[0];
    if (!target) return false;
    const p = this.map.points[0];
    const cx = (p[0] + p[3] + 1) / 2;
    const cz = (p[2] + p[5] + 1) / 2;
    const holding = foes.find((f) => this.life(f).hold > 120);
    const chase = holding ?? target;
    const d = dist(chase, me);
    const dy = chase.pos.y - me.pos.y;
    // Up close and level: the knockback game.
    if (d < 4.5 && Math.abs(dy) < 2.5) {
      c.setLabel('Fighting');
      if (!c.equip('stick')) c.emptyHand();
      c.fight(chase);
      c.keepOffEdge();
      return false;
    }
    // Throwables at someone in range (snowballs, eggs, fireballs, wind charges).
    if (d < 16 && c.rng.chance(0.05 + c.skill * 0.05)) {
      for (const id of ['snowball', 'egg', 'fire_charge', 'wind_charge'] as const) {
        if (me.slotOf(id) < 0) continue;
        // A burst this close would throw it off too.
        if ((id === 'fire_charge' || id === 'wind_charge') && d < 7) continue;
        c.equip(id);
        c.aimAt(chase.pos.x + chase.vel.x * d * 0.6, chase.pos.y + 1.2 + d * 0.05, chase.pos.z + chase.vel.z * d * 0.6, 1.4);
        me.startUsingItem(true);
        c.setLabel('Throwing');
        return false;
      }
    }
    // Where to: someone near (or about to win), else the centre.
    const toFoe = !!holding || d < 12;
    const goal = toFoe ? { x: chase.pos.x, z: chase.pos.z, y: chase.pos.y } : { x: cx, z: cz, y: p[1] };
    const gd = Math.hypot(goal.x - me.pos.x, goal.z - me.pos.z);
    c.setLabel(toFoe ? 'Going for them' : 'Going for the centre');
    if (gd < 0.8) return false;
    // Lower ground just ahead (the centre below a pillar): step off onto it.
    const ux = (goal.x - me.pos.x) / gd;
    const uz = (goal.z - me.pos.z) / gd;
    // (Checked all along the way down: walking off carries it a couple of blocks out.)
    if (goal.y < me.pos.y - 1.5 && me.onGround && [1.2, 2, 2.8].every((k) => this.landing(m, me.pos.x + ux * k, me.pos.z + uz * k, me.pos.y, goal.y))) {
      c.walkTo(goal.x, goal.z, 0.5, false);
      return true;
    }
    c.goTo(goal.x, goal.z, toFoe ? 2.5 : 0.6);
    return false;
  }

  /**
   * Somewhere safe to drop onto under (x, z): solid ground no lower than the goal's level, with
   * ground on every side of it too (not the edge of a thin bridge).
   */
  private landing(m: Match, x: number, z: number, y: number, goalY: number): boolean {
    const b = m.world.blocks;
    const fx = Math.floor(x);
    const fz = Math.floor(z);
    for (let yy = Math.floor(y + 0.01) - 1; yy >= Math.floor(goalY) - 1; yy--) {
      if (!isSolid(b.get(fx, yy, fz))) continue;
      return [-1, 0, 1].every((dx) => [-1, 0, 1].every((dz) => isSolid(b.get(fx + dx, yy, fz + dz))));
    }
    return false;
  }
}

function dist(a: Fighter, b: Fighter): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
}
