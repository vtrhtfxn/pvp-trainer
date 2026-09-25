import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { registerBuiltins } from '../src/commands/builtin';
import { CommandError, Dispatcher } from '../src/commands/dispatcher';
import { defaultSession, type ChatLine, type CmdCtx, type CommandHost } from '../src/commands/host';
import { B } from '../src/game/Blocks';
import { hurt, performAttack, rayDistanceToTarget } from '../src/game/combat';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';

function setup(kit = 'sword') {
  const d = new Dispatcher<CmdCtx>();
  registerBuiltins(d);
  let match = new Match(kitById(kit as never), DIFFICULTIES.lt3, 5);
  while (match.phase !== 'fight') match.tick();
  const out: string[] = [];
  const host: CommandHost = {
    online: false,
    get match() {
      return match;
    },
    session: defaultSession(),
    print: (l: ChatLine) => out.push(l.map((p) => p.t).join('')),
    applySession() {
      match.frozen = host.session.frozen;
      Object.assign(match.world.rules, host.session.rules);
      match.world.dayTime = host.session.dayTime;
    },
    markCheated() {},
    restart() {
      match = new Match(kitById(kit as never), DIFFICULTIES.lt3, 6);
    },
    step() {},
    sprint() {},
    stopStep: () => false,
    stopSprint: () => false,
    msPerTick: () => 1,
    title() {},
    playerName: 'Steve',
    broadcast(kind, text) {
      out.push(kind === 'say' ? `[Steve] ${text}` : kind === 'me' ? `* Steve ${text}` : `<Steve> ${text}`);
    },
    players: () => ['Steve', match.bot.name],
  };
  const ctx = (): CmdCtx => ({ host, self: match.player });
  const run = (line: string) => d.execute(line.replace(/^\//, ''), ctx());
  const fail = (line: string) => {
    try {
      run(line);
    } catch (e) {
      if (e instanceof CommandError) return e;
      throw e;
    }
    throw new Error(`expected "${line}" to fail`);
  };
  const suggest = (line: string) => d.suggest(line.replace(/^\//, ''), ctx()).list;
  return { d, host, get m() {
    return match;
  }, out, run, fail, suggest };
}

describe('command dispatcher', () => {
  it('parses, reports vanilla-style errors with a cursor, and completes', () => {
    const t = setup();
    expect(t.fail('tick rate abc').message).toBe("Invalid float 'abc'");
    expect(t.fail('tick rate abc').cursor).toBe(10);
    expect(t.fail('nope').message).toMatch(/Unknown or incomplete command/);
    expect(t.fail('tick').message).toMatch(/Unknown or incomplete command/);
    expect(t.suggest('ti')).toEqual(['tick', 'time', 'title']);
    expect(t.suggest('tick r')).toEqual(['rate']);
    expect(t.suggest('effect give @s str')).toContain('minecraft:strength');
    expect(t.suggest('attribute @s enti')).toContain('minecraft:entity_interaction_range');
    expect(t.suggest('gamemode c')).toEqual(['creative']);
    expect(t.d.usage('tick', { host: t.host, self: t.m.player })[0]).toMatch(/^\/tick/);
  });
});

describe('commands', () => {
  it('/tick rate and /tick freeze change the session', () => {
    const t = setup();
    t.run('/tick rate 40');
    expect(t.host.session.tickRate).toBe(40);
    expect(t.out.at(-1)).toBe('Set the target tick rate to 40 per second');
    t.run('/tick freeze');
    expect(t.m.frozen).toBe(true);
    // Frozen: the bot stays put, you can still move.
    const bot = t.m.bot.pos.clone();
    t.m.player.input = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: false };
    const z = t.m.player.pos.z;
    for (let i = 0; i < 10; i++) t.m.tick();
    expect(t.m.bot.pos.x).toBe(bot.x);
    expect(t.m.bot.pos.z).toBe(bot.z);
    expect(t.m.player.pos.z).not.toBe(z);
    t.run('/tick unfreeze');
    expect(t.m.frozen).toBe(false);
  });

  it('/attribute and /reach change the hit range (and the bot keeps its own)', () => {
    const t = setup();
    const p = t.m.player;
    const b = t.m.bot;
    p.pos.set(0.5, 0, 4.4);
    b.pos.set(0.5, 0, 0.5);
    p.yaw = 0;
    p.pitch = -0.1;
    expect(rayDistanceToTarget(p, b)).toBe(-1);
    t.run('/attribute @s minecraft:entity_interaction_range base set 4.5');
    expect(p.entityReach()).toBe(4.5);
    expect(rayDistanceToTarget(p, b)).toBeGreaterThan(3);
    p.attackStrengthTicker = 100;
    expect(performAttack(p, b).hit).toBe(true);
    expect(t.out.at(-1)).toBe('Base value for attribute Entity Interaction Range for Steve set to 4.5');
    t.run('/reach 6');
    expect(p.entityReach()).toBe(6);
    t.run('/attribute bot entity_interaction_range get');
    expect(t.out.at(-1)).toMatch(/is 3$/);
    t.run('/attribute @s entity_interaction_range base reset');
    expect(p.entityReach()).toBe(3);
    expect(t.fail('/attribute @a entity_interaction_range get').message).toMatch(/Only one entity/);
  });

  it('/attribute attack_speed 1024 removes the cooldown; gravity and jump_strength move you', () => {
    const t = setup();
    const p = t.m.player;
    t.run('/attribute @s attack_speed base set 1024');
    expect(p.attackDelay()).toBeLessThan(0.1);
    t.run('/attribute @s jump_strength base set 1');
    p.input = { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false };
    let top = 0;
    for (let i = 0; i < 40; i++) {
      t.m.tick();
      top = Math.max(top, p.pos.y);
    }
    expect(top).toBeGreaterThan(4);
  });

  it('/effect gives and clears effects, with vanilla mechanics', () => {
    const t = setup();
    const p = t.m.player;
    t.run('/effect give @s strength 10 1');
    expect(p.effects.get('strength')?.amplifier).toBe(1);
    expect(t.out.at(-1)).toBe('Applied effect Strength to Steve');
    t.run('/effect give @s resistance infinite 4');
    hurt(p, 10, null, false);
    expect(p.health).toBe(20); // Resistance V: immune
    t.run('/effect clear @s resistance');
    t.run('/gamerule naturalRegeneration false');
    t.run('/effect give bot poison 5 1');
    const hp = t.m.bot.health;
    for (let i = 0; i < 40; i++) t.m.tick();
    expect(t.m.bot.health).toBeLessThan(hp);
    p.health = 10;
    t.run('/effect give @s instant_health 1 1');
    expect(p.health).toBe(18);
    t.run('/effect give @s health_boost 30 1');
    expect(p.maxHealth).toBe(28);
    t.run('/effect clear');
    expect(p.effects.size).toBe(0);
    expect(p.maxHealth).toBe(20);
    expect(t.fail('/effect clear').message).toMatch(/no effects/);
  });

  it('/give with components, /clear, /enchant', () => {
    const t = setup();
    const p = t.m.player;
    t.run('/clear');
    t.run('/give @s minecraft:diamond_sword[enchantments={sharpness:5,knockback:2}]');
    expect(p.inventory[0]).toMatchObject({ id: 'diamond_sword', ench: { sharpness: 5, knockback: 2 } });
    expect(t.out.at(-1)).toBe('Gave 1 [Diamond Sword] to Steve');
    t.run('/give @s splash_potion[potion_contents={potion:"minecraft:strong_healing"}] 3');
    expect(p.countItem('splash_potion', 'healing')).toBe(3);
    t.run('/give @s golden_apple 70');
    expect(p.countItem('golden_apple')).toBe(70);
    expect(t.fail('/give @s diamond_sword[enchantments={bogus:1}]').message).toMatch(/unknown enchantment/);
    p.selectSlot(0);
    t.run('/enchant @s fire_aspect 2');
    expect(p.inventory[0]?.ench?.fireAspect).toBe(2);
    expect(t.fail('/enchant @s power 1').message).toMatch(/cannot support/);
    t.run('/clear @s golden_apple 10');
    expect(p.countItem('golden_apple')).toBe(60);
  });

  it('/gamemode creative: no damage, items are not used up, double-tap jump flies', () => {
    const t = setup('uhc');
    const p = t.m.player;
    t.run('/gamemode creative');
    expect(t.out.at(-1)).toBe('Set own game mode to Creative Mode');
    expect(hurt(p, 10, null, false).damaged).toBe(false);
    const jump = (on: boolean) => (p.input = { forward: 0, strafe: 0, jump: on, sneak: false, sprint: false });
    jump(true);
    t.m.tick();
    jump(false);
    t.m.tick();
    jump(true);
    t.m.tick();
    expect(p.flying).toBe(true);
    for (let i = 0; i < 20; i++) t.m.tick();
    expect(p.pos.y).toBeGreaterThan(2);
    jump(false);
    for (let i = 0; i < 20; i++) t.m.tick(); // drifts ~0.5 blocks, then hovers
    const y = p.pos.y;
    for (let i = 0; i < 20; i++) t.m.tick();
    expect(Math.abs(p.pos.y - y)).toBeLessThan(0.01);
    t.run('/gamemode survival');
    expect(p.flying).toBe(false);
  });

  it('/kill ends the duel; /tp, /gamerule, /time, /setblock, /fill', () => {
    const t = setup('uhc');
    t.run('/tp @s 10 0 10');
    expect(t.m.player.pos.x).toBe(10.5);
    t.run('/tp @s ~ ~5 ~');
    expect(t.m.player.pos.y).toBeCloseTo(5, 5);
    t.run('/tp bot @s');
    expect(t.m.bot.pos.x).toBe(10.5);
    t.run('/gamerule fallDamage false');
    expect(t.m.world.rules.fallDamage).toBe(false);
    expect(t.out.at(-1)).toBe('Gamerule fallDamage is now set to: false');
    t.run('/time set night');
    expect(t.m.world.dayTime).toBe(13000);
    t.run('/setblock 3 0 3 obsidian');
    expect(t.m.world.blocks.get(3, 0, 3)).toBe(B.OBSIDIAN);
    t.run('/fill 0 0 0 2 1 2 cobblestone');
    expect(t.m.world.blocks.get(2, 1, 2)).toBe(B.COBBLESTONE);
    expect(t.out.at(-1)).toBe('Successfully filled 18 block(s)');
    t.run('/kill bot');
    expect(t.m.bot.dead).toBe(true);
    t.m.tick();
    expect(t.m.phase).toBe('ended');
  });

  it('commands are refused online (except chat-ish ones)', () => {
    const t = setup();
    (t.host as { online: boolean }).online = true;
    expect(t.fail('/tick rate 40').message).toMatch(/Unknown or incomplete command/);
    t.run('/say hi');
    expect(t.out.at(-1)).toBe('[Steve] hi');
  });
});
