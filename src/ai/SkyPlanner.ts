import { DEG, wrapAngle, yawTowards } from '../core/math';
import type { Rng } from '../core/rng';
import { B, isSolid } from '../game/Blocks';
import type { Fighter, MoveInput } from '../game/Fighter';
import { ITEMS, type ItemId, type ItemStack } from '../game/items';
import type { Match } from '../game/Match';
import { Bedwars } from '../game/modes/Bedwars';
import { Skywars, lootValue } from '../game/modes/Skywars';
import type { Spot } from '../game/modes/maps';
import { SHOP, type ShopItem } from '../game/modes/shop';
import type { World } from '../game/World';
import type { BotProfile } from './difficulty';

/** The part of BotBrain the planner drives (aim, clicks, the sword game). */
export interface BrainHooks {
  readonly profile: BotProfile;
  settle: number;
  weapon: ItemId;
  aimAt(x: number, y: number, z: number, gain?: number): void;
  aimPoint(x: number, y: number, z: number): void;
  turnTo(yaw: number, pitch: number, gain?: number): void;
  facePoint(sx: number, sy: number, sz: number, nx: number, ny: number, nz: number): [number, number, number] | null;
  anyFacePoint(x: number, y: number, z: number): [number, number, number] | null;
  equip(id: ItemId): boolean;
}

export interface Perceived {
  x: number;
  y: number;
  z: number;
  onGround: boolean;
}

type BwPhase = 'collect' | 'shop' | 'defend' | 'rush' | 'hunt';
type SwPhase = 'cage' | 'loot' | 'go';

const BLOCK_ITEMS: ItemId[] = ['red_wool', 'blue_wool', 'oak_planks', 'cobblestone', 'end_stone', 'oak_log'];
const SWORDS: ItemId[] = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword'];
/** Skill on the 0..1 ladder (LT5 → HT1) from a profile: how fast and how much it plans. */
function skillOf(p: BotProfile): number {
  // Reaction 6 ticks (LT5) … 2.6 (HT1).
  return Math.max(0, Math.min(1, (6 - p.reactionTicks) / 3.4));
}

/**
 * Plays Bed Wars and SkyWars for the bot: walking, bridging over the void with blocks
 * (sneaking to the edge and placing against the side of the block it stands on, like a
 * player), collecting and shopping, defending and breaking beds, looting chests and gearing up.
 * Close to the opponent it hands over to the ordinary 1.8 sword game, with an edge guard so it
 * doesn't walk itself off the map.
 */
export class SkyPlanner {
  private bw: BwPhase = 'collect';
  private sw: SwPhase = 'cage';
  private timer = 0;
  private shopList: string[] = [];
  private defendCells: Spot[] = [];
  private chestQueue: Spot[] = [];
  private lootWait = 0;
  private placeWait = 0;
  private mineTarget: Spot | null = null;
  private stuck = 0;
  private detour = 0;
  private detourSide = 1;
  private lastPos = { x: 0, z: 0 };
  private throwCooldown = 0;
  label = '';

  constructor(
    private readonly bot: Fighter,
    private readonly target: Fighter,
    private readonly world: World,
    private readonly match: Match,
    private readonly rng: Rng,
    private readonly h: BrainHooks,
  ) {}

  private get skill(): number {
    return skillOf(this.h.profile);
  }

  reset() {
    this.bw = 'collect';
    this.sw = 'cage';
    this.timer = 0;
    this.shopList = [];
    this.defendCells = [];
    this.chestQueue = [];
    this.lootWait = 0;
    this.placeWait = 0;
    this.mineTarget = null;
    this.stuck = 0;
    this.throwCooldown = 0;
  }

  /** One tick. `fight` runs the sword game into `input` (BotBrain.legacyEngage). */
  tick(per: Perceived, input: MoveInput, fight: () => void) {
    const b = this.bot;
    if (b.mining && !this.mineTarget) b.tickMining(false, false);
    this.timer++;
    if (this.throwCooldown > 0) this.throwCooldown--;
    if (this.placeWait > 0) this.placeWait--;
    this.h.weapon = this.bestSword();
    const mode = this.match.mode;
    const T = this.target;
    const dist = Math.hypot(per.x - b.pos.x, per.z - b.pos.z);
    const dy = Math.abs(per.y - b.pos.y);
    // Close enough to fight (and not across a gap far below): the sword game.
    const closeFight = !T.dead && dist < 6 && dy < 3.5 && this.reachable(per);
    if (mode instanceof Bedwars) this.bedwars(mode, per, dist, input, closeFight, fight);
    else if (mode instanceof Skywars) this.skywars(mode, per, dist, input, closeFight, fight);
    this.edgeGuard(input);
  }

  // ------------------------------------------------------------------ Bed Wars

  private bedwars(mode: Bedwars, per: Perceived, dist: number, input: MoveInput, closeFight: boolean, fight: () => void) {
    const b = this.bot;
    const m = this.match;
    const me = m.bot === b ? 1 : 0;
    const them = me === 1 ? 0 : 1;
    const L = mode.layout;
    const s = this.skill;
    if (closeFight) {
      this.label = 'Fighting';
      fight();
      this.keepOffEdge(per, input);
      return;
    }
    switch (this.bw) {
      case 'collect': {
        this.label = 'Collecting iron';
        const gen = L.teams[me].gen;
        this.goTo(gen.x, gen.z, input, 0.4);
        // How much it saves before shopping: more (and longer) the better it is.
        const iron = b.countItem('iron_ingot');
        const gold = b.countItem('gold_ingot');
        const died = this.shopList.length === 0 && b.stats.hits + b.stats.damageDealt > 0;
        const wantIron = died ? 12 : 18 + Math.round(s * 30);
        const wantGold = s > 0.6 ? 7 : 0;
        const maxWait = 20 * (died ? 12 : 25 + s * 35);
        if ((iron >= wantIron && gold >= wantGold) || this.timer > maxWait) this.enterBw('shop');
        return;
      }
      case 'shop': {
        this.label = 'Shopping';
        const shop = L.teams[me].shop;
        if (!mode.nearShop(m, b)) {
          this.goTo(shop.x + 0.5, shop.z + 0.5, input, 2.5);
          if (this.timer > 20 * 20) this.enterBw('rush');
          return;
        }
        this.h.aimAt(shop.x + 0.5, shop.y + 0.5, shop.z + 0.5, 0.6);
        // Browsing the shop takes a moment, less for better players.
        if (this.timer < 30 - s * 20) return;
        if (!this.shopList.length) this.shopList = this.planPurchases();
        const next = this.shopList.shift();
        if (next) {
          const item = SHOP.find((i) => i.key === next) as ShopItem;
          if (item) mode.buy(m, b, item);
          this.timer = Math.round(30 - s * 22);
          return;
        }
        this.enterBw(s > 0.25 && mode.teams[me].bedAlive && !this.defendCells.length ? 'defend' : 'rush');
        return;
      }
      case 'defend': {
        this.label = 'Covering the bed';
        if (!this.defendCells.length) this.defendCells = this.bedCover(L.teams[me].bed);
        // Skip cells already filled; stop when done or out of blocks.
        while (this.defendCells.length && this.world.blocks.get(this.defendCells[0].x, this.defendCells[0].y, this.defendCells[0].z) !== B.AIR) this.defendCells.shift();
        const cell = this.defendCells[0];
        if (!cell || !this.blockItem() || this.timer > 20 * 30) {
          this.enterBw('rush');
          return;
        }
        this.placeAt(cell, input);
        return;
      }
      case 'rush': {
        const bed = L.teams[them].bed;
        if (!mode.teams[them].bedAlive) {
          this.enterBw('hunt');
          return;
        }
        this.label = 'Going for the bed';
        const head = bed[1];
        const d = Math.hypot(head.x + 0.5 - b.pos.x, head.z + 0.5 - b.pos.z);
        if (d < 3.6) {
          this.breakBed(bed, input);
          return;
        }
        // Out of blocks halfway: head home to buy more.
        if (!this.blockItem() && !this.standingNear(head, 8)) {
          this.enterBw('collect');
          return;
        }
        this.goTo(head.x + 0.5, head.z + 0.5, input, 2.5);
        return;
      }
      case 'hunt': {
        this.label = 'Hunting';
        if (!this.blockItem() && dist > 10) {
          this.enterBw('collect');
          return;
        }
        this.goTo(per.x, per.z, input, 2);
        this.maybeThrow(per, dist);
        return;
      }
    }
  }

  private enterBw(p: BwPhase) {
    this.bw = p;
    this.timer = 0;
    this.mineTarget = null;
    if (this.bot.mining) this.bot.tickMining(false, false);
  }

  /** What it buys this trip, in order, by skill and by what it can afford. */
  private planPurchases(): string[] {
    const b = this.bot;
    const s = this.skill;
    const out: string[] = [];
    let iron = b.countItem('iron_ingot');
    let gold = b.countItem('gold_ingot');
    const want = (key: string, cur: 'iron' | 'gold', cost: number) => {
      if (cur === 'iron' && iron >= cost) {
        iron -= cost;
        out.push(key);
      } else if (cur === 'gold' && gold >= cost) {
        gold -= cost;
        out.push(key);
      }
    };
    const hasSword = SWORDS.slice(0, 3).some((id) => b.countItem(id) > 0);
    want('wool', 'iron', 4);
    want('wool', 'iron', 4);
    if (!hasSword) want('stone_sword', 'iron', 10);
    if (s > 0.25) want('armor1', 'iron', 24);
    if (s > 0.55) want('iron_sword', 'gold', 7);
    if (s > 0.4) want('pickaxe', 'iron', 10);
    while (iron >= 4 && out.filter((k) => k === 'wool').length < 3 + Math.round(s * 3)) want('wool', 'iron', 4);
    if (s > 0.7) want('gapple', 'gold', 3);
    return out;
  }

  /** The cells around a bed (sides and top) to cover with blocks. */
  private bedCover(bed: [Spot, Spot]): Spot[] {
    const cells: Spot[] = [];
    const isBed = (x: number, z: number) => bed.some((c) => c.x === x && c.z === z);
    for (const c of bed) {
      cells.push({ x: c.x, y: c.y + 1, z: c.z });
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const x = c.x + dx;
        const z = c.z + dz;
        if (isBed(x, z) || cells.some((q) => q.x === x && q.z === z && q.y === c.y)) continue;
        cells.push({ x, y: c.y, z });
      }
    }
    // Sides first (they sit on the ground), then the top (on the bed).
    return cells.sort((a, b) => a.y - b.y);
  }

  /** Walks next to `cell` and places a block into it against any solid neighbour face. */
  private placeAt(cell: Spot, input: MoveInput) {
    const b = this.bot;
    const d = Math.hypot(cell.x + 0.5 - b.pos.x, cell.z + 0.5 - b.pos.z);
    if (d > 3.5) {
      this.goTo(cell.x + 0.5, cell.z + 0.5, input, 2.5);
      return;
    }
    // Standing in the cell: step out of it first.
    if (Math.floor(b.pos.x) === cell.x && Math.floor(b.pos.z) === cell.z && Math.abs(b.pos.y - cell.y) < 2) {
      this.moveWorld(input, b.pos.x - (cell.x + 0.5), b.pos.z - (cell.z + 0.5));
      return;
    }
    const faces: [number, number, number][] = [
      [0, -1, 0],
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [0, 1, 0],
    ];
    for (const [nx, ny, nz] of faces) {
      const sx = cell.x + nx;
      const sy = cell.y + ny;
      const sz = cell.z + nz;
      if (!isSolid(this.world.blocks.get(sx, sy, sz))) continue;
      const p = this.h.facePoint(sx, sy, sz, -nx, -ny, -nz);
      if (!p) continue;
      if (!this.equipBlock()) return;
      this.h.aimPoint(p[0], p[1], p[2]);
      if (this.h.settle >= this.aimSettle() && this.placeWait <= 0) {
        const hit = b.crosshairBlock(b.blockReach(), true);
        if (hit && hit.x === sx && hit.y === sy && hit.z === sz && hit.nx === -nx && hit.ny === -ny && hit.nz === -nz) {
          b.startUsingItem(true);
          this.placeWait = this.clickGap();
        }
      }
      return;
    }
    // No visible face: shuffle around a bit.
    this.moveWorld(input, cell.x + 0.5 - b.pos.x, cell.z + 0.5 - b.pos.z);
  }

  /** At their bed: break it, digging through whatever covers it. */
  private breakBed(bed: [Spot, Spot], input: MoveInput) {
    const b = this.bot;
    const blocks = this.world.blocks;
    this.label = 'Breaking the bed';
    input.forward = input.strafe = 0;
    input.sneak = true;
    // Aim at a bed half; whatever the crosshair meets first is what we dig.
    for (const c of bed) {
      if (blocks.get(c.x, c.y, c.z) !== B.BED) continue;
      const eye = b.eyePos();
      const tx = c.x + 0.5;
      const ty = c.y + 0.3;
      const tz = c.z + 0.5;
      this.h.aimPoint(tx, ty, tz);
      if (this.h.settle < this.aimSettle()) return;
      const hit = b.crosshairBlock(b.blockReach(), true);
      if (!hit) {
        // Too far to reach: step closer.
        this.moveWorld(input, tx - eye.x, tz - eye.z);
        input.sneak = false;
        return;
      }
      this.equipToolFor(hit.id);
      const started = !!this.mineTarget && this.mineTarget.x === hit.x && this.mineTarget.y === hit.y && this.mineTarget.z === hit.z;
      this.mineTarget = { x: hit.x, y: hit.y, z: hit.z };
      b.tickMining(true, !started);
      return;
    }
  }

  private equipToolFor(id: number) {
    const b = this.bot;
    const pick = ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'] as ItemId[];
    const axe = ['diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'] as ItemId[];
    const want: ItemId[] =
      id === B.END_STONE || id === B.OBSIDIAN || id === B.COBBLESTONE || id === B.STONE
        ? pick
        : id === B.PLANKS || id === B.OAK_LOG
          ? axe
          : id === B.WOOL
            ? (['shears'] as ItemId[])
            : [];
    for (const t of want) if (b.slotOf(t) >= 0 && this.h.equip(t)) return;
    // The sword or a bare hand for the rest (beds break at once).
    this.h.equip(this.h.weapon);
  }

  // ------------------------------------------------------------------ SkyWars

  private skywars(mode: Skywars, per: Perceived, dist: number, input: MoveInput, closeFight: boolean, fight: () => void) {
    const b = this.bot;
    const m = this.match;
    const me = m.bot === b ? 1 : 0;
    const L = mode.layout;
    const s = this.skill;
    if (m.phase !== 'fight') {
      this.sw = 'cage';
      return;
    }
    if (this.sw === 'cage') {
      this.sw = 'loot';
      this.chestQueue = [...L.islandChests[me]].sort((a, c) => this.distTo(a) - this.distTo(c));
      this.timer = 0;
    }
    if (closeFight) {
      this.label = 'Fighting';
      this.organize();
      fight();
      this.keepOffEdge(per, input);
      return;
    }
    if (this.sw === 'loot') {
      this.label = 'Looting';
      // Low tiers loot one chest and run; high tiers clear the island.
      const want = s < 0.3 ? 1 : s < 0.6 ? 2 : 3;
      const opened = L.islandChests[me].filter((c) => mode.opened[me].has(`${c.x},${c.y},${c.z}`)).length;
      const next = this.chestQueue.find((c) => !mode.opened[me].has(`${c.x},${c.y},${c.z}`));
      if (!next || opened >= want || this.timer > 20 * 40) {
        this.organize();
        this.sw = 'go';
        this.timer = 0;
        return;
      }
      this.lootChest(mode, next, input);
      return;
    }
    // 'go': the best players stop at the middle chests first while the other is still far off.
    this.organize();
    if (s > 0.5 && dist > 12) {
      const mid = L.midChests.find((c) => !mode.opened[me].has(`${c.x},${c.y},${c.z}`) && mode.chestAt(c.x, c.y, c.z) && this.distTo(c) < 26);
      if (mid && this.blockItem()) {
        this.label = 'Middle chests';
        this.lootChest(mode, mid, input);
        return;
      }
    }
    this.label = this.blockItem() ? 'Bridging over' : 'Hunting';
    this.goTo(per.x, per.z, input, 2);
    this.maybeThrow(per, dist);
  }

  private lootChest(mode: Skywars, c: Spot, input: MoveInput) {
    const b = this.bot;
    const m = this.match;
    const d = this.distTo(c);
    if (d > 3.2) {
      this.goTo(c.x + 0.5, c.z + 0.5, input, 2.2);
      this.lootWait = 0;
      return;
    }
    this.h.aimAt(c.x + 0.5, c.y + 0.5, c.z + 0.5, 0.8);
    // Opening the chest and taking what it wants takes time (less for better players).
    if (++this.lootWait < 26 - this.skill * 18) return;
    this.lootWait = 0;
    mode.open(m, b, c.x, c.y, c.z);
    const items = mode.chestAt(c.x, c.y, c.z);
    if (!items) return;
    const order = items.map((s, i) => ({ s, i })).filter((x) => x.s) as { s: ItemStack; i: number }[];
    order.sort((a, z) => lootValue(z.s) - lootValue(a.s));
    for (const { s, i } of order) {
      const copy = { ...s };
      b.addItem(copy);
      items[i] = copy.count > 0 ? copy : null;
    }
    this.organize();
  }

  /**
   * Gear up: best armor in every slot, best sword in slot 1, blocks in slot 2 (like a player
   * sorting their hotbar after looting).
   */
  private organize() {
    const b = this.bot;
    let changed = false;
    for (let i = 0; i < b.inventory.length; i++) {
      const s = b.inventory[i];
      const a = s ? ITEMS[s.id].armor : undefined;
      if (!s || !a || a.glider) continue;
      const cur = b.armorSlots[a.slot];
      if (!cur || lootValue(s) > lootValue(cur)) {
        b.armorSlots[a.slot] = s;
        b.inventory[i] = cur;
        changed = true;
      }
    }
    if (changed) b.recomputeArmor();
    const swap = (id: ItemId | null, slot: number) => {
      if (!id) return;
      const at = b.inventory.findIndex((s) => s?.id === id);
      if (at < 0 || at === slot) return;
      const tmp = b.inventory[slot];
      b.inventory[slot] = b.inventory[at];
      b.inventory[at] = tmp;
    };
    swap(this.bestSword(), 0);
    const block = BLOCK_ITEMS.find((id) => b.countItem(id) > 0) ?? null;
    if (block && b.slotOf(block) < 0) swap(block, 1);
    for (const id of ['snowball', 'egg', 'golden_apple', 'ender_pearl'] as ItemId[]) if (b.countItem(id) > 0 && b.slotOf(id) < 0) swap(id, 2 + ['snowball', 'egg', 'golden_apple', 'ender_pearl'].indexOf(id));
  }

  // ------------------------------------------------------------------ moving and bridging

  private distTo(c: Spot): number {
    return Math.hypot(c.x + 0.5 - this.bot.pos.x, c.z + 0.5 - this.bot.pos.z);
  }

  private standingNear(c: Spot, r: number): boolean {
    return this.distTo(c) < r;
  }

  private aimSettle(): number {
    return Math.max(1, Math.round(this.h.profile.crystal.aimSettle));
  }

  private clickGap(): number {
    return Math.max(1, Math.round(this.h.profile.crystal.clickGap * 0.8));
  }

  /** The strongest sword it carries (for the sword game). */
  private bestSword(): ItemId {
    const b = this.bot;
    for (const id of SWORDS) if (b.countItem(id) > 0) return id;
    return 'wooden_sword';
  }

  private blockItem(): ItemId | null {
    const b = this.bot;
    return BLOCK_ITEMS.find((id) => b.countItem(id) > 0) ?? null;
  }

  private equipBlock(): boolean {
    const b = this.bot;
    const id = BLOCK_ITEMS.find((i) => b.slotOf(i) >= 0);
    if (id) return this.h.equip(id);
    // Blocks only in the inventory: bring them into the hotbar.
    const inv = BLOCK_ITEMS.find((i) => b.invSlotOf(i) >= 0);
    if (!inv) return false;
    const from = b.invSlotOf(inv);
    let to = b.inventory.findIndex((s, i) => i < 9 && !s);
    if (to < 0) to = 8;
    const tmp = b.inventory[to];
    b.inventory[to] = b.inventory[from];
    b.inventory[from] = tmp;
    return this.h.equip(inv);
  }

  /** Sets forward/strafe so that we move along world direction (wx, wz), whatever we look at. */
  private moveWorld(input: MoveInput, wx: number, wz: number) {
    const len = Math.hypot(wx, wz);
    if (len < 1e-4) {
      input.forward = input.strafe = 0;
      return;
    }
    wx /= len;
    wz /= len;
    const s = Math.sin(this.bot.yaw);
    const c = Math.cos(this.bot.yaw);
    input.forward = -s * wx - c * wz;
    input.strafe = c * wx - s * wz;
  }

  /** Solid ground within `depth` blocks under world point (x, z) at our feet level. */
  private groundAt(x: number, z: number, depth = 3): boolean {
    const bl = this.world.blocks;
    const fy = Math.floor(this.bot.pos.y + 0.01);
    for (let y = fy - 1; y >= fy - depth; y--) if (isSolid(bl.get(Math.floor(x), y, Math.floor(z)))) return true;
    return false;
  }

  /** Is their spot at our level or reachable without dropping into the void? */
  private reachable(per: Perceived): boolean {
    // Roughly level with us, and (unless already in reach) ground all the way between: with a
    // gap in between, walking at them only sneaks us to the edge, so we bridge instead.
    const b = this.bot;
    if (Math.abs(per.y - b.pos.y) >= 2.5) return false;
    const dx = per.x - b.pos.x;
    const dz = per.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d <= 3.2) return true;
    for (let t = 0.5; t < d - 0.5; t += 0.5) if (!this.groundAt(b.pos.x + (dx / d) * t, b.pos.z + (dz / d) * t, 4)) return false;
    return true;
  }

  /**
   * Walk toward (gx, gz): straight over ground, and where the ground ends, bridge — sneak to the
   * edge along the main axis and place a block against the side of the one under us.
   */
  private goTo(gx: number, gz: number, input: MoveInput, stopAt: number) {
    const b = this.bot;
    const dx = gx - b.pos.x;
    const dz = gz - b.pos.z;
    const d = Math.hypot(dx, dz);
    // Stuck against something: hop.
    if (Math.hypot(b.pos.x - this.lastPos.x, b.pos.z - this.lastPos.z) < 0.02 && d > stopAt) this.stuck++;
    else this.stuck = 0;
    this.lastPos = { x: b.pos.x, z: b.pos.z };
    if (d <= stopAt) {
      input.forward = input.strafe = 0;
      return;
    }
    // Stuck for a long time (a corner, a pillar in the way): sidestep for a moment.
    if (this.stuck > 60) {
      this.stuck = 0;
      this.detour = 20;
      this.detourSide = this.rng.chance(0.5) ? 1 : -1;
    }
    if (this.detour > 0) {
      this.detour--;
      input.sneak = true;
      input.sprint = false;
      this.moveWorld(input, -dz / d * this.detourSide - dx / d * 0.3, dx / d * this.detourSide - dz / d * 0.3);
      return;
    }
    const ux = dx / d;
    const uz = dz / d;
    const aheadX = b.pos.x + ux * 0.7;
    const aheadZ = b.pos.z + uz * 0.7;
    if (!b.onGround || this.groundAt(aheadX, aheadZ)) {
      // Ground ahead: just walk (sprint), looking where we go.
      this.h.turnTo(yawTowards(dx, dz), 0.1, 0.8);
      input.forward = 1;
      input.strafe = 0;
      input.sprint = d > 4;
      if (this.stuck > 6 && b.onGround) input.jump = true;
      return;
    }
    // The edge: bridge along the bigger axis.
    const ax = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
    const az = ax === 0 ? Math.sign(dz) : 0;
    this.bridge(ax, az, input);
  }

  /** One tick of bridging in direction (ax, az): sneak out over the edge, place, repeat. */
  private bridge(ax: number, az: number, input: MoveInput) {
    const b = this.bot;
    const bl = this.world.blocks;
    this.label = this.label || 'Bridging';
    input.sneak = true;
    input.sprint = false;
    const fy = Math.floor(b.pos.y + 0.01);
    // The block we stand on (the one under our centre, or the last one we can still stand on).
    let cx = Math.floor(b.pos.x);
    let cz = Math.floor(b.pos.z);
    if (!isSolid(bl.get(cx, fy - 1, cz))) {
      // Held up by a corner: the solid cell under our feet (hitbox ±0.3) nearest our centre.
      let best = Infinity;
      let found = false;
      for (const ox of [-0.3, 0.3])
        for (const oz of [-0.3, 0.3]) {
          const x = Math.floor(b.pos.x + ox);
          const z = Math.floor(b.pos.z + oz);
          if (!isSolid(bl.get(x, fy - 1, z))) continue;
          const d = Math.hypot(x + 0.5 - b.pos.x, z + 0.5 - b.pos.z);
          if (d < best) {
            best = d;
            cx = x;
            cz = z;
            found = true;
          }
        }
      if (!found) {
        input.forward = input.strafe = 0;
        return;
      }
    }
    const nx = cx + ax;
    const nz = cz + az;
    if (isSolid(bl.get(nx, fy - 1, nz))) {
      this.moveWorld(input, ax, az);
      return;
    }
    if (!this.equipBlock()) {
      input.forward = input.strafe = 0;
      return;
    }
    // Keep to the middle of the line, and lean out toward the edge.
    const side = ax !== 0 ? cz + 0.5 - b.pos.z : cx + 0.5 - b.pos.x;
    this.moveWorld(input, ax + (ax === 0 ? side * 2 : 0), az + (az === 0 ? side * 2 : 0));
    const p = this.h.facePoint(cx, fy - 1, cz, ax, 0, az);
    if (!p) {
      // Not far enough out to see the side face yet: look down past the edge.
      this.h.turnTo(yawTowards(-ax, -az), 1.25, 1.5);
      return;
    }
    this.h.aimPoint(p[0], p[1], p[2]);
    if (this.h.settle >= this.aimSettle() && this.placeWait <= 0) {
      const hit = b.crosshairBlock(b.blockReach(), true);
      if (hit && hit.x === cx && hit.y === fy - 1 && hit.z === cz && hit.nx === ax && hit.nz === az) {
        b.startUsingItem(true);
        this.placeWait = this.clickGap();
      }
    }
  }

  /**
   * Whatever the input asks for, never walk (or strafe) off an edge into the void by accident:
   * where there is no ground ahead, sneak so the edge holds us.
   */
  private edgeGuard(input: MoveInput) {
    const b = this.bot;
    if (!b.onGround || input.sneak) return;
    const s = Math.sin(b.yaw);
    const c = Math.cos(b.yaw);
    const wx = -s * input.forward + c * input.strafe;
    const wz = -c * input.forward - s * input.strafe;
    const len = Math.hypot(wx, wz);
    if (len < 1e-3) return;
    if (!this.groundAt(b.pos.x + (wx / len) * 0.8, b.pos.z + (wz / len) * 0.8, 6)) {
      input.sneak = true;
      input.sprint = false;
      input.jump = false;
    }
  }

  /**
   * Better players don't fight with the void at their back: if the knockback we'd take (away
   * from them) would carry us off the ground, circle toward solid ground on their side instead.
   */
  private keepOffEdge(per: Perceived, input: MoveInput) {
    const b = this.bot;
    if (this.skill < 0.35 || !b.onGround) return;
    const dx = b.pos.x - per.x;
    const dz = b.pos.z - per.z;
    const d = Math.hypot(dx, dz) || 1;
    if (this.groundAt(b.pos.x + (dx / d) * 1.8, b.pos.z + (dz / d) * 1.8, 6)) return;
    // Pick the direction with ground under it that points most toward them.
    let best: [number, number] | null = null;
    let bestScore = -Infinity;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const wx = Math.cos(a);
      const wz = Math.sin(a);
      if (!this.groundAt(b.pos.x + wx * 1.2, b.pos.z + wz * 1.2, 6)) continue;
      const score = -(wx * dx + wz * dz) / d;
      if (score > bestScore) {
        bestScore = score;
        best = [wx, wz];
      }
    }
    if (best) this.moveWorld(input, best[0], best[1]);
  }

  /** Snowballs and eggs at them from range (they knock people off bridges). */
  private maybeThrow(per: Perceived, dist: number) {
    const b = this.bot;
    if (this.throwCooldown > 0 || dist < 5 || dist > 16 || this.skill < 0.3) return;
    const id = (['snowball', 'egg'] as ItemId[]).find((i) => b.slotOf(i) >= 0);
    if (!id) return;
    this.h.equip(id);
    const h = Math.hypot(per.x - b.pos.x, per.z - b.pos.z);
    const drop = (h / 1.5) ** 2 * 0.015;
    const yaw = yawTowards(per.x - b.pos.x, per.z - b.pos.z);
    const pitch = Math.atan2(per.y + 1 - (b.pos.y + b.eyeHeight()) + drop, h);
    this.h.turnTo(yaw, pitch, 2);
    if (Math.abs(wrapAngle(b.yaw - yaw)) < 4 * DEG) {
      b.startUsingItem(true);
      this.throwCooldown = 14 + this.rng.int(0, 10);
    }
  }
}
