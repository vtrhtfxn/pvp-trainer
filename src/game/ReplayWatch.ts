import { DIFFICULTIES, type BotProfile } from '../ai/difficulty';
import type { AttributeId, GameMode } from './attributes';
import { botUsernames } from '../ai/disguise';
import { kitById, type KitDef, type KitId } from './kits';
import { COUNTDOWN_TICKS, Match } from './Match';
import { wrapAngle } from '../core/math';
import { CHECK_EVERY, FrameFeeder, checksum, curveLook, tickLooks, type ReplayData } from './replay';
import { SPEC_CAMS, SPEC_SPEEDS, type RoundResult, type SpecCam, type Watch } from './Spectate';

const PLAYER_COLOR = '#55ff55';
/** Replays start this long before the countdown ends. */
const LEAD_IN = 20;

export function replayKit(d: ReplayData): KitDef {
  return d.customKit ?? kitById(d.kitId as KitId);
}

export function replayProfile(d: ReplayData): BotProfile {
  return (DIFFICULTIES as Record<string, BotProfile>)[d.profileId] ?? DIFFICULTIES.practice;
}

/** Builds the match a replay starts from: same kit, tier, seed and starting rules. */
export function replayMatch(d: ReplayData): Match {
  const m = new Match(replayKit(d), replayProfile(d), d.seed, undefined, d.players);
  m.countdownTicks = d.prep ?? COUNTDOWN_TICKS;
  m.player.name = d.playerName;
  m.player.leftHanded = !!d.leftHanded;
  m.bot.name = d.botName;
  // Disguised bots get the same usernames back (the first is the opponent's, as recorded).
  if (d.disguise !== undefined) {
    const bots = m.fighters.filter((f) => f !== m.player);
    const names = botUsernames(d.disguise, bots.length);
    bots.forEach((f, i) => (f.name = i === 0 ? d.botName : names[i]));
  }
  Object.assign(m.world.rules, d.rules);
  m.world.dayTime = d.dayTime;
  m.world.raining = d.raining;
  for (const who of ['player', 'bot'] as const) {
    const f = who === 'player' ? m.player : m.bot;
    for (const [id, v] of Object.entries(d.attrs[who])) f.setAttribute(id as AttributeId, v);
    f.setGameMode(d.gameModes[who] as GameMode);
    f.health = f.maxHealth;
  }
  return m;
}

/** Forgets what a tick produced (sounds, particles, mode messages) when nobody will show it. */
export function dropEvents(m: Match) {
  m.world.events.length = 0;
  m.player.events.length = 0;
  m.bot.events.length = 0;
  m.mode?.takeAnnouncements();
}

export function clock(ticks: number): string {
  const s = Math.max(0, Math.floor(ticks / 20));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Watching a replay: re-runs the recorded duel, with cameras, speed, pause and seeking. */
export class ReplayWatch implements Watch {
  match!: Match;
  readonly kit: KitDef;
  readonly profile: BotProfile;
  cam: SpecCam = 'povA';
  speed = 1;
  paused = false;
  lastResult: RoundResult | null = null;
  /** The re-run no longer matches the recording (it was made by a different game version). */
  desynced = false;
  /** Ticks played so far (= frames applied). */
  t = 0;
  private feeder!: FrameFeeder;
  private ended = false;
  /** Your look at every tick of the recording (frames leave it out when it didn't change). */
  private readonly yaws: number[];
  private readonly pitches: number[];
  /** The frames you saw between ticks (frame k: on the way from tick k − 1 to k), where recorded. */
  private readonly between: (number[] | undefined)[];

  constructor(readonly data: ReplayData) {
    this.kit = replayKit(data);
    this.profile = replayProfile(data);
    ({ yaws: this.yaws, pitches: this.pitches } = tickLooks(data.frames));
    // Only well-formed sample lists (fraction, yaw, pitch triples of finite numbers) are used.
    this.between = data.frames.map((f) => (Array.isArray(f.L) && f.L.length % 3 === 0 && f.L.length <= 180 && f.L.every((n) => Number.isFinite(n)) ? f.L : undefined));
    this.rebuild();
    this.seek(this.start);
  }

  get total(): number {
    return this.data.frames.length;
  }

  /** Where watching starts: just before the countdown ends. */
  get start(): number {
    // The fight starts when the countdown ends, or 3 s after you said you were ready.
    let fight = this.data.prep ?? COUNTDOWN_TICKS;
    const ready = this.data.frames.findIndex((f) => f.a?.some((a) => a.k === 'ready'));
    if (ready >= 0) fight = Math.min(fight, ready + COUNTDOWN_TICKS);
    return Math.min(this.total, Math.max(0, fight - LEAD_IN));
  }

  get nameA(): string {
    return this.data.playerName;
  }
  get nameB(): string {
    return this.data.botName;
  }
  get colorA(): string {
    return PLAYER_COLOR;
  }
  get colorB(): string {
    return this.profile.color;
  }

  label(side: 'a' | 'b'): string {
    return side === 'b' ? this.match.brain.label : '';
  }

  title(): string {
    return `Replay · ${this.kit.name}${this.desynced ? ' · drifted from the original' : ''}`;
  }

  help(camName: string): string {
    return `V / 1–6 camera: ${camName}${this.cam === 'free' ? ' (WASD, Space/Shift)' : ''}  ·  [ ] speed: ${this.speed}×${this.paused ? ' (paused)' : ''}  ·  P pause  ·  ← → 5 s  ·  R restart  ·  Esc leave`;
  }

  progress(): { at: number; total: number; text: string } {
    return { at: this.t, total: this.total, text: `${clock(this.t)} / ${clock(this.total)}` };
  }

  resultText(r: RoundResult): string {
    return r.winner === 'a' ? 'You won' : `${this.data.botName} won`;
  }

  private rebuild() {
    this.match = replayMatch(this.data);
    this.feeder = new FrameFeeder();
    this.t = 0;
    this.ended = false;
    this.lastResult = null;
  }

  /** Applies the next recorded frame and ticks. False at the end of the recording. */
  private step(): boolean {
    const d = this.data;
    if (this.t >= d.frames.length) return false;
    const p = this.match.player;
    const yaw = p.yaw;
    const pitch = p.pitch;
    this.feeder.apply(this.match, d.frames[this.t]);
    this.match.tick();
    // The frame set this tick's look before the tick saved the "previous" one, so both came out
    // the same and your POV turned in 20 jumps a second. Between ticks the camera goes from the
    // last tick's look to this one, as it did on your screen.
    p.prevYaw = yaw;
    p.prevPitch = pitch;
    this.t++;
    if (this.t % CHECK_EVERY === 0) {
      const want = d.checks[this.t / CHECK_EVERY - 1];
      if (want !== undefined && want !== checksum(this.match.player, this.match.bot)) this.desynced = true;
    }
    return true;
  }

  /**
   * Where your eyes point `alpha` of the way to the next tick, as they did on your screen. Where
   * the recording kept the frames you saw between ticks (a flick, a quick correction), it goes
   * through each of them; elsewhere a smooth curve through the per-tick looks (using the next
   * tick's, which a replay already knows) is within a fraction of a degree of what you saw — not
   * straight lines from tick to tick, whose 20 changes of speed a second read as a low frame rate.
   */
  look(alpha: number): { yaw: number; pitch: number } {
    const p = this.match.player;
    const k = this.t;
    if (k < 1) return { yaw: p.yaw, pitch: p.pitch };
    // Live, your eyes moved with the mouse every frame while your body went from the last tick to
    // the next one: the same here, on the way from tick k − 1 to tick k (the replay knows it).
    const L = this.between[k];
    if (L && k < this.yaws.length) {
      // The frames you saw this tick, in straight lines between them (they're a frame apart).
      let t0 = 0;
      let y0 = this.yaws[k - 1];
      let p0 = this.pitches[k - 1];
      for (let i = 0; i <= L.length; i += 3) {
        const t1 = i < L.length ? L[i] / 100 : 1;
        const y1 = i < L.length ? y0 + wrapAngle(L[i + 1] - y0) : y0 + wrapAngle(this.yaws[k] - y0);
        const p1 = i < L.length ? L[i + 2] : this.pitches[k];
        if (alpha <= t1 || i >= L.length) {
          const u = t1 > t0 ? Math.max(0, Math.min(1, (alpha - t0) / (t1 - t0))) : 1;
          return { yaw: wrapAngle(y0 + (y1 - y0) * u), pitch: p0 + (p1 - p0) * u };
        }
        t0 = t1;
        y0 = y1;
        p0 = p1;
      }
    }
    const [yaw, pitch] = curveLook(this.yaws, this.pitches, k, alpha);
    return { yaw: wrapAngle(yaw), pitch };
  }

  tick(): boolean {
    if (this.step()) return false;
    if (!this.ended) {
      this.ended = true;
      this.paused = true;
      if (this.data.winner) this.lastResult = { winner: this.data.winner === 'player' ? 'a' : 'b', timeout: false };
    }
    return false;
  }

  /** Jumps to tick `target` (re-running from the start to go back). Returns true: a new match. */
  seek(target: number): boolean {
    target = Math.max(0, Math.min(this.total, Math.round(target)));
    if (target < this.t) this.rebuild();
    while (this.t < target && this.step()) dropEvents(this.match);
    this.ended = false;
    this.lastResult = null;
    return true;
  }

  seekBy(seconds: number): boolean {
    const was = this.paused;
    const r = this.seek(Math.max(this.start, this.t + seconds * 20));
    this.paused = was && this.t < this.total;
    return r;
  }

  restart(): boolean {
    this.paused = false;
    return this.seek(this.start);
  }

  togglePause() {
    // At the end, Space plays it again from the start.
    if (this.paused && this.t >= this.total) this.restart();
    else this.paused = !this.paused;
  }

  cycleCam(dir = 1) {
    const i = SPEC_CAMS.indexOf(this.cam);
    this.cam = SPEC_CAMS[(i + dir + SPEC_CAMS.length) % SPEC_CAMS.length];
  }

  changeSpeed(dir: number) {
    const i = SPEC_SPEEDS.indexOf(this.speed);
    this.speed = SPEC_SPEEDS[Math.max(0, Math.min(SPEC_SPEEDS.length - 1, i + dir))];
  }
}
