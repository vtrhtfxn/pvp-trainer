import deadwood from '../assets/maps/arenas/deadwood.json';
import frostbite from '../assets/maps/arenas/frostbite_rage.json';
import jurassic from '../assets/maps/arenas/jurassic_attack_ffa.json';
import piazza from '../assets/maps/arenas/la_piazza.json';
import paladin from '../assets/maps/arenas/paladin_banners.json';
import type { GameMap } from './gameMap';

/**
 * Duel arenas that come with the game: FFA maps from Overcast Community (CC BY-SA 4.0, see
 * src/assets/maps/LICENSE.md), turned into arenas the same way an imported world is.
 */
export const BUILTIN_ARENAS = [piazza, deadwood, frostbite, jurassic, paladin] as unknown as GameMap[];
