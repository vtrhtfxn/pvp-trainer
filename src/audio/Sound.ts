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

  /** entity.player.attack.sweep: a longer, airy whoosh. */
  sweep(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.6);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.22, 'bandpass', 600, 2600, 1.1, 0.45);
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

  /** Wooden thunk of a hit landing on a raised shield. */
  shieldBlock(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.9);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.09, 'lowpass', 700, 180, 1.2, 0.9);
    this.tone(d, t, 0.12, 'triangle', 150, 70, 0.6);
  }

  /** The crack of an axe disabling a shield. */
  shieldBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.22, 'bandpass', 1800, 300, 0.8, 1);
    this.noiseBurst(d, t + 0.04, 0.14, 'lowpass', 600, 150, 1, 0.7);
    this.tone(d, t, 0.2, 'sawtooth', 220, 60, 0.25);
  }

  shieldRaise(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.35);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.06, 'bandpass', 500, 900, 1.5, 0.3);
  }

  bowShoot(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 0.12, 'triangle', 420 + power * 200, 180, 0.35);
    this.noiseBurst(d, t, 0.18, 'bandpass', 2500, 700, 1.2, 0.4);
  }

  crossbowLoad(pos: { x: number; y: number; z: number }, done: boolean) {
    const d = this.out(pos, 0.6);
    if (!d) return;
    const t = this.ctx!.currentTime;
    if (done) {
      this.noiseBurst(d, t, 0.05, 'highpass', 3000, 2000, 1, 0.5);
      this.tone(d, t, 0.06, 'square', 900, 700, 0.12);
    } else this.noiseBurst(d, t, 0.25, 'bandpass', 600, 1500, 2, 0.25);
  }

  arrowHit(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.9);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.07, 'bandpass', 2200, 900, 1.5, 0.7);
    this.tone(d, t, 0.06, 'sine', 900, 500, 0.25);
  }

  /** The little "ding" when you hit someone with an arrow (vanilla's arrow hit-player sound). */
  arrowDing() {
    const d = this.out(undefined, 0.45);
    if (d) this.tone(d, this.ctx!.currentTime, 0.16, 'sine', 1250, 1240, 0.3);
  }

  pickup(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.4);
    if (d) this.tone(d, this.ctx!.currentTime, 0.07, 'sine', 1400 + Math.random() * 400, 1800, 0.2);
  }

  /** Throwing a splash potion or XP bottle (entity.splash_potion.throw). */
  throwItem(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.14, 'bandpass', 900, 2400, 1.2, 0.35);
  }

  /** Glass breaking (entity.splash_potion.break). */
  glassBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.18, 'highpass', 5000, 2500, 0.8, 0.7);
    for (let i = 0; i < 3; i++) this.tone(d, t + i * 0.025, 0.07, 'sine', 2600 + Math.random() * 1800, 2000, 0.12);
  }

  /** item.totem.use: a rising magical whoosh. */
  totem(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.9, 'bandpass', 400, 3200, 2, 0.5);
    this.tone(d, t, 0.6, 'triangle', 330, 990, 0.3);
    this.tone(d, t + 0.1, 0.6, 'sine', 495, 1480, 0.2);
  }

  /** entity.experience_orb.pickup: a high random chime. */
  xp(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.25);
    if (d) this.tone(d, this.ctx!.currentTime, 0.09, 'sine', 1600 + Math.random() * 1200, 2400, 0.18);
  }

  /** entity.item.break */
  itemBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.2, 'bandpass', 1200, 400, 1, 0.8);
    this.tone(d, t, 0.15, 'square', 300, 120, 0.15);
  }

  /** Burning damage tick (entity.player.hurt_on_fire). */
  sizzle(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.25, 'highpass', 3000, 1500, 0.7, 0.45);
  }

  /** Placing or breaking a block: wood thunks, stone clacks, webs rustle. */
  block(pos: { x: number; y: number; z: number }, kind: 'wood' | 'stone' | 'web', broke: boolean) {
    const d = this.out(pos, broke ? 0.8 : 0.6);
    if (!d) return;
    const t = this.ctx!.currentTime;
    if (kind === 'web') this.noiseBurst(d, t, 0.12, 'highpass', 4000, 2500, 0.7, 0.35);
    else if (kind === 'wood') {
      this.noiseBurst(d, t, broke ? 0.16 : 0.1, 'lowpass', 900, 300, 1.4, 0.8);
      this.tone(d, t, 0.08, 'triangle', 190, 120, 0.25);
    } else {
      this.noiseBurst(d, t, broke ? 0.14 : 0.09, 'bandpass', 1800, 700, 1.2, 0.8);
    }
  }

  /** A mining tick (the quiet hit sound while digging). */
  dig(pos: { x: number; y: number; z: number }, kind: 'wood' | 'stone' | 'web') {
    const d = this.out(pos, 0.25);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.05, kind === 'wood' ? 'lowpass' : 'bandpass', kind === 'wood' ? 700 : 1600, 400, 1, 0.5);
  }

  bucket(pos: { x: number; y: number; z: number }, lava: boolean, fill: boolean) {
    const d = this.out(pos, 0.6);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, lava ? 0.4 : 0.3, 'lowpass', fill ? 600 : 1500, fill ? 1500 : 400, 1, lava ? 0.5 : 0.7);
    if (lava) this.tone(d, t, 0.3, 'sine', 90, 60, 0.3);
  }

  /** Lava meeting water (block.lava.extinguish). */
  fizz(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.45, 'highpass', 5000, 2000, 0.6, 0.6);
  }

  /** entity.generic.explode: a deep boom with a noisy tail (louder and longer for bigger blasts). */
  /** entity.wind_charge.wind_burst: a hollow airy thump. */
  windBurst(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.35 + power * 0.05, 'bandpass', 250, 1400, 0.9, 0.8);
    this.tone(d, t, 0.18, 'sine', 140, 60, 0.5);
  }

  /** item.mace.smash_air / smash_ground(_heavy). */
  smash(pos: { x: number; y: number; z: number }, heavy: boolean) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, heavy ? 0.4 : 0.25, 'triangle', heavy ? 110 : 160, 35, heavy ? 1 : 0.7);
    this.noiseBurst(d, t, heavy ? 0.3 : 0.18, 'lowpass', 900, 200, 1, heavy ? 1 : 0.6);
  }

  /** item.armor.equip_netherite / equip_elytra. */
  equipArmor(pos: { x: number; y: number; z: number }, elytra: boolean) {
    const d = this.out(pos, 0.5);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, elytra ? 0.2 : 0.12, 'bandpass', elytra ? 900 : 500, elytra ? 2400 : 300, 1, 0.4);
  }

  explosion(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 1.4);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.9 + power * 0.08, 'lowpass', 900, 60, 0.9, 1);
    this.tone(d, t, 0.6, 'sine', 70, 30, 0.9);
    this.noiseBurst(d, t + 0.02, 0.35, 'bandpass', 2400, 400, 0.7, 0.5);
  }

  /** Placing an end crystal: a glassy chime. */
  crystalPlace(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 0.25, 'sine', 1500, 1900, 0.18);
    this.tone(d, t + 0.03, 0.2, 'triangle', 2250, 2600, 0.1);
  }

  /** block.respawn_anchor.charge: a rising hum. */
  anchorCharge(pos: { x: number; y: number; z: number }, charge: number) {
    const d = this.out(pos, 0.6);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 0.35, 'sawtooth', 110 + charge * 40, 220 + charge * 60, 0.15);
    this.noiseBurst(d, t, 0.3, 'bandpass', 500, 1400, 2, 0.3);
  }

  /** Ender pearl throw / teleport: a portal whoosh. */
  pearl(pos: { x: number; y: number; z: number }, land: boolean) {
    const d = this.out(pos, land ? 0.8 : 0.4);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, land ? 0.45 : 0.2, 'bandpass', land ? 300 : 1200, land ? 1600 : 600, 1.5, 0.5);
    if (land) this.tone(d, t, 0.4, 'sine', 180, 520, 0.2);
  }

  equip() {
    const d = this.out(undefined, 0.3);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.08, 'bandpass', 1200, 700, 1, 0.3);
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
