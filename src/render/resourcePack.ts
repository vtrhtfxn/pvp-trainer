import { readZip, type ZipEntry } from './zip';

/**
 * Minecraft resource packs: which of a pack's files stand for which of the game's textures.
 *
 * The game keys its textures by their path under assets/minecraft/textures in today's layout
 * ("item/diamond_sword"). Packs made for 1.8–1.12 use the old folders and names ("items/",
 * "blocks/web", "items/apple_golden") and draw the HUD from two atlases (gui/icons.png,
 * gui/widgets.png); packs for 1.21.2+ keep armor under entity/equipment. All of those are mapped
 * here. Anything the game has no use for is ignored.
 */

export interface PackFile {
  name: string;
  read(): Promise<Uint8Array>;
}

export interface ParsedPack {
  /** From pack.mcmeta (plain text; § formatting codes removed). */
  description: string;
  /** pack.png, if there is one. */
  icon: PackFile | null;
  /** Game texture key → the pack file that replaces it. */
  textures: Map<string, PackFile>;
  /** Old-style atlases the HUD sprites are cut from. */
  atlases: { icons?: PackFile; widgets?: PackFile };
  /** Undyed leather armor (item and model layers) the team colours are dyed from. */
  leather: Map<string, PackFile>;
}

/** 1.8–1.12 names (after items/ → item/, blocks/ → block/) for today's. */
const LEGACY: Record<string, string> = {
  'item/apple_golden': 'item/golden_apple',
  'item/beef_cooked': 'item/cooked_beef',
  'item/bow_standby': 'item/bow',
  'item/bucket_empty': 'item/bucket',
  'item/bucket_lava': 'item/lava_bucket',
  'item/bucket_water': 'item/water_bucket',
  'item/gold_helmet': 'item/golden_helmet',
  'item/gold_chestplate': 'item/golden_chestplate',
  'item/gold_leggings': 'item/golden_leggings',
  'item/gold_boots': 'item/golden_boots',
  'item/wood_sword': 'item/wooden_sword',
  'item/wood_axe': 'item/wooden_axe',
  'item/wood_pickaxe': 'item/wooden_pickaxe',
  'item/potion_bottle_splash': 'item/splash_potion',
  'item/fireball': 'item/fire_charge',
  'item/totem': 'item/totem_of_undying',
  'item/chorus_fruit': 'item/chorus_fruit',
  'item/tipped_arrow_base': 'item/tipped_arrow_base',
  'item/tipped_arrow_head': 'item/tipped_arrow_head',
  'block/web': 'block/cobweb',
  'block/planks_oak': 'block/oak_planks',
  'block/log_oak': 'block/oak_log',
  'block/log_oak_top': 'block/oak_log_top',
  'block/leaves_oak': 'block/oak_leaves',
  'block/stonebrick': 'block/stone_bricks',
  'block/stonebrick_cracked': 'block/cracked_stone_bricks',
  'block/stonebrick_mossy': 'block/mossy_stone_bricks',
  'block/wool_colored_white': 'block/white_wool',
  'block/wool_colored_red': 'block/red_wool',
  'block/wool_colored_blue': 'block/blue_wool',
  'block/grass_side': 'block/grass_block_side',
  'block/grass_top': 'block/grass_block_top',
  'block/grass_side_overlay': 'block/grass_block_side_overlay',
  'block/rail_normal': 'block/rail',
  'block/fire_layer_0': 'block/fire_0',
  'block/end_stone': 'block/end_stone',
  'entity/arrow': 'entity/projectiles/arrow',
  'entity/tipped_arrow': 'entity/projectiles/tipped_arrow',
  'entity/endercrystal/endercrystal': 'entity/end_crystal/end_crystal',
  'misc/enchanted_item_glint': 'misc/enchanted_glint_item',
  'models/armor/gold_layer_1': 'models/armor/golden_layer_1',
  'models/armor/gold_layer_2': 'models/armor/golden_layer_2',
};

/** 1.21.2+ armor (entity/equipment/humanoid[_leggings]/<material>) as the old layer files. */
const EQUIPMENT_MATERIAL: Record<string, string> = { gold: 'golden', diamond: 'diamond', iron: 'iron', chainmail: 'chainmail', netherite: 'netherite', leather: 'leather' };

/** Leather pieces the team colours are dyed from (keys as they come out of mapPath). */
const LEATHER_SOURCES = new Set([
  'item/leather_helmet',
  'item/leather_chestplate',
  'item/leather_leggings',
  'item/leather_boots',
  'item/leather_helmet_overlay',
  'item/leather_chestplate_overlay',
  'item/leather_leggings_overlay',
  'item/leather_boots_overlay',
  'models/armor/leather_layer_1',
  'models/armor/leather_layer_2',
  'models/armor/leather_layer_1_overlay',
  'models/armor/leather_layer_2_overlay',
]);

/**
 * The game texture key for a path under assets/minecraft/textures/ (without ".png"), in either
 * the old or the new layout. Not every result is a texture the game uses.
 */
export function mapPath(rel: string): string {
  let k = rel.replace(/\.png$/i, '');
  k = k.replace(/^items\//, 'item/').replace(/^blocks\//, 'block/');
  const eq = /^entity\/equipment\/humanoid(_leggings)?\/([a-z]+)(_overlay)?$/.exec(k);
  if (eq) {
    const mat = EQUIPMENT_MATERIAL[eq[2]];
    if (mat) return `models/armor/${mat}_layer_${eq[1] ? 2 : 1}${eq[3] ?? ''}`;
  }
  // 1.8–1.12 armor names ("items/gold_helmet") and the rest of the renames.
  return LEGACY[k] ?? k;
}

/** Plain text from a pack.mcmeta description (a string or a text component). */
function describe(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(describe).join('');
  if (v && typeof v === 'object') {
    const o = v as { text?: unknown; extra?: unknown };
    return describe(o.text ?? '') + describe(o.extra ?? '');
  }
  return '';
}

/**
 * Sorts a pack's files into what the game can use. `known` is the set of the game's own texture
 * keys: only those (and the atlases and leather the game derives textures from) are kept.
 * A pack zipped with its folder inside ("MyPack/assets/…") works too.
 */
export async function parsePack(files: PackFile[], known: ReadonlySet<string>): Promise<ParsedPack> {
  const marker = 'assets/minecraft/textures/';
  // Where the pack's root is: the folder holding assets/ (and pack.mcmeta).
  let root = '';
  for (const f of files) {
    const i = f.name.toLowerCase().indexOf(marker);
    if (i >= 0) {
      root = f.name.slice(0, i);
      break;
    }
  }
  const pack: ParsedPack = { description: '', icon: null, textures: new Map(), atlases: {}, leather: new Map() };
  for (const f of files) {
    if (!f.name.startsWith(root)) continue;
    const rest = f.name.slice(root.length);
    if (rest.toLowerCase() === 'pack.png') pack.icon = f;
    else if (rest.toLowerCase() === 'pack.mcmeta') {
      try {
        const meta = JSON.parse(new TextDecoder().decode(await f.read())) as { pack?: { description?: unknown } };
        pack.description = describe(meta.pack?.description).replace(/§./g, '').trim();
      } catch {
        // A broken pack.mcmeta only loses the description.
      }
    } else if (rest.toLowerCase().startsWith(marker) && /\.png$/i.test(rest)) {
      const key = mapPath(rest.slice(marker.length).toLowerCase());
      if (key === 'gui/icons') pack.atlases.icons = f;
      else if (key === 'gui/widgets') pack.atlases.widgets = f;
      else if (LEATHER_SOURCES.has(key)) pack.leather.set(key, f);
      else if (known.has(key)) {
        pack.textures.set(key, f);
        // Old packs have one glint for items and armor.
        if (key === 'misc/enchanted_glint_item' && !pack.textures.has('misc/enchanted_glint_armor') && known.has('misc/enchanted_glint_armor')) {
          pack.textures.set('misc/enchanted_glint_armor', f);
        }
      }
    }
  }
  return pack;
}

/** A pack in a .zip file. */
export async function parseZipPack(bytes: Uint8Array, known: ReadonlySet<string>): Promise<ParsedPack> {
  const entries: ZipEntry[] = readZip(bytes);
  return parsePack(entries, known);
}

/**
 * Where the HUD sprites sit on the old atlases, in 256-wide atlas pixels (gui/icons.png and
 * gui/widgets.png, 1.8–1.19). Heart rows: Gui.renderHearts' u offsets.
 */
export const ICON_SPRITES: Record<string, [number, number, number, number]> = {
  'gui/sprites/hud/crosshair': [0, 0, 15, 15],
  // (1.9–1.19: the attack indicator, from GuiIngame.renderAttackIndicator.)
  'gui/sprites/hud/crosshair_attack_indicator_full': [68, 94, 16, 16],
  'gui/sprites/hud/crosshair_attack_indicator_background': [36, 94, 16, 4],
  'gui/sprites/hud/crosshair_attack_indicator_progress': [52, 94, 16, 4],
  'gui/sprites/hud/heart/container': [16, 0, 9, 9],
  'gui/sprites/hud/heart/container_blinking': [25, 0, 9, 9],
  'gui/sprites/hud/heart/full': [52, 0, 9, 9],
  'gui/sprites/hud/heart/half': [61, 0, 9, 9],
  'gui/sprites/hud/heart/full_blinking': [70, 0, 9, 9],
  'gui/sprites/hud/heart/half_blinking': [79, 0, 9, 9],
  'gui/sprites/hud/heart/poisoned_full': [88, 0, 9, 9],
  'gui/sprites/hud/heart/poisoned_half': [97, 0, 9, 9],
  'gui/sprites/hud/heart/poisoned_full_blinking': [106, 0, 9, 9],
  'gui/sprites/hud/heart/poisoned_half_blinking': [115, 0, 9, 9],
  'gui/sprites/hud/heart/withered_full': [124, 0, 9, 9],
  'gui/sprites/hud/heart/withered_half': [133, 0, 9, 9],
  'gui/sprites/hud/heart/withered_full_blinking': [142, 0, 9, 9],
  'gui/sprites/hud/heart/withered_half_blinking': [151, 0, 9, 9],
  'gui/sprites/hud/heart/absorbing_full': [160, 0, 9, 9],
  'gui/sprites/hud/heart/absorbing_half': [169, 0, 9, 9],
  'gui/sprites/hud/armor_empty': [16, 9, 9, 9],
  'gui/sprites/hud/armor_half': [25, 9, 9, 9],
  'gui/sprites/hud/armor_full': [34, 9, 9, 9],
  'gui/sprites/hud/food_empty': [16, 27, 9, 9],
  'gui/sprites/hud/food_full': [52, 27, 9, 9],
  'gui/sprites/hud/food_half': [61, 27, 9, 9],
  'gui/sprites/hud/food_full_hunger': [88, 27, 9, 9],
  'gui/sprites/hud/food_half_hunger': [97, 27, 9, 9],
  'gui/sprites/hud/food_empty_hunger': [133, 27, 9, 9],
};
export const WIDGET_SPRITES: Record<string, [number, number, number, number]> = {
  'gui/sprites/hud/hotbar': [0, 0, 182, 22],
  'gui/sprites/hud/hotbar_selection': [0, 22, 24, 23],
  'gui/sprites/hud/hotbar_offhand_left': [24, 22, 29, 24],
};

/** Vanilla dye colours of the team leather armor (DyeColor.RED / BLUE texture diffuse colours). */
export const TEAM_LEATHER: Record<'red' | 'blue', string> = { red: '#b02e26', blue: '#3c44aa' };
