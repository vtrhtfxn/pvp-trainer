import type { KitDef } from '../kits';
import { Bedwars } from './Bedwars';
import type { GameMode } from './GameMode';
import { Skywars } from './Skywars';
import { Crumble } from './Crumble';
import { HotPotato } from './HotPotato';
import { Sumo } from './Sumo';
import { Whodunit } from './Whodunit';

/** The minigame a kit plays (Bed Wars, SkyWars), or null for a plain duel. */
export function createMode(kit: KitDef): GameMode | null {
  switch (kit.mode) {
    case 'bedwars':
      return new Bedwars();
    case 'skywars':
      return new Skywars();
    case 'sumo':
      return new Sumo();
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
