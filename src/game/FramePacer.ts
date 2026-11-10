/**
 * Evens out frame times.
 *
 * The screen shows a new frame at a perfectly steady beat (every 16.7 ms at 60 Hz), but the time
 * the browser reports between frames wobbles by a millisecond or two around that. Moving the
 * camera and everyone on screen by those wobbly amounts makes steady motion look slightly jerky.
 * So when a frame's time is close to a whole number of screen refreshes, it is counted as exactly
 * that many. The small difference is paid back a little every frame, so the game clock never
 * drifts from real time. A real hitch (a time that fits no beat) is passed through untouched.
 */
export class FramePacer {
  private readonly recent: number[] = [];
  private sorted: number[] = [];
  /** The screen's refresh period as measured, in seconds (0: not known yet). */
  private period = 0;
  private sinceEstimate = 0;
  /** Real time not yet handed out (or handed out early), in seconds. */
  private drift = 0;

  /** `raw`: seconds since the last frame. `capped`: a frame-rate cap is on (frames skip beats unevenly: no snapping). */
  step(raw: number, capped: boolean): number {
    if (capped || raw <= 0) {
      this.drift = 0;
      return raw;
    }
    this.recent.push(raw);
    if (this.recent.length > 40) this.recent.shift();
    if (++this.sinceEstimate >= 10 && this.recent.length >= 20) {
      this.sinceEstimate = 0;
      // The usual frame time: the middle one, so the odd slow frame doesn't pull it up.
      this.sorted = [...this.recent].sort((x, y) => x - y);
      const p = this.sorted[Math.floor(this.sorted.length / 2)];
      // Only screens from 48 to 300 Hz, and only once most frames are steady around it.
      const steady = this.sorted[Math.floor(this.sorted.length * 0.8)] < p * 1.15;
      // (Eased toward the new measurement, so the beat itself never jumps.)
      this.period = steady && p > 1 / 300 && p < 1 / 48 ? (this.period ? this.period + (p - this.period) * 0.2 : p) : 0;
    }
    const period = this.period;
    if (!period) {
      this.drift = 0;
      return raw;
    }
    const beats = Math.round(raw / period);
    if (beats < 1 || beats > 3 || Math.abs(raw - beats * period) > period * 0.2) {
      this.drift = 0;
      return raw;
    }
    const even = beats * period;
    this.drift += raw - even;
    // Pay a tenth of what is owed each frame: no visible step, and no drift.
    const pay = this.drift * 0.1;
    this.drift -= pay;
    return Math.max(0, even + pay);
  }
}
