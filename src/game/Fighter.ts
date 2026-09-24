import * as C from '../core/constants';
import { V3, clamp, forwardX, forwardZ, lookDir, wrapAngle, type AABB } from '../core/math';
import { FIST, ITEMS, type EffectId, type ItemDef, type ItemId, type ItemStack } from './items';
import type { ArmorStats } from './kits';
import type { World } from './World';

export interface MoveInput {
  /** -1..1, +1 = W */
  forward: number;
  /** -1..1, +1 = D (right) */
  strafe: number;
  jump: boolean;
  sneak: boolean;
  /** Sprint key held (or toggle-sprint active). */
  sprint: boolean;
}

export interface EffectInstance {
  amplifier: number;
  duration: number;
}

export interface FighterStats {
  swings: number;
  hits: number;
  crits: number;
  sprintHits: number;
  damageDealt: number;
  damageTaken: number;
  combo: number;
  maxCombo: number;
  gapplesEaten: number;
  reachSum: number;
  maxReach: number;
}

export type FighterEvent =
  | { type: 'jump' }
  | { type: 'step' }
  | { type: 'land'; fall: number }
  | { type: 'eatStart' }
  | { type: 'eatTick' }
  | { type: 'eatDone' }
  | { type: 'miss' }
  | {
      type: 'attack';
      target: Fighter;
      crit: boolean;
      sprint: boolean;
      strong: boolean;
      enchanted: boolean;
      scale: number;
      damage: number;
      reach: number;
      fullHit: boolean;
    }
  | { type: 'noDamage'; target: Fighter }
  | { type: 'hurt'; attacker: Fighter; damage: number; crit: boolean }
  | { type: 'death' }
  | { type: 'heal'; amount: number };

export function newStats(): FighterStats {
  return {
    swings: 0,
    hits: 0,
    crits: 0,
    sprintHits: 0,
    damageDealt: 0,
    damageTaken: 0,
    combo: 0,
    maxCombo: 0,
    gapplesEaten: 0,
    reachSum: 0,
    maxReach: 0,
  };
}

/** Vanilla FoodData: hunger, saturation, exhaustion and natural regeneration. */
export class FoodData {
  level = C.MAX_FOOD;
  saturation = C.START_SATURATION;
  exhaustion = 0;
  tickTimer = 0;

  addExhaustion(v: number) {
    this.exhaustion = Math.min(this.exhaustion + v, C.EXHAUSTION_MAX);
  }

  eat(nutrition: number, saturationModifier: number) {
    this.level = Math.min(this.level + nutrition, C.MAX_FOOD);
    this.saturation = Math.min(this.saturation + nutrition * saturationModifier * 2, this.level);
  }

  tick(f: Fighter, naturalRegen: boolean) {
    if (this.exhaustion > 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0) this.saturation = Math.max(this.saturation - 1, 0);
      else this.level = Math.max(this.level - 1, 0);
    }
    const hurt = f.health > 0 && f.health < f.maxHealth;
    if (naturalRegen && this.saturation > 0 && hurt && this.level >= 20) {
      // "Saturation boost": fast regen while hunger is full.
      if (++this.tickTimer >= 10) {
        const amount = Math.min(this.saturation, 6);
        f.heal(amount / 6);
        this.addExhaustion(amount);
        this.tickTimer = 0;
      }
    } else if (naturalRegen && this.level >= 18 && hurt) {
      if (++this.tickTimer >= 80) {
        f.heal(1);
        this.addExhaustion(C.EXHAUSTION_HEAL);
        this.tickTimer = 0;
      }
    } else if (this.level <= 0) {
      if (++this.tickTimer >= 80) {
        if (f.health > 1) f.health -= 1; // Normal difficulty starvation
        this.tickTimer = 0;
      }
    } else {
      this.tickTimer = 0;
    }
  }
}

/** Knocks `v` away from the source direction (x, z), like LivingEntity.knockback. */
export function applyKnockback(v: V3, strength: number, x: number, z: number, onGround: boolean) {
  if (strength <= 0) return;
  let len = Math.hypot(x, z);
  if (len < 1e-7) {
    x = (Math.random() - Math.random()) * 0.01;
    z = (Math.random() - Math.random()) * 0.01;
    len = Math.hypot(x, z) || 1;
  }
  const nx = (x / len) * strength;
  const nz = (z / len) * strength;
  v.x = v.x / 2 - nx;
  v.z = v.z / 2 - nz;
  if (onGround) v.y = Math.min(C.MAX_KNOCKBACK_Y, v.y / 2 + strength);
}

/**
 * A player-like combatant. Movement mirrors LocalPlayer/LivingEntity (client), while
 * `serverSprinting` and `serverVel` emulate what the server believes, which is what makes
 * W-tapping, sprint-crit chains and "hit into the ground" behave like real multiplayer.
 */
export class Fighter {
  readonly pos = new V3();
  readonly prevPos = new V3();
  readonly vel = new V3();
  /** Server-side copy of the velocity: physics without input, never keeps knockback. */
  readonly serverVel = new V3();
  yaw = 0;
  pitch = 0;
  prevYaw = 0;
  prevPitch = 0;
  bodyYaw = 0;
  prevBodyYaw = 0;

  onGround = true;
  horizontalCollision = false;
  fallDistance = 0;

  input: MoveInput = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
  /** Allow double-tapping W to sprint (player only). */
  doubleTapSprint = false;
  /**
   * Online duels: this fighter's position, rotation and sprint state arrive over the network
   * instead of being simulated. tick() then skips movement but still runs hunger, effects,
   * item use, the attack cooldown and the server-side velocity decay that knockback needs.
   */
  networked = false;
  sprinting = false;
  private wasSprinting = false;
  serverSprinting = false;
  private sprintTriggerTime = 0;
  private hadEnoughImpulse = false;
  private noJumpDelay = 0;

  health = C.MAX_HEALTH;
  maxHealth = C.MAX_HEALTH;
  absorption = 0;
  hurtTime = 0;
  hurtDuration = C.HURT_DURATION;
  invulnerableTime = 0;
  lastHurt = 0;
  /** Direction of the last hit in Minecraft degrees (used for the damage tilt). */
  hurtDir = 0;
  dead = false;
  deathTime = 0;

  readonly food = new FoodData();
  naturalRegen = true;
  readonly effects = new Map<EffectId, EffectInstance>();

  attackStrengthTicker = 0;
  swinging = false;
  swingTime = 0;
  attackAnim = 0;
  oAttackAnim = 0;

  hotbar: (ItemStack | null)[] = new Array(9).fill(null);
  selected = 0;
  private lastHeld: ItemId | null = null;
  usingItem = false;
  useItemRemaining = 0;
  useItemDuration = 0;
  rightClickDelay = 0;

  armor: ArmorStats = { points: 0, toughness: 0, protectionEpf: 0, knockbackResistance: 0 };

  // Animation state
  walkDist = 0;
  walkDistO = 0;
  private moveDist = 0;
  private nextStep = 1;
  bob = 0;
  oBob = 0;
  limbSpeed = 0;
  limbSpeedO = 0;
  limbPos = 0;
  fovModifier = 1;
  oFovModifier = 1;

  stats = newStats();
  events: FighterEvent[] = [];

  constructor(
    readonly id: 'player' | 'bot',
    public name: string,
    readonly world: World,
  ) {}

  // ---------------------------------------------------------------- setup

  reset(x: number, z: number, yaw: number, hotbar: (ItemStack | null)[], armor: ArmorStats) {
    this.pos.set(x, this.world.floorY, z);
    this.prevPos.copy(this.pos);
    // Grounded entities rest at vy = -0.0784 (gravity applied after the floor collision).
    this.vel.set(0, -C.GRAVITY * C.VERTICAL_DRAG, 0);
    this.serverVel.set(0, -C.GRAVITY * C.VERTICAL_DRAG, 0);
    this.yaw = this.prevYaw = this.bodyYaw = this.prevBodyYaw = yaw;
    this.pitch = this.prevPitch = 0;
    this.onGround = true;
    this.horizontalCollision = false;
    this.fallDistance = 0;
    this.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    this.sprinting = this.wasSprinting = this.serverSprinting = false;
    this.sprintTriggerTime = 0;
    this.hadEnoughImpulse = false;
    this.noJumpDelay = 0;
    this.health = this.maxHealth = C.MAX_HEALTH;
    this.absorption = 0;
    this.hurtTime = this.invulnerableTime = 0;
    this.lastHurt = 0;
    this.dead = false;
    this.deathTime = 0;
    Object.assign(this.food, { level: C.MAX_FOOD, saturation: C.START_SATURATION, exhaustion: 0, tickTimer: 0 });
    this.effects.clear();
    this.attackStrengthTicker = 100;
    this.swinging = false;
    this.swingTime = 0;
    this.attackAnim = this.oAttackAnim = 0;
    this.hotbar = new Array(9).fill(null);
    hotbar.forEach((s, i) => (this.hotbar[i] = s ? { ...s } : null));
    this.selected = 0;
    this.lastHeld = this.hotbar[0]?.id ?? null;
    this.usingItem = false;
    this.useItemRemaining = this.useItemDuration = this.rightClickDelay = 0;
    this.armor = { ...armor };
    this.walkDist = this.walkDistO = this.moveDist = 0;
    this.nextStep = 1;
    this.bob = this.oBob = 0;
    this.limbSpeed = this.limbSpeedO = this.limbPos = 0;
    this.fovModifier = this.oFovModifier = 1;
    this.stats = newStats();
    this.events = [];
  }

  // ---------------------------------------------------------------- queries

  get sneaking() {
    return this.input.sneak && !this.dead;
  }
  eyeHeight() {
    return this.sneaking ? C.EYE_HEIGHT_SNEAK : C.EYE_HEIGHT;
  }
  height() {
    return this.sneaking ? C.PLAYER_SNEAK_HEIGHT : C.PLAYER_HEIGHT;
  }
  eyePos(out = new V3()): V3 {
    return out.set(this.pos.x, this.pos.y + this.eyeHeight(), this.pos.z);
  }
  look(out = new V3()): V3 {
    return lookDir(this.yaw, this.pitch, out);
  }
  aabb(): AABB {
    const hw = C.PLAYER_WIDTH / 2;
    return {
      minX: this.pos.x - hw,
      minY: this.pos.y,
      minZ: this.pos.z - hw,
      maxX: this.pos.x + hw,
      maxY: this.pos.y + this.height(),
      maxZ: this.pos.z + hw,
    };
  }
  heldStack(): ItemStack | null {
    return this.hotbar[this.selected];
  }
  heldDef(): ItemDef {
    const s = this.heldStack();
    return s ? ITEMS[s.id] : FIST;
  }
  /** Ticks for a full attack charge: 20 / attack speed (12.5 for swords). */
  attackDelay(): number {
    return 20 / this.heldDef().attackSpeed;
  }
  /** Player.getAttackStrengthScale — 0..1 cooldown progress. */
  attackStrengthScale(partial: number): number {
    return clamp((this.attackStrengthTicker + partial) / this.attackDelay(), 0, 1);
  }
  movementSpeed(): number {
    return C.WALK_SPEED * (this.sprinting ? C.SPRINT_SPEED_MULT : 1);
  }
  countItem(id: ItemId): number {
    return this.hotbar.reduce((n, s) => n + (s && s.id === id ? s.count : 0), 0);
  }
  slotOf(id: ItemId): number {
    return this.hotbar.findIndex((s) => s?.id === id);
  }
  effectiveHealth(): number {
    return this.health + this.absorption;
  }

  // ---------------------------------------------------------------- actions

  resetAttackStrength() {
    this.attackStrengthTicker = 0;
  }

  swing() {
    if (!this.swinging || this.swingTime >= C.SWING_DURATION / 2 || this.swingTime < 0) {
      this.swingTime = -1;
      this.swinging = true;
    }
  }

  getAttackAnim(partial: number): number {
    let d = this.attackAnim - this.oAttackAnim;
    if (d < 0) d += 1;
    return this.oAttackAnim + d * partial;
  }

  selectSlot(i: number) {
    if (i === this.selected || i < 0 || i > 8) return;
    this.selected = i;
    if (this.usingItem) this.stopUsingItem();
  }

  startUsingItem(): boolean {
    if (this.usingItem || this.dead || this.rightClickDelay > 0) return false;
    const food = this.heldDef().food;
    if (!this.heldStack() || !food) return false;
    if (!food.alwaysEdible && this.food.level >= C.MAX_FOOD) return false;
    this.usingItem = true;
    this.useItemDuration = this.useItemRemaining = food.useTicks;
    this.rightClickDelay = C.USE_ITEM_DELAY;
    this.events.push({ type: 'eatStart' });
    return true;
  }

  stopUsingItem() {
    this.usingItem = false;
    this.useItemRemaining = 0;
  }

  heal(amount: number) {
    if (this.dead || amount <= 0) return;
    const before = this.health;
    this.health = Math.min(this.maxHealth, this.health + amount);
    if (this.health > before) this.events.push({ type: 'heal', amount: this.health - before });
  }

  causeExhaustion(v: number) {
    this.food.addExhaustion(v);
  }

  addEffect(id: EffectId, amplifier: number, duration: number) {
    const cur = this.effects.get(id);
    if (!cur) this.effects.set(id, { amplifier, duration });
    else if (amplifier > cur.amplifier) Object.assign(cur, { amplifier, duration });
    else if (amplifier === cur.amplifier && duration > cur.duration) cur.duration = duration;
    else return;
    if (id === 'absorption') this.absorption = Math.max(this.absorption, 4 * (amplifier + 1));
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.deathTime = 0;
    this.stopUsingItem();
    this.sprinting = false;
    this.events.push({ type: 'death' });
  }

  // ---------------------------------------------------------------- tick

  /** Copies current state into the "previous" slots used for render interpolation. */
  snapshot() {
    this.prevPos.copy(this.pos);
    this.prevYaw = this.yaw;
    this.prevPitch = this.pitch;
    this.prevBodyYaw = this.bodyYaw;
    this.walkDistO = this.walkDist;
    this.oBob = this.bob;
    this.oAttackAnim = this.attackAnim;
    this.oFovModifier = this.fovModifier;
    this.limbSpeedO = this.limbSpeed;
  }

  tick() {
    if (this.hurtTime > 0) this.hurtTime--;
    if (this.invulnerableTime > 0) this.invulnerableTime--;
    if (this.dead) {
      this.deathTime++;
      this.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    } else {
      this.tickEffects();
      this.tickItemUse();
    }
    if (this.networked) this.netStep();
    else this.aiStep();
    this.updateBodyRotation();
    this.updateWalkAnimation();
    this.updateSwingTime();

    this.attackStrengthTicker++;
    const held = this.heldStack()?.id ?? null;
    if (held !== this.lastHeld) {
      this.resetAttackStrength();
      this.lastHeld = held;
    }
    if (!this.dead) this.food.tick(this, this.naturalRegen);

    // Client -> server sprint packets are only sent when the client's sprint state changes.
    // For a networked fighter `sprinting` IS the reported client state, so the same edge
    // detection reproduces the real sprint-reset rule (see applyMove).
    if (this.sprinting !== this.wasSprinting) {
      this.wasSprinting = this.sprinting;
      this.serverSprinting = this.sprinting;
    }
    this.tickServerMotion();

    const target = (this.movementSpeed() / C.WALK_SPEED + 1) / 2;
    this.fovModifier += (target - this.fovModifier) * 0.5;
  }

  private tickEffects() {
    for (const [id, e] of this.effects) {
      if (id === 'regeneration') {
        const k = 50 >> e.amplifier;
        if ((k <= 0 || e.duration % k === 0) && this.health < this.maxHealth) this.heal(1);
      }
      e.duration--;
      if (e.duration <= 0) {
        this.effects.delete(id);
        if (id === 'absorption') this.absorption = 0;
      }
    }
  }

  private tickItemUse() {
    if (this.rightClickDelay > 0) this.rightClickDelay--;
    if (!this.usingItem) return;
    const stack = this.heldStack();
    const food = this.heldDef().food;
    if (!stack || !food) {
      this.stopUsingItem();
      return;
    }
    const i = this.useItemRemaining;
    if (i <= this.useItemDuration - 7 && i % 4 === 0) this.events.push({ type: 'eatTick' });
    if (--this.useItemRemaining <= 0) {
      this.food.eat(food.nutrition, food.saturationModifier);
      for (const e of food.effects) this.addEffect(e.id, e.amplifier, e.duration);
      stack.count--;
      if (stack.count <= 0) this.hotbar[this.selected] = null;
      this.usingItem = false;
      this.useItemRemaining = 0;
      this.stats.gapplesEaten++;
      this.events.push({ type: 'eatDone' });
    }
  }

  private aiStep() {
    if (this.noJumpDelay > 0) this.noJumpDelay--;
    const v = this.vel;
    if (Math.abs(v.x) < C.MIN_VELOCITY) v.x = 0;
    if (Math.abs(v.y) < C.MIN_VELOCITY) v.y = 0;
    if (Math.abs(v.z) < C.MIN_VELOCITY) v.z = 0;

    // --- LocalPlayer input handling & sprint rules
    const sneak = this.sneaking;
    let fwd = clamp(this.input.forward, -1, 1);
    let str = clamp(this.input.strafe, -1, 1);
    if (sneak) {
      fwd *= C.SNEAK_INPUT_MULT;
      str *= C.SNEAK_INPUT_MULT;
    }
    if (this.usingItem) {
      fwd *= C.USE_ITEM_INPUT_MULT;
      str *= C.USE_ITEM_INPUT_MULT;
      this.sprintTriggerTime = 0;
    }
    if (this.sprintTriggerTime > 0) this.sprintTriggerTime--;
    const enough = fwd >= 0.8;
    const foodOk = this.food.level > C.SPRINT_MIN_FOOD;
    const canStart = enough && foodOk && !this.usingItem && !sneak && !this.dead;
    if (this.doubleTapSprint && !this.sprinting && canStart && this.onGround && !this.hadEnoughImpulse) {
      if (this.sprintTriggerTime <= 0 && !this.input.sprint) this.sprintTriggerTime = C.DOUBLE_TAP_SPRINT_WINDOW;
      else this.sprinting = true;
    }
    if (!this.sprinting && canStart && this.input.sprint) this.sprinting = true;
    // Eating does not cancel an existing sprint (lets you sprint-jump away while healing).
    if (this.sprinting && (fwd <= 1e-5 || !foodOk || this.horizontalCollision || sneak || this.dead)) {
      this.sprinting = false;
    }
    this.hadEnoughImpulse = enough;

    // --- jumping
    if (this.input.jump && !this.dead) {
      if (this.onGround && this.noJumpDelay === 0) {
        this.jumpFromGround();
        this.noJumpDelay = C.JUMP_DELAY_TICKS;
      }
    } else {
      this.noJumpDelay = 0;
    }

    this.travel(str * C.INPUT_DAMPING, fwd * C.INPUT_DAMPING);

    const f = this.onGround && !this.dead ? Math.min(0.1, Math.hypot(v.x, v.z)) : 0;
    this.bob += (f - this.bob) * 0.4;
  }

  /**
   * Movement for a fighter driven by the network: the position was already set from the last
   * packet, so only the animation bookkeeping aiStep() would have done is left.
   */
  private netStep() {
    const dx = this.pos.x - this.prevPos.x;
    const dz = this.pos.z - this.prevPos.z;
    const horizontal = Math.hypot(dx, dz);
    this.walkDist += horizontal * 0.6;
    this.moveDist += horizontal * 0.6;
    if (this.onGround && this.moveDist > this.nextStep) {
      this.nextStep = this.moveDist + 1;
      this.events.push({ type: 'step' });
    }
    const f = this.onGround && !this.dead ? Math.min(0.1, horizontal) : 0;
    this.bob += (f - this.bob) * 0.4;
  }

  /** Applies a movement packet. Position is trusted; the rest feeds the combat rules. */
  applyMove(
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    onGround: boolean,
    sprinting: boolean,
    sneaking: boolean,
    vy = 0,
  ) {
    if (this.dead) return;
    this.pos.set(x, y, z);
    // Only the vertical component matters here: knockback needs it to leave a jump alone.
    this.vel.y = vy;
    this.yaw = yaw;
    this.pitch = pitch;
    const wasOnGround = this.onGround;
    this.onGround = onGround;
    if (onGround) this.fallDistance = 0;
    else if (wasOnGround || this.pos.y < this.prevPos.y) this.fallDistance += Math.max(0, this.prevPos.y - this.pos.y);
    this.sprinting = sprinting;
    this.input = { ...this.input, sneak: sneaking };
  }

  private jumpFromGround() {
    this.vel.y = C.JUMP_POWER;
    if (this.sprinting) {
      this.vel.x += forwardX(this.yaw) * C.SPRINT_JUMP_BOOST;
      this.vel.z += forwardZ(this.yaw) * C.SPRINT_JUMP_BOOST;
    }
    this.causeExhaustion(this.sprinting ? C.EXHAUSTION_SPRINT_JUMP : C.EXHAUSTION_JUMP);
    this.events.push({ type: 'jump' });
  }

  private travel(strafe: number, forward: number) {
    const onGround = this.onGround;
    const friction = onGround ? C.GROUND_FRICTION : C.AIR_FRICTION;
    const speed = onGround
      ? this.movementSpeed() * (0.21600002 / (C.BLOCK_SLIPPERINESS ** 3))
      : this.sprinting
        ? C.AIR_ACCEL_SPRINT
        : C.AIR_ACCEL;
    let ix = strafe;
    let iz = forward;
    const lsq = ix * ix + iz * iz;
    if (lsq >= 1e-7) {
      if (lsq > 1) {
        const l = Math.sqrt(lsq);
        ix /= l;
        iz /= l;
      }
      ix *= speed;
      iz *= speed;
      const s = Math.sin(this.yaw);
      const c = Math.cos(this.yaw);
      this.vel.x += -s * iz + c * ix;
      this.vel.z += -c * iz - s * ix;
    }
    const ox = this.pos.x;
    const oz = this.pos.z;
    this.move(this.vel.x, this.vel.y, this.vel.z);
    this.vel.y = (this.vel.y - C.GRAVITY) * C.VERTICAL_DRAG;
    this.vel.x *= friction;
    this.vel.z *= friction;
    if (this.onGround && this.sprinting) {
      const cm = Math.round(Math.hypot(this.pos.x - ox, this.pos.z - oz) * 100);
      if (cm > 0) this.causeExhaustion(C.EXHAUSTION_SPRINT_PER_BLOCK * cm * 0.01);
    }
  }

  private move(dx: number, dy: number, dz: number) {
    const r = this.world.move(this.pos.x, this.pos.y, this.pos.z, dx, dy, dz);
    const horizontal = Math.hypot(r.x - this.pos.x, r.z - this.pos.z);
    this.pos.set(r.x, r.y, r.z);
    this.horizontalCollision = r.hitX || r.hitZ;
    const wasAirborne = !this.onGround;
    this.onGround = r.hitY && dy < 0;
    if (r.hitX) this.vel.x = 0;
    if (r.hitZ) this.vel.z = 0;
    if (r.hitY) this.vel.y = 0;
    if (this.onGround) {
      if (wasAirborne && this.fallDistance > 0) this.events.push({ type: 'land', fall: this.fallDistance });
      this.fallDistance = 0;
    } else if (dy < 0) {
      this.fallDistance -= dy;
    }
    this.walkDist += horizontal * 0.6;
    this.moveDist += horizontal * 0.6;
    if (this.onGround && this.moveDist > this.nextStep) {
      this.nextStep = this.moveDist + 1;
      this.events.push({ type: 'step' });
    }
  }

  /** Server-side physics on the server's velocity copy (no input), used for knockback maths. */
  private tickServerMotion() {
    const sv = this.serverVel;
    if (Math.abs(sv.x) < C.MIN_VELOCITY) sv.x = 0;
    if (Math.abs(sv.y) < C.MIN_VELOCITY) sv.y = 0;
    if (Math.abs(sv.z) < C.MIN_VELOCITY) sv.z = 0;
    const friction = this.onGround ? C.GROUND_FRICTION : C.AIR_FRICTION;
    if (this.onGround && sv.y < 0) sv.y = 0;
    sv.y = (sv.y - C.GRAVITY) * C.VERTICAL_DRAG;
    sv.x *= friction;
    sv.z *= friction;
  }

  private updateBodyRotation() {
    const dx = this.pos.x - this.prevPos.x;
    const dz = this.pos.z - this.prevPos.z;
    let target = this.bodyYaw;
    if (dx * dx + dz * dz > 0.0025000002) {
      const moveYaw = Math.atan2(-dx, -dz);
      const diff = Math.abs(wrapAngle(this.yaw - moveYaw));
      target = diff > (95 * Math.PI) / 180 ? moveYaw + Math.PI : moveYaw;
    }
    if (this.attackAnim > 0 || this.swinging) target = this.yaw;
    this.bodyYaw += wrapAngle(target - this.bodyYaw) * 0.3;
    const rel = wrapAngle(this.yaw - this.bodyYaw);
    const max = (50 * Math.PI) / 180;
    if (Math.abs(rel) > max) this.bodyYaw += rel - Math.sign(rel) * max;
    this.bodyYaw = wrapAngle(this.bodyYaw);
  }

  private updateWalkAnimation() {
    const d = Math.hypot(this.pos.x - this.prevPos.x, this.pos.z - this.prevPos.z);
    const target = Math.min(d * 4, 1);
    this.limbSpeed += (target - this.limbSpeed) * 0.4;
    this.limbPos += this.limbSpeed;
  }

  private updateSwingTime() {
    if (this.swinging) {
      this.swingTime++;
      if (this.swingTime >= C.SWING_DURATION) {
        this.swingTime = 0;
        this.swinging = false;
      }
    } else {
      this.swingTime = 0;
    }
    this.attackAnim = this.swingTime / C.SWING_DURATION;
  }
}
