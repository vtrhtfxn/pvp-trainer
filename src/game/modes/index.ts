import type { KitDef } from '../kits';
import { Bedwars } from './Bedwars';
import type { GameMode } from './GameMode';
import { Skywars } from './Skywars';
import { Crumble } from './Crumble';
import { HotPotato } from './HotPotato';
import { ItemSumo } from './ItemSumo';
import { Sumo } from './Sumo';
import { Whodunit } from './Whodunit';

/**
 * The minigame a kit plays (Bed Wars, SkyWars), or null for a plain duel. `map` picks the map of
 * a mode with several (Item Sumo): the host's choice online; `pick` (0–1) chooses one otherwise.
 */
export function createMode(kit: KitDef, opts: { map?: string; pick?: number } = {}): GameMode | null {
  switch (kit.mode) {
    case 'bedwars':
      return new Bedwars();
    case 'skywars':
      return new Skywars();
    case 'sumo':
      return new Sumo();
    case 'itemsumo':
      return new ItemSumo(opts.map, opts.pick);
    case 'crumble':
      return new Crumble();
    case 'hotpotato':
      return new HotPotato();
    case 'whodunit':
      return new Whodunit();
    default:
      return null;
  }
}
