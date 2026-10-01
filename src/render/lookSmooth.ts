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
  update(who: object, prevYaw: number, yaw: number, prevPitch: number, pitch: number, a: number, dt: number) {
    const ty = lerpAngle(prevYaw, yaw, a);
    const tp = lerp(prevPitch, pitch, a);
    if (this.who !== who) {
      this.who = who;
      this.yaw = ty;
      this.pitch = tp;
      return;
    }
    const k = 1 - Math.exp(-Math.max(0, dt) / TAU);
    this.yaw = wrapAngle(this.yaw + wrapAngle(ty - this.yaw) * k);
    this.pitch += (tp - this.pitch) * k;
  }

  /** Back to following nobody (the next fighter starts from where it looks, not from a glide). */
  reset() {
    this.who = null;
  }
}
