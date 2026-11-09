import type { Fighter } from '../Fighter';
import type { ItemStack } from '../items';
import type { GameMode, ModeHost } from './GameMode';

export const CHEST_SLOTS = 27;

/**
 * A mode with containers you right-click and move items in and out of: SkyWars loot chests, and
 * the Bed Wars ender chest (your own storage, the same in every ender chest). The chest screen,
 * the replay actions and the online server all go through this.
 */
export interface ChestMode {
  /** The slots `f` sees in the container at (x, y, z), or null if there is none. */
  storageFor(f: Fighter, x: number, y: number, z: number): (ItemStack | null)[] | null;
  /** It exists and is within reach (6 blocks of `f`'s eyes), and `f` is alive. */
  canUse(f: Fighter, x: number, y: number, z: number): boolean;
  /** `f` right-clicked it. */
  open(m: ModeHost, f: Fighter, x: number, y: number, z: number): void;
  /** Slot `i` → `f`. */
  take(f: Fighter, x: number, y: number, z: number, i: number): void;
  takeAll(f: Fighter, x: number, y: number, z: number): void;
  /** `f`'s inventory slot `i` → the container. */
  put(f: Fighter, x: number, y: number, z: number, i: number): void;
}

export function isChestMode(mode: GameMode | null | undefined): mode is GameMode & ChestMode {
  return !!mode && typeof (mode as Partial<ChestMode>).storageFor === 'function';
}

export function inReach(f: Fighter, x: number, y: number, z: number): boolean {
  const e = f.eyePos();
  return !f.dead && Math.hypot(e.x - (x + 0.5), e.y - (y + 0.5), e.z - (z + 0.5)) <= 6;
}

/** Container slot `i` → `f`: as much as fits. */
export function takeFrom(items: (ItemStack | null)[], f: Fighter, i: number) {
  const s = items[i];
  if (!s) return;
  const copy = { ...s };
  f.addItem(copy);
  items[i] = copy.count > 0 ? copy : null;
}

/** `f`'s inventory slot `i` → the container's first empty slot. */
export function putInto(items: (ItemStack | null)[], f: Fighter, i: number) {
  const s = f.inventory[i];
  if (!s) return;
  const j = items.findIndex((it) => !it);
  if (j < 0) return;
  items[j] = s;
  f.inventory[i] = null;
}
