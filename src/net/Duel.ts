import { BotBrain } from '../ai/BotBrain';
import type { BotProfile } from '../ai/difficulty';
import { performAttack, pushApart, rayDistanceToTarget, type AttackOutcome } from '../game/combat';
import { hitNearerEntity } from '../game/crystals';
import { Fighter, SLOT_COUNT, type FighterEvent } from '../game/Fighter';
import { ITEMS } from '../game/items';
import { kitById, type KitDef, type KitId } from '../game/kits';
import { World } from '../game/World';
import { COUNTDOWN_TICKS, SPAWN_DISTANCE, TEAM_SPREAD } from '../game/Match';
import { Rng } from '../core/rng';
import { B } from '../game/Blocks';
import { createMode } from '../game/modes';
import { Bedwars } from '../game/modes/Bedwars';
import type { GameMode } from '../game/modes/GameMode';
import { SHOP } from '../game/modes/shop';
import { Skywars } from '../game/modes/Skywars';
import { INTERP_TICKS, MAX_REWIND_MS, MAX_REWIND_TICKS, NET_TPS, fromSlot, itemTotals, toSlot, type NetEntities, type NetEvent, type NetFighter, type NetPhase, type ClientMsg, type ServerMsg, type Slot } from './protocol';

/** Where a fighter was on one past tick, for lag compensation. */
interface Rewind {
  x: number;
  y: number;
  z: number;
  sneaking: boolean;
  fallFlying: boolean;
}

/** One accepted move, by the sender's tick number, for rewinding to what an opponent saw. */
interface LoggedMove extends Rewind {
  q: number;
  /** Server time it arrived, ms. */
  at: number;
}

export interface DuelEvent {
  /** Something server-side (knockback, an explosion, a wind burst) moved this player. */
  motion?: { to: number; vx: number; vy: number; vz: number };
  /** A pearl (or a respawn) moved this player. */
  teleport?: { to: number; id: number; x: number; y: number; z: number; yaw?: number };
  /** A server-run bot moved: relayed to the players like a person's move. */
  mv?: Extract<ServerMsg, { t: 'mv' }>;
}

/** Where seat `i` starts: red (even seats) at +z, blue at -z; 2v2 teammates side by side. */
export function seatSpawn(i: number, seats: number): { x: number; z: number; yaw: number } {
  const half = SPAWN_DISTANCE / 2;
  const red = i % 2 === 0;
  const x = seats > 2 ? (i < 2 ? -TEAM_SPREAD / 2 : TEAM_SPREAD / 2) : 0;
  return { x, z: red ? half : -half, yaw: red ? 0 : Math.PI };
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
/** What a click hit on the attacker's screen (-1: nothing) and the aim it was made with. */
export interface AttackClaim {
  p: number;
  yaw: number;
  pitch: number;
}

/**
 * How far (blocks) the server lets a claimed hit sit off its own rewound picture: the drawn
 * opponent is smoothed, and the attacker's eye may be a tick off the click.
 */
const CLAIM_SLACK = 0.35;

export class Duel {
  readonly kit: KitDef;
  readonly world: World;
  /** One per seat: two in a duel, four in a 2v2 (even seats red, odd seats blue). */
  readonly fighters: Fighter[];
  phase: NetPhase = 'lobby';
  phaseTicks = 0;
  /** Ticks from round start to FIGHT! (the lobby gives real duels PREP_TICKS). */
  countdownTicks = COUNTDOWN_TICKS;
  fightTicks = 0;
  tickCount = 0;
  winner: number | null = null;
  private readonly useHeld: boolean[];
  private readonly mineHeld: boolean[];
  private readonly pendingAttacks: number[];
  /** The opponent tick each queued click was aimed at (from the attacker's screen), if sent. */
  private readonly attackViews: (number | null)[][];
  /** What each click hit on the attacker's screen, and the aim then (null: not sent). */
  private readonly attackClaims: (AttackClaim | null)[][];
  /** The seat each queued click was aimed at (2v2; null: whoever is under the crosshair). */
  private readonly attackTargets: (number | null)[][];
  /** Every accepted move per fighter, newest last (about two seconds). */
  private readonly moveLog: LoggedMove[][];
  /** Server clock, ms (tests drive it). */
  clock: () => number = () => performance.now();
  private readonly pendingSlot: (number | null)[];
  private readonly pendingSwap: number[];
  private readonly pendingUse: number[];
  /** Position history per fighter, newest last — see rewindTicks(). */
  private readonly history: Rewind[][];
  /** Each player's measured round-trip time in ms, fed in by the server. */
  private readonly pings: number[];
  /** Pearl teleports sent to each client; their moves count again once they acknowledge it. */
  private readonly teleportId: number[];
  private readonly teleportAcked: number[];
  /** Stable ids for entities on the wire. */
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;
  /** Last inventory sent per fighter (JSON), so unchanged inventories are not re-sent. */
  private readonly lastInv: string[];
  /** Bed Wars / SkyWars rules, or null for a plain duel. */
  readonly mode: GameMode | null;
  /** Mode messages waiting to go out: to a seat, or to everyone (-1). */
  private outbox: { to: number; msg: ServerMsg }[] = [];
  /** The last mode panel (scoreboard, title, gear) sent to each seat, as JSON. */
  private readonly lastModeUi: string[];
  /** The chest each player has open, and what they were last sent of it (JSON). */
  private readonly openChest: ({ x: number; y: number; z: number; sent: string } | null)[];
  /** 2v2: the seats the server plays itself (empty places, or someone who left). */
  private readonly brains: (BotBrain | null)[];

  constructor(names: string[], kitId: KitId = 'sword') {
    this.kit = kitById(kitId);
    this.mode = createMode(this.kit);
    this.world = new World(undefined, this.mode ? 12 : (this.kit.floorDepth ?? 0));
    if (this.mode) {
      // The same floating map every client builds for itself (see NetMatch).
      this.world.blocks.voidWorld = true;
      this.world.blocks.clear();
    }
    this.world.damageMultiplier = this.kit.damageMultiplier ?? 1;
    this.world.shieldStuns = !!this.kit.shieldStuns;
    this.world.legacyCombat = !!this.kit.legacyCombat;
    this.world.rng = new Rng((Math.random() * 2 ** 30) | 0);
    this.world.blocks.changeLog = new Set();
    const n = names.length > 2 ? 4 : 2;
    this.fighters = Array.from({ length: n }, (_, i) => new Fighter(i === 0 ? 'player' : 'bot', names[i] ?? `Player ${i + 1}`, this.world));
    this.fighters.forEach((f, i) => (f.team = i % 2));
    this.world.fighters.push(...this.fighters);
    const per = <T>(make: () => T): T[] => Array.from({ length: n }, make);
    this.useHeld = per(() => false);
    this.mineHeld = per(() => false);
    this.pendingAttacks = per(() => 0);
    this.attackViews = per(() => []);
    this.attackClaims = per(() => []);
    this.attackTargets = per(() => []);
    this.moveLog = per(() => []);
    this.pendingSlot = per(() => null);
    this.pendingSwap = per(() => 0);
    this.pendingUse = per(() => 0);
    this.history = per(() => []);
    this.pings = per(() => 0);
    this.teleportId = per(() => 0);
    this.teleportAcked = per(() => 0);
    this.lastInv = per(() => '');
    this.lastModeUi = per(() => '');
    this.openChest = per(() => null);
    this.brains = per(() => null);
    this.reset();
  }

  /** Seats in this game (2 or 4). */
  get seats(): number {
    return this.fighters.length;
  }

  /** Whether seat `i` is played by the server. */
  isBot(i: number): boolean {
    return !!this.brains[i];
  }

  /**
   * Hands seat `i` to a server-run bot at `profile` (a 2v2's empty place, or a player who left).
   * It fights like the offline bots: nearest enemy first, the whole kit, the mode's objectives.
   */
  makeBot(i: number, profile: BotProfile, name?: string) {
    const f = this.fighters[i];
    if (!f) return;
    f.networked = false;
    if (name) f.name = name;
    const rng = new Rng((Math.random() * 2 ** 30) | 0);
    const brain: BotBrain = new BotBrain(f, this.enemiesOf(i)[0], this.world, profile, rng, () => this.botAttack(f, brain.opponent));
    if (this.mode) brain.attachSky(this);
    brain.resetRound();
    this.brains[i] = brain;
  }

  /** Everyone on the other team from seat `i`. */
  enemiesOf(i: number): Fighter[] {
    const t = this.fighters[i].team;
    return this.fighters.filter((f) => f.team !== t);
  }

  private botAttack(f: Fighter, target: Fighter): AttackOutcome {
    if (hitNearerEntity(f, rayDistanceToTarget(f, target))) {
      return { hit: false, reach: -1, crit: false, sprint: false, scale: 1, damage: 0, blocked: false, disabled: false, swap: false };
    }
    return performAttack(f, target);
  }

  /** A mode respawned someone: a bot starts its plan over. */
  onRespawn(f: Fighter) {
    this.brains[this.fighters.indexOf(f)]?.resetRound();
  }

  /** Seat 0 is the red team, seat 1 blue (the mode host interface). */
  get player(): Fighter {
    return this.fighters[0];
  }
  get bot(): Fighter {
    return this.fighters[1];
  }

  reset() {
    this.fighters.forEach((f, i) => {
      const s = seatSpawn(i, this.seats);
      f.reset(s.x, s.z, s.yaw, this.kit);
    });
    this.world.clearEntities();
    for (const [i, f] of this.fighters.entries()) {
      // (brains is still unset while the constructor runs its first reset.)
      f.networked = !this.brains?.[i];
      f.naturalRegen = this.kit.naturalRegen ?? true;
      f.food.locked = !!this.kit.noHunger;
    }
    // The mode builds its map and spawns everyone; the clients build the same map themselves,
    // so none of it goes out as block changes.
    this.mode?.setup(this);
    for (const f of this.fighters) f.events.length = 0;
    this.world.blocks.changeLog?.clear();
    this.outbox = [];
    this.phase = 'countdown';
    this.phaseTicks = 0;
    this.fightTicks = 0;
    this.winner = null;
    // (Unset while the constructor runs its first reset: the arrays come after.)
    if (!this.useHeld) return;
    for (let i = 0; i < this.seats; i++) {
      this.lastModeUi[i] = '';
      this.openChest[i] = null;
      this.useHeld[i] = this.mineHeld[i] = false;
      this.pendingAttacks[i] = this.pendingSwap[i] = this.pendingUse[i] = 0;
      this.attackViews[i].length = 0;
      this.attackClaims[i].length = 0;
      this.attackTargets[i].length = 0;
      this.moveLog[i].length = 0;
      this.brains[i]?.resetRound();
      this.pendingSlot[i] = null;
      this.lastInv[i] = '';
      this.history[i].length = 0;
      // The clients reset their teleport acks for the new round too.
      this.teleportId[i] = this.teleportAcked[i] = 0;
    }
  }

  get countdownSeconds(): number {
    return Math.max(0, Math.ceil((this.countdownTicks - this.phaseTicks) / 20));
  }

  setName(i: number, name: string) {
    this.fighters[i].name = name;
  }

  /**
   * A click; `view` is the opponent tick the attacker had on screen (see rewindToView), `claim`
   * what the click hit there and the aim it was made with.
   */
  queueAttack(i: number, view?: number, claim?: AttackClaim, target?: number) {
    // One click per tick is all a 20 Hz simulation can resolve; more would just be swallowed.
    if (this.pendingAttacks[i] >= 4) return;
    this.pendingAttacks[i]++;
    this.attackViews[i].push(typeof view === 'number' && Number.isFinite(view) ? view : null);
    const ok = claim && [claim.p, claim.yaw, claim.pitch].every((n) => typeof n === 'number' && Number.isFinite(n));
    this.attackClaims[i].push(ok ? claim : null);
    // Only an enemy's seat counts (a teammate or a made-up seat is ignored).
    const t = typeof target === 'number' && Number.isInteger(target) && this.fighters[target]?.isEnemy(this.fighters[i]) ? target : null;
    this.attackTargets[i].push(t);
  }

  /**
   * Whom seat `i`'s click is judged against: the seat it said (2v2), else the enemy nearest
   * along their crosshair, else the first enemy standing.
   */
  private targetSeat(i: number, said: number | null): number {
    if (this.seats === 2) return 1 - i;
    if (said !== null) return said;
    const f = this.fighters[i];
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < this.seats; k++) {
      if (!this.fighters[k].isEnemy(f)) continue;
      const d = rayDistanceToTarget(f, this.fighters[k]);
      if (d >= 0 && d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) return best;
    const alive = this.fighters.findIndex((g) => g.isEnemy(f) && !g.dead);
    return alive >= 0 ? alive : this.fighters.findIndex((g) => g.isEnemy(f));
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

  /**
   * A movement packet. Ignored until the client has applied the last pearl teleport. Returns the
   * move to relay to the opponent (null if it was ignored).
   */
  applyMove(
    i: number,
    m: { q?: number; x: number; y: number; z: number; yaw: number; pitch: number; g: boolean; sp: boolean; sn: boolean; vy: number; ff?: boolean; fd?: number; tp?: number },
  ): Extract<ServerMsg, { t: 'mv' }> | null {
    if ((Number(m.tp) | 0) < this.teleportId[i]) return null;
    this.teleportAcked[i] = this.teleportId[i];
    const num = (v: unknown, lo: number, hi: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : 0;
    };
    // Movement is trusted, but only inside the arena: a wild coordinate would send the block
    // scans on a walk through billions of cells and stall every room on this server.
    const lim = this.world.blocks.half + 2;
    const f = this.fighters[i];
    f.applyMove(
      num(m.x, -lim, lim),
      num(m.y, -64, 512),
      num(m.z, -lim, lim),
      num(m.yaw, -1e4, 1e4),
      num(m.pitch, -Math.PI / 2, Math.PI / 2),
      !!m.g,
      !!m.sp,
      !!m.sn,
      num(m.vy, -10, 10),
      !!m.ff,
      m.fd === undefined ? null : num(m.fd, 0, 400),
    );
    const q = Number(m.q);
    if (!Number.isFinite(q)) return null;
    const log = this.moveLog[i];
    log.push({ q, at: this.clock(), x: f.pos.x, y: f.pos.y, z: f.pos.z, sneaking: f.input.sneak, fallFlying: f.fallFlying });
    if (log.length > 60) log.shift();
    const flags = (f.onGround ? 1 : 0) | (f.sprinting ? 2 : 0) | (f.input.sneak ? 4 : 0) | (f.fallFlying ? 8 : 0);
    return { t: 'mv', i, q, x: r3(f.pos.x), y: r3(f.pos.y), z: r3(f.pos.z), yaw: r3(f.yaw), pitch: r3(f.pitch), f: flags };
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
    const all = this.fighters;
    for (const f of all) f.snapshot();
    // Velocity as the clients last reported it: anything that changes it this tick came from
    // the server (knockback, explosions, wind) and has to be sent to that player.
    const vel = all.map((f) => [f.vel.x, f.vel.y, f.vel.z]);

    if (this.phase === 'fight') {
      this.fightTicks++;
      for (let i = 0; i < this.seats; i++) {
        const brain = this.brains[i];
        if (!brain) this.handleActions(i);
        else {
          brain.chooseTarget(this.enemiesOf(i));
          brain.tick();
        }
      }
    } else {
      for (let i = 0; i < this.seats; i++) {
        this.pendingAttacks[i] = 0;
        this.attackViews[i].length = 0;
        this.attackClaims[i].length = 0;
        this.attackTargets[i].length = 0;
        // Hotbar keys still work during the countdown (the client already shows the new slot).
        const slot = this.pendingSlot[i];
        if (slot !== null && !all[i].dead) all[i].selectSlot(slot);
        this.pendingSlot[i] = null;
        const brain = this.brains[i];
        if (brain && this.phase === 'countdown') {
          const f = all[i];
          const t = brain.opponent;
          f.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
          f.yaw = Math.atan2(-(t.pos.x - f.pos.x), -(t.pos.z - f.pos.z));
        }
      }
    }

    for (const f of all) f.tick();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pushApart(all[i], all[j]);
    this.world.tickEntities();
    if (this.mode && this.phase === 'fight') this.mode.tick(this);
    this.record();

    for (let i = 0; i < this.seats; i++) {
      const f = all[i];
      if (this.brains[i]) {
        // A bot's move goes out like a person's, stamped with the server tick, so the players
        // draw it through the same smooth playback.
        const q = this.tickCount;
        const log = this.moveLog[i];
        log.push({ q, at: this.clock(), x: f.pos.x, y: f.pos.y, z: f.pos.z, sneaking: f.input.sneak, fallFlying: f.fallFlying });
        if (log.length > 60) log.shift();
        const flags = (f.onGround ? 1 : 0) | (f.sprinting ? 2 : 0) | (f.input.sneak ? 4 : 0) | (f.fallFlying ? 8 : 0);
        out.push({ mv: { t: 'mv', i, q, x: r3(f.pos.x), y: r3(f.pos.y), z: r3(f.pos.z), yaw: r3(f.yaw), pitch: r3(f.pitch), f: flags } });
        continue;
      }
      const respawned = f.events.some((e) => e.type === 'respawn');
      if (respawned || f.events.some((e) => e.type === 'pearlLand')) {
        const id = ++this.teleportId[i];
        out.push({ teleport: { to: i, id, x: r3(f.pos.x), y: r3(f.pos.y), z: r3(f.pos.z), yaw: respawned ? r3(f.yaw) : undefined } });
      } else if (f.vel.x !== vel[i][0] || f.vel.y !== vel[i][1] || f.vel.z !== vel[i][2]) {
        out.push({ motion: { to: i, vx: f.vel.x, vy: f.vel.y, vz: f.vel.z } });
      }
    }

    if (this.mode) this.tickModeUi();

    this.phaseTicks++;
    if (this.phase === 'countdown' && this.phaseTicks >= this.countdownTicks) {
      this.phase = 'fight';
      this.phaseTicks = 0;
    } else if (this.phase === 'fight' && this.mode) {
      const w = this.mode.winner(this);
      if (w) {
        this.phase = 'ended';
        this.phaseTicks = 0;
        this.winner = all.indexOf(w);
      }
    } else if (this.phase === 'fight') {
      // Over when a whole team is down (in a duel, one player).
      const redDown = all.every((f) => f.team !== 0 || f.dead);
      const blueDown = all.every((f) => f.team !== 1 || f.dead);
      if (redDown || blueDown) {
        this.phase = 'ended';
        this.phaseTicks = 0;
        this.winner = redDown ? (blueDown ? null : 1) : 0;
      }
    }
    return out;
  }

  /**
   * Bed Wars / SkyWars: opens chests players right-clicked, and queues each player's scoreboard,
   * title and upgrades, the announcements, and the contents of any chest they have open.
   */
  private tickModeUi() {
    const mode = this.mode!;
    for (let i = 0; i < this.seats; i++) {
      // A server bot has no screen to send panels to (it loots chests through its planner).
      if (this.brains[i]) continue;
      const f = this.fighters[i];
      for (const e of f.events) {
        if (e.type !== 'openBlock' || e.block !== B.CHEST || !(mode instanceof Skywars) || this.phase !== 'fight') continue;
        if (!mode.canUse(f, e.x, e.y, e.z)) continue;
        mode.open(this, f, e.x, e.y, e.z);
        this.openChest[i] = { x: e.x, y: e.y, z: e.z, sent: '' };
        this.sendChest(i, true);
      }
      if (this.openChest[i]) this.sendChest(i, false);
      const ui = {
        sb: mode.scoreboard(this, f),
        title: mode.title(this, f),
        gear: mode instanceof Bedwars ? ({ ...mode.gear(this, f) } as Record<string, unknown>) : undefined,
      };
      const json = JSON.stringify(ui);
      if (json !== this.lastModeUi[i]) {
        this.lastModeUi[i] = json;
        this.outbox.push({ to: i, msg: { t: 'mode', ...ui } });
      }
    }
    const lines = mode.takeAnnouncements();
    if (lines.length) this.outbox.push({ to: -1, msg: { t: 'announce', lines } });
  }

  /** Sends seat `i` the chest they have open, if it changed (or `force`, when it opens). */
  private sendChest(i: number, open: boolean) {
    const c = this.openChest[i];
    if (!c || !(this.mode instanceof Skywars)) return;
    const items = this.mode.chestAt(c.x, c.y, c.z);
    const slots = items ? items.map((s) => toSlot(s)) : null;
    const json = JSON.stringify(slots);
    if (!open && json === c.sent) return;
    c.sent = json;
    this.outbox.push({ to: i, msg: { t: 'chest', x: c.x, y: c.y, z: c.z, items: slots, open: open || undefined } });
    if (!items) this.openChest[i] = null;
  }

  /** Mode messages since the last call (the room sends them after the state). */
  takeOutbox(): { to: number; msg: ServerMsg }[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** A Bed Wars purchase: only at your own shop, only while alive and fighting. */
  private buy(i: number, key: unknown) {
    const mode = this.mode;
    const f = this.fighters[i];
    if (!(mode instanceof Bedwars) || this.phase !== 'fight') return;
    const item = SHOP.find((s) => s.key === key);
    if (!item) return;
    let msg: string;
    if (!mode.nearShop(this, f)) msg = '✘ You are too far from your shop';
    else {
      const err = mode.buy(this, f, item);
      msg = err ? `✘ ${err}` : `✔ Bought ${item.name}`;
    }
    this.outbox.push({ to: i, msg: { t: 'bought', msg } });
  }

  /** A click in a SkyWars chest screen. */
  private chestOp(i: number, m: Extract<ClientMsg, { t: 'chest' }>) {
    const mode = this.mode;
    const f = this.fighters[i];
    if (!(mode instanceof Skywars) || this.phase !== 'fight') return;
    const [x, y, z] = [m.x, m.y, m.z].map((v) => Number(v) | 0);
    // Only the chest this player actually opened (a right click the server saw), and still in reach.
    const open = this.openChest[i];
    if (!open || open.x !== x || open.y !== y || open.z !== z || !mode.canUse(f, x, y, z)) return;
    const slot = Number(m.i) | 0;
    if (m.op === 'all') mode.takeAll(f, x, y, z);
    else if (m.op === 'take' && slot >= 0 && slot < 27) mode.take(f, x, y, z, slot);
    else if (m.op === 'put' && slot >= 0 && slot < 36) mode.put(f, x, y, z, slot);
    open.sent = '';
    this.sendChest(i, false);
  }

  /**
   * Resolves player i's queued clicks the moment they arrive instead of on the next tick (up to
   * 50 ms sooner), when every one of them is a plain swing at the opponent: anything else (an
   * item in use, a block or an end crystal in the way) is left for the tick, which keeps the
   * exact Match order for those. Returns the knockback to send at once; `hit` says whether
   * anything was resolved (then the caller sends a state straight away too).
   */
  resolveClicksNow(i: number): { hit: boolean; events: DuelEvent[] } {
    const none = { hit: false, events: [] };
    const f = this.fighters[i];
    if (this.phase !== 'fight' || f.dead || f.usingItem || this.pendingAttacks[i] === 0) return none;
    if (this.world.crystals.length || this.world.carts.length) return none;
    const vel = this.fighters.map((g) => [g.vel.x, g.vel.y, g.vel.z]);
    const slot = this.pendingSlot[i];
    if (slot !== null) {
      f.selectSlot(slot);
      this.pendingSlot[i] = null;
    }
    while (this.pendingSwap[i] > 0) {
      this.pendingSwap[i]--;
      f.swapHands();
    }
    let hit = false;
    while (this.pendingAttacks[i] > 0) {
      const view = this.attackViews[i][0] ?? null;
      const claim = this.attackClaims[i][0] ?? null;
      const ts = this.targetSeat(i, this.attackTargets[i][0] ?? null);
      const other = this.fighters[ts];
      const unwind = (view !== null && this.rewindToView(ts, view)) || this.rewind(ts, this.rewindTicks(i));
      const yaw = f.yaw;
      const pitch = f.pitch;
      if (claim) {
        f.yaw = claim.yaw;
        f.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, claim.pitch));
      }
      const judged = this.judgeClaim(f, other, claim);
      const plain = (judged !== undefined && judged >= 0) || !f.crosshairBlock(f.blockReach(), true);
      if (plain) {
        this.pendingAttacks[i]--;
        this.attackViews[i].shift();
        this.attackClaims[i].shift();
        this.attackTargets[i].shift();
        performAttack(f, other, judged);
        hit = true;
      }
      unwind();
      f.yaw = yaw;
      f.pitch = pitch;
      if (!plain) break;
    }
    const events: DuelEvent[] = [];
    for (let k = 0; k < this.seats; k++) {
      const g = this.fighters[k];
      if (g.vel.x !== vel[k][0] || g.vel.y !== vel[k][1] || g.vel.z !== vel[k][2]) events.push({ motion: { to: k, vx: g.vel.x, vy: g.vel.y, vz: g.vel.z } });
    }
    return { hit, events };
  }

  /** Mirrors Match.handlePlayerActions, but for a remote player's queued inputs. */
  private handleActions(i: number) {
    const f = this.fighters[i];
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
      this.attackViews[i].length = 0;
      this.attackClaims[i].length = 0;
      this.attackTargets[i].length = 0;
      this.pendingUse[i] = 0;
      return;
    }
    let mined = false;
    while (this.pendingAttacks[i] > 0) {
      this.pendingAttacks[i]--;
      const view = this.attackViews[i].shift() ?? null;
      const claim = this.attackClaims[i].shift() ?? null;
      const ts = this.targetSeat(i, this.attackTargets[i].shift() ?? null);
      const other = this.fighters[ts];
      // An end crystal nearer than the opponent takes the hit (against the rewound opponent).
      const unwind = (view !== null && this.rewindToView(ts, view)) || this.rewind(ts, this.rewindTicks(i));
      // Swing with the aim the click was made with, not the one from the last move packet.
      const yaw = f.yaw;
      const pitch = f.pitch;
      if (claim) {
        f.yaw = claim.yaw;
        f.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, claim.pitch));
      }
      const restore = () => {
        unwind();
        f.yaw = yaw;
        f.pitch = pitch;
      };
      if (hitNearerEntity(f, rayDistanceToTarget(f, other))) {
        restore();
        continue;
      }
      // A hit on the attacker's screen, which the server accepts, is an attack even if the
      // rewound opponent sits a hair beside the ray and a block (an arena wall) is behind them:
      // their screen showed the opponent in front of it.
      const judged = this.judgeClaim(f, other, claim);
      const onScreenHit = judged !== undefined && judged >= 0;
      if (!onScreenHit && !mined && f.tickMining(true, true)) {
        restore();
        mined = true;
        continue;
      }
      performAttack(f, other, judged);
      restore();
    }
    if (!mined) f.tickMining(this.mineHeld[i], false);
    while (this.pendingUse[i] > 0) {
      this.pendingUse[i]--;
      f.startUsingItem(true);
    }
    if (this.useHeld[i]) f.startUsingItem();
  }

  /**
   * What the attacker's screen showed, if the server agrees it could have: a click that missed on
   * screen is a miss; a claimed hit counts (at its distance) when the rewound opponent is within
   * CLAIM_SLACK of the crosshair — the smoothing, the frame and the tick between click and move
   * packet. Anything else (an old client, an implausible claim) is tested here as usual.
   */
  private judgeClaim(f: Fighter, other: Fighter, claim: AttackClaim | null): number | undefined {
    if (!claim) return undefined;
    if (claim.p < 0) return -1;
    if (rayDistanceToTarget(f, other, f.entityReach(), CLAIM_SLACK) < 0) return undefined;
    return Math.min(claim.p, f.entityReach());
  }

  /** Snapshots both fighters so a later swing can be tested against where they used to be. */
  private record() {
    for (let i = 0; i < this.seats; i++) {
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

  /**
   * Puts fighter `i` where the attacker saw them: at their own tick `view` (the moves are logged
   * by tick number, so this is exact however jittery the network was), interpolated between
   * logged moves. Bounded to MAX_REWIND_MS, so a client cannot claim a stale view. Returns the
   * function that puts them back, or null to fall back to the time-based rewind.
   */
  private rewindToView(i: number, view: number): (() => void) | null {
    const log = this.moveLog[i];
    if (log.length < 2) return null;
    const f = this.fighters[i];
    const newest = log[log.length - 1];
    if (view >= newest.q) return () => {};
    const limit = this.clock() - MAX_REWIND_MS;
    let k = log.length - 1;
    while (k > 0 && log[k].q > view) k--;
    let a = log[k];
    let b = log[Math.min(k + 1, log.length - 1)];
    // Too far back (or older than the log): the oldest moment still allowed.
    if (a.at < limit || a.q > view) {
      const j = log.findIndex((m) => m.at >= limit);
      a = b = log[j < 0 ? log.length - 1 : j];
      view = a.q;
    }
    const t = b.q > a.q ? Math.min(1, Math.max(0, (view - a.q) / (b.q - a.q))) : 0;
    const x = f.pos.x;
    const y = f.pos.y;
    const z = f.pos.z;
    const sneak = f.input.sneak;
    const ff = f.fallFlying;
    const past = t < 0.5 ? a : b;
    f.pos.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
    f.fallFlying = past.fallFlying;
    if (past.sneaking !== sneak) f.input = { ...f.input, sneak: past.sneaking };
    return () => {
      f.pos.set(x, y, z);
      f.fallFlying = ff;
      if (past.sneaking !== sneak) f.input = { ...f.input, sneak };
    };
  }

  /** Reach of i's crosshair onto the other fighter, or -1. Used only for diagnostics. */
  reach(i: number): number {
    return rayDistanceToTarget(this.fighters[i], this.fighters[this.targetSeat(i, null)]);
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
      k: w.carts.filter((c) => !c.removed).map((c) => [this.idOf(c), r3(c.pos.x), r3(c.pos.y), r3(c.pos.z), c.axis, c.primed ? 1 : 0]),
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
    for (let i = 0; i < this.seats; i++) {
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

  /**
   * A player's input message (everything but joining, rematches and pings). Returns a message
   * to pass straight on to the opponent: their move, relayed without waiting for a tick.
   */
  receive(i: number, msg: ClientMsg): ServerMsg | null {
    switch (msg.t) {
      case 'move':
        return this.applyMove(i, msg);
      case 'attack':
        this.queueAttack(i, msg.v, msg.p === undefined ? undefined : { p: msg.p, yaw: msg.yaw ?? NaN, pitch: msg.pitch ?? NaN }, msg.ti);
        return null;
      case 'use':
        this.setUse(i, !!msg.down);
        return null;
      case 'mine':
        this.setMining(i, !!msg.down);
        return null;
      case 'slot':
        this.setSlot(i, Number(msg.i) | 0);
        return null;
      case 'swap':
        this.queueSwap(i);
        return null;
      case 'buy':
        this.buy(i, msg.key);
        return null;
      case 'chest':
        if (msg && typeof msg === 'object') this.chestOp(i, msg);
        return null;
      case 'inv':
        this.setInventory(i, msg.slots);
        // Accepted or not, send back the real inventory: the client's copy was frozen while its
        // inventory screen was open and may have fallen behind (worn armor, a pickup).
        this.lastInv[i] = '';
        return null;
      default:
        return null;
    }
  }

  /** The per-tick state broadcast (call once per tick, after tick()). */
  stateMessage(tick: number, pings: number[]): Extract<ServerMsg, { t: 'state' }> {
    const ev = this.takeEvents();
    const we = this.takeWorldEvents();
    return {
      t: 'state',
      tick,
      phase: this.phase,
      fightTicks: this.fightTicks,
      countdown: this.countdownSeconds,
      players: this.fighters.map((_, i) => this.snapshot(i, pings[i] ?? 0)),
      winner: this.winner,
      blocks: this.takeBlockChanges(),
      ents: this.entities(),
      ev: ev.length ? ev : undefined,
      we: we.length ? we : undefined,
    };
  }

  /** Forces the next snapshot to carry full inventories (a client just (re)joined). */
  resendInventories() {
    this.lastInv.fill('');
  }
}
