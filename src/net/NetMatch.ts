import { clamp, lerp, lerpAngle } from '../core/math';
import { pushApart } from '../game/combat';
import { Fighter, SLOT_COUNT } from '../game/Fighter';
import { kitById } from '../game/kits';
import { World } from '../game/World';
import { COUNTDOWN_TICKS, SPAWN_DISTANCE } from '../game/Match';
import type { NetClient } from './Client';
import { INTERP_TICKS, fromSlot, toSlot, type NetFighter, type NetPhase, type ServerMsg } from './protocol';

/** One received snapshot of the opponent, kept so playback can interpolate between them. */
interface RemoteSample {
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  onGround: boolean;
  sprinting: boolean;
  sneaking: boolean;
}

/**
 * The online counterpart of Match, duck-typed so Game can drive either one.
 *
 * `player` is simulated locally from your own input exactly as in single-player — that is what
 * keeps the controls lag-free — and every authoritative value the server owns (health, hunger,
 * effects, attack cooldown, knockback) is written back over it as snapshots arrive. `bot` is the
 * opponent, driven entirely from snapshots.
 */
export class NetMatch {
  readonly world = new World(24);
  readonly kit = kitById('sword');
  readonly player: Fighter;
  readonly bot: Fighter;
  readonly profile = { id: 'online' as const, name: 'Opponent', color: '#ff55ff', tagline: '' };
  readonly brain = { label: '' };
  phase: NetPhase = 'countdown';
  phaseTicks = 0;
  fightTicks = 0;
  tickCount = 0;
  winner: Fighter | null = null;
  useHeld = false;
  /** Set while the remote snapshot has not arrived yet. */
  ready = false;
  /** The inventory screen is open: keep our local layout instead of the server's snapshot. */
  holdInventory = false;

  private lastUseHeld = false;
  private lastSlot = -1;
  private lastSwing = 0;
  /** Snapshot history for the opponent, oldest first. */
  private readonly samples: RemoteSample[] = [];
  /** Server tick currently being drawn — deliberately INTERP_TICKS behind the newest. */
  private playback = 0;
  private latestTick = 0;
  private hasRemote = false;
  private countdown = 3;

  constructor(
    private readonly net: NetClient,
    private readonly you: number,
  ) {
    this.player = new Fighter('player', 'You', this.world);
    this.bot = new Fighter('bot', 'Opponent', this.world);
    this.bot.networked = true;
    const half = SPAWN_DISTANCE / 2;
    const mine = you === 0 ? half : -half;
    this.player.reset(0, mine, you === 0 ? 0 : Math.PI, this.kit);
    this.bot.reset(0, -mine, you === 0 ? Math.PI : 0, this.kit);
    this.bot.networked = true;
  }

  get countdownSeconds(): number {
    return this.countdown;
  }

  queueClick() {
    if (this.phase !== 'fight' || this.player.dead) return;
    // Swing locally straight away so the animation is not waiting on the round trip; the server
    // still decides whether anything was hit.
    this.player.swing();
    this.player.resetAttackStrength();
    this.net.send({ t: 'attack' });
  }

  queueSlot(i: number) {
    if (i === this.player.selected) return;
    this.player.selectSlot(i);
    this.net.send({ t: 'slot', i });
  }

  queueUse() {
    // The server treats the press itself as a click; nothing extra to send.
  }

  queueSwapHands() {
    if (this.phase !== 'fight' || this.player.dead) return;
    this.player.swapHands();
    this.net.send({ t: 'swap' });
  }

  /** The inventory screen changed something: send the whole layout for the server to check. */
  syncInventory() {
    const p = this.player;
    this.net.send({ t: 'inv', slots: Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(p.getSlot(k))) });
  }

  requestRematch() {
    this.net.send({ t: 'rematch' });
  }

  // ---------------------------------------------------------------- server messages

  handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'state':
        this.applyState(msg.phase, msg.countdown, msg.fightTicks, msg.players, msg.winner, msg.tick);
        break;
      case 'motion':
        // ClientboundSetEntityMotionPacket: knockback replaces our velocity outright.
        this.player.vel.set(msg.vx, msg.vy, msg.vz);
        this.player.serverVel.set(msg.vx, msg.vy, msg.vz);
        break;
      case 'start':
        this.phase = 'countdown';
        this.phaseTicks = 0;
        this.countdown = msg.countdown;
        this.winner = null;
        this.resetLocal();
        break;
      default:
        break;
    }
  }

  private resetLocal() {
    const half = SPAWN_DISTANCE / 2;
    const mine = this.you === 0 ? half : -half;
    this.player.reset(0, mine, this.you === 0 ? 0 : Math.PI, this.kit);
    this.bot.reset(0, -mine, this.you === 0 ? Math.PI : 0, this.kit);
    this.bot.networked = true;
    this.lastSwing = 0;
    this.hasRemote = false;
    this.samples.length = 0;
  }

  private applyState(
    phase: NetPhase,
    countdown: number,
    fightTicks: number,
    players: NetFighter[],
    winner: number | null,
    tick: number,
  ) {
    this.phase = phase;
    this.countdown = countdown;
    this.fightTicks = fightTicks;
    const mine = players.find((p) => p.i === this.you);
    const theirs = players.find((p) => p.i !== this.you);
    if (mine) this.applyAuthoritative(this.player, mine);
    if (theirs) {
      this.applyAuthoritative(this.bot, theirs);
      this.bot.name = theirs.name;
      this.profile.name = theirs.name;
      this.latestTick = tick;
      this.samples.push({
        tick,
        x: theirs.x,
        y: theirs.y,
        z: theirs.z,
        yaw: theirs.yaw,
        pitch: theirs.pitch,
        onGround: theirs.g,
        sprinting: theirs.sp,
        sneaking: theirs.sn,
      });
      // A couple of seconds is plenty; playback never looks back more than INTERP_TICKS.
      while (this.samples.length > 60) this.samples.shift();
      if (!this.hasRemote) {
        this.bot.pos.set(theirs.x, theirs.y, theirs.z);
        this.bot.prevPos.copy(this.bot.pos);
        this.bot.yaw = theirs.yaw;
        this.bot.pitch = theirs.pitch;
        this.playback = tick - INTERP_TICKS;
        this.hasRemote = true;
        this.ready = true;
      }
      if (theirs.sw !== this.lastSwing) {
        if (this.lastSwing !== 0 || theirs.sw > 0) this.bot.swing();
        this.lastSwing = theirs.sw;
      }
      this.brain.label = theirs.ping ? `${theirs.ping} ms` : '';
    }
    this.winner = winner === null ? null : winner === this.you ? this.player : this.bot;
  }

  /** Copies everything the server owns onto a fighter, leaving movement alone. */
  private applyAuthoritative(f: Fighter, s: NetFighter) {
    f.health = s.hp;
    f.absorption = s.ab;
    f.food.level = s.food;
    f.food.saturation = s.sat;
    f.hurtTime = s.ht;
    f.invulnerableTime = s.iv;
    f.hurtDir = s.hd;
    f.attackStrengthTicker = s.ast;
    f.selected = s.sel;
    if (Array.isArray(s.inv) && !(f === this.player && this.holdInventory)) {
      for (let k = 0; k < SLOT_COUNT; k++) f.setSlot(k, fromSlot(s.inv[k]));
    }
    f.shieldCooldown = s.sc ?? 0;
    f.applyUseState(s.ui, s.uh === 1 ? 'off' : 'main', s.ur, s.ud);
    f.effects.clear();
    for (const [id, amplifier, duration] of s.eff) {
      f.effects.set(id as 'regeneration' | 'absorption', { amplifier, duration });
    }
    Object.assign(f.stats, s.st);
    if (s.dead && !f.dead) {
      f.dead = true;
      f.deathTime = s.dt;
    } else if (!s.dead && f.dead) {
      f.dead = false;
      f.deathTime = 0;
    } else if (s.dead) {
      f.deathTime = s.dt;
    }
  }

  // ---------------------------------------------------------------- tick

  tick() {
    this.tickCount++;
    const p = this.player;
    const b = this.bot;
    p.snapshot();
    b.snapshot();

    if (this.phase !== 'fight') {
      p.input = { forward: 0, strafe: 0, jump: false, sneak: p.input.sneak, sprint: false };
    }

    // Local movement + local use prediction; the server confirms the outcome.
    if (this.useHeld !== this.lastUseHeld) {
      this.lastUseHeld = this.useHeld;
      this.net.send({ t: 'use', down: this.useHeld });
    }
    if (this.phase === 'fight' && !p.dead) {
      if (this.useHeld && !p.usingItem) p.startUsingItem();
      else if (!this.useHeld && p.usingItem) p.stopUsingItem();
    }

    p.tick();
    this.stepRemote();
    // Vanilla pushes players apart client-side; without it you can stand inside your opponent.
    // Only our own half of the push is kept — the opponent is server-driven.
    if (!p.dead && !b.dead && this.phase === 'fight') {
      const bx = b.vel.x;
      const bz = b.vel.z;
      pushApart(p, b);
      b.vel.x = bx;
      b.vel.z = bz;
    }

    if (this.phase === 'countdown') this.phaseTicks++;
    if (p.selected !== this.lastSlot) this.lastSlot = p.selected;

    if (this.net.connected) {
      this.net.send({
        t: 'move',
        x: p.pos.x,
        y: p.pos.y,
        z: p.pos.z,
        yaw: p.yaw,
        pitch: p.pitch,
        g: p.onGround,
        sp: p.sprinting,
        sn: p.input.sneak,
        vy: p.vel.y,
      });
    }
  }

  /**
   * Eases the opponent toward the last reported position instead of snapping to it, then ticks
   * them so all the usual limb/body/swing animation still runs.
   */
  /**
   * Draws the opponent INTERP_TICKS behind the newest snapshot, interpolating between the two
   * snapshots that bracket that moment.
   *
   * The previous version eased toward the latest position by a fixed fraction each tick, which
   * is an exponential filter: its lag depends on how fast the target moves and is never fully
   * caught up. That is what made hits miss — you were swinging at a ghost roughly half a hitbox
   * behind the truth. A fixed delay is both smoother and, crucially, a number the server knows,
   * so it can rewind by exactly the same amount.
   */
  private stepRemote() {
    const b = this.bot;
    if (this.hasRemote && this.samples.length) {
      // Advance one tick per tick, nudging toward the target delay so clock drift is absorbed.
      this.playback += 1;
      const want = this.latestTick - INTERP_TICKS;
      this.playback += clamp(want - this.playback, -0.5, 0.5);

      const oldest = this.samples[0].tick;
      const newest = this.samples[this.samples.length - 1].tick;
      // Clamp the clock itself, not just the lookup: letting it run past the newest sample
      // freezes the opponent until the drift correction hauls it back.
      if (this.playback < oldest || this.playback > newest + 4) this.playback = want;
      this.playback = clamp(this.playback, oldest, newest);

      const t = this.playback;
      let i = this.samples.length - 1;
      while (i > 0 && this.samples[i].tick > t) i--;
      const a = this.samples[i];
      const c = this.samples[Math.min(i + 1, this.samples.length - 1)];
      const span = c.tick - a.tick;
      const f = span > 0 ? clamp((t - a.tick) / span, 0, 1) : 0;

      b.pos.set(lerp(a.x, c.x, f), lerp(a.y, c.y, f), lerp(a.z, c.z, f));
      b.yaw = lerpAngle(a.yaw, c.yaw, f);
      b.pitch = lerp(a.pitch, c.pitch, f);
      const cur = f < 0.5 ? a : c;
      b.onGround = cur.onGround;
      b.sprinting = cur.sprinting;
      b.input = { ...b.input, sneak: cur.sneaking };
    }
    b.tick();
  }
}

export const NET_COUNTDOWN_TICKS = COUNTDOWN_TICKS;
