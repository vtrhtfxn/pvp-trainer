import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { kitById } from '../src/game/kits';
import { COUNTDOWN_TICKS, Match, PREP_TICKS } from '../src/game/Match';

describe('inventory time before a duel', () => {
  it('lasts 10 s, then the fight starts', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.practice, 1);
    m.countdownTicks = PREP_TICKS;
    expect(m.countdownSeconds).toBe(10);
    for (let i = 0; i < PREP_TICKS - 1; i++) m.tick();
    expect(m.phase).toBe('countdown');
    m.tick();
    expect(m.phase).toBe('fight');
  });

  it('Ready skips to the 3-2-1', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.practice, 1);
    m.countdownTicks = PREP_TICKS;
    m.tick();
    expect(m.preparing).toBe(true);
    m.act({ k: 'ready' });
    expect(m.preparing).toBe(false);
    expect(m.countdownSeconds).toBe(3);
    for (let i = 0; i < COUNTDOWN_TICKS; i++) m.tick();
    expect(m.phase).toBe('fight');
  });

  it('lets you pick your hotbar slot before the fight', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.practice, 1);
    m.countdownTicks = PREP_TICKS;
    m.queueSlot(3);
    m.tick();
    expect(m.player.selected).toBe(3);
  });
});
