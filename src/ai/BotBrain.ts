import * as C from '../core/constants';
import { DEG, V3, clamp, rayAABB, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { rayDistanceToTarget, shieldFaces, type AttackOutcome } from '../game/combat';
import { B, isSolid as isSolidBlock, type RayHit } from '../game/Blocks';
import { SLOT_ARMOR, SLOT_OFFHAND, type Fighter, type MoveInput } from '../game/Fighter';
import { ITEMS, durabilityFraction, type ItemId, type PotionId } from '../game/items';
import type { World } from '../game/World';
import type { BotProfile } from './difficulty';

export type BotState = 'engage' | 'retreat' | 'eat';

interface Seen {
  x: number;
  y: number;
  z: number;
  onGround: boolean;
  /** Eating (a golden apple). */
  using: boolean;
  /** Shield raised (visible from the first tick, blocking from the fifth). */
  shield: boolean;
  held: ItemId | null;
}

/** Something the NethPot bot is throwing at its own feet. */
type ThrowPlan = { what: PotionId | 'xp'; left: number };

/** A multi-tick UHC manoeuvre. Cells are block coordinates. */
type UhcPlan =
  | { kind: 'water'; x: number; y: number; z: number; phase: 'place' | 'wait' | 'pickup'; timer: number }
  | { kind: 'lava'; x: number; y: number; z: number; phase: 'place' | 'wait' | 'pickup'; timer: number }
  | { kind: 'web'; x: number; y: number; z: number; ax: number; ay: number; az: number; timer: number }
  | { kind: 'mine'; x: number; y: number; z: number; timer: number; started: boolean }
  | { kind: 'pillar'; baseY: number; height: number; timer: number; phase: 'build' | 'eat' }
  | { kind: 'head'; timer: number; count: number };

/** An open inventory: a delay, then slot swaps (number key / F over a slot) one by one. */
interface InvPlan {
  timer: number;
  moves: [from: number, to: number][];
}

/** Sub-plans the Axe-kit bot runs at range. */
type RangedPlan = 'none' | 'loadCrossbow' | 'fireCrossbow' | 'drawBow';

interface Perceived extends Seen {
  vx: number;
  vz: number;
}

/**
 * Drives the bot like a player would: it only controls keys (W/A/S/D, sprint, jump), mouse
 * look with human-like delay and error, left click and right click. All combat rules come
 * from the same simulation the player uses.
 */
const uhcRay: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };

export class BotBrain {
  state: BotState = 'engage';
  private seen: Seen[] = [];
  private errYaw = 0;
  private errPitch = 0;
  private strafeDir = 0;
  private strafeTimer = 0;
  private wtapTimer = 0;
  private stapNow = false;
  private critPlan = false;
  private critPlanTimer = 0;
  private critCheckTimer = 0;
  private swingThreshold: number;
  private stateTimer = 0;
  private partingTicks = 0;
  private gapsThisRetreat = 0;
  private gapCountAtEat = 0;
  private fleeYaw: number | null = null;
  private hitsTaken = 0;
  private escapeTimer = 0;
  private retreatCooldown = 0;

  // ---- Axe kit
  private ticks = 0;
  /** Tick the target's last swing started, to estimate when their weapon is charged again. */
  private targetSwingTick = -100;
  private targetHeldPrev: ItemId | null = null;
  /** We disabled their shield: it cannot come back up before this tick. */
  private targetShieldDownUntil = 0;
  private shieldPlan = false;
  private shieldPlanTimer = 0;
  private axeWait = -1;
  /** Bots that cannot attribute-swap keep the axe out until it has swung. */
  private axeCommit = 0;
  private swapBackTimer = 0;
  private readAxeRoll = false;
  private ranged: RangedPlan = 'none';
  private rangedTimer = 0;
  private rangedCooldown = 0;

  // ---- NethPot
  /** Spawned with splash potions: runs the pot/totem/mending game. */
  private potKit = false;
  /** Best melee weapon in the kit. */
  private weapon: ItemId = 'diamond_sword';
  /**
   * Diamond Pot (pots but no totems): a combo game. Normal knockback, Speed II and Strength II
   * make sprint-hit combos the main damage, crits the exception; low on health it runs out of
   * range and pots on the move instead of backing off.
   */
  private comboStyle = false;
  private runTimer = 0;
  private eatId: ItemId | null = null;
  private eatStartCount = 0;
  private inv: InvPlan | null = null;
  private throwing: ThrowPlan | null = null;
  private throwGap = 0;
  private throwAim = 0;
  private potCooldown = 0;
  private hadTotem = false;
  private totemReact = -1;
  private eating = false;
  private gapCooldown = 0;
  private potLabel = '';

  // ---- UHC
  private uhcKit = false;
  private plan: UhcPlan | null = null;
  private uhcCooldown = 0;
  private settle = 0;
  private uhcLabel = '';
  /** Ticks before it tries to rescue itself again (water, cutting a web) after a failed attempt. */
  private selfHelpCooldown = 0;

  constructor(
    private readonly bot: Fighter,
    private readonly target: Fighter,
    private readonly world: World,
    readonly profile: BotProfile,
    private readonly rng: Rng,
    private readonly doAttack: () => AttackOutcome,
  ) {
    this.swingThreshold = rng.range(profile.chargeMin, profile.chargeMax);
  }

  get label(): string {
    if (this.potLabel) return this.potLabel;
    if (this.uhcLabel) return this.uhcLabel;
    if (this.state === 'retreat') return 'Retreating';
    if (this.state === 'eat') return this.bot.usingItem ? 'Eating' : 'Healing';
    if (this.bot.raisingShield()) return 'Blocking';
    if (this.ranged !== 'none') return this.ranged === 'loadCrossbow' ? 'Loading' : 'Aiming';
    return this.profile.passive ? 'Passive' : 'Fighting';
  }

  /** Whether the bot is holding right click — lets Match drive a brain on the player's side. */
  get useHeld(): boolean {
    return this.bot.usingItem;
  }

  /** The Axe kit (or anything with a shield) switches the bot to its shield game. */
  private get shieldKit(): boolean {
    return this.bot.hasShield() || this.bot.slotOf('diamond_axe') >= 0;
  }

  resetRound() {
    this.state = 'engage';
    this.seen = [];
    this.stateTimer = 0;
    this.hitsTaken = 0;
    this.escapeTimer = 0;
    this.retreatCooldown = 0;
    this.critPlan = false;
    this.wtapTimer = 0;
    this.ticks = 0;
    this.targetSwingTick = -100;
    this.targetHeldPrev = null;
    this.targetShieldDownUntil = 0;
    this.shieldPlan = false;
    this.shieldPlanTimer = 0;
    this.axeWait = -1;
    this.axeCommit = 0;
    this.swapBackTimer = 0;
    this.ranged = 'none';
    this.rangedTimer = 0;
    this.rangedCooldown = 0;
    const b = this.bot;
    this.potKit = b.countItem('splash_potion') > 0;
    this.weapon = b.countItem('netherite_sword') > 0 ? 'netherite_sword' : 'diamond_sword';
    this.comboStyle = this.potKit && b.countItem('totem_of_undying') === 0;
    this.runTimer = 0;
    this.eatId = null;
    this.inv = null;
    this.throwing = null;
    this.throwGap = 0;
    this.potCooldown = 0;
    this.hadTotem = b.offhand?.id === 'totem_of_undying';
    this.totemReact = -1;
    this.eating = false;
    this.gapCooldown = 0;
    this.potLabel = '';
    this.uhcKit = b.countItem('water_bucket') + b.countItem('lava_bucket') + b.countItem('cobweb') > 0;
    this.plan = null;
    this.uhcCooldown = 0;
    this.settle = 0;
    this.uhcLabel = '';
    this.selfHelpCooldown = 0;
  }

  tick() {
    const b = this.bot;
    const T = this.target;
    this.ticks++;
    this.remember();
    const input: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    if (b.dead || T.dead) {
      b.input = input;
      if (b.usingItem) b.stopUsingItem();
      return;
    }
    const per = this.perceive();
    const dist = Math.hypot(per.x - b.pos.x, per.z - b.pos.z);
    const trueDist = Math.hypot(T.pos.x - b.pos.x, T.pos.z - b.pos.z);
    const justHurt = b.hurtTime === C.HURT_DURATION;
    if (justHurt) {
      this.hitsTaken++;
      if (this.hitsTaken >= 2 && this.profile.comboEscape !== 'none') this.escapeTimer = 14;
    }
    if (this.retreatCooldown > 0) this.retreatCooldown--;

    if (this.potKit) {
      this.potLabel = '';
      this.engagePot(per, dist, trueDist, justHurt, input);
      b.input = input;
      return;
    }
    if (this.uhcKit) {
      this.uhcLabel = '';
      if (this.uhcStep(per, trueDist, justHurt, input)) {
        this.avoidLava(input);
        b.input = input;
        return;
      }
    }
    this.updateState(trueDist);
    if (this.state === 'engage' && this.shieldKit) this.engageShield(per, dist, justHurt, input);
    else if (this.state === 'engage') this.engage(per, dist, justHurt, input);
    else if (this.state === 'retreat') this.retreat(per, trueDist, input);
    else this.eat(per, trueDist, input);
    if (this.uhcKit) this.avoidLava(input);
    b.input = input;
  }

  // ------------------------------------------------------------ perception & aim

  private remember() {
    const T = this.target;
    const held = T.heldStack()?.id ?? null;
    this.seen.push({
      x: T.pos.x,
      y: T.pos.y,
      z: T.pos.z,
      onGround: T.onGround,
      using: T.usingItem && T.useKind() === 'food',
      shield: T.raisingShield(),
      held,
    });
    if (this.seen.length > 48) this.seen.shift();
    // A swing is visible the tick it starts; a new item in hand restarts their cooldown too.
    if (T.swinging && T.swingTime <= 0) this.targetSwingTick = this.ticks;
    if (held !== this.targetHeldPrev) {
      this.targetSwingTick = this.ticks;
      this.targetHeldPrev = held;
    }
  }

  private perceive(): Perceived {
    const P = this.profile;
    const n = this.seen.length;
    const i = Math.max(0, n - 1 - P.reactionTicks);
    const s = this.seen[i];
    const prev = this.seen[Math.max(0, i - 1)];
    const vx = s.x - prev.x;
    const vz = s.z - prev.z;
    // Speed II (NethPot) makes a strafing target move 40% further per tick; without leading its
    // reaction delay even a Normal bot's crosshair trails 40° behind. Everyone learns to track
    // that, so pot fights lead by at least three quarters of the delay.
    const lead = P.reactionTicks * (this.potKit ? Math.max(P.predict, 0.75) : P.predict);
    return { ...s, x: s.x + vx * lead, z: s.z + vz * lead, vx, vz };
  }

  private aimAt(x: number, y: number, z: number, gain = 1) {
    const b = this.bot;
    const P = this.profile;
    const dx = x - b.pos.x;
    const dy = y - (b.pos.y + b.eyeHeight());
    const dz = z - b.pos.z;
    const h = Math.hypot(dx, dz);
    const wantYaw = h > 1e-4 ? yawTowards(dx, dz) : b.yaw;
    const wantPitch = Math.atan2(dy, Math.max(h, 0.25));
    const n = P.aimNoiseDeg * DEG;
    this.errYaw += (this.rng.gauss() * n * 2 - this.errYaw) * 0.15;
    this.errPitch += (this.rng.gauss() * n * 1.2 - this.errPitch) * 0.15;
    // Pot fights are fought at Speed II; keeping the crosshair on a sped-up strafe takes faster
    // mouse movement from everyone.
    this.turnTo(wantYaw + this.errYaw, wantPitch + this.errPitch, this.potKit ? gain * 1.6 : gain);
  }

  private turnTo(yaw: number, pitch: number, gain = 1) {
    const b = this.bot;
    const P = this.profile;
    const max = P.maxTurnDeg * DEG * gain;
    const k = Math.min(1, P.aimGain * gain);
    b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yaw - b.yaw) * k, -max, max));
    b.pitch = clamp(b.pitch + clamp((pitch - b.pitch) * k, -max, max), -1.55, 1.55);
  }

  // ------------------------------------------------------------ state machine

  private enter(s: BotState) {
    this.state = s;
    this.stateTimer = 0;
    if (s === 'retreat') {
      this.gapsThisRetreat = 0;
      this.fleeYaw = null;
      this.partingTicks = this.profile.partingShot ? 12 : 0;
    }
    if (s === 'eat') this.gapCountAtEat = this.bot.countItem('golden_apple');
    this.critPlan = false;
    this.wtapTimer = 0;
  }

  private updateState(trueDist: number) {
    const b = this.bot;
    const P = this.profile;
    const eff = b.effectiveHealth();
    const gaps = b.countItem('golden_apple');
    this.stateTimer++;
    switch (this.state) {
      case 'engage':
        if (gaps > 0 && this.retreatCooldown <= 0 && eff <= P.retreatHP && !b.effects.has('regeneration')) {
          this.enter('retreat');
        }
        break;
      case 'retreat':
        if (gaps === 0 || eff >= P.returnHP) this.enter('engage');
        else if (
          this.stateTimer > this.partingTicks &&
          (trueDist >= P.eatDistance || this.stateTimer >= P.maxRetreatTicks || this.cornered(trueDist))
        ) {
          this.enter('eat');
        }
        break;
      case 'eat': {
        const now = b.countItem('golden_apple');
        if (now < this.gapCountAtEat) {
          this.gapsThisRetreat++;
          this.gapCountAtEat = now;
          const again = eff < P.returnHP && now > 0 && this.gapsThisRetreat < P.maxGapsPerRetreat && trueDist > 4;
          if (!again) this.enter('engage');
        } else if (now === 0) {
          this.enter('engage');
        }
        break;
      }
    }
  }

  private cornered(trueDist: number) {
    return this.world.wallDistance(this.bot.pos.x, this.bot.pos.z) < 2.5 && trueDist < 4;
  }

  // ------------------------------------------------------------ behaviours

  private engage(per: Perceived, dist: number, justHurt: boolean, input: MoveInput, allowAttack = true) {
    const b = this.bot;
    const T = this.target;
    const P = this.profile;
    const rng = this.rng;
    if (!this.shieldKit) {
      this.equip(this.weapon);
      if (b.usingItem) b.stopUsingItem();
    }

    this.aimAt(per.x, per.y + (per.onGround ? 1.3 : 0.9), per.z);
    const p = b.attackStrengthScale(0.5);
    const targetEating = per.using;

    if (--this.strafeTimer <= 0) {
      this.strafeDir = rng.chance(P.strafeChance) ? (rng.chance(0.5) ? 1 : -1) : 0;
      this.strafeTimer = rng.int(P.strafeSwitch[0], P.strafeSwitch[1]);
    }
    let strafe = this.strafeDir;
    if (this.world.wallDistance(b.pos.x, b.pos.z) < 3) strafe = this.roomySide();

    input.forward = 1;
    input.sprint = true;
    input.strafe = dist < 5 ? strafe : 0;

    // Spacing: while the sword recharges, stay just outside the opponent's reach.
    if (p < 0.7 && dist < P.spacing - 0.5 && !targetEating && rng.chance(P.spacingDiscipline)) {
      input.forward = dist < P.spacing - 1.2 ? -1 : 0;
    }

    // W-tap / S-tap after a sprint hit so the next hit gets sprint knockback again.
    if (this.wtapTimer > 0) {
      this.wtapTimer--;
      input.forward = this.stapNow ? -1 : 0;
    }

    // Getting comboed: back out (S-hold) or strafe + jump-reset.
    if (this.escapeTimer > 0) {
      this.escapeTimer--;
      if (P.comboEscape === 'shold' && this.escapeTimer > 8) {
        input.forward = -1;
        input.sprint = false;
      }
      if (!input.strafe) input.strafe = strafe || (rng.chance(0.5) ? 1 : -1);
    }

    // Close the gap faster with sprint-jumps.
    if (P.chaseSprintJump && b.sprinting && b.onGround && (dist > 5.5 || (targetEating && P.punishEating && dist > 3.2))) {
      input.jump = true;
    }

    // Jump-reset: jump on the tick you get hit to cancel part of the knockback.
    if (this.profile.passive || !allowAttack) {
      if (justHurt && b.onGround && rng.chance(P.jumpResetChance)) input.jump = true;
      return; // never plans crits, never clicks
    }

    // Decide per exchange whether to go for jump-crits.
    if (--this.critCheckTimer <= 0) {
      this.critCheckTimer = 12;
      const base = this.comboStyle ? P.critChance * 0.4 : P.critChance;
      const chance = targetEating && P.punishEating ? Math.max(base, 0.7) : base;
      if (dist < 4 && rng.chance(chance)) {
        this.critPlan = true;
        this.critPlanTimer = 24;
      }
    }
    if (this.critPlan) {
      if (--this.critPlanTimer <= 0) this.critPlan = false;
      input.sprint = false;
      if (b.serverSprinting) input.forward = 0; // drop the sprint so the hit can be a crit
      else input.forward = dist > 2 ? 1 : 0;
      if (b.onGround && !b.serverSprinting && p >= 0.4 && dist < 3.2) input.jump = true;
    }

    // Jump-reset: jump on the tick you get hit to cancel part of the knockback.
    const jr = this.escapeTimer > 0 && P.comboEscape === 'jumpreset' ? Math.min(1, P.jumpResetChance + 0.3) : P.jumpResetChance;
    if (justHurt && b.onGround && rng.chance(jr)) {
      input.jump = true;
      input.forward = 1;
      input.sprint = true;
    }

    // ---- left click
    const reach = rayDistanceToTarget(b, T);
    const canHit = reach >= 0 && reach <= P.maxReach;
    const falling = !b.onGround && b.fallDistance > 0;
    let threshold = this.swingThreshold;
    if (P.halfSwing && (falling || b.serverSprinting)) threshold = Math.min(threshold, 0.92);
    let attack = false;
    if (canHit) {
      if (justHurt && p > C.STRONG_ATTACK_SCALE && rng.chance(P.hitSelectChance)) attack = true;
      else if (p >= threshold) {
        if (this.critPlan && !b.onGround && !falling) attack = false; // still rising
        else if (this.critPlan && b.onGround && p < 1) attack = false; // jump first
        else attack = true;
      }
    } else if (dist < 3.8 && rng.chance(P.missClickChance)) {
      attack = true;
    }
    if (attack) {
      const r = this.doAttack();
      this.swingThreshold = rng.range(P.chargeMin, P.chargeMax);
      if (r.hit) {
        this.hitsTaken = 0;
        this.escapeTimer = 0;
        if (r.crit) this.critPlan = false;
        if (r.sprint && rng.chance(P.wtapChance)) {
          this.wtapTimer = rng.int(P.wtapTicks[0], P.wtapTicks[1]);
          this.stapNow = rng.chance(P.stapChance);
        }
      }
    }
  }

  // ------------------------------------------------------------ Axe kit

  /** What the target looked like `ago` ticks ago (a raised shield is easy to spot). */
  private seenLate(ago: number): Seen {
    const n = this.seen.length;
    return this.seen[Math.max(0, n - 1 - ago)];
  }

  /**
   * The Axe-kit game. Priorities, in order: shoot at range; break a raised shield with the axe
   * (attribute-swapping on Hard+); block while the opponent's weapon is charged and ours is not;
   * otherwise fight with the sword exactly like the Sword kit — W-taps, crits, spacing.
   */
  private engageShield(per: Perceived, dist: number, justHurt: boolean, input: MoveInput) {
    const b = this.bot;
    const T = this.target;
    const P = this.profile;
    const A = P.axe;
    const rng = this.rng;
    if (this.rangedCooldown > 0) this.rangedCooldown--;

    if ((this.ranged !== 'none' || this.wantRanged(per, dist)) && this.rangedStep(per, dist, input)) return;

    // Back to the sword after an axe swing, or whenever nothing else needs a different item.
    if (this.swapBackTimer > 0) this.swapBackTimer--;
    const held = b.heldStack()?.id ?? null;
    if (this.swapBackTimer === 0 && this.axeWait < 0 && held !== 'diamond_sword') this.equip('diamond_sword');

    const seen = this.seenLate(A.shieldReact);
    const targetDown = this.targetShieldDownUntil > this.ticks;
    const facingUs = shieldFaces(T, b.pos.x, b.pos.z);
    const reach = rayDistanceToTarget(b, T);
    const inReach = reach >= 0 && reach <= P.maxReach;

    // ---- 1. Their shield is up and facing us: the axe disables it for 5 seconds.
    const wantsBreak = !P.passive && seen.shield && facingUs && !targetDown && b.slotOf('diamond_axe') >= 0;
    if (wantsBreak || this.axeCommit > 0) {
      if (this.axeCommit > 0) this.axeCommit--;
      this.shieldPlan = false;
      let released = false;
      if (b.usingItem) {
        // Lowering our own shield takes the whole tick: vanilla swallows clicks while in use.
        b.releaseUsingItem();
        released = true;
      }
      this.engage(per, dist, false, input, false);
      input.forward = dist > 2.4 ? 1 : 0;
      input.sprint = dist > 3.5;
      if (released || !inReach) return;
      if (A.swap && wantsBreak) {
        // Attribute swap: the axe goes in the hand and swings on the same tick, before the
        // equipment tick refreshes attributes — sword damage and cooldown, axe disable.
        this.equip('diamond_axe');
        this.afterAxeSwing(this.doAttack());
        this.swapBackTimer = 1;
        this.axeWait = -1;
        this.axeCommit = 0;
        return;
      }
      if (b.heldStack()?.id !== 'diamond_axe') {
        this.equip('diamond_axe');
        this.axeWait = rng.int(A.axeDelay[0], A.axeDelay[1]);
        this.axeCommit = 40;
        return;
      }
      if (this.axeWait > 0) {
        this.axeWait--;
        return;
      }
      // Still blocking: any axe hit disables. Shield dropped: wait for a strong axe hit instead of
      // throwing away the cooldown by switching straight back.
      if (wantsBreak || b.attackStrengthScale(0.5) >= 0.95) {
        this.afterAxeSwing(this.doAttack());
        this.axeWait = -1;
        this.axeCommit = 0;
        this.swapBackTimer = rng.int(2, 6);
      }
      return;
    }
    if (this.axeWait >= 0) this.axeWait = -1;

    // ---- 2. Block while their weapon is charged and ours is not.
    if (--this.shieldPlanTimer <= 0) {
      this.shieldPlanTimer = rng.int(8, 16);
      this.shieldPlan = rng.chance(A.shieldChance);
      this.readAxeRoll = rng.chance(A.readAxe);
    }
    const theirHeld = per.held;
    const theirDelay = 20 / (theirHeld ? ITEMS[theirHeld].attackSpeed : C.FIST_ATTACK_SPEED);
    const readyIn = this.targetSwingTick + theirDelay * 0.9 - this.ticks;
    const lookingAtUs = Math.abs(wrapAngle(T.yaw - yawTowards(b.pos.x - T.pos.x, b.pos.z - T.pos.z))) < 1.1;
    const threatened = dist < 4.6 && lookingAtUs && readyIn <= A.shieldLead && !per.using && !seen.shield;
    const canShield = b.offhand?.id === 'shield' && b.shieldCooldown === 0 && ITEMS[held ?? 'arrow'].use === 'none';
    const p = b.attackStrengthScale(0.5);
    const myHitReady = inReach && p >= Math.min(this.swingThreshold, 0.95) && !(seen.shield && facingUs && !targetDown);
    const axeRead = theirHeld === 'diamond_axe' && this.readAxeRoll;
    let wantShield = canShield && this.shieldPlan && threatened && !axeRead && !myHitReady;
    if (P.passive) wantShield = canShield && this.shieldPlan && dist < 5 && lookingAtUs;

    if (wantShield) {
      if (!b.usingItem) b.startUsingItem(true);
      this.engage(per, dist, justHurt, input, false);
      // Blocking walks at 20% speed and cannot sprint; hold ground just inside reach.
      input.sprint = false;
      input.jump = false;
      // Spacing off where they really are: walking into them with the shield up wastes it.
      const d = Math.hypot(T.pos.x - b.pos.x, T.pos.z - b.pos.z);
      if (d < 2.4) input.forward = -1;
      else if (d < 3.2) input.forward = 0;
      return;
    }

    // ---- 3. Sword.
    if (b.usingItem) {
      b.releaseUsingItem();
      this.engage(per, dist, justHurt, input, false);
      return;
    }
    this.engage(per, dist, justHurt, input, true);
  }

  private afterAxeSwing(r: AttackOutcome) {
    if (r.disabled) {
      // Their shield is down for 5 s: go all in with the sword.
      this.targetShieldDownUntil = this.ticks + C.SHIELD_DISABLE_TICKS - 2;
      this.critPlan = this.rng.chance(Math.max(0.5, this.profile.critChance));
      this.critPlanTimer = 30;
    }
    this.swingThreshold = this.rng.range(this.profile.chargeMin, this.profile.chargeMax);
  }

  // ---- ranged

  private closingSpeed(per: Perceived): number {
    const b = this.bot;
    const dx = b.pos.x - per.x;
    const dz = b.pos.z - per.z;
    const d = Math.hypot(dx, dz) || 1;
    return (dx * per.vx + dz * per.vz) / d;
  }

  private wantRanged(per: Perceived, dist: number): boolean {
    const b = this.bot;
    const A = this.profile.axe;
    if (A.ranged === 0 || this.profile.passive || this.rangedCooldown > 0 || b.shieldCooldown > 0) return false;
    const xb = b.slotOf('crossbow');
    const charged = xb >= 0 && !!b.inventory[xb]?.charged;
    if (charged && dist > 6) return true;
    // UHC: out of sword reach up a pillar — shoot them down.
    if (this.uhcKit && this.targetUp() && xb >= 0 && (charged || b.hasAmmo())) return true;
    if (dist < 10 || this.closingSpeed(per) > 0.12) return false;
    if (xb >= 0 && b.hasAmmo()) return true;
    return A.ranged >= 2 && b.slotOf('bow') >= 0 && b.hasAmmo() && dist > 11;
  }

  /** Returns true while a ranged plan owns this tick. */
  private rangedStep(per: Perceived, dist: number, input: MoveInput): boolean {
    const b = this.bot;
    const A = this.profile.axe;
    if (this.ranged === 'none') {
      const xb = b.slotOf('crossbow');
      if (xb >= 0 && b.inventory[xb]?.charged) this.ranged = 'fireCrossbow';
      else if (xb >= 0 && b.hasAmmo()) this.ranged = 'loadCrossbow';
      else if (b.slotOf('bow') >= 0 && b.hasAmmo()) this.ranged = 'drawBow';
      else return false;
      this.rangedTimer = 0;
    }
    this.rangedTimer++;
    const abortAt = this.uhcKit && this.targetUp() ? 0 : this.ranged === 'fireCrossbow' ? 4 : 6.5;
    if (dist < abortAt || this.rangedTimer > 90) {
      if (b.usingItem) b.stopUsingItem();
      this.ranged = 'none';
      this.rangedCooldown = 40;
      return false;
    }
    // Strafe slowly while busy, keeping the distance.
    input.strafe = this.strafeDir || 1;
    input.forward = dist < 12 ? -1 : 0;

    const T = this.target;
    const blockedByShield = this.seenLate(A.shieldReact).shield && shieldFaces(T, b.pos.x, b.pos.z);
    switch (this.ranged) {
      case 'loadCrossbow':
        this.equip('crossbow');
        this.aimAt(per.x, per.y + 1.2, per.z, 0.6);
        if (!b.usingItem) b.startUsingItem(true);
        else if (b.useTicks() >= C.CROSSBOW_CHARGE_TICKS + 1) {
          b.releaseUsingItem();
          this.ranged = 'fireCrossbow';
          this.rangedTimer = 0;
        }
        return true;
      case 'fireCrossbow': {
        this.equip('crossbow');
        const aimed = this.aimArrow(per, C.CROSSBOW_SPEED);
        if (aimed && !blockedByShield && b.heldStack()?.charged) {
          b.startUsingItem(true);
          this.ranged = 'none';
          this.rangedCooldown = 30;
        }
        return true;
      }
      case 'drawBow': {
        this.equip('bow');
        if (!b.usingItem) {
          b.startUsingItem(true);
          return true;
        }
        const aimed = this.aimArrow(per, C.BOW_MAX_SPEED);
        if (b.useTicks() >= C.BOW_FULL_DRAW_TICKS && aimed && !blockedByShield) {
          b.releaseUsingItem();
          this.ranged = 'none';
          this.rangedCooldown = 30;
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Aims a ballistic arrow at where the target will be; true once the crosshair is on it. */
  private aimArrow(per: Perceived, speed: number): boolean {
    const b = this.bot;
    const ex = b.pos.x;
    const ey = b.pos.y + b.eyeHeight() - 0.1;
    const ez = b.pos.z;
    let tx = per.x;
    let tz = per.z;
    let sol = ballistic(Math.hypot(tx - ex, tz - ez), per.y + 1.1 - ey, speed);
    if (!sol) return false;
    // Lead once by the flight time, then solve again for the led point.
    tx += per.vx * sol.ticks;
    tz += per.vz * sol.ticks;
    sol = ballistic(Math.hypot(tx - ex, tz - ez), per.y + 1.1 - ey, speed);
    if (!sol) return false;
    const n = this.profile.axe.rangedNoiseDeg * DEG;
    this.errYaw += (this.rng.gauss() * n - this.errYaw) * 0.1;
    this.errPitch += (this.rng.gauss() * n * 0.6 - this.errPitch) * 0.1;
    const yaw = yawTowards(tx - ex, tz - ez) + this.errYaw;
    const pitch = sol.pitch + this.errPitch;
    this.turnTo(yaw, pitch, 1);
    return Math.abs(wrapAngle(b.yaw - yaw)) < 1.5 * DEG && Math.abs(b.pitch - pitch) < 1.5 * DEG;
  }

  // ------------------------------------------------------------ NethPot

  /**
   * The NethPot game, in priority order: finish what the open inventory is doing; re-totem after
   * a pop; pot when low; keep Strength, Speed and Fire Resistance up; mend armor with XP and eat
   * a golden apple for absorption when there is room; otherwise fight for crits — jump crits and
   * P-crits (punish crits: the knockback from their hit lifts you, and you crit on the way down).
   */
  private engagePot(per: Perceived, dist: number, trueDist: number, justHurt: boolean, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    const N = P.neth;
    const rng = this.rng;
    if (this.potCooldown > 0) this.potCooldown--;
    if (this.throwGap > 0) this.throwGap--;
    if (this.gapCooldown > 0) this.gapCooldown--;

    // ---- 0. Inventory open: no movement, no clicks, just the moves.
    if (this.inv) {
      this.potLabel = 'Inventory';
      if (b.usingItem) b.stopUsingItem();
      if (--this.inv.timer <= 0) {
        const mv = this.inv.moves.shift();
        if (mv) b.swapSlots(mv[0], mv[1]);
        if (this.inv.moves.length) this.inv.timer = 2;
        else this.inv = null;
      }
      return;
    }

    // ---- 1. Re-totem.
    const hasTotem = b.offhand?.id === 'totem_of_undying';
    if (this.hadTotem && !hasTotem) this.totemReact = N.totemReact;
    this.hadTotem = hasTotem;
    if (!hasTotem && b.countItem('totem_of_undying') > 0 && this.totemReact >= 0) {
      if (this.totemReact > 0) this.totemReact--;
      else {
        this.potLabel = 'Re-totem';
        const hs = b.slotOf('totem_of_undying');
        if (hs >= 0 && N.hotbarTotem) {
          if (b.usingItem) b.stopUsingItem();
          // Two keys: the totem's slot, then F on the next tick.
          if (b.selected !== hs) b.selectSlot(hs);
          else {
            b.swapHands();
            this.totemReact = -1;
          }
          this.backOff(per, dist, input);
          return;
        }
        const is = b.invSlotOf('totem_of_undying');
        if (is >= 0) {
          this.openInv([[is, SLOT_OFFHAND]]);
          this.totemReact = -1;
          return;
        }
      }
    }

    const safe = trueDist > 4.8 && !per.using;

    // ---- 2. Decide what, if anything, to throw.
    if (!this.throwing && !this.eating && this.potCooldown === 0) this.throwing = this.pickThrow(trueDist);

    if (this.throwing) {
      this.throwStep(per, dist, input);
      return;
    }

    // ---- 3. Keep a spare totem and some healing in the hotbar when there is time.
    if (safe && !this.eating && this.potCooldown === 0) {
      const moves = this.restockMoves();
      if (moves.length) {
        this.openInv(moves);
        return;
      }
    }

    // ---- 4. Eat: a golden apple for absorption, or steak to keep the hunger bar (and sprint) up.
    if (!this.eating && this.potCooldown === 0 && this.gapCooldown === 0 && !P.passive) {
      const hungry = b.food.level <= 14 && b.countItem('cooked_beef') > 0;
      const starving = b.food.level <= 7; // sprinting stops at 6
      if (!b.effects.has('absorption') && b.countItem('golden_apple') > 0 && trueDist > N.gapDist) this.eatId = 'golden_apple';
      else if (hungry && (trueDist > N.gapDist || (starving && trueDist > 3.5))) this.eatId = 'cooked_beef';
      else this.eatId = null;
      this.eating = this.eatId !== null;
      if (this.eatId) this.eatStartCount = b.countItem(this.eatId);
    }
    if (this.eating && this.eatId) {
      this.potLabel = 'Eating';
      // Food in the off hand (steak) is eaten behind the sword: right click falls through to it.
      const inOff = b.offhand?.id === this.eatId;
      const ready = inOff ? this.equip(this.weapon) : this.equip(this.eatId);
      const left = b.countItem(this.eatId);
      if (!ready || left === 0 || left < this.eatStartCount) {
        // Out of food, or the one we started on is finished.
        this.eating = false;
        this.gapCooldown = 20;
      } else {
        if (!b.usingItem && !b.startUsingItem()) {
          this.eating = false;
          this.gapCooldown = 20;
          return;
        }
        if (this.comboStyle) this.runOff(per, input);
        else this.backOff(per, dist, input);
        const progress = b.usingItem ? 1 - b.useItemRemaining / Math.max(1, b.useItemDuration) : 0;
        // Too close to finish it: stop eating and fight.
        if (trueDist < 3 && progress < 0.6) {
          b.stopUsingItem();
          this.eating = false;
          this.gapCooldown = 60;
        }
        return;
      }
    }

    // ---- 5a. Diamond Pot: getting comboed low on health — use Speed to get out of range.
    if (this.comboStyle && !P.passive) {
      if (justHurt && this.hitsTaken >= 2 && b.health < 13 && N.rebuff && trueDist < 4) this.runTimer = 12 + rng.int(0, 8);
      if (this.runTimer > 0) {
        this.runTimer--;
        this.potLabel = 'Escaping';
        if (b.usingItem) b.stopUsingItem();
        this.equip(this.weapon);
        this.runOff(per, input);
        return;
      }
    }

    // ---- 5. Fight. A hit on us is a P-crit chance: no sprint, hop, crit on the way down.
    if (justHurt && !P.passive && rng.chance(this.comboStyle ? N.pcrit * 0.3 : N.pcrit)) {
      this.critPlan = true;
      this.critPlanTimer = 16;
      this.engage(per, dist, false, input);
      input.sprint = false;
      if (b.onGround) input.jump = true;
      return;
    }
    this.engage(per, dist, justHurt, input);
  }

  /** Everything to throw at our own feet, most urgent first. */
  private pickThrow(trueDist: number): ThrowPlan | null {
    const b = this.bot;
    const T = this.target;
    const N = this.profile.neth;
    const has = (p: PotionId) => b.countItem('splash_potion', p) > 0;
    const low = (id: 'strength' | 'speed' | 'fire_resistance' | 'regeneration') => (b.effects.get(id)?.duration ?? 0) < 60;
    // Diamond Pot hits are 33% harder, so pot earlier.
    const potHP = N.potHP + (this.comboStyle ? 2 : 0);
    if (b.health <= potHP && has('healing')) return { what: 'healing', left: b.health <= potHP - 5 ? 2 : 1 };
    const opening = this.ticks < 80;
    const buffOk = (opening || N.rebuff) && trueDist > 3.6;
    const theirSword = T.heldStack();
    const burns = (theirSword?.ench?.fireAspect ?? 0) > 0 || b.onFire;
    if (buffOk && burns && low('fire_resistance') && has('fire_resistance')) return { what: 'fire_resistance', left: 1 };
    if (buffOk && !this.profile.passive && low('strength') && has('strength')) return { what: 'strength', left: 1 };
    if (buffOk && low('speed') && has('swiftness')) return { what: 'swiftness', left: 1 };
    if (buffOk && low('regeneration') && has('regeneration')) return { what: 'regeneration', left: 1 };
    // Mending: in bursts whenever a knockback opens a gap.
    if (N.mendAt > 0 && trueDist > 4.5 && b.countItem('experience_bottle') > 0) {
      let worst = 1;
      let missing = 0;
      for (let i = 0; i < 4; i++) {
        const st = b.armorSlots[i];
        const f = durabilityFraction(st);
        if (f !== null) {
          worst = Math.min(worst, f);
          missing += st!.damage ?? 0;
        }
      }
      if (worst < N.mendAt) return { what: 'xp', left: Math.min(16, Math.ceil(missing / 14)) };
    }
    return null;
  }

  /** Select the item, look down, back away and throw; an XP bottle repeats on the held button. */
  private throwStep(per: Perceived, dist: number, input: MoveInput) {
    const b = this.bot;
    const t = this.throwing!;
    const N = this.profile.neth;
    const id: ItemId = t.what === 'xp' ? 'experience_bottle' : 'splash_potion';
    const potion = t.what === 'xp' ? undefined : t.what;
    this.potLabel = t.what === 'xp' ? 'Mending' : t.what === 'healing' ? 'Potting' : 'Buffing';
    // Mending stops once they come back.
    if (t.what === 'xp' && Math.hypot(this.target.pos.x - b.pos.x, this.target.pos.z - b.pos.z) < 3.5) {
      this.throwing = null;
      return;
    }
    let slot = b.slotOf(id, potion);
    if (slot < 0) {
      const from = b.invSlotOf(id, potion);
      const to = this.freeHotbarSlot();
      if (from < 0 || to < 0) {
        this.throwing = null;
        return;
      }
      // Out of healing in the hotbar: shift-click a row of pots in while the inventory is open.
      const moves: [number, number][] = [[from, to]];
      if (t.what === 'healing') for (const mv of this.restockMoves(2, from, to)) moves.push(mv);
      this.openInv(moves);
      return;
    }
    if (b.usingItem) b.stopUsingItem();
    if (b.selected !== slot) b.selectSlot(slot);
    slot = b.selected;
    if (this.throwAim === 0) this.throwAim = Math.abs(this.rng.gauss()) * N.potNoiseDeg * DEG + 1e-4;
    // Straight down, give or take the skill's error; the flick is fast but not instant.
    this.turnTo(b.yaw, -Math.PI / 2 + this.throwAim, 2.5);
    // Diamond Pot run-pot: sprint away and throw at your feet — the potion carries your
    // speed, so it lands under you. NethPot backs off facing them instead.
    if (this.comboStyle && t.what === 'healing' && dist < 6) this.runOff(per, input);
    else this.backOff(per, dist, input);
    input.jump = false;
    if (b.pitch > -Math.PI / 2 + this.throwAim + 0.35 || this.throwGap > 0) return;
    if (t.what === 'xp') {
      if (!b.startUsingItem()) return; // held button: one bottle every 4 ticks
    } else if (!b.startUsingItem(true)) return;
    this.throwAim = 0;
    this.throwGap = t.what === 'xp' ? 0 : N.potGap;
    if (--t.left <= 0) {
      this.throwing = null;
      // Give the potion time to land (about 3 ticks) before judging what we need again.
      this.potCooldown = t.what === 'xp' ? 2 : 6;
    }
  }

  /** Walk backwards away from the target (keeps facing them, so the fight resumes instantly). */
  private backOff(per: Perceived, dist: number, input: MoveInput) {
    const b = this.bot;
    const yaw = yawTowards(per.x - b.pos.x, per.z - b.pos.z);
    // Keep the body turned to them even while the head looks down.
    b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yaw - b.yaw), -0.6, 0.6));
    input.forward = dist < 9 ? -1 : 0;
    input.strafe = this.world.wallDistance(b.pos.x, b.pos.z) < 3 ? this.roomySide() : this.strafeDir;
    input.sprint = false;
  }

  /** Sprint straight away from the target (with Speed II this outruns a chaser's reach). */
  private runOff(per: Perceived, input: MoveInput) {
    const b = this.bot;
    const fy = this.fleeDirection(per);
    b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(fy - b.yaw), -0.9, 0.9));
    input.forward = 1;
    input.sprint = true;
    input.strafe = 0;
  }

  private openInv(moves: [number, number][]) {
    const b = this.bot;
    if (b.usingItem) b.stopUsingItem();
    this.inv = { timer: this.profile.neth.invTicks, moves };
    this.eating = false;
  }

  /**
   * A hotbar slot we can swap something into: empty first, then a spare healing pot (it just goes
   * back to the inventory), then a buff whose effect is already running. Never the sword, apples
   * or totem.
   */
  private freeHotbarSlot(): number {
    const b = this.bot;
    for (let i = 0; i < 9; i++) if (!b.inventory[i]) return i;
    let heals = 0;
    for (let i = 0; i < 9; i++) if (b.inventory[i]?.potion === 'healing') heals++;
    if (heals >= 2) for (let i = 8; i >= 0; i--) if (b.inventory[i]?.potion === 'healing') return i;
    for (let i = 8; i >= 0; i--) {
      const p = b.inventory[i]?.potion;
      if (p && p !== 'healing' && b.effects.has(p === 'swiftness' ? 'speed' : p)) return i;
    }
    for (let i = 8; i >= 0; i--) if (b.inventory[i]?.id === 'splash_potion') return i;
    return -1;
  }

  /**
   * Inventory moves that put a spare totem and healing pots back into empty hotbar slots
   * (skipping `usedFrom` / `usedTo`, a move already planned). Healing is only topped up once
   * the hotbar is down to `minHeals`.
   */
  private restockMoves(minHeals = 2, usedFrom = -1, usedTo = -1): [number, number][] {
    const b = this.bot;
    const N = this.profile.neth;
    const moves: [number, number][] = [];
    const empty: number[] = [];
    for (let i = 1; i < 9; i++) if (!b.inventory[i] && i !== usedTo) empty.push(i);
    if (!empty.length) return moves;
    const taken = new Set<number>([usedFrom]);
    const take = (id: ItemId, potion?: PotionId) => {
      for (let i = 9; i < SLOT_ARMOR; i++) {
        const s = b.inventory[i];
        if (!taken.has(i) && s?.id === id && (potion === undefined || s.potion === potion)) {
          taken.add(i);
          return i;
        }
      }
      return -1;
    };
    if (N.hotbarTotem && b.slotOf('totem_of_undying') < 0 && b.offhand?.id === 'totem_of_undying') {
      const from = take('totem_of_undying');
      if (from >= 0) moves.push([from, empty.shift()!]);
    }
    let heals = 0;
    for (let i = 0; i < 9; i++) if (b.inventory[i]?.potion === 'healing') heals++;
    if (heals <= minHeals) {
      while (empty.length && moves.length < 6) {
        const from = take('splash_potion', 'healing');
        if (from < 0) break;
        moves.push([from, empty.shift()!]);
      }
    }
    return moves;
  }

  // ------------------------------------------------------------ UHC

  private targetUp(): boolean {
    return this.target.pos.y - this.bot.pos.y > 1.4;
  }

  /**
   * UHC tricks on top of the Axe-kit shield game. Returns true when a plan owns this tick.
   * Priorities: put out fire / wash off a web; eat a golden head; pillar up to eat when low;
   * break the pillar they stand on or the blocks between us; pour lava on them; web them.
   */
  private uhcStep(per: Perceived, trueDist: number, justHurt: boolean, input: MoveInput): boolean {
    const b = this.bot;
    const T = this.target;
    const U = this.profile.uhc;
    const P = this.profile;
    const rng = this.rng;
    const blocks = this.world.blocks;
    if (this.uhcCooldown > 0) this.uhcCooldown--;
    if (this.selfHelpCooldown > 0) this.selfHelpCooldown--;
    if (this.plan) {
      const r = this.runPlan(per, trueDist, input);
      if (r === 'own') return true;
      if (this.plan) return false; // running in the background (lava waiting to be picked up)
    } else if (b.mining) b.tickMining(false, false);

    const cellX = Math.floor(b.pos.x);
    const cellY = Math.floor(b.pos.y + 0.01);
    const cellZ = Math.floor(b.pos.z);

    // ---- Fire or lava on us: water at our feet (then pick it back up).
    const burning = b.inLava || (b.fireTicks > 30 && !b.effects.has('fire_resistance'));
    if (U.water && burning && !b.inWater && b.slotOf('water_bucket') >= 0 && this.selfHelpCooldown === 0) {
      this.plan = { kind: 'water', x: cellX, y: cellY, z: cellZ, phase: 'place', timer: 0 };
      return this.runPlan(per, trueDist, input) === 'own';
    }
    // ---- Stuck in a web: wash it away, or cut it with the sword — unless they are right here,
    // in which case fighting back (sword and shield still work in a web) is the better answer.
    if (b.inWeb && trueDist > 3.2 && this.selfHelpCooldown === 0) {
      if (U.water && b.slotOf('water_bucket') >= 0) {
        this.plan = { kind: 'water', x: cellX, y: cellY, z: cellZ, phase: 'place', timer: 0 };
        return this.runPlan(per, trueDist, input) === 'own';
      }
      if (U.mine) {
        const y = blocks.get(cellX, cellY, cellZ) === B.COBWEB ? cellY : cellY + 1;
        if (blocks.get(cellX, y, cellZ) === B.COBWEB) {
          this.plan = { kind: 'mine', x: cellX, y, z: cellZ, timer: 0, started: false };
          return this.runPlan(per, trueDist, input) === 'own';
        }
      }
    }
    // ---- A golden head: one second, four hearts.
    if (
      b.health <= U.headHP &&
      b.countItem('golden_head') > 0 &&
      !b.cooldowns.has('golden_head') &&
      !b.effects.has('regeneration') &&
      trueDist > 2.4
    ) {
      this.plan = { kind: 'head', timer: 0, count: b.countItem('golden_head') };
      return this.runPlan(per, trueDist, input) === 'own';
    }
    // ---- Low with apples to eat and them close: pillar up out of reach and eat on top.
    if (
      U.pillar &&
      !P.passive &&
      b.effectiveHealth() <= P.retreatHP &&
      !b.effects.has('regeneration') &&
      b.countItem('golden_apple') > 0 &&
      b.slotOf('oak_planks') >= 0 &&
      b.onGround &&
      trueDist < 6 &&
      this.columnClear(cellX, cellY, cellZ, 5)
    ) {
      this.plan = { kind: 'pillar', baseY: cellY, height: 0, timer: 0, phase: 'build' };
      return this.runPlan(per, trueDist, input) === 'own';
    }
    if (P.passive) return false;
    // ---- They are up a pillar next to us: break the block they stand on.
    if (U.mine && this.targetUp() && trueDist < 3.2) {
      const tx = Math.floor(T.pos.x);
      const ty = Math.floor(T.pos.y + 0.01) - 1;
      const tz = Math.floor(T.pos.z);
      if (blocks.get(tx, ty, tz) === B.PLANKS) {
        this.plan = { kind: 'mine', x: tx, y: ty, z: tz, timer: 0, started: false };
        return this.runPlan(per, trueDist, input) === 'own';
      }
    }
    // ---- A wall between us: dig through it.
    if (U.mine && trueDist < 4.3 && blocks.count) {
      const eye = b.eyePos();
      const dx = T.pos.x - eye.x;
      const dy = T.pos.y + 1.2 - eye.y;
      const dz = T.pos.z - eye.z;
      const len = Math.hypot(dx, dy, dz);
      const hit = blocks.raycast(eye.x, eye.y, eye.z, dx / len, dy / len, dz / len, Math.min(len, C.BLOCK_REACH), 'outline', uhcRay);
      if (hit && (hit.id === B.PLANKS || hit.id === B.COBWEB)) {
        this.plan = { kind: 'mine', x: hit.x, y: hit.y, z: hit.z, timer: 0, started: false };
        return this.runPlan(per, trueDist, input) === 'own';
      }
    }
    if (this.uhcCooldown > 0) return false;
    const tCell = { x: Math.floor(T.pos.x), y: Math.floor(T.pos.y + 0.01), z: Math.floor(T.pos.z) };
    const level = Math.abs(T.pos.y - b.pos.y) < 1 && T.onGround;
    // ---- Lava at their feet.
    if (
      U.lava > 0 &&
      b.slotOf('lava_bucket') >= 0 &&
      level &&
      trueDist > 2 &&
      trueDist < 4.2 &&
      !T.inWater &&
      !T.inLava &&
      !T.effects.has('fire_resistance') &&
      blocks.get(tCell.x, tCell.y, tCell.z) === B.AIR
    ) {
      if (rng.chance(U.lava)) {
        this.plan = { kind: 'lava', ...tCell, phase: 'place', timer: 0 };
        return this.runPlan(per, trueDist, input) === 'own';
      }
      this.uhcCooldown = 40;
      return false;
    }
    // ---- A web where they are walking in, or on ourselves to stop a combo.
    if (U.web > 0 && b.slotOf('cobweb') >= 0) {
      const comboed = justHurt && this.hitsTaken >= 3 && b.health < 10 && !b.inWeb;
      if (comboed && rng.chance(U.web)) {
        this.plan = { kind: 'web', x: cellX, y: cellY, z: cellZ, ax: b.pos.x, ay: cellY, az: b.pos.z, timer: 0 };
        return this.runPlan(per, trueDist, input) === 'own';
      }
      if (level && trueDist > 2 && trueDist < 4.2 && this.closingSpeed(per) > 0.05 && !T.inWeb && blocks.get(tCell.x, tCell.y, tCell.z) === B.AIR) {
        const aim = this.webAim(tCell.x, tCell.y, tCell.z);
        if (aim && rng.chance(U.web)) {
          this.plan = { kind: 'web', ...tCell, ax: aim[0], ay: aim[1], az: aim[2], timer: 0 };
          return this.runPlan(per, trueDist, input) === 'own';
        }
        this.uhcCooldown = 30;
      }
    }
    return false;
  }

  /** One tick of the current plan: 'own' (it used the tick), 'fight' (let the fight run), 'done'. */
  private runPlan(per: Perceived, trueDist: number, input: MoveInput): 'own' | 'fight' | 'done' {
    const b = this.bot;
    const U = this.profile.uhc;
    const P = this.profile;
    const blocks = this.world.blocks;
    const plan = this.plan!;
    plan.timer++;
    const finish = (cooldown = 20): 'done' => {
      this.plan = null;
      this.uhcCooldown = Math.max(this.uhcCooldown, cooldown);
      this.settle = 0;
      if (b.mining) b.tickMining(false, false);
      return 'done';
    };
    switch (plan.kind) {
      case 'water':
      case 'lava': {
        this.uhcLabel = plan.kind === 'lava' ? 'Lava!' : 'Water';
        const full: ItemId = plan.kind === 'lava' ? 'lava_bucket' : 'water_bucket';
        const fluid = plan.kind === 'lava' ? B.LAVA : B.WATER;
        if (plan.phase === 'place') {
          if (plan.timer > 16 || !this.equip(full)) {
            if (plan.kind === 'water') this.selfHelpCooldown = 30;
            return finish(plan.kind === 'lava' ? 60 : 10);
          }
          if (b.usingItem) b.stopUsingItem();
          // The floor (or block top) under the cell: a bucket ray ignores players.
          this.aimPoint(plan.x + 0.5, plan.y + 0.001, plan.z + 0.5);
          const hit = b.crosshairBlock(C.BLOCK_REACH, false);
          const on =
            !!hit &&
            ((hit.x + hit.nx === plan.x && hit.y + hit.ny === plan.y && hit.z + hit.nz === plan.z) ||
              // Our own web: pouring into it works as well.
              (plan.kind === 'water' && hit.id === B.COBWEB && Math.abs(hit.x - plan.x) + Math.abs(hit.z - plan.z) === 0));
          if (on && this.settle >= U.aimSettle && b.startUsingItem(true)) {
            plan.phase = 'wait';
            plan.timer = 0;
          }
          return 'own';
        }
        if (plan.phase === 'wait') {
          const hold = plan.kind === 'lava' ? 30 : 6;
          if (plan.timer >= hold) {
            plan.phase = 'pickup';
            plan.timer = 0;
          }
          return plan.kind === 'lava' ? 'fight' : 'own';
        }
        // pickup
        if (plan.kind === 'lava' && !U.lavaPickup) return finish(60);
        const cx = plan.x + 0.5;
        const cz = plan.z + 0.5;
        const reachable = Math.hypot(cx - b.pos.x, plan.y + 0.5 - (b.pos.y + b.eyeHeight()), cz - b.pos.z) < C.BLOCK_REACH - 0.3;
        if (plan.timer > 25 || !blocks.isSource(plan.x, plan.y, plan.z) || blocks.get(plan.x, plan.y, plan.z) !== fluid || !reachable) {
          return finish(plan.kind === 'lava' ? 80 : 10);
        }
        if (!this.equip('bucket')) return finish(40);
        if (b.usingItem) b.stopUsingItem();
        this.aimPoint(cx, plan.y + 0.4, cz);
        const hit = b.crosshairBlock(C.BLOCK_REACH, false, 'source');
        if (hit && hit.x === plan.x && hit.y === plan.y && hit.z === plan.z && this.settle >= U.aimSettle && b.startUsingItem(true)) {
          return finish(plan.kind === 'lava' ? 80 : 10);
        }
        return 'own';
      }
      case 'web': {
        this.uhcLabel = 'Web';
        if (plan.timer > 12 || blocks.get(plan.x, plan.y, plan.z) !== B.AIR || !this.equip('cobweb')) return finish(50);
        if (b.usingItem) b.stopUsingItem();
        this.aimPoint(plan.ax, plan.ay + 0.001, plan.az);
        const hit = b.crosshairBlock(C.BLOCK_REACH, true);
        const on = !!hit && hit.x + hit.nx === plan.x && hit.y + hit.ny === plan.y && hit.z + hit.nz === plan.z;
        if (on && this.settle >= U.aimSettle && b.startUsingItem(true)) return finish(50);
        return 'own';
      }
      case 'mine': {
        this.uhcLabel = 'Mining';
        const id = blocks.get(plan.x, plan.y, plan.z);
        if (plan.timer > 90 || (id !== B.PLANKS && id !== B.COBWEB)) {
          if (plan.timer > 90) this.selfHelpCooldown = 40;
          return finish(5);
        }
        if (b.usingItem) b.stopUsingItem();
        this.equip(id === B.COBWEB ? 'diamond_sword' : b.slotOf('diamond_axe') >= 0 ? 'diamond_axe' : 'diamond_sword');
        this.aimPoint(plan.x + 0.5, plan.y + 0.5, plan.z + 0.5);
        const dist = Math.hypot(plan.x + 0.5 - b.pos.x, plan.z + 0.5 - b.pos.z);
        if (dist > 3.4) input.forward = 1;
        const hit = b.crosshairBlock(C.BLOCK_REACH, true);
        if (hit && hit.x === plan.x && hit.y === plan.y && hit.z === plan.z) {
          b.tickMining(true, !plan.started);
          plan.started = true;
        } else if (b.mining) b.tickMining(false, false);
        return 'own';
      }
      case 'pillar': {
        this.uhcLabel = plan.phase === 'build' ? 'Pillaring' : 'Eating';
        const top = plan.baseY + plan.height;
        if (plan.phase === 'build') {
          if (plan.timer > 80 || !this.equip('oak_planks')) return finish(60);
          if (b.usingItem) b.stopUsingItem();
          this.turnTo(b.yaw, -Math.PI / 2 + 0.01, 3);
          input.jump = true;
          if (!b.onGround && b.pos.y >= top + 1 && b.startUsingItem(true)) {
            plan.height++;
            if (plan.height >= 3) {
              plan.phase = 'eat';
              plan.timer = 0;
            }
          }
          return 'own';
        }
        // On top: stand still and eat until healthy, out of food, or knocked off.
        const fell = b.pos.y < top - 0.5;
        const food: ItemId | null = b.countItem('golden_head') > 0 && !b.cooldowns.has('golden_head') ? 'golden_head' : b.countItem('golden_apple') > 0 ? 'golden_apple' : null;
        if (fell || !food || b.effectiveHealth() >= P.returnHP || plan.timer > 260) {
          if (b.usingItem && fell) b.stopUsingItem();
          if (!b.usingItem) return finish(100);
        }
        if (!b.usingItem && food) {
          this.equip(food);
          b.startUsingItem();
        }
        this.aimAt(per.x, per.y + 1.2, per.z, 0.5);
        return 'own';
      }
      case 'head': {
        this.uhcLabel = 'Eating';
        if (plan.timer > 40 || b.countItem('golden_head') < plan.count || !this.equip('golden_head')) {
          if (b.usingItem && plan.timer > 40) b.stopUsingItem();
          return finish(10);
        }
        if (!b.usingItem) b.startUsingItem();
        this.backOff(per, trueDist, input);
        return 'own';
      }
    }
  }

  /** Turn toward a point quickly (placing and mining are deliberate flicks); counts settled ticks. */
  private aimPoint(x: number, y: number, z: number) {
    const b = this.bot;
    const dx = x - b.pos.x;
    const dy = y - (b.pos.y + b.eyeHeight());
    const dz = z - b.pos.z;
    const h = Math.hypot(dx, dz);
    const yaw = h > 1e-4 ? yawTowards(dx, dz) : b.yaw;
    const pitch = Math.atan2(dy, Math.max(h, 1e-4));
    this.turnTo(yaw, pitch, 2.5);
    const err = Math.abs(wrapAngle(b.yaw - yaw)) + Math.abs(b.pitch - Math.max(-1.55, Math.min(1.55, pitch)));
    this.settle = err < 3 * DEG ? this.settle + 1 : 0;
  }

  /** A floor point in the target's cell whose ray isn't blocked by their hitbox (webs need a clear face). */
  private webAim(x: number, y: number, z: number): [number, number, number] | null {
    const b = this.bot;
    const eye = b.eyePos();
    const box = this.target.aabb();
    for (const [u, v] of [
      [0.5, 0.5],
      [0.15, 0.15],
      [0.85, 0.15],
      [0.15, 0.85],
      [0.85, 0.85],
      [0.5, 0.12],
      [0.5, 0.88],
      [0.12, 0.5],
      [0.88, 0.5],
    ]) {
      const px = x + u;
      const pz = z + v;
      const dx = px - eye.x;
      const dy = y - eye.y;
      const dz = pz - eye.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > C.BLOCK_REACH) continue;
      const d = new V3(dx / len, dy / len, dz / len);
      const t = rayAABB(eye, d, box);
      if (t >= 0 && t < len) continue;
      return [px, y, pz];
    }
    return null;
  }

  private columnClear(x: number, y: number, z: number, h: number): boolean {
    for (let i = 0; i < h; i++) if (this.world.blocks.get(x, y + i, z) !== B.AIR && i > 0) return false;
    return y + h < this.world.blocks.height;
  }

  /** Never walk into lava (ours or theirs); step out if we are in it. */
  private avoidLava(input: MoveInput) {
    const b = this.bot;
    const blocks = this.world.blocks;
    if (!blocks.count) return;
    const y = Math.floor(b.pos.y + 0.01);
    if (b.inLava) {
      // Walk toward the nearest cell without lava.
      let best: [number, number] | null = null;
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [1, -1],
        [-1, 1],
        [-1, -1],
      ]) {
        const cx = Math.floor(b.pos.x) + dx;
        const cz = Math.floor(b.pos.z) + dz;
        if (blocks.get(cx, y, cz) === B.AIR && !isSolidBlock(blocks.get(cx, y, cz))) {
          best = [cx + 0.5, cz + 0.5];
          break;
        }
      }
      if (best) {
        b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yawTowards(best[0] - b.pos.x, best[1] - b.pos.z) - b.yaw), -0.8, 0.8));
        input.forward = 1;
        input.strafe = 0;
        input.jump = true;
      }
      return;
    }
    const s = Math.sin(b.yaw);
    const c = Math.cos(b.yaw);
    const mx = -s * input.forward + c * input.strafe;
    const mz = -c * input.forward - s * input.strafe;
    const len = Math.hypot(mx, mz);
    if (len < 1e-3) return;
    for (const k of [0.6, 1.2]) {
      const px = Math.floor(b.pos.x + (mx / len) * k);
      const pz = Math.floor(b.pos.z + (mz / len) * k);
      if (blocks.get(px, y, pz) === B.LAVA || blocks.get(px, y - 1, pz) === B.LAVA) {
        input.forward = input.forward > 0 ? 0 : input.forward;
        input.strafe = -input.strafe;
        input.sprint = false;
        input.jump = false;
        return;
      }
    }
  }

  private retreat(per: Perceived, trueDist: number, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    this.equip(this.weapon);
    if (b.usingItem) b.stopUsingItem();

    // Parting shot: land one more sprint hit to knock them away before turning around.
    // partingTicks is 0 for profiles that don't do this, and stateTimer is 0 on the first
    // retreat tick, so the window has to be checked explicitly.
    if (this.partingTicks > 0 && this.stateTimer <= this.partingTicks) {
      const p = b.attackStrengthScale(0.5);
      this.aimAt(per.x, per.y + 1.2, per.z);
      input.forward = 1;
      input.sprint = true;
      const reach = rayDistanceToTarget(b, this.target);
      if (reach >= 0 && reach <= P.maxReach && p > C.STRONG_ATTACK_SCALE) {
        this.doAttack();
        this.partingTicks = this.stateTimer;
      } else if (trueDist > 3.3 || p < 0.5) {
        this.partingTicks = this.stateTimer;
      }
      return;
    }

    if (P.fleeStyle === 'backpedal') {
      this.aimAt(per.x, per.y + 1.2, per.z, 0.7);
      input.forward = -1;
      input.strafe = this.strafeDir || 1;
      return;
    }
    const fy = this.fleeDirection(per);
    this.turnTo(fy, 0.1, 1.6);
    input.forward = 1;
    input.sprint = true;
    if (P.fleeStyle === 'sprintjump' && b.onGround && b.sprinting && Math.abs(wrapAngle(b.yaw - fy)) < 0.6) {
      input.jump = true;
    }
  }

  private eat(per: Perceived, trueDist: number, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    if (!this.equip('golden_apple')) return;
    if (!b.usingItem) b.startUsingItem();

    switch (P.eatMove) {
      case 'stand':
        this.aimAt(per.x, per.y + 1.2, per.z, 0.5);
        break;
      case 'walk': {
        const fy = this.fleeDirection(per);
        this.turnTo(fy, 0.1, 1.2);
        input.forward = trueDist < 9 ? 1 : 0;
        break;
      }
      case 'sprintjump': {
        const fy = this.fleeDirection(per);
        this.turnTo(fy, 0.1, 1.6);
        input.forward = 1;
        input.sprint = true;
        if (b.onGround && b.sprinting && trueDist < 11) input.jump = true;
        break;
      }
    }

    if (P.abortEatDistance > 0 && b.usingItem) {
      const progress = 1 - b.useItemRemaining / Math.max(1, b.useItemDuration);
      if (trueDist < P.abortEatDistance && progress < 0.5) {
        b.stopUsingItem();
        this.enter('engage');
        this.retreatCooldown = 50;
      }
    }
  }

  // ------------------------------------------------------------ helpers

  private equip(id: ItemId): boolean {
    const slot = this.bot.slotOf(id);
    if (slot < 0) {
      if (id === 'golden_apple') this.enter('engage');
      return false;
    }
    if (this.bot.selected !== slot) this.bot.selectSlot(slot);
    return true;
  }

  private fleeDirection(per: Perceived): number {
    const b = this.bot;
    let best = b.yaw;
    let bestScore = -Infinity;
    for (let k = 0; k < 16; k++) {
      const yaw = -Math.PI + (k * Math.PI) / 8;
      const px = b.pos.x - Math.sin(yaw) * 6;
      const pz = b.pos.z - Math.cos(yaw) * 6;
      const clear = this.world.wallDistance(px, pz);
      let score = Math.hypot(px - per.x, pz - per.z);
      if (clear < 3) score -= (3 - clear) * 3;
      if (this.fleeYaw !== null) score -= Math.abs(wrapAngle(yaw - this.fleeYaw)) * 0.8;
      if (score > bestScore) {
        bestScore = score;
        best = yaw;
      }
    }
    this.fleeYaw = best;
    return best;
  }

  private roomySide(): number {
    const b = this.bot;
    const rx = Math.cos(b.yaw);
    const rz = -Math.sin(b.yaw);
    const right = this.world.wallDistance(b.pos.x + rx * 2, b.pos.z + rz * 2);
    const left = this.world.wallDistance(b.pos.x - rx * 2, b.pos.z - rz * 2);
    return right >= left ? 1 : -1;
  }
}

/**
 * Pitch that lands an arrow `dh` blocks away and `dy` up, simulating AbstractArrow's own
 * integration (move, then ×0.99 drag and −0.05 gravity). Null if it cannot reach.
 */
export function ballistic(dh: number, dy: number, speed: number): { pitch: number; ticks: number } | null {
  const flight = (pitch: number) => {
    let x = 0;
    let y = 0;
    let vx = Math.cos(pitch) * speed;
    let vy = Math.sin(pitch) * speed;
    for (let t = 1; t <= 100; t++) {
      const nx = x + vx;
      const ny = y + vy;
      if (nx >= dh) {
        const f = (dh - x) / (nx - x);
        return { y: y + (ny - y) * f, ticks: t - 1 + f };
      }
      x = nx;
      y = ny;
      vx *= C.ARROW_DRAG;
      vy = vy * C.ARROW_DRAG - C.ARROW_GRAVITY;
    }
    return { y: -Infinity, ticks: 100 };
  };
  let lo = -0.8;
  let hi = 0.7;
  if (flight(hi).y < dy) return null;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (flight(mid).y < dy) lo = mid;
    else hi = mid;
  }
  const pitch = (lo + hi) / 2;
  return { pitch, ticks: flight(pitch).ticks };
}
