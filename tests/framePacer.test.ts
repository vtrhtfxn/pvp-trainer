import { describe, expect, it } from 'vitest';
import { FramePacer } from '../src/game/FramePacer';

/** A deterministic wobble in [-1, 1]. */
const wobble = (i: number) => Math.sin(i * 12.9898) * Math.cos(i * 4.1414);

describe('frame pacing', () => {
  it('turns wobbly 60 Hz frame times into steady ones without drifting from real time', () => {
    const p = new FramePacer();
    const period = 1 / 60;
    let real = 0;
    let game = 0;
    const late: number[] = [];
    for (let i = 0; i < 1200; i++) {
      const raw = period + wobble(i) * 0.0015;
      const dt = p.step(raw, false);
      real += raw;
      game += dt;
      if (i >= 600) late.push(dt);
    }
    // Once settled, frames differ by far less than the 1.5 ms wobble that came in.
    const spread = Math.max(...late) - Math.min(...late);
    expect(spread).toBeLessThan(0.0004);
    // The game clock is still real time (within a couple of milliseconds after 20 seconds).
    expect(Math.abs(real - game)).toBeLessThan(0.003);
  });

  it('a dropped frame counts as exactly two beats; a real hitch passes through', () => {
    const p = new FramePacer();
    const period = 1 / 120;
    for (let i = 0; i < 100; i++) p.step(period + wobble(i) * 0.0004, false);
    expect(p.step(period * 2 + 0.0003, false)).toBeCloseTo(period * 2, 3);
    expect(p.step(0.071, false)).toBe(0.071);
  });

  it('leaves frame times alone under a frame-rate cap or when frames are unsteady', () => {
    const p = new FramePacer();
    for (let i = 0; i < 100; i++) expect(p.step(1 / 60 + wobble(i) * 0.001, true)).toBe(1 / 60 + wobble(i) * 0.001);
    const q = new FramePacer();
    for (let i = 0; i < 200; i++) {
      const raw = 0.02 + Math.abs(wobble(i)) * 0.03;
      expect(q.step(raw, false)).toBe(raw);
    }
  });
});
