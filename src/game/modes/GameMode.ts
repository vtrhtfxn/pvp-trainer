import type { Fighter } from '../Fighter';
import type { Match } from '../Match';

export type ModeId = 'bedwars' | 'skywars';

/** One line of the mode's scoreboard (drawn on the right, like a server sidebar). */
export interface ScoreLine {
  text: string;
  color?: string;
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
