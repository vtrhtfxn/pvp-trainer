/**
 * Kits players build in the kit editor: any item in any slot, with counts, enchantments and
 * potion types, plus a couple of kit rules. Saved in this browser; everything loaded is checked
 * against the item registry, so a hand-edited save can't smuggle in something the game can't run.
 */
import { ITEMS, POTIONS, stackName, type Enchants, type ItemDef, type ItemId, type ItemStack, type PotionId } from './items';
import { registerCustomKits, type KitDef, type Loadout } from './kits';
import { cleanChat } from '../net/protocol';

export interface CustomKitData {
  /** `custom:<id>` in KitId form. */
  id: `custom:${string}`;
  name: string;
  hotbar: (ItemStack | null)[];
  /** Inventory slots 9–35. */
  main: (ItemStack | null)[];
  /** Head, chest, legs, feet. */
  armor: (ItemStack | null)[];
  offhand: ItemStack | null;
  /** Health comes back on its own (off: UHC-style, only from golden apples and heads). */
  naturalRegen: boolean;
  /** Hunger never drops, so you can always sprint. */
  noHunger: boolean;
}

export const MAX_CUSTOM_KITS = 24;
export const MAX_KIT_NAME = 24;
const STORE_KEY = 'pvp-trainer.kits.v1';

/** Enchantments offered for each kind of item, with their vanilla maximum levels. */
export const ENCHANT_INFO: { key: keyof Enchants; name: string; max: number }[] = [
  { key: 'sharpness', name: 'Sharpness', max: 5 },
  { key: 'fireAspect', name: 'Fire Aspect', max: 2 },
  { key: 'knockback', name: 'Knockback', max: 2 },
  { key: 'sweepingEdge', name: 'Sweeping Edge', max: 3 },
  { key: 'density', name: 'Density', max: 5 },
  { key: 'breach', name: 'Breach', max: 4 },
  { key: 'windBurst', name: 'Wind Burst', max: 3 },
  { key: 'efficiency', name: 'Efficiency', max: 5 },
  { key: 'silkTouch', name: 'Silk Touch', max: 1 },
  { key: 'power', name: 'Power', max: 5 },
  { key: 'multishot', name: 'Multishot', max: 1 },
  { key: 'quickCharge', name: 'Quick Charge', max: 3 },
  { key: 'piercing', name: 'Piercing', max: 4 },
  { key: 'protection', name: 'Protection', max: 4 },
  { key: 'blastProtection', name: 'Blast Protection', max: 4 },
  { key: 'featherFalling', name: 'Feather Falling', max: 4 },
  { key: 'swiftSneak', name: 'Swift Sneak', max: 3 },
  { key: 'unbreaking', name: 'Unbreaking', max: 3 },
  { key: 'mending', name: 'Mending', max: 1 },
];
const ENCHANT_MAX = new Map(ENCHANT_INFO.map((e) => [e.key, e.max]));

/** The enchantments an item can take (the ones this game simulates). */
export function enchantsFor(id: ItemId): (keyof Enchants)[] {
  const def = ITEMS[id];
  const keep: (keyof Enchants)[] = def.maxDamage ? ['unbreaking', 'mending'] : [];
  if (def.tool === 'sword') return ['sharpness', 'fireAspect', 'knockback', 'sweepingEdge', ...keep];
  if (def.tool === 'axe') return ['sharpness', 'efficiency', 'silkTouch', ...keep];
  if (def.tool === 'pickaxe') return ['efficiency', 'silkTouch', ...keep];
  if (id === 'mace') return ['density', 'breach', 'windBurst', 'fireAspect', ...keep];
  if (id === 'bow') return ['power', ...keep];
  if (id === 'crossbow') return ['multishot', 'quickCharge', 'piercing', ...keep];
  const a = def.armor;
  if (a && !a.glider) {
    const out: (keyof Enchants)[] = ['protection', 'blastProtection'];
    if (a.slot === 3) out.push('featherFalling');
    if (a.slot === 2) out.push('swiftSneak');
    return [...out, ...keep];
  }
  return keep;
}

/** Items that carry a potion (splash potions, tipped arrows). */
export function takesPotion(id: ItemId): boolean {
  return id === 'splash_potion' || id === 'tipped_arrow';
}

/** Which armor slot (0 head … 3 feet) an item may go in, or -1 for none. */
export function armorSlotOf(id: ItemId): number {
  const a = ITEMS[id].armor;
  return a ? a.slot : -1;
}

/** Every item, in palette order: weapons, armor, then the rest as the registry lists them. */
export function paletteItems(): ItemId[] {
  const ids = Object.keys(ITEMS) as ItemId[];
  const rank = (d: ItemDef) => (d.tool === 'sword' || d.tool === 'axe' || d.id === 'mace' ? 0 : d.armor ? 1 : d.tool ? 2 : 3);
  return ids.map((id, i) => ({ id, i })).sort((a, b) => rank(ITEMS[a.id]) - rank(ITEMS[b.id]) || a.i - b.i).map((x) => x.id);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** A stack from a save, or null if it isn't one the game can hold. */
export function cleanStack(raw: unknown): ItemStack | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !Object.hasOwn(ITEMS, raw.id)) return null;
  const id = raw.id as ItemId;
  const def = ITEMS[id];
  const count = Math.floor(Number(raw.count));
  const s: ItemStack = { id, count: Number.isFinite(count) ? Math.min(Math.max(count, 1), def.maxStack) : 1 };
  if (takesPotion(id)) {
    const p = typeof raw.potion === 'string' && Object.hasOwn(POTIONS, raw.potion) ? (raw.potion as PotionId) : 'healing';
    s.potion = id === 'tipped_arrow' && p === 'healing' ? 'slow_falling' : p;
  }
  if (id === 'red_shulker_box') {
    const n = Math.floor(Number(raw.stored));
    if (Number.isFinite(n) && n > 0) s.stored = Math.min(n, 27);
  }
  if (isObj(raw.ench)) {
    const allowed = enchantsFor(id);
    const ench: Enchants = {};
    for (const key of allowed) {
      const lvl = Math.floor(Number(raw.ench[key]));
      if (Number.isFinite(lvl) && lvl > 0) ench[key] = Math.min(lvl, ENCHANT_MAX.get(key) ?? 1);
    }
    if (Object.keys(ench).length) s.ench = ench;
  }
  return s;
}

function cleanSlots(raw: unknown, n: number, fit?: (s: ItemStack, i: number) => boolean): (ItemStack | null)[] {
  const arr = Array.isArray(raw) ? raw : [];
  return Array.from({ length: n }, (_, i) => {
    const s = cleanStack(arr[i]);
    return s && (!fit || fit(s, i)) ? s : null;
  });
}

/** Strips invisible and control characters and trims to length. */
export function cleanKitName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  const out = cleanChat(s, MAX_KIT_NAME);
  return out || 'Custom Kit';
}

export function cleanCustomKit(raw: unknown): CustomKitData | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !/^custom:[a-z0-9]{1,16}$/.test(raw.id)) return null;
  return {
    id: raw.id as `custom:${string}`,
    name: cleanKitName(raw.name),
    hotbar: cleanSlots(raw.hotbar, 9),
    main: cleanSlots(raw.main, 27),
    armor: cleanSlots(raw.armor, 4, (s, i) => armorSlotOf(s.id) === i),
    offhand: cleanStack(raw.offhand),
    naturalRegen: raw.naturalRegen !== false,
    noHunger: raw.noHunger === true,
  };
}

export function newCustomKitId(): `custom:${string}` {
  return `custom:${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/** A fresh kit to start editing from: a diamond sword and diamond armor. */
export function blankCustomKit(name = 'My Kit'): CustomKitData {
  return {
    id: newCustomKitId(),
    name,
    hotbar: [{ id: 'diamond_sword', count: 1 }, ...Array<null>(8).fill(null)],
    main: Array<null>(27).fill(null),
    armor: (['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'] as const).map((id) => ({ id, count: 1 })),
    offhand: null,
    naturalRegen: true,
    noHunger: false,
  };
}

/** A copy of any kit's loadout as a custom kit (to start from a built-in one). */
export function customFromLoadout(name: string, l: Loadout, rules: { naturalRegen?: boolean; noHunger?: boolean } = {}): CustomKitData {
  const copy = (s: ItemStack | null | undefined) => (s ? cleanStack(JSON.parse(JSON.stringify(s))) : null);
  return {
    id: newCustomKitId(),
    name: cleanKitName(name),
    hotbar: Array.from({ length: 9 }, (_, i) => copy(l.hotbar[i])),
    main: Array.from({ length: 27 }, (_, i) => copy(l.main?.[i])),
    armor: Array.from({ length: 4 }, (_, i) => copy(l.armor[i])),
    offhand: copy(l.offhand),
    naturalRegen: rules.naturalRegen ?? true,
    noHunger: !!rules.noHunger,
  };
}

/** What the kit menu lists: the named items and how many of each. */
function contentsOf(k: CustomKitData): string[] {
  const all = [...k.hotbar, ...k.main, k.offhand].filter((s): s is ItemStack => !!s);
  const totals = new Map<string, number>();
  for (const s of all) totals.set(stackName(s), (totals.get(stackName(s)) ?? 0) + s.count);
  const items = [...totals].map(([n, c]) => (c > 1 ? `${c}× ${n}` : n));
  const armor = k.armor.filter((s): s is ItemStack => !!s).map((s) => stackName(s));
  const lines: string[] = [];
  if (armor.length) lines.push(`Armor: ${armor.join(', ')}`);
  for (let i = 0; i < items.length; i += 4) lines.push(items.slice(i, i + 4).join(' · '));
  if (lines.length > 5) lines.splice(4, lines.length - 4, `…and ${items.length - 16 > 0 ? items.length - 16 : 'more'} more`);
  const rules = [k.naturalRegen ? '' : 'No natural regen', k.noHunger ? 'Hunger off' : ''].filter(Boolean);
  if (rules.length) lines.push(rules.join(' · '));
  return lines.length ? lines : ['Empty — add some items in the kit editor'];
}

export function customKitDef(k: CustomKitData): KitDef {
  const armor = k.armor.filter((s): s is ItemStack => !!s);
  // Crystals and anchors crater the ground, like on the Crystal kit's map.
  const blasts = [...k.hotbar, ...k.main, k.offhand].some((s) => s?.id === 'end_crystal' || s?.id === 'respawn_anchor');
  return {
    id: k.id,
    name: k.name,
    icon: 'custom',
    available: true,
    custom: true,
    summary: 'Your own kit, made in the kit editor.',
    contents: contentsOf(k),
    hotbar: k.hotbar,
    main: k.main,
    armor: k.armor,
    offhand: k.offhand,
    armorLabel: armor.length ? stackName(armor[0]) : 'No armor',
    naturalRegen: k.naturalRegen,
    noHunger: k.noHunger,
    floorDepth: blasts ? 4 : 0,
  };
}

export function loadCustomKits(): CustomKitData[] {
  let raw: unknown = [];
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
  } catch {
    raw = [];
  }
  const out: CustomKitData[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw) ? raw.slice(0, MAX_CUSTOM_KITS) : []) {
    const k = cleanCustomKit(r);
    if (k && !seen.has(k.id)) {
      seen.add(k.id);
      out.push(k);
    }
  }
  registerCustomKits(out.map(customKitDef));
  return out;
}

export function saveCustomKits(kits: CustomKitData[]) {
  const list = kits.slice(0, MAX_CUSTOM_KITS);
  registerCustomKits(list.map(customKitDef));
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked: the kits still work until the game closes */
  }
}
