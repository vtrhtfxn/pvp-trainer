/**
 * Wire format for online duels.
 *
 * The split follows Minecraft's own: **movement is client-authoritative** (each client runs
 * its own Fighter and reports where it ended up) while **combat is server-authoritative**
 * (the server owns health, hunger, effects, the attack cooldown and knockback). A client that
 * lands a hit does not decide anything — it sends `attack` and the server rules on it, exactly
 * like ServerboundInteractPacket.
 */

import { ITEMS, POTIONS, type Enchants, type ItemId, type ItemStack, type PotionId } from '../game/items';

export const PROTOCOL_VERSION = 6;
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

/**
 * An item stack on the wire. `e` packs Sharpness (bits 0–2), Protection (3–5), crossbow charge
 * (6), Unbreaking (7–8), Fire Aspect (9–10), Mending (11) and the potion (12–14, index + 1);
 * `d` is the durability used.
 */
export type Slot = readonly [id: string, count: number, e?: number, d?: number] | null;

const POTION_IDS = Object.keys(POTIONS) as PotionId[];

export function toSlot(s: ItemStack | null): Slot {
  if (!s) return null;
  const n = s.ench ?? {};
  const e =
    (n.sharpness ?? 0) |
    ((n.protection ?? 0) << 3) |
    (s.charged ? 64 : 0) |
    ((n.unbreaking ?? 0) << 7) |
    ((n.fireAspect ?? 0) << 9) |
    ((n.mending ?? 0) << 11) |
    ((s.potion ? POTION_IDS.indexOf(s.potion) + 1 : 0) << 12);
  if (s.damage) return [s.id, s.count, e, s.damage];
  return e ? [s.id, s.count, e] : [s.id, s.count];
}

export function fromSlot(slot: Slot | undefined): ItemStack | null {
  if (!slot || !(slot[0] in ITEMS)) return null;
  const count = Math.max(1, Math.min(64, Number(slot[1]) | 0));
  const e = Number(slot[2]) | 0;
  const out: ItemStack = { id: slot[0] as ItemId, count };
  const ench: Enchants = {};
  const put = (k: keyof Enchants, v: number) => {
    if (v) ench[k] = v;
  };
  put('sharpness', e & 7);
  put('protection', (e >> 3) & 7);
  put('unbreaking', (e >> 7) & 3);
  put('fireAspect', (e >> 9) & 3);
  put('mending', (e >> 11) & 1);
  if (Object.keys(ench).length) out.ench = ench;
  if (e & 64) out.charged = true;
  const potion = POTION_IDS[((e >> 12) & 7) - 1];
  if (potion) out.potion = potion;
  const d = Number(slot[3]) | 0;
  if (d > 0) out.damage = d;
  return out;
}

/**
 * Item totals keyed by id, enchantments, potion and durability: an inventory rearrangement
 * must not change these (crossbow charge aside).
 */
export function itemTotals(slots: readonly Slot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (!s) continue;
    const key = `${s[0]}:${(Number(s[2]) | 0) & ~64}:${Number(s[3]) | 0}`;
    m.set(key, (m.get(key) ?? 0) + (Number(s[1]) | 0));
  }
  return m;
}

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
  /** Every slot: 0–35 inventory, 36–39 armor, 40 off hand. */
  inv: Slot[];
  /** Ticks left on the shield cooldown. */
  sc: number;
  /** Hand the item in use is in: 0 main, 1 off. */
  uh: number;
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
  blocked: number;
  shieldsDisabled: number;
  arrowsShot: number;
  arrowHits: number;
  attributeSwaps: number;
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
  /** F: swap hands. */
  | { t: 'swap' }
  /** The inventory screen rearranged items; the server checks nothing was created. */
  | { t: 'inv'; slots: Slot[] }
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
  /** Stopped by a raised shield (and disabled it, if `disabled`). */
  shield?: boolean;
  disabled?: boolean;
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
