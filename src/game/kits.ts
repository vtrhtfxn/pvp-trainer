import { ITEMS, type ItemStack } from './items';

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
}

export interface KitDef extends Loadout {
  id: KitId;
  name: string;
  icon: KitIcon;
  available: boolean;
  summary: string;
  contents: string[];
  armorLabel: string;
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
  soon('diamond_pot', 'Diamond Pot', 'potion', 'Splash healing in diamond gear.'),
  soon('neth_pot', 'NethPot', 'neth_potion', 'Netherite gear with potions.'),
  soon('crystal', 'Crystal', 'crystal', 'End crystals and anchors.'),
  soon('smp', 'SMP', 'smp', 'Full SMP loadout, no explosives.'),
  soon('mace', 'Mace', 'mace', 'Wind charges and smash attacks.'),
];

export function kitById(id: KitId): KitDef {
  return KITS.find((k) => k.id === id) ?? KITS[0];
}
