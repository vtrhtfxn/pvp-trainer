import { describe, expect, it } from 'vitest';
import { NET, simulateHitreg } from './hitregsim';

/**
 * A perfect player clicks whenever the opponent is under the crosshair on their own screen with
 * a full cooldown, over a simulated internet link. Every one of those hits must land, and the
 * attacker must see it land about one round trip later.
 */
describe('hit registration over the internet', () => {
  for (const [name, net, rtt, slack] of [
    ['same city (~20 ms round trip)', NET.near, 20, 15],
    ['across a country (~60 ms round trip, Wi-Fi jitter)', NET.far, 60, 25],
  ] as const) {
    it(`${name}: every on-screen hit lands, seen about one round trip later`, () => {
      for (const seed of [1, 2, 3]) {
        const r = simulateHitreg({ seconds: 30, seed, ...net, fps: [144, 144] });
        const info = JSON.stringify(r);
        expect(r.claims, info).toBeGreaterThan(25);
        expect(r.rate, info).toBe(1);
        // No double swings into the opponent's hurt immunity (the cooldown bar used to refill
        // from the server's stale copy right after every click).
        expect(r.wasted, info).toBe(0);
        // Click → hit on screen: the round trip, the link's jitter and a frame or two.
        expect(r.feedbackP50, info).toBeLessThanOrEqual(rtt + slack);
      }
    }, 60000);
  }

  it('the old way (swings only on the server tick) is slower to show the hit', () => {
    const now = simulateHitreg({ seconds: 30, seed: 1, ...NET.far, fps: [144, 144] });
    const tick = simulateHitreg({ seconds: 30, seed: 1, ...NET.far, fps: [144, 144], immediate: false });
    expect(now.feedbackP50).toBeLessThan(tick.feedbackP50 - 15);
  }, 60000);
});
