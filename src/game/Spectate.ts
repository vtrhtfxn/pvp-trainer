import { BotBrain } from '../ai/BotBrain';
import type { BotProfile } from '../ai/difficulty';
import { Rng } from '../core/rng';
import { performAttack } from './combat';
import type { Fighter } from './Fighter';
import type { KitDef } from './kits';
import { Match } from './Match';

/** Where the spectator camera is: circling the fight, behind a fighter, or through their eyes. */
export type SpecCam = 'orbit' | 'followA' | 'followB' | 'povA' | 'povB';
export const SPEC_CAMS: SpecCam[] = ['orbit', 'followA', 'followB', 'povA', 'povB'];
export const SPEC_SPEEDS = [0.25, 0.5, 1, 2, 4];

/** A round with no winner after this long goes to whoever has more health (and totems) left. */
export const SPEC_ROUND_TICKS = 20 * 60 * 3;
/** Ticks the result stays on screen before the next round starts. */
const RESULT_TICKS = 60;

export interface RoundResult {
  winner: 'a' | 'b';
  /** Decided on health at the time limit rather than by a kill. */
  timeout: boolean;
}

/**
 * Bot vs bot: two tier bots fight round after round while you watch. Fighter A is the match's
 * "player" (driven by its own brain, like the title-screen demo), fighter B the match's bot.
 */
export class Spectate {
  match!: Match;
  brainA!: BotBrain;
  readonly score: [number, number] = [0, 0];
  round = 0;
  cam: SpecCam = 'orbit';
  speed = 1;
  paused = false;
  /** Set when a round has just been decided (for the announcement), cleared by the caller. */
  lastResult: RoundResult | null = null;
  private resultTimer = -1;
  private seed: number;

  constructor(
    readonly kit: KitDef,
    readonly a: BotProfile,
    readonly b: BotProfile,
    seed = Math.floor(Math.random() * 2 ** 30),
  ) {
    this.seed = seed;
    this.newRound();
  }

  /** Display names: the tier, numbered when both bots are the same tier. */
  get nameA(): string {
    return this.a.id === this.b.id ? `${this.a.name} (1)` : this.a.name;
  }
  get nameB(): string {
    return this.a.id === this.b.id ? `${this.b.name} (2)` : this.b.name;
  }

  fighter(side: 'a' | 'b'): Fighter {
    return side === 'a' ? this.match.player : this.match.bot;
  }

  label(side: 'a' | 'b'): string {
    return side === 'a' ? this.brainA.label : this.match.brain.label;
  }

  newRound() {
    this.round++;
    const s = this.seed + this.round * 7919;
    const m = new Match(this.kit, this.b, s);
    m.player.name = this.nameA;
    m.bot.name = this.nameB;
    this.brainA = new BotBrain(m.player, m.bot, m.world, this.a, new Rng(s + 99), () => performAttack(m.player, m.bot));
    if (m.mode) this.brainA.attachSky(m);
    m.externalMining = true;
    this.brainA.resetRound();
    this.match = m;
    this.resultTimer = -1;
  }

  /** One game tick. Returns true when a new round's match replaced the old one. */
  tick(): boolean {
    const m = this.match;
    if (m.phase === 'fight') {
      this.brainA.tick();
      m.useHeld = this.brainA.useHeld;
    }
    m.tick();
    if (this.resultTimer < 0) {
      let result: RoundResult | null = null;
      if (m.phase === 'ended') result = { winner: m.winner === m.player ? 'a' : 'b', timeout: false };
      else if (m.phase === 'fight' && m.fightTicks >= (m.mode ? SPEC_ROUND_TICKS * 6 : SPEC_ROUND_TICKS)) {
        const score = (f: Fighter) => f.effectiveHealth() + 20 * f.countItem('totem_of_undying');
        result = { winner: score(m.player) >= score(m.bot) ? 'a' : 'b', timeout: true };
        m.phase = 'ended';
        m.phaseTicks = 0;
      }
      if (result) {
        this.score[result.winner === 'a' ? 0 : 1]++;
        this.lastResult = result;
        this.resultTimer = RESULT_TICKS;
      }
      return false;
    }
    if (--this.resultTimer <= 0) {
      this.newRound();
      return true;
    }
    return false;
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
