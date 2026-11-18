import { B } from '../game/Blocks';
import { bareName, stateProps } from './formats';

/**
 * Today's ~1000 block names on this game's blocks. Blocks the game has (stone, cobblestone, oak
 * planks and logs, wool, glass, obsidian…) stay themselves; everything else becomes a map block:
 * one of a set of textures (planks, stone, bricks, wool…) in the block's own colour, so a
 * terracotta castle or a quartz bridge still looks like itself. Decoration you walk through
 * (flowers, torches, carpets, signs, rails) is left out; slabs on the floor are left out (their
 * half-step would be a full block to jump); stairs, fences and walls become full blocks.
 */

/** How a map block is drawn: a texture family (textures.ts paints them in grey) and its colour. */
export type MapFamily = 'plain' | 'rough' | 'bricks' | 'planks' | 'log' | 'leaves' | 'wool' | 'sand' | 'stone_bricks' | 'mossy_stone_bricks' | 'cracked_stone_bricks' | 'bedrock';

export interface MapMaterial {
  key: string;
  family: MapFamily;
  /** sRGB colour of the block (white for the exact textures). */
  color: string;
}

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'] as const;
const WOOL: Record<string, string> = { white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9', yellow: '#f8c627', lime: '#70b919', pink: '#ed8dac', gray: '#3e4447', light_gray: '#8e8e86', cyan: '#158991', purple: '#792aac', blue: '#35399d', brown: '#724728', green: '#546d1b', red: '#a12722', black: '#141519' };
const CONCRETE: Record<string, string> = { white: '#cfd5d6', orange: '#e06100', magenta: '#a9309f', light_blue: '#2389c6', yellow: '#f0af15', lime: '#5ea818', pink: '#d5658e', gray: '#36393d', light_gray: '#7d7d73', cyan: '#157788', purple: '#64209c', blue: '#2c2e8f', brown: '#603b1f', green: '#495b24', red: '#8e2020', black: '#080a0f' };
const TERRACOTTA: Record<string, string> = { white: '#d1b2a1', orange: '#a15325', magenta: '#95576c', light_blue: '#706c8a', yellow: '#ba8523', lime: '#677534', pink: '#a04d4e', gray: '#392a23', light_gray: '#876a61', cyan: '#575b5b', purple: '#764656', blue: '#4a3b5b', brown: '#4d3323', green: '#4c532a', red: '#8f3d2e', black: '#251610' };
const WOODS: Record<string, { planks: string; bark: string; leaves: string }> = {
  oak: { planks: '#a2834f', bark: '#6d5533', leaves: '#4a7a20' },
  spruce: { planks: '#735531', bark: '#3a2510', leaves: '#3b5e3b' },
  birch: { planks: '#c0af79', bark: '#d8d7d2', leaves: '#5e7f3a' },
  jungle: { planks: '#a07351', bark: '#554419', leaves: '#3f8f1a' },
  acacia: { planks: '#a85a32', bark: '#676157', leaves: '#4c7a1e' },
  dark_oak: { planks: '#422b14', bark: '#3c2e1a', leaves: '#3a6418' },
  pale_oak: { planks: '#e3d9d4', bark: '#5d5450', leaves: '#a3a69c' },
  mangrove: { planks: '#763631', bark: '#543d20', leaves: '#4c7d1e' },
  cherry: { planks: '#e2b2a6', bark: '#36191e', leaves: '#e5adc2' },
  bamboo: { planks: '#c1ad50', bark: '#7f9032', leaves: '#5c8a2a' },
  crimson: { planks: '#653146', bark: '#5c1a1e', leaves: '#7b0000' },
  warped: { planks: '#2b6963', bark: '#3a3a4c', leaves: '#167e86' },
  azalea: { planks: '#a2834f', bark: '#6d5533', leaves: '#5a7a2a' },
};

/** Named materials (beyond colours and woods): family and colour. */
const NAMED: Record<string, [MapFamily, string]> = {
  bedrock: ['bedrock', '#ffffff'],
  stone_bricks: ['stone_bricks', '#ffffff'],
  mossy_stone_bricks: ['mossy_stone_bricks', '#ffffff'],
  cracked_stone_bricks: ['cracked_stone_bricks', '#ffffff'],
  chiseled_stone_bricks: ['stone_bricks', '#ffffff'],
  granite: ['rough', '#956755'],
  polished_granite: ['plain', '#9a6a59'],
  diorite: ['rough', '#bcbcbc'],
  polished_diorite: ['plain', '#c0c1c2'],
  andesite: ['rough', '#888889'],
  polished_andesite: ['plain', '#848685'],
  deepslate: ['rough', '#505053'],
  cobbled_deepslate: ['rough', '#4d4d51'],
  polished_deepslate: ['plain', '#484849'],
  deepslate_bricks: ['bricks', '#474747'],
  deepslate_tiles: ['bricks', '#363637'],
  tuff: ['rough', '#6c6d66'],
  calcite: ['plain', '#dfe0dc'],
  smooth_stone: ['plain', '#9e9e9e'],
  mossy_cobblestone: ['rough', '#6e7a5e'],
  sandstone: ['plain', '#d8cb9b'],
  red_sandstone: ['plain', '#ba6621'],
  sand: ['sand', '#dbcfa3'],
  red_sand: ['sand', '#be6621'],
  gravel: ['sand', '#837f7e'],
  clay: ['plain', '#a0a6b3'],
  terracotta: ['plain', '#985e43'],
  netherrack: ['rough', '#612626'],
  nether_bricks: ['bricks', '#2c1519'],
  red_nether_bricks: ['bricks', '#450709'],
  blackstone: ['rough', '#2a2328'],
  polished_blackstone: ['plain', '#353038'],
  polished_blackstone_bricks: ['bricks', '#302a30'],
  basalt: ['rough', '#4b4a4f'],
  smooth_basalt: ['plain', '#48484e'],
  end_stone_bricks: ['bricks', '#dadea0'],
  purpur: ['bricks', '#a97fa9'],
  quartz: ['plain', '#ebe5de'],
  quartz_bricks: ['bricks', '#eae5dd'],
  prismarine: ['rough', '#63a39b'],
  prismarine_bricks: ['bricks', '#63ab9e'],
  dark_prismarine: ['bricks', '#335b4b'],
  bricks: ['bricks', '#966153'],
  mud_bricks: ['bricks', '#89684f'],
  packed_mud: ['plain', '#8e6b50'],
  mud: ['sand', '#3c393d'],
  snow: ['plain', '#f9fefe'],
  ice: ['plain', '#91b7fd'],
  packed_ice: ['plain', '#8db4fa'],
  blue_ice: ['plain', '#74a7fd'],
  crying_obsidian: ['rough', '#20093c'],
  sea_lantern: ['plain', '#acc8be'],
  shroomlight: ['plain', '#f19046'],
  redstone_lamp: ['plain', '#9c6a3a'],
  iron: ['plain', '#dcdcdc'],
  gold: ['plain', '#f6d03d'],
  diamond: ['plain', '#62ede4'],
  emerald: ['plain', '#2ab047'],
  lapis: ['plain', '#1f438c'],
  redstone: ['plain', '#af1805'],
  coal: ['plain', '#151515'],
  copper: ['plain', '#c06c50'],
  exposed_copper: ['plain', '#a17e68'],
  weathered_copper: ['plain', '#6c996e'],
  oxidized_copper: ['plain', '#52a385'],
  netherite: ['plain', '#423d3f'],
  amethyst: ['rough', '#8561bf'],
  hay: ['planks', '#a68b0c'],
  bone: ['plain', '#e5e1cf'],
  sponge: ['rough', '#c3c04a'],
  slime: ['plain', '#6fc05b'],
  honey: ['plain', '#fbb933'],
  melon: ['plain', '#6f9119'],
  pumpkin: ['plain', '#c67519'],
  moss: ['wool', '#596e2d'],
  coarse_dirt: ['sand', '#77553a'],
  podzol: ['sand', '#5c3f18'],
  mycelium: ['sand', '#6f6265'],
  dirt_path: ['sand', '#94793f'],
  farmland: ['sand', '#8f6743'],
  rooted_dirt: ['sand', '#90674c'],
  soul_sand: ['sand', '#513e32'],
  soul_soil: ['sand', '#4b3a2e'],
  magma: ['rough', '#8e3f1f'],
  nether_wart: ['wool', '#720b0b'],
  warped_wart: ['wool', '#167e86'],
  dark: ['plain', '#2a2a2e'],
  ore: ['rough', '#7d7d7d'],
  mushroom: ['plain', '#c9aa78'],
  red_mushroom_block: ['plain', '#c82e2d'],
  brown_mushroom_block: ['plain', '#957051'],
  dried_kelp: ['plain', '#323b26'],
  cactus: ['plain', '#5a8a2c'],
  reinforced_deepslate: ['rough', '#505053'],
  generic: ['rough', '#8a8a8a'],
};

export const MAP_MATERIALS: MapMaterial[] = [];
const INDEX = new Map<string, number>();
function add(key: string, family: MapFamily, color: string) {
  INDEX.set(key, MAP_MATERIALS.length);
  MAP_MATERIALS.push({ key, family, color });
}
for (const c of COLORS) {
  add(`${c}_wool`, 'wool', WOOL[c]);
  add(`${c}_concrete`, 'plain', CONCRETE[c]);
  add(`${c}_terracotta`, 'plain', TERRACOTTA[c]);
}
for (const [w, c] of Object.entries(WOODS)) {
  add(`${w}_planks`, 'planks', c.planks);
  add(`${w}_log`, 'log', c.bark);
  add(`${w}_leaves`, 'leaves', c.leaves);
}
for (const [k, [f, c]] of Object.entries(NAMED)) add(k, f, c);
if (MAP_MATERIALS.length > 255) throw new Error('Too many map materials');

/** A cell of this game: block id and its data (`amount`). */
export interface Cell {
  id: number;
  data: number;
}

const AIR: Cell = { id: B.AIR, data: 0 };
const mat = (key: string): Cell => ({ id: B.MAP, data: INDEX.get(key) ?? INDEX.get('generic')! });

/** Things you walk through, too small to matter, or not a block at all. */
const PASS =
  /(carpet|flower|torch|sign|button|pressure_plate|rail$|^short_grass|^tall_grass|^grass$|fern$|vine|ladder|_door$|^door|banner|_head$|_skull$|flower_pot|potted_|sapling|^(red|brown)_mushroom$|dandelion|poppy|orchid|allium|bluet|tulip|daisy|cornflower|lily|rose_bush|peony|lilac|sunflower|bush$|sugar_cane|wheat|carrots|potatoes|beetroots|(pumpkin|melon)_stem$|cocoa|lever|tripwire|redstone_wire|repeater|comparator|^snow$|barrier|structure_void|^light$|^fire$|soul_fire|portal|kelp|seagrass|coral(?!_block)|sea_pickle|^(soul_)?lantern$|(^|_)chain$|trapdoor|candle|item_frame|scaffolding|end_rod|lightning_rod|hanging_roots|spore_blossom|glow_lichen|sculk_vein|cave_vines|weeping_vines|twisting_vines|roots$|sprouts$|fungus$|dripleaf|azalea$|pink_petals|leaf_litter|frogspawn|moss_carpet|bubble_column|piston_head|moving_piston|^air$|cave_air|void_air)/;

/** This game's cell for a block state ("oak_stairs[half=bottom]"), or air. */
export function mapCell(state: string): Cell {
  const name = bareName(state);
  if (!name.endsWith('_leaves') && PASS.test(name)) return AIR;
  if (name === 'water' || name === 'bubble_column') return { id: B.WATER, data: 0 };
  if (name === 'lava') return { id: B.LAVA, data: 0 };
  if (name === 'cobweb') return { id: B.COBWEB, data: 0 };
  if (name.endsWith('_slab')) {
    const p = stateProps(state);
    // A floor slab would be a full block to jump onto: leave it out.
    if ((p.type ?? 'bottom') === 'bottom') return AIR;
    return material(name.slice(0, -5));
  }
  return material(name.replace(/_(stairs|fence_gate|fence|wall)$/, ''));
}

function material(name: string): Cell {
  switch (name) {
    case 'stone':
      return { id: B.STONE, data: 0 };
    case 'cobblestone':
      return { id: B.COBBLESTONE, data: 0 };
    case 'oak_planks':
    case 'oak':
      return { id: B.PLANKS, data: 0 };
    case 'oak_log':
    case 'oak_wood':
      return { id: B.OAK_LOG, data: 0 };
    case 'obsidian':
      return { id: B.OBSIDIAN, data: 0 };
    case 'glowstone':
      return { id: B.GLOWSTONE, data: 0 };
    case 'end_stone':
      return { id: B.END_STONE, data: 0 };
    case 'dirt':
      return { id: B.DIRT, data: 0 };
    case 'grass_block':
      return { id: B.GRASS, data: 0 };
    case 'tnt':
      return { id: B.TNT, data: 0 };
    case 'red_wool':
      return { id: B.WOOL, data: 0 };
    case 'blue_wool':
      return { id: B.WOOL, data: 1 };
    case 'white_wool':
      return { id: B.WOOL, data: 2 };
    case 'chest':
    case 'trapped_chest':
      return { id: B.CHEST, data: 0 };
    // An ender chest refills your kit in a duel: on a map it's just a dark block.
    case 'ender_chest':
      return mat('dark');
  }
  if (name === 'glass' || name === 'tinted_glass' || name.endsWith('stained_glass') || name.endsWith('glass_pane') || name === 'iron_bars') return { id: B.GLASS, data: 0 };
  if (INDEX.has(name)) return mat(name);
  // Colours: wool, concrete (and powder), terracotta (and glazed), shulker boxes, beds.
  const colour = /^(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)_(.+)$/.exec(name);
  if (colour) {
    const [, c, rest] = colour;
    if (rest === 'wool' || rest === 'bed') return mat(`${c}_wool`);
    if (rest.startsWith('concrete') || rest === 'shulker_box') return mat(`${c}_concrete`);
    if (rest.includes('terracotta')) return mat(`${c}_terracotta`);
  }
  // Woods: planks, logs, wood, stems, hyphae, leaves, and things made of them.
  const wood = /^(?:stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|pale_oak|mangrove|cherry|bamboo|crimson|warped|azalea|flowering_azalea)(?:_(planks|log|wood|stem|hyphae|leaves|block|mosaic|trapdoor))?$/.exec(name);
  if (wood) {
    const w = wood[1] === 'flowering_azalea' ? 'azalea' : wood[1];
    const part = wood[2] ?? 'planks';
    const stripped = name.startsWith('stripped_');
    if (part === 'leaves') return mat(`${w}_leaves`);
    if ((part === 'log' || part === 'wood' || part === 'stem' || part === 'hyphae' || part === 'block') && !stripped) return w === 'oak' ? { id: B.OAK_LOG, data: 0 } : mat(`${w}_log`);
    return w === 'oak' ? { id: B.PLANKS, data: 0 } : mat(`${w}_planks`);
  }
  // Everything else, by what its name says.
  const rules: [RegExp, string][] = [
    // (Names containing "stone_brick" that aren't stone bricks come first.)
    [/polished_blackstone_brick/, 'polished_blackstone_bricks'],
    [/blackstone/, 'polished_blackstone'],
    [/end_stone_brick/, 'end_stone_bricks'],
    [/mossy_stone_brick/, 'mossy_stone_bricks'],
    [/cracked_stone_brick/, 'cracked_stone_bricks'],
    [/stone_brick/, 'stone_bricks'],
    [/deepslate_(brick|tile)/, 'deepslate_bricks'],
    [/deepslate/, 'deepslate'],
    [/red_nether_brick/, 'red_nether_bricks'],
    [/nether_brick/, 'nether_bricks'],
    [/mud_brick/, 'mud_bricks'],
    [/red_sandstone/, 'red_sandstone'],
    [/sandstone/, 'sandstone'],
    [/quartz/, 'quartz'],
    [/purpur/, 'purpur'],
    [/prismarine/, 'prismarine'],
    [/brick/, 'bricks'],
    [/granite/, 'granite'],
    [/diorite/, 'diorite'],
    [/andesite/, 'andesite'],
    [/tuff/, 'tuff'],
    [/basalt/, 'basalt'],
    [/oxidized_copper|oxidized_cut/, 'oxidized_copper'],
    [/weathered_copper|weathered_cut/, 'weathered_copper'],
    [/exposed_copper|exposed_cut/, 'exposed_copper'],
    [/copper/, 'copper'],
    [/_ore$/, 'ore'],
    [/^(iron|gold|diamond|emerald|lapis|redstone|coal|netherite|copper|amethyst|hay|bone|slime|honey|nether_wart|warped_wart)_block$/, ''],
    [/ice/, 'ice'],
    [/snow/, 'snow'],
    [/cobblestone/, 'mossy_cobblestone'],
    [/smooth_stone|stone/, 'smooth_stone'],
    [/bookshelf|crafting_table|barrel|lectern|loom|composter|beehive|bee_nest|note_block|jukebox|chiseled_bookshelf|cartography|fletching|smithing/, 'spruce_planks'],
    [/furnace|smoker|dispenser|dropper|observer|piston|spawner|anvil|cauldron|hopper|blast/, 'dark'],
    [/pumpkin|jack_o_lantern/, 'pumpkin'],
    [/mushroom/, 'mushroom'],
    [/obsidian/, 'crying_obsidian'],
  ];
  for (const [re, key] of rules) {
    if (!re.test(name)) continue;
    return mat(key || name.replace(/_block$/, ''));
  }
  return mat('generic');
}
