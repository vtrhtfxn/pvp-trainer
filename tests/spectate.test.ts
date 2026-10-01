import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { kitById } from '../src/game/kits';
import { Spectate, SPEC_ROUND_TICKS } from '../src/game/Spectate';

describe('Bot vs Bot', () => {
  it('plays round after round and keeps the score', () => {
    const s = new Spectate(kitById('sword'), DIFFICULTIES.lt1, DIFFICULTIES.ht1, 42);
    expect(s.match.player.name).toBe('LT1');
    expect(s.match.bot.name).toBe('HT1');
    let rounds = 0;
    for (let t = 0; t < 20 * 60 * 8 && rounds < 3; t++) {
      if (s.tick()) rounds++;
      for (const f of [s.match.player, s.match.bot]) f.events.length = 0;
      s.match.world.events.length = 0;
    }
    expect(rounds).toBe(3);
    expect(s.round).toBe(4);
    expect(s.score[0] + s.score[1]).toBe(3);
  });

  it('numbers two bots of the same tier, and a timeout goes to health', () => {
    const s = new Spectate(kitById('sword'), DIFFICULTIES.lt5, DIFFICULTIES.lt5, 1);
    expect([s.nameA, s.nameB]).toEqual(['LT5 (1)', 'LT5 (2)']);
    s.match.phase = 'fight';
    s.match.fightTicks = SPEC_ROUND_TICKS;
    s.match.bot.health = 3;
    s.tick();
    expect(s.lastResult).toEqual({ winner: 'a', timeout: true });
    expect(s.score).toEqual([1, 0]);
  });

  it('cycles cameras and clamps speed', () => {
    const s = new Spectate(kitById('axe'), DIFFICULTIES.ht3, DIFFICULTIES.lt2, 3);
    // Starts in the free camera; the cameras wrap around in both directions.
    expect(s.cam).toBe('free');
    s.cycleCam();
    expect(s.cam).toBe('orbit');
    s.cycleCam();
    expect(s.cam).toBe('followA');
    s.cycleCam(-1);
    s.cycleCam(-1);
    s.cycleCam(-1);
    expect(s.cam).toBe('povB');
    for (let i = 0; i < 10; i++) s.changeSpeed(1);
    expect(s.speed).toBe(4);
    for (let i = 0; i < 10; i++) s.changeSpeed(-1);
    expect(s.speed).toBe(0.25);
  });
});
