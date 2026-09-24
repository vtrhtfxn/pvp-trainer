import * as C from '../core/constants';
import { DEG, clamp, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { rayDistanceToTarget, shieldFaces, type AttackOutcome } from '../game/combat';
import type { Fighter, MoveInput } from '../game/Fighter';
import { ITEMS, type ItemId } from '../game/items';
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
    const lead = P.reactionTicks * P.predict;
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
    this.turnTo(wantYaw + this.errYaw, wantPitch + this.errPitch, gain);
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
      this.equip('diamond_sword');
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

  private retreat(per: Perceived, trueDist: number, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    this.equip('diamond_sword');
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
