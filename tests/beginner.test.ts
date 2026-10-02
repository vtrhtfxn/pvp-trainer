import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BEGINNER_STEPS, beginnerHidden, beginnerProgress, setBeginnerHidden } from '../src/ui/beginner';
import { DRILLS } from '../src/trainer/drills';
import { DIFFICULTY_ORDER } from '../src/ai/difficulty';

function fakeStorage() {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  return store;
}

describe('Getting started path', () => {
  beforeEach(fakeStorage);
  afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  it('only names drills and tiers that exist', () => {
    for (const s of BEGINNER_STEPS) {
      if (s.drill) expect(DRILLS.some((d) => d.id === s.drill)).toBe(true);
      if (s.duel) expect(DIFFICULTY_ORDER).toContain(s.duel.tier);
      expect(!!s.drill !== !!s.duel).toBe(true);
    }
  });

  it('moves on as drills are passed and duels are played', () => {
    expect(beginnerProgress({}, {})).toEqual({ done: 0, next: BEGINNER_STEPS[0] });
    const drills = { cooldown: { passed: true, best: 100 }, wtap: { passed: true, best: 100 }, crit: { passed: false, best: 40 } };
    expect(beginnerProgress(drills, {}).next?.id).toBe('crit');
    drills.crit.passed = true;
    expect(beginnerProgress(drills, {}).next?.id).toBe('first-duel');
    // A lost practice duel still counts as playing one; LT5 needs a win.
    const records = { 'sword:practice': { wins: 0, losses: 1, bestCombo: 1 }, 'sword:lt5': { wins: 0, losses: 2, bestCombo: 3 } };
    const all = { ...drills, spacing: { passed: true, best: 100 } };
    expect(beginnerProgress(all, records)).toEqual({ done: 5, next: BEGINNER_STEPS[5] });
    records['sword:lt5'].wins = 1;
    expect(beginnerProgress(all, records)).toEqual({ done: 6, next: null });
  });

  it('remembers being hidden', () => {
    expect(beginnerHidden()).toBe(false);
    setBeginnerHidden(true);
    expect(beginnerHidden()).toBe(true);
    setBeginnerHidden(false);
    expect(beginnerHidden()).toBe(false);
  });
});
