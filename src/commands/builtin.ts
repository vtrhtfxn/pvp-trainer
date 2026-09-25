import { DIFFICULTIES, type DifficultyId } from '../ai/difficulty';
import { ATTRIBUTES, type AttributeId, type GameMode } from '../game/attributes';
import { B, BLOCK_NAMES, isSolid } from '../game/Blocks';
import { hurt, type DamageKind } from '../game/combat';
import { DroppedItem } from '../game/DroppedItem';
import { SLOT_COUNT, type Fighter } from '../game/Fighter';
import { EFFECT_NAMES, INFINITE_DURATION, INSTANT_EFFECTS, ITEMS, cloneStack, stackName, type EffectId, type ItemStack } from '../game/items';
import { KITS, kitById, type KitId } from '../game/kits';
import { BUILD_HEIGHT, type GameRules } from '../game/World';
import {
  attribute,
  block,
  blockPos,
  bool,
  canEnchant,
  double,
  effect,
  enchantment,
  ENCHANTMENTS,
  entities,
  gameMode,
  greedy,
  integer,
  intRange,
  item,
  kit,
  oneOf,
  rotation,
  tier,
  time,
  vec3,
} from './args';
import { arg, CommandError, Dispatcher, lit, type Args } from './dispatcher';
import { COLOR, type CmdCtx, type ChatLine } from './host';

type Ctx = CmdCtx;

/** Effects given by /effect with `infinite` (the HUD shows ∞). */
export const INFINITE_TICKS = INFINITE_DURATION;

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

function nameOf(ctx: Ctx, f: Fighter): string {
  return f.id === 'player' ? ctx.host.playerName : f.name;
}

/** Vanilla's "…to %s" or "…to %s targets" wording. */
function who(ctx: Ctx, list: Fighter[]): string {
  return list.length === 1 ? nameOf(ctx, list[0]) : `${list.length} targets`;
}

function say(ctx: Ctx, text: string, color?: string) {
  if (!ctx.host.session.rules.sendCommandFeedback) return;
  ctx.host.print([{ t: text, c: color }]);
}

/** Everything that changes the duel: marks it as not counting toward records. */
function cheat(ctx: Ctx) {
  ctx.host.markCheated();
}

/** Game-changing commands only work offline, against the bot. */
const offline = (ctx: Ctx) => !ctx.host.online;

function needMatch(ctx: Ctx) {
  if (!ctx.host.match) throw new CommandError('Start a duel first — commands change the duel you are playing.');
  return ctx.host.match;
}

function targets(args: Args, key = 'targets'): Fighter[] {
  return args[key] as Fighter[];
}

/** The value /attribute … get reports: the base with items, armor and effects applied. */
export function attributeValue(f: Fighter, id: AttributeId): number {
  switch (id) {
    case 'entity_interaction_range':
      return f.entityReach();
    case 'block_interaction_range':
      return f.blockReach();
    case 'attack_damage':
      return f.attackDamage();
    case 'attack_speed':
      return f.attackSpeedValue();
    case 'movement_speed':
      return f.movementSpeed();
    case 'jump_strength':
      return f.jumpPower();
    case 'max_health':
      return f.maxHealth;
    case 'armor':
      return f.armor.points;
    case 'armor_toughness':
      return f.armor.toughness;
    case 'knockback_resistance':
      return f.armor.knockbackResistance;
    case 'explosion_knockback_resistance':
      return f.armor.explosionKnockbackResistance;
    default:
      return f.attrs[id];
  }
}

function setAttr(ctx: Ctx, f: Fighter, id: AttributeId, value: number | null) {
  const store = ctx.host.session.attrs[f.id];
  const v = value ?? ATTRIBUTES[id].def;
  f.setAttribute(id, v);
  if (value === null || f.attrs[id] === ATTRIBUTES[id].def) delete store[id];
  else store[id] = f.attrs[id];
}

const GAME_MODE_NAMES: Record<GameMode, string> = {
  survival: 'Survival Mode',
  creative: 'Creative Mode',
  adventure: 'Adventure Mode',
  spectator: 'Spectator Mode',
};

/** Vanilla rule names (and the snake_case spellings of newer versions) → our rules. */
const RULES: Record<string, keyof GameRules> = {
  naturalregeneration: 'naturalRegeneration',
  natural_regeneration: 'naturalRegeneration',
  natural_health_regeneration: 'naturalRegeneration',
  falldamage: 'fallDamage',
  fall_damage: 'fallDamage',
  firedamage: 'fireDamage',
  fire_damage: 'fireDamage',
  doimmediaterespawn: 'doImmediateRespawn',
  immediate_respawn: 'doImmediateRespawn',
  showdeathmessages: 'showDeathMessages',
  show_death_messages: 'showDeathMessages',
  sendcommandfeedback: 'sendCommandFeedback',
  send_command_feedback: 'sendCommandFeedback',
  dodaylightcycle: 'doDaylightCycle',
  advance_time: 'doDaylightCycle',
  daylight_cycle: 'doDaylightCycle',
};
const RULE_NAMES: (keyof GameRules)[] = [
  'doDaylightCycle',
  'doImmediateRespawn',
  'fallDamage',
  'fireDamage',
  'naturalRegeneration',
  'sendCommandFeedback',
  'showDeathMessages',
];

const DAMAGE_TYPES: Record<string, { kind: DamageKind; fire?: boolean; bypassArmor?: boolean }> = {
  generic: { kind: 'generic' },
  player_attack: { kind: 'generic' },
  magic: { kind: 'magic', bypassArmor: true },
  indirect_magic: { kind: 'magic', bypassArmor: true },
  fall: { kind: 'fall', bypassArmor: true },
  in_fire: { kind: 'generic', fire: true, bypassArmor: false },
  on_fire: { kind: 'generic', fire: true, bypassArmor: true },
  lava: { kind: 'generic', fire: true, bypassArmor: false },
  explosion: { kind: 'explosion' },
  player_explosion: { kind: 'explosion' },
  wither: { kind: 'wither', bypassArmor: true },
  generic_kill: { kind: 'kill', bypassArmor: true },
  out_of_world: { kind: 'kill', bypassArmor: true },
};

function giveStack(f: Fighter, template: ItemStack, count: number): number {
  const max = ITEMS[template.id].maxStack || 1;
  let left = count;
  while (left > 0) {
    const n = Math.min(max, left);
    const st = { ...cloneStack(template)!, count: n };
    left -= n;
    if (!f.addItem(st)) {
      // Whatever doesn't fit lands at your feet, like vanilla.
      f.world.items.push(new DroppedItem({ ...st }, f.pos.x, f.pos.y + 0.5, f.pos.z, f.world.rng));
    }
  }
  return count;
}

/** Clamps a teleport inside the arena (its walls go up forever; outside them is solid). */
function clampToArena(f: Fighter, x: number, y: number, z: number): [number, number, number] {
  const lim = f.world.half - 0.31;
  return [Math.max(-lim, Math.min(lim, x)), Math.max(-f.world.blocks.depth, Math.min(400, y)), Math.max(-lim, Math.min(lim, z))];
}

function teleport(f: Fighter, x: number, y: number, z: number, rot?: [number, number]) {
  const [cx, cy, cz] = clampToArena(f, x, y, z);
  f.pos.set(cx, cy, cz);
  f.prevPos.copy(f.pos);
  f.vel.set(0, 0, 0);
  f.serverVel.set(0, 0, 0);
  f.fallDistance = 0;
  f.onGround = false;
  if (rot) {
    f.yaw = f.prevYaw = ((180 - rot[0]) * Math.PI) / 180;
    f.pitch = f.prevPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, (-rot[1] * Math.PI) / 180));
  }
}

const TIME_NAMES: Record<string, number> = { day: 1000, noon: 6000, sunset: 12000, night: 13000, midnight: 18000, sunrise: 23000 };

export function registerBuiltins(d: Dispatcher<Ctx>) {
  // ------------------------------------------------------------------ help
  d.register(
    lit<Ctx>(
      'help',
      arg<Ctx, string>('command', {
        parse(r) {
          return r.readToken();
        },
        suggest: () => [...d.roots.keys()],
      }).runs((ctx, a) => {
        const name = String(a.command).replace(/^\//, '');
        const lines = d.usage(name, ctx);
        if (!lines.length) throw new CommandError(`Unknown command '${name}'`);
        for (const l of lines) ctx.host.print([{ t: l }]);
        const h = d.help.get(d.root(name)!.name);
        if (h) ctx.host.print([{ t: h, c: COLOR.gray }]);
      }),
    ).runs((ctx) => {
      ctx.host.print([{ t: 'Commands (Tab completes, ↑ repeats). /help <command> for its usage:', c: COLOR.gold }]);
      for (const [name, h] of [...d.help.entries()].sort()) {
        const node = d.roots.get(name)!;
        if (node.requires && !node.requires(ctx)) continue;
        ctx.host.print([{ t: `/${name}`, c: COLOR.yellow }, { t: ` — ${h}`, c: COLOR.gray }]);
      }
    }),
    'This list, or how to use one command',
    ['?'],
  );

  // ------------------------------------------------------------------ tick
  const tickQuery = (ctx: Ctx) => {
    const s = ctx.host.session;
    const status = s.frozen ? 'The game is frozen' : 'The game is running normally';
    ctx.host.print([{ t: status }]);
    const target = 1000 / s.tickRate;
    ctx.host.print([{ t: `Target tick rate: ${fmt(s.tickRate)} per second.` }]);
    ctx.host.print([{ t: `Average time per tick: ${ctx.host.msPerTick().toFixed(2)}ms (Target: ${target.toFixed(2)}ms)` }]);
  };
  d.register(
    lit<Ctx>(
      'tick',
      lit<Ctx>('query').runs(tickQuery),
      lit<Ctx>(
        'rate',
        arg<Ctx, number>('rate', double(1, 10000, 'Float')).runs((ctx, a) => {
          const rate = a.rate as number;
          ctx.host.session.tickRate = rate;
          if (rate !== 20) cheat(ctx);
          say(ctx, `Set the target tick rate to ${fmt(rate)} per second`);
        }),
      ),
      lit<Ctx>('freeze').runs((ctx) => {
        ctx.host.session.frozen = true;
        ctx.host.applySession();
        cheat(ctx);
        say(ctx, 'The game is frozen');
      }),
      lit<Ctx>('unfreeze').runs((ctx) => {
        ctx.host.session.frozen = false;
        ctx.host.applySession();
        say(ctx, 'The game is running normally');
      }),
      lit<Ctx>(
        'step',
        lit<Ctx>('stop').runs((ctx) => {
          if (!ctx.host.stopStep()) throw new CommandError('No step is in progress');
          say(ctx, 'Interrupted the current step');
        }),
        arg<Ctx, number>('time', time(1)).runs((ctx, a) => {
          if (!ctx.host.session.frozen) throw new CommandError('Unable to step the game — freeze it first (/tick freeze)');
          ctx.host.step(a.time as number);
          say(ctx, `Stepping ${a.time} tick(s)`);
        }),
      ).runs((ctx) => {
        if (!ctx.host.session.frozen) throw new CommandError('Unable to step the game — freeze it first (/tick freeze)');
        ctx.host.step(1);
        say(ctx, 'Stepping 1 tick(s)');
      }),
      lit<Ctx>(
        'sprint',
        lit<Ctx>('stop').runs((ctx) => {
          if (!ctx.host.stopSprint()) throw new CommandError('No tick sprint in progress');
          say(ctx, 'Interrupted the current tick sprint');
        }),
        arg<Ctx, number>('time', time(1)).runs((ctx, a) => {
          ctx.host.sprint(a.time as number);
          cheat(ctx);
        }),
      ),
    ).requires(offline),
    'Game speed: rate <ticks/s> (20 = normal), freeze, step, sprint, query',
  );

  // ------------------------------------------------------------------ attribute
  const attrNode = arg<Ctx, AttributeId>(
    'attribute',
    attribute(),
    lit<Ctx>('get', arg<Ctx, number>('scale', double()).runs((ctx, a) => attrGet(ctx, a, false))).runs((ctx, a) => attrGet(ctx, a, false)),
    lit<Ctx>(
      'base',
      lit<Ctx>('get', arg<Ctx, number>('scale', double()).runs((ctx, a) => attrGet(ctx, a, true))).runs((ctx, a) => attrGet(ctx, a, true)),
      lit<Ctx>(
        'set',
        arg<Ctx, number>('value', double()).runs((ctx, a) => {
          const f = targets(a, 'target')[0];
          const id = a.attribute as AttributeId;
          setAttr(ctx, f, id, a.value as number);
          cheat(ctx);
          say(ctx, `Base value for attribute ${ATTRIBUTES[id].name} for ${nameOf(ctx, f)} set to ${fmt(f.attrs[id])}`);
        }),
      ),
      lit<Ctx>('reset').runs((ctx, a) => {
        const f = targets(a, 'target')[0];
        const id = a.attribute as AttributeId;
        setAttr(ctx, f, id, null);
        say(ctx, `Base value for attribute ${ATTRIBUTES[id].name} for ${nameOf(ctx, f)} reset to default ${fmt(ATTRIBUTES[id].def)}`);
      }),
    ),
    lit<Ctx>('modifier').runs(() => {
      throw new CommandError('Attribute modifiers aren’t supported here — use "base set" (items and effects already apply theirs)');
    }),
  );
  const attrGet = (ctx: Ctx, a: Args, base: boolean) => {
    const f = targets(a, 'target')[0];
    const id = a.attribute as AttributeId;
    const v = base ? f.attrs[id] : attributeValue(f, id);
    say(ctx, `${base ? 'Base value' : 'Value'} of attribute ${ATTRIBUTES[id].name} for ${nameOf(ctx, f)} is ${fmt(v)}`);
    return Math.round(v * ((a.scale as number) ?? 1));
  };
  d.register(
    lit<Ctx>('attribute', arg<Ctx, Fighter[]>('target', entities(true), attrNode)).requires(offline),
    'Read or change a stat: reach (entity_interaction_range), attack_speed, movement_speed, gravity…',
  );

  // Shortcut for the one everyone wants.
  d.register(
    lit<Ctx>(
      'reach',
      arg<Ctx, number>('blocks', double(0, 64)).runs((ctx, a) => {
        const f = needMatch(ctx).player;
        setAttr(ctx, f, 'entity_interaction_range', a.blocks as number);
        cheat(ctx);
        say(ctx, `Your reach is now ${fmt(f.entityReach())} blocks (vanilla: 3)`);
      }),
      lit<Ctx>('reset').runs((ctx) => {
        const f = needMatch(ctx).player;
        setAttr(ctx, f, 'entity_interaction_range', null);
        say(ctx, `Your reach is back to ${fmt(f.entityReach())} blocks`);
      }),
    )
      .runs((ctx) => {
        const f = needMatch(ctx).player;
        say(ctx, `Your reach is ${fmt(f.entityReach())} blocks`);
      })
      .requires(offline),
    'PvP Trainer shortcut: your hit range (= /attribute @s entity_interaction_range base set)',
  );

  // ------------------------------------------------------------------ effect
  const give = (ctx: Ctx, a: Args, seconds: number | 'infinite', amp: number) => {
    const list = targets(a);
    const id = a.effect as EffectId;
    const ticks = seconds === 'infinite' ? INFINITE_TICKS : INSTANT_EFFECTS.has(id) ? 1 : seconds * 20;
    for (const f of list) f.addEffect(id, amp, ticks);
    cheat(ctx);
    say(ctx, `Applied effect ${EFFECT_NAMES[id]} to ${who(ctx, list)}`);
    return list.length;
  };
  const amplifier = arg<Ctx, number>('amplifier', integer(0, 255), arg<Ctx, boolean>('hideParticles', bool()).runs((ctx, a) => give(ctx, a, a.seconds as number | 'infinite', a.amplifier as number)));
  amplifier.runs((ctx, a) => give(ctx, a, a.seconds as number | 'infinite', a.amplifier as number));
  const secondsArg = {
    parse(r: import('./dispatcher').Reader) {
      const at = r.i;
      const t = r.readToken();
      if (t === 'infinite') return 'infinite' as const;
      if (!/^\d+$/.test(t)) throw r.error(t ? `Invalid integer '${t}'` : 'Expected integer', at);
      const v = Number(t);
      if (v < 1 || v > 1000000) throw r.error(`Integer must be between 1 and 1000000, found ${v}`, at);
      return v;
    },
    suggest: () => ['infinite', '30', '60'],
  };
  d.register(
    lit<Ctx>(
      'effect',
      lit<Ctx>(
        'give',
        arg<Ctx, Fighter[]>(
          'targets',
          entities(),
          arg<Ctx, EffectId>(
            'effect',
            effect(),
            arg<Ctx, number | 'infinite'>('seconds', secondsArg, amplifier).runs((ctx, a) => give(ctx, a, a.seconds as number | 'infinite', 0)),
          ).runs((ctx, a) => give(ctx, a, 30, 0)),
        ),
      ),
      lit<Ctx>(
        'clear',
        arg<Ctx, Fighter[]>(
          'targets',
          entities(),
          arg<Ctx, EffectId>('effect', effect()).runs((ctx, a) => {
            const list = targets(a).filter((f) => f.effects.has(a.effect as EffectId));
            if (!list.length) throw new CommandError('Target doesn’t have the requested effect');
            for (const f of list) f.removeEffect(a.effect as EffectId);
            say(ctx, `Removed effect ${EFFECT_NAMES[a.effect as EffectId]} from ${who(ctx, list)}`);
          }),
        ).runs((ctx, a) => clearEffects(ctx, targets(a))),
      ).runs((ctx) => clearEffects(ctx, [needMatch(ctx).player])),
    ).requires(offline),
    'give <targets> <effect> [seconds|infinite] [amplifier] · clear [targets] [effect]',
  );
  const clearEffects = (ctx: Ctx, list: Fighter[]) => {
    const had = list.filter((f) => f.effects.size);
    if (!had.length) throw new CommandError('Target has no effects to remove');
    for (const f of had) f.removeEffect();
    say(ctx, `Removed every effect from ${who(ctx, had)}`);
  };

  // ------------------------------------------------------------------ give / clear
  const giveRun = (ctx: Ctx, a: Args, count: number) => {
    const list = targets(a);
    const st = a.item as ItemStack;
    const max = (ITEMS[st.id].maxStack || 1) * 100;
    if (count > max) throw new CommandError(`Can't give more than ${max} of [${stackName(st)}]`);
    for (const f of list) giveStack(f, st, count);
    cheat(ctx);
    say(ctx, `Gave ${count} [${stackName(st)}] to ${who(ctx, list)}`);
    return list.length;
  };
  d.register(
    lit<Ctx>(
      'give',
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        arg<Ctx, ItemStack>('item', item(), arg<Ctx, number>('count', integer(1, 6400)).runs((ctx, a) => giveRun(ctx, a, a.count as number))).runs((ctx, a) => giveRun(ctx, a, 1)),
      ),
    ).requires(offline),
    'give <targets> <item> [count] — e.g. /give @s diamond_sword[enchantments={sharpness:5}]',
  );

  const clearRun = (ctx: Ctx, list: Fighter[], filter: ItemStack | null, max: number) => {
    let removed = 0;
    for (const f of list) {
      let left = max;
      for (let k = 0; k < SLOT_COUNT && left > 0; k++) {
        const s = f.getSlot(k);
        if (!s || (filter && (s.id !== filter.id || (filter.potion && s.potion !== filter.potion)))) continue;
        const n = Math.min(left, s.count);
        left -= n;
        removed += n;
        if (n >= s.count) f.setSlot(k, null);
        else s.count -= n;
      }
    }
    if (!removed) throw new CommandError(`No items were found on ${list.length === 1 ? `player ${nameOf(ctx, list[0])}` : `${list.length} players`}`);
    cheat(ctx);
    say(ctx, `Removed ${removed} item(s) from ${list.length === 1 ? `player ${nameOf(ctx, list[0])}` : `${list.length} players`}`);
    return removed;
  };
  d.register(
    lit<Ctx>(
      'clear',
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        arg<Ctx, ItemStack>(
          'item',
          item(),
          arg<Ctx, number>('maxCount', integer(0)).runs((ctx, a) => clearRun(ctx, targets(a), a.item as ItemStack, a.maxCount as number)),
        ).runs((ctx, a) => clearRun(ctx, targets(a), a.item as ItemStack, Infinity)),
      ).runs((ctx, a) => clearRun(ctx, targets(a), null, Infinity)),
    )
      .runs((ctx) => clearRun(ctx, [needMatch(ctx).player], null, Infinity))
      .requires(offline),
    'Empty inventories: clear [targets] [item] [maxCount]',
  );

  // ------------------------------------------------------------------ kill / damage / heal
  const killRun = (ctx: Ctx, list: Fighter[]) => {
    for (const f of list) {
      f.lastDamage = { kind: 'kill', attacker: null, fire: false };
      f.die();
    }
    cheat(ctx);
    say(ctx, list.length === 1 ? `Killed ${nameOf(ctx, list[0])}` : `Killed ${list.length} entities`);
  };
  d.register(
    lit<Ctx>('kill', arg<Ctx, Fighter[]>('targets', entities()).runs((ctx, a) => killRun(ctx, targets(a))))
      .runs((ctx) => killRun(ctx, [needMatch(ctx).player]))
      .requires(offline),
    'Kill yourself or the bot (ends the duel)',
  );

  const damageRun = (ctx: Ctx, a: Args, type: string) => {
    const f = targets(a, 'target')[0];
    const t = DAMAGE_TYPES[type];
    const res = hurt(f, a.amount as number, null, false, !!t.fire, t.bypassArmor ?? (!!t.fire || t.kind === 'kill'), t.kind);
    cheat(ctx);
    say(ctx, res.damaged ? `Applied ${fmt(a.amount as number)} damage to ${nameOf(ctx, f)}` : `${nameOf(ctx, f)} took no damage (immune right now)`);
  };
  d.register(
    lit<Ctx>(
      'damage',
      arg<Ctx, Fighter[]>(
        'target',
        entities(true),
        arg<Ctx, number>('amount', double(0), arg<Ctx, string>('damageType', oneOf(Object.keys(DAMAGE_TYPES), 'damage type')).runs((ctx, a) => damageRun(ctx, a, a.damageType as string))).runs((ctx, a) => damageRun(ctx, a, 'generic')),
      ),
    ).requires(offline),
    'damage <target> <amount> [type: generic, magic, fall, lava, explosion, …]',
  );

  const healRun = (ctx: Ctx, list: Fighter[]) => {
    for (const f of list) {
      f.health = f.maxHealth;
      f.food.level = 20;
      f.food.saturation = 5;
      f.fireTicks = 0;
    }
    cheat(ctx);
    say(ctx, `Healed ${who(ctx, list)}`);
  };
  d.register(
    lit<Ctx>('heal', arg<Ctx, Fighter[]>('targets', entities()).runs((ctx, a) => healRun(ctx, targets(a))))
      .runs((ctx) => healRun(ctx, [needMatch(ctx).player]))
      .requires(offline),
    'PvP Trainer: full health and hunger, fire put out',
  );

  // ------------------------------------------------------------------ teleport
  const tpTo = (ctx: Ctx, list: Fighter[], pos: (s: Fighter | null) => import('../core/math').V3, rot?: (s: Fighter | null) => [number, number]) => {
    const p = pos(ctx.self);
    const r = rot?.(ctx.self);
    for (const f of list) teleport(f, p.x, p.y, p.z, r);
    cheat(ctx);
    say(ctx, `Teleported ${who(ctx, list)} to ${fmt(Math.round(p.x * 100) / 100)}, ${fmt(Math.round(p.y * 100) / 100)}, ${fmt(Math.round(p.z * 100) / 100)}`);
  };
  const tpToEntity = (ctx: Ctx, list: Fighter[], dest: Fighter) => {
    for (const f of list) teleport(f, dest.pos.x, dest.pos.y, dest.pos.z, [180 - (dest.yaw * 180) / Math.PI, (-dest.pitch * 180) / Math.PI]);
    cheat(ctx);
    say(ctx, `Teleported ${who(ctx, list)} to ${nameOf(ctx, dest)}`);
  };
  const tp = (name: string) =>
    lit<Ctx>(
      name,
      arg<Ctx, (s: Fighter | null) => import('../core/math').V3>('location', vec3()).runs((ctx, a) => tpTo(ctx, [needMatch(ctx).player], a.location as never)),
      arg<Ctx, Fighter[]>('destination', entities(true)).runs((ctx, a) => tpToEntity(ctx, [needMatch(ctx).player], targets(a, 'destination')[0])),
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        arg<Ctx, (s: Fighter | null) => import('../core/math').V3>(
          'location',
          vec3(),
          arg<Ctx, unknown>('rotation', rotation()).runs((ctx, a) => tpTo(ctx, targets(a), a.location as never, a.rotation as never)),
        ).runs((ctx, a) => tpTo(ctx, targets(a), a.location as never)),
        arg<Ctx, Fighter[]>('destination', entities(true)).runs((ctx, a) => tpToEntity(ctx, targets(a), targets(a, 'destination')[0])),
      ),
    ).requires(offline);
  d.register(tp('teleport'), 'teleport [targets] <x y z | entity> — ~ is relative, ^ is along your view', ['tp']);

  // ------------------------------------------------------------------ gamemode
  const gmRun = (ctx: Ctx, list: Fighter[], mode: GameMode) => {
    for (const f of list) {
      f.setGameMode(mode);
      ctx.host.session.gameModes[f.id] = mode;
    }
    if (mode !== 'survival') cheat(ctx);
    for (const f of list) {
      say(ctx, f.id === 'player' ? `Set own game mode to ${GAME_MODE_NAMES[mode]}` : `Set ${nameOf(ctx, f)}'s game mode to ${GAME_MODE_NAMES[mode]}`);
    }
  };
  d.register(
    lit<Ctx>(
      'gamemode',
      arg<Ctx, GameMode>('gamemode', gameMode(), arg<Ctx, Fighter[]>('target', entities()).runs((ctx, a) => gmRun(ctx, targets(a, 'target'), a.gamemode as GameMode))).runs((ctx, a) =>
        gmRun(ctx, [needMatch(ctx).player], a.gamemode as GameMode),
      ),
    ).requires(offline),
    'survival · creative (fly with double-tap Space, can’t be hurt) · adventure · spectator',
  );

  // ------------------------------------------------------------------ gamerule
  const ruleNode = (rule: keyof GameRules) =>
    lit<Ctx>(
      rule.toLowerCase(),
      arg<Ctx, boolean>('value', bool()).runs((ctx, a) => {
        ctx.host.session.rules[rule] = a.value as boolean;
        ctx.host.applySession();
        if (rule === 'naturalRegeneration' || rule === 'fallDamage' || rule === 'fireDamage') cheat(ctx);
        ctx.host.print([{ t: `Gamerule ${rule} is now set to: ${a.value}` }]);
      }),
    ).runs((ctx) => {
      ctx.host.print([{ t: `Gamerule ${rule} is currently set to: ${ctx.host.session.rules[rule]}` }]);
    });
  const gamerule = lit<Ctx>('gamerule');
  for (const r of RULE_NAMES) gamerule.then(ruleNode(r));
  // The newer snake_case spellings.
  for (const [alias, rule] of Object.entries(RULES)) {
    if (alias.includes('_')) {
      const n = ruleNode(rule);
      n.node.name = alias;
      gamerule.then(n);
    }
  }
  d.register(gamerule.requires(offline), 'naturalRegeneration, fallDamage, fireDamage, doDaylightCycle, doImmediateRespawn, …');

  // ------------------------------------------------------------------ time / weather
  const setTime = (ctx: Ctx, t: number) => {
    ctx.host.session.dayTime = ((t % 24000) + 24000) % 24000;
    ctx.host.applySession();
    say(ctx, `Set the time to ${t}`);
  };
  const timeSet = lit<Ctx>('set', arg<Ctx, number>('time', time(0)).runs((ctx, a) => setTime(ctx, a.time as number)));
  for (const [n, t] of Object.entries(TIME_NAMES)) timeSet.then(lit<Ctx>(n).runs((ctx) => setTime(ctx, t)));
  d.register(
    lit<Ctx>(
      'time',
      timeSet,
      lit<Ctx>(
        'add',
        arg<Ctx, number>('time', time(0)).runs((ctx, a) => {
          const t = ctx.host.session.dayTime + (a.time as number);
          ctx.host.session.dayTime = t % 24000;
          ctx.host.applySession();
          say(ctx, `Set the time to ${t}`);
        }),
      ),
      lit<Ctx>(
        'query',
        lit<Ctx>('daytime').runs((ctx) => say(ctx, `The time is ${Math.floor(ctx.host.session.dayTime)}`)),
        lit<Ctx>('gametime').runs((ctx) => say(ctx, `The time is ${ctx.host.match?.tickCount ?? 0}`)),
        lit<Ctx>('day').runs((ctx) => say(ctx, 'The time is 0')),
      ),
    ).requires(offline),
    'set (day|noon|night|midnight|<ticks>) · add <time> · query daytime',
  );

  const weatherRun = (ctx: Ctx, w: 'clear' | 'rain' | 'thunder') => {
    ctx.host.session.weather = w;
    ctx.host.applySession();
    say(ctx, w === 'clear' ? 'Set the weather to clear' : w === 'rain' ? 'Set the weather to rain' : 'Set the weather to rain & thunder');
  };
  const weather = lit<Ctx>('weather');
  for (const w of ['clear', 'rain', 'thunder'] as const) {
    weather.then(lit<Ctx>(w, arg<Ctx, number>('duration', time(1)).runs((ctx) => weatherRun(ctx, w))).runs((ctx) => weatherRun(ctx, w)));
  }
  d.register(weather.requires(offline), 'clear · rain · thunder');

  // ------------------------------------------------------------------ enchant
  const enchantRun = (ctx: Ctx, a: Args, level: number) => {
    const list = targets(a);
    const id = a.enchantment as string;
    const e = ENCHANTMENTS[id];
    if (level > e.max) throw new CommandError(`${level} is higher than the maximum level of ${e.max} supported by that enchantment`);
    let ok = 0;
    for (const f of list) {
      const st = f.heldStack();
      if (!st) {
        if (list.length === 1) throw new CommandError(`${nameOf(ctx, f)} isn't holding an item`);
        continue;
      }
      if (!canEnchant(st.id, id)) {
        if (list.length === 1) throw new CommandError(`${ITEMS[st.id].name} cannot support that enchantment`);
        continue;
      }
      st.ench = { ...st.ench, [e.key]: level };
      ok++;
    }
    if (!ok) throw new CommandError('Nothing changed. Targets either have no item in their hands or the enchantment could not be applied');
    cheat(ctx);
    say(ctx, `Applied enchantment ${id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} ${level} to ${list.length === 1 ? `${nameOf(ctx, list[0])}'s item` : `${ok} entities`}`);
  };
  d.register(
    lit<Ctx>(
      'enchant',
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        arg<Ctx, string>('enchantment', enchantment(), arg<Ctx, number>('level', integer(1, 255)).runs((ctx, a) => enchantRun(ctx, a, a.level as number))).runs((ctx, a) => enchantRun(ctx, a, 1)),
      ),
    ).requires(offline),
    'Enchant the item in hand: enchant @s sharpness 5',
  );

  // ------------------------------------------------------------------ setblock / fill
  const inBuild = (ctx: Ctx, x: number, y: number, z: number) => {
    const b = needMatch(ctx).world.blocks;
    return b.inside(x, y, z) && y < BUILD_HEIGHT;
  };
  const placeBlock = (ctx: Ctx, x: number, y: number, z: number, id: number, mode: string): boolean => {
    const w = needMatch(ctx).world;
    const b = w.blocks;
    const cur = b.get(x, y, z);
    if (mode === 'keep' && cur !== B.AIR) return false;
    if (cur === id && id !== B.WATER && id !== B.LAVA) return false;
    if (mode === 'destroy' && cur !== B.AIR) w.emit({ type: 'blockBreak', x, y, z, block: cur });
    if (id === B.WATER || id === B.LAVA) b.placeSource(x, y, z, id);
    else b.set(x, y, z, id);
    return true;
  };
  const setblockRun = (ctx: Ctx, a: Args, mode: string) => {
    const [x, y, z] = (a.pos as (s: Fighter | null) => [number, number, number])(ctx.self);
    if (!inBuild(ctx, x, y, z)) throw new CommandError('That position is out of the arena (blocks go inside the walls, below build height)');
    if (!placeBlock(ctx, x, y, z, a.block as number, mode)) throw new CommandError('Could not set the block');
    cheat(ctx);
    say(ctx, `Changed the block at ${x}, ${y}, ${z}`);
  };
  const modes = ['destroy', 'keep', 'replace'];
  const setblockNode = arg<Ctx, number>('block', block()).runs((ctx, a) => setblockRun(ctx, a, 'replace'));
  for (const m of modes) setblockNode.then(lit<Ctx>(m).runs((ctx, a) => setblockRun(ctx, a, m)));
  d.register(lit<Ctx>('setblock', arg<Ctx, unknown>('pos', blockPos(), setblockNode)).requires(offline), 'setblock <x y z> <block> [destroy|keep|replace]');

  const fillRun = (ctx: Ctx, a: Args, mode: string) => {
    const [x0, y0, z0] = (a.from as (s: Fighter | null) => [number, number, number])(ctx.self);
    const [x1, y1, z1] = (a.to as (s: Fighter | null) => [number, number, number])(ctx.self);
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const [az, bz] = [Math.min(z0, z1), Math.max(z0, z1)];
    const volume = (bx - ax + 1) * (by - ay + 1) * (bz - az + 1);
    if (volume > 32768) throw new CommandError(`Too many blocks in the specified area (maximum 32768, specified ${volume})`);
    const id = a.block as number;
    let n = 0;
    for (let y = ay; y <= by; y++)
      for (let z = az; z <= bz; z++)
        for (let x = ax; x <= bx; x++) {
          if (!inBuild(ctx, x, y, z)) continue;
          const edge = x === ax || x === bx || y === ay || y === by || z === az || z === bz;
          if ((mode === 'outline' || mode === 'hollow') && !edge) {
            if (mode === 'hollow' && placeBlock(ctx, x, y, z, B.AIR, 'replace')) n++;
            continue;
          }
          if (placeBlock(ctx, x, y, z, id, mode)) n++;
        }
    if (!n) throw new CommandError('No blocks were filled');
    cheat(ctx);
    say(ctx, `Successfully filled ${n} block(s)`);
  };
  const fillNode = arg<Ctx, number>('block', block()).runs((ctx, a) => fillRun(ctx, a, 'replace'));
  for (const m of ['destroy', 'hollow', 'keep', 'outline', 'replace']) fillNode.then(lit<Ctx>(m).runs((ctx, a) => fillRun(ctx, a, m)));
  d.register(lit<Ctx>('fill', arg<Ctx, unknown>('from', blockPos(), arg<Ctx, unknown>('to', blockPos(), fillNode))).requires(offline), 'fill <from> <to> <block> [destroy|hollow|keep|outline|replace]');

  // ------------------------------------------------------------------ chat-ish
  d.register(
    lit<Ctx>(
      'say',
      arg<Ctx, string>('message', greedy()).runs((ctx, a) => {
        ctx.host.broadcast('say', a.message as string);
      }),
    ),
    'Broadcast a message',
  );
  d.register(
    lit<Ctx>(
      'me',
      arg<Ctx, string>('action', greedy()).runs((ctx, a) => {
        ctx.host.broadcast('me', a.action as string);
      }),
    ),
    'Describe an action',
  );
  d.register(
    lit<Ctx>('list').runs((ctx) => {
      const names = ctx.host.players();
      say(ctx, `There are ${names.length} of a max of 2 players online: ${names.join(', ')}`);
    }),
    'Who is here',
  );
  d.register(
    lit<Ctx>(
      'random',
      lit<Ctx>(
        'value',
        arg<Ctx, [number, number]>('range', intRange()).runs((ctx, a) => {
          const [lo, hi] = a.range as [number, number];
          const v = lo + Math.floor(Math.random() * (hi - lo + 1));
          say(ctx, `Randomized value: ${v}`);
          return v;
        }),
      ),
      lit<Ctx>(
        'roll',
        arg<Ctx, [number, number]>('range', intRange()).runs((ctx, a) => {
          const [lo, hi] = a.range as [number, number];
          const v = lo + Math.floor(Math.random() * (hi - lo + 1));
          ctx.host.print([{ t: `${ctx.host.playerName} rolled ${v} (from ${lo} to ${hi})` }]);
          return v;
        }),
      ),
    ),
    'value <range> · roll <range>, e.g. /random roll 1..6',
  );
  const titleText = (raw: string): string => {
    const s = raw.trim();
    try {
      const j = JSON.parse(s) as unknown;
      if (typeof j === 'string') return j;
      if (j && typeof j === 'object' && 'text' in j) return String((j as { text: unknown }).text);
    } catch {
      /* plain text */
    }
    return s;
  };
  const titleKind = (kind: 'title' | 'subtitle' | 'actionbar') =>
    lit<Ctx>(kind, arg<Ctx, string>('text', greedy()).runs((ctx, a) => ctx.host.title(kind, titleText(a.text as string))));
  d.register(
    lit<Ctx>(
      'title',
      arg<Ctx, Fighter[]>(
        'targets',
        entities(),
        titleKind('title'),
        titleKind('subtitle'),
        titleKind('actionbar'),
        lit<Ctx>('clear').runs((ctx) => ctx.host.title('clear', '')),
        lit<Ctx>('reset').runs((ctx) => ctx.host.title('clear', '')),
      ),
    ),
    'title <targets> (title|subtitle|actionbar) <text>',
  );

  // ------------------------------------------------------------------ PvP Trainer extras
  d.register(
    lit<Ctx>(
      'kit',
      arg<Ctx, KitId>('kit', kit()).runs((ctx, a) => {
        ctx.host.restart({ kit: a.kit as KitId });
        say(ctx, `Starting a ${kitById(a.kit as KitId).name} duel`);
      }),
    )
      .runs((ctx) => {
        say(ctx, `Kits: ${KITS.filter((k) => k.available).map((k) => k.id).join(', ')}`);
      })
      .requires(offline),
    'PvP Trainer: start a duel with another kit',
  );
  d.register(
    lit<Ctx>(
      'bot',
      lit<Ctx>(
        'tier',
        arg<Ctx, DifficultyId>('tier', tier()).runs((ctx, a) => {
          ctx.host.restart({ tier: a.tier as DifficultyId });
          say(ctx, `Starting a duel against ${DIFFICULTIES[a.tier as DifficultyId].name}`);
        }),
      ),
    ).requires(offline),
    'PvP Trainer: bot tier <LT5 … HT1 | practice> starts a new duel against it',
  );
  d.register(
    lit<Ctx>('restart').runs((ctx) => {
      ctx.host.restart();
    }).requires(offline),
    'PvP Trainer: start the duel again (rules, reach and other settings stay)',
  );
}

/**
 * Vanilla-style death message for chat ("HT3 Bot was slain by Steve", "Steve fell from a high
 * place", …), from what hurt the fighter last.
 */
export function deathMessage(f: Fighter, name: (f: Fighter) => string): ChatLine {
  const d = f.lastDamage;
  const me = name(f);
  const by = d?.attacker && d.attacker !== f ? name(d.attacker) : null;
  let text: string;
  if (!d) text = `${me} died`;
  else if (d.kind === 'kill') text = `${me} was killed`;
  else if (d.kind === 'fall') text = by ? `${me} was doomed to fall by ${by}` : `${me} hit the ground too hard`;
  else if (d.kind === 'explosion') text = by ? `${me} was blown up by ${by}` : `${me} blew up`;
  else if (d.kind === 'magic') text = by ? `${me} was killed by ${by} using magic` : `${me} was killed by magic`;
  else if (d.kind === 'wither') text = `${me} withered away`;
  else if (d.fire) text = f.inLava ? `${me} tried to swim in lava` : by ? `${me} was burned to a crisp whilst fighting ${by}` : `${me} burned to death`;
  else if (by) {
    const weapon = d.attacker!.heldStack();
    text = weapon && weapon.ench && Object.keys(weapon.ench).length ? `${me} was slain by ${by} using [${stackName(weapon)}]` : `${me} was slain by ${by}`;
  } else text = `${me} died`;
  return [{ t: text }];
}

/** For /setblock and /fill: which names exist. */
export const BLOCK_NAME_LIST = ['air', ...Object.values(BLOCK_NAMES)];
export { isSolid };
