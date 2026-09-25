import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../ai/difficulty';
import { lookDir, V3 } from '../core/math';
import { ATTRIBUTE_IDS, GAME_MODES, parseAttributeId, type AttributeId, type GameMode } from '../game/attributes';
import { B, BLOCK_NAMES } from '../game/Blocks';
import type { Fighter } from '../game/Fighter';
import { EFFECT_NAMES, ITEMS, POTIONS, type EffectId, type Enchants, type ItemId, type ItemStack, type PotionId } from '../game/items';
import { KITS, type KitId } from '../game/kits';
import type { ArgType, Reader } from './dispatcher';
import type { CmdCtx } from './host';

type Arg<T> = ArgType<T, CmdCtx>;

const ns = (s: string) => s.toLowerCase().replace(/^minecraft:/, '');

// ------------------------------------------------------------------ numbers

export function integer(min = -2147483648, max = 2147483647): Arg<number> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      if (!/^-?\d+$/.test(t)) throw r.error(t ? `Invalid integer '${t}'` : 'Expected integer', at);
      const v = Number(t);
      if (v < min) throw r.error(`Integer must not be less than ${min}, found ${v}`, at);
      if (v > max) throw r.error(`Integer must not be more than ${max}, found ${v}`, at);
      return v;
    },
  };
}

export function double(min = -Infinity, max = Infinity, label = 'Double'): Arg<number> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) throw r.error(t ? `Invalid ${label.toLowerCase()} '${t}'` : `Expected ${label.toLowerCase()}`, at);
      const v = Number(t);
      if (v < min) throw r.error(`${label} must not be less than ${min}, found ${v}`, at);
      if (v > max) throw r.error(`${label} must not be more than ${max}, found ${v}`, at);
      return v;
    },
  };
}

export function bool(): Arg<boolean> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      if (t === 'true') return true;
      if (t === 'false') return false;
      throw r.error(`Invalid boolean, expected 'true' or 'false' but found '${t}'`, at);
    },
    suggest: () => ['true', 'false'],
  };
}

/** One of a fixed set of words (suggested as you type). */
export function oneOf<T extends string>(options: readonly T[], what = 'value'): Arg<T> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken().toLowerCase();
      if ((options as readonly string[]).includes(t)) return t as T;
      throw r.error(`Unknown ${what} '${t}'`, at);
    },
    suggest: () => [...options],
  };
}

/** The rest of the line. */
export function greedy(): Arg<string> {
  return {
    greedy: true,
    parse(r) {
      const t = r.rest;
      r.i = r.s.length;
      return t;
    },
  };
}

/**
 * TimeArgument: a number with an optional unit — d (days, 24000 ticks), s (seconds, 20) or
 * t (ticks, the default). "10s", "0.5d", "100".
 */
export function time(min = 0): Arg<number> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken().toLowerCase();
      const m = /^(\d+\.?\d*|\.\d+)([dst]?)$/.exec(t);
      if (!m) throw r.error(t ? `Invalid time '${t}'` : 'Expected time', at);
      const mult = m[2] === 'd' ? 24000 : m[2] === 's' ? 20 : 1;
      const ticks = Math.round(Number(m[1]) * mult);
      if (ticks < min) throw r.error(`Tick count must not be less than ${min}, found ${ticks}`, at);
      return ticks;
    },
    suggest: () => ['1s', '10s', '1d', '100t'],
  };
}

/** "1..6", "5", "..10" (for /random). */
export function intRange(): Arg<[number, number]> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const m = /^(-?\d+)?(\.\.)?(-?\d+)?$/.exec(t);
      if (!m || (!m[1] && !m[3])) throw r.error(`Invalid range '${t}'`, at);
      const lo = m[1] !== undefined ? Number(m[1]) : -2147483648;
      const hi = m[3] !== undefined ? Number(m[3]) : m[2] ? 2147483647 : lo;
      if (hi < lo) throw r.error('Min cannot be bigger than max', at);
      return [lo, hi];
    },
  };
}

// ------------------------------------------------------------------ entities

/** Every fighter in the duel (you first). */
function fighters(ctx: CmdCtx): Fighter[] {
  const m = ctx.host.match;
  return m ? [m.player, m.bot] : [];
}

/** Names a fighter can be targeted by: its name with the spaces removed or as underscores, or just "bot". */
function nameMatches(f: Fighter, t: string, ctx: CmdCtx): boolean {
  const n = t.toLowerCase();
  if (f.id === 'bot') {
    const name = f.name.toLowerCase();
    return n === 'bot' || n === name.replace(/\s+/g, '') || n === name.replace(/\s+/g, '_');
  }
  return n === ctx.host.playerName.toLowerCase().replace(/\s+/g, '_') || n === 'you' || n === 'player';
}

/**
 * EntityArgument: @s / @p (you), @a / @e (both of you), @r (one at random), or a name — "bot",
 * or the bot's name without spaces (HT3Bot). Selector options in [ ] aren't supported.
 */
export function entities(single = false): Arg<Fighter[]> {
  return {
    parse(r, ctx) {
      const at = r.i;
      const t = r.readToken();
      if (!t) throw r.error('Expected an entity', at);
      if (t.includes('[')) throw r.error('Selector options [ … ] are not supported here', at + t.indexOf('['));
      const all = fighters(ctx);
      let out: Fighter[];
      switch (t) {
        case '@s':
        case '@p':
          out = ctx.self ? [ctx.self] : all.slice(0, 1);
          break;
        case '@a':
        case '@e':
          out = all;
          if (single && out.length > 1) throw r.error('Only one entity is allowed, but the provided selector allows more than one', at);
          break;
        case '@r':
          out = all.length ? [all[Math.floor(Math.random() * all.length)]] : [];
          break;
        default:
          if (t.startsWith('@')) throw r.error(`Unknown selector type '${t}'`, at);
          out = all.filter((f) => nameMatches(f, t, ctx));
      }
      if (!out.length) throw r.error(t.startsWith('@') ? 'No entity was found' : 'No player was found', at);
      return out;
    },
    suggest(ctx) {
      const bot = ctx.host.match?.bot;
      return ['@s', '@p', '@a', '@e', '@r', 'bot', ...(bot ? [bot.name.replace(/\s+/g, '')] : [])];
    },
  };
}

// ------------------------------------------------------------------ registries

export function attribute(): Arg<AttributeId> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const id = parseAttributeId(t);
      if (!id) throw r.error(`Can't find element '${t}' of type 'minecraft:attribute'`, at);
      return id;
    },
    suggest: () => ATTRIBUTE_IDS.map((id) => `minecraft:${id}`),
  };
}

export const EFFECT_IDS = Object.keys(EFFECT_NAMES) as EffectId[];

export function effect(): Arg<EffectId> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const id = ns(t);
      if (!(id in EFFECT_NAMES)) throw r.error(`Can't find element '${t}' of type 'minecraft:mob_effect'`, at);
      return id as EffectId;
    },
    suggest: () => EFFECT_IDS.map((id) => `minecraft:${id}`),
  };
}

export function gameMode(): Arg<GameMode> {
  return oneOf(GAME_MODES, 'game mode');
}

export function tier(): Arg<DifficultyId> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken().toLowerCase();
      if (t in DIFFICULTIES) return t as DifficultyId;
      throw r.error(`Unknown bot tier '${t}' (LT5 … HT1, or practice)`, at);
    },
    suggest: () => [...DIFFICULTY_ORDER],
  };
}

export function kit(): Arg<KitId> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken().toLowerCase();
      const k = KITS.find((k) => k.id === t && k.available);
      if (!k) throw r.error(`Unknown kit '${t}'`, at);
      return k.id as KitId;
    },
    suggest: () => KITS.filter((k) => k.available).map((k) => k.id),
  };
}

/** Vanilla enchantment ids → our Enchants keys. */
export const ENCHANTMENTS: Record<string, { key: keyof Enchants; max: number }> = {
  sharpness: { key: 'sharpness', max: 5 },
  protection: { key: 'protection', max: 4 },
  unbreaking: { key: 'unbreaking', max: 3 },
  fire_aspect: { key: 'fireAspect', max: 2 },
  mending: { key: 'mending', max: 1 },
  efficiency: { key: 'efficiency', max: 5 },
  power: { key: 'power', max: 5 },
  piercing: { key: 'piercing', max: 4 },
  blast_protection: { key: 'blastProtection', max: 4 },
  feather_falling: { key: 'featherFalling', max: 4 },
  knockback: { key: 'knockback', max: 2 },
  multishot: { key: 'multishot', max: 1 },
  quick_charge: { key: 'quickCharge', max: 3 },
  silk_touch: { key: 'silkTouch', max: 1 },
  density: { key: 'density', max: 5 },
  breach: { key: 'breach', max: 4 },
  wind_burst: { key: 'windBurst', max: 3 },
  sweeping_edge: { key: 'sweepingEdge', max: 3 },
  swift_sneak: { key: 'swiftSneak', max: 3 },
};

export function enchantment(): Arg<string> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const id = ns(t);
      if (!(id in ENCHANTMENTS)) throw r.error(`Can't find element '${t}' of type 'minecraft:enchantment'`, at);
      return id;
    },
    suggest: () => Object.keys(ENCHANTMENTS).map((id) => `minecraft:${id}`),
  };
}

/** Which enchantments an item can carry (EnchantmentHelper.canEnchant, simplified). */
export function canEnchant(id: ItemId, ench: string): boolean {
  const def = ITEMS[id];
  const durable = !!def.maxDamage;
  if (ench === 'unbreaking' || ench === 'mending') return durable;
  if (def.armor) {
    if (ench === 'protection' || ench === 'blast_protection') return !def.armor.glider;
    if (ench === 'feather_falling') return def.armor.slot === 3;
    if (ench === 'swift_sneak') return def.armor.slot === 2;
    return false;
  }
  switch (ench) {
    case 'sharpness':
      return def.tool === 'sword' || def.tool === 'axe';
    case 'knockback':
    case 'fire_aspect':
    case 'sweeping_edge':
      return def.tool === 'sword' || (ench === 'fire_aspect' && id === 'mace');
    case 'efficiency':
      return def.tool === 'pickaxe' || def.tool === 'axe';
    case 'silk_touch':
      return def.tool === 'pickaxe' || def.tool === 'axe';
    case 'power':
      return id === 'bow';
    case 'piercing':
    case 'multishot':
    case 'quick_charge':
      return id === 'crossbow';
    case 'density':
    case 'breach':
    case 'wind_burst':
      return id === 'mace';
    default:
      return false;
  }
}

/** Vanilla potion ids → the kit potions (which have fixed strengths and lengths). */
export const POTION_IDS: Record<string, PotionId> = {
  healing: 'healing',
  strong_healing: 'healing',
  strength: 'strength',
  strong_strength: 'strength',
  long_strength: 'strength',
  swiftness: 'swiftness',
  strong_swiftness: 'swiftness',
  long_swiftness: 'swiftness',
  fire_resistance: 'fire_resistance',
  long_fire_resistance: 'fire_resistance',
  regeneration: 'regeneration',
  strong_regeneration: 'regeneration',
  long_regeneration: 'regeneration',
  slow_falling: 'slow_falling',
  long_slow_falling: 'slow_falling',
};

// A tiny SNBT reader for item components: {a:1,b:{c:"x"}}, "str", 'str', 5b, true.
type Snbt = string | number | boolean | { [k: string]: Snbt };
function readSnbt(src: string, pos: { i: number }): Snbt {
  const skip = () => {
    while (src[pos.i] === ' ') pos.i++;
  };
  skip();
  const c = src[pos.i];
  if (c === '{') {
    pos.i++;
    const out: Record<string, Snbt> = {};
    skip();
    if (src[pos.i] === '}') {
      pos.i++;
      return out;
    }
    for (;;) {
      skip();
      const key = readSnbtWord(src, pos, true);
      skip();
      if (src[pos.i] !== ':' && src[pos.i] !== '=') throw new Error(`Expected ':' after '${key}'`);
      pos.i++;
      out[key] = readSnbt(src, pos);
      skip();
      if (src[pos.i] === ',') {
        pos.i++;
        continue;
      }
      if (src[pos.i] === '}') {
        pos.i++;
        return out;
      }
      throw new Error("Expected ',' or '}'");
    }
  }
  const w = readSnbtWord(src, pos);
  if (/^-?\d+(\.\d+)?[bslfdBSLFD]?$/.test(w)) return Number(w.replace(/[bslfdBSLFD]$/, ''));
  if (w === 'true' || w === 'false') return w === 'true';
  return w;
}
/** An unquoted word; keys stop at ':' (quote namespaced keys: {"minecraft:sharpness":5}). */
function readSnbtWord(src: string, pos: { i: number }, key = false): string {
  const q = src[pos.i];
  if (q === '"' || q === "'") {
    let out = '';
    pos.i++;
    while (pos.i < src.length && src[pos.i] !== q) {
      if (src[pos.i] === '\\') pos.i++;
      out += src[pos.i++];
    }
    pos.i++;
    return out;
  }
  const start = pos.i;
  const allowed = key ? /[A-Za-z0-9_.+\-]/ : /[A-Za-z0-9_.:+\-]/;
  while (pos.i < src.length && allowed.test(src[pos.i])) pos.i++;
  if (pos.i === start) throw new Error(`Unexpected '${src[pos.i] ?? 'end'}'`);
  return src.slice(start, pos.i);
}

/**
 * ItemArgument with the 1.20.5+ component syntax: `minecraft:diamond_sword[enchantments={sharpness:5}]`,
 * `splash_potion[potion_contents={potion:"minecraft:strong_healing"}]` (or `potion_contents=strong_healing`),
 * `diamond_chestplate[damage=100]`. Older `{levels:{…}}` enchantment lists are accepted too.
 */
export function item(): Arg<ItemStack> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const br = t.indexOf('[');
      const idPart = ns(br >= 0 ? t.slice(0, br) : t);
      if (!(idPart in ITEMS)) throw r.error(`Unknown item '${t.slice(0, br >= 0 ? br : undefined)}'`, at);
      const stack: ItemStack = { id: idPart as ItemId, count: 1 };
      if (br >= 0) {
        if (!t.endsWith(']')) throw r.error('Expected closing ] for item components', at + t.length);
        const body = t.slice(br + 1, -1);
        const pos = { i: 0 };
        try {
          while (pos.i < body.length) {
            const key = ns(readSnbtWord(body, pos));
            if (body[pos.i] !== '=') throw new Error(`Expected '=' after component '${key}'`);
            pos.i++;
            const value = readSnbt(body, pos);
            applyComponent(stack, key, value);
            if (body[pos.i] === ',') pos.i++;
            else if (pos.i < body.length) throw new Error("Expected ',' between components");
          }
        } catch (e) {
          throw r.error(`Malformed item: ${(e as Error).message}`, at + br + 1 + pos.i);
        }
      }
      if ((stack.id === 'splash_potion' || stack.id === 'tipped_arrow') && !stack.potion) {
        stack.potion = stack.id === 'tipped_arrow' ? 'slow_falling' : 'healing';
      }
      return stack;
    },
    suggest: () => Object.keys(ITEMS).map((id) => `minecraft:${id}`),
  };
}

function applyComponent(stack: ItemStack, key: string, value: Snbt) {
  if (key === 'enchantments') {
    if (typeof value !== 'object') throw new Error('enchantments must be {id:level,…}');
    const levels = (typeof value.levels === 'object' ? value.levels : value) as Record<string, Snbt>;
    const ench: Enchants = { ...stack.ench };
    for (const [k, v] of Object.entries(levels)) {
      if (k === 'show_in_tooltip') continue;
      const e = ENCHANTMENTS[ns(k)];
      if (!e) throw new Error(`unknown enchantment '${k}'`);
      const lvl = Math.max(1, Math.min(255, Math.floor(Number(v))));
      (ench as Record<string, number>)[e.key] = lvl;
    }
    stack.ench = ench;
  } else if (key === 'potion_contents') {
    const id = ns(String(typeof value === 'object' ? (value.potion ?? '') : value));
    const p = POTION_IDS[id];
    if (!p) throw new Error(`unknown potion '${id}' (try strong_healing, strong_strength, strong_swiftness, long_fire_resistance, long_regeneration, long_slow_falling)`);
    stack.potion = p;
  } else if (key === 'damage') {
    const max = ITEMS[stack.id].maxDamage;
    if (!max) throw new Error(`${stack.id} has no durability`);
    stack.damage = Math.max(0, Math.min(max - 1, Math.floor(Number(value))));
  } else if (key === 'charged_projectiles') {
    if (stack.id !== 'crossbow') throw new Error('only crossbows hold projectiles');
    stack.charged = true;
  } else {
    throw new Error(`component '${key}' isn't supported (enchantments, potion_contents, damage)`);
  }
}

/** The kit potions as vanilla ids, for suggestions. */
export const POTION_SUGGESTIONS = Object.keys(POTIONS);

// ------------------------------------------------------------------ blocks and positions

export const BLOCK_IDS: Record<string, number> = { air: B.AIR };
for (const [k, v] of Object.entries(BLOCK_NAMES)) BLOCK_IDS[v] = Number(k);

export function block(): Arg<number> {
  return {
    parse(r) {
      const at = r.i;
      const t = r.readToken();
      const id = ns(t.replace(/\[.*$/, ''));
      if (!(id in BLOCK_IDS)) throw r.error(`Unknown block type '${t}'`, at);
      return BLOCK_IDS[id];
    },
    suggest: () => Object.keys(BLOCK_IDS).map((id) => `minecraft:${id}`),
  };
}

interface Coord {
  kind: 'abs' | 'rel' | 'local';
  v: number;
  /** Written without a decimal point (vanilla centres those on the block for x/z). */
  whole: boolean;
}

function readCoord(r: Reader, allowLocal: boolean): Coord {
  const at = r.i;
  const t = r.readToken();
  if (!t) throw r.error('Expected a coordinate', at);
  const c = t[0];
  if (c === '~' || c === '^') {
    if (c === '^' && !allowLocal) throw r.error('Local coordinates (^) are not allowed here', at);
    const rest = t.slice(1);
    if (rest && !/^-?(\d+\.?\d*|\.\d+)$/.test(rest)) throw r.error(`Invalid double '${rest}'`, at + 1);
    return { kind: c === '~' ? 'rel' : 'local', v: rest ? Number(rest) : 0, whole: false };
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) throw r.error(`Invalid double '${t}'`, at);
  return { kind: 'abs', v: Number(t), whole: !t.includes('.') };
}

function readCoords(r: Reader, n: number, allowLocal: boolean): Coord[] {
  const out: Coord[] = [];
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      if (r.peek() !== ' ') throw r.error('Incomplete (expected 3 coordinates)');
      r.i++;
    }
    out.push(readCoord(r, allowLocal));
  }
  const locals = out.filter((c) => c.kind === 'local').length;
  if (locals && locals !== out.length) throw r.error('Cannot mix world & local coordinates (everything must either use ^ or not)');
  return out;
}

/** Resolves ~ and ^ against the executor (feet position, look direction). */
function resolve(coords: Coord[], self: Fighter | null, center: boolean): V3 {
  const px = self?.pos.x ?? 0;
  const py = self?.pos.y ?? 0;
  const pz = self?.pos.z ?? 0;
  if (coords[0].kind === 'local') {
    const yaw = self?.yaw ?? 0;
    const pitch = self?.pitch ?? 0;
    const f = lookDir(yaw, pitch, new V3());
    const u = lookDir(yaw, pitch + Math.PI / 2, new V3());
    // left = up × forward
    const lx = u.y * f.z - u.z * f.y;
    const ly = u.z * f.x - u.x * f.z;
    const lz = u.x * f.y - u.y * f.x;
    const [l, up, fw] = coords.map((c) => c.v);
    return new V3(px + lx * l + u.x * up + f.x * fw, py + ly * l + u.y * up + f.y * fw, pz + lz * l + u.z * up + f.z * fw);
  }
  const base = [px, py, pz];
  const v = coords.map((c, k) => {
    if (c.kind === 'rel') return base[k] + c.v;
    return center && c.whole && k !== 1 ? c.v + 0.5 : c.v;
  });
  return new V3(v[0], v[1], v[2]);
}

/** Vec3Argument: three coordinates for an entity position (x/z integers are centred). */
export function vec3(): Arg<(self: Fighter | null) => V3> {
  return {
    parse(r) {
      const coords = readCoords(r, 3, true);
      return (self) => resolve(coords, self, true);
    },
    suggest: () => ['~ ~ ~', '^ ^ ^'],
  };
}

/** BlockPosArgument: three coordinates floored to a block. */
export function blockPos(): Arg<(self: Fighter | null) => [number, number, number]> {
  return {
    parse(r) {
      const coords = readCoords(r, 3, true);
      return (self) => {
        const v = resolve(coords, self, false);
        return [Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)];
      };
    },
    suggest: () => ['~ ~ ~', '^ ^ ^'],
  };
}

/** RotationArgument: yaw pitch in Minecraft degrees (~ keeps the current one). */
export function rotation(): Arg<(self: Fighter | null) => [number, number]> {
  return {
    parse(r) {
      const coords = readCoords(r, 2, false);
      return (self) => {
        // Minecraft yaw 0 = +Z (south); ours: 0 = -Z. mcYaw = 180 - ours (in degrees).
        const mcYaw = self ? 180 - (self.yaw * 180) / Math.PI : 0;
        const mcPitch = self ? (-self.pitch * 180) / Math.PI : 0;
        const y = coords[0].kind === 'rel' ? mcYaw + coords[0].v : coords[0].v;
        const p = coords[1].kind === 'rel' ? mcPitch + coords[1].v : coords[1].v;
        return [y, p];
      };
    },
    suggest: () => ['~ ~'],
  };
}
