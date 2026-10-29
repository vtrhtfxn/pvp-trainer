import { describe, expect, it } from 'vitest';
import { focus, perKit, rates, streaks, trend, type DuelEntry } from '../src/game/history';

const duel = (o: Partial<DuelEntry>): DuelEntry => ({
  at: 0, kit: 'sword', tier: 'lt3', mode: 'bot', won: true, secs: 30, swings: 20, hits: 14, crits: 4, combo: 4, dealt: 20, taken: 12, reach: 2.8, ...o,
});

describe('duel history (Progress)', () => {
  it('sums rates and streaks', () => {
    const list = [duel({ won: false }), duel({}), duel({}), duel({ won: false }), duel({}), duel({})];
    const r = rates(list);
    expect(r.accuracy).toBeCloseTo(14 / 20);
    expect(r.critRate).toBeCloseTo(4 / 14);
    expect(r.winRate).toBeCloseTo(4 / 6);
    expect(streaks(list)).toEqual({ current: 2, best: 2 });
  });

  it('groups by kit, busiest first', () => {
    const k = perKit([duel({ kit: 'uhc' }), duel({ kit: 'sword' }), duel({ kit: 'sword', won: false })]);
    expect(k.map((x) => x.kit)).toEqual(['sword', 'uhc']);
    expect(k[0]).toMatchObject({ duels: 2, wins: 1 });
  });

  it('trends are rolling averages over the last duels', () => {
    const list = Array.from({ length: 40 }, (_, i) => duel({ hits: i < 20 ? 8 : 16 }));
    const t = trend(list, (r) => r.accuracy);
    expect(t).toHaveLength(30);
    expect(t[t.length - 1]).toBeCloseTo(0.8);
    expect(t[0]).toBeLessThan(t[t.length - 1]);
  });

  it('points at the weakest skill, with a drill for it', () => {
    expect(focus([duel({})])).toBeNull();
    const aimless = Array.from({ length: 5 }, () => duel({ swings: 40, hits: 10, crits: 3 }));
    expect(focus(aimless)).toMatchObject({ title: 'Aim', drill: 'aim' });
    const noCrits = Array.from({ length: 5 }, () => duel({ crits: 0 }));
    expect(focus(noCrits)).toMatchObject({ title: 'Crits', drill: 'crit' });
    const good = Array.from({ length: 5 }, () => duel({}));
    expect(focus(good)?.drill).toBeNull();
  });
});
