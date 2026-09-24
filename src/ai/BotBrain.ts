import * as C from '../core/constants';
import { DEG, clamp, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { rayDistanceToTarget, type AttackOutcome } from '../game/combat';
import type { Fighter, MoveInput } from '../game/Fighter';
import type { World } from '../game/World';
import type { BotProfile } from './difficulty';

export type BotState = 'engage' | 'retreat' | 'eat';

interface Seen {
  x: number;
  y: number;
  z: number;
  onGround: boolean;
  using: boolean;
}

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
    return this.profile.passive ? 'Passive' : 'Fighting';
  }

  tick() {
    const b = this.bot;
    const T = this.target;
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
    if (this.state === 'engage') this.engage(per, dist, justHurt, input);
    else if (this.state === 'retreat') this.retreat(per, trueDist, input);
    else this.eat(per, trueDist, input);
    b.input = input;
  }

  // ------------------------------------------------------------ perception & aim

  private remember() {
    const T = this.target;
    this.seen.push({ x: T.pos.x, y: T.pos.y, z: T.pos.z, onGround: T.onGround, using: T.usingItem });
    if (this.seen.length > 48) this.seen.shift();
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

  private engage(per: Perceived, dist: number, justHurt: boolean, input: MoveInput) {
    const b = this.bot;
    const T = this.target;
    const P = this.profile;
    const rng = this.rng;
    this.equip('diamond_sword');
    if (b.usingItem) b.stopUsingItem();

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
    if (this.profile.passive) {
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

  private equip(id: 'diamond_sword' | 'golden_apple'): boolean {
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
