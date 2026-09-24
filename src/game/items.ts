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
  | 'diamond_boots';
export type EffectId = 'regeneration' | 'absorption';

/** How an item behaves on right click. */
export type UseKind = 'none' | 'food' | 'shield' | 'bow' | 'crossbow';

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
  food?: FoodProps;
  armor?: ArmorProps;
}

/** Per-stack enchantments. Kits decide these, so the same sword can be plain or Sharpness V. */
export interface Enchants {
  sharpness?: number;
  protection?: number;
}

export interface ItemStack {
  id: ItemId;
  count: number;
  ench?: Enchants;
  /** Crossbow: loaded with an arrow. */
  charged?: boolean;
}

const MELEE_FIST = { attackDamage: FIST_DAMAGE, attackSpeed: FIST_ATTACK_SPEED };

function armor(id: ItemId, name: string, slot: ArmorSlot, points: number): ItemDef {
  return { id, name, maxStack: 1, ...MELEE_FIST, use: 'none', armor: { slot, points, toughness: 2, knockbackResistance: 0 } };
}

export const ITEMS: Record<ItemId, ItemDef> = {
  diamond_sword: { id: 'diamond_sword', name: 'Diamond Sword', maxStack: 1, attackDamage: 7, attackSpeed: 1.6, use: 'none', handheld: true },
  diamond_axe: {
    id: 'diamond_axe',
    name: 'Diamond Axe',
    maxStack: 1,
    attackDamage: 9,
    attackSpeed: 1.0,
    use: 'none',
    handheld: true,
    disablesShield: true,
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
  shield: { id: 'shield', name: 'Shield', maxStack: 1, ...MELEE_FIST, use: 'shield' },
  bow: { id: 'bow', name: 'Bow', maxStack: 1, ...MELEE_FIST, use: 'bow' },
  crossbow: { id: 'crossbow', name: 'Crossbow', maxStack: 1, ...MELEE_FIST, use: 'crossbow' },
  arrow: { id: 'arrow', name: 'Arrow', maxStack: 64, ...MELEE_FIST, use: 'none' },
  diamond_helmet: armor('diamond_helmet', 'Diamond Helmet', 0, 3),
  diamond_chestplate: armor('diamond_chestplate', 'Diamond Chestplate', 1, 8),
  diamond_leggings: armor('diamond_leggings', 'Diamond Leggings', 2, 6),
  diamond_boots: armor('diamond_boots', 'Diamond Boots', 3, 3),
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
  const e = stack?.ench;
  return !!e && ((e.sharpness ?? 0) > 0 || (e.protection ?? 0) > 0);
}

export function cloneStack(s: ItemStack | null | undefined): ItemStack | null {
  return s ? { ...s, ench: s.ench ? { ...s.ench } : undefined } : null;
}

/** Tooltip lines under the item name. */
export function stackLore(s: ItemStack): string[] {
  const out: string[] = [];
  const roman = ['', 'I', 'II', 'III', 'IV', 'V'];
  if (s.ench?.sharpness) out.push(`Sharpness ${roman[s.ench.sharpness] ?? s.ench.sharpness}`);
  if (s.ench?.protection) out.push(`Protection ${roman[s.ench.protection] ?? s.ench.protection}`);
  if (s.charged) out.push('Projectile: [Arrow]');
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
  }
  return out;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
