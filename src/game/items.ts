import { FIST_ATTACK_SPEED, FIST_DAMAGE, GOLDEN_APPLE_EAT_TICKS } from '../core/constants';

export type ItemId = 'diamond_sword' | 'golden_apple';
export type EffectId = 'regeneration' | 'absorption';

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

export interface ItemDef {
  id: ItemId;
  name: string;
  lore?: string;
  maxStack: number;
  /** Attack damage attribute while held, including the player's base 1. */
  attackDamage: number;
  /** Attacks per second at full charge (attack_speed attribute). */
  attackSpeed: number;
  sharpness: number;
  knockback: number;
  enchanted: boolean;
  food?: FoodProps;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  diamond_sword: {
    id: 'diamond_sword',
    name: 'Diamond Sword',
    lore: 'Sharpness V',
    maxStack: 1,
    attackDamage: 7,
    attackSpeed: 1.6,
    sharpness: 5,
    knockback: 0,
    enchanted: true,
  },
  golden_apple: {
    id: 'golden_apple',
    name: 'Golden Apple',
    maxStack: 64,
    attackDamage: FIST_DAMAGE,
    attackSpeed: FIST_ATTACK_SPEED,
    sharpness: 0,
    knockback: 0,
    enchanted: false,
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
};

export const FIST: ItemDef = {
  id: 'golden_apple', // never used as an id; only the combat stats matter
  name: 'Hand',
  maxStack: 0,
  attackDamage: FIST_DAMAGE,
  attackSpeed: FIST_ATTACK_SPEED,
  sharpness: 0,
  knockback: 0,
  enchanted: false,
};

export interface ItemStack {
  id: ItemId;
  count: number;
}

/** Sharpness adds 0.5 * level + 0.5 damage in Java Edition (Sharpness V = +3). */
export function sharpnessBonus(level: number): number {
  return level > 0 ? 0.5 * level + 0.5 : 0;
}
