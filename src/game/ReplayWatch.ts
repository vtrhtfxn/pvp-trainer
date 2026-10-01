import { DIFFICULTIES, type BotProfile } from '../ai/difficulty';
import type { AttributeId, GameMode } from './attributes';
import { kitById, type KitDef, type KitId } from './kits';
import { COUNTDOWN_TICKS, Match } from './Match';
import { CHECK_EVERY, FrameFeeder, checksum, type ReplayData } from './replay';
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
  const m = new Match(replayKit(d), replayProfile(d), d.seed);
  m.player.name = d.playerName;
  m.bot.name = d.botName;
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

  constructor(readonly data: ReplayData) {
    this.kit = replayKit(data);
    this.profile = replayProfile(data);
    this.rebuild();
    this.seek(this.start);
  }

  get total(): number {
    return this.data.frames.length;
  }

  /** Where watching starts: just before the countdown ends. */
  get start(): number {
    return Math.min(this.total, Math.max(0, COUNTDOWN_TICKS - LEAD_IN));
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
    this.feeder.apply(this.match, d.frames[this.t]);
    this.match.tick();
    this.t++;
    if (this.t % CHECK_EVERY === 0) {
      const want = d.checks[this.t / CHECK_EVERY - 1];
      if (want !== undefined && want !== checksum(this.match.player, this.match.bot)) this.desynced = true;
    }
    return true;
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
