import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type TierId } from '../src/ai/difficulty';
import { B } from '../src/game/Blocks';
import { Match } from '../src/game/Match';
import { kitById } from '../src/game/kits';
import { Bedwars, RESPAWN_TICKS } from '../src/game/modes/Bedwars';
import { SHOP } from '../src/game/modes/shop';
import { Skywars, lootValue } from '../src/game/modes/Skywars';
import { Spectate } from '../src/game/Spectate';

function match(kit: 'bedwars' | 'skywars', seed = 3): Match {
  const m = new Match(kitById(kit), DIFFICULTIES.practice, seed);
  m.botDriver = () => {};
  return m;
}

function run(m: Match, ticks: number, each?: () => void) {
  for (let i = 0; i < ticks; i++) {
    each?.();
    m.tick();
    m.world.events.length = 0;
    m.player.events.length = 0;
    m.bot.events.length = 0;
    m.mode?.takeAnnouncements();
  }
}

const toFight = (m: Match) => {
  while (m.phase !== 'fight') run(m, 1);
};

describe('Bed Wars', () => {
  it('builds a void map with both beds, spawns and a shop', () => {
    const m = match('bedwars');
    const mode = m.mode as Bedwars;
    expect(m.world.blocks.voidWorld).toBe(true);
    expect(m.world.protectMap).toBe(true);
    for (const t of mode.layout.teams) {
      for (const c of t.bed) expect(m.world.blocks.get(c.x, c.y, c.z)).toBe(B.BED);
      expect(m.world.blocks.get(t.shop.x, t.shop.y, t.shop.z)).toBe(B.SHOP);
    }
    // Starting kit: wooden sword and leather armor in the team colour.
    expect(m.player.slotOf('wooden_sword')).toBeGreaterThanOrEqual(0);
    expect(m.player.armorSlots.map((s) => s?.id)).toContain('red_leather_chestplate');
    expect(m.bot.armorSlots.map((s) => s?.id)).toContain('blue_leather_chestplate');
  });

  it('forges iron and gold that the player can spend at the shop', () => {
    const m = match('bedwars');
    const mode = m.mode as Bedwars;
    toFight(m);
    const gen = mode.layout.teams[0].gen;
    m.player.pos.set(gen.x, gen.y, gen.z);
    run(m, 20 * 20);
    expect(m.player.countItem('iron_ingot')).toBeGreaterThanOrEqual(10);
    const iron = m.player.countItem('iron_ingot');
    const wool = SHOP.find((i) => i.key === 'wool')!;
    expect(mode.buy(m, m.player, wool)).toBeNull();
    expect(m.player.countItem('iron_ingot')).toBe(iron - 4);
    expect(m.player.countItem('red_wool')).toBe(16);
    const sword = SHOP.find((i) => i.key === 'stone_sword')!;
    expect(mode.buy(m, m.player, sword)).toBeNull();
    expect(m.player.slotOf('stone_sword')).toBeGreaterThanOrEqual(0);
    // Too poor for diamond armor.
    expect(mode.buy(m, m.player, SHOP.find((i) => i.key === 'armor3')!)).not.toBeNull();
  });

  it('protects the map: only placed blocks break, and not your own bed', () => {
    const m = match('bedwars');
    const mode = m.mode as Bedwars;
    const w = m.world;
    const own = mode.layout.teams[0].bed[0];
    const theirs = mode.layout.teams[1].bed[0];
    expect(w.canBreak(m.player, own.x, own.y, own.z, B.BED)).toBe(false);
    expect(w.canBreak(m.player, theirs.x, theirs.y, theirs.z, B.BED)).toBe(true);
    const s = mode.layout.teams[0].spawn;
    const floor = { x: Math.floor(s.x), y: Math.floor(s.y) - 1, z: Math.floor(s.z) };
    expect(w.canBreak(m.player, floor.x, floor.y, floor.z, w.blocks.get(floor.x, floor.y, floor.z))).toBe(false);
    w.blocks.set(0, 0, 10, B.WOOL);
    w.blocks.markPlaced(0, 0, 10);
    expect(w.canBreak(m.player, 0, 0, 10, B.WOOL)).toBe(true);
  });

  it('respawns you while your bed stands; without it the next death is final', () => {
    const m = match('bedwars');
    const mode = m.mode as Bedwars;
    toFight(m);
    m.player.pos.set(0.5, -40, 0.5);
    run(m, 5);
    expect(m.player.dead).toBe(true);
    expect(m.player.lastDamage?.kind).toBe('void');
    run(m, RESPAWN_TICKS + 5);
    expect(m.player.dead).toBe(false);
    expect(m.winner).toBeNull();
    // Break the red bed, then fall again: out of the game.
    for (const c of mode.layout.teams[0].bed) m.world.blocks.set(c.x, c.y, c.z, B.AIR);
    run(m, 2);
    expect(mode.teams[0].bedAlive).toBe(false);
    m.player.pos.set(0.5, -40, 0.5);
    run(m, 10);
    expect(mode.teams[0].eliminated).toBe(true);
    expect(m.phase === 'ended' || m.winner === m.bot).toBe(true);
  });
});

describe('SkyWars', () => {
  it('starts both players caged over their islands with filled chests', () => {
    const m = match('skywars');
    const mode = m.mode as Skywars;
    expect(m.player.inventory.every((s) => !s)).toBe(true);
    for (const cage of mode.layout.cages) expect(cage.some((c) => m.world.blocks.get(c.x, c.y, c.z) === B.GLASS)).toBe(true);
    for (const team of [0, 1]) {
      const all = mode.layout.islandChests[team].flatMap((c) => mode.chestAt(c.x, c.y, c.z)!.filter(Boolean));
      // Every island gets a sword and some armor.
      expect(all.some((s) => s!.id.endsWith('_sword'))).toBe(true);
      expect(all.filter((s) => lootValue(s!) >= 10).length).toBeGreaterThanOrEqual(3);
    }
    for (const c of mode.layout.midChests) expect(m.world.blocks.get(c.x, c.y, c.z)).toBe(B.CHEST);
  });

  it('opens the cages when the fight starts; the void kills and there are no respawns', () => {
    const m = match('skywars');
    const mode = m.mode as Skywars;
    toFight(m);
    run(m, 1);
    for (const cage of mode.layout.cages) for (const c of cage) expect(m.world.blocks.get(c.x, c.y, c.z)).not.toBe(B.GLASS);
    m.bot.pos.set(0.5, -40, 0.5);
    run(m, 5);
    expect(m.bot.dead).toBe(true);
    expect(m.winner).toBe(m.player);
  });

  it('spills a broken chest', () => {
    const m = match('skywars');
    const mode = m.mode as Skywars;
    toFight(m);
    const c = mode.layout.islandChests[0][0];
    const n = mode.chestAt(c.x, c.y, c.z)!.filter(Boolean).length;
    m.world.blocks.set(c.x, c.y, c.z, B.AIR);
    run(m, 1);
    expect(mode.chestAt(c.x, c.y, c.z)).toBeNull();
    expect(m.world.items.length).toBeGreaterThanOrEqual(n);
  });
});

describe('sky mode bots', () => {
  const play = (kit: 'bedwars' | 'skywars', a: TierId, b: TierId, seed: number) => {
    const s = new Spectate(kitById(kit), DIFFICULTIES[a], DIFFICULTIES[b], seed);
    for (let t = 0; t < 20 * 60 * 10 && !s.lastResult; t++) {
      s.tick();
      const m = s.match;
      m.world.events.length = 0;
      m.player.events.length = 0;
      m.bot.events.length = 0;
      m.mode?.takeAnnouncements();
    }
    return s.lastResult;
  };

  it('play a whole Bed Wars game: a bed goes and someone is finally killed', () => {
    const r = play('bedwars', 'ht3', 'ht3', 1);
    expect(r).not.toBeNull();
    expect(r!.timeout).toBe(false);
  }, 120000);

  it('play a whole SkyWars game to the last one standing', () => {
    const r = play('skywars', 'ht3', 'ht3', 1);
    expect(r).not.toBeNull();
    expect(r!.timeout).toBe(false);
  }, 120000);

  it('the stronger tier wins Bed Wars', () => {
    expect(play('bedwars', 'lt5', 'ht1', 2)?.winner).toBe('b');
    expect(play('bedwars', 'ht1', 'lt3', 2)?.winner).toBe('a');
  }, 240000);
});
