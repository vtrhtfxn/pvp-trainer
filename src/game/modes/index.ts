import type { KitDef } from '../kits';
import { Bedwars } from './Bedwars';
import type { GameMode } from './GameMode';
import { Skywars } from './Skywars';

/** The minigame a kit plays (Bed Wars, SkyWars), or null for a plain duel. */
export function createMode(kit: KitDef): GameMode | null {
  return kit.mode === 'bedwars' ? new Bedwars() : kit.mode === 'skywars' ? new Skywars() : null;
}
