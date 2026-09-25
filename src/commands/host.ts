import type { DifficultyId } from '../ai/difficulty';
import { defaultAttributes, type AttributeId, type GameMode } from '../game/attributes';
import type { Fighter } from '../game/Fighter';
import type { KitId } from '../game/kits';
import type { Match } from '../game/Match';
import { defaultGameRules, type GameRules } from '../game/World';

/** A run of chat text; color is a CSS colour (vanilla's § colours map onto these). */
export interface ChatPart {
  t: string;
  c?: string;
  b?: boolean;
  i?: boolean;
  /** Underlined (the bad part of a command in an error). */
  u?: boolean;
}
export type ChatLine = ChatPart[];

export const COLOR = {
  gray: '#aaaaaa',
  darkGray: '#555555',
  red: '#ff5555',
  yellow: '#ffff55',
  gold: '#ffaa00',
  green: '#55ff55',
  aqua: '#55ffff',
  white: '#ffffff',
} as const;

export type Weather = 'clear' | 'rain' | 'thunder';

/**
 * What commands change that outlives one duel — like a singleplayer world's settings. A new duel
 * (R, Restart, /restart) starts with these re-applied; items, effects and health do not carry over.
 */
export interface SessionState {
  tickRate: number;
  frozen: boolean;
  rules: GameRules;
  dayTime: number;
  weather: Weather;
  /** Attribute base values that differ from the default, per fighter. */
  attrs: { player: Partial<Record<AttributeId, number>>; bot: Partial<Record<AttributeId, number>> };
  gameModes: { player: GameMode; bot: GameMode };
}

export function defaultSession(): SessionState {
  return {
    tickRate: 20,
    frozen: false,
    rules: defaultGameRules(),
    dayTime: 6000,
    weather: 'clear',
    attrs: { player: {}, bot: {} },
    gameModes: { player: 'survival', bot: 'survival' },
  };
}

/** True when anything differs from a fresh game (such duels are not recorded). */
export function sessionModified(s: SessionState): boolean {
  const d = defaultSession();
  if (s.tickRate !== d.tickRate || s.frozen) return true;
  for (const k of Object.keys(d.rules) as (keyof GameRules)[]) {
    // Cosmetic rules don't change the fight.
    if (k === 'showDeathMessages' || k === 'sendCommandFeedback' || k === 'doDaylightCycle' || k === 'doImmediateRespawn') continue;
    if (s.rules[k] !== d.rules[k]) return true;
  }
  const base = defaultAttributes();
  for (const who of ['player', 'bot'] as const) {
    for (const [k, v] of Object.entries(s.attrs[who])) if (v !== base[k as AttributeId]) return true;
    if (s.gameModes[who] !== 'survival') return true;
  }
  return false;
}

/** What the command system needs from the game. */
export interface CommandHost {
  /** An online duel: commands can't change a game the server runs. */
  readonly online: boolean;
  /** The offline duel being played (null on the title screen or online). */
  readonly match: Match | null;
  readonly session: SessionState;
  /** Shows a line in chat. */
  print(line: ChatLine): void;
  /** Re-applies session state (rules, attributes, time…) to the running duel. */
  applySession(): void;
  /** Marks this duel as not counting toward records. */
  markCheated(): void;
  /** Starts a new duel, optionally with another kit or bot tier. */
  restart(opts?: { kit?: KitId; tier?: DifficultyId }): void;
  /** /tick step and /tick sprint. */
  step(ticks: number): void;
  sprint(ticks: number): void;
  stopStep(): boolean;
  stopSprint(): boolean;
  /** Average milliseconds per tick lately (for /tick query). */
  msPerTick(): number;
  title(kind: 'title' | 'subtitle' | 'actionbar' | 'clear', text: string): void;
  /** The player's display name in chat. */
  readonly playerName: string;
  /** Chat everyone in the game sees: plain chat, /say or /me (online it goes through the server). */
  broadcast(kind: 'chat' | 'say' | 'me', text: string): void;
  /** Names of everyone in the game (/list). */
  players(): string[];
}

/** Context passed to every command. */
export interface CmdCtx {
  host: CommandHost;
  /** Who ran it (the local player). */
  self: Fighter | null;
}
