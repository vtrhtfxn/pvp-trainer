import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { B } from '../src/game/Blocks';
import { Match } from '../src/game/Match';
import { performAttack } from '../src/game/combat';
import { kitById, type KitId } from '../src/game/kits';
import { HotPotato } from '../src/game/modes/HotPotato';
import { Whodunit } from '../src/game/modes/Whodunit';

/** A party game with a bot playing your side too. */
function play(kit: KitId, seed: number, maxTicks = 20 * 60 * 6, each?: (m: Match) => void, players?: number) {
  const m = new Match(kitById(kit), DIFFICULTIES.ht3, seed, undefined, players);
  m.externalMining = true;
  const pb: BotBrain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.ht3, new Rng(seed + 99), () => performAttack(m.player, pb.opponent));
  pb.attachSky(m);
  pb.resetRound();
  const said: string[] = [];
  while (m.phase !== 'ended' && m.tickCount < maxTicks) {
    if (m.phase === 'fight') {
      pb.chooseTarget(m.enemiesOf(m.player));
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    each?.(m);
    for (const f of m.fighters) f.events.length = 0;
    m.world.events.length = 0;
    for (const a of m.mode!.takeAnnouncements()) said.push(a.text);
  }
  return { m, said };
}

describe('party minigames', () => {
  it('any number of players within the game\'s limits, every one for themselves', () => {
    for (const [kit, usual, min, max] of [
      ['sumo', 2, 2, 8],
      ['crumble', 6, 2, 12],
      ['hotpotato', 6, 3, 12],
      ['whodunit', 8, 3, 15],
    ] as [KitId, number, number, number][]) {
      const m = new Match(kitById(kit), DIFFICULTIES.lt3, 1);
      expect(m.fighters, kit).toHaveLength(usual);
      expect(new Set(m.fighters.map((f) => f.team)).size).toBe(usual);
      expect(new Match(kitById(kit), DIFFICULTIES.lt3, 1, undefined, 1).fighters).toHaveLength(min);
      const big = new Match(kitById(kit), DIFFICULTIES.lt3, 1, undefined, 99);
      expect(big.fighters).toHaveLength(max);
      // Everyone starts on solid ground, apart from each other.
      for (const f of big.fighters) expect(big.world.blocks.get(Math.floor(f.pos.x), Math.floor(f.pos.y) - 1, Math.floor(f.pos.z)), `${kit} ${f.name}`).not.toBe(B.AIR);
    }
  });

  it('every game ends with a winner, the bots playing all sides', () => {
    for (const [kit, players] of [
      ['sumo', 2],
      ['sumo', 8],
      ['crumble', 6],
      ['crumble', 12],
      ['hotpotato', 3],
      ['hotpotato', 8],
      ['whodunit', 4],
      ['whodunit', 15],
    ] as [KitId, number][]) {
      const { m } = play(kit, players + 1, 20 * 60 * 8, undefined, players);
      expect(m.phase, `${kit} ${players}`).toBe('ended');
      expect(m.winner, `${kit} ${players}`).not.toBeNull();
    }
  }, 600_000);

  it('Crumble: the TNT drops away under you', () => {
    const m = new Match(kitById('crumble'), DIFFICULTIES.lt3, 2);
    m.botDriver = () => {};
    while (m.phase !== 'fight') m.tick();
    const p = m.player;
    const x = Math.floor(p.pos.x);
    const z = Math.floor(p.pos.z);
    expect(m.world.blocks.get(x, -1, z)).toBe(B.TNT);
    for (let t = 0; t < 20; t++) m.tick();
    expect(m.world.blocks.get(x, -1, z)).toBe(B.AIR);
    // Standing still, you fall to the floor below.
    for (let t = 0; t < 30; t++) m.tick();
    expect(p.pos.y).toBeLessThan(-3);
  });

  it('Hot Potato: a hit passes the TNT on, and the fuse blows the holder up', () => {
    const { said } = play('hotpotato', 3);
    expect(said.some((s) => / is IT!$| are IT!$/.test(s))).toBe(true);
    expect(said.some((s) => s.startsWith('BOOM!'))).toBe(true);
    const m = new Match(kitById('hotpotato'), DIFFICULTIES.lt3, 4);
    expect((m.mode as HotPotato).it).toBeNull();
  }, 120_000);

  it('Whodunit: one murderer, one detective, the rest innocent; the murderer sword kills in one hit', () => {
    const m = new Match(kitById('whodunit'), DIFFICULTIES.lt3, 5, undefined, 4);
    m.botDriver = () => {};
    const mode = m.mode as Whodunit;
    const roles = m.fighters.map((f) => mode.role(f)).sort();
    expect(roles).toEqual(['detective', 'innocent', 'innocent', 'murderer']);
    while (m.phase !== 'fight') m.tick();
    const murderer = m.fighters.find((f) => mode.role(f) === 'murderer')!;
    const victim = m.fighters.find((f) => mode.role(f) === 'innocent')!;
    expect(murderer.countItem('iron_sword')).toBe(1);
    // Put them face to face and swing.
    for (let t = 0; t < 30; t++) m.tick();
    // (A bot murderer keeps its sword away until it strikes: draw it now.)
    murderer.selectSlot(murderer.inventory.findIndex((s) => s?.id === 'iron_sword'));
    victim.pos.set(murderer.pos.x, murderer.pos.y, murderer.pos.z - 2);
    murderer.yaw = 0;
    murderer.pitch = 0;
    expect(performAttack(murderer, victim).hit).toBe(true);
    // The mode judges the hit on the tick it lands (the bot puts its sword away again after).
    mode.tick(m);
    expect(victim.dead).toBe(true);
    // A punch from anyone else does nothing.
    const a = m.fighters.find((f) => !f.dead && f !== murderer && f !== victim)!;
    const b = m.fighters.find((f) => !f.dead && f !== murderer && f !== victim && f !== a)!;
    a.selectSlot(a.inventory.findIndex((s) => !s));
    for (let t = 0; t < 30; t++) m.tick();
    b.pos.set(a.pos.x, a.pos.y, a.pos.z - 2);
    a.yaw = 0;
    a.pitch = 0;
    expect(performAttack(a, b).hit).toBe(true);
    mode.tick(m);
    expect(b.dead).toBe(false);
    expect(b.health).toBe(b.maxHealth);
  });
});
