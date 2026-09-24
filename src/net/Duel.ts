import { performAttack, pushApart, rayDistanceToTarget } from '../game/combat';
import { attackCrystal, crosshairCrystal } from '../game/crystals';
import { Fighter, SLOT_COUNT, type FighterEvent } from '../game/Fighter';
import { ITEMS } from '../game/items';
import { kitById, type KitDef, type KitId } from '../game/kits';
import { World } from '../game/World';
import { COUNTDOWN_TICKS, SPAWN_DISTANCE } from '../game/Match';
import { Rng } from '../core/rng';
import { INTERP_TICKS, MAX_REWIND_TICKS, NET_TPS, fromSlot, itemTotals, toSlot, type NetEntities, type NetEvent, type NetFighter, type NetPhase, type ClientMsg, type ServerMsg, type Slot } from './protocol';

/** Where a fighter was on one past tick, for lag compensation. */
interface Rewind {
  x: number;
  y: number;
  z: number;
  sneaking: boolean;
  fallFlying: boolean;
}

export interface DuelEvent {
  /** Something server-side (knockback, an explosion, a wind burst) moved this player. */
  motion?: { to: number; vx: number; vy: number; vz: number };
  /** A pearl moved this player. */
  teleport?: { to: number; id: number; x: number; y: number; z: number };
}

/** Movement events every client makes for itself; the rest of a fighter's events are forwarded. */
const LOCAL_EVENTS = new Set(['step', 'jump', 'land', 'glide']);

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * The authoritative side of an online duel, for any kit: two fighters whose movement comes from
 * their clients, and everything else — combat, items, blocks, fluids, projectiles, crystals,
 * explosions, pearls, wind charges — which does not.
 *
 * It runs the exact same Fighter/World code the single-player game does, so every rule online
 * is the offline rule. Each tick it reports what changed (blocks, entities, events) for the
 * clients to mirror.
 */
export class Duel {
  readonly kit: KitDef;
  readonly world: World;
  readonly fighters: [Fighter, Fighter];
  phase: NetPhase = 'lobby';
  phaseTicks = 0;
  fightTicks = 0;
  tickCount = 0;
  winner: number | null = null;
  private readonly useHeld: [boolean, boolean] = [false, false];
  private readonly mineHeld: [boolean, boolean] = [false, false];
  private readonly pendingAttacks: [number, number] = [0, 0];
  private readonly pendingSlot: [number | null, number | null] = [null, null];
  private readonly pendingSwap: [number, number] = [0, 0];
  private readonly pendingUse: [number, number] = [0, 0];
  /** Position history per fighter, newest last — see rewindTicks(). */
  private readonly history: [Rewind[], Rewind[]] = [[], []];
  /** Each player's measured round-trip time in ms, fed in by the server. */
  private readonly pings: [number, number] = [0, 0];
  /** Pearl teleports sent to each client; their moves count again once they acknowledge it. */
  private readonly teleportId: [number, number] = [0, 0];
  private readonly teleportAcked: [number, number] = [0, 0];
  /** Stable ids for entities on the wire. */
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  /** Last inventory sent per fighter (JSON), so unchanged inventories are not re-sent. */
  private readonly lastInv: [string, string] = ['', ''];

  constructor(names: [string, string], kitId: KitId = 'sword') {
    this.kit = kitById(kitId);
    this.world = new World(undefined, this.kit.floorDepth ?? 0);
    this.world.damageMultiplier = this.kit.damageMultiplier ?? 1;
    this.world.shieldStuns = !!this.kit.shieldStuns;
    this.world.rng = new Rng((Math.random() * 2 ** 30) | 0);
    this.world.blocks.changeLog = new Set();
    this.fighters = [new Fighter('player', names[0], this.world), new Fighter('bot', names[1], this.world)];
    this.world.fighters.push(...this.fighters);
    this.reset();
  }

  reset() {
    const half = SPAWN_DISTANCE / 2;
    this.fighters[0].reset(0, half, 0, this.kit);
    this.fighters[1].reset(0, -half, Math.PI, this.kit);
    this.world.clearEntities();
    this.world.blocks.changeLog?.clear();
    for (const f of this.fighters) {
      f.networked = true;
      f.naturalRegen = this.kit.naturalRegen ?? true;
    }
    this.phase = 'countdown';
    this.phaseTicks = 0;
    this.fightTicks = 0;
    this.winner = null;
    for (let i = 0; i < 2; i++) {
      this.useHeld[i] = this.mineHeld[i] = false;
      this.pendingAttacks[i] = this.pendingSwap[i] = this.pendingUse[i] = 0;
      this.pendingSlot[i] = null;
      this.lastInv[i] = '';
      this.history[i].length = 0;
    }
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

  /**
   * How far back to wind the target before testing a swing: the time it took the attacker's
   * view to reach them (half their round trip) plus the interpolation delay their client draws
   * the opponent at. Together that is exactly the gap between what they saw and what the server
   * now holds, so a swing that looked like a hit on their screen is a hit here.
   */
  private rewindTicks(attacker: number): number {
    const latencyTicks = (this.pings[attacker] / 2 / 1000) * NET_TPS;
    return Math.min(MAX_REWIND_TICKS, Math.round(latencyTicks + INTERP_TICKS));
  }

  setUse(i: number, down: boolean) {
    // A press is also queued as a click, so a tap shorter than a tick still registers.
    if (down && !this.useHeld[i] && this.pendingUse[i] < 2) this.pendingUse[i]++;
    this.useHeld[i] = down;
  }

  setMining(i: number, down: boolean) {
    this.mineHeld[i] = down;
  }

  queueSwap(i: number) {
    if (this.pendingSwap[i] < 2) this.pendingSwap[i]++;
  }

  /** A movement packet. Ignored until the client has applied the last pearl teleport. */
  applyMove(i: number, m: { x: number; y: number; z: number; yaw: number; pitch: number; g: boolean; sp: boolean; sn: boolean; vy: number; ff?: boolean; fd?: number; tp?: number }) {
    if ((Number(m.tp) | 0) < this.teleportId[i]) return;
    this.teleportAcked[i] = this.teleportId[i];
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    this.fighters[i].applyMove(num(m.x), num(m.y), num(m.z), num(m.yaw), num(m.pitch), !!m.g, !!m.sp, !!m.sn, num(m.vy), !!m.ff, m.fd === undefined ? null : num(m.fd));
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
    this.pendingSlot[i] = Math.max(0, Math.min(8, slot | 0));
  }

  tick(): DuelEvent[] {
    this.tickCount++;
    const out: DuelEvent[] = [];
    const [a, b] = this.fighters;
    a.snapshot();
    b.snapshot();
    // Velocity as the clients last reported it: anything that changes it this tick came from
    // the server (knockback, explosions, wind) and has to be sent to that player.
    const vel = this.fighters.map((f) => [f.vel.x, f.vel.y, f.vel.z]);

    if (this.phase === 'fight') {
      this.fightTicks++;
      for (let i = 0; i < 2; i++) this.handleActions(i);
    } else {
      this.pendingAttacks[0] = this.pendingAttacks[1] = 0;
    }

    a.tick();
    b.tick();
    pushApart(a, b);
    this.world.tickEntities();
    this.record();

    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      if (f.events.some((e) => e.type === 'pearlLand')) {
        const id = ++this.teleportId[i];
        out.push({ teleport: { to: i, id, x: r3(f.pos.x), y: r3(f.pos.y), z: r3(f.pos.z) } });
      } else if (f.vel.x !== vel[i][0] || f.vel.y !== vel[i][1] || f.vel.z !== vel[i][2]) {
        out.push({ motion: { to: i, vx: f.vel.x, vy: f.vel.y, vz: f.vel.z } });
      }
    }

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
  private handleActions(i: number) {
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
    let mined = false;
    while (this.pendingAttacks[i] > 0) {
      this.pendingAttacks[i]--;
      // An end crystal nearer than the opponent takes the hit (against the rewound opponent).
      const restore = this.rewind(1 - i, this.rewindTicks(i));
      const cr = crosshairCrystal(f);
      const t = rayDistanceToTarget(f, other);
      if (cr && (t < 0 || cr.t < t)) {
        restore();
        attackCrystal(f, cr.crystal);
        continue;
      }
      if (!mined && f.tickMining(true, true)) {
        restore();
        mined = true;
        continue;
      }
      performAttack(f, other);
      restore();
    }
    if (!mined) f.tickMining(this.mineHeld[i], false);
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
      h.push({ x: f.pos.x, y: f.pos.y, z: f.pos.z, sneaking: f.input.sneak, fallFlying: f.fallFlying });
      if (h.length > MAX_REWIND_TICKS + 4) h.shift();
    }
  }

  /**
   * Moves a fighter back to where they were `ticks` ago and returns a function that puts them
   * back. Only the position (and pose) is wound back: damage, knockback and i-frames all still
   * land on the fighter as they are now.
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
    const ff = f.fallFlying;
    f.pos.set(past.x, past.y, past.z);
    f.fallFlying = past.fallFlying;
    if (past.sneaking !== sneak) f.input = { ...f.input, sneak: past.sneaking };
    return () => {
      f.pos.set(x, y, z);
      f.fallFlying = ff;
      if (past.sneaking !== sneak) f.input = { ...f.input, sneak: sneak };
    };
  }

  /** Reach of i's crosshair onto the other fighter, or -1. Used only for diagnostics. */
  reach(i: number): number {
    return rayDistanceToTarget(this.fighters[i], this.fighters[1 - i]);
  }

  private idOf(o: object): number {
    let id = this.ids.get(o);
    if (!id) this.ids.set(o, (id = this.nextId++));
    return id;
  }

  /** Every server entity, for the clients to draw. */
  entities(): NetEntities {
    const w = this.world;
    return {
      a: w.arrows.map((e) => [this.idOf(e), r3(e.pos.x), r3(e.pos.y), r3(e.pos.z), r3(e.yaw), r3(e.pitch), e.potion ?? '']),
      t: w.thrown.map((e) => [this.idOf(e), e.kind, e.potion ?? '', r3(e.pos.x), r3(e.pos.y), r3(e.pos.z)]),
      c: w.crystals.filter((c) => !c.removed).map((c) => [this.idOf(c), c.x, c.y, c.z]),
      it: w.items.map((e) => [this.idOf(e), e.stack.id, e.stack.count, r3(e.pos.x), r3(e.pos.y), r3(e.pos.z)]),
      o: w.orbs.map((e) => [this.idOf(e), e.value, r3(e.pos.x), r3(e.pos.y), r3(e.pos.z)]),
    };
  }

  /** Block cells changed since the last call: [index, id, amount, flags] flattened. */
  takeBlockChanges(): number[] | undefined {
    const log = this.world.blocks.changeLog;
    if (!log || !log.size) return undefined;
    const out: number[] = [];
    for (const i of log) out.push(...this.world.blocks.cellData(i));
    log.clear();
    return out;
  }

  /** This tick's fighter events (fighter references as { f: index }) — then clears them. */
  takeEvents(): NetEvent[] {
    const out: NetEvent[] = [];
    for (let i = 0; i < 2; i++) {
      const f = this.fighters[i];
      for (const e of f.events as FighterEvent[]) {
        if (LOCAL_EVENTS.has(e.type)) continue;
        const o: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(e)) o[k] = v instanceof Fighter ? { f: this.fighters.indexOf(v) } : v;
        out.push({ on: i, e: o });
      }
      f.events.length = 0;
    }
    return out;
  }

  /** This tick's world events — then clears them. */
  takeWorldEvents(): Record<string, unknown>[] {
    const out = this.world.events.map((e) => ({ ...e }) as Record<string, unknown>);
    this.world.events.length = 0;
    return out;
  }

  snapshot(i: number, ping: number): NetFighter {
    const f = this.fighters[i];
    const invSlots = Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k)));
    const invJson = JSON.stringify(invSlots);
    const invChanged = invJson !== this.lastInv[i];
    this.lastInv[i] = invJson;
    const mn = f.mining ? ([f.mining.x, f.mining.y, f.mining.z, r3(f.mineProgress)] as [number, number, number, number]) : null;
    return {
      i,
      name: f.name,
      x: r3(f.pos.x),
      y: r3(f.pos.y),
      z: r3(f.pos.z),
      yaw: r3(f.yaw),
      pitch: r3(f.pitch),
      g: f.onGround,
      sp: f.sprinting,
      sn: f.input.sneak,
      ui: f.usingItem,
      ur: f.useItemRemaining,
      ud: f.useItemDuration,
      hp: r3(f.health),
      ab: r3(f.absorption),
      food: f.food.level,
      sat: r3(f.food.saturation),
      sel: f.selected,
      inv: invChanged ? invSlots : undefined,
      sc: f.shieldCooldown,
      uh: f.useHand === 'off' ? 1 : 0,
      ht: f.hurtTime,
      iv: f.invulnerableTime,
      hd: r3(f.hurtDir),
      dead: f.dead,
      dt: f.deathTime,
      ast: f.attackStrengthTicker,
      sw: f.swingCount,
      ff: f.fallFlying,
      fft: f.fallFlyTicks,
      cd: [...f.cooldowns].map(([id, c]) => [id, c.ticks, c.total] as [string, number, number]),
      mn,
      fire: f.fireTicks,
      eff: [...f.effects].map(([id, e]) => [id, e.amplifier, e.duration] as [string, number, number]),
      st: { ...f.stats } as unknown as Record<string, number>,
      ping,
    };
  }

  /** A player's input message (everything but joining, rematches and pings). */
  receive(i: number, msg: ClientMsg) {
    switch (msg.t) {
      case 'move':
        this.applyMove(i, msg);
        return;
      case 'attack':
        this.queueAttack(i);
        return;
      case 'use':
        this.setUse(i, !!msg.down);
        return;
      case 'mine':
        this.setMining(i, !!msg.down);
        return;
      case 'slot':
        this.setSlot(i, Number(msg.i) | 0);
        return;
      case 'swap':
        this.queueSwap(i);
        return;
      case 'inv':
        this.setInventory(i, msg.slots);
        return;
      default:
        return;
    }
  }

  /** The per-tick state broadcast (call once per tick, after tick()). */
  stateMessage(tick: number, pings: [number, number]): Extract<ServerMsg, { t: 'state' }> {
    const ev = this.takeEvents();
    const we = this.takeWorldEvents();
    return {
      t: 'state',
      tick,
      phase: this.phase,
      fightTicks: this.fightTicks,
      countdown: this.countdownSeconds,
      players: [0, 1].map((i) => this.snapshot(i, pings[i])),
      winner: this.winner,
      blocks: this.takeBlockChanges(),
      ents: this.entities(),
      ev: ev.length ? ev : undefined,
      we: we.length ? we : undefined,
    };
  }

  /** Forces the next snapshot to carry full inventories (a client just (re)joined). */
  resendInventories() {
    this.lastInv[0] = this.lastInv[1] = '';
  }
}
