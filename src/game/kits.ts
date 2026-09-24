import { ITEMS, type ItemStack, type PotionId } from './items';

export interface ArmorStats {
  points: number;
  toughness: number;
  /** Enchantment protection factor: Protection IV gives 4 per piece, capped at 20. */
  protectionEpf: number;
  knockbackResistance: number;
}

export type KitId = 'sword' | 'axe' | 'uhc' | 'diamond_pot' | 'neth_pot' | 'crystal' | 'smp' | 'mace';
export type KitIcon = 'sword' | 'axe' | 'uhc' | 'potion' | 'neth_potion' | 'crystal' | 'smp' | 'mace';

/** Everything a fighter spawns with. */
export interface Loadout {
  /** Hotbar slots 0–8. */
  hotbar: (ItemStack | null)[];
  /** Head, chest, legs, feet. */
  armor: (ItemStack | null)[];
  offhand: ItemStack | null;
  /** Main inventory slots 9–35 (index 0 = slot 9). */
  main?: (ItemStack | null)[];
}

export interface KitDef extends Loadout {
  id: KitId;
  name: string;
  icon: KitIcon;
  available: boolean;
  summary: string;
  contents: string[];
  armorLabel: string;
  /**
   * Server-side damage multiplier some kits run with (Diamond Pot: +33%). Applied to the raw
   * damage before armor, like a plugin changing the base damage of every hit.
   */
  damageMultiplier?: number;
}

/** Sums armor points, toughness and Protection from the pieces actually worn. */
export function armorStatsOf(pieces: readonly (ItemStack | null)[]): ArmorStats {
  const out: ArmorStats = { points: 0, toughness: 0, protectionEpf: 0, knockbackResistance: 0 };
  for (const s of pieces) {
    const a = s ? ITEMS[s.id].armor : undefined;
    if (!s || !a) continue;
    out.points += a.points;
    out.toughness += a.toughness;
    out.knockbackResistance += a.knockbackResistance;
    out.protectionEpf += s.ench?.protection ?? 0;
  }
  return out;
}

function diamondArmor(protection: number): (ItemStack | null)[] {
  const ench = protection ? { protection } : undefined;
  return (['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'] as const).map((id) => ({ id, count: 1, ench }));
}

function netheriteArmor(): (ItemStack | null)[] {
  const ench = { protection: 4, unbreaking: 3, mending: 1 };
  return (['netherite_helmet', 'netherite_chestplate', 'netherite_leggings', 'netherite_boots'] as const).map((id) => ({ id, count: 1, ench: { ...ench } }));
}

const pot = (potion: PotionId): ItemStack => ({ id: 'splash_potion', count: 1, potion });

/**
 * The NethPot layout from a tier-test inventory: sword, totem, gapples and healing in the
 * hotbar; a spare totem, two stacks of XP and the buff potions in the inventory; a totem in
 * the off hand. Every empty slot is filled with Splash Healing II.
 */
function nethPotLoadout(): Loadout {
  const heal = () => pot('healing');
  const hotbar: ItemStack[] = [
    { id: 'netherite_sword', count: 1, ench: { sharpness: 5, fireAspect: 2, unbreaking: 3, mending: 1 } },
    { id: 'totem_of_undying', count: 1 },
    { id: 'golden_apple', count: 64 },
    pot('strength'),
    pot('swiftness'),
    heal(),
    heal(),
    heal(),
    heal(),
  ];
  const main: ItemStack[] = [
    { id: 'totem_of_undying', count: 1 },
    pot('strength'),
    pot('strength'),
    pot('swiftness'),
    pot('swiftness'),
    pot('fire_resistance'),
    pot('fire_resistance'),
    pot('fire_resistance'),
    heal(),
    { id: 'experience_bottle', count: 64 },
    ...Array.from({ length: 8 }, heal),
    { id: 'experience_bottle', count: 64 },
    ...Array.from({ length: 8 }, heal),
  ];
  return { hotbar, main, armor: netheriteArmor(), offhand: { id: 'totem_of_undying', count: 1 } };
}

/**
 * The Pot PvP layout: Sharpness V diamond sword and 8 Splash Healing II in the hotbar, 18 more
 * healing plus three sets of buffs (Strength II, Speed II, Regeneration — all 1:30) in the
 * inventory, 5 steak in the off hand.
 */
function diamondPotLoadout(): Loadout {
  const heal = () => pot('healing');
  const hotbar: ItemStack[] = [{ id: 'diamond_sword', count: 1, ench: { sharpness: 5 } }, ...Array.from({ length: 8 }, heal)];
  const main: ItemStack[] = [];
  for (let row = 0; row < 3; row++) main.push(...Array.from({ length: 6 }, heal), pot('strength'), pot('swiftness'), pot('regeneration'));
  const armor = diamondArmor(4).map((s) => ({ ...s!, ench: { protection: 4, unbreaking: 3 } }));
  return { hotbar, main, armor, offhand: { id: 'cooked_beef', count: 5 } };
}

function soon(id: KitId, name: string, icon: KitIcon, summary: string): KitDef {
  return { id, name, icon, available: false, summary, contents: [], hotbar: [], armor: [], offhand: null, armorLabel: '' };
}

export const KITS: KitDef[] = [
  {
    id: 'sword',
    name: 'Sword',
    icon: 'sword',
    available: true,
    summary: 'Pure sword combos, crits, W-taps and spacing.',
    contents: ['Diamond Sword — Sharpness V', 'Full Diamond Armor — Protection IV', '5× Golden Apple'],
    hotbar: [
      { id: 'diamond_sword', count: 1, ench: { sharpness: 5 } },
      { id: 'golden_apple', count: 5 },
    ],
    armor: diamondArmor(4),
    offhand: null,
    armorLabel: 'Diamond · Prot IV',
  },
  {
    id: 'axe',
    name: 'Axe',
    icon: 'axe',
    available: true,
    summary: 'Shield play: block, disable shields with the axe, punish with the sword.',
    contents: [
      'Diamond Axe · Diamond Sword',
      'Shield (off hand)',
      'Crossbow · Bow · 6× Arrow',
      'Full Diamond Armor (unenchanted)',
    ],
    hotbar: [
      { id: 'diamond_axe', count: 1 },
      { id: 'diamond_sword', count: 1 },
      { id: 'crossbow', count: 1 },
      { id: 'bow', count: 1 },
      { id: 'arrow', count: 6 },
    ],
    armor: diamondArmor(0),
    offhand: { id: 'shield', count: 1 },
    armorLabel: 'Diamond',
  },
  soon('uhc', 'UHC', 'uhc', 'No natural regen, lava, water and webs.'),
  {
    id: 'diamond_pot',
    name: 'Diamond Pot',
    icon: 'potion',
    available: true,
    summary: 'Combo game: Speed II and Strength II to trap, escape and run-pot.',
    contents: [
      'Diamond Sword — Sharpness V',
      'Diamond Armor — Protection IV, Unbreaking III',
      '26× Splash Healing II · 5× Steak (off hand)',
      '3× Strength II · 3× Speed II · 3× Regeneration (all 1:30)',
      'All damage +33%',
    ],
    ...diamondPotLoadout(),
    armorLabel: 'Diamond · Prot IV',
    damageMultiplier: 1.33,
  },
  {
    id: 'neth_pot',
    name: 'NethPot',
    icon: 'neth_potion',
    available: true,
    summary: 'Netherite, splash pots and totems: crits, P-crits, pot and re-totem.',
    contents: [
      'Netherite Sword — Sharp V, Fire Aspect II, Unbreaking III, Mending',
      'Netherite Armor — Prot IV, Unbreaking III, Mending',
      '3× Totem (one in the off hand) · 64× Golden Apple',
      '3× Strength II · 3× Speed II · 3× Fire Res (8:00)',
      '21× Splash Healing II · 128× Bottle o\' Enchanting',
    ],
    ...nethPotLoadout(),
    armorLabel: 'Netherite · Prot IV',
  },
  soon('crystal', 'Crystal', 'crystal', 'End crystals and anchors.'),
  soon('smp', 'SMP', 'smp', 'Full SMP loadout, no explosives.'),
  soon('mace', 'Mace', 'mace', 'Wind charges and smash attacks.'),
];

export function kitById(id: KitId): KitDef {
  return KITS.find((k) => k.id === id) ?? KITS[0];
}
