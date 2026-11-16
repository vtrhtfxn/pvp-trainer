import { lerp, lerpAngle, wrapAngle } from '../core/math';

/** Time constant (s) of the low-pass over a followed bot's look. */
const TAU = 0.045;

/**
 * The eyes of a bot you spectate. A bot turns once per tick (20 per second) but you draw many more
 * frames, so its raw angles move in steps: tens of degrees, then nothing for a few frames. This
 * eases from the previous tick's angle to the current one, then a short low-pass takes the
 * corners off, so the view glides.
 */
export class LookSmoother {
  private who: object | null = null;
  yaw = 0;
  pitch = 0;

  /** `a` is how far into the tick the frame is (0..1), `dt` the frame time in seconds. */
  update(who: object, prevYaw: number, yaw: number, prevPitch: number, pitch: number, a: number, dt: number, tau = TAU) {
    const ty = lerpAngle(prevYaw, yaw, a);
    const tp = lerp(prevPitch, pitch, a);
    if (this.who !== who) {
      this.who = who;
      this.yaw = ty;
      this.pitch = tp;
      return;
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / tau);
    this.yaw = wrapAngle(this.yaw + wrapAngle(ty - this.yaw) * k);
    this.pitch += (tp - this.pitch) * k;
  }

  /** Back to following nobody (the next fighter starts from where it looks, not from a glide). */
  reset() {
    this.who = null;
  }
}

/**
 * The value between p1 (t = 0) and p2 (t = 1) on a smooth curve through four samples in a row
 * (Fritsch–Carlson monotone cubic): it passes through every sample, its speed never jumps at a
 * sample, and it never swings past one — a flick that stops dead stops dead.
 */
export function monotoneCubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const s0 = p1 - p0;
  const s1 = p2 - p1;
  const s2 = p3 - p2;
  if (s1 === 0) return p1;
  const tangent = (a: number, b: number) => (a * b <= 0 ? 0 : Math.sign(b) * Math.min((Math.abs(a) + Math.abs(b)) / 2, 3 * Math.min(Math.abs(a), Math.abs(b))));
  const m1 = tangent(s0, s1);
  const m2 = tangent(s1, s2);
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1 + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}
