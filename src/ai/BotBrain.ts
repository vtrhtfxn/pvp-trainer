import * as C from '../core/constants';
import { DEG, V3, clamp, rayAABB, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { rayDistanceToTarget, shieldFaces, type AttackOutcome } from '../game/combat';
import { B, isSolid as isSolidBlock, type RayHit } from '../game/Blocks';
import { SLOT_ARMOR, SLOT_OFFHAND, type Fighter, type MoveInput } from '../game/Fighter';
import { ITEMS, durabilityFraction, type ItemId, type PotionId } from '../game/items';
import type { World } from '../game/World';
import type { EndCrystal } from '../game/EndCrystal';
import { explosionDamageTo } from '../game/Explosion';
import { ANCHOR_POWER, CRYSTAL_POWER, attackCrystal, canPlaceCrystal, crosshairCrystal } from '../game/crystals';
import { Blocks } from '../game/Blocks';
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
  | { kind: 'pillar'; baseY: number; height: number; timer: number; phase: 'build' | 'eat'; x: number; z: number }
  | { kind: 'head'; timer: number; count: number };

/**
 * A Crystal-kit combo, one click per phase. (x, y, z) is the obsidian or anchor cell; (sx, sy,
 * sz) + (nx, ny, nz) the block face clicked to place it.
 */
type CrystalPlan =
  | {
      kind: 'crystal' | 'anchor';
      /** 'dig': mine the ground first so the obsidian (and the crystal) sit a block lower. */
      phase: 'dig' | 'place' | 'crystal' | 'charge' | 'blow';
      started?: boolean;
      x: number;
      y: number;
      z: number;
      sx: number;
      sy: number;
      sz: number;
      nx: number;
      ny: number;
      nz: number;
      crystal: EndCrystal | null;
      timer: number;
      wait: number;
    }
  | { kind: 'hit'; crystal: EndCrystal; timer: number; wait: number }
  /** Mine a block of their surround open with the pickaxe. */
  | { kind: 'mine'; x: number; y: number; z: number; timer: number; started: boolean; wait: number }
  /** Wall ourselves in: step to the middle of the block, then a block on each side. */
  | { kind: 'surround'; phase: 'center' | 'place'; timer: number; wait: number }
  | { kind: 'pearl'; yaw: number; pitch: number; timer: number };

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
/** Hotbar items that can go back to the inventory to make room (they get restocked). */
const SPARE_ITEMS: ItemId[] = ['experience_bottle', 'splash_potion', 'netherite_pickaxe', 'diamond_pickaxe', 'ender_chest', 'bow'];

/** Blocks the bot will mine out of its way: planks (axe), webs (sword), lava/water rock (pickaxe). */
const MINEABLE = new Set<number>([B.PLANKS, B.COBWEB, B.COBBLESTONE, B.STONE, B.OBSIDIAN, B.ENDER_CHEST, B.RESPAWN_ANCHOR]);
const FACES: [number, number, number][] = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
];

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

  // ---- SMP
  /** Shield game plus splash buffs, gapples, pearls, one totem and a knockback sword. */
  private smpKit = false;
  /** The axe in the kit (diamond or netherite). */
  private axe: ItemId = 'diamond_axe';
  /** Ticks left before it reacts to wanting the totem (or the shield) in the off hand. */
  private offhandReact = -1;
  /** Ticks before it will pearl again (pearling back and forth wastes them). */
  private pearlCooldown = 0;
  private pearledThisRetreat = false;

  // ---- Crystal
  private crystalKit = false;
  private cplan: CrystalPlan | null = null;
  private crystalCooldown = 0;
  private thinkTimer = 0;
  private surroundCooldown = 0;

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
    return this.bot.hasShield() || this.bot.slotOf('diamond_axe') >= 0 || this.bot.slotOf('netherite_axe') >= 0;
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
    this.crystalKit = b.countItem('end_crystal') > 0;
    this.smpKit = !this.crystalKit && b.hasShield() && b.countItem('splash_potion') > 0;
    this.axe = b.countItem('netherite_axe') > 0 ? 'netherite_axe' : 'diamond_axe';
    this.offhandReact = -1;
    this.pearlCooldown = 0;
    this.pearledThisRetreat = false;
    this.cplan = null;
    this.crystalCooldown = 0;
    this.thinkTimer = 0;
    this.surroundCooldown = 0;
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

    this.potLabel = '';
    if (this.inv) {
      this.invStep();
      b.input = input;
      return;
    }
    if (this.crystalKit) {
      this.potLabel = '';
      this.crystalStep(per, dist, trueDist, justHurt, input);
      this.avoidLava(input);
      b.input = input;
      return;
    }
    if (this.smpKit) {
      this.smpStep(per, dist, trueDist, justHurt, input);
      b.input = input;
      return;
    }
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
    if (this.swapBackTimer === 0 && this.axeWait < 0 && held !== this.weapon) this.equip(this.weapon);

    const seen = this.seenLate(A.shieldReact);
    const targetDown = this.targetShieldDownUntil > this.ticks;
    const facingUs = shieldFaces(T, b.pos.x, b.pos.z);
    const reach = rayDistanceToTarget(b, T);
    const inReach = reach >= 0 && reach <= P.maxReach;

    // ---- 1. Their shield is up and facing us: the axe disables it for 5 seconds.
    const wantsBreak = !P.passive && seen.shield && facingUs && !targetDown && b.slotOf(this.axe) >= 0;
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
        this.equip(this.axe);
        this.afterAxeSwing(this.doAttack());
        this.swapBackTimer = 1;
        this.axeWait = -1;
        this.axeCommit = 0;
        return;
      }
      if (b.heldStack()?.id !== this.axe) {
        this.equip(this.axe);
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
    const axeRead = !!theirHeld && !!ITEMS[theirHeld].disablesShield && this.readAxeRoll;
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
        else if (b.useTicks() >= b.crossbowChargeTicks(b.heldStack()) + 1) {
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

    if (this.invStep()) return;
    if (this.retotemStep(per, dist, input)) return;

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
    if (this.eating && this.eatId && this.eatingStep(per, dist, trueDist, input)) return;

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

  /** An open inventory: no movement, no clicks, just the moves. True while it owns the tick. */
  private invStep(): boolean {
    const b = this.bot;
    if (!this.inv) return false;
    this.potLabel = 'Inventory';
    if (b.usingItem) b.stopUsingItem();
    if (--this.inv.timer <= 0) {
      const mv = this.inv.moves.shift();
      if (mv) b.swapSlots(mv[0], mv[1]);
      if (this.inv.moves.length) this.inv.timer = 2;
      else this.inv = null;
    }
    return true;
  }

  /** Puts a new totem in the off hand after one pops: hotbar key + F, or through the inventory. */
  private retotemStep(per: Perceived, dist: number, input: MoveInput): boolean {
    const b = this.bot;
    const N = this.profile.neth;
    const hasTotem = b.offhand?.id === 'totem_of_undying';
    if (this.hadTotem && !hasTotem) this.totemReact = N.totemReact;
    this.hadTotem = hasTotem;
    if (hasTotem || b.countItem('totem_of_undying') === 0 || this.totemReact < 0) return false;
    if (this.totemReact > 0) {
      this.totemReact--;
      return false;
    }
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
      return true;
    }
    const is = b.invSlotOf('totem_of_undying');
    if (is >= 0) {
      this.openInv([[is, SLOT_OFFHAND]]);
      this.totemReact = -1;
      return true;
    }
    return false;
  }

  /** Keeps eating `eatId` while backing off. True while it owns the tick. */
  private eatingStep(per: Perceived, dist: number, trueDist: number, input: MoveInput): boolean {
    const b = this.bot;
    const id = this.eatId!;
    this.potLabel = 'Eating';
    // Food in the off hand (steak) is eaten behind the sword: right click falls through to it.
    const inOff = b.offhand?.id === id;
    const ready = inOff ? this.equip(this.weapon) : this.equip(id);
    const left = b.countItem(id);
    if (!ready || left === 0 || left < this.eatStartCount) {
      // Out of food, or the one we started on is finished.
      this.eating = false;
      this.gapCooldown = 20;
      return false;
    }
    // A fresh press: the 4-tick delay after placing a block doesn't apply to it.
    if (!b.usingItem && !b.startUsingItem(true)) {
      this.eating = false;
      this.gapCooldown = 20;
      return true;
    }
    if (this.comboStyle) this.runOff(per, input);
    else this.backOff(per, dist, input);
    const progress = b.usingItem ? 1 - b.useItemRemaining / Math.max(1, b.useItemDuration) : 0;
    // Too close to finish it: stop eating and fight (unless it is an emergency).
    if (trueDist < 3 && progress < 0.6 && !(this.crystalKit && b.health <= 8)) {
      b.stopUsingItem();
      this.eating = false;
      this.gapCooldown = 60;
    }
    return true;
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
  private throwStep(per: Perceived, dist: number, input: MoveInput): boolean {
    const b = this.bot;
    const t = this.throwing!;
    const N = this.profile.neth;
    const id: ItemId = t.what === 'xp' ? 'experience_bottle' : 'splash_potion';
    const potion = t.what === 'xp' ? undefined : t.what;
    this.potLabel = t.what === 'xp' ? 'Mending' : t.what === 'healing' ? 'Potting' : 'Buffing';
    // Mending stops once they come back.
    if (t.what === 'xp' && Math.hypot(this.target.pos.x - b.pos.x, this.target.pos.z - b.pos.z) < 3.5) {
      this.throwing = null;
      return false;
    }
    let slot = b.slotOf(id, potion);
    if (slot < 0) {
      const from = b.invSlotOf(id, potion);
      const to = this.freeHotbarSlot();
      if (from < 0 || to < 0) {
        // No room in the hotbar right now: try again later instead of every tick.
        this.throwing = null;
        this.potCooldown = 40;
        return false;
      }
      // Out of healing in the hotbar: shift-click a row of pots in while the inventory is open.
      const moves: [number, number][] = [[from, to]];
      if (t.what === 'healing') for (const mv of this.restockMoves(2, from, to)) moves.push(mv);
      this.openInv(moves);
      return true;
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
    if (b.pitch > -Math.PI / 2 + this.throwAim + 0.35 || this.throwGap > 0) return true;
    if (t.what === 'xp') {
      if (!b.startUsingItem()) return true; // held button: one bottle every 4 ticks
    } else if (!b.startUsingItem(true)) return true;
    this.throwAim = 0;
    this.throwGap = t.what === 'xp' ? 0 : N.potGap;
    if (--t.left <= 0) {
      this.throwing = null;
      // Give the potion time to land (about 3 ticks) before judging what we need again.
      this.potCooldown = t.what === 'xp' ? 2 : 6;
    }
    return true;
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
    // The Crystal hotbar is full: a utility slot takes turns.
    if (this.crystalKit) return this.spareHotbarSlot();
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

  // ------------------------------------------------------------ SMP

  /** Hotbar slot of a sword with Knockback (the SMP kit's second sword), or -1. */
  private kbSwordSlot(): number {
    const b = this.bot;
    for (let i = 0; i < 9; i++) {
      const s = b.inventory[i];
      if (s && ITEMS[s.id].tool === 'sword' && (s.ench?.knockback ?? 0) > 0) return i;
    }
    return -1;
  }

  /**
   * The SMP game: the Axe-kit shield game (with the netherite axe) on top of NethPot-style
   * buffs and mending, gapple retreats, pearls, and one totem that only saves you from the off
   * hand — so it goes there, instead of the shield, when things get dangerous.
   */
  private smpStep(per: Perceived, dist: number, trueDist: number, justHurt: boolean, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    const K = P.crystal;
    if (this.potCooldown > 0) this.potCooldown--;
    if (this.throwGap > 0) this.throwGap--;
    if (this.crystalCooldown > 0) this.crystalCooldown--;

    // ---- Off hand: totem when low and they are close; the shield back once safe (or popped).
    if (this.offhandStep(dist, input)) return;

    // ---- A pearl in flight (in from far away, or out to eat).
    if (this.cplan && this.runCrystal(per, dist, input)) return;
    if (this.pearlCooldown > 0) this.pearlCooldown--;
    if (this.state !== 'retreat') this.pearledThisRetreat = false;
    if (!P.passive && K.pearls > 0 && this.pearlCooldown === 0 && b.countItem('ender_pearl') > 0 && !b.cooldowns.has('ender_pearl') && !b.usingItem) {
      // In: they ran far and aren't coming back.
      if (trueDist > 16 && b.onGround && this.state === 'engage' && this.closingSpeed(per) < 0.05) {
        const shot = ballistic(trueDist, this.target.pos.y - (b.pos.y + b.eyeHeight() - 0.1), C.PEARL_THROW_SPEED, C.PEARL_GRAVITY);
        if (shot) this.cplan = { kind: 'pearl', yaw: yawTowards(this.target.pos.x - b.pos.x, this.target.pos.z - b.pos.z), pitch: shot.pitch, timer: 0 };
      } else if (K.pearls >= 2 && this.state === 'retreat' && !this.pearledThisRetreat && trueDist < 4 && this.stateTimer > this.partingTicks + 10) {
        // Still chased while trying to get away to eat: pearl out, once.
        this.cplan = { kind: 'pearl', yaw: this.fleeDirection(per), pitch: 0.4, timer: 0 };
        this.pearledThisRetreat = true;
      }
      if (this.cplan) {
        this.pearlCooldown = 200;
        this.settle = 0;
        if (this.runCrystal(per, dist, input)) return;
      }
    }

    // ---- Buffs (Fire Resistance whenever their Fire Aspect has us burning) and mending.
    if (!this.throwing && this.potCooldown === 0 && this.state !== 'eat' && !b.usingItem) this.throwing = this.pickThrow(trueDist);
    if (this.throwing && this.throwStep(per, dist, input)) return;

    // ---- Restock the hotbar in a quiet moment.
    if (trueDist > 5 && this.state !== 'eat' && !b.usingItem) {
      const moves = this.smpRestockMoves();
      if (moves.length) {
        this.openInv(moves);
        return;
      }
    }

    // ---- The shield game, with gapple retreats.
    this.updateState(trueDist);
    if (this.state === 'engage') this.engageShield(per, dist, justHurt, input);
    else if (this.state === 'retreat') this.retreat(per, trueDist, input);
    else this.eat(per, trueDist, input);
  }

  /** True while it is swapping hands (two keys over two ticks: the slot, then F). */
  private offhandStep(dist: number, input: MoveInput): boolean {
    const b = this.bot;
    const P = this.profile;
    const off = b.offhand?.id ?? null;
    const eff = b.effectiveHealth();
    let want: ItemId | null = null;
    if (off !== 'totem_of_undying' && b.slotOf('totem_of_undying') >= 0 && eff <= 7 && dist < 7) want = 'totem_of_undying';
    else if (off !== 'shield' && b.slotOf('shield') >= 0 && (off === null || (eff >= P.returnHP && dist > 3.5))) want = 'shield';
    if (!want || P.passive) {
      this.offhandReact = -1;
      return false;
    }
    if (this.offhandReact < 0) this.offhandReact = P.neth.totemReact;
    if (this.offhandReact > 0) {
      this.offhandReact--;
      return false;
    }
    this.potLabel = want === 'shield' ? 'Shield back' : 'Totem';
    if (b.usingItem) b.stopUsingItem();
    const slot = b.slotOf(want);
    if (b.selected !== slot) b.selectSlot(slot);
    else {
      b.swapHands();
      this.offhandReact = -1;
    }
    input.forward = dist < 4 ? -1 : 0;
    return true;
  }

  /** Buff potions, gapples and pearls back into empty hotbar slots. */
  private smpRestockMoves(): [number, number][] {
    const b = this.bot;
    const moves: [number, number][] = [];
    const empty: number[] = [];
    for (let i = 0; i < 9; i++) if (!b.inventory[i]) empty.push(i);
    const taken = new Set<number>();
    const want = (id: ItemId, potion?: PotionId) => {
      if (!empty.length || b.slotOf(id, potion) >= 0) return;
      for (let i = 9; i < SLOT_ARMOR; i++) {
        const st = b.inventory[i];
        if (!taken.has(i) && st?.id === id && (potion === undefined || st.potion === potion)) {
          taken.add(i);
          moves.push([i, empty.shift()!]);
          return;
        }
      }
    };
    want('splash_potion', 'strength');
    want('splash_potion', 'swiftness');
    want('splash_potion', 'fire_resistance');
    want('golden_apple');
    want('ender_pearl');
    return moves;
  }

  // ------------------------------------------------------------ Crystal

  /**
   * The Crystal game. Priorities: inventory and re-totem; a combo in progress; pearl in from
   * far away (or out when it is about to die); buffs and mending; restock; golden apples; a new
   * crystal or anchor combo at the spot that hurts them most for what it costs us; otherwise the
   * sword.
   */
  private crystalStep(per: Perceived, dist: number, trueDist: number, justHurt: boolean, input: MoveInput) {
    const b = this.bot;
    const T = this.target;
    const P = this.profile;
    const K = P.crystal;
    if (this.crystalCooldown > 0) this.crystalCooldown--;
    if (this.potCooldown > 0) this.potCooldown--;
    if (this.throwGap > 0) this.throwGap--;
    if (this.gapCooldown > 0) this.gapCooldown--;

    if (this.invStep()) return;
    if (this.retotemStep(per, dist, input)) {
      this.cplan = null;
      return;
    }
    if (this.cplan && this.runCrystal(per, dist, input)) return;

    // Pearls: in when they are far away, out when the next hit would kill us.
    if (!P.passive && K.pearls > 0 && b.countItem('ender_pearl') > 0 && !b.cooldowns.has('ender_pearl') && !this.eating) {
      const totems = b.countItem('totem_of_undying'); // off hand included
      if (trueDist > 14 && b.onGround) {
        const dh = trueDist;
        const shot = ballistic(dh, T.pos.y - (b.pos.y + b.eyeHeight() - 0.1), C.PEARL_THROW_SPEED, C.PEARL_GRAVITY);
        if (shot) {
          this.cplan = { kind: 'pearl', yaw: yawTowards(T.pos.x - b.pos.x, T.pos.z - b.pos.z), pitch: shot.pitch, timer: 0 };
          this.settle = 0;
          if (this.runCrystal(per, dist, input)) return;
        }
      } else if (K.pearls >= 2 && totems === 0 && b.effectiveHealth() < 7 && trueDist < 6) {
        this.cplan = { kind: 'pearl', yaw: this.fleeDirection(per), pitch: 0.45, timer: 0 };
        this.settle = 0;
        if (this.runCrystal(per, dist, input)) return;
      }
    }

    // Buffs at the start (and again when they run out), mending when there is a gap.
    if (!this.throwing && !this.eating && this.potCooldown === 0 && this.ranged === 'none') this.throwing = this.pickThrow(trueDist);
    if (this.throwing && this.throwStep(per, dist, input)) return;

    // Restock the hotbar: a spare totem, whatever ran out or got swapped out.
    if (trueDist > 4.5 && !this.eating && !per.using && this.ranged === 'none') {
      const moves = this.crystalRestockMoves();
      if (moves.length) {
        this.openInv(moves);
        return;
      }
    }

    // Low with them close: wall in before eating (HT3+).
    const low = b.health <= 10 && !b.effects.has('regeneration');
    if (this.surroundCooldown > 0) this.surroundCooldown--;
    if (K.surround && !P.passive && low && this.surroundCooldown === 0 && trueDist < 7 && b.onGround && !this.eating && !this.isSurrounded(b) && b.countItem('ender_chest') + b.countItem('obsidian') >= 4) {
      this.cplan = { kind: 'surround', phase: 'center', timer: 0, wait: 0 };
      this.surroundCooldown = 200;
      this.settle = 0;
      if (this.runCrystal(per, dist, input)) return;
    }
    // Healing inside our surround: stay in it until healthy.
    const stayIn = K.surround && this.isSurrounded(b) && b.effectiveHealth() < P.returnHP;

    // Golden apples: keep absorption up when there is a gap, and always when low.
    if (!this.eating && this.gapCooldown === 0 && !P.passive && b.countItem('golden_apple') > 0) {
      if (low || (!b.effects.has('absorption') && trueDist > 4.5)) {
        this.eating = true;
        this.eatId = 'golden_apple';
        this.eatStartCount = b.countItem('golden_apple');
      }
    }
    if (this.eating && this.eatId && this.eatingStep(per, dist, trueDist, input)) {
      if (stayIn) input.forward = input.strafe = 0;
      return;
    }

    // Out of crystal range: the crossbow (Quick Charge III, Multishot, Slow Falling arrows).
    if (this.rangedCooldown > 0) this.rangedCooldown--;
    if (K.crossbow && !P.passive && (this.ranged !== 'none' || this.crystalWantsCrossbow(dist))) {
      if (this.rangedStep(per, dist, input)) {
        input.forward = dist > 9 ? 1 : 0; // close in while loading
        return;
      }
    }

    // Their surround: mine it open with the pickaxe (HT3+).
    if (K.mine && !P.passive && this.crystalCooldown === 0 && trueDist < 4.6 && this.isSurrounded(T)) {
      const tx = Math.floor(T.pos.x);
      const ty = Math.floor(T.pos.y + 0.01);
      const tz = Math.floor(T.pos.z);
      const eye = b.eyePos();
      let best: [number, number, number] | null = null;
      let bestD = Infinity;
      for (const [x, y, z] of this.sides(tx, ty, tz)) {
        const d = Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z);
        if (d < bestD && d < C.BLOCK_REACH && this.anyFacePoint(x, y, z)) {
          bestD = d;
          best = [x, y, z];
        }
      }
      if (best) {
        this.cplan = { kind: 'mine', x: best[0], y: best[1], z: best[2], timer: 0, started: false, wait: 0 };
        this.settle = 0;
        if (this.runCrystal(per, dist, input)) return;
      }
    }

    // A new combo.
    if (!P.passive && this.crystalCooldown === 0 && --this.thinkTimer <= 0) {
      this.thinkTimer = K.thinkTicks;
      const plan = this.pickCrystalPlan(per);
      if (plan) {
        this.cplan = plan;
        this.settle = 0;
        if (this.runCrystal(per, dist, input)) return;
      }
    }

    // Nothing worth blowing up: the sword.
    this.engage(per, dist, justHurt, input);
    if (stayIn) {
      input.forward = input.strafe = 0;
      input.jump = false;
    } else if (b.horizontalCollision && b.onGround) input.jump = true; // out of craters (and surrounds)
  }

  /** A loaded crossbow and them out of crystal range, or time to load it while they are far. */
  private crystalWantsCrossbow(dist: number): boolean {
    const b = this.bot;
    if (this.rangedCooldown > 0 || b.countItem('crossbow') === 0) return false;
    if (b.slotOf('crossbow') < 0) return false; // it comes back with the next restock
    const charged = !!b.inventory[b.slotOf('crossbow')]?.charged;
    if (charged) return dist > 6 && dist < 26;
    return dist > 8 && dist < 26 && b.hasAmmo();
  }

  /** The four cells beside a floor cell, at foot level. */
  private sides(x: number, y: number, z: number): [number, number, number][] {
    return [
      [x + 1, y, z],
      [x - 1, y, z],
      [x, y, z + 1],
      [x, y, z - 1],
    ];
  }

  /** Walled in on all four sides at foot level (by placed blocks — the floor itself doesn't count). */
  private isSurrounded(f: Fighter): boolean {
    const blocks = this.world.blocks;
    const y = Math.floor(f.pos.y + 0.01);
    return this.sides(Math.floor(f.pos.x), y, Math.floor(f.pos.z)).every(([x, yy, z]) => {
      const id = blocks.get(x, yy, z);
      return isSolidBlock(id) && id !== B.BEDROCK;
    });
  }

  /**
   * Surround: step into the middle of the block (sneaking, so it doesn't overshoot), then put an
   * ender chest (crystals can't go on those; obsidian when they run out) on each side. Crystals
   * at their feet can't reach ours any more.
   */
  private runSurround(plan: CrystalPlan & { kind: 'surround' }, input: MoveInput, end: (ok: boolean) => false): boolean {
    const b = this.bot;
    const K = this.profile.crystal;
    const blocks = this.world.blocks;
    this.potLabel = 'Surround';
    const cx = Math.floor(b.pos.x);
    const cy = Math.floor(b.pos.y + 0.01);
    const cz = Math.floor(b.pos.z);
    if (plan.timer > 70 || !b.onGround) return end(false);
    if (plan.phase === 'center') {
      const dx = cx + 0.5 - b.pos.x;
      const dz = cz + 0.5 - b.pos.z;
      if ((Math.abs(dx) < 0.15 && Math.abs(dz) < 0.15) || plan.timer > 16) {
        plan.phase = 'place';
        plan.timer = 0;
        return true;
      }
      // Walk to the middle facing it, sneaking so we don't overshoot.
      const yaw = yawTowards(dx, dz);
      b.yaw = wrapAngle(b.yaw + clamp(wrapAngle(yaw - b.yaw), -0.8, 0.8));
      input.forward = Math.abs(wrapAngle(yaw - b.yaw)) < 0.5 ? 1 : 0;
      input.sneak = true;
      return true;
    }
    if (plan.wait > 0) plan.wait--;
    const todo = this.sides(cx, cy, cz).filter(([x, y, z]) => blocks.get(x, y, z) === B.AIR && !this.cellHasFighter(x, y, z));
    if (!todo.length) return end(true);
    if (b.countItem('ender_chest') > 0) {
      const r = this.fetch('ender_chest');
      if (r === 'fetching') return true;
      if (r === 'none' && !this.equip('obsidian')) return end(false);
    } else if (!this.equip('obsidian')) return end(false);
    for (const [x, y, z] of todo) {
      const face = this.supportFace(x, y, z);
      if (!face) continue;
      const [sx, sy, sz, nx, ny, nz] = face;
      const p = this.facePoint(sx, sy, sz, nx, ny, nz)!;
      this.aimPoint(p[0], p[1], p[2]);
      if (plan.wait > 0 || this.settle < K.aimSettle) return true;
      const hit = b.crosshairBlock(C.BLOCK_REACH, true);
      if (hit && hit.x === sx && hit.y === sy && hit.z === sz && hit.nx === nx && hit.ny === ny && hit.nz === nz && b.startUsingItem(true)) {
        plan.wait = K.clickGap;
        this.settle = 0;
      }
      return true;
    }
    return end(false);
  }

  /**
   * Crystal restock: the totem, anything that ran out, and whatever a utility swap pushed out of
   * the hotbar (it goes back where the XP, potion, pickaxe or ender chest is).
   */
  private crystalRestockMoves(): [number, number][] {
    const b = this.bot;
    const moves = this.restockMoves(0);
    const taken = new Set(moves.map((m) => m[1]));
    const essentials: ItemId[] = [this.weapon, 'end_crystal', 'obsidian', 'golden_apple', 'totem_of_undying', 'ender_pearl'];
    const K = this.profile.crystal;
    if (K.anchors) essentials.push('respawn_anchor', 'glowstone');
    if (K.crossbow) essentials.push('crossbow');
    for (const id of essentials) {
      const from = b.invSlotOf(id);
      if (b.slotOf(id) >= 0 || from < 0 || moves.some((m) => m[0] === from)) continue;
      let to = -1;
      for (let i = 0; i < 9 && to < 0; i++) if (!taken.has(i) && !b.inventory[i]) to = i;
      for (const u of SPARE_ITEMS) {
        if (to >= 0) break;
        const i = b.slotOf(u);
        if (i >= 0 && !taken.has(i)) to = i;
      }
      if (to < 0) break;
      taken.add(to);
      moves.push([from, to]);
    }
    return moves;
  }

  /** Damage (after armor) to them and to us from a blast, and how good a trade that is. */
  private blastScore(cx: number, cy: number, cz: number, power: number, per: Perceived): number | null {
    const b = this.bot;
    const T = this.target;
    const K = this.profile.crystal;
    const theirs = explosionDamageTo(this.world, T, cx, cy, cz, power, per.x, per.y, per.z);
    if (theirs < K.minDamage) return null;
    const ours = explosionDamageTo(this.world, b, cx, cy, cz, power, b.pos.x, b.pos.y, b.pos.z);
    const ourHp = b.effectiveHealth();
    const ourTotem = b.offhand?.id === 'totem_of_undying';
    if (ours >= ourHp - 0.5 && !ourTotem) return null;
    let score = theirs - K.selfWeight * ours;
    const theirTotem = T.offhand?.id === 'totem_of_undying' || T.heldStack()?.id === 'totem_of_undying';
    if (theirs >= T.effectiveHealth()) score += theirTotem ? 4 : 50;
    if (ours >= ourHp) score -= 20 * K.selfWeight;
    return score;
  }

  /**
   * A point on block face (sx, sy, sz)+(nx, ny, nz) that our crosshair can reach and click
   * (nothing in front of it, not hidden by the opponent), or null.
   */
  private facePoint(sx: number, sy: number, sz: number, nx: number, ny: number, nz: number): [number, number, number] | null {
    const b = this.bot;
    const eye = b.eyePos();
    const cx = sx + 0.5 + nx * 0.5;
    const cy = sy + 0.5 + ny * 0.5;
    const cz = sz + 0.5 + nz * 0.5;
    if ((eye.x - cx) * nx + (eye.y - cy) * ny + (eye.z - cz) * nz <= 0.01) return null; // facing away
    const box = this.target.aabb();
    // Two axes along the face.
    const ux = nx === 0 ? 1 : 0;
    const uz = nx === 0 ? 0 : 1;
    const vx = 0;
    const vy = ny === 0 ? 1 : 0;
    const vz = ny === 0 ? 0 : nx === 0 ? 1 : 0;
    for (const [u, v] of [
      [0, 0],
      [0.3, 0.3],
      [-0.3, 0.3],
      [0.3, -0.3],
      [-0.3, -0.3],
    ]) {
      const px = cx + ux * u + vx * v;
      const py = cy + vy * v;
      const pz = cz + uz * u + vz * v;
      const dx = px - eye.x;
      const dy = py - eye.y;
      const dz = pz - eye.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > C.BLOCK_REACH - 0.05) continue;
      const hit = this.world.blocks.raycast(eye.x, eye.y, eye.z, dx / len, dy / len, dz / len, len + 0.05, 'outline', uhcRay);
      if (!hit || hit.x !== sx || hit.y !== sy || hit.z !== sz || hit.nx !== nx || hit.ny !== ny || hit.nz !== nz) continue;
      const t = rayAABB(eye, new V3(dx / len, dy / len, dz / len), box);
      if (t >= 0 && t <= C.ATTACK_REACH && t < hit.t) continue;
      return [px, py, pz];
    }
    return null;
  }

  /** A visible face of solid block (sx, sy, sz) — for crystals on obsidian and anchor clicks. */
  private anyFacePoint(x: number, y: number, z: number): [number, number, number] | null {
    for (const [nx, ny, nz] of FACES) {
      if (isSolidBlock(this.world.blocks.get(x + nx, y + ny, z + nz))) continue;
      const p = this.facePoint(x, y, z, nx, ny, nz);
      if (p) return p;
    }
    return null;
  }

  /** A support face we can click to put a block into (x, y, z), or null. */
  private supportFace(x: number, y: number, z: number): [number, number, number, number, number, number] | null {
    const blocks = this.world.blocks;
    for (const [nx, ny, nz] of FACES) {
      const sx = x - nx;
      const sy = y - ny;
      const sz = z - nz;
      const id = blocks.get(sx, sy, sz);
      // Clicking an anchor would charge or blow it instead of placing against it.
      if (!isSolidBlock(id) || id === B.RESPAWN_ANCHOR) continue;
      if (!blocks.inside(sx, sy, sz) && sy >= 0) continue; // the walls
      if (this.facePoint(sx, sy, sz, nx, ny, nz)) return [sx, sy, sz, nx, ny, nz];
    }
    return null;
  }

  private cellHasFighter(x: number, y: number, z: number, h = 1): boolean {
    for (const f of this.world.fighters) {
      if (f.dead) continue;
      const bb = f.aabb();
      for (let i = 0; i < h; i++) if (Blocks.boxOverlapsCell(bb.minX, bb.minY, bb.minZ, bb.maxX, bb.maxY, bb.maxZ, x, y + i, z)) return true;
    }
    return false;
  }

  /**
   * Scores every option near the opponent and returns the best: hit a crystal already there,
   * put a crystal on obsidian already there, place obsidian then a crystal, or an anchor.
   * Each extra click costs a little, since they may move in the meantime.
   */
  private pickCrystalPlan(per: Perceived): CrystalPlan | null {
    const b = this.bot;
    const K = this.profile.crystal;
    const world = this.world;
    const blocks = world.blocks;
    const eye = b.eyePos();
    let best: CrystalPlan | null = null;
    let bestScore = 0;
    // Judged per tick: `clicks` clicks (each with its gap and aim settle) plus `extra` ticks of
    // work, plus the 10 ticks of hurt immunity every blast has to wait out anyway.
    const click = K.clickGap + K.aimSettle;
    const consider = (score: number | null, clicks: number, extra: number, plan: () => CrystalPlan) => {
      if (score === null || score <= 0) return;
      const rate = score / (clicks * click + extra + 10);
      if (rate > bestScore) {
        bestScore = rate;
        best = plan();
      }
    };

    // 1. Crystals already standing (ours, or theirs when it hurts them more).
    for (const c of world.crystals) {
      if (c.removed || (c.owner !== b && !K.breakTheirs)) continue;
      const d = Math.hypot(c.x - eye.x, c.y + 1 - eye.y, c.z - eye.z);
      if (d > C.ATTACK_REACH + 1) continue;
      const s = this.blastScore(c.x, c.y, c.z, CRYSTAL_POWER, per);
      consider(s, 1, 0, () => ({ kind: 'hit', crystal: c, timer: 0, wait: 0 }));
    }

    // Digging takes about a second (and leaves obsidian they can use too): only worth it on
    // someone who stays put — eating, or walled in.
    const camping = K.mine && (per.using || this.isSurrounded(this.target));
    const hasObsidian = b.slotOf('obsidian') >= 0;
    const hasCrystal = b.slotOf('end_crystal') >= 0;
    const anchors = K.anchors && b.slotOf('respawn_anchor') >= 0 && b.slotOf('glowstone') >= 0;
    const tx = Math.floor(per.x);
    const ty = Math.floor(per.y + 0.01);
    const tz = Math.floor(per.z);
    for (let dy = -2; dy <= 1; dy++)
      for (let dx = -2; dx <= 2; dx++)
        for (let dz = -2; dz <= 2; dz++) {
          const x = tx + dx;
          const y = ty + dy;
          const z = tz + dz;
          if (!blocks.inside(x, y, z)) continue;
          if (Math.hypot(x + 0.5 - eye.x, y + 0.5 - eye.y, z + 0.5 - eye.z) > C.BLOCK_REACH + 0.5) continue;
          const id = blocks.get(x, y, z);
          const above = blocks.get(x, y + 1, z);
          // 2. A crystal on obsidian that is already there.
          if (hasCrystal && id === B.OBSIDIAN && above === B.AIR) {
            if (!canPlaceCrystal(world, x, y, z) || !this.anyFacePoint(x, y, z)) continue;
            const s = this.blastScore(x + 0.5, y + 1, z + 0.5, CRYSTAL_POWER, per);
            consider(s, 2, 0, () => ({
              kind: 'crystal', phase: 'crystal', x, y, z, sx: 0, sy: 0, sz: 0, nx: 0, ny: 0, nz: 0, crystal: null, timer: 0, wait: 0,
            }));
            continue;
          }
          // 2b. Dig the ground beside them and set obsidian into it: a crystal at their feet (HT3+).
          if (camping && hasObsidian && hasCrystal && (id === B.GRASS || id === B.DIRT) && above === B.AIR && blocks.get(x, y + 2, z) === B.AIR) {
            if (this.cellHasFighter(x, y + 1, z, 2) || !this.anyFacePoint(x, y, z)) continue;
            // Once dug, a face inside the hole has to be in view to put the obsidian in.
            const ground = blocks.swapTemp(x, y, z, B.AIR);
            const inHole = this.supportFace(x, y, z);
            blocks.swapTemp(x, y, z, ground);
            if (!inHole) continue;
            const was = blocks.swapTemp(x, y, z, B.OBSIDIAN);
            const s = this.blastScore(x + 0.5, y + 1, z + 0.5, CRYSTAL_POWER, per);
            blocks.swapTemp(x, y, z, was);
            // Grass or dirt by hand: 15–18 ticks of digging first.
            consider(s, 3, id === B.GRASS ? 18 : 15, () => ({
              kind: 'crystal', phase: 'dig', x, y, z, sx: x, sy: y - 1, sz: z, nx: 0, ny: 1, nz: 0, crystal: null, timer: 0, wait: 0,
            }));
            continue;
          }
          if (id !== B.AIR || this.cellHasFighter(x, y, z)) continue;
          const face = this.supportFace(x, y, z);
          if (!face) continue;
          const [sx, sy, sz, nx, ny, nz] = face;
          // 3. Obsidian first, then the crystal on it.
          if (hasObsidian && hasCrystal && above === B.AIR && !this.cellHasFighter(x, y + 1, z, 2)) {
            const was = blocks.swapTemp(x, y, z, B.OBSIDIAN);
            const s = this.blastScore(x + 0.5, y + 1, z + 0.5, CRYSTAL_POWER, per);
            blocks.swapTemp(x, y, z, was);
            consider(s, 3, 0, () => ({ kind: 'crystal', phase: 'place', x, y, z, sx, sy, sz, nx, ny, nz, crystal: null, timer: 0, wait: 0 }));
          }
          // 4. An anchor: placed, charged, blown up (the block is gone by then).
          if (anchors && dy >= -1) {
            const s = this.blastScore(x + 0.5, y + 0.5, z + 0.5, ANCHOR_POWER, per);
            consider(s, 3, 1, () => ({ kind: 'anchor', phase: 'place', x, y, z, sx, sy, sz, nx, ny, nz, crystal: null, timer: 0, wait: 0 }));
          }
        }
    return best;
  }

  /** Keeps crystal range while a combo runs: close enough to place, not in their face. */
  private crystalMove(dist: number, input: MoveInput) {
    const b = this.bot;
    const P = this.profile;
    if (--this.strafeTimer <= 0) {
      this.strafeDir = this.rng.chance(P.strafeChance) ? (this.rng.chance(0.5) ? 1 : -1) : 0;
      this.strafeTimer = this.rng.int(P.strafeSwitch[0], P.strafeSwitch[1]);
    }
    input.forward = dist > 4.3 ? 1 : dist < 2.4 ? -1 : 0;
    input.sprint = false;
    input.strafe = this.world.wallDistance(b.pos.x, b.pos.z) < 3 ? this.roomySide() : this.strafeDir;
    // Healing in our surround: stay put.
    if (P.crystal.surround && b.effectiveHealth() < P.returnHP && this.isSurrounded(b)) {
      input.forward = input.strafe = 0;
      return;
    }
    if (b.horizontalCollision && b.onGround && input.forward > 0) input.jump = true;
  }

  /** One tick of the current combo. False when it ended (and something else may run). */
  private runCrystal(per: Perceived, dist: number, input: MoveInput): boolean {
    const b = this.bot;
    const T = this.target;
    const K = this.profile.crystal;
    const blocks = this.world.blocks;
    const plan = this.cplan!;
    plan.timer++;
    const end = (ok: boolean): false => {
      this.cplan = null;
      this.crystalCooldown = ok ? K.comboGap : 4;
      this.thinkTimer = 0;
      if (b.mining) b.tickMining(false, false);
      return false;
    };
    if (b.usingItem) b.stopUsingItem();
    this.eating = false;

    if (plan.kind === 'pearl') {
      this.potLabel = 'Pearl';
      if (plan.timer > 20 || !this.equip('ender_pearl') || b.cooldowns.has('ender_pearl')) return end(false);
      this.turnTo(plan.yaw, plan.pitch, 2.5);
      const err = Math.abs(wrapAngle(b.yaw - plan.yaw)) + Math.abs(b.pitch - plan.pitch);
      this.settle = err < 3 * DEG ? this.settle + 1 : 0;
      if (this.settle >= K.aimSettle && b.startUsingItem(true)) {
        this.cplan = null;
        return true;
      }
      return true;
    }

    if (plan.kind === 'surround') return this.runSurround(plan, input, end);

    this.crystalMove(dist, input);
    if ('wait' in plan && plan.wait > 0) plan.wait--;
    // Hurt immunity: a blast within 10 ticks of their last hit only deals what it exceeds it by.
    const immune = K.iframeTiming && T.invulnerableTime > C.IFRAME_WINDOW;

    const hitCrystal = (c: EndCrystal): boolean => {
      this.potLabel = 'Crystal';
      if (c.removed) return end(true);
      if (plan.timer > 30) return end(false);
      // Would it kill us now (no totem)? Leave it.
      if (this.blastScore(c.x, c.y, c.z, CRYSTAL_POWER, per) === null && c.owner === b && b.offhand?.id !== 'totem_of_undying') {
        const ours = explosionDamageTo(this.world, b, c.x, c.y, c.z, CRYSTAL_POWER, b.pos.x, b.pos.y, b.pos.z);
        if (ours >= b.effectiveHealth() - 0.5) return end(false);
      }
      this.aimPoint(c.x, c.y + 0.5, c.z);
      if (plan.wait > 0 || this.settle < K.aimSettle || (immune && plan.timer < 12)) return true;
      const cr = crosshairCrystal(b);
      const tT = rayDistanceToTarget(b, T);
      if (cr && cr.crystal === c && (tT < 0 || cr.t < tT)) {
        attackCrystal(b, c);
        return end(true);
      }
      return true;
    };

    if (plan.kind === 'hit') return hitCrystal(plan.crystal);

    // Mine a block open: their surround (pickaxe), or the ground for a lower crystal.
    const mineStep = (x: number, y: number, z: number, started: boolean): boolean | 'mined' => {
      if (blocks.get(x, y, z) === B.AIR) {
        if (b.mining) b.tickMining(false, false);
        return 'mined';
      }
      const p = this.anyFacePoint(x, y, z);
      if (!p) return false;
      this.aimPoint(p[0], p[1], p[2]);
      // Stand still to mine; settle before the first click, then just hold it.
      input.forward = input.strafe = 0;
      input.sprint = false;
      if (!started && this.settle < K.aimSettle) return true;
      const hit = b.crosshairBlock(C.BLOCK_REACH, true);
      if (hit && hit.x === x && hit.y === y && hit.z === z) {
        b.tickMining(true, !started);
        return true;
      }
      if (b.mining) b.tickMining(false, false);
      return true;
    };
    if (plan.kind === 'mine') {
      this.potLabel = 'Mining';
      if (plan.timer > 90) return end(false);
      if (!this.equipToolFor(blocks.get(plan.x, plan.y, plan.z))) return true;
      const r = mineStep(plan.x, plan.y, plan.z, plan.started);
      if (r === 'mined') return end(true);
      if (r === false) return plan.timer > 8 ? end(false) : true;
      if (b.mining) plan.started = true;
      return true;
    }

    if (plan.phase === 'dig') {
      this.potLabel = 'Digging';
      // Grass and dirt need no tool: dig with the obsidian already in hand.
      if (plan.timer > 50 || !this.equip('obsidian') || this.cellHasFighter(plan.x, plan.y + 1, plan.z, 2)) return end(false);
      const r = mineStep(plan.x, plan.y, plan.z, !!plan.started);
      if (r === false) return plan.timer > 8 ? end(false) : true;
      if (r === 'mined') {
        const face = this.supportFace(plan.x, plan.y, plan.z);
        if (!face) return end(false);
        [plan.sx, plan.sy, plan.sz, plan.nx, plan.ny, plan.nz] = face;
        plan.phase = 'place';
        plan.timer = 0;
        plan.wait = K.clickGap;
        this.settle = 0;
        return true;
      }
      if (b.mining) plan.started = true;
      return true;
    }

    if (plan.phase === 'place') {
      this.potLabel = plan.kind === 'anchor' ? 'Anchor' : 'Obsidian';
      const want: ItemId = plan.kind === 'anchor' ? 'respawn_anchor' : 'obsidian';
      const id = blocks.get(plan.x, plan.y, plan.z);
      if (plan.kind === 'crystal' && id === B.OBSIDIAN) {
        plan.phase = 'crystal';
        plan.timer = 0;
        return true;
      }
      if (id !== B.AIR || plan.timer > 20 || !this.equip(want)) return end(false);
      const p = this.facePoint(plan.sx, plan.sy, plan.sz, plan.nx, plan.ny, plan.nz);
      if (!p) return plan.timer > 6 ? end(false) : true;
      this.aimPoint(p[0], p[1], p[2]);
      if (plan.wait > 0 || this.settle < K.aimSettle) return true;
      const hit = b.crosshairBlock(C.BLOCK_REACH, true);
      if (hit && hit.x === plan.sx && hit.y === plan.sy && hit.z === plan.sz && hit.nx === plan.nx && hit.ny === plan.ny && hit.nz === plan.nz) {
        if (b.startUsingItem(true) && blocks.get(plan.x, plan.y, plan.z) !== B.AIR) {
          plan.phase = plan.kind === 'anchor' ? 'charge' : 'crystal';
          plan.timer = 0;
          plan.wait = K.clickGap;
          this.settle = 0;
        }
      }
      return true;
    }

    if (plan.phase === 'crystal') {
      this.potLabel = 'Crystal';
      if (plan.crystal) return hitCrystal(plan.crystal);
      if (plan.timer > 20 || blocks.get(plan.x, plan.y, plan.z) !== B.OBSIDIAN || !canPlaceCrystal(this.world, plan.x, plan.y, plan.z)) return end(false);
      if (!this.equip('end_crystal')) return end(false);
      const p = this.anyFacePoint(plan.x, plan.y, plan.z);
      if (!p) return plan.timer > 6 ? end(false) : true;
      this.aimPoint(p[0], p[1], p[2]);
      if (plan.wait > 0 || this.settle < K.aimSettle) return true;
      const hit = b.crosshairBlock(C.BLOCK_REACH, true);
      if (hit && hit.x === plan.x && hit.y === plan.y && hit.z === plan.z) {
        const n = this.world.crystals.length;
        if (b.startUsingItem(true) && this.world.crystals.length > n) {
          plan.crystal = this.world.crystals[this.world.crystals.length - 1];
          plan.timer = 0;
          plan.wait = K.clickGap;
          this.settle = 0;
        }
      }
      return true;
    }

    // Anchor: charge with glowstone, then click it with anything else.
    this.potLabel = 'Anchor';
    if (blocks.get(plan.x, plan.y, plan.z) !== B.RESPAWN_ANCHOR || plan.timer > 25) return end(false);
    const charge = blocks.anchorCharge(plan.x, plan.y, plan.z);
    if (plan.phase === 'charge' && charge > 0) {
      plan.phase = 'blow';
      plan.timer = 0;
    }
    if (plan.phase === 'charge') {
      if (!this.equip('glowstone')) return end(false);
    } else {
      // A totem (or the sword) in the main hand: anything that isn't glowstone sets it off.
      const tot = b.slotOf('totem_of_undying');
      if (tot >= 0) {
        if (b.selected !== tot) b.selectSlot(tot);
      } else this.equip(this.weapon);
      if (b.heldStack()?.id === 'glowstone') return end(false);
      const ours = explosionDamageTo(this.world, b, plan.x + 0.5, plan.y + 0.5, plan.z + 0.5, ANCHOR_POWER, b.pos.x, b.pos.y, b.pos.z);
      if (ours >= b.effectiveHealth() - 0.5 && b.offhand?.id !== 'totem_of_undying') return true; // step back first
      if (immune && plan.timer < 12) {
        const p = this.anyFacePoint(plan.x, plan.y, plan.z);
        if (p) this.aimPoint(p[0], p[1], p[2]);
        return true;
      }
    }
    const p = this.anyFacePoint(plan.x, plan.y, plan.z);
    if (!p) return plan.timer > 6 ? end(false) : true;
    this.aimPoint(p[0], p[1], p[2]);
    if (plan.wait > 0 || this.settle < K.aimSettle) return true;
    const hit = b.crosshairBlock(C.BLOCK_REACH, true);
    if (hit && hit.x === plan.x && hit.y === plan.y && hit.z === plan.z && b.startUsingItem(true)) {
      if (plan.phase === 'blow') {
        end(true);
        return true;
      }
      plan.phase = 'blow';
      plan.timer = 0;
      plan.wait = K.clickGap;
      this.settle = 0;
    }
    return true;
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
    // ---- Low with apples to eat and them a few blocks off: pillar up out of reach and eat on
    // top. Not with them next to us: an Efficiency III axe takes a plank out in 4 ticks.
    if (
      U.pillar &&
      trueDist > 6 &&
      !P.passive &&
      b.effectiveHealth() <= P.retreatHP &&
      !b.effects.has('regeneration') &&
      b.countItem('golden_apple') > 0 &&
      b.slotOf('oak_planks') >= 0 &&
      b.onGround &&
      trueDist < 12 &&
      this.columnClear(cellX, cellY, cellZ, 5)
    ) {
      this.plan = { kind: 'pillar', baseY: cellY, height: 0, timer: 0, phase: 'build', x: cellX + 0.5, z: cellZ + 0.5 };
      return this.runPlan(per, trueDist, input) === 'own';
    }
    if (P.passive) return false;
    // ---- They are up a pillar next to us: break the block they stand on.
    if (U.mine && this.targetUp() && trueDist < 3.2) {
      const tx = Math.floor(T.pos.x);
      const ty = Math.floor(T.pos.y + 0.01) - 1;
      const tz = Math.floor(T.pos.z);
      if (MINEABLE.has(blocks.get(tx, ty, tz)) && blocks.get(tx, ty, tz) !== B.COBWEB) {
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
      if (hit && MINEABLE.has(hit.id)) {
        this.plan = { kind: 'mine', x: hit.x, y: hit.y, z: hit.z, timer: 0, started: false };
        return this.runPlan(per, trueDist, input) === 'own';
      }
    }
    // ---- A quiet moment: bring spare buckets, planks, the bow and the crossbow back to the hotbar.
    if (trueDist > 5.5 && !b.inWeb && !b.onFire) {
      const moves = this.uhcRestockMoves();
      if (moves.length) {
        this.openInv(moves);
        return true;
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

  private uhcRestockMoves(): [number, number][] {
    const b = this.bot;
    const moves: [number, number][] = [];
    const taken = new Set<number>();
    const target = (ok: (i: number) => boolean) => {
      for (let i = 0; i < 9; i++) if (!taken.has(i) && ok(i)) return i;
      return -1;
    };
    const want = (id: ItemId, into: (i: number) => boolean) => {
      const from = b.invSlotOf(id);
      if (b.slotOf(id) >= 0 || from < 0) return;
      const to = target(into);
      if (to < 0) return;
      taken.add(to);
      moves.push([from, to]);
    };
    const empty = (i: number) => !b.inventory[i];
    const bucket = (i: number) => empty(i) || b.inventory[i]?.id === 'bucket';
    want('crossbow', (i) => empty(i) || b.inventory[i]?.id === 'diamond_pickaxe');
    want('water_bucket', bucket);
    if (this.profile.uhc.lava > 0) want('lava_bucket', bucket);
    want('oak_planks', empty);
    if (this.profile.axe.ranged >= 2) want('bow', empty);
    return moves;
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
        if (plan.timer > 120 || !MINEABLE.has(id)) {
          if (plan.timer > 120) this.selfHelpCooldown = 40;
          return finish(5);
        }
        if (b.usingItem) b.stopUsingItem();
        if (!this.equipToolFor(id)) return 'own';
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
          // Knocked off the column: it's over, fight or run instead.
          const off = Math.hypot(b.pos.x - plan.x, b.pos.z - plan.z) > 0.55 || b.pos.y < top - 0.6;
          if (plan.timer > 60 || (plan.timer > 3 && off) || !this.equip('oak_planks')) return finish(80);
          if (b.usingItem) b.stopUsingItem();
          this.turnTo(b.yaw, -Math.PI / 2 + 0.01, 3);
          // Stop first (a jump keeps our run-up speed and carries us off the column).
          input.jump = plan.height > 0 || Math.hypot(b.vel.x, b.vel.z) < 0.03;
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
      const here = blocks.get(px, y, pz);
      if (here === B.LAVA || here === B.FIRE || blocks.get(px, y - 1, pz) === B.LAVA) {
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
        // The knockback sword swapped in on the same tick: the charged sword's cooldown, its
        // Knockback I — a big push to open the gap.
        const kb = P.axe.swap ? this.kbSwordSlot() : -1;
        if (kb >= 0) b.selectSlot(kb);
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

  /**
   * Makes sure `id` is in the hotbar and selected: 'ready', 'fetching' (the inventory is open to
   * bring it in — it takes real time), or 'none' (we have none, or no room for it).
   */
  private fetch(id: ItemId): 'ready' | 'fetching' | 'none' {
    const b = this.bot;
    const slot = b.slotOf(id);
    if (slot >= 0) {
      if (b.selected !== slot) b.selectSlot(slot);
      return 'ready';
    }
    const from = b.invSlotOf(id);
    const to = from >= 0 ? this.spareHotbarSlot(id) : -1;
    if (to < 0) return 'none';
    this.openInv([[from, to]]);
    return 'fetching';
  }

  /**
   * A hotbar slot something can be swapped into: an empty one, an empty bucket, a utility item
   * that isn't needed right now, and as a last resort the crossbow (restocked afterwards).
   */
  private spareHotbarSlot(forId: ItemId | null = null): number {
    const b = this.bot;
    for (let i = 0; i < 9; i++) if (!b.inventory[i]) return i;
    for (let i = 0; i < 9; i++) if (b.inventory[i]?.id === 'bucket') return i;
    for (const u of SPARE_ITEMS) {
      if (u === forId) continue;
      const i = b.slotOf(u);
      if (i >= 0 && !(this.throwing && (u === 'experience_bottle' || u === 'splash_potion'))) return i;
    }
    if (forId !== 'crossbow' && forId !== 'tipped_arrow' && this.ranged === 'none') return b.slotOf('crossbow');
    return -1;
  }

  /** The right tool for a block: pickaxe for stone-like blocks, axe for planks, sword for webs. */
  /** False while the inventory is open to fetch the pickaxe. */
  private equipToolFor(id: number): boolean {
    const b = this.bot;
    const pick: ItemId = b.countItem('netherite_pickaxe') > 0 ? 'netherite_pickaxe' : 'diamond_pickaxe';
    if (id === B.COBWEB) this.equip(this.weapon);
    else if (id === B.PLANKS && b.slotOf('diamond_axe') >= 0) this.equip('diamond_axe');
    else if (id !== B.PLANKS && id !== B.GRASS && id !== B.DIRT) {
      const r = this.fetch(pick);
      if (r === 'fetching') return false;
      if (r === 'none' && !this.equip(this.weapon)) this.equip('diamond_sword');
    } else if (!this.equip(this.weapon)) this.equip('diamond_sword');
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
export function ballistic(dh: number, dy: number, speed: number, gravity = C.ARROW_GRAVITY): { pitch: number; ticks: number } | null {
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
      vy = vy * C.ARROW_DRAG - gravity;
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
