/**
 * Wire format for online duels.
 *
 * The split follows Minecraft's own: **movement is client-authoritative** (each client runs
 * its own Fighter and reports where it ended up) while **combat is server-authoritative**
 * (the server owns health, hunger, effects, the attack cooldown and knockback). A client that
 * lands a hit does not decide anything — it sends `attack` and the server rules on it, exactly
 * like ServerboundInteractPacket.
 */

export const PROTOCOL_VERSION = 4;
export const DEFAULT_PORT = 4180;
/** Server simulation rate, matching the single-player sim. */
export const NET_TPS = 20;

/**
 * How far behind the newest snapshot the opponent is drawn, in server ticks.
 *
 * Two ticks (100 ms) is enough to ride out one dropped or late packet, which is what keeps
 * remote movement smooth instead of stuttering. It costs nothing in hit registration because
 * the server rewinds by exactly this much plus the attacker's latency before testing a swing
 * (see Duel.queueAttack) — you hit what you saw.
 */
export const INTERP_TICKS = 2;

/** Never rewind a target further than this; beyond it, lag compensation becomes abuse. */
export const MAX_REWIND_TICKS = 10;

export type Slot = readonly [id: string, count: number] | null;

/** One fighter as the server sees it. Short keys: this goes out 20×/second. */
export interface NetFighter {
  /** 0 = the player who created the room. */
  i: number;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** onGround, sprinting, sneaking, usingItem */
  g: boolean;
  sp: boolean;
  sn: boolean;
  ui: boolean;
  /** useItemRemaining / useItemDuration */
  ur: number;
  ud: number;
  hp: number;
  ab: number;
  food: number;
  sat: number;
  sel: number;
  bar: Slot[];
  /** hurtTime, invulnerableTime, hurtDir */
  ht: number;
  iv: number;
  hd: number;
  dead: boolean;
  dt: number;
  /** attackStrengthTicker — the client shows the cooldown from the authoritative value. */
  ast: number;
  /** Swing counter; the client replays the animation whenever it changes. */
  sw: number;
  /** [effectId, amplifier, durationTicks] */
  eff: [string, number, number][];
  st: NetStats;
  /** Round-trip time in ms, as measured by the server. */
  ping: number;
}

export interface NetStats {
  swings: number;
  hits: number;
  crits: number;
  sprintHits: number;
  damageDealt: number;
  damageTaken: number;
  combo: number;
  maxCombo: number;
  gapplesEaten: number;
  reachSum: number;
  maxReach: number;
}

export type NetPhase = 'lobby' | 'countdown' | 'fight' | 'ended';

export type ClientMsg =
  | { t: 'join'; room: string; name: string; v: number }
  | {
      t: 'move';
      x: number;
      y: number;
      z: number;
      yaw: number;
      pitch: number;
      g: boolean;
      sp: boolean;
      sn: boolean;
      /**
       * Vertical velocity. The server never simulates your movement, so without this it cannot
       * know you are mid-jump — and knockback would replace your rise with its own stale guess,
       * dropping you out of the air.
       */
      vy: number;
    }
  | { t: 'attack' }
  | { t: 'use'; down: boolean }
  | { t: 'slot'; i: number }
  | { t: 'rematch' }
  | { t: 'pong'; id: number };

/** Why a hit mattered — drives sounds, particles and the hit-feedback text. */
export interface NetHit {
  /** Index of the attacker. */
  by: number;
  crit: boolean;
  sprint: boolean;
  strong: boolean;
  /** Attack-cooldown scale the hit landed at. */
  scale: number;
  damage: number;
  reach: number;
  fullHit: boolean;
  /** No damage got through (i-frames). */
  blocked: boolean;
}

export type ServerMsg =
  | { t: 'joined'; you: number; room: string }
  | { t: 'error'; message: string }
  | { t: 'lobby'; room: string; players: { i: number; name: string }[] }
  | { t: 'start'; countdown: number }
  | {
      t: 'state';
      tick: number;
      phase: NetPhase;
      fightTicks: number;
      countdown: number;
      players: NetFighter[];
      winner: number | null;
    }
  /** A knockback impulse for YOU — the client copies it into its own velocity. */
  | { t: 'motion'; vx: number; vy: number; vz: number }
  | { t: 'hit'; hit: NetHit; on: number }
  | { t: 'miss'; by: number }
  | { t: 'eat'; by: number; kind: 'tick' | 'done' }
  | { t: 'end'; winner: number | null }
  | { t: 'ping'; id: number };

export function roomCode(rng: () => number = Math.random): string {
  // No vowels (avoids accidental words) and no look-alike characters.
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
  return s;
}

export function normalizeRoom(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}
