import type { Rng } from '../../core/rng';
import type { Fighter, MoveInput } from '../Fighter';
import type { ItemId } from '../items';
import type { World } from '../World';

export type ModeId = 'bedwars' | 'skywars' | 'sumo' | 'crumble' | 'hotpotato' | 'whodunit';

/** One line of the mode's scoreboard (drawn on the right, like a server sidebar). */
export interface ScoreLine {
  text: string;
  color?: string;
}

/**
 * What a mode runs on: the offline Match or the server's Duel. `player` is team 0 (red), `bot`
 * team 1 (blue); `fighters` is everyone in the game (four in a 2v2), each with their `team`.
 */
export interface ModeHost {
  readonly world: World;
  readonly player: Fighter;
  readonly bot: Fighter;
  readonly fighters: readonly Fighter[];
  readonly phase: string;
  readonly fightTicks: number;
  /** A party minigame played 2v2: you and an ally (every other fighter) against the rest. */
  readonly partyTeams?: boolean;
  /** A fighter came back to life (the offline bot resets its plan). */
  onRespawn?(f: Fighter): void;
}

type Match = ModeHost;

/** A game a bot can play a mode in (the offline Match, or the server's Duel for its bots). */
export interface SkyHost extends ModeHost {
  readonly mode: GameMode | null;
}

/**
 * A minigame on top of a duel (Bed Wars, SkyWars): it builds its map, places the fighters,
 * runs its own rules every tick and decides who has won.
 */
export interface GameMode {
  readonly id: ModeId;
  /** Builds the map and sets the fighters up for a new game (after Match.reset). */
  setup(m: Match): void;
  /** Every tick, after the world's entities. */
  tick(m: Match): void;
  /** The winner, once there is one (a death alone may not end a Bed Wars game). */
  winner(m: Match): Fighter | null;
  /**
   * Everyone on the winning side once `winner` names one, when that's more than the winner alone
   * (Whodunit's innocents win together). Online, each of them is told they won.
   */
  winners?(m: Match): Fighter[];
  /** Scoreboard lines for `viewer`. */
  scoreboard(m: Match, viewer: Fighter): ScoreLine[];
  /** A big message for `viewer` right now (respawn countdown…), or null. */
  title(m: Match, viewer: Fighter): { title: string; sub: string } | null;
  /** Announcements since the last call (bed destroyed, final kill…), for the chat. */
  takeAnnouncements(): ScoreLine[];
  /**
   * Minigames that play their bots themselves (Sumo, Crumble…): one tick of bot `f`. Return false
   * to let the planner's edge guard stop it walking into the void (a mode where standing still
   * loses returns true to skip it).
   */
  botTick?(m: Match, ctl: BotControl): boolean;
  /** A nametag status for `viewer` to see over `f` ('' for nothing); hides roles in Whodunit. */
  tagStatus?(m: Match, f: Fighter, viewer: Fighter): string | null;
}

/** What a minigame's bot logic can do with its bot (built by SkyPlanner from BotBrain). */
export interface BotControl {
  readonly bot: Fighter;
  readonly input: MoveInput;
  /** 0 (LT5) … 1 (HT1). */
  readonly skill: number;
  readonly rng: Rng;
  /** The sword game against `target`: chase, aim, time the hits. */
  fight(target: Fighter): void;
  /** Walks (sprinting) toward (x, z) with no bridging; true once within `stop`. */
  walkTo(x: number, z: number, stop: number, sprint?: boolean): boolean;
  aimAt(x: number, y: number, z: number, gain?: number): void;
  /** Puts `id` in hand (false if it has none). */
  equip(id: ItemId): boolean;
  /** Holds an empty hotbar slot (hides what it carries). */
  emptyHand(): void;
  setLabel(s: string): void;
  /** Sneaks rather than walk off an edge. */
  keepOffEdge(): void;
}

/** Team of a fighter in a two-team mode: red (0) or blue (1). */
export function teamOf(_m: Match, f: Fighter): 0 | 1 {
  return f.team === 0 ? 0 : 1;
}

/** `f`'s place within their team (0, or 1 for the second player of a 2v2): spawns sit side by side. */
export function teamSlot(m: Match, f: Fighter): number {
  return m.fighters.filter((g) => g.team === f.team).indexOf(f);
}

/** Two players a team (2v2). */
export function isTeams(m: Match): boolean {
  return m.fighters.length > 2;
}

/** Everyone on `team`. */
export function members(m: Match, team: number): Fighter[] {
  return m.fighters.filter((f) => f.team === team);
}

export const TEAM_NAMES = ['Red', 'Blue'] as const;
export const TEAM_COLORS = ['#ff5555', '#5555ff'] as const;
