import type { PackFile } from '../render/resourcePack';

/**
 * Sounds a resource pack can replace, by the game's sound event: the files a pack keeps under
 * assets/minecraft/sounds/ (the same paths since 1.9; 1.8 packs use them too for hurt, steps,
 * eating and the like). An event with several files picks one at random each time, as the game
 * does. The game itself ships no Minecraft sounds for these: without a pack they are synthesised.
 */
const range = (base: string, n: number) => Array.from({ length: n }, (_, i) => `${base}${i + 1}`);

export const PACK_SOUNDS = {
  hurt: range('damage/hit', 3),
  hitStrong: range('entity/player/attack/strong', 6),
  hitWeak: range('entity/player/attack/weak', 4),
  hitCrit: range('entity/player/attack/crit', 3),
  hitKnockback: range('entity/player/attack/knockback', 4),
  sweep: range('entity/player/attack/sweep', 7),
  noDamage: range('entity/player/attack/nodamage', 4),
  step: range('step/grass', 6),
  stepStone: range('step/stone', 6),
  stepWood: range('step/wood', 6),
  landSmall: ['damage/fallsmall'],
  landBig: ['damage/fallbig'],
  eat: range('random/eat', 3),
  drink: ['random/drink'],
  burp: ['random/burp'],
  bow: ['random/bow'],
  arrowHit: range('random/bowhit', 4),
  arrowDing: ['random/successful_hit'],
  pickup: ['random/pop'],
  glass: range('random/glass', 3),
  orb: ['random/orb'],
  itemBreak: ['random/break'],
  totem: ['item/totem/use_totem'],
  explode: range('random/explode', 4),
  shieldBlock: range('item/shield/block', 5),
  crossbowShoot: range('item/crossbow/shoot', 3),
  smashAir: range('item/mace/smash_air', 3),
  smashGround: range('item/mace/smash_ground', 4),
  smashHeavy: ['item/mace/smash_ground_heavy'],
  windBurst: range('entity/wind_charge/wind_burst', 3),
  thunder: range('ambient/weather/thunder', 3),
} as const;

export type PackSound = keyof typeof PACK_SOUNDS;

/** Every file path above: the only sounds read from a pack. */
export const KNOWN_SOUND_KEYS: ReadonlySet<string> = new Set(Object.values(PACK_SOUNDS).flat());

let pending: Map<string, PackFile> = new Map();

/** The active pack's sound files (set at startup; read by Sound once audio is allowed to start). */
export function setPackSounds(files: Map<string, PackFile>) {
  pending = files;
}

export function packSoundFiles(): Map<string, PackFile> {
  return pending;
}
