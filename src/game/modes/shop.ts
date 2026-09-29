import type { Fighter } from '../Fighter';
import { ITEMS, type Enchants, type ItemId, type ItemStack, type PotionId } from '../items';

/** Bed Wars currencies. */
export type Currency = 'iron_ingot' | 'gold_ingot' | 'diamond' | 'emerald';

export const CURRENCY_NAMES: Record<Currency, string> = { iron_ingot: 'Iron', gold_ingot: 'Gold', diamond: 'Diamond', emerald: 'Emerald' };
export const CURRENCY_COLORS: Record<Currency, string> = { iron_ingot: '#dddddd', gold_ingot: '#ffcc33', diamond: '#55ffff', emerald: '#55ff55' };

export type ShopCategory = 'Blocks' | 'Melee' | 'Armor' | 'Tools' | 'Ranged' | 'Potions' | 'Utility' | 'Upgrades';
export const SHOP_CATEGORIES: ShopCategory[] = ['Blocks', 'Melee', 'Armor', 'Tools', 'Ranged', 'Potions', 'Utility', 'Upgrades'];

/** What a team owns for good: kept through deaths (tools drop a tier on death, like Hypixel). */
export interface TeamGear {
  /** 0 leather, 1 chainmail, 2 iron, 3 diamond. */
  armor: number;
  /** 0 none, 1 wooden, 2 iron, 3 diamond. */
  pickaxe: number;
  /** 0 none, 1 wooden, 2 stone, 3 iron, 4 diamond. */
  axe: number;
  shears: boolean;
  /** Team upgrades. */
  sharpness: boolean;
  /** Reinforced Armor 0–4 (Protection on everyone's armor). */
  protection: number;
  /** Wool colour item for this team. */
  wool: ItemId;
  leather: 'red' | 'blue';
}

export interface ShopItem {
  key: string;
  name: string;
  category: ShopCategory;
  /** The item shown on the button. */
  icon: ItemStack;
  currency: Currency;
  price: number;
  /** One line under the name. */
  info?: string;
  /** Null if it can be bought; otherwise why not ("Already bought"). */
  locked?(f: Fighter, g: TeamGear): string | null;
  /** Price in this state (tools and upgrades get dearer per tier). */
  cost?(g: TeamGear): number;
  give(f: Fighter, g: TeamGear): void;
}

const ARMOR_TIERS = ['leather', 'chainmail', 'iron', 'diamond'] as const;
const PICK_IDS: (ItemId | null)[] = [null, 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'];
const AXE_IDS: (ItemId | null)[] = [null, 'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe'];
const PICK_COST: [Currency, number][] = [
  ['iron_ingot', 10],
  ['iron_ingot', 10],
  ['gold_ingot', 6],
];
const AXE_COST: [Currency, number][] = [
  ['iron_ingot', 10],
  ['iron_ingot', 10],
  ['gold_ingot', 3],
  ['gold_ingot', 6],
];
const PROT_COST = [2, 4, 8, 16];

function isSword(id: ItemId | undefined): boolean {
  return !!id && ITEMS[id].tool === 'sword';
}

/** Every sword the fighter holds gets Sharpness I when the team has Sharpened Swords. */
export function applyTeamEnchants(f: Fighter, g: TeamGear) {
  const all = [...f.inventory, f.offhand];
  for (const s of all) {
    if (!s) continue;
    const def = ITEMS[s.id];
    if (g.sharpness && (def.tool === 'sword' || def.tool === 'axe')) s.ench = { ...(s.ench ?? {}), sharpness: 1 };
  }
  for (const s of f.armorSlots) {
    if (!s) continue;
    if (g.protection > 0) s.ench = { ...(s.ench ?? {}), protection: g.protection };
  }
  f.recomputeArmor();
}

/** The armor a team member wears at this tier: team leather top, tier leggings and boots. */
export function armorFor(g: TeamGear): (ItemStack | null)[] {
  const top = (piece: string): ItemStack => ({ id: `${g.leather}_leather_${piece}` as ItemId, count: 1 });
  const low = (piece: string): ItemStack =>
    g.armor === 0 ? top(piece) : { id: `${ARMOR_TIERS[g.armor]}_${piece}` as ItemId, count: 1 };
  const out = [top('helmet'), top('chestplate'), low('leggings'), low('boots')];
  if (g.protection > 0) for (const s of out) s.ench = { protection: g.protection } as Enchants;
  return out;
}

/** Swap a tool of one tier for the next in place (or add it). */
function upgradeTool(f: Fighter, ids: (ItemId | null)[], from: number, to: number) {
  const old = ids[from];
  const next: ItemStack = { id: ids[to]!, count: 1 };
  if (old) {
    for (let i = 0; i < f.inventory.length; i++) {
      if (f.inventory[i]?.id === old) {
        f.inventory[i] = next;
        return;
      }
    }
  }
  f.addItem(next);
}

function giveSword(id: ItemId) {
  return (f: Fighter, g: TeamGear) => {
    // Buying a better sword takes the wooden one away (Hypixel).
    for (let i = 0; i < f.inventory.length; i++) if (f.inventory[i]?.id === 'wooden_sword') f.inventory[i] = null;
    const s: ItemStack = { id, count: 1 };
    if (g.sharpness) s.ench = { sharpness: 1 };
    const slot = f.inventory.findIndex((x, i) => i < 9 && !x);
    if (slot >= 0) f.inventory[slot] = s;
    else f.addItem(s);
  };
}

function potion(p: PotionId): ItemStack {
  return { id: 'potion', count: 1, potion: p };
}

/**
 * The Item Shop and Team Upgrades, at Hypixel's Solo/Doubles prices (the numbers everyone quotes
 * on the forums). Armor is permanent and swaps your leggings and boots; tools go up a tier at a
 * time and fall one tier when you die; swords replace the wooden sword.
 */
export const SHOP: ShopItem[] = [
  { key: 'wool', name: 'Wool ×16', category: 'Blocks', icon: { id: 'red_wool', count: 16 }, currency: 'iron_ingot', price: 4, info: 'Great for bridging', give: (f, g) => void f.addItem({ id: g.wool, count: 16 }) },
  { key: 'wood', name: 'Oak Planks ×16', category: 'Blocks', icon: { id: 'oak_planks', count: 16 }, currency: 'gold_ingot', price: 4, info: 'Harder to break than wool', give: (f) => void f.addItem({ id: 'oak_planks', count: 16 }) },
  { key: 'endstone', name: 'End Stone ×12', category: 'Blocks', icon: { id: 'end_stone', count: 12 }, currency: 'iron_ingot', price: 24, info: 'Blast-resistant bed defence', give: (f) => void f.addItem({ id: 'end_stone', count: 12 }) },
  { key: 'glass', name: 'Blast-Proof Glass ×4', category: 'Blocks', icon: { id: 'glass', count: 4 }, currency: 'iron_ingot', price: 12, info: 'TNT and fireballs can’t break it', give: (f) => void f.addItem({ id: 'glass', count: 4 }) },
  { key: 'obsidian', name: 'Obsidian ×4', category: 'Blocks', icon: { id: 'obsidian', count: 4 }, currency: 'emerald', price: 4, info: 'The toughest bed defence', give: (f) => void f.addItem({ id: 'obsidian', count: 4 }) },

  { key: 'stone_sword', name: 'Stone Sword', category: 'Melee', icon: { id: 'stone_sword', count: 1 }, currency: 'iron_ingot', price: 10, give: giveSword('stone_sword') },
  { key: 'iron_sword', name: 'Iron Sword', category: 'Melee', icon: { id: 'iron_sword', count: 1 }, currency: 'gold_ingot', price: 7, give: giveSword('iron_sword') },
  { key: 'diamond_sword', name: 'Diamond Sword', category: 'Melee', icon: { id: 'diamond_sword', count: 1 }, currency: 'emerald', price: 4, give: giveSword('diamond_sword') },
  { key: 'kb_stick', name: 'Knockback Stick', category: 'Melee', icon: { id: 'stick', count: 1, ench: { knockback: 1 } }, currency: 'gold_ingot', price: 5, info: 'Knockback I', give: (f) => void f.addItem({ id: 'stick', count: 1, ench: { knockback: 1 } }) },

  ...([1, 2, 3] as const).map(
    (tier): ShopItem => ({
      key: `armor${tier}`,
      name: `Permanent ${['', 'Chainmail', 'Iron', 'Diamond'][tier]} Armor`,
      category: 'Armor',
      icon: { id: `${ARMOR_TIERS[tier]}_boots` as ItemId, count: 1 },
      currency: (['iron_ingot', 'iron_ingot', 'gold_ingot', 'emerald'] as Currency[])[tier],
      price: [0, 24, 12, 6][tier],
      info: 'Leggings and boots, kept when you die',
      locked: (_f, g) => (g.armor >= tier ? 'Already have it' : null),
      give: (f, g) => {
        g.armor = tier;
        const a = armorFor(g);
        f.armorSlots[2] = a[2];
        f.armorSlots[3] = a[3];
        f.recomputeArmor();
      },
    }),
  ),

  {
    key: 'pickaxe',
    name: 'Pickaxe (next tier)',
    category: 'Tools',
    icon: { id: 'iron_pickaxe', count: 1 },
    currency: 'iron_ingot',
    price: 10,
    info: 'Wooden → Iron → Diamond; drops a tier when you die',
    locked: (_f, g) => (g.pickaxe >= 3 ? 'Max tier' : null),
    cost: (g) => PICK_COST[Math.min(g.pickaxe, 2)][1],
    give: (f, g) => {
      upgradeTool(f, PICK_IDS, g.pickaxe, g.pickaxe + 1);
      g.pickaxe++;
    },
  },
  {
    key: 'axe',
    name: 'Axe (next tier)',
    category: 'Tools',
    icon: { id: 'iron_axe', count: 1 },
    currency: 'iron_ingot',
    price: 10,
    info: 'Wooden → Stone → Iron → Diamond; drops a tier when you die',
    locked: (_f, g) => (g.axe >= 4 ? 'Max tier' : null),
    cost: (g) => AXE_COST[Math.min(g.axe, 3)][1],
    give: (f, g) => {
      upgradeTool(f, AXE_IDS, g.axe, g.axe + 1);
      g.axe++;
    },
  },
  { key: 'shears', name: 'Permanent Shears', category: 'Tools', icon: { id: 'shears', count: 1 }, currency: 'iron_ingot', price: 20, info: 'Cut wool fast', locked: (_f, g) => (g.shears ? 'Already have it' : null), give: (f, g) => ((g.shears = true), void f.addItem({ id: 'shears', count: 1 })) },

  { key: 'arrows', name: 'Arrow ×6', category: 'Ranged', icon: { id: 'arrow', count: 6 }, currency: 'gold_ingot', price: 2, give: (f) => void f.addItem({ id: 'arrow', count: 6 }) },
  { key: 'bow', name: 'Bow', category: 'Ranged', icon: { id: 'bow', count: 1 }, currency: 'gold_ingot', price: 12, give: (f) => void f.addItem({ id: 'bow', count: 1 }) },
  { key: 'bow_power', name: 'Bow (Power I)', category: 'Ranged', icon: { id: 'bow', count: 1, ench: { power: 1 } }, currency: 'gold_ingot', price: 20, give: (f) => void f.addItem({ id: 'bow', count: 1, ench: { power: 1 } }) },

  { key: 'speed', name: 'Speed II Potion (45 s)', category: 'Potions', icon: potion('bw_speed'), currency: 'emerald', price: 1, give: (f) => void f.addItem(potion('bw_speed')) },
  { key: 'jump', name: 'Jump V Potion (45 s)', category: 'Potions', icon: potion('bw_jump'), currency: 'emerald', price: 1, give: (f) => void f.addItem(potion('bw_jump')) },
  { key: 'invis', name: 'Invisibility Potion (30 s)', category: 'Potions', icon: potion('bw_invisibility'), currency: 'emerald', price: 2, give: (f) => void f.addItem(potion('bw_invisibility')) },

  { key: 'gapple', name: 'Golden Apple', category: 'Utility', icon: { id: 'golden_apple', count: 1 }, currency: 'gold_ingot', price: 3, give: (f) => void f.addItem({ id: 'golden_apple', count: 1 }) },
  { key: 'fireball', name: 'Fireball', category: 'Utility', icon: { id: 'fire_charge', count: 1 }, currency: 'iron_ingot', price: 40, info: 'Right-click to launch; breaks wool', give: (f) => void f.addItem({ id: 'fire_charge', count: 1 }) },
  { key: 'tnt', name: 'TNT', category: 'Utility', icon: { id: 'tnt', count: 1 }, currency: 'gold_ingot', price: 4, info: 'Lights itself; goes off in 2.5 s', give: (f) => void f.addItem({ id: 'tnt', count: 1 }) },
  { key: 'pearl', name: 'Ender Pearl', category: 'Utility', icon: { id: 'ender_pearl', count: 1 }, currency: 'emerald', price: 4, give: (f) => void f.addItem({ id: 'ender_pearl', count: 1 }) },
  { key: 'water', name: 'Water Bucket', category: 'Utility', icon: { id: 'water_bucket', count: 1 }, currency: 'gold_ingot', price: 3, give: (f) => void f.addItem({ id: 'water_bucket', count: 1 }) },

  {
    key: 'sharp',
    name: 'Sharpened Swords',
    category: 'Upgrades',
    icon: { id: 'iron_sword', count: 1, ench: { sharpness: 1 } },
    currency: 'diamond',
    price: 4,
    info: 'Sharpness I on your swords and axes, for good',
    locked: (_f, g) => (g.sharpness ? 'Already have it' : null),
    give: (f, g) => {
      g.sharpness = true;
      applyTeamEnchants(f, g);
    },
  },
  {
    key: 'prot',
    name: 'Reinforced Armor',
    category: 'Upgrades',
    icon: { id: 'iron_chestplate', count: 1, ench: { protection: 1 } },
    currency: 'diamond',
    price: 2,
    info: 'Protection I → II → III → IV on your armor (2/4/8/16 diamonds)',
    locked: (_f, g) => (g.protection >= 4 ? 'Max tier' : null),
    cost: (g) => PROT_COST[Math.min(g.protection, 3)],
    give: (f, g) => {
      g.protection++;
      applyTeamEnchants(f, g);
    },
  },
];

/** Price and currency of `item` for this team right now. */
export function priceOf(item: ShopItem, g: TeamGear): { currency: Currency; amount: number } {
  if (item.key === 'pickaxe') {
    const [c, n] = PICK_COST[Math.min(g.pickaxe, 2)];
    return { currency: c, amount: n };
  }
  if (item.key === 'axe') {
    const [c, n] = AXE_COST[Math.min(g.axe, 3)];
    return { currency: c, amount: n };
  }
  return { currency: item.currency, amount: item.cost ? item.cost(g) : item.price };
}

/** How much of a currency the fighter carries. */
export function wallet(f: Fighter, c: Currency): number {
  return f.countItem(c);
}

function take(f: Fighter, c: Currency, n: number) {
  for (let i = 0; i < f.inventory.length && n > 0; i++) {
    const s = f.inventory[i];
    if (s?.id !== c) continue;
    const k = Math.min(n, s.count);
    s.count -= k;
    n -= k;
    if (s.count <= 0) f.inventory[i] = null;
  }
}

/** Buys `item` if affordable and allowed: returns null on success, or why not. */
export function buy(f: Fighter, g: TeamGear, item: ShopItem): string | null {
  const lock = item.locked?.(f, g);
  if (lock) return lock;
  const { currency, amount } = priceOf(item, g);
  if (wallet(f, currency) < amount) return `Need ${amount - wallet(f, currency)} more ${CURRENCY_NAMES[currency]}`;
  take(f, currency, amount);
  item.give(f, g);
  if (isSword(item.icon.id)) applyTeamEnchants(f, g);
  f.events.push({ type: 'equip', id: item.icon.id });
  return null;
}

/** The loadout a team member respawns with: wooden sword, team armor, tools a tier lower. */
export function respawnLoadout(g: TeamGear, onDeath: boolean): { hotbar: (ItemStack | null)[]; armor: (ItemStack | null)[]; offhand: null } {
  if (onDeath) {
    g.pickaxe = g.pickaxe > 0 ? Math.max(1, g.pickaxe - 1) : 0;
    g.axe = g.axe > 0 ? Math.max(1, g.axe - 1) : 0;
  }
  const hotbar: (ItemStack | null)[] = [{ id: 'wooden_sword', count: 1, ench: g.sharpness ? { sharpness: 1 } : undefined }];
  if (g.pickaxe > 0) hotbar.push({ id: PICK_IDS[g.pickaxe]!, count: 1 });
  if (g.axe > 0) hotbar.push({ id: AXE_IDS[g.axe]!, count: 1, ench: g.sharpness ? { sharpness: 1 } : undefined });
  if (g.shears) hotbar.push({ id: 'shears', count: 1 });
  return { hotbar, armor: armorFor(g), offhand: null };
}
