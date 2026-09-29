import type { Fighter } from '../Fighter';
import type { World } from '../World';

export type ModeId = 'bedwars' | 'skywars';

/** One line of the mode's scoreboard (drawn on the right, like a server sidebar). */
export interface ScoreLine {
  text: string;
  color?: string;
}

/**
 * What a mode runs on: the offline Match or the server's Duel. `player` is team 0 (red), `bot`
 * team 1 (blue).
 */
export interface ModeHost {
  readonly world: World;
  readonly player: Fighter;
  readonly bot: Fighter;
  readonly phase: string;
  readonly fightTicks: number;
  /** A fighter came back to life (the offline bot resets its plan). */
  onRespawn?(f: Fighter): void;
}

type Match = ModeHost;

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
  /** Scoreboard lines for `viewer`. */
  scoreboard(m: Match, viewer: Fighter): ScoreLine[];
  /** A big message for `viewer` right now (respawn countdown…), or null. */
  title(m: Match, viewer: Fighter): { title: string; sub: string } | null;
  /** Announcements since the last call (bed destroyed, final kill…), for the chat. */
  takeAnnouncements(): ScoreLine[];
}

/** Team of a fighter in a two-team mode: the player is red, the bot blue. */
export function teamOf(m: Match, f: Fighter): 0 | 1 {
  return f === m.player ? 0 : 1;
}

export const TEAM_NAMES = ['Red', 'Blue'] as const;
export const TEAM_COLORS = ['#ff5555', '#5555ff'] as const;
