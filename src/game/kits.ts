import type { ItemStack } from './items';

export interface ArmorStats {
  points: number;
  toughness: number;
  /** Enchantment protection factor: Protection IV gives 4 per piece, capped at 20. */
  protectionEpf: number;
  knockbackResistance: number;
}

export type KitId = 'sword' | 'axe' | 'uhc' | 'diamond_pot' | 'neth_pot' | 'crystal' | 'smp' | 'mace';
export type KitIcon = 'sword' | 'axe' | 'uhc' | 'potion' | 'neth_potion' | 'crystal' | 'smp' | 'mace';

export interface KitDef {
  id: KitId;
  name: string;
  icon: KitIcon;
  available: boolean;
  summary: string;
  contents: string[];
  hotbar: (ItemStack | null)[];
  armor: ArmorStats;
  armorLabel: string;
}

const DIAMOND_PROT4: ArmorStats = { points: 20, toughness: 8, protectionEpf: 16, knockbackResistance: 0 };

function soon(id: KitId, name: string, icon: KitIcon, summary: string): KitDef {
  return { id, name, icon, available: false, summary, contents: [], hotbar: [], armor: DIAMOND_PROT4, armorLabel: '' };
}

export const KITS: KitDef[] = [
  {
    id: 'sword',
    name: 'Sword',
    icon: 'sword',
    available: true,
    summary: 'Pure sword combos, crits, W-taps and spacing.',
    contents: [
      'Diamond Sword — Sharpness V',
      'Full Diamond Armor — Protection IV',
      '5× Golden Apple',
    ],
    hotbar: [
      { id: 'diamond_sword', count: 1 },
      { id: 'golden_apple', count: 5 },
    ],
    armor: DIAMOND_PROT4,
    armorLabel: 'Diamond · Prot IV',
  },
  soon('axe', 'Axe', 'axe', 'Shield disables and axe crits.'),
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
