import { B, isSolid } from '../Blocks';
import { DroppedItem } from '../DroppedItem';
import type { Fighter } from '../Fighter';
import type { ItemId } from '../items';
import type { Loadout } from '../kits';
import type { BotControl, GameMode, ModeHost as Match, ScoreLine } from './GameMode';
import { EMPTY_KIT, alive, fill, freeForAll, noDamage, place, ring } from './party';

export type Role = 'murderer' | 'detective' | 'innocent';

/** Takes `n` of `id` out of `f`'s inventory. */
function take(f: Fighter, id: ItemId, n: number) {
  for (let i = 0; i < 36 && n > 0; i++) {
    const s = f.inventory[i];
    if (!s || s.id !== id) continue;
    const k = Math.min(n, s.count);
    s.count -= k;
    n -= k;
    if (s.count <= 0) f.inventory[i] = null;
  }
}

/** Manor half-size (the outer wall stands on ±HALF). */
const HALF = 17;
/** The game's length; if the murderer hasn't won by then, everyone left wins. */
const GAME_TICKS = 20 * 60 * 4;
/** A gold ingot appears every this many ticks (up to MAX_GOLD lying about). */
const GOLD_EVERY = 100;
const MAX_GOLD = 10;
/** Gold that buys a bow (and an arrow with it). */
const GOLD_FOR_BOW = 10;
/** The detective's arrow comes back this long after it is shot. */
const ARROW_RECHARGE = 100;

const MURDERER_KIT: Loadout = { hotbar: [null, { id: 'iron_sword', count: 1 }], armor: [null, null, null, null], offhand: null };
const DETECTIVE_KIT: Loadout = { hotbar: [null, { id: 'bow', count: 1 }, { id: 'arrow', count: 1 }], armor: [null, null, null, null], offhand: null };

interface BotMind {
  /** Fighters it has seen with a sword out, or seen killing. */
  suspects: Set<Fighter>;
  wander: { x: number; z: number; t: number };
  /** Ticks the bow has been drawn. */
  draw: number;
  /** The murderer bot's mark (null: blending in). */
  victim: Fighter | null;
  patience: number;
}

/**
 * Whodunit: a murder mystery in an old manor. One player is secretly the **murderer** (a sword
 * that kills in one hit), one the **detective** (a bow; its arrow comes back after 5 s), and the
 * rest are **innocents**. Gold ingots appear around the house: ten buy an innocent a bow. Nobody
 * is told who is who. The murderer wins by killing everyone; everyone else wins if the murderer
 * is shot, or if anyone is still alive after four minutes. Shoot an innocent and you die too.
 */
export class Whodunit implements GameMode {
  readonly id = 'whodunit' as const;
  readonly roles = new Map<Fighter, Role>();
  private ticks = 0;
  private goldTimer = 0;
  private arrowTimer = new Map<Fighter, number>();
  private announcements: ScoreLine[] = [];
  private dead = new Set<Fighter>();
  private minds = new Map<Fighter, BotMind>();
  /** Spots inside the house (floor cells) gold and wandering bots use. */
  private spots: { x: number; z: number }[] = [];

  role(f: Fighter): Role {
    return this.roles.get(f) ?? 'innocent';
  }

  setup(m: Match) {
    const w = m.world;
    const b = w.blocks;
    b.clear();
    // The house: a planked floor, stone walls, four rooms around a hall, lamps.
    fill(b, -HALF, -1, -HALF, HALF, -1, HALF, B.PLANKS);
    fill(b, -HALF, -2, -HALF, HALF, -2, HALF, B.STONE);
    for (const s of [-1, 1]) {
      fill(b, -HALF, 0, s * HALF, HALF, 3, s * HALF, B.COBBLESTONE);
      fill(b, s * HALF, 0, -HALF, s * HALF, 3, HALF, B.COBBLESTONE);
    }
    // Inner walls (a cross), with doorways.
    fill(b, -HALF, 0, 0, HALF, 2, 0, B.STONE);
    fill(b, 0, 0, -HALF, 0, 2, HALF, B.STONE);
    for (const d of [-9, 9]) {
      fill(b, d - 1, 0, 0, d + 1, 1, 0, B.AIR);
      fill(b, 0, 0, d - 1, 0, 1, d + 1, B.AIR);
    }
    fill(b, -1, 0, -1, 1, 2, 1, B.AIR); // the hall in the middle
    // Furniture: tables and shelves to break line of sight.
    for (const [x, z] of [
      [-12, -12],
      [12, 12],
      [-12, 12],
      [12, -12],
      [-5, -12],
      [5, 12],
      [-12, 5],
      [12, -5],
    ])
      fill(b, x - 1, 0, z, x + 1, 1, z, B.OAK_LOG);
    for (const [x, z] of [
      [-8, -8],
      [8, 8],
      [-8, 8],
      [8, -8],
    ])
      b.set(x, 0, z, B.GLOWSTONE);
    w.protectMap = true;
    w.placeRule = () => false;
    w.voidY = -10;
    w.rules.fallDamage = false;
    freeForAll(m);
    this.spots = [];
    for (let x = -HALF + 2; x <= HALF - 2; x += 2)
      for (let z = -HALF + 2; z <= HALF - 2; z += 2) if (b.get(x, 0, z) === B.AIR && b.get(x, 1, z) === B.AIR) this.spots.push({ x: x + 0.5, z: z + 0.5 });
    this.ticks = 0;
    this.goldTimer = 0;
    this.arrowTimer = new Map();
    this.announcements = [];
    this.dead = new Set();
    this.minds = new Map();
    // Secret roles.
    const order = [...m.fighters].sort(() => w.rng.next() - 0.5);
    this.roles.clear();
    order.forEach((f, i) => this.roles.set(f, i === 0 ? 'murderer' : i === 1 ? 'detective' : 'innocent'));
    const spawns = ring(m.fighters.length, 10);
    m.fighters.forEach((f, i) => {
      const r = this.role(f);
      place(f, spawns[i], r === 'murderer' ? MURDERER_KIT : r === 'detective' ? DETECTIVE_KIT : EMPTY_KIT);
      f.naturalRegen = false;
    });
  }

  private kill(m: Match, f: Fighter, by: Fighter | null, how: string) {
    if (f.dead) return;
    f.health = 0;
    f.die();
    this.dead.add(f);
    // A bow is dropped where its holder fell, for anyone (but the murderer) to pick up.
    if (f.countItem('bow') > 0) {
      const d = new DroppedItem({ id: 'bow', count: 1 }, f.pos.x, f.pos.y + 0.5, f.pos.z, m.world.rng);
      d.pickupDelay = 20;
      m.world.items.push(d);
      this.announcements.push({ text: 'A bow has been dropped!', color: '#55ffff' });
    }
    this.announcements.push({ text: how, color: '#ff5555' });
    void by;
  }

  tick(m: Match) {
    if (m.phase !== 'fight') {
      noDamage(m);
      return;
    }
    this.ticks++;
    const murderer = m.fighters.find((f) => this.role(f) === 'murderer')!;
    // Who hurt whom this tick: the murderer's sword and any arrow kill; fists do nothing.
    for (const f of m.fighters) {
      if (f.dead || f.health >= f.maxHealth) continue;
      const by = f.lastDamage?.attacker ?? null;
      if (!by || by === f) continue;
      const held = by.heldStack()?.id;
      const close = Math.hypot(by.pos.x - f.pos.x, by.pos.z - f.pos.z) < 4.2;
      if (by === murderer && held === 'iron_sword' && close) {
        this.kill(m, f, by, `${f.name} ${f.id === 'player' ? 'were' : 'was'} killed!`);
        this.witness(m, by, f);
      } else if (!close || held === 'bow') {
        // Shot.
        this.kill(m, f, by, f === murderer ? `${by.name} shot the murderer, ${f.name}!` : `${f.name} ${f.id === 'player' ? 'were' : 'was'} shot!`);
        if (f !== murderer && by !== murderer && !by.dead) this.kill(m, by, null, `${by.name} shot an innocent and died of guilt.`);
      }
    }
    noDamage(m);
    // The murderer can't use a bow: one picked up drops straight back.
    if (!murderer.dead && murderer.countItem('bow') > 0) {
      for (let i = 0; i < 36; i++) if (murderer.inventory[i]?.id === 'bow') murderer.inventory[i] = null;
      const d = new DroppedItem({ id: 'bow', count: 1 }, murderer.pos.x, murderer.pos.y + 0.5, murderer.pos.z, m.world.rng);
      d.pickupDelay = 40;
      m.world.items.push(d);
    }
    // Gold appears around the house.
    if (++this.goldTimer >= GOLD_EVERY && this.spots.length) {
      this.goldTimer = 0;
      const lying = m.world.items.filter((it) => !it.removed && it.stack.id === 'gold_ingot').length;
      if (lying < MAX_GOLD) {
        const s = this.spots[m.world.rng.int(0, this.spots.length - 1)];
        const d = new DroppedItem({ id: 'gold_ingot', count: 1 }, s.x, 0.3, s.z, m.world.rng);
        d.vel.set(0, 0, 0);
        d.pickupDelay = 0;
        m.world.items.push(d);
      }
    }
    for (const f of m.fighters) {
      if (f.dead) continue;
      // Ten gold: a bow (innocents) or another arrow (anyone who already has one).
      const g = f.countItem('gold_ingot');
      if (g >= GOLD_FOR_BOW && this.role(f) !== 'murderer') {
        take(f, 'gold_ingot', GOLD_FOR_BOW);
        if (f.countItem('bow') === 0) f.addItem({ id: 'bow', count: 1 });
        f.addItem({ id: 'arrow', count: 1 });
        this.announcements.push({ text: f === m.player ? 'You bought a bow and an arrow with your gold!' : `${f.name} bought a bow.`, color: '#ffff55' });
      }
      // The detective's arrow comes back.
      if (this.role(f) === 'detective' && f.countItem('arrow') === 0) {
        const t = (this.arrowTimer.get(f) ?? 0) + 1;
        this.arrowTimer.set(f, t);
        if (t >= ARROW_RECHARGE) {
          this.arrowTimer.set(f, 0);
          f.addItem({ id: 'arrow', count: 1 });
        }
      }
    }
  }

  /** Bots near a kill that could see it now know who did it. */
  private witness(m: Match, killer: Fighter, victim: Fighter) {
    for (const f of m.fighters) {
      if (f === killer || f.dead) continue;
      const mind = this.minds.get(f);
      if (mind && Math.hypot(f.pos.x - victim.pos.x, f.pos.z - victim.pos.z) < 14 && this.sees(m, f, killer)) mind.suspects.add(killer);
    }
  }

  winner(m: Match): Fighter | null {
    const murderer = m.fighters.find((f) => this.role(f) === 'murderer');
    if (!murderer) return null;
    const others = m.fighters.filter((f) => f !== murderer);
    const innocentsWin = murderer.dead || (this.ticks >= GAME_TICKS && others.some((f) => !f.dead));
    if (innocentsWin) {
      // Everyone on the innocent side wins, dead or alive: the player if they were one.
      if (m.player !== murderer) return m.player;
      return others.find((f) => !f.dead) ?? others[0];
    }
    if (others.every((f) => f.dead)) return murderer;
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const r = this.role(viewer);
    const left = Math.max(0, Math.ceil((GAME_TICKS - this.ticks) / 20));
    const innocents = m.fighters.filter((f) => this.role(f) !== 'murderer' && !f.dead).length;
    const det = m.fighters.find((f) => this.role(f) === 'detective');
    return [
      { text: 'WHODUNIT', color: '#ff5555' },
      { text: `Role: ${r.toUpperCase()}`, color: r === 'murderer' ? '#ff5555' : r === 'detective' ? '#55ffff' : '#55ff55' },
      { text: `Time left: ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` },
      { text: `Innocents left: ${innocents}` },
      { text: `Detective: ${det && !det.dead ? 'alive' : 'dead — bow dropped'}` },
      { text: r === 'murderer' ? 'Kill everyone (slot 2: your sword)' : `Gold: ${viewer.countItem('gold_ingot')}/${GOLD_FOR_BOW} for a bow` },
    ];
  }

  title(_m: Match, viewer: Fighter): { title: string; sub: string } | null {
    if (viewer.dead) return { title: 'YOU DIED', sub: 'Watching the rest' };
    if (this.ticks < 80) {
      const r = this.role(viewer);
      if (r === 'murderer') return { title: 'You are the MURDERER', sub: 'Kill everyone without being shot' };
      if (r === 'detective') return { title: 'You are the DETECTIVE', sub: 'Find the murderer and shoot them' };
      return { title: 'You are INNOCENT', sub: 'Survive — collect gold for a bow' };
    }
    return null;
  }

  /** Nametags say nothing about roles. */
  tagStatus(): string | null {
    return '';
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }

  // ------------------------------------------------------------------ bots

  /** Nothing solid between `a`'s eyes and `b`'s. */
  private sees(m: Match, a: Fighter, b: Fighter): boolean {
    const bl = m.world.blocks;
    const ax = a.pos.x;
    const az = a.pos.z;
    const d = Math.hypot(b.pos.x - ax, b.pos.z - az);
    const steps = Math.ceil(d * 2);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (isSolid(bl.get(Math.floor(ax + (b.pos.x - ax) * t), 1, Math.floor(az + (b.pos.z - az) * t)))) return false;
    }
    return true;
  }

  private mind(f: Fighter): BotMind {
    let x = this.minds.get(f);
    if (!x) this.minds.set(f, (x = { suspects: new Set(), wander: { x: f.pos.x, z: f.pos.z, t: 0 }, draw: 0, victim: null, patience: 0 }));
    return x;
  }

  private wander(c: BotControl, mind: BotMind) {
    const me = c.bot;
    if (--mind.wander.t <= 0 || Math.hypot(mind.wander.x - me.pos.x, mind.wander.z - me.pos.z) < 1.2) {
      const s = this.spots[c.rng.int(0, this.spots.length - 1)];
      mind.wander = { x: s.x, z: s.z, t: 160 };
    }
    c.walkTo(mind.wander.x, mind.wander.z, 0.8, false);
  }

  private nearest(me: Fighter, list: Fighter[]): Fighter | null {
    let best: Fighter | null = null;
    let bd = Infinity;
    for (const f of list) {
      const d = Math.hypot(f.pos.x - me.pos.x, f.pos.z - me.pos.z);
      if (d < bd) {
        bd = d;
        best = f;
      }
    }
    return best;
  }

  /** Draws, aims (allowing for the drop) and looses an arrow at `t`. */
  private shoot(c: BotControl, mind: BotMind, t: Fighter) {
    const me = c.bot;
    if (me.countItem('arrow') === 0 || !c.equip('bow' as ItemId)) {
      mind.draw = 0;
      return false;
    }
    const d = Math.hypot(t.pos.x - me.pos.x, t.pos.z - me.pos.z);
    const noise = (1 - c.skill) * 0.6;
    c.aimAt(t.pos.x + c.rng.range(-noise, noise), t.pos.y + 1.1 + d * 0.025, t.pos.z + c.rng.range(-noise, noise), 0.6);
    c.input.forward = 0;
    c.input.strafe = 0;
    if (!me.usingItem) {
      me.startUsingItem(true);
      mind.draw = 0;
      return true;
    }
    if (++mind.draw >= 18 - Math.round(c.skill * 4)) {
      me.releaseUsingItem();
      mind.draw = 0;
    }
    return true;
  }

  botTick(m: Match, c: BotControl): boolean {
    const me = c.bot;
    const mind = this.mind(me);
    const role = this.role(me);
    // Everyone looks the same from outside.
    c.setLabel('Exploring');
    const others = alive(m).filter((f) => f !== me);
    // What it sees: anyone with a sword out.
    for (const f of others) {
      if (f.heldStack()?.id === 'iron_sword' && Math.hypot(f.pos.x - me.pos.x, f.pos.z - me.pos.z) < 18 && this.sees(m, me, f)) mind.suspects.add(f);
    }
    if (role === 'murderer') return this.murdererTick(m, c, mind, others);
    // Innocents and the detective: shoot a known murderer in sight, else flee them, else gather gold.
    const threat = this.nearest(
      me,
      others.filter((f) => mind.suspects.has(f) && this.sees(m, me, f)),
    );
    if (threat) {
      const d = Math.hypot(threat.pos.x - me.pos.x, threat.pos.z - me.pos.z);
      if (me.countItem('bow') > 0 && me.countItem('arrow') > 0 && d < 24 && this.shoot(c, mind, threat)) return false;
      if (d < 12) {
        if (me.usingItem) me.releaseUsingItem();
        c.emptyHand();
        const ax = me.pos.x - threat.pos.x;
        const az = me.pos.z - threat.pos.z;
        const l = Math.hypot(ax, az) || 1;
        c.walkTo(me.pos.x + (ax / l) * 5, me.pos.z + (az / l) * 5, 0.5, true);
        return false;
      }
    }
    if (me.usingItem) me.releaseUsingItem();
    c.emptyHand();
    const gold = m.world.items
      .filter((it) => !it.removed && it.stack.id === 'gold_ingot' && Math.hypot(it.pos.x - me.pos.x, it.pos.z - me.pos.z) < 6 + c.skill * 10)
      .sort((a, b) => Math.hypot(a.pos.x - me.pos.x, a.pos.z - me.pos.z) - Math.hypot(b.pos.x - me.pos.x, b.pos.z - me.pos.z))[0];
    if (gold) {
      c.walkTo(gold.pos.x, gold.pos.z, 0.2, false);
      return false;
    }
    // A dropped bow is worth fetching.
    const bow = me.countItem('bow') === 0 ? m.world.items.find((it) => !it.removed && it.stack.id === 'bow') : null;
    if (bow) {
      c.walkTo(bow.pos.x, bow.pos.z, 0.2, true);
      return false;
    }
    this.wander(c, mind);
    return false;
  }

  /**
   * The murderer bot blends in (sword away, wandering), then picks off whoever is alone: nobody
   * else within sight of them. Better bots wait longer for a clean chance.
   */
  private murdererTick(m: Match, c: BotControl, mind: BotMind, others: Fighter[]): boolean {
    const me = c.bot;
    const lonely = (v: Fighter) => others.every((o) => o === v || Math.hypot(o.pos.x - v.pos.x, o.pos.z - v.pos.z) > 8 || !this.sees(m, o, v));
    if (mind.victim && (mind.victim.dead || !lonely(mind.victim))) mind.victim = null;
    // It blends in for the first half minute, then waits for someone to be alone.
    if (!mind.victim && this.ticks > 20 * 30 && ++mind.patience > 80 - c.skill * 40) {
      mind.patience = 0;
      const cand = others.filter((v) => lonely(v) && Math.hypot(v.pos.x - me.pos.x, v.pos.z - me.pos.z) < 16);
      mind.victim = this.nearest(me, cand);
    }
    // Late in the game, it stops being picky.
    if (!mind.victim && this.ticks > GAME_TICKS * 0.6) mind.victim = this.nearest(me, others);
    const v = mind.victim;
    if (v) {
      const d = Math.hypot(v.pos.x - me.pos.x, v.pos.z - me.pos.z);
      if (d < 5) c.equip('iron_sword');
      else c.emptyHand();
      if (d < 5) c.fight(v);
      else c.walkTo(v.pos.x, v.pos.z, 1, d > 6);
      return false;
    }
    c.emptyHand();
    this.wander(c, mind);
    return false;
  }
}
