import { PACK_SOUNDS, packSoundFiles, type PackSound } from './packSounds';
import critUrl from '../assets/sounds/crit.ogg?url';
import knockbackUrl from '../assets/sounds/knockback.ogg?url';
import sweepUrl from '../assets/sounds/sweep.ogg?url';
import totemUrl from '../assets/sounds/totem.ogg?url';
import smashUrl from '../assets/sounds/smash.ogg?url';
import smashGroundUrl from '../assets/sounds/smash_ground.ogg?url';
import crossbowShootUrl from '../assets/sounds/crossbow_shoot.ogg?url';
import shieldBlockUrl from '../assets/sounds/shield_block.ogg?url';
import explodeUrl from '../assets/sounds/explode.ogg?url';
import lungeUrl from '../assets/sounds/lunge.ogg?url';

/**
 * Small WebAudio synth for combat feedback, plus recorded samples for crits, knockback hits,
 * sweeps, totem pops, mace smashes and explosions (the synth stands in until they are decoded,
 * or if the browser can't decode Ogg).
 */

type SampleName = 'crit' | 'knockback' | 'sweep' | 'totem' | 'smash' | 'smashGround' | 'crossbowShoot' | 'shieldBlock' | 'explode' | 'lunge';

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** yaw of the listener (our convention: forward = (-sin, -cos)) */
  yaw: number;
}

export type HitKind = 'weak' | 'strong' | 'crit' | 'knockback';

/** Options → Sound sliders: players (hits, hurt, bows, blasts), footsteps, blocks & items, UI. */
export type SoundCategory = 'players' | 'steps' | 'blocks' | 'ui';

/** Sound Changer mod: the groups whose volume can be set on their own. */
export type SoundGroup = 'hits' | 'arrows' | 'explosions' | 'teleports' | 'shields' | 'eating' | 'totems' | 'items' | 'blocks' | 'steps';

/** Which group each sound belongs to (anything not listed is left alone). */
const GROUP_OF: Record<string, SoundGroup> = {
  hit: 'hits',
  hurt: 'hits',
  sweep: 'hits',
  swing: 'hits',
  smash: 'hits',
  lunge: 'hits',
  bowShoot: 'arrows',
  crossbowShoot: 'arrows',
  crossbowLoad: 'arrows',
  arrowHit: 'arrows',
  arrowDing: 'arrows',
  explosion: 'explosions',
  crystalPlace: 'explosions',
  anchorCharge: 'explosions',
  windBurst: 'explosions',
  lightning: 'explosions',
  thunder: 'explosions',
  firework: 'explosions',
  pearl: 'teleports',
  shieldBlock: 'shields',
  shieldBreak: 'shields',
  shieldRaise: 'shields',
  eat: 'eating',
  burp: 'eating',
  totem: 'totems',
  pickup: 'items',
  throwItem: 'items',
  glassBreak: 'items',
  xp: 'items',
  itemBreak: 'items',
  equipArmor: 'items',
  equip: 'items',
  bucket: 'items',
  fizz: 'items',
  sizzle: 'items',
  block: 'blocks',
  dig: 'blocks',
  step: 'steps',
  land: 'steps',
};

export class Sound {
  /** Sound Changer: each group's volume (1 = as normal). */
  readonly groups: Record<SoundGroup, number> = { hits: 1, arrows: 1, explosions: 1, teleports: 1, shields: 1, eating: 1, totems: 1, items: 1, blocks: 1, steps: 1 };
  /** The group of the sound being played right now (set around each sound method). */
  private group: SoundGroup | null = null;

  constructor() {
    // Every sound method runs with its group set, so out() can apply that group's volume.
    const self = this as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const [name, group] of Object.entries(GROUP_OF)) {
      const fn = self[name];
      if (typeof fn !== 'function') continue;
      self[name] = (...a: unknown[]) => {
        const was = this.group;
        this.group = group;
        try {
          return fn.apply(this, a);
        } finally {
          this.group = was;
        }
      };
    }
  }

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private readonly samples: Partial<Record<SampleName, AudioBuffer>> = {};
  /** A resource pack's sounds, decoded: every variant of each event. */
  private readonly packBufs: Partial<Record<PackSound, AudioBuffer[]>> = {};
  volume = 0.8;
  /** Silences new sounds (during /tick sprint, when thousands of ticks run per second). */
  muted = false;
  readonly categories: Record<SoundCategory, number> = { players: 1, steps: 1, blocks: 1, ui: 1 };
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
      this.loadSamples();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private out(pos?: { x: number; y: number; z: number }, gain = 1, cat: SoundCategory = 'players'): AudioNode | null {
    if (!this.ctx || !this.master || this.muted) return null;
    this.master.gain.value = this.volume;
    let vol = gain * this.categories[cat] * (this.group ? this.groups[this.group] : 1);
    if (vol <= 0.001) return null;
    const g = this.ctx.createGain();
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

  /** The active resource pack's sounds (read and decoded once audio may start). */
  private loadPackSounds() {
    const ctx = this.ctx!;
    const files = packSoundFiles();
    if (!files.size) return;
    for (const [event, keys] of Object.entries(PACK_SOUNDS) as [PackSound, readonly string[]][]) {
      for (const key of keys) {
        const f = files.get(key);
        if (!f) continue;
        f.read()
          .then((bytes) => ctx.decodeAudioData(bytes.slice().buffer))
          .then((buf) => (this.packBufs[event] ??= []).push(buf))
          .catch(() => {
            /* a file that won't decode: the game's own sound stays */
          });
      }
    }
  }

  /**
   * Plays one of the resource pack's variants for `event` (picked at random, like the game);
   * false when the pack has none, so the caller plays the game's own sound.
   */
  private pack(event: PackSound, dest: AudioNode, peak = 1, pitch = 1): boolean {
    const list = this.packBufs[event];
    if (!list?.length) return false;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = pitch;
    const g = ctx.createGain();
    g.gain.value = peak;
    src.connect(g).connect(dest);
    src.start();
    return true;
  }

  /** The game's usual random pitch for player sounds: 1 ± up to 0.2. */
  private static jitter(range = 0.2): number {
    return 1 + (Math.random() - Math.random()) * range;
  }

  private loadSamples() {
    this.loadPackSounds();
    const ctx = this.ctx!;
    const list = [
      ['crit', critUrl],
      ['knockback', knockbackUrl],
      ['sweep', sweepUrl],
      ['totem', totemUrl],
      ['smash', smashUrl],
      ['smashGround', smashGroundUrl],
      ['crossbowShoot', crossbowShootUrl],
      ['shieldBlock', shieldBlockUrl],
      ['explode', explodeUrl],
      ['lunge', lungeUrl],
    ] as const;
    for (const [name, url] of list) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => (this.samples[name] = buf))
        .catch(() => {
          /* keep the synth version */
        });
    }
  }

  /** Plays a decoded sample; false when it isn't ready (the caller synthesises instead). */
  private sample(name: SampleName, dest: AudioNode, peak = 1, rate = 1): boolean {
    const buf = this.samples[name];
    if (!buf) return false;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    const g = ctx.createGain();
    g.gain.value = peak;
    src.connect(g).connect(dest);
    src.start();
    return true;
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
    if (this.pack(kind === 'weak' ? 'hitWeak' : kind === 'strong' ? 'hitStrong' : kind === 'crit' ? 'hitCrit' : 'hitKnockback', d)) return;
    const t = this.ctx!.currentTime;
    switch (kind) {
      case 'weak':
        // A soft, dull tap.
        this.thump(d, t, 95, 0.5, 0.07);
        this.noiseBurst(d, t, 0.05, 'lowpass', 1100, 500, 0.8, 0.35);
        break;
      case 'strong':
        // A solid punch: a low thump, a cloth-and-leather slap, and a short crack on top.
        this.thump(d, t, 120, 0.95, 0.11);
        this.noiseBurst(d, t, 0.07, 'bandpass', 1300, 600, 1.1, 0.8);
        this.noiseBurst(d, t, 0.025, 'highpass', 3500, 2500, 0.7, 0.45);
        break;
      case 'knockback':
        if (this.sample('knockback', d)) break;
        this.thump(d, t, 115, 0.95, 0.12);
        this.noiseBurst(d, t, 0.16, 'bandpass', 500, 2400, 1.2, 0.6);
        this.noiseBurst(d, t, 0.08, 'bandpass', 1400, 500, 0.9, 0.75);
        break;
      case 'crit':
        if (this.sample('crit', d)) break;
        this.thump(d, t, 125, 0.8, 0.1);
        this.noiseBurst(d, t, 0.11, 'highpass', 2600, 1200, 0.8, 0.9);
        this.tone(d, t, 0.05, 'square', 1900, 700, 0.18);
        break;
    }
  }

  /** A short low "body" hit: a sine dropping fast in pitch, with a click at the start. */
  private thump(dest: AudioNode, t0: number, f0: number, peak: number, dur: number) {
    this.tone(dest, t0, dur, 'sine', f0, f0 * 0.38, peak);
    this.noiseBurst(dest, t0, 0.012, 'lowpass', 2400, 1200, 0.7, peak * 0.5);
  }

  /**
   * Getting hurt: a short voiced grunt rather than a beep — a buzzy source pitched down, shaped by
   * two vowel-like resonances, with a breath of noise. Each one is pitched a little differently.
   */
  hurt(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.75 : 0.9);
    if (!d) return;
    if (this.pack('hurt', d, 1, Sound.jitter())) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const p = Sound.jitter(0.25);
    const dur = 0.19;
    const src = ctx.createOscillator();
    src.type = 'sawtooth';
    src.frequency.setValueAtTime(150 * p, t);
    src.frequency.exponentialRampToValueAtTime(96 * p, t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.55, t + 0.012);
    env.gain.setValueAtTime(0.55, t + 0.05);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    // "uh": resonances around 650 Hz and 1150 Hz, sliding down a little as the voice drops.
    for (const [f, q, g] of [
      [650, 6, 1],
      [1150, 8, 0.55],
    ] as const) {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f * p, t);
      bp.frequency.exponentialRampToValueAtTime(f * p * 0.8, t + dur);
      const gg = ctx.createGain();
      gg.gain.value = g;
      src.connect(bp).connect(gg).connect(env);
    }
    env.connect(d);
    src.start(t);
    src.stop(t + dur + 0.05);
    this.noiseBurst(d, t, 0.08, 'bandpass', 1800, 900, 1, 0.18);
    this.thump(d, t, 90, 0.35, 0.08);
  }

  /** entity.player.attack.sweep: a longer, airy whoosh. */
  sweep(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.6);
    if (!d) return;
    if (this.pack('sweep', d)) return;
    if (this.sample('sweep', d, 1.4)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.22, 'bandpass', 600, 2600, 1.1, 0.45);
  }

  /** A swing that hits nothing: a quick, quiet swish of air. */
  swing(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.12, 'bandpass', 700, 2200, 1.6, 0.22);
  }

  eat(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7, 'blocks');
    if (!d) return;
    if (this.pack('eat', d, 0.7, 1 + (Math.random() - Math.random()) * 0.2)) return;
    const t = this.ctx!.currentTime;
    for (let i = 0; i < 3; i++) {
      const f = 900 + Math.random() * 1600;
      this.noiseBurst(d, t + i * 0.035, 0.035, 'bandpass', f, f * 0.7, 2.5, 0.6);
    }
  }

  burp(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7, 'blocks');
    if (!d) return;
    if (this.pack('burp', d, 0.6, 0.9 + Math.random() * 0.1)) return;
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

  /** A footstep on grass: two quick crunches (heel, then toe) and a soft thud under them. */
  step(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.18 : 0.25, 'steps');
    if (!d) return;
    if (this.pack('step', d, 0.9, 1)) return;
    const t = this.ctx!.currentTime;
    const f = 1800 + Math.random() * 1400;
    this.noiseBurst(d, t, 0.045, 'bandpass', f, f * 0.6, 1.4, 0.55);
    this.noiseBurst(d, t + 0.03 + Math.random() * 0.02, 0.05, 'bandpass', f * 0.8, f * 0.5, 1.4, 0.4);
    this.thump(d, t, 80, 0.25, 0.06);
  }

  /** Landing: a heavier thud with a crunch of grass. */
  land(pos: { x: number; y: number; z: number }, self: boolean) {
    const d = this.out(self ? undefined : pos, self ? 0.25 : 0.3, 'steps');
    if (!d) return;
    if (this.pack('landSmall', d, 0.9)) return;
    const t = this.ctx!.currentTime;
    this.thump(d, t, 85, 0.7, 0.1);
    this.noiseBurst(d, t, 0.08, 'bandpass', 1600, 700, 1.2, 0.5);
  }

  /** item.shield.block: a hit (or an arrow) landing on a raised shield. */
  shieldBlock(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.9);
    if (!d) return;
    // Vanilla varies the pitch a little per block (0.8–1.2).
    if (this.pack('shieldBlock', d, 1, 0.8 + Math.random() * 0.4)) return;
    if (this.sample('shieldBlock', d, 1, 0.85 + Math.random() * 0.3)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.09, 'lowpass', 700, 180, 1.2, 0.9);
    this.tone(d, t, 0.12, 'triangle', 150, 70, 0.6);
  }

  /** The crack of an axe disabling a shield. */
  shieldBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    if (this.pack('itemBreak', d, 0.8, 0.8 + Math.random() * 0.4)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.22, 'bandpass', 1800, 300, 0.8, 1);
    this.noiseBurst(d, t + 0.04, 0.14, 'lowpass', 600, 150, 1, 0.7);
    this.tone(d, t, 0.2, 'sawtooth', 220, 60, 0.25);
  }

  shieldRaise(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.35);
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.06, 'bandpass', 500, 900, 1.5, 0.3);
  }

  /** item.crossbow.shoot (the recording). */
  crossbowShoot(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.9);
    if (!d) return;
    if (this.pack('crossbowShoot', d, 1, 1 + (Math.random() - 0.5) * 0.2)) return;
    if (this.sample('crossbowShoot', d)) return;
    this.bowShoot(pos, 1);
  }

  bowShoot(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    // ArrowItem: pitch 1 / (random · 0.4 + 1.2) + power / 2.
    if (this.pack('bow', d, 1, 1 / (Math.random() * 0.4 + 1.2) + power * 0.5)) return;
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
    if (this.pack('arrowHit', d, 1, 1.2 / (Math.random() * 0.2 + 0.9))) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.07, 'bandpass', 2200, 900, 1.5, 0.7);
    this.tone(d, t, 0.06, 'sine', 900, 500, 0.25);
  }

  /** The little "ding" when you hit someone with an arrow (vanilla's arrow hit-player sound). */
  arrowDing() {
    const d = this.out(undefined, 0.45, 'ui');
    if (d && !this.pack('arrowDing', d, 0.6, 0.5)) this.tone(d, this.ctx!.currentTime, 0.16, 'sine', 1250, 1240, 0.3);
  }

  pickup(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.4, 'blocks');
    if (d && !this.pack('pickup', d, 0.5, (Math.random() - Math.random()) * 1.4 + 2)) this.tone(d, this.ctx!.currentTime, 0.07, 'sine', 1400 + Math.random() * 400, 1800, 0.2);
  }

  /** Throwing a splash potion or XP bottle (entity.splash_potion.throw). */
  throwItem(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5, 'blocks');
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.14, 'bandpass', 900, 2400, 1.2, 0.35);
  }

  /** Glass breaking (entity.splash_potion.break). */
  glassBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.8, 'blocks');
    if (!d) return;
    if (this.pack('glass', d, 1, 0.9 + Math.random() * 0.1)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.18, 'highpass', 5000, 2500, 0.8, 0.7);
    for (let i = 0; i < 3; i++) this.tone(d, t + i * 0.025, 0.07, 'sine', 2600 + Math.random() * 1800, 2000, 0.12);
  }

  /** item.totem.use: the recorded totem pop (a rising magical whoosh until it is loaded). */
  totem(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    if (this.pack('totem', d)) return;
    if (this.sample('totem', d, 0.7)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.9, 'bandpass', 400, 3200, 2, 0.5);
    this.tone(d, t, 0.6, 'triangle', 330, 990, 0.3);
    this.tone(d, t + 0.1, 0.6, 'sine', 495, 1480, 0.2);
  }

  /** entity.experience_orb.pickup: a high random chime. */
  xp(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.25, 'blocks');
    if (d && !this.pack('orb', d, 0.5, 0.55 + Math.random() * 0.9)) this.tone(d, this.ctx!.currentTime, 0.09, 'sine', 1600 + Math.random() * 1200, 2400, 0.18);
  }

  /** entity.item.break */
  itemBreak(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    if (this.pack('itemBreak', d, 0.8, 0.8 + Math.random() * 0.4)) return;
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
    const d = this.out(pos, broke ? 0.8 : 0.6, 'blocks');
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
    const d = this.out(pos, 0.25, 'blocks');
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.05, kind === 'wood' ? 'lowpass' : 'bandpass', kind === 'wood' ? 700 : 1600, 400, 1, 0.5);
  }

  bucket(pos: { x: number; y: number; z: number }, lava: boolean, fill: boolean) {
    const d = this.out(pos, 0.6, 'blocks');
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, lava ? 0.4 : 0.3, 'lowpass', fill ? 600 : 1500, fill ? 1500 : 400, 1, lava ? 0.5 : 0.7);
    if (lava) this.tone(d, t, 0.3, 'sine', 90, 60, 0.3);
  }

  /** Lava meeting water (block.lava.extinguish). */
  fizz(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.7, 'blocks');
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.45, 'highpass', 5000, 2000, 0.6, 0.6);
  }

  /** entity.generic.explode: a deep boom with a noisy tail (louder and longer for bigger blasts). */
  /** entity.wind_charge.wind_burst: a hollow airy thump. */
  windBurst(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 0.8);
    if (!d) return;
    if (this.pack('windBurst', d, 1, 0.9 + Math.random() * 0.2)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.35 + power * 0.05, 'bandpass', 250, 1400, 0.9, 0.8);
    this.tone(d, t, 0.18, 'sine', 140, 60, 0.5);
  }

  /**
   * MaceItem: item.mace.smash_air when the one hit is off the ground, smash_ground when they
   * stand on it — smash_ground_heavy (deeper, with a thump under it) after a fall over 5 blocks.
   */
  smash(pos: { x: number; y: number; z: number }, heavy: boolean, ground = true) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    if (this.pack(!ground ? 'smashAir' : heavy ? 'smashHeavy' : 'smashGround', d)) return;
    if (!ground && this.sample('smash', d, 1, 1)) return;
    if (ground && this.sample('smashGround', d, 1, heavy ? 0.85 : 1)) {
      if (heavy) this.tone(d, t, 0.35, 'sine', 90, 35, 0.6);
      return;
    }
    this.tone(d, t, heavy ? 0.4 : 0.25, 'triangle', heavy ? 110 : 160, 35, heavy ? 1 : 0.7);
    this.noiseBurst(d, t, heavy ? 0.3 : 0.18, 'lowpass', 900, 200, 1, heavy ? 1 : 0.6);
  }

  /** item.armor.equip_netherite / equip_elytra. */
  equipArmor(pos: { x: number; y: number; z: number }, elytra: boolean) {
    const d = this.out(pos, 0.5, 'blocks');
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, elytra ? 0.2 : 0.12, 'bandpass', elytra ? 900 : 500, elytra ? 2400 : 300, 1, 0.4);
  }

  explosion(pos: { x: number; y: number; z: number }, power: number) {
    const d = this.out(pos, 1.4);
    if (!d) return;
    if (this.pack('explode', d, 0.8, (1 + (Math.random() - Math.random()) * 0.2) * 0.7)) return;
    // The recorded blast: bigger explosions (crystals, power 6) a touch deeper than anchors or TNT.
    if (this.sample('explode', d, 0.8, power >= 6 ? 0.92 : 1)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.9 + power * 0.08, 'lowpass', 900, 60, 0.9, 1);
    this.tone(d, t, 0.6, 'sine', 70, 30, 0.9);
    this.noiseBurst(d, t + 0.02, 0.35, 'bandpass', 2400, 400, 0.7, 0.5);
  }

  /** Placing an end crystal: a glassy chime. */
  crystalPlace(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 0.5, 'blocks');
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 0.25, 'sine', 1500, 1900, 0.18);
    this.tone(d, t + 0.03, 0.2, 'triangle', 2250, 2600, 0.1);
  }

  /** block.respawn_anchor.charge: a rising hum. */
  anchorCharge(pos: { x: number; y: number; z: number }, charge: number) {
    const d = this.out(pos, 0.6, 'blocks');
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

  /** entity.lightning_bolt.thunder: a long, low rumble. */
  thunder() {
    const d = this.out(undefined, 0.9, 'blocks');
    if (!d) return;
    if (this.pack('thunder', d, 1, 0.8 + Math.random() * 0.2)) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.25, 'highpass', 2500, 900, 0.7, 0.5);
    this.noiseBurst(d, t + 0.05, 2.6, 'lowpass', 260, 60, 0.8, 1);
    this.tone(d, t, 1.8, 'sine', 55, 30, 0.5);
  }

  private rainGain: GainNode | null = null;

  /** A looping hiss while it rains (0 = off). */
  setRain(strength: number) {
    if (!this.ctx || !this.master) return;
    const v = strength * 0.12 * this.categories.blocks;
    if (!this.rainGain) {
      if (v <= 0.001) return;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = this.ctx.createBiquadFilter();
      filt.type = 'bandpass';
      filt.frequency.value = 2200;
      filt.Q.value = 0.4;
      this.rainGain = this.ctx.createGain();
      this.rainGain.gain.value = 0;
      src.connect(filt).connect(this.rainGain).connect(this.master);
      src.start();
    }
    const g = this.rainGain.gain;
    if (Math.abs(g.value - v) > 0.002) g.setTargetAtTime(v, this.ctx.currentTime, 0.3);
  }

  equip() {
    const d = this.out(undefined, 0.3, 'blocks');
    if (d) this.noiseBurst(d, this.ctx!.currentTime, 0.08, 'bandpass', 1200, 700, 1, 0.3);
  }

  ui() {
    const d = this.out(undefined, 0.35, 'ui');
    if (d) this.tone(d, this.ctx!.currentTime, 0.05, 'square', 1250, 900, 0.15);
  }

  countdown(final: boolean) {
    const d = this.out(undefined, 0.45, 'ui');
    if (!d) return;
    const t = this.ctx!.currentTime;
    if (final) {
      this.tone(d, t, 0.18, 'square', 880, 880, 0.2);
      this.tone(d, t + 0.09, 0.3, 'square', 1320, 1320, 0.2);
    } else this.tone(d, t, 0.14, 'square', 587, 587, 0.2);
  }

  /** entity.lightning_bolt.impact + thunder: a sharp crack right there, then the rumble. */
  lightning(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1.2);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, 0.12, 'highpass', 5000, 1500, 0.8, 1);
    this.noiseBurst(d, t + 0.03, 0.5, 'bandpass', 1800, 300, 0.6, 0.7);
    this.thunder();
  }

  /** entity.firework_rocket.blast (+ twinkle): a pop, then a crackle of sparks. */
  firework(pos: { x: number; y: number; z: number }, big = false) {
    const d = this.out(pos, big ? 1.1 : 0.9);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.noiseBurst(d, t, big ? 0.6 : 0.4, 'lowpass', 1400, 120, 0.9, 1);
    this.tone(d, t, 0.25, 'sine', 120, 50, 0.6);
    for (let i = 0; i < 9; i++) {
      const at = t + 0.35 + Math.random() * 0.8;
      this.noiseBurst(d, at, 0.04, 'highpass', 4000 + Math.random() * 3000, 2500, 1, 0.25);
    }
  }

  /** item.spear.lunge: the recorded whoosh (a synth swish until it is loaded). */
  lunge(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    if (this.sample('lunge', d, 0.9)) return;
    this.noiseBurst(d, this.ctx!.currentTime, 0.3, 'bandpass', 600, 2200, 1.2, 0.6);
  }

  /** A low growl that rises and falls: the Dragon's Breath finisher. */
  roar(pos: { x: number; y: number; z: number }) {
    const d = this.out(pos, 1);
    if (!d) return;
    const t = this.ctx!.currentTime;
    this.tone(d, t, 1.3, 'sawtooth', 90, 55, 0.35);
    this.tone(d, t + 0.05, 1.2, 'sawtooth', 135, 70, 0.2);
    this.noiseBurst(d, t, 1.2, 'bandpass', 500, 200, 1.5, 0.6);
  }

  /** ui.toast.challenge_complete / in: a bright rising fanfare for an advancement. */
  advancement(challenge: boolean) {
    const d = this.out(undefined, 0.4, 'ui');
    if (!d) return;
    const t = this.ctx!.currentTime;
    const notes = challenge ? [523, 659, 784, 1047, 1319] : [784, 1047];
    notes.forEach((f, i) => this.tone(d, t + i * 0.09, challenge ? 0.5 : 0.35, 'triangle', f, f, 0.22));
  }

  jingle(win: boolean) {
    const d = this.out(undefined, 0.45, 'ui');
    if (!d) return;
    const t = this.ctx!.currentTime;
    const notes = win ? [523, 659, 784, 1047] : [440, 392, 330, 262];
    notes.forEach((f, i) => this.tone(d, t + i * 0.13, 0.22, 'square', f, f, 0.18));
  }
}
