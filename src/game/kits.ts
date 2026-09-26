import { ITEMS, type ItemStack, type PotionId } from './items';

export interface ArmorStats {
  points: number;
  toughness: number;
  /** Enchantment protection factor: Protection IV gives 4 per piece, capped at 20. */
  protectionEpf: number;
  /** Extra EPF against explosions only: Blast Protection gives 2 per level. */
  blastEpf: number;
  /** Extra EPF against falls only: Feather Falling gives 3 per level. */
  fallEpf: number;
  knockbackResistance: number;
  /** explosion_knockback_resistance: Blast Protection adds 0.15 per level, stacking (1.21). */
  explosionKnockbackResistance: number;
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
  /** UHC: health only comes back from golden apples and heads. */
  naturalRegen?: boolean;
  /** mcpvp.club "stuns": a shield disable clears hurt immunity for an instant follow-up. */
  shieldStuns?: boolean;
  /** Layers of diggable ground (grass over dirt) that explosions crater; 0 = unbreakable floor. */
  floorDepth?: number;
  /**
   * Hunger stays full (like duel servers with hunger off), so nobody loses their sprint in a long
   * fight. Saturation still runs down, so natural regeneration slows to vanilla's 1 HP / 4 s.
   */
  noHunger?: boolean;
}

/** Sums armor points, toughness and Protection from the pieces actually worn. */
export function armorStatsOf(pieces: readonly (ItemStack | null)[]): ArmorStats {
  const out: ArmorStats = { points: 0, toughness: 0, protectionEpf: 0, blastEpf: 0, fallEpf: 0, knockbackResistance: 0, explosionKnockbackResistance: 0 };
  for (const s of pieces) {
    const a = s ? ITEMS[s.id].armor : undefined;
    if (!s || !a) continue;
    out.points += a.points;
    out.toughness += a.toughness;
    out.knockbackResistance += a.knockbackResistance;
    out.protectionEpf += s.ench?.protection ?? 0;
    out.blastEpf += 2 * (s.ench?.blastProtection ?? 0);
    out.fallEpf += 3 * (s.ench?.featherFalling ?? 0);
    out.explosionKnockbackResistance += 0.15 * (s.ench?.blastProtection ?? 0);
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
 * The Mace tier-test kit, laid out as in the reference inventory: sword, axe, the Density/Wind
 * Burst mace, elytra, wind charges, the Breach mace, shield, gapples and pearls in the hotbar; a
 * totem in the off hand; potions, a second stack each of gapples and wind charges, three more
 * stacks of pearls and a spare totem in the inventory.
 */
function maceLoadout(): Loadout {
  const ub = { unbreaking: 3 };
  const armor: ItemStack[] = [
    { id: 'netherite_helmet', count: 1, ench: { protection: 4, ...ub } },
    { id: 'netherite_chestplate', count: 1, ench: { protection: 4, ...ub } },
    { id: 'netherite_leggings', count: 1, ench: { protection: 4, ...ub } },
    { id: 'netherite_boots', count: 1, ench: { protection: 4, ...ub } },
  ];
  const hotbar: ItemStack[] = [
    { id: 'netherite_sword', count: 1, ench: { sharpness: 5, ...ub } },
    { id: 'netherite_axe', count: 1, ench: { sharpness: 5, ...ub } },
    { id: 'mace', count: 1, ench: { density: 5, windBurst: 3, ...ub } },
    { id: 'elytra', count: 1 },
    { id: 'wind_charge', count: 64 },
    { id: 'mace', count: 1, ench: { breach: 4, ...ub } },
    { id: 'shield', count: 1, ench: ub },
    { id: 'golden_apple', count: 64 },
    { id: 'ender_pearl', count: 16 },
  ];
  const S = () => pot('strength');
  const V = () => pot('swiftness');
  const pearl = (): ItemStack => ({ id: 'ender_pearl', count: 16 });
  const main: ItemStack[] = [
    S(), V(), S(), { id: 'golden_apple', count: 64 }, { id: 'totem_of_undying', count: 1 }, { id: 'wind_charge', count: 64 }, S(), V(), S(),
    S(), V(), S(), pearl(), pearl(), pearl(), S(), V(), S(),
    S(), V(), S(), V(), S(), V(), S(), V(), S(),
  ];
  return { hotbar, main, armor, offhand: { id: 'totem_of_undying', count: 1 } };
}

/**
 * The SMP tier-test kit, laid out as in the reference inventory: sword, gapples, pearls, axe,
 * the knockback sword, one of each buff and the totem in the hotbar; the shield in the off hand;
 * the rest of the potions, a stack of XP and the second stacks of gapples and pearls in the
 * inventory.
 */
function smpLoadout(): Loadout {
  const keep = { unbreaking: 3, mending: 1 };
  const armor: ItemStack[] = [
    { id: 'netherite_helmet', count: 1, ench: { protection: 4, ...keep } },
    { id: 'netherite_chestplate', count: 1, ench: { protection: 4, ...keep } },
    { id: 'netherite_leggings', count: 1, ench: { protection: 4, swiftSneak: 3, ...keep } },
    { id: 'netherite_boots', count: 1, ench: { protection: 4, featherFalling: 4, ...keep } },
  ];
  const sword = { sharpness: 5, fireAspect: 2, sweepingEdge: 3 };
  const hotbar: ItemStack[] = [
    { id: 'netherite_sword', count: 1, ench: sword },
    { id: 'golden_apple', count: 64 },
    { id: 'ender_pearl', count: 16 },
    { id: 'netherite_axe', count: 1, ench: { sharpness: 5 } },
    { id: 'netherite_sword', count: 1, ench: { ...sword, knockback: 1 } },
    pot('strength'),
    pot('swiftness'),
    pot('fire_resistance'),
    { id: 'totem_of_undying', count: 1 },
  ];
  const main: ItemStack[] = [
    ...Array.from({ length: 9 }, () => pot('strength')),
    ...Array.from({ length: 9 }, () => pot('swiftness')),
    { id: 'experience_bottle', count: 64 },
    { id: 'golden_apple', count: 64 },
    { id: 'ender_pearl', count: 16 },
    pot('strength'),
    pot('strength'),
    pot('swiftness'),
    pot('swiftness'),
    pot('fire_resistance'),
    pot('fire_resistance'),
  ];
  return { hotbar, main, armor, offhand: { id: 'shield', count: 1, ench: keep } };
}

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

/**
 * The UHC tier-test kit, laid out as on mcpvp.club: sword, axe, golden heads, gapples, water,
 * lava, crossbow, planks and webs in the hotbar; shield in the off hand; spare buckets, arrows,
 * bow, pickaxe and a second stack of planks in the inventory.
 */
function uhcLoadout(): Loadout {
  const prot = [3, 2, 2, 3];
  const armor = (['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'] as const).map((id, i) => ({
    id,
    count: 1,
    ench: { protection: prot[i] },
  }));
  const hotbar: ItemStack[] = [
    { id: 'diamond_sword', count: 1, ench: { sharpness: 3 } },
    { id: 'diamond_axe', count: 1, ench: { efficiency: 3 } },
    { id: 'golden_head', count: 2 },
    { id: 'golden_apple', count: 8 },
    { id: 'water_bucket', count: 1 },
    { id: 'lava_bucket', count: 1 },
    { id: 'crossbow', count: 1, ench: { piercing: 1 } },
    { id: 'oak_planks', count: 64 },
    { id: 'cobweb', count: 8 },
  ];
  const main: (ItemStack | null)[] = new Array(27).fill(null);
  main[3] = { id: 'water_bucket', count: 1 };
  main[4] = { id: 'water_bucket', count: 1 };
  main[5] = { id: 'water_bucket', count: 1 };
  main[8] = { id: 'arrow', count: 10 };
  main[13] = { id: 'lava_bucket', count: 1 };
  main[17] = { id: 'bow', count: 1, ench: { power: 1 } };
  main[22] = { id: 'diamond_pickaxe', count: 1, ench: { efficiency: 3 } };
  main[26] = { id: 'oak_planks', count: 64 };
  return { hotbar, main, armor, offhand: { id: 'shield', count: 1 } };
}

/**
 * The Crystal layout from the tier-test screenshot: sword, obsidian, crystals, anchors,
 * glowstone, gapples, pearls, crossbow and a totem in the hotbar; the rest of the pearls,
 * Slow Falling arrows, XP, spare anchors/glowstone/obsidian/crystals, an ender chest, the
 * pickaxe, eight splash potions and six more totems in the inventory; a totem in the off hand.
 * Enchantments follow the standard crystal kit (Blast Protection IV legs and boots).
 */
function crystalLoadout(): Loadout {
  const keep = { unbreaking: 3, mending: 1 };
  const armor: ItemStack[] = [
    { id: 'netherite_helmet', count: 1, ench: { protection: 4, ...keep } },
    { id: 'netherite_chestplate', count: 1, ench: { protection: 4, ...keep } },
    { id: 'netherite_leggings', count: 1, ench: { blastProtection: 4, ...keep } },
    { id: 'netherite_boots', count: 1, ench: { blastProtection: 4, featherFalling: 4, ...keep } },
  ];
  const pearls = (): ItemStack => ({ id: 'ender_pearl', count: 16 });
  const totem = (): ItemStack => ({ id: 'totem_of_undying', count: 1 });
  const hotbar: ItemStack[] = [
    { id: 'netherite_sword', count: 1, ench: { sharpness: 5, knockback: 1, ...keep } },
    { id: 'obsidian', count: 64 },
    { id: 'end_crystal', count: 64 },
    { id: 'respawn_anchor', count: 64 },
    { id: 'glowstone', count: 64 },
    { id: 'golden_apple', count: 64 },
    pearls(),
    { id: 'crossbow', count: 1, ench: { multishot: 1, quickCharge: 3, ...keep } },
    totem(),
  ];
  const main: ItemStack[] = [
    pearls(),
    pearls(),
    { id: 'tipped_arrow', count: 64, potion: 'slow_falling' },
    { id: 'experience_bottle', count: 64 },
    { id: 'experience_bottle', count: 64 },
    totem(),
    totem(),
    totem(),
    totem(),
    pearls(),
    pearls(),
    { id: 'respawn_anchor', count: 64 },
    { id: 'glowstone', count: 64 },
    pot('swiftness'),
    pot('strength'),
    pot('swiftness'),
    pot('strength'),
    totem(),
    { id: 'netherite_pickaxe', count: 1, ench: { efficiency: 5, silkTouch: 1, ...keep } },
    { id: 'ender_chest', count: 32 },
    { id: 'obsidian', count: 64 },
    { id: 'end_crystal', count: 64 },
    pot('swiftness'),
    pot('strength'),
    pot('swiftness'),
    pot('strength'),
    totem(),
  ];
  return { hotbar, main, armor, offhand: totem() };
}

export const KITS: KitDef[] = [
  {
    id: 'sword',
    name: 'Sword',
    icon: 'sword',
    available: true,
    summary: 'Pure sword combos, crits, W-taps and spacing. No golden apples, no hunger.',
    contents: ['Diamond Sword — Sharpness V', 'Full Diamond Armor — Protection IV', 'Hunger off: you can always sprint'],
    hotbar: [{ id: 'diamond_sword', count: 1, ench: { sharpness: 5 } }],
    armor: diamondArmor(4),
    offhand: null,
    armorLabel: 'Diamond · Prot IV',
    noHunger: true,
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
  {
    id: 'uhc',
    name: 'UHC',
    icon: 'uhc',
    available: true,
    summary: 'No natural regen: shields, lava, water, webs and blocks.',
    contents: [
      'Diamond Sword (Sharp III) · Diamond Axe (Eff III) · Shield',
      'Diamond armor — Prot III / II / II / III',
      '8× Golden Apple · 2× Golden Head',
      '4× Water Bucket · 2× Lava Bucket · 8× Cobweb · 128× Oak Planks',
      'Bow (Power I) · Crossbow (Piercing I) · 10× Arrow · Pickaxe (Eff III)',
    ],
    ...uhcLoadout(),
    armorLabel: 'Diamond · Prot III/II',
    naturalRegen: false,
    shieldStuns: true,
  },
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
  {
    id: 'crystal',
    name: 'Crystal',
    icon: 'crystal',
    available: true,
    summary: 'End crystals, respawn anchors, obsidian, pearls and totems.',
    contents: [
      'Netherite armor — Prot IV / Blast Prot IV legs & boots (Feather Falling IV)',
      'Netherite Sword (Sharp V, KB I) · Pickaxe (Eff V, Silk Touch)',
      '128× End Crystal · 128× Obsidian · 128× Respawn Anchor · 128× Glowstone',
      '8× Totem · 64× Golden Apple · 80× Ender Pearl · 32× Ender Chest',
      'Crossbow (Multishot, Quick Charge III) · 64× Slow Falling Arrow · 128× XP · 4× Strength II · 4× Speed II',
    ],
    ...crystalLoadout(),
    armorLabel: 'Netherite · Prot IV / Blast IV',
    floorDepth: 4,
  },
  {
    id: 'smp',
    name: 'SMP',
    icon: 'smp',
    available: true,
    summary: 'Shield, axe, two swords, buffs, gapples, pearls and one totem — no explosives.',
    contents: [
      'Netherite Armor — Prot IV, Unbreaking III, Mending (Swift Sneak III legs, Feather Falling IV boots)',
      '2× Netherite Sword — Sharp V, Fire Aspect II, Sweeping Edge III (one with Knockback I)',
      'Netherite Axe — Sharp V · Shield — Unbreaking III, Mending (off hand)',
      '12× Strength II · 12× Speed II · 3× Fire Res (8:00) · 1× Totem',
      '128× Golden Apple · 32× Ender Pearl · 64× Bottle o\' Enchanting',
    ],
    ...smpLoadout(),
    armorLabel: 'Netherite · Prot IV',
  },
  {
    id: 'mace',
    name: 'Mace',
    icon: 'mace',
    available: true,
    summary: 'Wind charges, pearls and an elytra to get above them, then a mace smash from the sky.',
    contents: [
      'Netherite Armor — Prot IV, Unbreaking III · Elytra',
      'Mace — Density V, Wind Burst III · Mace — Breach IV (both Unbreaking III)',
      'Netherite Sword & Axe — Sharp V, Unbreaking III · Shield — Unbreaking III',
      '128× Wind Charge · 64× Ender Pearl · 128× Golden Apple · 2× Totem',
      '13× Strength II · 8× Speed II (splash)',
    ],
    ...maceLoadout(),
    armorLabel: 'Netherite · Prot IV',
  },
];

export function kitById(id: KitId): KitDef {
  return KITS.find((k) => k.id === id) ?? KITS[0];
}
