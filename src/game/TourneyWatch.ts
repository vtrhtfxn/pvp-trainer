import { BotBrain } from '../ai/BotBrain';
import { DIFFICULTIES } from '../ai/difficulty';
import { Rng } from '../core/rng';
import { performAttack } from './combat';
import type { Fighter } from './Fighter';
import { kitById, type KitDef, type KitId } from './kits';
import { Match } from './Match';
import { SPEC_CAMS, SPEC_SPEEDS, type RoundResult, type SpecCam, type Watch } from './Spectate';
import {
  entrantColor,
  gameKit,
  gameSeed,
  prepareBotMatch,
  recordGame,
  roundName,
  saveTournament,
  teamSlot,
  type Entrant,
  type GamePlayer,
  type TMatch,
  type Tournament,
} from './tournament';

/**
 * A tournament game between two bots runs to a kill or this long, then goes to whoever has more
 * health and totems left (like Bot vs Bot). Bed Wars and SkyWars aren't in the tournament pool.
 */
export const TOURNEY_GAME_TICKS = 20 * 60 * 2.5;
/** Ticks the result stays up before the next game of the match starts. */
const RESULT_TICKS = 80;

/** One game between two tournament bots: `a` plays the match's "player" side, `b` its bot. */
export function botGame(kit: KitId, a: Entrant, b: Entrant, seed: number): { match: Match; brainA: BotBrain } {
  const m = new Match(kitById(kit), DIFFICULTIES[b.tier ?? 'lt3'], seed);
  m.player.name = a.name;
  m.bot.name = b.name;
  const brainA = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[a.tier ?? 'lt3'], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  if (m.mode) brainA.attachSky(m);
  m.externalMining = true;
  brainA.resetRound();
  return { match: m, brainA };
}

/** Steps a bot game one tick. Returns the winner (0 = `a`, 1 = `b`) once it's decided. */
export function stepBotGame(g: { match: Match; brainA: BotBrain }): 0 | 1 | null {
  const m = g.match;
  if (m.phase === 'fight') {
    g.brainA.tick();
    m.useHeld = g.brainA.useHeld;
  }
  m.tick();
  if (m.phase === 'ended') return m.winner === m.player ? 0 : 1;
  if (m.phase === 'fight' && m.fightTicks >= TOURNEY_GAME_TICKS) {
    const score = (f: Fighter) => f.effectiveHealth() + 20 * f.countItem('totem_of_undying');
    m.phase = 'ended';
    m.phaseTicks = 0;
    return score(m.player) >= score(m.bot) ? 0 : 1;
  }
  return null;
}

/** Plays a whole bot game at once, without drawing it. */
export const playBotGame: GamePlayer = (kit, a, b, seed) => {
  const g = botGame(kit, a, b, seed);
  for (;;) {
    const w = stepBotGame(g);
    if (w !== null) return w;
    g.match.world.events.length = 0;
    g.match.player.events.length = 0;
    g.match.bot.events.length = 0;
  }
};

/** What the broadcast overlay shows about the match being watched. */
export interface BroadcastInfo {
  kit: KitDef;
  /** Whose pick this game's kit was ("Decider" for game 3). */
  pickedBy: string;
  round: string;
  game: number;
  /** Seeds and series wins: [player side, bot side]. */
  seeds: [number, number];
  wins: [number, number];
}

/**
 * Watching a tournament match between two bots: game after game on the drafted kits, through the
 * Bot vs Bot cameras. Each result goes into the bracket as it happens; `finished` turns true once
 * someone has won the match.
 */
export class TourneyWatch implements Watch {
  match!: Match;
  private brainA!: BotBrain;
  cam: SpecCam = 'followA';
  speed = 1;
  paused = false;
  lastResult: RoundResult | null = null;
  /** The match is decided (after its last result has been shown). */
  finished = false;
  /** A new game started this tick (the overlay plays its intro). */
  newGame = true;
  private resultTimer = -1;

  constructor(
    readonly t: Tournament,
    readonly m: TMatch,
  ) {
    prepareBotMatch(t, m);
    this.startGame();
  }

  private entrant(slot: 0 | 1): Entrant {
    return this.t.entrants[this.m.players[slot]!];
  }

  get kit(): KitDef {
    return kitById(gameKit(this.m.draft!, Math.min(2, this.m.games.length))!);
  }

  get nameA(): string {
    return this.entrant(0).name;
  }
  get nameB(): string {
    return this.entrant(1).name;
  }
  get colorA(): string {
    return entrantColor(this.entrant(0));
  }
  get colorB(): string {
    return entrantColor(this.entrant(1));
  }

  broadcast(): BroadcastInfo {
    const d = this.m.draft!;
    const n = Math.min(2, this.m.games.length);
    const picker = n < 2 ? this.t.entrants[this.m.players[teamSlot(d, n === 0 ? 'A' : 'B')]!].name : null;
    return {
      kit: this.kit,
      pickedBy: picker ? `${picker} Pick` : 'Decider',
      round: roundName(this.t, this.m),
      game: n + 1,
      seeds: [this.entrant(0).seed, this.entrant(1).seed],
      wins: [this.m.wins[0], this.m.wins[1]],
    };
  }

  private startGame() {
    const g = botGame(this.kit.id, this.entrant(0), this.entrant(1), gameSeed(this.t));
    this.match = g.match;
    this.brainA = g.brainA;
    this.resultTimer = -1;
    this.newGame = true;
  }

  label(side: 'a' | 'b'): string {
    return side === 'a' ? this.brainA.label : this.match.brain.label;
  }

  title(): string {
    const b = this.broadcast();
    return `${b.round} · Game ${b.game} · ${b.kit.name} · ${this.nameA} ${b.wins[0]} – ${b.wins[1]} ${this.nameB}`;
  }

  help(camName: string): string {
    return `V / 1–6 camera: ${camName}${this.cam === 'free' ? ' (WASD, Space/Shift)' : ''}  ·  [ ] speed: ${this.speed}×${this.paused ? ' (paused)' : ''}  ·  P pause  ·  Esc back to the bracket (it plays on there)`;
  }

  progress(): null {
    return null;
  }

  resultText(r: RoundResult): string {
    const name = r.winner === 'a' ? this.nameA : this.nameB;
    if (this.m.winner !== null) return `${name} wins the match ${Math.max(...this.m.wins)}–${Math.min(...this.m.wins)}!`;
    return r.timeout ? `${name} takes the game on health` : `${name} takes the game!`;
  }

  tick(): boolean {
    if (this.finished) return false;
    if (this.resultTimer < 0) {
      const w = stepBotGame({ match: this.match, brainA: this.brainA });
      if (w !== null) {
        recordGame(this.t, this.m, w);
        saveTournament(this.t);
        this.lastResult = { winner: w === 0 ? 'a' : 'b', timeout: this.match.winner === null };
        this.resultTimer = RESULT_TICKS;
      }
      return false;
    }
    this.match.tick();
    if (--this.resultTimer > 0) return false;
    if (this.m.winner !== null) {
      this.finished = true;
      return false;
    }
    this.startGame();
    return true;
  }

  /** R: nothing to restart in a tournament game. */
  restart(): boolean {
    return false;
  }

  togglePause() {
    this.paused = !this.paused;
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
