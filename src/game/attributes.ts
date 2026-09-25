/**
 * Entity attributes, as `/attribute` sees them (1.21 names, defaults and limits). A fighter keeps
 * only the base values; items, armor and effects are applied on top by the getters in Fighter,
 * the same way vanilla's attribute modifiers are (a sword's −2.4 attack speed on the base 4, …).
 */
export type AttributeId =
  | 'entity_interaction_range'
  | 'block_interaction_range'
  | 'attack_damage'
  | 'attack_speed'
  | 'attack_knockback'
  | 'movement_speed'
  | 'sneaking_speed'
  | 'jump_strength'
  | 'gravity'
  | 'max_health'
  | 'max_absorption'
  | 'armor'
  | 'armor_toughness'
  | 'knockback_resistance'
  | 'explosion_knockback_resistance'
  | 'safe_fall_distance'
  | 'fall_damage_multiplier'
  | 'block_break_speed'
  | 'burning_time';

export interface AttributeDef {
  /** Display name (the attribute's translation in English). */
  name: string;
  def: number;
  min: number;
  max: number;
}

export const ATTRIBUTES: Record<AttributeId, AttributeDef> = {
  entity_interaction_range: { name: 'Entity Interaction Range', def: 3, min: 0, max: 64 },
  block_interaction_range: { name: 'Block Interaction Range', def: 4.5, min: 0, max: 64 },
  attack_damage: { name: 'Attack Damage', def: 1, min: 0, max: 2048 },
  attack_speed: { name: 'Attack Speed', def: 4, min: 0, max: 1024 },
  attack_knockback: { name: 'Attack Knockback', def: 0, min: 0, max: 5 },
  movement_speed: { name: 'Speed', def: 0.1, min: 0, max: 1024 },
  sneaking_speed: { name: 'Sneaking Speed', def: 0.3, min: 0, max: 1 },
  jump_strength: { name: 'Jump Strength', def: 0.42, min: 0, max: 32 },
  gravity: { name: 'Gravity', def: 0.08, min: -1, max: 1 },
  max_health: { name: 'Max Health', def: 20, min: 1, max: 1024 },
  max_absorption: { name: 'Max Absorption', def: 0, min: 0, max: 2048 },
  armor: { name: 'Armor', def: 0, min: 0, max: 30 },
  armor_toughness: { name: 'Armor Toughness', def: 0, min: 0, max: 20 },
  knockback_resistance: { name: 'Knockback Resistance', def: 0, min: 0, max: 1 },
  explosion_knockback_resistance: { name: 'Explosion Knockback Resistance', def: 0, min: 0, max: 1 },
  safe_fall_distance: { name: 'Safe Fall Distance', def: 3, min: -1024, max: 1024 },
  fall_damage_multiplier: { name: 'Fall Damage Multiplier', def: 1, min: 0, max: 100 },
  block_break_speed: { name: 'Block Break Speed', def: 1, min: 0, max: 1024 },
  burning_time: { name: 'Burning Time', def: 1, min: 0, max: 1024 },
};

export const ATTRIBUTE_IDS = Object.keys(ATTRIBUTES) as AttributeId[];

export type Attributes = Record<AttributeId, number>;

export function defaultAttributes(): Attributes {
  const out = {} as Attributes;
  for (const id of ATTRIBUTE_IDS) out[id] = ATTRIBUTES[id].def;
  return out;
}

/** Accepts "minecraft:entity_interaction_range", "entity_interaction_range" and the pre-1.21.2 "generic." forms. */
export function parseAttributeId(s: string): AttributeId | null {
  const id = s
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/^(generic|player)\./, '');
  return id in ATTRIBUTES ? (id as AttributeId) : null;
}

export type GameMode = 'survival' | 'creative' | 'adventure' | 'spectator';
export const GAME_MODES: GameMode[] = ['survival', 'creative', 'adventure', 'spectator'];
