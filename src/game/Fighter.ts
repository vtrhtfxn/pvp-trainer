import * as C from '../core/constants';
import { V3, clamp, forwardX, forwardZ, lookDir, wrapAngle, type AABB } from '../core/math';
import { Arrow } from './Arrow';
import { FIST, ITEMS, cloneStack, defOf, type EffectId, type ItemDef, type ItemId, type ItemStack, type PotionId, type UseKind } from './items';
import { armorStatsOf, type ArmorStats, type Loadout } from './kits';
import { burn } from './combat';
import { Thrown } from './Thrown';
import type { World } from './World';

/** Inventory slot addresses: 0–8 hotbar, 9–35 main inventory, 36–39 armor (head → feet), 40 off hand. */
export const INV_SIZE = 36;
export const SLOT_ARMOR = 36;
export const SLOT_OFFHAND = 40;
export const SLOT_COUNT = 41;

export type Hand = 'main' | 'off';

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
  /** Hits (and arrows) your shield stopped. */
  blocked: number;
  /** Times you put the opponent's shield on cooldown. */
  shieldsDisabled: number;
  arrowsShot: number;
  arrowHits: number;
  /** Hits landed with the previous item's attributes (hotbar swap on the same tick). */
  attributeSwaps: number;
  potsThrown: number;
  totemsPopped: number;
  xpBottles: number;
  /** Durability Mending restored. */
  repaired: number;
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
      /** Landed with the previous item's attack attributes (attribute swap). */
      swap: boolean;
    }
  | { type: 'noDamage'; target: Fighter }
  /** Your swing hit a raised shield. */
  | { type: 'hitShield'; target: Fighter; disabled: boolean; swap: boolean }
  | { type: 'shieldRaise' }
  | { type: 'shieldBlock'; attacker: Fighter }
  | { type: 'shieldDisabled' }
  | { type: 'bowDraw' }
  | { type: 'crossbowLoading' }
  | { type: 'crossbowLoaded' }
  | { type: 'shoot'; crossbow: boolean; power: number }
  | { type: 'arrowHit'; target: Fighter; damage: number; crit: boolean }
  | { type: 'pickup' }
  | { type: 'swapHands' }
  | { type: 'throw'; kind: 'potion' | 'xp' }
  /** A splash potion's effect reached you (`own`: you threw it). */
  | { type: 'splashed'; potion: PotionId; scale: number; own: boolean }
  | { type: 'totem' }
  | { type: 'itemBreak'; id: ItemId }
  | { type: 'xpPickup'; value: number }
  /** `attacker` is null for damage without a source entity (burning). */
  | { type: 'hurt'; attacker: Fighter | null; damage: number; crit: boolean; fire?: boolean }
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
    blocked: 0,
    shieldsDisabled: 0,
    arrowsShot: 0,
    arrowHits: 0,
    attributeSwaps: 0,
    potsThrown: 0,
    totemsPopped: 0,
    xpBottles: 0,
    repaired: 0,
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

  /** 0–8 hotbar, 9–35 main inventory — vanilla Inventory.items order. */
  inventory: (ItemStack | null)[] = new Array(INV_SIZE).fill(null);
  /** Head, chest, legs, feet. */
  armorSlots: (ItemStack | null)[] = [null, null, null, null];
  offhand: ItemStack | null = null;
  selected = 0;
  /**
   * The main-hand item whose attribute modifiers (attack damage, attack speed) are applied.
   * Vanilla only refreshes these in the entity tick, so a hotbar switch and a click on the same
   * tick still attack with the OLD item's damage and cooldown but the NEW item's own effects
   * (an axe's shield disable, its enchantments). That gap is attribute swapping.
   */
  attrId: ItemId | null = null;
  usingItem = false;
  useHand: Hand = 'main';
  private useId: ItemId | null = null;
  useItemRemaining = 0;
  useItemDuration = 0;
  rightClickDelay = 0;
  /** Ticks left before any shield can be raised again (after an axe disabled it). */
  shieldCooldown = 0;
  /** Entity.remainingFireTicks: burning while > 0. */
  fireTicks = 0;
  /** Player.takeXpDelay: an orb can only be absorbed when this is 0. */
  takeXpDelay = 0;

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

  reset(x: number, z: number, yaw: number, kit: Loadout) {
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
    this.inventory = new Array(INV_SIZE).fill(null);
    kit.hotbar.forEach((s, i) => (this.inventory[i] = cloneStack(s)));
    kit.main?.forEach((s, i) => (this.inventory[9 + i] = cloneStack(s)));
    this.armorSlots = [0, 1, 2, 3].map((i) => cloneStack(kit.armor[i]));
    this.offhand = cloneStack(kit.offhand);
    this.selected = 0;
    this.attrId = this.inventory[0]?.id ?? null;
    this.usingItem = false;
    this.useHand = 'main';
    this.useId = null;
    this.useItemRemaining = this.useItemDuration = this.rightClickDelay = 0;
    this.shieldCooldown = 0;
    this.fireTicks = 0;
    this.takeXpDelay = 0;
    this.recomputeArmor();
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
    return this.aabbInto({ minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
  }
  /** Writes the hitbox (grown by `grow` on every side) into `out` without allocating. */
  aabbInto(out: AABB, grow = 0): AABB {
    const hw = C.PLAYER_WIDTH / 2 + grow;
    out.minX = this.pos.x - hw;
    out.minY = this.pos.y - grow;
    out.minZ = this.pos.z - hw;
    out.maxX = this.pos.x + hw;
    out.maxY = this.pos.y + this.height() + grow;
    out.maxZ = this.pos.z + hw;
    return out;
  }
  heldStack(): ItemStack | null {
    return this.inventory[this.selected];
  }
  stackIn(hand: Hand): ItemStack | null {
    return hand === 'main' ? this.inventory[this.selected] : this.offhand;
  }
  heldDef(): ItemDef {
    return defOf(this.heldStack());
  }
  /** The item whose attack attributes are in effect — see `attrId`. */
  attrDef(): ItemDef {
    return this.attrId ? ITEMS[this.attrId] : FIST;
  }
  /** Ticks for a full attack charge: 20 / attack speed (12.5 for swords, 20 for axes). */
  attackDelay(): number {
    return 20 / this.attrDef().attackSpeed;
  }
  /** What the item being used does, or 'none'. */
  useKind(): UseKind {
    return this.usingItem && this.useId ? ITEMS[this.useId].use : 'none';
  }
  /** Ticks the current item has been in use. */
  useTicks(): number {
    return this.usingItem ? this.useItemDuration - this.useItemRemaining : 0;
  }
  /** Shield held up — drawn from the first tick, but only blocks after SHIELD_RAISE_TICKS. */
  raisingShield(): boolean {
    return this.useKind() === 'shield';
  }
  isBlocking(): boolean {
    return this.useKind() === 'shield' && this.useTicks() >= C.SHIELD_RAISE_TICKS;
  }
  hasShield(): boolean {
    return this.offhand?.id === 'shield' || this.heldStack()?.id === 'shield';
  }
  /** Player.getAttackStrengthScale — 0..1 cooldown progress. */
  attackStrengthScale(partial: number): number {
    return clamp((this.attackStrengthTicker + partial) / this.attackDelay(), 0, 1);
  }
  /** movement_speed: sprinting ×1.3 and Speed ×(1 + 0.2 per level) are separate multipliers. */
  movementSpeed(): number {
    let v = C.WALK_SPEED * (this.sprinting ? C.SPRINT_SPEED_MULT : 1);
    const sp = this.effects.get('speed');
    if (sp) v *= 1 + 0.2 * (sp.amplifier + 1);
    return v;
  }
  /** attack_damage attribute: the attribute item's damage plus Strength's +3 per level. */
  attackDamage(): number {
    const st = this.effects.get('strength');
    return this.attrDef().attackDamage + (st ? 3 * (st.amplifier + 1) : 0);
  }
  get onFire(): boolean {
    return this.fireTicks > 0;
  }
  countItem(id: ItemId, potion?: PotionId): number {
    const match = (s: ItemStack | null) => !!s && s.id === id && (potion === undefined || s.potion === potion);
    let n = match(this.offhand) ? this.offhand!.count : 0;
    for (const s of this.inventory) if (match(s)) n += s!.count;
    return n;
  }
  /** Hotbar index holding `id` (and that potion), or -1. */
  slotOf(id: ItemId, potion?: PotionId): number {
    for (let i = 0; i < 9; i++) {
      const s = this.inventory[i];
      if (s?.id === id && (potion === undefined || s.potion === potion)) return i;
    }
    return -1;
  }
  /** Main-inventory index (9–35) holding `id` (and that potion), or -1. */
  invSlotOf(id: ItemId, potion?: PotionId): number {
    for (let i = 9; i < INV_SIZE; i++) {
      const s = this.inventory[i];
      if (s?.id === id && (potion === undefined || s.potion === potion)) return i;
    }
    return -1;
  }

  // ---------------------------------------------------------------- inventory

  getSlot(i: number): ItemStack | null {
    if (i < INV_SIZE) return this.inventory[i] ?? null;
    if (i < SLOT_OFFHAND) return this.armorSlots[i - SLOT_ARMOR];
    return this.offhand;
  }

  setSlot(i: number, s: ItemStack | null) {
    const v = s && s.count > 0 ? s : null;
    if (i < INV_SIZE) this.inventory[i] = v;
    else if (i < SLOT_OFFHAND) {
      this.armorSlots[i - SLOT_ARMOR] = v;
      this.recomputeArmor();
    } else this.offhand = v;
  }

  recomputeArmor() {
    this.armor = armorStatsOf(this.armorSlots);
  }

  /** Swaps two slots (a number key over a slot in the inventory screen). */
  swapSlots(a: number, b: number) {
    if (a === b) return;
    const sa = this.getSlot(a);
    this.setSlot(a, this.getSlot(b));
    this.setSlot(b, sa);
  }

  /**
   * ItemStack.hurtAndBreak: Unbreaking skips each point with probability level/(level+1) —
   * for armor only 60% of that chance applies. The stack breaks when damage reaches its max.
   */
  damageItem(slot: number, amount: number) {
    const s = this.getSlot(slot);
    const max = s ? ITEMS[s.id].maxDamage : undefined;
    if (!s || !max || amount <= 0) return;
    const ub = s.ench?.unbreaking ?? 0;
    const isArmor = !!ITEMS[s.id].armor;
    let n = 0;
    for (let i = 0; i < amount; i++) {
      if (ub > 0) {
        const r = this.world.rng;
        const ignore = isArmor ? r.next() >= 0.6 && r.int(0, ub) > 0 : r.int(0, ub) > 0;
        if (ignore) continue;
      }
      n++;
    }
    if (!n) return;
    s.damage = (s.damage ?? 0) + n;
    if (s.damage >= max) {
      this.setSlot(slot, null);
      this.events.push({ type: 'itemBreak', id: s.id });
    }
  }

  /** LivingEntity.doHurtEquipment for armor: each piece loses max(1, damage / 4). */
  damageArmor(amount: number) {
    const per = Math.max(1, Math.floor(amount / 4));
    for (let i = 0; i < 4; i++) if (this.armorSlots[i]) this.damageItem(SLOT_ARMOR + i, per);
  }

  /** The slot index the hand holds (main hand = selected hotbar slot). */
  handSlot(hand: Hand): number {
    return hand === 'main' ? this.selected : SLOT_OFFHAND;
  }

  /**
   * ExperienceOrb.repairPlayerItems: a random equipped (hands and armor), damaged Mending item
   * soaks up the orb at 2 durability per point; whatever is left over goes to the next one.
   */
  pickUpXp(value: number) {
    this.events.push({ type: 'xpPickup', value });
    let xp = value;
    while (xp > 0) {
      let pick = -1;
      let seen = 0;
      for (const slot of [this.selected, SLOT_OFFHAND, SLOT_ARMOR, SLOT_ARMOR + 1, SLOT_ARMOR + 2, SLOT_ARMOR + 3]) {
        const s = this.getSlot(slot);
        if (s?.ench?.mending && (s.damage ?? 0) > 0 && this.world.rng.int(0, seen++) === 0) pick = slot;
      }
      if (pick < 0) return;
      const s = this.getSlot(pick)!;
      const can = xp * C.MENDING_DURABILITY_PER_XP;
      const k = Math.min(can, s.damage!);
      s.damage! -= k;
      if (!s.damage) delete s.damage;
      this.stats.repaired += k;
      xp -= Math.floor((k * xp) / can);
      if (k <= 0) return;
    }
  }

  /** Entity.igniteForTicks: only ever extends the current fire. */
  ignite(ticks: number) {
    if (this.fireTicks < ticks) this.fireTicks = ticks;
  }

  /**
   * LivingEntity.checkTotemDeathProtection: a totem in either hand (main hand first) is used
   * up instead of dying — health 1, every effect cleared, then Regeneration II (45 s),
   * Absorption II (5 s) and Fire Resistance (40 s).
   */
  tryTotem(): boolean {
    for (const hand of ['main', 'off'] as const) {
      const s = this.stackIn(hand);
      if (s?.id !== 'totem_of_undying') continue;
      this.setSlot(this.handSlot(hand), null);
      this.health = 1;
      this.effects.clear();
      this.absorption = 0;
      this.addEffect('regeneration', 1, C.TOTEM_REGEN_TICKS);
      this.addEffect('absorption', 1, C.TOTEM_ABSORPTION_TICKS);
      this.addEffect('fire_resistance', 0, C.TOTEM_FIRE_RES_TICKS);
      this.stats.totemsPopped++;
      this.events.push({ type: 'totem' });
      return true;
    }
    return false;
  }

  /** Inventory.add: tops up matching stacks first, then fills the first empty slot. */
  addItem(stack: ItemStack): boolean {
    const max = ITEMS[stack.id].maxStack;
    let left = stack.count;
    const top = (s: ItemStack | null) => {
      if (!s || s.id !== stack.id || left <= 0) return;
      const n = Math.min(left, max - s.count);
      if (n > 0) {
        s.count += n;
        left -= n;
      }
    };
    top(this.heldStack());
    top(this.offhand);
    for (const s of this.inventory) top(s);
    for (let i = 0; i < INV_SIZE && left > 0; i++) {
      if (!this.inventory[i]) {
        const n = Math.min(left, max);
        this.inventory[i] = { ...stack, count: n };
        left -= n;
      }
    }
    stack.count = left;
    return left <= 0;
  }

  /** Player.getProjectile: off hand first, then main hand, then the inventory in order. */
  private findAmmo(): number {
    if (this.offhand?.id === 'arrow') return SLOT_OFFHAND;
    if (this.heldStack()?.id === 'arrow') return this.selected;
    for (let i = 0; i < INV_SIZE; i++) if (this.inventory[i]?.id === 'arrow') return i;
    return -1;
  }
  hasAmmo(): boolean {
    return this.findAmmo() >= 0;
  }
  private consumeAmmo(): boolean {
    const i = this.findAmmo();
    if (i < 0) return false;
    const s = this.getSlot(i)!;
    s.count--;
    if (s.count <= 0) this.setSlot(i, null);
    return true;
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
    // An off-hand shield stays up while you scroll; only a main-hand use is interrupted.
    if (this.usingItem && this.useHand === 'main') this.stopUsingItem();
  }

  /** F: swaps the main-hand and off-hand stacks (ServerboundPlayerActionPacket SWAP_ITEM_WITH_OFFHAND). */
  swapHands() {
    if (this.dead) return;
    const main = this.inventory[this.selected];
    this.inventory[this.selected] = this.offhand;
    this.offhand = main;
    if (this.usingItem) this.stopUsingItem();
    this.events.push({ type: 'swapHands' });
  }

  /**
   * Right click. Like Minecraft.startUseItem it tries the main hand first and falls through to
   * the off hand when the main-hand item has no use: a sword with a shield or golden apple in
   * the off hand blocks or eats. `click` is a fresh press, which ignores the 4-tick
   * rightClickDelay that throttles a held button.
   */
  startUsingItem(click = false): boolean {
    if (this.usingItem || this.dead) return false;
    if (!click && this.rightClickDelay > 0) return false;
    for (const hand of ['main', 'off'] as const) {
      const s = this.stackIn(hand);
      if (s && this.tryUse(s, hand)) {
        this.rightClickDelay = C.USE_ITEM_DELAY;
        return true;
      }
    }
    return false;
  }

  private beginUse(hand: Hand, id: ItemId, duration: number) {
    this.usingItem = true;
    this.useHand = hand;
    this.useId = id;
    this.useItemDuration = this.useItemRemaining = duration;
  }

  private tryUse(s: ItemStack, hand: Hand): boolean {
    const def = ITEMS[s.id];
    switch (def.use) {
      case 'food': {
        const food = def.food!;
        if (!food.alwaysEdible && this.food.level >= C.MAX_FOOD) return false;
        this.beginUse(hand, s.id, food.useTicks);
        this.events.push({ type: 'eatStart' });
        return true;
      }
      case 'shield':
        if (this.shieldCooldown > 0) return false;
        this.beginUse(hand, s.id, C.USE_FOREVER);
        this.events.push({ type: 'shieldRaise' });
        return true;
      case 'bow':
        if (!this.hasAmmo()) return false;
        this.beginUse(hand, s.id, C.USE_FOREVER);
        this.events.push({ type: 'bowDraw' });
        return true;
      case 'crossbow':
        if (s.charged) {
          // A loaded crossbow fires on the click itself.
          s.charged = false;
          this.shootArrow(C.CROSSBOW_SPEED, true, false);
          this.events.push({ type: 'shoot', crossbow: true, power: 1 });
          return true;
        }
        if (!this.hasAmmo()) return false;
        this.beginUse(hand, s.id, C.USE_FOREVER);
        this.events.push({ type: 'crossbowLoading' });
        return true;
      case 'throw':
        this.throwItem(s, hand);
        return true;
      default:
        return false;
    }
  }

  /** Splash potions and XP bottles leave the hand the moment you click. */
  private throwItem(s: ItemStack, hand: Hand) {
    const xp = s.id === 'experience_bottle';
    const t = new Thrown(this, xp ? 'xp' : 'potion', s.potion ?? null, this.pos.x, this.pos.y + this.eyeHeight() - 0.1, this.pos.z);
    t.throwFrom(this, xp ? C.XP_BOTTLE_THROW_SPEED : C.POTION_THROW_SPEED, this.world.rng);
    this.world.spawnThrown(t);
    s.count--;
    if (s.count <= 0) this.setSlot(this.handSlot(hand), null);
    if (hand === 'main') this.swing();
    if (xp) this.stats.xpBottles++;
    else this.stats.potsThrown++;
    this.events.push({ type: 'throw', kind: xp ? 'xp' : 'potion' });
  }

  /** Letting go of right click: looses a drawn bow, or finishes loading a crossbow. */
  releaseUsingItem() {
    if (!this.usingItem) return;
    const s = this.stackIn(this.useHand);
    const ticks = this.useTicks();
    if (s && s.id === this.useId) {
      if (s.id === 'bow') {
        const power = bowPower(ticks);
        if (power >= 0.1 && this.consumeAmmo()) {
          this.shootArrow(power * C.BOW_MAX_SPEED, power >= 1, true);
          this.events.push({ type: 'shoot', crossbow: false, power });
        }
      } else if (s.id === 'crossbow' && ticks >= C.CROSSBOW_CHARGE_TICKS && !s.charged && this.consumeAmmo()) {
        s.charged = true;
        this.events.push({ type: 'crossbowLoaded' });
      }
    }
    this.stopUsingItem();
  }

  stopUsingItem() {
    this.usingItem = false;
    this.useItemRemaining = 0;
    this.useId = null;
  }

  /** Online: mirrors the server's item-use state onto this fighter. */
  applyUseState(using: boolean, hand: Hand, remaining: number, duration: number) {
    const s = using ? this.stackIn(hand) : null;
    if (!s) {
      this.stopUsingItem();
      return;
    }
    this.usingItem = true;
    this.useHand = hand;
    this.useId = s.id;
    this.useItemRemaining = remaining;
    this.useItemDuration = duration;
  }

  /** Axe hit on a raised shield: every shield goes on a 5 s cooldown and drops. */
  disableShield() {
    this.shieldCooldown = C.SHIELD_DISABLE_TICKS;
    if (this.raisingShield()) this.stopUsingItem();
    this.events.push({ type: 'shieldDisabled' });
  }

  private shootArrow(speed: number, crit: boolean, addMotion: boolean) {
    const eyeY = this.pos.y + this.eyeHeight() - 0.1;
    const arrow = new Arrow(this, this.pos.x, eyeY, this.pos.z, crit);
    const d = this.look();
    arrow.shoot(d.x, d.y, d.z, speed, 1, this.world.rng);
    if (addMotion) {
      // BowItem uses shootFromRotation, which inherits the shooter's own movement.
      const mx = this.networked ? this.pos.x - this.prevPos.x : this.vel.x;
      const mz = this.networked ? this.pos.z - this.prevPos.z : this.vel.z;
      arrow.vel.x += mx;
      arrow.vel.z += mz;
      if (!this.onGround) arrow.vel.y += this.vel.y;
    }
    this.world.spawnArrow(arrow);
    this.stats.arrowsShot++;
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
    if (this.shieldCooldown > 0) this.shieldCooldown--;
    if (this.invulnerableTime > 0) this.invulnerableTime--;
    if (this.takeXpDelay > 0) this.takeXpDelay--;
    if (this.fireTicks > 0 && !this.dead) {
      if (this.fireTicks % 20 === 0) burn(this);
      this.fireTicks--;
    }
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
    // Equipment change detection: new attribute modifiers, and a fresh attack cooldown.
    const held = this.heldStack()?.id ?? null;
    if (held !== this.attrId) {
      this.resetAttackStrength();
      this.attrId = held;
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
    const stack = this.stackIn(this.useHand);
    // LivingEntity.updatingUsingItem: stop if the hand no longer holds what we started using.
    if (!stack || stack.id !== this.useId) {
      this.stopUsingItem();
      return;
    }
    const def = ITEMS[stack.id];
    if (def.use !== 'food') {
      this.useItemRemaining--;
      if (def.use === 'crossbow' && this.useTicks() === C.CROSSBOW_CHARGE_TICKS) this.events.push({ type: 'crossbowLoaded' });
      if (def.use === 'shield' && this.shieldCooldown > 0) this.stopUsingItem();
      return;
    }
    const food = def.food!;
    const i = this.useItemRemaining;
    if (i <= this.useItemDuration - 7 && i % 4 === 0) this.events.push({ type: 'eatTick' });
    if (--this.useItemRemaining <= 0) {
      this.food.eat(food.nutrition, food.saturationModifier);
      for (const e of food.effects) this.addEffect(e.id, e.amplifier, e.duration);
      stack.count--;
      if (stack.count <= 0) {
        if (this.useHand === 'main') this.inventory[this.selected] = null;
        else this.offhand = null;
      }
      this.stopUsingItem();
      if (def.id === 'golden_apple') this.stats.gapplesEaten++;
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

/** BowItem.getPowerForTime: 0..1 draw strength after `ticks` of pulling. */
export function bowPower(ticks: number): number {
  const f = ticks / C.BOW_FULL_DRAW_TICKS;
  return Math.min(1, (f * f + f * 2) / 3);
}
