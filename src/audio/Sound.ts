/** Small WebAudio synth for combat feedback (no copyrighted game audio). */

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** yaw of the listener (our convention: forward = (-sin, -cos)) */
  yaw: number;
}

export type HitKind = 'weak' | 'strong' | 'crit' | 'knockback';

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.8;
  listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };

  /** Must be called from a user gesture. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private out(pos?: { x: number; y: number; z: number }, gain = 1): AudioNode | null {
    if (!this.ctx || !this.master) return null;
    this.master.gain.value = this.volume;
    const g = this.ctx.createGain();
    let vol = gain;
    let pan = 0;
    if (pos) {
      const dx = pos.x - this.listener.x;
      const dz = pos.z - this.listener.z;
      const dist = Math.hypot(dx, pos.y - this.listener.y, dz);
      vol *= Math.max(0, 1 - dist / 16);
      if (dist > 0.01) {
        const rx = Math.cos(this.listener.yaw);
        const rz = -Math.sin(this.listener.yaw);
        pan = Math.max(-1, Math.min(1, ((dx * rx + dz * rz) / Math.max(dist, 1)) * 0.8));
      }
    }
    if (vol <= 0.001) return null;
    g.gain.value = vol;
    if (this.ctx.createStereoPanner) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      p.connect(this.master);
    } else g.connect(this.master);
    return g;
  }

  private noiseBurst(dest: AudioNode, t0: number, dur: number, type: BiquadFilterType, f0: number, f1: number, q: number, peak: number) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filt = ctx.createBiquadFilter();
    filt.type = type;
    filt.Q.value = q;
    filt.frequency.setValueAtTime(f0, t0);
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filt).connect(env).connect(dest);
    src.start(t0, Math.random() * 0.5, dur + 0.05);
  }

  private tone(dest: AudioNode, t0: number, dur: number, type: OscillatorType, f0: number, f1: number, peak: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(env).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  hit(kind: HitKind, pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    switch (kind) {
      case 'weak':
        this.noiseBurst(d, t, 0.06, 'lowpass', 900, 400, 0.7, 0.35);
        break;
      case 'strong':
        this.noiseBurst(d, t, 0.09, 'bandpass', 1500, 500, 0.9, 0.9);
        this.tone(d, t, 0.1, 'sine', 170, 55, 0.7);
        break;
      case 'knockback':
        this.noiseBurst(d, t, 0.16, 'bandpass', 500, 2400, 1.2, 0.6);
        this.noiseBurst(d, t, 0.08, 'bandpass', 1400, 500, 0.9, 0.75);
        this.tone(d, t, 0.11, 'sine', 160, 50, 0.7);
        break;
      case 'crit':
        this.noiseBurst(d, t, 0.11, 'highpass', 2600, 1200, 0.8, 0.9);
        this.tone(d, t, 0.05, 'square', 1900, 700, 0.18);
        this.tone(d, t, 0.1, 'sine', 190, 60, 0.6);
        break;
    }
  }

  hurt(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.75 : 0.9);
    if (!d) return;
    const t = this.ctx!.currentTime;
    const base = self ? 210 : 240 + Math.random() * 30;
    this.tone(d, t, 0.16, 'triangle', base, base * 0.62, 0.55);
    this.tone(d, t + 0.005, 0.12, 'sawtooth', base * 1.5, base * 0.8, 0.08);
  }

  swing(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.13, 'bandpass', 380, 1300, 1.4, 0.35);
  }

  eat(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7);
    if (!d) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 3; i++) {
      const f = 900 + Math.random() * 1600;
      this.noiseBurst(d, t + i * 0.035, 0.035, 'bandpass', f, f * 0.7, 2.5, 0.6);
    }
  }

  burp(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7);
    if (!d) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(115, t);
    o.frequency.linearRampToValueAtTime(92, t + 0.28);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 28;
    const lg = ctx.createGain();
    lg.gain.value = 9;
    lfo.connect(lg).connect(o.frequency);
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 700;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.4, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(filt).connect(env).connect(d);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.35);
    lfo.stop(t + 0.35);
  }

  step(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.18 : 0.25);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.07, 'lowpass', 700, 250, 0.7, 0.5);
  }

  land(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.25 : 0.3);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.09, 'lowpass', 500, 150, 0.7, 0.6);
  }

  ui() {
    const d = this.out(undefined, 0.35);
    if (d) this.tone(d, this.ctx!.currentTime, 0.05, 'square', 1250, 900, 0.15);
  }

  countdown(final: boolean) {
    const d = this.out(undefined, 0.45);
    if (!d) return;
    const t = this.ctx!.currentTime;
    if (final) {
      this.tone(d, t, 0.18, 'square', 880, 880, 0.2);
      this.tone(d, t + 0.09, 0.3, 'square', 1320, 1320, 0.2);
    } else this.tone(d, t, 0.14, 'square', 587, 587, 0.2);
  }

  jingle(win: boolean) {
    const d = this.out(undefined, 0.45);
    if (!d) return;
    const t = this.ctx!.currentTime;
    const notes = win ? [523, 659, 784, 1047] : [440, 392, 330, 262];
    notes.forEach((f, i) => this.tone(d, t + i * 0.13, 0.22, 'square', f, f, 0.18));
  }
}
