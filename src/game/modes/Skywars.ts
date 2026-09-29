import { B } from '../Blocks';
import { DroppedItem } from '../DroppedItem';
import type { Fighter } from '../Fighter';
import { ITEMS, type Enchants, type ItemId, type ItemStack } from '../items';
import type { Rng } from '../../core/rng';
import { TEAM_COLORS, TEAM_NAMES, teamOf, type GameMode, type ModeHost as Match, type ScoreLine } from './GameMode';
import { buildSkywarsMap, type SkywarsLayout, type Spot } from './maps';

/** Chests refill this far into the game (Hypixel refills around then). */
export const REFILL_TICKS = 20 * 60 * 4;
export const CHEST_SLOTS = 27;

type Pick = () => ItemStack | null;

const I = (id: ItemId, count = 1, ench?: Enchants): ItemStack => (ench ? { id, count, ench } : { id, count });

function chance<T>(rng: Rng, p: number, f: () => T): T | null {
  return rng.chance(p) ? f() : null;
}

function pickOne<T>(rng: Rng, xs: T[]): T {
  return xs[rng.int(0, xs.length - 1)];
}

const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'] as const;

/**
 * Loot for one spawn island's three chests together, like Hypixel's SkyWars Normal: everyone
 * gets a sword, some armor and blocks, then a few extras (bow, snowballs, pearls, apples,
 * buckets, tools). It is dealt out over the three chests into random slots.
 */
function islandLoot(rng: Rng): ItemStack[] {
  const out: ItemStack[] = [];
  const add = (s: ItemStack | null) => s && out.push(s);
  const sword = rng.next();
  add(sword < 0.05 ? I('diamond_sword') : sword < 0.4 ? I('iron_sword') : I('stone_sword', 1, rng.chance(0.25) ? { sharpness: 1 } : undefined));
  // Two to four armor pieces, all different slots.
  const pieces = [...ARMOR_PIECES].sort(() => rng.next() - 0.5).slice(0, rng.int(2, 4));
  for (const piece of pieces) {
    const r = rng.next();
    const mat = r < 0.08 ? 'diamond' : r < 0.45 ? 'iron' : r < 0.75 ? 'chainmail' : 'golden';
    add(I(`${mat}_${piece}` as ItemId, 1, rng.chance(0.2) ? { protection: 1 } : undefined));
  }
  add(I(rng.chance(0.5) ? 'cobblestone' : 'oak_planks', rng.int(32, 64)));
  add(I(rng.chance(0.5) ? 'oak_planks' : 'cobblestone', rng.int(16, 48)));
  add(chance(rng, 0.45, () => I('bow')));
  add(chance(rng, 0.55, () => I('arrow', rng.int(6, 16))));
  add(chance(rng, 0.5, () => I(rng.chance(0.5) ? 'snowball' : 'egg', rng.int(8, 16))));
  add(chance(rng, 0.35, () => I('golden_apple', rng.int(1, 2))));
  add(chance(rng, 0.25, () => I('ender_pearl', 1)));
  add(chance(rng, 0.4, () => I('water_bucket')));
  add(chance(rng, 0.2, () => I('lava_bucket')));
  add(chance(rng, 0.4, () => I(pickOne(rng, ['stone_axe', 'iron_axe', 'stone_pickaxe', 'iron_pickaxe'] as ItemId[]))));
  add(chance(rng, 0.5, () => I('cooked_beef', rng.int(3, 8))));
  return out;
}

/** One middle chest: better gear — enchanted diamond pieces, strong swords, pearls, apples. */
function midLoot(rng: Rng): ItemStack[] {
  const out: ItemStack[] = [];
  const add = (s: ItemStack | null) => s && out.push(s);
  const picks: Pick[] = [
    () => I('diamond_sword', 1, rng.chance(0.5) ? { sharpness: rng.int(1, 2) } : undefined),
    () => I('iron_sword', 1, { sharpness: rng.int(1, 2), ...(rng.chance(0.3) ? { fireAspect: 1 } : {}) }),
    () => I(`diamond_${pickOne(rng, [...ARMOR_PIECES])}` as ItemId, 1, rng.chance(0.6) ? { protection: rng.int(1, 2) } : undefined),
    () => I(`iron_${pickOne(rng, [...ARMOR_PIECES])}` as ItemId, 1, { protection: rng.int(1, 3) }),
    () => I('bow', 1, { power: rng.int(1, 2) }),
    () => I('arrow', rng.int(12, 24)),
    () => I('ender_pearl', rng.int(1, 2)),
    () => I('golden_apple', rng.int(2, 3)),
    () => ({ id: 'splash_potion', count: 1, potion: pickOne(rng, ['healing', 'swiftness', 'strength'] as const) }),
    () => I('snowball', 16),
    () => I('cobblestone', 32),
    () => I('diamond_axe', 1, { sharpness: 1 }),
    () => I('lava_bucket'),
  ];
  const n = rng.int(3, 5);
  for (let i = 0; i < n; i++) add(pickOne(rng, picks)());
  return out;
}

/** Spreads stacks over `chests` chests of 27 slots, into random empty slots. */
function deal(rng: Rng, items: ItemStack[], chests: number): (ItemStack | null)[][] {
  const out = Array.from({ length: chests }, () => new Array<ItemStack | null>(CHEST_SLOTS).fill(null));
  items.forEach((s, i) => {
    const c = out[i % chests];
    let slot = rng.int(0, CHEST_SLOTS - 1);
    for (let k = 0; k < CHEST_SLOTS && c[slot]; k++) slot = (slot + 1) % CHEST_SLOTS;
    c[slot] = s;
  });
  return out;
}

const key = (s: Spot) => `${s.x},${s.y},${s.z}`;

/**
 * SkyWars, 1v1 (Hypixel Solo Normal rules): both players start in glass cages over their own
 * islands; when the countdown ends the cages open. Loot your three chests, bridge over (or to the
 * better middle chests), and knock or beat the other player off the map. No respawns; the last
 * one standing wins. Chests refill after four minutes.
 */
export class Skywars implements GameMode {
  readonly id = 'skywars' as const;
  layout!: SkywarsLayout;
  /** Chest contents by "x,y,z". */
  readonly chests = new Map<string, (ItemStack | null)[]>();
  /** Chests each player has opened (the bot uses this to plan its route). */
  readonly opened = [new Set<string>(), new Set<string>()];
  private cagesOpen = false;
  private refilled = false;
  private announcements: ScoreLine[] = [];
  private deathsSeen = new Set<Fighter>();

  setup(m: Match) {
    const w = m.world;
    this.layout = buildSkywarsMap(w.blocks);
    this.chests.clear();
    this.opened[0].clear();
    this.opened[1].clear();
    this.cagesOpen = false;
    this.refilled = false;
    this.announcements = [];
    this.deathsSeen.clear();
    w.protectMap = false;
    w.voidY = -24;
    w.breakRule = null;
    w.placeRule = null;
    this.fill(m);
    const empty = { hotbar: [] as (ItemStack | null)[], armor: [null, null, null, null], offhand: null };
    for (const f of [m.player, m.bot]) {
      const s = this.layout.spawns[teamOf(m, f)];
      f.respawn(s.x, s.y, s.z, s.yaw, empty);
      f.naturalRegen = true;
      f.food.locked = true;
    }
  }

  private fill(m: Match) {
    const rng = m.world.rng;
    for (const team of [0, 1] as const) {
      const cells = this.layout.islandChests[team];
      const dealt = deal(rng, islandLoot(rng), cells.length);
      cells.forEach((c, i) => this.merge(key(c), dealt[i]));
    }
    for (const c of this.layout.midChests) this.merge(key(c), deal(rng, midLoot(rng), 1)[0]);
  }

  /** Puts new loot into a chest's empty slots (a refill keeps what is still there). */
  private merge(k: string, loot: (ItemStack | null)[]) {
    const cur = this.chests.get(k) ?? new Array<ItemStack | null>(CHEST_SLOTS).fill(null);
    for (let i = 0; i < CHEST_SLOTS; i++) if (loot[i] && !cur[i]) cur[i] = loot[i];
    this.chests.set(k, cur);
  }

  /** The contents of the chest at (x, y, z), or null if there is none. */
  chestAt(x: number, y: number, z: number): (ItemStack | null)[] | null {
    return this.chests.get(`${x},${y},${z}`) ?? null;
  }

  /** Marks a chest opened by `f` (right-click). */
  open(m: Match, f: Fighter, x: number, y: number, z: number) {
    this.opened[teamOf(m, f)].add(`${x},${y},${z}`);
  }

  /** Whether `f` can reach into the chest at (x, y, z): it exists and is within 6 blocks of their eyes. */
  canUse(f: Fighter, x: number, y: number, z: number): boolean {
    if (f.dead || !this.chestAt(x, y, z)) return false;
    const e = f.eyePos();
    return Math.hypot(e.x - (x + 0.5), e.y - (y + 0.5), e.z - (z + 0.5)) <= 6;
  }

  /** Chest slot `i` → `f`: as much as fits (armor goes straight on if that slot is empty). */
  take(f: Fighter, x: number, y: number, z: number, i: number) {
    const items = this.chestAt(x, y, z);
    const s = items?.[i];
    if (!items || !s) return;
    const copy = { ...s };
    f.addItem(copy);
    items[i] = copy.count > 0 ? copy : null;
    autoEquip(f);
  }

  /** Every slot of the chest → `f`. */
  takeAll(f: Fighter, x: number, y: number, z: number) {
    for (let i = 0; i < CHEST_SLOTS; i++) this.take(f, x, y, z, i);
  }

  /** `f`'s inventory slot `i` → the chest's first empty slot. */
  put(f: Fighter, x: number, y: number, z: number, i: number) {
    const items = this.chestAt(x, y, z);
    const s = f.inventory[i];
    if (!items || !s) return;
    const j = items.findIndex((it) => !it);
    if (j < 0) return;
    items[j] = s;
    f.inventory[i] = null;
  }

  tick(m: Match) {
    const w = m.world;
    if (m.phase === 'fight' && !this.cagesOpen) {
      this.cagesOpen = true;
      for (const cage of this.layout.cages) for (const c of cage) if (w.blocks.get(c.x, c.y, c.z) === B.GLASS) w.blocks.set(c.x, c.y, c.z, B.AIR);
      this.announcements.push({ text: 'Cages opened! FIGHT!', color: '#ffff55' });
    }
    if (m.phase !== 'fight') return;
    if (!this.refilled && m.fightTicks >= REFILL_TICKS) {
      this.refilled = true;
      this.fill(m);
      this.announcements.push({ text: 'All chests have been refilled!', color: '#ffaa00' });
    }
    // A chest broken with things inside spills them.
    for (const [k, items] of this.chests) {
      const [x, y, z] = k.split(',').map(Number);
      if (w.blocks.get(x, y, z) === B.CHEST) continue;
      for (const s of items) if (s) w.items.push(new DroppedItem(s, x + 0.5, y + 0.3, z + 0.5, w.rng));
      this.chests.delete(k);
    }

  }

  winner(m: Match): Fighter | null {
    if (m.player.dead) return m.bot;
    if (m.bot.dead) return m.player;
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const lines: ScoreLine[] = [{ text: 'SKYWARS', color: '#ffff55' }];
    if (m.phase === 'fight' && !this.refilled) {
      const left = Math.max(0, Math.ceil((REFILL_TICKS - m.fightTicks) / 20));
      lines.push({ text: `Refill in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    } else if (this.refilled) lines.push({ text: 'Chests refilled' });
    for (const f of [m.player, m.bot]) {
      const team = teamOf(m, f);
      lines.push({ text: `${TEAM_NAMES[team]}: ${f.dead ? '✘' : '✔'}${f === viewer ? ' YOU' : ''}`, color: TEAM_COLORS[team] });
    }
    const opened = this.opened[teamOf(m, viewer)].size;
    lines.push({ text: `Chests opened: ${opened}` });
    return lines;
  }

  title(): { title: string; sub: string } | null {
    return null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }
}

/** Armor in the inventory goes on where that slot is empty (a common quality-of-life plugin rule). */
function autoEquip(f: Fighter) {
  for (let i = 0; i < f.inventory.length; i++) {
    const s = f.inventory[i];
    const a = s ? ITEMS[s.id].armor : undefined;
    if (!s || !a || a.glider || f.armorSlots[a.slot]) continue;
    f.armorSlots[a.slot] = s;
    f.inventory[i] = null;
  }
  f.recomputeArmor();
}

/** How much better an item is than nothing, for sorting loot (the bot takes the best first). */
export function lootValue(s: ItemStack): number {
  const def = ITEMS[s.id];
  if (def.armor) return 10 + def.armor.points * 3 + (s.ench?.protection ?? 0) * 2;
  if (def.tool === 'sword') return 20 + def.attackDamage * 3 + (s.ench?.sharpness ?? 0) * 2;
  return 5;
}
