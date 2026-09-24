import * as C from '../core/constants';
import { DEG, clamp, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { rayDistanceToTarget, shieldFaces, type AttackOutcome } from '../game/combat';
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
    this.inv = null;
    this.throwing = null;
    this.throwGap = 0;
    this.potCooldown = 0;
    this.hadTotem = b.offhand?.id === 'totem_of_undying';
    this.totemReact = -1;
    this.eating = false;
    this.gapCooldown = 0;
    this.potLabel = '';
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
    this.updateState(trueDist);
    if (this.state === 'engage' && this.shieldKit) this.engageShield(per, dist, justHurt, input);
    else if (this.state === 'engage') this.engage(per, dist, justHurt, input);
    else if (this.state === 'retreat') this.retreat(per, trueDist, input);
    else this.eat(per, trueDist, input);
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
      const chance = targetEating && P.punishEating ? Math.max(P.critChance, 0.7) : P.critChance;
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
    const abortAt = this.ranged === 'fireCrossbow' ? 4 : 6.5;
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

    // ---- 4. Golden apple for absorption while they are away.
    if (!this.eating && this.potCooldown === 0 && this.gapCooldown === 0 && !b.effects.has('absorption') && b.countItem('golden_apple') > 0 && trueDist > N.gapDist && !P.passive) {
      this.eating = true;
    }
    if (this.eating) {
      this.potLabel = 'Eating';
      if (!this.equip('golden_apple')) {
        this.eating = false;
      } else {
        if (!b.usingItem) b.startUsingItem();
        this.backOff(per, dist, input);
        const progress = b.usingItem ? 1 - b.useItemRemaining / Math.max(1, b.useItemDuration) : 0;
        // Too close to finish it: bin the apple and fight.
        if ((trueDist < 3 && progress < 0.6) || b.effects.has('absorption')) {
          if (b.usingItem && !b.effects.has('absorption')) b.stopUsingItem();
          this.eating = false;
          this.gapCooldown = 60;
        }
        return;
      }
    }

    // ---- 5. Fight. A hit on us is a P-crit chance: no sprint, hop, crit on the way down.
    if (justHurt && !P.passive && rng.chance(N.pcrit)) {
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
    const low = (id: 'strength' | 'speed' | 'fire_resistance') => (b.effects.get(id)?.duration ?? 0) < 60;
    if (b.health <= N.potHP && has('healing')) return { what: 'healing', left: b.health <= N.potHP - 5 ? 2 : 1 };
    const opening = this.ticks < 80;
    const buffOk = (opening || N.rebuff) && trueDist > 3.6;
    const theirSword = T.heldStack();
    const burns = (theirSword?.ench?.fireAspect ?? 0) > 0 || b.onFire;
    if (buffOk && burns && low('fire_resistance') && has('fire_resistance')) return { what: 'fire_resistance', left: 1 };
    if (buffOk && !this.profile.passive && low('strength') && has('strength')) return { what: 'strength', left: 1 };
    if (buffOk && low('speed') && has('swiftness')) return { what: 'swiftness', left: 1 };
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
    this.backOff(per, dist, input);
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
