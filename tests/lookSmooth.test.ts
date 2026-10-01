import { describe, expect, it } from 'vitest';
import { LookSmoother } from '../src/render/lookSmooth';

/** A bot that snaps its aim by `snap` radians every tick, drawn at `fps` frames per second. */
function frames(snap: number, fps: number, seconds: number, smooth: boolean) {
  const sm = new LookSmoother();
  const who = {};
  const out: number[] = [];
  let yaw = 0;
  let prev = 0;
  let acc = 0;
  const dt = 1 / fps;
  for (let t = 0; t < seconds; t += dt) {
    acc += dt;
    while (acc >= 0.05) {
      acc -= 0.05;
      prev = yaw;
      yaw += snap;
    }
    const a = acc / 0.05;
    if (smooth) {
      sm.update(who, prev, yaw, 0, 0, a, dt);
      out.push(sm.yaw);
    } else out.push(yaw);
  }
  // Angles wrap at ±π; measure the shortest way between frames.
  return out.slice(1).map((v, i) => Math.abs(Math.atan2(Math.sin(v - out[i]), Math.cos(v - out[i]))));
}

describe('bot-eye camera smoothing', () => {
  it('turns steps of 0.6 rad per tick into small per-frame moves', () => {
    const raw = frames(0.6, 144, 2, false);
    const smooth = frames(0.6, 144, 2, true);
    // Raw: a 0.6 rad jump every 7th frame and nothing between.
    expect(Math.max(...raw)).toBeCloseTo(0.6, 3);
    expect(raw.filter((d) => d === 0).length).toBeGreaterThan(raw.length / 2);
    // Smoothed: never more than a small fraction of the step, and it never freezes.
    expect(Math.max(...smooth)).toBeLessThan(0.12);
    expect(Math.min(...smooth.slice(30))).toBeGreaterThan(0);
  });

  it('keeps up with the bot (no growing lag) and takes the short way round ±π', () => {
    const sm = new LookSmoother();
    const who = {};
    let yaw = 3.0;
    let prev = 3.0;
    for (let i = 0; i < 200; i++) {
      prev = yaw;
      yaw = ((yaw + 0.1 + Math.PI) % (2 * Math.PI)) - Math.PI;
      for (let f = 0; f < 4; f++) sm.update(who, prev, yaw, 0, 0, (f + 1) / 4, 0.0125);
    }
    let d = Math.abs(sm.yaw - yaw);
    if (d > Math.PI) d = 2 * Math.PI - d;
    expect(d).toBeLessThan(0.25);
  });

  it('starts from the new fighter instead of gliding over from the old one', () => {
    const sm = new LookSmoother();
    sm.update({}, 0, 0, 0, 0, 1, 0.016);
    sm.update({}, 2, 2, 0.3, 0.3, 1, 0.016);
    expect(sm.yaw).toBeCloseTo(2, 5);
    expect(sm.pitch).toBeCloseTo(0.3, 5);
  });
});
