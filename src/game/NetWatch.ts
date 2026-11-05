import type { NetClient } from '../net/Client';
import { NetMatch } from '../net/NetMatch';
import type { ServerMsg } from '../net/protocol';
import type { TourView } from '../net/tourney';
import { kitById, type KitDef, type KitId } from './kits';
import type { Match } from './Match';
import { SPEC_CAMS, type RoundResult, type SpecCam, type Watch } from './Spectate';
import { entrantColor, matchById, type TMatch } from './tournament';
import { broadcastInfo, type BroadcastInfo } from './TourneyWatch';

/** Ticks the result stays up before going back to the bracket. */
const RESULT_TICKS = 80;

/**
 * Watching two people's game in an online tournament, live: the host sends its states and moves
 * to everyone in the room, played back here like an opponent's (no seat of ours). It runs from
 * the game's first message whether you look at it or not, so you can switch to it any time.
 */
export class NetWatch implements Watch {
  readonly net: NetMatch;
  cam: SpecCam = 'followA';
  /** Live: always 1×, and it can't be paused. */
  readonly speed = 1;
  readonly paused = false;
  lastResult: RoundResult | null = null;
  /** The game is over and its result has been shown (or it was called off). */
  finished = false;
  newGame = true;
  private endedTicks = -1;

  constructor(
    client: NetClient,
    kit: KitId,
    /** The bracket match being played. */
    readonly matchId: string,
    private view: TourView,
  ) {
    this.net = new NetMatch(client, -1, kit, 2);
  }

  /** The renderer and HUD only read what NetMatch and Match share (fighters, world, phase, clocks). */
  get match(): Match {
    return this.net as unknown as Match;
  }

  get kit(): KitDef {
    return kitById(this.net.kit.id);
  }

  setView(v: TourView) {
    this.view = v;
  }

  private tm(): TMatch | null {
    const t = this.view.tour;
    try {
      return t ? matchById(t, this.matchId) : null;
    } catch {
      return null;
    }
  }

  private entrant(slot: 0 | 1) {
    const t = this.view.tour;
    const m = this.tm();
    const id = m?.players[slot];
    return t && id !== null && id !== undefined ? t.entrants[id] : null;
  }

  get nameA(): string {
    return this.entrant(0)?.name ?? this.net.player.name;
  }
  get nameB(): string {
    return this.entrant(1)?.name ?? this.net.bot.name;
  }
  get colorA(): string {
    const e = this.entrant(0);
    return e ? entrantColor(e) : '#55ff55';
  }
  get colorB(): string {
    const e = this.entrant(1);
    return e ? entrantColor(e) : '#ff5555';
  }

  broadcast(): BroadcastInfo | null {
    const t = this.view.tour;
    const m = this.tm();
    return t && m ? broadcastInfo(t, m, this.kit) : null;
  }

  label(side: 'a' | 'b'): string {
    const f = side === 'a' ? this.net.player : this.net.bot;
    return f === this.net.bot ? this.net.brain.label : '';
  }

  title(): string {
    const b = this.broadcast();
    return b ? `LIVE · ${b.round} · Game ${b.game} · ${b.kit.name} · ${this.nameA} ${b.wins[0]} – ${b.wins[1]} ${this.nameB}` : `LIVE · ${this.nameA} vs ${this.nameB}`;
  }

  help(camName: string): string {
    return `V / 1–6 camera: ${camName}${this.cam === 'free' ? ' (WASD, Space/Shift)' : ''}  ·  live  ·  Esc back to the bracket`;
  }

  progress(): null {
    return null;
  }

  resultText(r: RoundResult): string {
    return r.timeout ? 'Draw — they play it again' : `${r.winner === 'a' ? this.nameA : this.nameB} takes the game!`;
  }

  /** A message of the game being watched. */
  handle(msg: ServerMsg) {
    this.net.handle(msg);
    if (msg.t === 'end' && this.endedTicks < 0) {
      this.endedTicks = 0;
      this.lastResult = msg.winner === null ? { winner: 'a', timeout: true } : { winner: msg.winner === 0 ? 'a' : 'b', timeout: false };
    }
  }

  /** The host called the game off (someone left): nothing more will come. */
  cancel() {
    if (this.endedTicks < 0) this.finished = true;
  }

  tick(): boolean {
    this.net.tick();
    if (this.endedTicks >= 0 && ++this.endedTicks >= RESULT_TICKS) this.finished = true;
    return false;
  }

  restart(): boolean {
    return false;
  }

  togglePause() {}

  cycleCam(dir = 1) {
    const i = SPEC_CAMS.indexOf(this.cam);
    this.cam = SPEC_CAMS[(i + dir + SPEC_CAMS.length) % SPEC_CAMS.length];
  }

  changeSpeed() {}
}
