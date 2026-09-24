import { FIST_ATTACK_SPEED, FIST_DAMAGE, GOLDEN_APPLE_EAT_TICKS } from '../core/constants';

export type ItemId =
  | 'diamond_sword'
  | 'diamond_axe'
  | 'golden_apple'
  | 'shield'
  | 'bow'
  | 'crossbow'
  | 'arrow'
  | 'diamond_helmet'
  | 'diamond_chestplate'
  | 'diamond_leggings'
  | 'diamond_boots'
  | 'netherite_sword'
  | 'netherite_helmet'
  | 'netherite_chestplate'
  | 'netherite_leggings'
  | 'netherite_boots'
  | 'totem_of_undying'
  | 'splash_potion'
  | 'experience_bottle'
  | 'cooked_beef'
  | 'diamond_pickaxe'
  | 'golden_head'
  | 'water_bucket'
  | 'lava_bucket'
  | 'bucket'
  | 'oak_planks'
  | 'cobweb'
  | 'cobblestone'
  | 'obsidian'
  | 'end_crystal'
  | 'respawn_anchor'
  | 'glowstone'
  | 'ender_chest'
  | 'ender_pearl'
  | 'netherite_pickaxe'
  | 'netherite_axe'
  | 'mace'
  | 'wind_charge'
  | 'elytra'
  | 'tipped_arrow';
export type EffectId = 'regeneration' | 'absorption' | 'strength' | 'speed' | 'fire_resistance' | 'slow_falling';

/** How an item behaves on right click. */
export type UseKind = 'none' | 'food' | 'shield' | 'bow' | 'crossbow' | 'throw' | 'place' | 'bucket' | 'crystal' | 'equip';

/** Mining tool classes (the mineable/* block tags). */
export type ToolKind = 'axe' | 'pickaxe' | 'sword';

/** The splash potions NethPot uses (vanilla potion registry names in the comments). */
export type PotionId = 'strength' | 'swiftness' | 'fire_resistance' | 'healing' | 'regeneration' | 'slow_falling';

export interface PotionDef {
  id: PotionId;
  name: string;
  /** Liquid colour (MobEffect colour), tints item/potion_overlay. */
  color: number;
  /** A timed effect, or instant health (heals 4 << amplifier at full strength). */
  effect: EffectId | 'instant_health';
  amplifier: number;
  duration: number;
}

export const POTIONS: Record<PotionId, PotionDef> = {
  // strong_strength: Strength II, 1:30
  strength: { id: 'strength', name: 'Strength', color: 0xffc700, effect: 'strength', amplifier: 1, duration: 1800 },
  // strong_swiftness: Speed II, 1:30
  swiftness: { id: 'swiftness', name: 'Swiftness', color: 0x33ebff, effect: 'speed', amplifier: 1, duration: 1800 },
  // long_fire_resistance: Fire Resistance, 8:00
  fire_resistance: { id: 'fire_resistance', name: 'Fire Resistance', color: 0xff9900, effect: 'fire_resistance', amplifier: 0, duration: 9600 },
  // strong_healing: Instant Health II, 8 HP
  healing: { id: 'healing', name: 'Healing', color: 0xf82423, effect: 'instant_health', amplifier: 1, duration: 1 },
  // long_regeneration: Regeneration I, 1:30 (half a heart every 2.5 s)
  regeneration: { id: 'regeneration', name: 'Regeneration', color: 0xcd5cab, effect: 'regeneration', amplifier: 0, duration: 1800 },
  // long_slow_falling: 4:00 (a tipped arrow carries an eighth of it: 30 s)
  slow_falling: { id: 'slow_falling', name: 'Slow Falling', color: 0xf3cfb9, effect: 'slow_falling', amplifier: 0, duration: 4800 },
};

/** MobEffect colours (potion swirls). */
export const EFFECT_COLORS: Record<EffectId, number> = {
  regeneration: 0xcd5cab,
  absorption: 0x2552a5,
  strength: 0xffc700,
  speed: 0x33ebff,
  fire_resistance: 0xff9900,
  slow_falling: 0xf3cfb9,
};

export const EFFECT_NAMES: Record<EffectId, string> = {
  regeneration: 'Regeneration',
  absorption: 'Absorption',
  strength: 'Strength',
  speed: 'Speed',
  fire_resistance: 'Fire Resistance',
  slow_falling: 'Slow Falling',
};

/** Armor slot index: 0 head, 1 chest, 2 legs, 3 feet. */
export type ArmorSlot = 0 | 1 | 2 | 3;

export interface EffectSpec {
  id: EffectId;
  amplifier: number; // 0 = level I
  duration: number; // ticks
}

export interface FoodProps {
  nutrition: number;
  saturationModifier: number;
  useTicks: number;
  alwaysEdible: boolean;
  effects: EffectSpec[];
}

export interface ArmorProps {
  slot: ArmorSlot;
  points: number;
  toughness: number;
  knockbackResistance: number;
  /** Elytra: lets you glide while it is worn. */
  glider?: boolean;
}

export interface ItemDef {
  id: ItemId;
  name: string;
  maxStack: number;
  /** Attack damage attribute while held, including the player's base 1. */
  attackDamage: number;
  /** Attacks per second at full charge (attack_speed attribute). */
  attackSpeed: number;
  use: UseKind;
  /** Axes: a hit on a raised shield puts every shield on a 5 s cooldown. */
  disablesShield?: boolean;
  /** Rendered as a tool held diagonally (item/handheld) rather than a flat item. */
  handheld?: boolean;
  /** Durability. Missing = unbreakable. */
  maxDamage?: number;
  /** Durability lost per entity hit (swords 1, axes 2). */
  hitCost?: number;
  /** Mining: what it is a tool for, and its destroy speed on those blocks (diamond: 8). */
  tool?: ToolKind;
  toolSpeed?: number;
  /** Block item: the block (Blocks B.*) it places. */
  places?: number;
  /** Bucket contents: the fluid (Blocks B.WATER / B.LAVA), or 0 for an empty bucket. */
  bucket?: number;
  /** ItemCooldowns: ticks the item is unusable after being used (golden heads: 10 s). */
  cooldown?: number;
  food?: FoodProps;
  armor?: ArmorProps;
}

/** Per-stack enchantments. Kits decide these, so the same sword can be plain or Sharpness V. */
export interface Enchants {
  sharpness?: number;
  protection?: number;
  unbreaking?: number;
  fireAspect?: number;
  mending?: number;
  efficiency?: number;
  power?: number;
  piercing?: number;
  blastProtection?: number;
  featherFalling?: number;
  knockback?: number;
  multishot?: number;
  quickCharge?: number;
  silkTouch?: number;
  /** Mace: +0.5 smash damage per level per block fallen. */
  density?: number;
  /** Mace: the target's armor protects 15% less (absolute) per level. */
  breach?: number;
  /** Mace: a smash hit launches you back up (knockback ×1.2 / 1.75 / 2.2). */
  windBurst?: number;
  /** Sweep attacks hit others near your target for 1 + level/(level+1) of the damage. */
  sweepingEdge?: number;
  /** Sneaking speed 30% + 15% per level. */
  swiftSneak?: number;
}

export interface ItemStack {
  id: ItemId;
  count: number;
  ench?: Enchants;
  /** Crossbow: loaded with an arrow. */
  charged?: boolean;
  /** Crossbow: the loaded arrow was tipped with this potion. */
  chargedPotion?: PotionId;
  /** Splash potion contents. */
  potion?: PotionId;
  /** Durability used up (ItemStack damage value). */
  damage?: number;
}

const MELEE_FIST = { attackDamage: FIST_DAMAGE, attackSpeed: FIST_ATTACK_SPEED };

function armor(id: ItemId, name: string, slot: ArmorSlot, points: number, maxDamage: number, toughness = 2, knockbackResistance = 0): ItemDef {
  // Right click with armor in hand swaps it with what you are wearing (1.19.4+).
  return { id, name, maxStack: 1, ...MELEE_FIST, use: 'equip', maxDamage, armor: { slot, points, toughness, knockbackResistance } };
}

export const ITEMS: Record<ItemId, ItemDef> = {
  diamond_sword: { id: 'diamond_sword', name: 'Diamond Sword', maxStack: 1, attackDamage: 7, attackSpeed: 1.6, use: 'none', handheld: true, maxDamage: 1561, hitCost: 1, tool: 'sword', toolSpeed: 15 },
  netherite_sword: { id: 'netherite_sword', name: 'Netherite Sword', maxStack: 1, attackDamage: 8, attackSpeed: 1.6, use: 'none', handheld: true, maxDamage: 2031, hitCost: 1, tool: 'sword', toolSpeed: 15 },
  netherite_pickaxe: { id: 'netherite_pickaxe', name: 'Netherite Pickaxe', maxStack: 1, attackDamage: 6, attackSpeed: 1.2, use: 'none', handheld: true, maxDamage: 2031, hitCost: 2, tool: 'pickaxe', toolSpeed: 9 },
  diamond_pickaxe: { id: 'diamond_pickaxe', name: 'Diamond Pickaxe', maxStack: 1, attackDamage: 5, attackSpeed: 1.2, use: 'none', handheld: true, maxDamage: 1561, hitCost: 2, tool: 'pickaxe', toolSpeed: 8 },
  diamond_axe: {
    id: 'diamond_axe',
    name: 'Diamond Axe',
    maxStack: 1,
    attackDamage: 9,
    attackSpeed: 1.0,
    use: 'none',
    handheld: true,
    disablesShield: true,
    maxDamage: 1561,
    hitCost: 2,
    tool: 'axe',
    toolSpeed: 8,
  },
  // Mace: 6 attack damage, 0.6 attack speed (a 33-tick cooldown); smash attacks while falling.
  mace: { id: 'mace', name: 'Mace', maxStack: 1, attackDamage: 6, attackSpeed: 0.6, use: 'none', handheld: true, maxDamage: 500, hitCost: 1 },
  // Wind charge: thrown straight (no gravity), bursts on impact; 0.5 s cooldown.
  wind_charge: { id: 'wind_charge', name: 'Wind Charge', maxStack: 64, ...MELEE_FIST, use: 'throw', cooldown: 10 },
  elytra: {
    id: 'elytra',
    name: 'Elytra',
    maxStack: 1,
    ...MELEE_FIST,
    use: 'equip',
    maxDamage: 432,
    armor: { slot: 1, points: 0, toughness: 0, knockbackResistance: 0, glider: true },
  },
  // Netherite axe: 10 attack damage, 1.0 attack speed (a 20-tick cooldown); disables shields.
  netherite_axe: {
    id: 'netherite_axe',
    name: 'Netherite Axe',
    maxStack: 1,
    attackDamage: 10,
    attackSpeed: 1.0,
    use: 'none',
    handheld: true,
    disablesShield: true,
    maxDamage: 2031,
    hitCost: 2,
    tool: 'axe',
    toolSpeed: 9,
  },
  golden_apple: {
    id: 'golden_apple',
    name: 'Golden Apple',
    maxStack: 64,
    ...MELEE_FIST,
    use: 'food',
    food: {
      nutrition: 4,
      saturationModifier: 1.2, // +9.6 saturation
      useTicks: GOLDEN_APPLE_EAT_TICKS,
      alwaysEdible: true,
      effects: [
        { id: 'regeneration', amplifier: 1, duration: 100 }, // Regeneration II, 5 s
        { id: 'absorption', amplifier: 0, duration: 2400 }, // Absorption I, 2 min
      ],
    },
  },
  shield: { id: 'shield', name: 'Shield', maxStack: 1, ...MELEE_FIST, use: 'shield', maxDamage: 336 },
  bow: { id: 'bow', name: 'Bow', maxStack: 1, ...MELEE_FIST, use: 'bow' },
  crossbow: { id: 'crossbow', name: 'Crossbow', maxStack: 1, ...MELEE_FIST, use: 'crossbow' },
  arrow: { id: 'arrow', name: 'Arrow', maxStack: 64, ...MELEE_FIST, use: 'none' },
  diamond_helmet: armor('diamond_helmet', 'Diamond Helmet', 0, 3, 363),
  diamond_chestplate: armor('diamond_chestplate', 'Diamond Chestplate', 1, 8, 528),
  diamond_leggings: armor('diamond_leggings', 'Diamond Leggings', 2, 6, 495),
  diamond_boots: armor('diamond_boots', 'Diamond Boots', 3, 3, 429),
  // Netherite: +1 toughness over diamond and 0.1 knockback resistance per piece (40% for a set).
  netherite_helmet: armor('netherite_helmet', 'Netherite Helmet', 0, 3, 407, 3, 0.1),
  netherite_chestplate: armor('netherite_chestplate', 'Netherite Chestplate', 1, 8, 592, 3, 0.1),
  netherite_leggings: armor('netherite_leggings', 'Netherite Leggings', 2, 6, 555, 3, 0.1),
  netherite_boots: armor('netherite_boots', 'Netherite Boots', 3, 3, 481, 3, 0.1),
  totem_of_undying: { id: 'totem_of_undying', name: 'Totem of Undying', maxStack: 1, ...MELEE_FIST, use: 'none' },
  splash_potion: { id: 'splash_potion', name: 'Splash Potion', maxStack: 1, ...MELEE_FIST, use: 'throw' },
  experience_bottle: { id: 'experience_bottle', name: "Bottle o' Enchanting", maxStack: 64, ...MELEE_FIST, use: 'throw' },
  golden_head: {
    id: 'golden_head',
    name: 'Golden Head',
    maxStack: 64,
    ...MELEE_FIST,
    use: 'food',
    // Server item (UHC tier tests): 1 s to eat, Regeneration III 5 s (4 hearts), Absorption I 2 min, 10 s cooldown.
    food: {
      nutrition: 4,
      saturationModifier: 1.2,
      useTicks: 20,
      alwaysEdible: true,
      effects: [
        { id: 'regeneration', amplifier: 2, duration: 100 },
        { id: 'absorption', amplifier: 0, duration: 2400 },
      ],
    },
    cooldown: 200,
  },
  water_bucket: { id: 'water_bucket', name: 'Water Bucket', maxStack: 1, ...MELEE_FIST, use: 'bucket', bucket: 6 },
  lava_bucket: { id: 'lava_bucket', name: 'Lava Bucket', maxStack: 1, ...MELEE_FIST, use: 'bucket', bucket: 7 },
  bucket: { id: 'bucket', name: 'Bucket', maxStack: 16, ...MELEE_FIST, use: 'bucket', bucket: 0 },
  oak_planks: { id: 'oak_planks', name: 'Oak Planks', maxStack: 64, ...MELEE_FIST, use: 'place', places: 1 },
  cobweb: { id: 'cobweb', name: 'Cobweb', maxStack: 64, ...MELEE_FIST, use: 'place', places: 2 },
  cobblestone: { id: 'cobblestone', name: 'Cobblestone', maxStack: 64, ...MELEE_FIST, use: 'place', places: 3 },
  obsidian: { id: 'obsidian', name: 'Obsidian', maxStack: 64, ...MELEE_FIST, use: 'place', places: 4 },
  glowstone: { id: 'glowstone', name: 'Glowstone', maxStack: 64, ...MELEE_FIST, use: 'place', places: 8 },
  respawn_anchor: { id: 'respawn_anchor', name: 'Respawn Anchor', maxStack: 64, ...MELEE_FIST, use: 'place', places: 9 },
  ender_chest: { id: 'ender_chest', name: 'Ender Chest', maxStack: 64, ...MELEE_FIST, use: 'place', places: 10 },
  end_crystal: { id: 'end_crystal', name: 'End Crystal', maxStack: 64, ...MELEE_FIST, use: 'crystal' },
  // Thrown like a potion (speed 1.5, gravity 0.03); 1 s cooldown; lands you where it hits for 5 fall damage.
  ender_pearl: { id: 'ender_pearl', name: 'Ender Pearl', maxStack: 16, ...MELEE_FIST, use: 'throw', cooldown: 20 },
  tipped_arrow: { id: 'tipped_arrow', name: 'Tipped Arrow', maxStack: 64, ...MELEE_FIST, use: 'none' },
  cooked_beef: {
    id: 'cooked_beef',
    name: 'Steak',
    maxStack: 64,
    ...MELEE_FIST,
    use: 'food',
    // 8 hunger, 12.8 saturation, 1.6 s; only edible when you are hungry.
    food: { nutrition: 8, saturationModifier: 0.8, useTicks: 32, alwaysEdible: false, effects: [] },
  },
};

export const FIST: ItemDef = { id: 'arrow', name: 'Hand', maxStack: 0, ...MELEE_FIST, use: 'none' };

export function defOf(stack: ItemStack | null | undefined): ItemDef {
  return stack ? ITEMS[stack.id] : FIST;
}

/** Sharpness adds 0.5 * level + 0.5 damage in Java Edition (Sharpness V = +3). */
export function sharpnessBonus(level: number): number {
  return level > 0 ? 0.5 * level + 0.5 : 0;
}

export function isEnchanted(stack: ItemStack | null | undefined): boolean {
  if (stack?.id === 'experience_bottle') return true; // always glints
  const e = stack?.ench;
  if (!e) return false;
  for (const k in e) if ((e[k as keyof Enchants] ?? 0) > 0) return true;
  return false;
}

export function cloneStack(s: ItemStack | null | undefined): ItemStack | null {
  return s ? { ...s, ench: s.ench ? { ...s.ench } : undefined } : null;
}

/** ItemStack.isSameItemSameComponents: the stacks could merge. */
export function sameItem(a: ItemStack, b: ItemStack): boolean {
  return (
    a.id === b.id &&
    !!a.charged === !!b.charged &&
    a.potion === b.potion &&
    (a.damage ?? 0) === (b.damage ?? 0) &&
    JSON.stringify(a.ench ?? {}) === JSON.stringify(b.ench ?? {})
  );
}

/** Display name, e.g. "Splash Potion of Healing". */
export function stackName(s: ItemStack): string {
  if (s.id === 'splash_potion' && s.potion) return `Splash Potion of ${POTIONS[s.potion].name}`;
  if (s.id === 'tipped_arrow' && s.potion) return `Arrow of ${POTIONS[s.potion].name}`;
  return ITEMS[s.id].name;
}

/** Durability left as 0..1, or null for items without durability (or undamaged ones). */
export function durabilityFraction(s: ItemStack | null | undefined): number | null {
  const max = s ? ITEMS[s.id].maxDamage : undefined;
  if (!s || !max || !s.damage) return null;
  return Math.max(0, 1 - s.damage / max);
}

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];
const roman = (n: number) => ROMAN[n] ?? String(n);

export function formatTicks(t: number): string {
  const sec = Math.max(0, Math.ceil(t / 20));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** Tooltip lines under the item name. */
export function stackLore(s: ItemStack): string[] {
  const out: string[] = [];
  const e = s.ench;
  if (e?.sharpness) out.push(`Sharpness ${roman(e.sharpness)}`);
  if (e?.protection) out.push(`Protection ${roman(e.protection)}`);
  if (e?.fireAspect) out.push(`Fire Aspect ${roman(e.fireAspect)}`);
  if (e?.blastProtection) out.push(`Blast Protection ${roman(e.blastProtection)}`);
  if (e?.featherFalling) out.push(`Feather Falling ${roman(e.featherFalling)}`);
  if (e?.knockback) out.push(`Knockback ${roman(e.knockback)}`);
  if (e?.sweepingEdge) out.push(`Sweeping Edge ${roman(e.sweepingEdge)}`);
  if (e?.density) out.push(`Density ${roman(e.density)}`);
  if (e?.breach) out.push(`Breach ${roman(e.breach)}`);
  if (e?.windBurst) out.push(`Wind Burst ${roman(e.windBurst)}`);
  if (e?.swiftSneak) out.push(`Swift Sneak ${roman(e.swiftSneak)}`);
  if (e?.efficiency) out.push(`Efficiency ${roman(e.efficiency)}`);
  if (e?.silkTouch) out.push('Silk Touch');
  if (e?.multishot) out.push('Multishot');
  if (e?.quickCharge) out.push(`Quick Charge ${roman(e.quickCharge)}`);
  if (e?.power) out.push(`Power ${roman(e.power)}`);
  if (e?.piercing) out.push(`Piercing ${roman(e.piercing)}`);
  if (e?.unbreaking) out.push(`Unbreaking ${roman(e.unbreaking)}`);
  if (e?.mending) out.push('Mending');
  if (s.charged) out.push('Projectile: [Arrow]');
  if (s.potion && s.id === 'tipped_arrow') {
    out.push(`${EFFECT_NAMES[POTIONS[s.potion].effect as EffectId]} (${formatTicks(POTIONS[s.potion].duration / 8)})`);
  } else if (s.potion) {
    const p = POTIONS[s.potion];
    const lvl = p.amplifier > 0 ? ` ${roman(p.amplifier + 1)}` : '';
    if (p.effect === 'instant_health') out.push(`Instant Health${lvl}`);
    else out.push(`${EFFECT_NAMES[p.effect]}${lvl} (${formatTicks(p.duration)})`);
    if (p.effect === 'strength' || p.effect === 'speed') {
      out.push('');
      out.push('When Applied:');
      out.push(p.effect === 'strength' ? ` +${3 * (p.amplifier + 1)} Attack Damage` : ` +${20 * (p.amplifier + 1)}% Speed`);
    }
  }
  const def = ITEMS[s.id];
  if (def.handheld) {
    out.push('');
    out.push('When in Main Hand:');
    const sharp = sharpnessBonus(s.ench?.sharpness ?? 0);
    out.push(` ${fmt(def.attackDamage + sharp)} Attack Damage`);
    out.push(` ${fmt(def.attackSpeed)} Attack Speed`);
  }
  if (def.armor) {
    out.push('');
    out.push(`When on ${['Head', 'Body', 'Legs', 'Feet'][def.armor.slot]}:`);
    out.push(` +${def.armor.points} Armor`);
    out.push(` +${def.armor.toughness} Armor Toughness`);
    if (def.armor.knockbackResistance) out.push(` +${Math.round(def.armor.knockbackResistance * 10)} Knockback Resistance`);
  }
  if (def.maxDamage && s.damage) out.push(`Durability: ${def.maxDamage - s.damage} / ${def.maxDamage}`);
  return out;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
