import { describe, expect, it } from 'vitest';
import { awardTier, clampFirstTo, newSeries, scoreRound, TIER_POINTS, totalPoints, type MyTiers } from '../src/game/series';

describe('first to N', () => {
  it('plays rounds until one side reaches N', () => {
    const s = newSeries('sword', 'lt3', 3);
    expect(scoreRound(s, true, false)).toBeNull();
    expect(scoreRound(s, false, false)).toBeNull();
    expect(scoreRound(s, true, false)).toBeNull();
    expect(scoreRound(s, false, false)).toBeNull();
    expect(scoreRound(s, true, false)).toBe('you');
    expect([s.you, s.bot]).toEqual([3, 2]);
    const b = newSeries('axe', 'ht1', 2);
    scoreRound(b, false, false);
    expect(scoreRound(b, false, false)).toBe('bot');
  });

  it('FT1 is a single duel, and the target is kept between 1 and 20', () => {
    expect(scoreRound(newSeries('sword', 'lt5', 1), true, false)).toBe('you');
    expect(clampFirstTo(0)).toBe(1);
    expect(clampFirstTo(99)).toBe(20);
    expect(clampFirstTo(Number.NaN)).toBe(1);
  });

  it('remembers a round changed by commands', () => {
    const s = newSeries('sword', 'lt3', 2);
    scoreRound(s, true, true);
    scoreRound(s, true, false);
    expect(s.modified).toBe(true);
  });
});

describe('My Tiers', () => {
  it('uses the points table', () => {
    expect(TIER_POINTS).toEqual({ lt5: 1, ht5: 2, lt4: 3, ht4: 4, lt3: 6, ht3: 10, lt2: 20, ht2: 30, lt1: 45, ht1: 60 });
  });

  it('keeps the best tier per kit and adds up the points over kits', () => {
    const t: MyTiers = {};
    expect(awardTier(t, 'sword', 'lt4')).toBe(true);
    expect(awardTier(t, 'sword', 'lt5')).toBe(false); // lower: no change
    expect(t.sword).toBe('lt4');
    expect(awardTier(t, 'sword', 'ht3')).toBe(true);
    expect(awardTier(t, 'neth_pot', 'lt5')).toBe(true);
    expect(awardTier(t, 'axe', 'practice')).toBe(false); // Practice is no tier
    expect(totalPoints(t)).toBe(10 + 1);
  });
});
