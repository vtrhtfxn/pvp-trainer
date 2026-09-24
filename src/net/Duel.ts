import { performAttack, pushApart, rayDistanceToTarget } from '../game/combat';
import { Fighter, SLOT_COUNT, type FighterEvent } from '../game/Fighter';
import { ITEMS } from '../game/items';
import { kitById } from '../game/kits';
import { World } from '../game/World';
import { COUNTDOWN_TICKS, SPAWN_DISTANCE } from '../game/Match';
import { INTERP_TICKS, MAX_REWIND_TICKS, NET_TPS, fromSlot, itemTotals, toSlot, type NetFighter, type NetHit, type NetPhase, type Slot } from './protocol';

/** Where a fighter was on one past tick, for lag compensation. */
interface Rewind {
  x: number;
  y: number;
  z: number;
  sneaking: boolean;
}

export interface DuelEvent {
  /** Knockback to push to a specific player's client. */
  motion?: { to: number; vx: number; vy: number; vz: number };
  hit?: { on: number; hit: NetHit };
  miss?: { by: number };
  eat?: { by: number; kind: 'tick' | 'done' };
}

/**
 * The authoritative side of an online duel: two fighters whose movement comes from their
 * clients, and all of the combat rules, which do not.
 *
 * It reuses the exact same Fighter/combat code the single-player sim runs, so an online hit
 * resolves through vanilla's cooldown, reach, crit, sprint-knockback and i-frame rules.
 */
export class Duel {
  readonly world = new World();
  readonly kit = kitById('sword');
  readonly fighters: [Fighter, Fighter];
  phase: NetPhase = 'lobby';
  phaseTicks = 0;
  fightTicks = 0;
  tickCount = 0;
  winner: number | null = null;
  /** Bumped every time a fighter swings, so clients can replay the animation. */
  readonly swings: [number, number] = [0, 0];
  private readonly useHeld: [boolean, boolean] = [false, false];
  private readonly pendingAttacks: [number, number] = [0, 0];
  private readonly pendingSlot: [number | null, number | null] = [null, null];
  private readonly pendingSwap: [number, number] = [0, 0];
  private readonly pendingUse: [number, number] = [0, 0];
  /** Position history per fighter, newest last — see rewindTicks(). */
  private readonly history: [Rewind[], Rewind[]] = [[], []];
  /** Each player's measured round-trip time in ms, fed in by the server. */
  private readonly pings: [number, number] = [0, 0];

  constructor(names: [string, string]) {
    this.fighters = [new Fighter('player', names[0], this.world), new Fighter('bot', names[1], this.world)];
    this.world.fighters.push(...this.fighters);
    for (const f of this.fighters) f.networked = true;
    this.reset();
  }

  reset() {
    const half = SPAWN_DISTANCE / 2;
    this.fighters[0].reset(0, half, 0, this.kit);
    this.fighters[1].reset(0, -half, Math.PI, this.kit);
    this.world.clearEntities();
    for (const f of this.fighters) f.networked = true;
    this.phase = 'countdown';
    this.phaseTicks = 0;
    this.fightTicks = 0;
    this.winner = null;
    this.swings[0] = 0;
    this.swings[1] = 0;
    this.useHeld[0] = this.useHeld[1] = false;
    this.pendingAttacks[0] = this.pendingAttacks[1] = 0;
    this.pendingSlot[0] = this.pendingSlot[1] = null;
    this.pendingSwap[0] = this.pendingSwap[1] = 0;
    this.pendingUse[0] = this.pendingUse[1] = 0;
  }

  get countdownSeconds(): number {
    return Math.max(0, Math.ceil((COUNTDOWN_TICKS - this.phaseTicks) / 20));
  }

  setName(i: number, name: string) {
    this.fighters[i].name = name;
  }

  queueAttack(i: number) {
    // One click per tick is all a 20 Hz simulation can resolve; more would just be swallowed.
    if (this.pendingAttacks[i] < 4) this.pendingAttacks[i]++;
  }

  setPing(i: number, ms: number) {
    this.pings[i] = ms;
  }

  /**
   * How far back to wind the target before testing a swing: the time it took the attacker's
   * view to reach them (half their round trip) plus the interpolation delay their client draws
   * the opponent at. Together that is exactly the gap between what they saw and what the server
   * now holds, so a swing that looked like a hit on their screen is a hit here.
   */
  rewindTicksFor(attacker: number): number {
    return this.rewindTicks(attacker);
  }

  /** Where fighter `i` appeared on `viewer`'s screen — the position a swing is tested against. */
  rewoundPosition(i: number, viewer: number): { x: number; y: number; z: number } {
    const h = this.history[i];
    const past = h[h.length - 1 - this.rewindTicks(viewer)];
    const f = this.fighters[i];
    return past ?? { x: f.pos.x, y: f.pos.y, z: f.pos.z };
  }

  private rewindTicks(attacker: number): number {
    const latencyTicks = (this.pings[attacker] / 2 / 1000) * NET_TPS;
    return Math.min(MAX_REWIND_TICKS, Math.round(latencyTicks + INTERP_TICKS));
  }

  setUse(i: number, down: boolean) {
    // A press is also queued as a click, so a tap shorter than a tick still registers.
    if (down && !this.useHeld[i] && this.pendingUse[i] < 2) this.pendingUse[i]++;
    this.useHeld[i] = down;
  }

  queueSwap(i: number) {
    if (this.pendingSwap[i] < 2) this.pendingSwap[i]++;
  }

  /**
   * Applies an inventory rearrangement from the inventory screen. Movement is trusted but items
   * are not: the new layout must hold exactly the same items, or it is ignored.
   */
  setInventory(i: number, slots: Slot[]): boolean {
    const f = this.fighters[i];
    if (!Array.isArray(slots) || slots.length !== SLOT_COUNT || f.dead) return false;
    const current = Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k)));
    const a = itemTotals(current);
    const b = itemTotals(slots);
    if (a.size !== b.size) return false;
    for (const [k, n] of a) if (b.get(k) !== n) return false;
    // Armor slots only take the matching armor piece.
    for (let k = 36; k < 40; k++) {
      const s = fromSlot(slots[k]);
      if (s && ITEMS[s.id].armor?.slot !== k - 36) return false;
    }
    if (f.usingItem) f.stopUsingItem();
    for (let k = 0; k < SLOT_COUNT; k++) f.setSlot(k, fromSlot(slots[k]));
    return true;
  }

  setSlot(i: number, slot: number) {
    this.pendingSlot[i] = slot;
  }

  tick(): DuelEvent[] {
    this.tickCount++;
    const out: DuelEvent[] = [];
    const [a, b] = this.fighters;
    a.snapshot();
    b.snapshot();

    if (this.phase === 'fight') {
      this.fightTicks++;
      for (let i = 0; i < 2; i++) this.handleActions(i, out);
    } else {
      this.pendingAttacks[0] = this.pendingAttacks[1] = 0;
    }

    a.tick();
    b.tick();
    pushApart(a, b);
    this.world.tickEntities();
    this.collectEvents(out);
    this.record();

    this.phaseTicks++;
    if (this.phase === 'countdown' && this.phaseTicks >= COUNTDOWN_TICKS) {
      this.phase = 'fight';
      this.phaseTicks = 0;
    } else if (this.phase === 'fight' && (a.dead || b.dead)) {
      this.phase = 'ended';
      this.phaseTicks = 0;
      this.winner = a.dead ? (b.dead ? null : 1) : 0;
    }
    return out;
  }

  /** Mirrors Match.handlePlayerActions, but for a remote player's queued inputs. */
  private handleActions(i: number, out: DuelEvent[]) {
    const f = this.fighters[i];
    const other = this.fighters[1 - i];
    const slot = this.pendingSlot[i];
    if (slot !== null) {
      f.selectSlot(slot);
      this.pendingSlot[i] = null;
    }
    while (this.pendingSwap[i] > 0) {
      this.pendingSwap[i]--;
      f.swapHands();
    }
    if (f.usingItem) {
      if (!this.useHeld[i]) f.releaseUsingItem();
      this.pendingAttacks[i] = 0; // clicks are swallowed while an item is in use
      this.pendingUse[i] = 0;
      return;
    }
    while (this.pendingAttacks[i] > 0) {
      this.pendingAttacks[i]--;
      const before = other.vel.clone();
      const restore = this.rewind(1 - i, this.rewindTicks(i));
      const r = performAttack(f, other);
      restore();
      this.swings[i]++;
      const ev = f.events.find((e) => e.type === 'attack') as Extract<FighterEvent, { type: 'attack' }> | undefined;
      const noDamage = f.events.some((e) => e.type === 'noDamage');
      if (r.blocked) {
        out.push({
          hit: {
            on: 1 - i,
            hit: { by: i, crit: false, sprint: false, strong: false, scale: r.scale, damage: 0, reach: r.reach, fullHit: false, blocked: true, shield: true, disabled: r.disabled },
          },
        });
      } else if (ev) {
        out.push({
          hit: {
            on: 1 - i,
            hit: {
              by: i,
              crit: ev.crit,
              sprint: ev.sprint,
              strong: ev.strong,
              scale: ev.scale,
              damage: ev.damage,
              reach: ev.reach,
              fullHit: ev.fullHit,
              blocked: false,
            },
          },
        });
        if (before.x !== other.vel.x || before.y !== other.vel.y || before.z !== other.vel.z) {
          out.push({ motion: { to: 1 - i, vx: other.vel.x, vy: other.vel.y, vz: other.vel.z } });
        }
      } else if (noDamage) {
        out.push({
          hit: {
            on: 1 - i,
            hit: { by: i, crit: false, sprint: false, strong: false, scale: r.scale, damage: 0, reach: r.reach, fullHit: false, blocked: true },
          },
        });
      } else {
        out.push({ miss: { by: i } });
      }
    }
    while (this.pendingUse[i] > 0) {
      this.pendingUse[i]--;
      f.startUsingItem(true);
    }
    if (this.useHeld[i]) f.startUsingItem();
  }

  /** Snapshots both fighters so a later swing can be tested against where they used to be. */
  private record() {
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      const h = this.history[i];
      h.push({ x: f.pos.x, y: f.pos.y, z: f.pos.z, sneaking: f.input.sneak });
      if (h.length > MAX_REWIND_TICKS + 4) h.shift();
    }
  }

  private collectEvents(out: DuelEvent[]) {
    for (let i = 0; i < 2; i++) {
      for (const e of this.fighters[i].events) {
        if (e.type === 'eatTick') out.push({ eat: { by: i, kind: 'tick' } });
        else if (e.type === 'eatDone') out.push({ eat: { by: i, kind: 'done' } });
      }
      this.fighters[i].events.length = 0;
    }
  }

  /**
   * Moves a fighter back to where they were `ticks` ago and returns a function that puts them
   * back. Only the position is wound back: damage, knockback and i-frames all still land on the
   * fighter as they are now.
   */
  private rewind(i: number, ticks: number): () => void {
    const f = this.fighters[i];
    const h = this.history[i];
    const past = h[h.length - 1 - ticks];
    if (!past || ticks <= 0) return () => {};
    const x = f.pos.x;
    const y = f.pos.y;
    const z = f.pos.z;
    const sneak = f.input.sneak;
    f.pos.set(past.x, past.y, past.z);
    if (past.sneaking !== sneak) f.input = { ...f.input, sneak: past.sneaking };
    return () => {
      f.pos.set(x, y, z);
      if (past.sneaking !== sneak) f.input = { ...f.input, sneak: sneak };
    };
  }

  /** Reach of i's crosshair onto the other fighter, or -1. Used only for diagnostics. */
  reach(i: number): number {
    return rayDistanceToTarget(this.fighters[i], this.fighters[1 - i]);
  }

  snapshot(i: number, ping: number): NetFighter {
    const f = this.fighters[i];
    return {
      i,
      name: f.name,
      x: round(f.pos.x),
      y: round(f.pos.y),
      z: round(f.pos.z),
      yaw: round(f.yaw),
      pitch: round(f.pitch),
      g: f.onGround,
      sp: f.sprinting,
      sn: f.input.sneak,
      ui: f.usingItem,
      ur: f.useItemRemaining,
      ud: f.useItemDuration,
      hp: round(f.health),
      ab: round(f.absorption),
      food: f.food.level,
      sat: round(f.food.saturation),
      sel: f.selected,
      inv: Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k))),
      sc: f.shieldCooldown,
      uh: f.useHand === 'off' ? 1 : 0,
      ht: f.hurtTime,
      iv: f.invulnerableTime,
      hd: round(f.hurtDir),
      dead: f.dead,
      dt: f.deathTime,
      ast: f.attackStrengthTicker,
      sw: this.swings[i],
      eff: [...f.effects].map(([id, e]) => [id, e.amplifier, e.duration] as [string, number, number]),
      st: { ...f.stats },
      ping,
    };
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
