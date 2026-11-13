import * as C from '../core/constants';
import { B, BLOCK_NAMES } from '../game/Blocks';
import { hurt, rayDistanceToTarget } from '../game/combat';
import { EndCrystal } from '../game/EndCrystal';
import { INV_SIZE, SLOT_ARMOR, SLOT_OFFHAND, type Fighter } from '../game/Fighter';
import { EFFECT_NAMES, ITEMS, cloneStack, stackName, type ItemStack } from '../game/items';
import { TntCart } from '../game/TntCart';
import { XpOrb } from '../game/XpOrb';
import { BUILD_HEIGHT } from '../game/World';
import { blockPos, entities, greedy, integer, item, oneOf, vec3 } from './args';
import { arg, CommandError, Reader, lit, type Args, type Dispatcher } from './dispatcher';
import { COLOR, type ChatLine, type ChatPart, type CmdCtx } from './host';
import type { V3 } from '../core/math';

/**
 * More commands: the vanilla ones that make sense in a duel (/summon, /data, /item, /clone,
 * /tellraw, /execute, /seed) and practice tools (/stats, /feed, /repair, /distance, /pos,
 * /clearchat). Anything that changes the duel works offline only and marks it as not counting.
 */

type Ctx = CmdCtx;
type Pos = (self: Fighter | null) => V3;
type BlockPosFn = (self: Fighter | null) => [number, number, number];

const fmt = (v: number, places = 2) => (Number.isInteger(v) ? String(v) : v.toFixed(places));
const offline = (ctx: Ctx) => !ctx.host.online;
const nameOf = (ctx: Ctx, f: Fighter) => (f.id === 'player' ? ctx.host.playerName : f.name);
const who = (ctx: Ctx, list: Fighter[]) => (list.length === 1 ? nameOf(ctx, list[0]) : `${list.length} targets`);

function say(ctx: Ctx, text: string, color?: string) {
  if (!ctx.host.session.rules.sendCommandFeedback) return;
  ctx.host.print([{ t: text, c: color }]);
}
function needMatch(ctx: Ctx) {
  if (!ctx.host.match) throw new CommandError('Start a duel first — commands change the duel you are playing.');
  return ctx.host.match;
}
function needSelf(ctx: Ctx): Fighter {
  needMatch(ctx);
  if (!ctx.self) throw new CommandError('Only a player can run this');
  return ctx.self;
}
/** The first enemy of `f` that is alive (the bot in a duel). */
function opponentOf(ctx: Ctx, f: Fighter): Fighter | null {
  const m = needMatch(ctx);
  const all = m.world.fighters.length ? m.world.fighters : [m.player, m.bot];
  let best: Fighter | null = null;
  let bestD = Infinity;
  for (const o of all) {
    if (!o.isEnemy(f) || o.dead) continue;
    const d = Math.hypot(o.pos.x - f.pos.x, o.pos.y - f.pos.y, o.pos.z - f.pos.z);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** Minecraft's yaw/pitch in degrees for a fighter (south = 0, looking down = +90). */
export function mcRotation(f: Fighter): [number, number] {
  let yaw = 180 - (f.yaw * 180) / Math.PI;
  yaw = ((((yaw + 180) % 360) + 360) % 360) - 180;
  return [yaw, (-f.pitch * 180) / Math.PI];
}

/** Which way a yaw (Minecraft degrees) faces, as F3 names it. */
function facing(yaw: number): string {
  const dirs = ['south (Towards positive Z)', 'west (Towards negative X)', 'north (Towards negative Z)', 'east (Towards positive X)'];
  return dirs[(((Math.round(yaw / 90) % 4) + 4) % 4)];
}

// ------------------------------------------------------------------ /item slots

/** Vanilla slot names → our inventory index. */
export function slotIndex(name: string): number | null {
  const n = name.toLowerCase();
  if (n === 'weapon' || n === 'weapon.mainhand') return -1; // the selected hotbar slot
  if (n === 'weapon.offhand') return SLOT_OFFHAND;
  const armor = ['armor.head', 'armor.chest', 'armor.legs', 'armor.feet'].indexOf(n);
  if (armor >= 0) return SLOT_ARMOR + armor;
  let m = /^hotbar\.(\d)$/.exec(n);
  if (m) return Number(m[1]);
  m = /^inventory\.(\d{1,2})$/.exec(n);
  if (m && Number(m[1]) < INV_SIZE - 9) return 9 + Number(m[1]);
  return null;
}
const SLOT_NAMES = ['weapon.mainhand', 'weapon.offhand', 'armor.head', 'armor.chest', 'armor.legs', 'armor.feet', ...Array.from({ length: 9 }, (_, i) => `hotbar.${i}`), ...Array.from({ length: 27 }, (_, i) => `inventory.${i}`)];

const slotArg = {
  parse(r: Reader) {
    const at = r.i;
    const t = r.readToken();
    const i = slotIndex(t);
    if (i === null) throw r.error(`Unknown slot '${t}'`, at);
    return t;
  },
  suggest: () => SLOT_NAMES,
};

// ------------------------------------------------------------------ /tellraw

const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  dark_blue: '#0000aa',
  dark_green: '#00aa00',
  dark_aqua: '#00aaaa',
  dark_red: '#aa0000',
  dark_purple: '#aa00aa',
  gold: '#ffaa00',
  gray: '#aaaaaa',
  dark_gray: '#555555',
  blue: '#5555ff',
  green: '#55ff55',
  aqua: '#55ffff',
  red: '#ff5555',
  light_purple: '#ff55ff',
  yellow: '#ffff55',
  white: '#ffffff',
};

interface TextStyle {
  c?: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
}

/**
 * A JSON text component (what /tellraw takes) → chat parts: a string, an array, or
 * {"text", "color", "bold", "italic", "underlined", "extra": [...]}; children inherit the style.
 */
export function textComponent(json: unknown, inherit: TextStyle = {}, out: ChatPart[] = []): ChatPart[] {
  if (typeof json === 'string' || typeof json === 'number' || typeof json === 'boolean') {
    out.push({ t: String(json), ...inherit });
  } else if (Array.isArray(json)) {
    // Vanilla: the first element's style carries over to the rest.
    let style = inherit;
    json.forEach((part, k) => {
      textComponent(part, style, out);
      if (k === 0 && part && typeof part === 'object' && !Array.isArray(part)) style = styleOf(part as Record<string, unknown>, inherit);
    });
  } else if (json && typeof json === 'object') {
    const o = json as Record<string, unknown>;
    const style = styleOf(o, inherit);
    const text = o.text ?? o.translate ?? '';
    if (text !== '') out.push({ t: String(text), ...style });
    if (Array.isArray(o.extra)) for (const e of o.extra) textComponent(e, style, out);
  }
  return out;
}
function styleOf(o: Record<string, unknown>, inherit: TextStyle): TextStyle {
  const s: TextStyle = { ...inherit };
  if (typeof o.color === 'string') {
    const c = o.color.toLowerCase();
    if (NAMED_COLORS[c]) s.c = NAMED_COLORS[c];
    else if (/^#[0-9a-f]{6}$/.test(c)) s.c = c;
  }
  if (typeof o.bold === 'boolean') s.b = o.bold;
  if (typeof o.italic === 'boolean') s.i = o.italic;
  if (typeof o.underlined === 'boolean') s.u = o.underlined;
  return s;
}

// ------------------------------------------------------------------ /data

/** What /data get entity shows, by vanilla's NBT names. */
function entityData(f: Fighter): Record<string, () => string> {
  const [yaw, pitch] = mcRotation(f);
  const d = (v: number) => `${fmt(v, 3)}d`;
  const fl = (v: number) => `${fmt(v, 3)}f`;
  const stack = (s: ItemStack | null) => (s ? `{id: "minecraft:${s.id}", count: ${s.count}${s.damage ? `, damage: ${s.damage}` : ''}}` : '{}');
  return {
    Health: () => fl(f.health),
    AbsorptionAmount: () => fl(f.absorption),
    Pos: () => `[${d(f.pos.x)}, ${d(f.pos.y)}, ${d(f.pos.z)}]`,
    Motion: () => `[${d(f.vel.x)}, ${d(f.vel.y)}, ${d(f.vel.z)}]`,
    Rotation: () => `[${fl(yaw)}, ${fl(pitch)}]`,
    OnGround: () => `${f.onGround ? 1 : 0}b`,
    FallDistance: () => fl(f.fallDistance),
    HurtTime: () => `${f.hurtTime}s`,
    Fire: () => `${f.fireTicks}s`,
    foodLevel: () => String(f.food.level),
    foodSaturationLevel: () => fl(f.food.saturation),
    foodExhaustionLevel: () => fl(f.food.exhaustion),
    SelectedItemSlot: () => String(f.selected),
    SelectedItem: () => stack(f.heldStack()),
    active_effects: () =>
      `[${[...f.effects]
        .map(([id, e]) => `{id: "minecraft:${id}", amplifier: ${e.amplifier}b, duration: ${e.duration}}`)
        .join(', ')}]`,
  };
}

// ------------------------------------------------------------------ registration

export function registerExtras(d: Dispatcher<Ctx>) {
  // ---------------------------------------------------------------- /summon
  const SUMMONABLE = ['end_crystal', 'tnt', 'tnt_minecart', 'experience_orb', 'lightning_bolt'] as const;
  type Summon = (typeof SUMMONABLE)[number];
  const summon = (ctx: Ctx, a: Args) => {
    const m = needMatch(ctx);
    const w = m.world;
    const p = a.pos ? (a.pos as Pos)(ctx.self) : ctx.self ? ctx.self.pos.clone() : null;
    if (!p) throw new CommandError('Give a position');
    const owner = ctx.self;
    switch (a.entity as Summon) {
      case 'end_crystal':
        w.crystals.push(new EndCrystal(p.x, p.y, p.z, owner));
        w.emit({ type: 'crystalPlace', x: p.x, y: p.y, z: p.z });
        break;
      case 'tnt': {
        const t = new TntCart(p.x, p.y, p.z, owner);
        t.bare = true;
        t.fuse = 80; // vanilla's primed TNT fuse
        w.carts.push(t);
        w.emit({ type: 'cartPrimed', x: p.x, y: p.y, z: p.z });
        break;
      }
      case 'tnt_minecart':
        w.carts.push(new TntCart(p.x, p.y, p.z, owner));
        w.emit({ type: 'cartPlace', x: p.x, y: p.y, z: p.z });
        break;
      case 'experience_orb':
        w.orbs.push(new XpOrb(p.x, p.y, p.z, 1, w.rng));
        break;
      case 'lightning_bolt':
        lightning(ctx, p);
        break;
    }
    ctx.host.markCheated();
    say(ctx, `Summoned new ${(a.entity as string).replace(/_/g, ' ')}`);
  };
  /** LightningBolt: 5 damage and 8 seconds of fire to anyone within 3 blocks (6 up). */
  const lightning = (ctx: Ctx, p: V3) => {
    const w = needMatch(ctx).world;
    w.emit({ type: 'lightning', x: p.x, y: p.y, z: p.z });
    for (const f of w.fighters) {
      if (f.dead || Math.abs(f.pos.x - p.x) > 3 || Math.abs(f.pos.z - p.z) > 3 || f.pos.y + f.height() < p.y - 3 || f.pos.y > p.y + 6) continue;
      f.ignite(160);
      hurt(f, 5, null, false, true);
    }
  };
  const entityType = oneOf<Summon>(SUMMONABLE, 'entity');
  d.register(
    lit<Ctx>('summon', arg<Ctx, Summon>('entity', entityType, arg<Ctx, Pos>('pos', vec3()).runs(summon)).runs(summon)).requires(offline),
    'summon <end_crystal|tnt|tnt_minecart|experience_orb|lightning_bolt> [pos]',
  );

  // ---------------------------------------------------------------- /data get entity
  const dataGet = (ctx: Ctx, a: Args) => {
    needMatch(ctx);
    const f = (a.target as Fighter[])[0];
    const data = entityData(f);
    const path = a.path as string | undefined;
    if (path) {
      const key = Object.keys(data).find((k) => k.toLowerCase() === path.toLowerCase());
      if (!key) throw new CommandError(`Found no elements matching ${path}`);
      say(ctx, `${nameOf(ctx, f)} has the following entity data: ${data[key]()}`);
      return;
    }
    say(ctx, `${nameOf(ctx, f)} has the following entity data:`);
    for (const [k, v] of Object.entries(data)) ctx.host.print([{ t: `  ${k}: `, c: COLOR.aqua }, { t: v() }]);
  };
  const pathArg = {
    parse(r: Reader) {
      return r.readToken();
    },
    suggest: () => Object.keys(entityData(DUMMY_KEYS)),
  };
  d.register(
    lit<Ctx>('data', lit<Ctx>('get', lit<Ctx>('entity', arg<Ctx, Fighter[]>('target', entities(true), arg<Ctx, string>('path', pathArg).runs(dataGet)).runs(dataGet)))).requires(offline),
    'data get entity <target> [path] — Health, Pos, Motion, Rotation, FallDistance, foodLevel, …',
  );

  // ---------------------------------------------------------------- /item replace
  const itemReplace = (ctx: Ctx, a: Args, count: number) => {
    needMatch(ctx);
    const list = a.targets as Fighter[];
    const proto = a.item as ItemStack;
    const max = ITEMS[proto.id].maxStack ?? 64;
    if (count > max) throw new CommandError(`Can't put ${count} of ${stackName(proto)} in one slot (max ${max})`);
    for (const f of list) {
      let i = slotIndex(a.slot as string)!;
      if (i === -1) i = f.selected;
      if (i >= SLOT_ARMOR && i < SLOT_OFFHAND && ITEMS[proto.id].armor?.slot !== i - SLOT_ARMOR) {
        throw new CommandError(`${stackName(proto)} can't be worn in ${a.slot as string}`);
      }
      f.setSlot(i, { ...cloneStack(proto)!, count });
    }
    ctx.host.markCheated();
    say(ctx, `Replaced a slot on ${who(ctx, list)} with ${stackName(proto)}`);
  };
  d.register(
    lit<Ctx>(
      'item',
      lit<Ctx>(
        'replace',
        lit<Ctx>(
          'entity',
          arg<Ctx, Fighter[]>(
            'targets',
            entities(),
            arg<Ctx, string>(
              'slot',
              slotArg,
              lit<Ctx>(
                'with',
                arg<Ctx, ItemStack>('item', item(), arg<Ctx, number>('count', integer(1, 64)).runs((ctx, a) => itemReplace(ctx, a, a.count as number))).runs((ctx, a) =>
                  itemReplace(ctx, a, 1),
                ),
              ),
            ),
          ),
        ),
      ),
    ).requires(offline),
    'item replace entity <targets> <slot> with <item> [count] — slots: weapon.mainhand, weapon.offhand, armor.head…feet, hotbar.0–8, inventory.0–26',
  );

  // ---------------------------------------------------------------- /clone
  const cloneRun = (ctx: Ctx, a: Args, mode: 'replace' | 'masked' | 'move') => {
    const m = needMatch(ctx);
    const b = m.world.blocks;
    const [x0, y0, z0] = (a.from as BlockPosFn)(ctx.self);
    const [x1, y1, z1] = (a.to as BlockPosFn)(ctx.self);
    const [dx, dy, dz] = (a.dest as BlockPosFn)(ctx.self);
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
    const volume = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
    if (volume > 32768) throw new CommandError(`Too many blocks in the specified area (maximum 32768, specified ${volume})`);
    const ox = dx - ax;
    const oy = dy - ay;
    const oz = dz - az;
    // Copy first, so an overlapping destination doesn't read blocks it has already written.
    const copy: [number, number, number, number][] = [];
    for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) copy.push([x, y, z, b.inside(x, y, z) ? b.get(x, y, z) : B.AIR]);
    const fits = (x: number, y: number, z: number) => b.inside(x, y, z) && y < BUILD_HEIGHT;
    if (mode === 'move') for (const [x, y, z] of copy) if (fits(x, y, z) && b.get(x, y, z) !== B.AIR) b.set(x, y, z, B.AIR);
    let n = 0;
    for (const [x, y, z, id] of copy) {
      const tx = x + ox;
      const ty = y + oy;
      const tz = z + oz;
      if (!fits(tx, ty, tz)) continue;
      if (mode === 'masked' && id === B.AIR) continue;
      if (b.get(tx, ty, tz) === id) continue;
      if (id === B.WATER || id === B.LAVA) b.placeSource(tx, ty, tz, id);
      else b.set(tx, ty, tz, id);
      n++;
    }
    if (!n) throw new CommandError('No blocks were cloned');
    ctx.host.markCheated();
    say(ctx, `Successfully cloned ${n} block(s)`);
  };
  const cloneModes = arg<Ctx, unknown>('dest', blockPos()).runs((ctx, a) => cloneRun(ctx, a, 'replace'));
  for (const mode of ['replace', 'masked'] as const) {
    cloneModes.then(
      lit<Ctx>(mode, lit<Ctx>('force').runs((ctx, a) => cloneRun(ctx, a, mode)), lit<Ctx>('move').runs((ctx, a) => cloneRun(ctx, a, 'move')), lit<Ctx>('normal').runs((ctx, a) => cloneRun(ctx, a, mode))).runs(
        (ctx, a) => cloneRun(ctx, a, mode),
      ),
    );
  }
  d.register(
    lit<Ctx>('clone', arg<Ctx, unknown>('from', blockPos(), arg<Ctx, unknown>('to', blockPos(), cloneModes))).requires(offline),
    'clone <from> <to> <destination> [replace|masked] [normal|force|move]',
  );

  // ---------------------------------------------------------------- /tellraw
  d.register(
    lit<Ctx>(
      'tellraw',
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        arg<Ctx, string>('message', greedy()).runs((ctx, a) => {
          const raw = (a.message as string).trim();
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch {
            throw new CommandError(`Invalid chat component: ${raw.length > 40 ? `${raw.slice(0, 40)}…` : raw}`);
          }
          const line: ChatLine = textComponent(json);
          if (line.length) ctx.host.print(line);
        }),
      ),
    ),
    'tellraw <targets> <json> — e.g. /tellraw @a {"text":"GG","color":"gold","bold":true}',
  );

  // ---------------------------------------------------------------- /execute
  /**
   * as/at <targets> (both make the target the one running the rest, so @s and ~ ~ ~ are them),
   * if/unless entity <targets>, then run <command>. Returns how many times the command ran.
   */
  const executeChain = (r: Reader, ctx: Ctx): number => {
    r.skipSpaces();
    const at = r.i;
    const word = r.readToken();
    r.skipSpaces();
    switch (word) {
      case 'run': {
        const rest = r.rest;
        if (!rest.trim()) throw r.error('Expected a command after run', r.i);
        d.execute(rest.trim().replace(/^\//, ''), ctx);
        return 1;
      }
      case 'as':
      case 'at': {
        const list = entities().parse(r, ctx);
        const from = r.i;
        let n = 0;
        for (const f of list) {
          r.i = from;
          n += executeChain(r, { ...ctx, self: f });
        }
        return n;
      }
      case 'if':
      case 'unless': {
        const kindAt = r.i;
        const kind = r.readToken();
        if (kind !== 'entity') throw r.error(`Only "${word} entity <targets>" is supported`, kindAt);
        r.skipSpaces();
        let found: boolean;
        try {
          found = entities().parse(r, ctx).length > 0;
        } catch (e) {
          if (!(e instanceof CommandError) || !/No (entity|player) was found/.test(e.message)) throw e;
          r.readToken();
          found = false;
        }
        if (found !== (word === 'if')) return 0;
        r.skipSpaces();
        if (r.atEnd()) {
          say(ctx, 'Test passed');
          return 1;
        }
        return executeChain(r, ctx);
      }
      default:
        throw r.error(word ? `Unknown execute subcommand '${word}' (as, at, if, unless, run)` : 'Expected as, at, if, unless or run', at);
    }
  };
  d.register(
    lit<Ctx>(
      'execute',
      arg<Ctx, string>('chain', {
        ...greedy(),
        suggest: () => ['as', 'at', 'if', 'unless', 'run'],
      }).runs((ctx, a) => {
        const r = new Reader(a.chain as string);
        const n = executeChain(r, ctx);
        if (!n) throw new CommandError('Test failed');
        return n;
      }),
    ),
    'execute (as|at <targets>) (if|unless entity <targets>) … run <command> — e.g. /execute as @a run effect give @s speed',
  );

  // ---------------------------------------------------------------- /seed
  d.register(
    lit<Ctx>('seed').runs((ctx) => {
      const m = needMatch(ctx);
      ctx.host.print([{ t: 'Seed: [' }, { t: String(m.seed), c: COLOR.green }, { t: ']' }]);
      return m.seed;
    }).requires(offline),
    "This duel's random seed (bot choices, knockback jitter)",
  );

  // ---------------------------------------------------------------- PvP Trainer tools
  const statsOf = (ctx: Ctx, f: Fighter) => {
    const s = f.stats;
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
    ctx.host.print([{ t: `${nameOf(ctx, f)} this duel:`, c: COLOR.gold }]);
    const rows: [string, string][] = [
      ['Hits', `${s.hits} of ${s.swings} swings (${pct(s.hits, s.swings)})`],
      ['Crits', `${s.crits} (${pct(s.crits, s.hits)} of hits)`],
      ['Sprint hits', `${s.sprintHits}`],
      ['Combo', `${s.combo} now, best ${s.maxCombo}`],
      ['Reach', s.hits ? `${fmt(s.reachSum / s.hits)} average, ${fmt(s.maxReach)} longest` : '—'],
      ['Damage', `${fmt(s.damageDealt, 1)} dealt, ${fmt(s.damageTaken, 1)} taken`],
      ['Blocked', `${s.blocked} with your shield, ${s.shieldsDisabled} shields disabled`],
    ];
    if (s.arrowsShot) rows.push(['Arrows', `${s.arrowHits} of ${s.arrowsShot} hit`]);
    if (s.gapplesEaten || s.potsThrown || s.totemsPopped) rows.push(['Used', `${s.gapplesEaten} gapples, ${s.potsThrown} pots, ${s.totemsPopped} totems`]);
    if (s.crystalsPlaced) rows.push(['Crystals', `${s.crystalsPlaced} placed, ${s.crystalsBroken} broken`]);
    if (s.smashes) rows.push(['Mace', `${s.smashes} smashes, biggest ${fmt(s.maxSmash, 1)}`]);
    for (const [k, v] of rows) ctx.host.print([{ t: `  ${k}: `, c: COLOR.gray }, { t: v }]);
  };
  d.register(
    lit<Ctx>('stats', arg<Ctx, Fighter[]>('target', entities(true)).runs((ctx, a) => statsOf(ctx, (a.target as Fighter[])[0]))).runs((ctx) => statsOf(ctx, needSelf(ctx))).requires(offline),
    'PvP Trainer: hits, crits, combos, reach and damage so far this duel',
  );

  const feed = (ctx: Ctx, list: Fighter[]) => {
    needMatch(ctx);
    for (const f of list) {
      f.food.level = C.MAX_FOOD;
      f.food.saturation = C.MAX_FOOD;
      f.food.exhaustion = 0;
    }
    ctx.host.markCheated();
    say(ctx, `Fed ${who(ctx, list)}`);
  };
  d.register(
    lit<Ctx>('feed', arg<Ctx, Fighter[]>('targets', entities()).runs((ctx, a) => feed(ctx, a.targets as Fighter[]))).runs((ctx) => feed(ctx, [needSelf(ctx)])).requires(offline),
    'PvP Trainer: fill hunger and saturation',
  );

  const repair = (ctx: Ctx, list: Fighter[]) => {
    needMatch(ctx);
    let n = 0;
    for (const f of list) {
      for (const s of [...f.inventory, ...f.armorSlots, f.offhand]) {
        if (s?.damage) {
          s.damage = 0;
          n++;
        }
      }
    }
    if (!n) throw new CommandError('Nothing to repair');
    ctx.host.markCheated();
    say(ctx, `Repaired ${n} item(s) of ${who(ctx, list)}`);
  };
  d.register(
    lit<Ctx>('repair', arg<Ctx, Fighter[]>('targets', entities()).runs((ctx, a) => repair(ctx, a.targets as Fighter[]))).runs((ctx) => repair(ctx, [needSelf(ctx)])).requires(offline),
    'PvP Trainer: full durability on all armor, weapons and shields',
  );

  d.register(
    lit<Ctx>('distance').runs((ctx) => {
      const f = needSelf(ctx);
      const o = opponentOf(ctx, f);
      if (!o) throw new CommandError('No opponent to measure to');
      const flat = Math.hypot(o.pos.x - f.pos.x, o.pos.z - f.pos.z);
      const ray = rayDistanceToTarget(f, o, 64);
      const reach = f.entityReach();
      ctx.host.print([{ t: `${nameOf(ctx, o)}: `, c: COLOR.gold }, { t: `${fmt(flat)} blocks apart (feet to feet)` }]);
      if (ray >= 0) {
        const ok = ray <= reach;
        ctx.host.print([{ t: `  Crosshair to their hitbox: ${fmt(ray)} blocks — ` }, { t: ok ? 'in reach' : `${fmt(ray - reach)} out of reach`, c: ok ? COLOR.green : COLOR.red }]);
      } else ctx.host.print([{ t: '  Your crosshair is not on them', c: COLOR.gray }]);
      return Math.round(flat * 100) / 100;
    }).requires(offline),
    'PvP Trainer: how far your opponent is, and whether your crosshair is in reach',
  );

  d.register(
    lit<Ctx>('pos').runs((ctx) => {
      const f = needSelf(ctx);
      const [yaw, pitch] = mcRotation(f);
      ctx.host.print([{ t: 'XYZ: ', c: COLOR.gray }, { t: `${f.pos.x.toFixed(3)} / ${f.pos.y.toFixed(5)} / ${f.pos.z.toFixed(3)}` }]);
      ctx.host.print([{ t: 'Block: ', c: COLOR.gray }, { t: `${Math.floor(f.pos.x)} ${Math.floor(f.pos.y)} ${Math.floor(f.pos.z)}` }]);
      ctx.host.print([{ t: 'Facing: ', c: COLOR.gray }, { t: `${facing(yaw)} (${yaw.toFixed(1)} / ${pitch.toFixed(1)})` }]);
      const below = f.world.blocks.inside(Math.floor(f.pos.x), Math.floor(f.pos.y - 0.01), Math.floor(f.pos.z)) ? f.world.blocks.get(Math.floor(f.pos.x), Math.floor(f.pos.y - 0.01), Math.floor(f.pos.z)) : B.AIR;
      ctx.host.print([{ t: 'Standing on: ', c: COLOR.gray }, { t: below === B.AIR ? (f.onGround ? 'the floor' : 'nothing (in the air)') : (BLOCK_NAMES[below] ?? 'a block') }]);
      if (f.effects.size) ctx.host.print([{ t: 'Effects: ', c: COLOR.gray }, { t: [...f.effects.keys()].map((id) => EFFECT_NAMES[id]).join(', ') }]);
    }).requires(offline),
    'PvP Trainer: your position and facing (like F3)',
  );

  d.register(
    lit<Ctx>('clearchat').runs((ctx) => {
      if (!ctx.host.clearChat) throw new CommandError('Chat can’t be cleared here');
      ctx.host.clearChat();
    }),
    'PvP Trainer: wipe the chat',
    ['cls'],
  );
}

/** A stand-in fighter shape for listing /data paths in completions (only keys are read). */
const DUMMY_KEYS = new Proxy({} as Fighter, {
  get(_t, key) {
    if (key === 'effects') return new Map();
    if (key === 'pos' || key === 'vel') return { x: 0, y: 0, z: 0 };
    if (key === 'food') return { level: 0, saturation: 0, exhaustion: 0 };
    if (key === 'heldStack') return () => null;
    return 0;
  },
});
