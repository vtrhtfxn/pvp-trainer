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

export const PROTOCOL_VERSION = 7;
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
 * An item stack on the wire: id, count, enchantments (0 = none), durability used, potion,
 * crossbow charge (1) and the potion of the loaded arrow. Trailing defaults are dropped.
 */
export type Slot =
  | readonly [id: string, count: number, ench?: Record<string, number> | 0, damage?: number, potion?: string, charged?: number, chargedPotion?: string]
  | null;

/** Every enchantment an item can carry (the keys of Enchants). */
const ENCHANT_KEYS: readonly (keyof Enchants)[] = [
  'sharpness',
  'protection',
  'unbreaking',
  'fireAspect',
  'mending',
  'efficiency',
  'power',
  'piercing',
  'blastProtection',
  'featherFalling',
  'knockback',
  'multishot',
  'quickCharge',
  'silkTouch',
  'sweepingEdge',
  'swiftSneak',
  'density',
  'breach',
  'windBurst',
];

export function toSlot(s: ItemStack | null): Slot {
  if (!s) return null;
  const out: (string | number | Record<string, number>)[] = [s.id, s.count];
  const ench = s.ench && Object.keys(s.ench).length ? { ...s.ench } : 0;
  const tail = [ench, s.damage ?? 0, s.potion ?? '', s.charged ? 1 : 0, s.chargedPotion ?? ''];
  let last = tail.length;
  while (last > 0 && !tail[last - 1]) last--;
  for (let k = 0; k < last; k++) out.push(tail[k] as string | number | Record<string, number>);
  return out as unknown as Slot;
}

export function fromSlot(slot: Slot | undefined): ItemStack | null {
  if (!Array.isArray(slot) || typeof slot[0] !== 'string' || !Object.hasOwn(ITEMS, slot[0])) return null;
  const id = slot[0] as ItemId;
  const count = Math.max(1, Math.min(ITEMS[id].maxStack, Number(slot[1]) | 0));
  const out: ItemStack = { id, count };
  const e = slot[2];
  if (e && typeof e === 'object') {
    const ench: Enchants = {};
    for (const k of ENCHANT_KEYS) {
      const v = Number((e as Record<string, number>)[k]) | 0;
      if (v > 0 && v <= 10) ench[k] = v;
    }
    if (Object.keys(ench).length) out.ench = ench;
  }
  const d = Number(slot[3]) | 0;
  if (d > 0) out.damage = d;
  if (typeof slot[4] === 'string' && slot[4] in POTIONS) out.potion = slot[4] as PotionId;
  if (slot[5]) out.charged = true;
  if (typeof slot[6] === 'string' && slot[6] in POTIONS) out.chargedPotion = slot[6] as PotionId;
  return out;
}

/**
 * Item totals keyed by id, enchantments, potion and durability: an inventory rearrangement
 * must not change these (crossbow charge aside).
 */
export function itemTotals(slots: readonly Slot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of slots) {
    const s = fromSlot(raw ?? null);
    if (!s) continue;
    const ench = s.ench ? ENCHANT_KEYS.filter((k) => s.ench![k]).map((k) => `${k}${s.ench![k]}`).join(',') : '';
    // A loaded crossbow counts as a different item, so a layout can't load one for free.
    const key = `${s.id}:${ench}:${s.damage ?? 0}:${s.potion ?? ''}:${s.charged ? 1 : 0}:${s.chargedPotion ?? ''}`;
    m.set(key, (m.get(key) ?? 0) + s.count);
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
  /** Every slot: 0–35 inventory, 36–39 armor, 40 off hand — only when something changed. */
  inv?: Slot[];
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
  /** Gliding with an elytra, and for how long (the pose eases in). */
  ff: boolean;
  fft: number;
  /** Item cooldowns: [itemId, ticksLeft, total]. */
  cd: [string, number, number][];
  /** The block being mined and how far along: [x, y, z, progress], or null. */
  mn: [number, number, number, number] | null;
  /** Fire ticks left (the burning overlay). */
  fire: number;
  /** [effectId, amplifier, durationTicks] */
  eff: [string, number, number][];
  st: Record<string, number>;
  /** Round-trip time in ms, as measured by the server. */
  ping: number;
}

export type NetPhase = 'lobby' | 'countdown' | 'fight' | 'ended';

export type ClientMsg =
  | { t: 'join'; room: string; name: string; v: number; kit?: string }
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
      /** Gliding, and the fall distance the client has measured (crits and mace smashes use it). */
      ff?: boolean;
      fd?: number;
      /** The last teleport (pearl) this client has applied; older moves are ignored. */
      tp?: number;
    }
  | { t: 'attack' }
  | { t: 'use'; down: boolean }
  /** Holding left click on a block: mining. */
  | { t: 'mine'; down: boolean }
  | { t: 'slot'; i: number }
  /** F: swap hands. */
  | { t: 'swap' }
  /** The inventory screen rearranged items; the server checks nothing was created. */
  | { t: 'inv'; slots: Slot[] }
  | { t: 'rematch' }
  | { t: 'pong'; id: number };

/**
 * Server entities, re-sent every tick for the client to draw: arrows [id, x, y, z, yaw, pitch,
 * potion], thrown items [id, kind, potion, x, y, z], end crystals [id, x, y, z], dropped items
 * [id, itemId, count, x, y, z] and XP orbs [id, value, x, y, z].
 */
export interface NetEntities {
  a: (number | string)[][];
  t: (number | string)[][];
  c: number[][];
  it: (number | string)[][];
  o: number[][];
}

/** A fighter event (sound, particles, feedback). Fighter references travel as { f: index }. */
export interface NetEvent {
  on: number;
  e: Record<string, unknown>;
}

export type ServerMsg =
  | { t: 'joined'; you: number; room: string }
  | { t: 'error'; message: string }
  | { t: 'lobby'; room: string; players: { i: number; name: string }[]; kit: string }
  | { t: 'start'; countdown: number; kit: string }
  | {
      t: 'state';
      tick: number;
      phase: NetPhase;
      fightTicks: number;
      countdown: number;
      players: NetFighter[];
      winner: number | null;
      /** Changed block cells since the last state: [index, id, amount, flags] flattened. */
      blocks?: number[];
      ents: NetEntities;
      ev?: NetEvent[];
      /** World events (explosions, splashes, blocks placed/broken, …). */
      we?: Record<string, unknown>[];
    }
  /** Knockback, an explosion or a wind burst moved YOU — the client takes this velocity. */
  | { t: 'motion'; vx: number; vy: number; vz: number }
  /** A pearl moved YOU; moves sent before you applied it are ignored. */
  | { t: 'teleport'; id: number; x: number; y: number; z: number }
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
