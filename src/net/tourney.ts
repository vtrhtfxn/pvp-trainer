import type { KitId } from '../game/kits';
import {
  FIELDS,
  TOURNEY_SIZES,
  botChoice,
  botTakesOver,
  createBracket,
  draftChoose,
  draftStep,
  gameKit,
  isHuman,
  matchById,
  nextMatch,
  recordGame,
  rollDecider,
  simulateMatch,
  startDraft,
  teamSlot,
  type Entrant,
  type FieldId,
  type TMatch,
  type Tournament,
  type TourneySize,
} from '../game/tournament';

/**
 * An online tournament, run by the host: the people in the room plus bots in one
 * double-elimination bracket, one match at a time while everyone else watches the bracket.
 *
 * A match between two people is a real online duel; a person against a bot plays it in their own
 * game and reports the result; bot against bot is simulated straight away. Each match is drafted
 * first (bans, picks, a random decider) with a time limit on every turn. Someone who leaves is
 * replaced by a bot under their name, so the bracket never stalls.
 */

export interface TourMember {
  pid: number;
  name: string;
  /** 0 = LT5 … 9 = HT1: only decides seeds. */
  rating: number;
}

export type LiveStage = 'draft' | 'break' | 'game' | 'done';

/** What everyone in the room is shown (sent whenever anything changes). */
export interface TourView {
  size: TourneySize;
  field: FieldId;
  members: { pid: number; name: string }[];
  host: number;
  /** The player this view was made for. */
  you: number;
  tour: Tournament | null;
  live: { match: string; stage: LiveStage; game: number; pve: boolean; deadlineMs: number | null } | null;
}

export interface TourHooks {
  /** Anything changed: send everyone their view. */
  changed(): void;
  /** Two people play game `n` on `kit`: seat them in a duel (pidA is seat 0). */
  startDuel(pidA: number, pidB: number, kit: KitId): void;
  stopDuel(): void;
  /** A person plays a bot: their own game runs the duel and reports back. */
  playLocal(pid: number, kit: KitId, bot: Entrant): void;
}

/** Time for a person's ban or pick before a bot makes it for them. */
export const DRAFT_TURN_MS = 30_000;
const BOT_TURN_MS = 1200;
/** The decider shown, or a game's result, before the next game starts. */
const BREAK_MS = 4000;
const DONE_MS = 5000;
/** Most people a room's host takes (the rest of the bracket is bots). */
export const MAX_HUMANS = 16;

export function isTourneySetup(v: unknown): v is { size: TourneySize; field: FieldId } {
  const o = v as { size?: unknown; field?: unknown } | null;
  return !!o && TOURNEY_SIZES.includes(o.size as TourneySize) && Object.hasOwn(FIELDS, String(o.field));
}

export class OnlineTourney {
  t: Tournament | null = null;
  members: TourMember[] = [];
  /** Who may start it: whoever made the room (or the longest-standing member after they leave). */
  host = -1;
  private live: { match: string; stage: LiveStage; game: number; pve: boolean; at: number } | null = null;

  constructor(
    readonly size: TourneySize,
    readonly field: FieldId,
    private readonly hooks: TourHooks,
    private readonly now: () => number = () => Date.now(),
    private readonly seed?: number,
  ) {}

  get started(): boolean {
    return this.t !== null;
  }

  /** A player joins the room. False if it is full or already under way. */
  join(m: TourMember): boolean {
    if (this.started || this.members.length >= Math.min(this.size, MAX_HUMANS)) return false;
    this.members.push(m);
    if (this.host < 0) this.host = m.pid;
    this.hooks.changed();
    return true;
  }

  leave(pid: number) {
    this.members = this.members.filter((m) => m.pid !== pid);
    if (this.host === pid) this.host = this.members[0]?.pid ?? -1;
    const t = this.t;
    const e = t?.entrants.find((x) => x.pid === pid);
    if (t && e) {
      botTakesOver(t, e.id);
      e.name = `${e.name} (bot)`;
      const live = this.live;
      if (live && live.stage === 'game' && liveHas(t, live.match, e.id)) {
        // Their game can't go on: a duel against a person goes back to the draft screen and
        // restarts against… whoever is left (a bot plays for them).
        if (!live.pve) this.hooks.stopDuel();
        this.toBreak();
      }
    }
    this.advance();
    this.hooks.changed();
  }

  /** The host starts it: everyone here takes a place, bots fill the rest. */
  start(pid: number): string | null {
    if (this.started) return 'It has already started.';
    if (pid !== this.host) return 'Only the host can start the tournament.';
    this.t = createBracket(this.size, this.field, this.members.map((m) => ({ name: m.name, rating: m.rating, pid: m.pid })), this.seed);
    this.advance();
    this.hooks.changed();
    return null;
  }

  /** A person's ban or pick. */
  draft(pid: number, kit: KitId) {
    const m = this.liveMatch();
    if (!m || this.live!.stage !== 'draft') return;
    const d = m.draft!;
    const step = draftStep(d);
    if (!step || step.kind === 'decider') return;
    const e = this.t!.entrants[m.players[teamSlot(d, step.team)]!];
    if (e.pid !== pid) return;
    if (draftChoose(d, kit)) {
      this.live!.at = this.now();
      this.stepDraft();
      this.hooks.changed();
    }
  }

  /** A person-vs-bot game, played in that person's game, is over. */
  result(pid: number, won: boolean) {
    const m = this.liveMatch();
    const live = this.live;
    if (!m || !live || live.stage !== 'game' || !live.pve) return;
    const me = m.players.findIndex((id) => id !== null && this.t!.entrants[id].pid === pid);
    if (me < 0) return;
    this.record(m, won ? (me as 0 | 1) : ((1 - me) as 0 | 1));
  }

  /** A person-vs-person duel ended: `winner` is the winning player (null: a draw, play it again). */
  duelEnded(winner: number | null) {
    const m = this.liveMatch();
    const live = this.live;
    if (!m || !live || live.stage !== 'game' || live.pve) return;
    this.hooks.stopDuel();
    const slot = m.players.findIndex((id) => id !== null && this.t!.entrants[id].pid === winner);
    if (winner === null || slot < 0) {
      this.toBreak();
      this.hooks.changed();
      return;
    }
    this.record(m, slot as 0 | 1);
  }

  /** Call a few times a second: bot turns, timeouts and the gaps between games. */
  tick() {
    const live = this.live;
    if (!this.t || !live) return;
    const now = this.now();
    if (live.stage === 'draft') {
      const m = this.liveMatch()!;
      const d = m.draft!;
      const step = draftStep(d);
      if (step && step.kind !== 'decider') {
        const e = this.t.entrants[m.players[teamSlot(d, step.team)]!];
        const wait = isHuman(e) ? DRAFT_TURN_MS : BOT_TURN_MS;
        if (now - live.at >= wait) {
          // A bot's turn, or a person who ran out of time: a bot's choice for them.
          draftChoose(d, botChoice(this.t, m));
          live.at = now;
          this.stepDraft();
          this.hooks.changed();
        }
      }
    } else if (live.stage === 'break' && now - live.at >= BREAK_MS) {
      this.startGame();
      this.hooks.changed();
    } else if (live.stage === 'done' && now - live.at >= DONE_MS) {
      this.live = null;
      this.advance();
      this.hooks.changed();
    }
  }

  view(pid: number): TourView {
    const live = this.live;
    let deadlineMs: number | null = null;
    if (live?.stage === 'draft') {
      const m = this.liveMatch()!;
      const step = draftStep(m.draft!);
      if (step && step.kind !== 'decider' && isHuman(this.t!.entrants[m.players[teamSlot(m.draft!, step.team)]!])) deadlineMs = Math.max(0, DRAFT_TURN_MS - (this.now() - live.at));
    } else if (live?.stage === 'break') deadlineMs = Math.max(0, BREAK_MS - (this.now() - live.at));
    return {
      size: this.size,
      field: this.field,
      members: this.members.map((m) => ({ pid: m.pid, name: m.name })),
      host: this.host,
      you: pid,
      tour: this.t,
      live: live ? { match: live.match, stage: live.stage, game: live.game, pve: live.pve, deadlineMs } : null,
    };
  }

  // ---------------------------------------------------------------- internals

  private liveMatch(): TMatch | null {
    return this.t && this.live ? matchById(this.t, this.live.match) : null;
  }

  /** Plays bot matches out until one with a person in it is next; that one goes live. */
  private advance() {
    const t = this.t;
    if (!t || this.live) return;
    for (let m = nextMatch(t); m; m = nextMatch(t)) {
      const people = m.players.filter((id) => isHuman(t.entrants[id!])).length;
      if (people === 0) {
        simulateMatch(t, m);
        continue;
      }
      startDraft(t, m);
      this.live = { match: m.id, stage: 'draft', game: m.games.length, pve: people === 1, at: this.now() };
      this.stepDraft();
      return;
    }
  }

  /** After a draft move: the decider rolls itself, then a short break before game 1. */
  private stepDraft() {
    const m = this.liveMatch()!;
    const step = draftStep(m.draft!);
    if (step?.kind === 'decider') rollDecider(this.t!, m.draft!);
    if (!draftStep(m.draft!)) this.toBreak();
  }

  private toBreak() {
    const m = this.liveMatch()!;
    const people = m.players.filter((id) => isHuman(this.t!.entrants[id!])).length;
    if (people === 0) {
      // Both people left: the bots finish it.
      simulateMatch(this.t!, m);
      this.live = { ...this.live!, stage: 'done', at: this.now() };
      return;
    }
    this.live = { ...this.live!, stage: 'break', game: m.games.length, pve: people === 1, at: this.now() };
  }

  private startGame() {
    const t = this.t!;
    const m = this.liveMatch()!;
    const kit = gameKit(m.draft!, m.games.length)!;
    const [a, b] = m.players.map((id) => t.entrants[id!]);
    this.live = { ...this.live!, stage: 'game', game: m.games.length, at: this.now() };
    if (isHuman(a) && isHuman(b)) this.hooks.startDuel(a.pid!, b.pid!, kit);
    else if (isHuman(a)) this.hooks.playLocal(a.pid!, kit, b);
    else if (isHuman(b)) this.hooks.playLocal(b.pid!, kit, a);
    else this.toBreak();
  }

  private record(m: TMatch, slot: 0 | 1) {
    recordGame(this.t!, m, slot);
    if (m.winner !== null) this.live = { ...this.live!, stage: 'done', at: this.now() };
    else this.toBreak();
    this.hooks.changed();
  }
}

function liveHas(t: Tournament, match: string, entrant: number): boolean {
  return matchById(t, match).players.includes(entrant);
}
