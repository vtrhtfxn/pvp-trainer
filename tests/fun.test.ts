import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADVANCEMENTS,
  GAUNTLET_LIVES,
  GAUNTLET_TIERS,
  KILL_EFFECTS,
  earnAdvancements,
  effectUnlocked,
  gauntletRound,
  gauntletTier,
  loadAdvancements,
  loadGauntletBest,
  loadKillEffect,
  newGauntlet,
  rewardsOf,
  saveGauntletBest,
  saveKillEffect,
  type AdvEvent,
} from '../src/game/fun';
import { DIFFICULTY_ORDER } from '../src/ai/difficulty';
import { Fighter } from '../src/game/Fighter';
import { World } from '../src/game/World';

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});
afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

const stats = () => new Fighter('player', 'P', new World(20)).stats;
const duel = (over: Partial<Extract<AdvEvent, { kind: 'duel' }>> = {}): AdvEvent => ({
  kind: 'duel',
  won: true,
  kit: 'sword',
  tier: 'lt5',
  stats: stats(),
  seconds: 40,
  health: 20,
  online: false,
  tierEarned: false,
  kitsWon: 1,
  ...over,
});

describe('Gauntlet', () => {
  it('climbs every tier, LT5 to HT1, and a win on the last one clears it', () => {
    expect(GAUNTLET_TIERS.every((t) => DIFFICULTY_ORDER.includes(t))).toBe(true);
    const g = newGauntlet('sword');
    for (let i = 0; i < GAUNTLET_TIERS.length - 1; i++) {
      expect(gauntletTier(g)).toBe(GAUNTLET_TIERS[i]);
      expect(gauntletRound(g, true)).toBe('next');
    }
    expect(gauntletTier(g)).toBe('ht1');
    expect(gauntletRound(g, true)).toBe('cleared');
    expect(g.cleared).toBe(GAUNTLET_TIERS.length);
  });

  it('a loss costs a life and you face the same tier again; out of lives ends it', () => {
    const g = newGauntlet('sword');
    gauntletRound(g, true);
    for (let i = 1; i < GAUNTLET_LIVES; i++) {
      expect(gauntletRound(g, false)).toBe('retry');
      expect(gauntletTier(g)).toBe('ht5');
    }
    expect(gauntletRound(g, false)).toBe('over');
    expect(g.cleared).toBe(1);
  });

  it('keeps the best run per kit', () => {
    expect(saveGauntletBest('sword', 3)).toBe(true);
    expect(saveGauntletBest('sword', 2)).toBe(false);
    expect(saveGauntletBest('axe', 1)).toBe(true);
    expect(loadGauntletBest()).toEqual({ sword: 3, axe: 1 });
  });
});

describe('Advancements', () => {
  it('a plain win earns First Blood once; a flawless fast clutch-free win earns more', () => {
    const have = loadAdvancements();
    const hurt = stats();
    hurt.damageTaken = 6;
    expect(earnAdvancements(duel({ stats: hurt }), have).map((a) => a.id)).toEqual(['first_blood']);
    expect(earnAdvancements(duel({ stats: hurt }), have)).toEqual([]);
    const s = stats();
    s.maxCombo = 10;
    s.crits = 8;
    const got = earnAdvancements(duel({ stats: s, seconds: 12, tier: 'ht1' }), have).map((a) => a.id);
    expect(got).toEqual(expect.arrayContaining(['combo5', 'combo10', 'crits', 'speedrun', 'flawless', 'ht3', 'ht1']));
    expect(got).not.toContain('clutch');
    expect(loadAdvancements()).toEqual(have);
  });

  it('losses earn nothing win-based; practice bots don\'t count for speed or flawless', () => {
    const have = new Set<string>();
    expect(earnAdvancements(duel({ won: false, tier: 'ht1' }), have)).toEqual([]);
    const got = earnAdvancements(duel({ tier: 'practice', seconds: 5 }), have).map((a) => a.id);
    expect(got).toEqual(['first_blood']);
  });

  it('drills, Gauntlet runs, online wins and kit variety each have theirs', () => {
    const have = new Set<string>();
    expect(earnAdvancements({ kind: 'drills', passed: 5, total: 21 }, have).map((a) => a.id)).toEqual(['student']);
    expect(earnAdvancements({ kind: 'gauntlet', cleared: 10, total: 10 }, have).map((a) => a.id)).toEqual(['gauntlet3', 'gauntlet10']);
    expect(earnAdvancements(duel({ online: true, kitsWon: 5, health: 3 }), have).map((a) => a.id)).toEqual(
      expect.arrayContaining(['online', 'allrounder', 'clutch']),
    );
  });
});

describe('Kill effects', () => {
  it('each locked one names a real advancement, and "none" is always yours', () => {
    for (const e of KILL_EFFECTS) if (e.unlock) expect(ADVANCEMENTS.some((a) => a.id === e.unlock)).toBe(true);
    expect(effectUnlocked(KILL_EFFECTS[0], new Set())).toBe(true);
    expect(rewardsOf('first_blood').map((e) => e.id)).toEqual(['lightning']);
  });

  it('a saved effect only loads while it is unlocked', () => {
    saveKillEffect('lightning');
    expect(loadKillEffect(new Set())).toBe('none');
    expect(loadKillEffect(new Set(['first_blood']))).toBe('lightning');
  });
});
