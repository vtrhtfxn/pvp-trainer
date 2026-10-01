import type { Fighter, MoveInput } from './Fighter';
import type { ItemStack } from './items';
import type { KitDef } from './kits';
import type { GameRules } from './World';
import { Bedwars } from './modes/Bedwars';
import type { GameMode, ModeHost } from './modes/GameMode';
import { SHOP } from './modes/shop';
import { Skywars } from './modes/Skywars';

/**
 * Replays. The simulation is deterministic (every random number comes from the match seed), so a
 * duel is stored as its seed plus what *you* did each tick — keys, mouse look, clicks and the
 * screens you used. Watching it re-runs the match: the bot, knockback, explosions and blocks all
 * come out exactly the same, at a few bytes per tick.
 */

/** Something you did on a screen between two ticks (the shop, a chest, letting go of an item). */
export type ReplayAction =
  | { k: 'buy'; key: string }
  | { k: 'open' | 'takeAll'; x: number; y: number; z: number }
  | { k: 'take' | 'put'; x: number; y: number; z: number; i: number }
  | { k: 'stopUse' }
  /** /weather, /time or /gamerule changed the world (rain puts out fire, rules change damage). */
  | { k: 'env'; raining: boolean; dayTime: number; rules: GameRules };

/**
 * One tick of input. Fields that did not change since the previous frame are left out, so a
 * frame where you stood still and looked the same way is just `{}`.
 */
export interface ReplayFrame {
  /** forward, strafe, flags (see FLAG_*). */
  m?: [number, number, number];
  y?: number;
  p?: number;
  /** Clicks this tick: what each one hit on screen (null = test it at the tick). */
  c?: (number | null)[];
  s?: number;
  u?: number;
  w?: number;
  a?: ReplayAction[];
  /** The whole inventory (41 slots), when a screen changed it since the last tick. */
  i?: (ItemStack | null)[];
}

const FLAG_JUMP = 1;
const FLAG_SNEAK = 2;
const FLAG_SPRINT = 4;
const FLAG_USE = 8;
const FLAG_ATTACK = 16;
const FLAG_DOUBLE_TAP = 32;

export const REPLAY_VERSION = 1;
/** A position/health checksum is stored this often, to notice a replay that drifted. */
export const CHECK_EVERY = 20;

export interface ReplayHeader {
  v: number;
  /** Built-in kit id; custom kits carry their definition (they may be deleted later). */
  kitId: string;
  customKit?: KitDef;
  profileId: string;
  seed: number;
  playerName: string;
  botName: string;
  rules: GameRules;
  /** /attribute and /gamemode values the duel started with (defaults unless set). */
  attrs: { player: Record<string, number>; bot: Record<string, number> };
  gameModes: { player: string; bot: string };
  dayTime: number;
  raining: boolean;
  /** Date.now() when the duel started. */
  date: number;
}

export interface ReplayData extends ReplayHeader {
  id: string;
  frames: ReplayFrame[];
  checks: number[];
  /** Who won, or null when you left before the end. */
  winner: 'player' | 'bot' | null;
  /** Fight length in ticks (after the countdown). */
  fightTicks: number;
  /** Starred replays are never dropped to make room. */
  starred?: boolean;
}

/** What Match exposes to the recorder at the start of a tick (before it consumes anything). */
export interface PendingInput {
  clicks: readonly number[];
  slot: number | null;
  use: number;
  swap: number;
  useHeld: boolean;
  attackHeld: boolean;
}

const cloneStack = (s: ItemStack): ItemStack => JSON.parse(JSON.stringify(s)) as ItemStack;

/** Everything a player's inventory holds, deep-copied (stacks are changed in place). */
function inventoryOf(f: Fighter): (ItemStack | null)[] {
  const out: (ItemStack | null)[] = [];
  for (let i = 0; i < 41; i++) {
    const s = f.getSlot(i);
    out.push(s ? cloneStack(s) : null);
  }
  return out;
}

function inventoryKey(f: Fighter): string {
  let k = '';
  for (let i = 0; i < 41; i++) {
    const s = f.getSlot(i);
    k += s ? JSON.stringify(s) : '-';
    k += '|';
  }
  return k;
}

/** Rounds positions and health into one number, to compare a replay against the original. */
export function checksum(a: Fighter, b: Fighter): number {
  const v = [a.pos.x, a.pos.y, a.pos.z, a.health, b.pos.x, b.pos.y, b.pos.z, b.health];
  let h = 0;
  for (const n of v) h = (Math.imul(h, 31) + Math.round(n * 1000)) | 0;
  return h;
}

/** Records one match as it is played. Match calls capture() before and after() each tick. */
export class ReplayRecorder {
  readonly frames: ReplayFrame[] = [];
  readonly checks: number[] = [];
  private pending: ReplayAction[] = [];
  private lastInv = '';
  private last = { m: [0, 0, 0] as [number, number, number], y: Number.NaN, p: Number.NaN, s: -1 };
  /** Set when something the replay can't reproduce happened (a command): the recording is dropped. */
  broken = false;

  constructor(readonly header: ReplayHeader) {}

  start(player: Fighter) {
    this.lastInv = inventoryKey(player);
  }

  /** A screen action, between ticks: it goes into the next frame. */
  act(a: ReplayAction) {
    this.pending.push(a);
  }

  capture(player: Fighter, input: PendingInput) {
    const f: ReplayFrame = {};
    const mi = player.input;
    const flags =
      (mi.jump ? FLAG_JUMP : 0) |
      (mi.sneak ? FLAG_SNEAK : 0) |
      (mi.sprint ? FLAG_SPRINT : 0) |
      (input.useHeld ? FLAG_USE : 0) |
      (input.attackHeld ? FLAG_ATTACK : 0) |
      (player.doubleTapSprint ? FLAG_DOUBLE_TAP : 0);
    const m: [number, number, number] = [mi.forward, mi.strafe, flags];
    const l = this.last;
    if (m[0] !== l.m[0] || m[1] !== l.m[1] || m[2] !== l.m[2]) f.m = l.m = m;
    if (!Object.is(player.yaw, l.y)) f.y = l.y = player.yaw;
    if (!Object.is(player.pitch, l.p)) f.p = l.p = player.pitch;
    if (input.clicks.length) f.c = input.clicks.map((c) => (Number.isNaN(c) ? null : c));
    if (input.slot !== null) f.s = input.slot;
    if (input.use) f.u = input.use;
    if (input.swap) f.w = input.swap;
    if (this.pending.length) {
      f.a = this.pending;
      this.pending = [];
    }
    const key = inventoryKey(player);
    if (key !== this.lastInv) {
      f.i = inventoryOf(player);
      this.lastInv = key;
    }
    this.frames.push(f);
  }

  after(player: Fighter, bot: Fighter) {
    this.lastInv = inventoryKey(player);
    if (this.frames.length % CHECK_EVERY === 0) this.checks.push(checksum(player, bot));
  }

  finish(winner: 'player' | 'bot' | null, fightTicks: number): ReplayData | null {
    if (this.broken || this.frames.length === 0) return null;
    return {
      ...this.header,
      id: `${this.header.date.toString(36)}-${this.header.seed.toString(36)}`,
      frames: this.frames.slice(),
      checks: this.checks.slice(),
      winner,
      fightTicks,
    };
  }
}

/** What a replay drives: the match's player controls (Match implements this). */
export interface ReplayTarget extends ModeHost {
  readonly player: Fighter;
  readonly mode: GameMode | null;
  useHeld: boolean;
  attackHeld: boolean;
  queueClick(picked?: number): void;
  queueSlot(i: number): void;
  queueUse(): void;
  queueSwapHands(): void;
}

/** Runs a screen action against the match (live, and again when replaying). */
export function runAction(m: ReplayTarget, a: ReplayAction): string | null | undefined {
  const p = m.player;
  const mode = m.mode;
  switch (a.k) {
    case 'stopUse':
      if (p.usingItem) p.stopUsingItem();
      return undefined;
    case 'env':
      m.world.raining = a.raining;
      m.world.dayTime = a.dayTime;
      Object.assign(m.world.rules, a.rules);
      return undefined;
    case 'buy': {
      const item = SHOP.find((s) => s.key === a.key);
      return item && mode instanceof Bedwars ? mode.buy(m, p, item) : 'No shop';
    }
    case 'open':
      if (mode instanceof Skywars) mode.open(m, p, a.x, a.y, a.z);
      return undefined;
    case 'take':
      if (mode instanceof Skywars) mode.take(p, a.x, a.y, a.z, a.i);
      return undefined;
    case 'takeAll':
      if (mode instanceof Skywars) mode.takeAll(p, a.x, a.y, a.z);
      return undefined;
    case 'put':
      if (mode instanceof Skywars) mode.put(p, a.x, a.y, a.z, a.i);
      return undefined;
  }
}

/** Plays frames back into a match, keeping the values each frame left out. */
export class FrameFeeder {
  private m: [number, number, number] = [0, 0, 0];
  private yaw = 0;
  private pitch = 0;

  /** Sets up the player's controls for the next tick from `f`. */
  apply(t: ReplayTarget, f: ReplayFrame) {
    const p = t.player;
    if (f.m) this.m = f.m;
    if (f.y !== undefined) this.yaw = f.y;
    if (f.p !== undefined) this.pitch = f.p;
    const [forward, strafe, flags] = this.m;
    const input: MoveInput = {
      forward,
      strafe,
      jump: !!(flags & FLAG_JUMP),
      sneak: !!(flags & FLAG_SNEAK),
      sprint: !!(flags & FLAG_SPRINT),
    };
    p.input = input;
    p.doubleTapSprint = !!(flags & FLAG_DOUBLE_TAP);
    t.useHeld = !!(flags & FLAG_USE);
    t.attackHeld = !!(flags & FLAG_ATTACK);
    p.yaw = this.yaw;
    p.pitch = this.pitch;
    if (f.a) for (const a of f.a) runAction(t, a);
    if (f.i) {
      for (let i = 0; i < 41; i++) {
        const s = f.i[i];
        p.setSlot(i, s ? cloneStack(s) : null);
      }
    }
    if (f.s !== undefined) t.queueSlot(f.s);
    for (let n = 0; n < (f.w ?? 0); n++) t.queueSwapHands();
    if (f.c) for (const c of f.c) t.queueClick(c ?? Number.NaN);
    for (let n = 0; n < (f.u ?? 0); n++) t.queueUse();
  }
}

// ------------------------------------------------------------------ saved replays

const STORE_KEY = 'pvp-trainer.replays';
/** Kept replays (oldest unstarred ones go first). */
export const MAX_REPLAYS = 12;
/** localStorage is ~5 MB per site; leave room for settings and records. */
const MAX_BYTES = 3_000_000;

export function loadReplays(): ReplayData[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as ReplayData[];
    return Array.isArray(list) ? list.filter((r) => r && r.v === REPLAY_VERSION && Array.isArray(r.frames)) : [];
  } catch {
    return [];
  }
}

/** Saves the list, dropping the oldest unstarred replays until it fits. Returns what was kept. */
export function saveReplays(list: ReplayData[]): ReplayData[] {
  const keep = list.slice().sort((a, b) => b.date - a.date);
  const trim = () => {
    for (let i = keep.length - 1; i >= 0; i--) {
      if (!keep[i].starred) {
        keep.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  while (keep.length > MAX_REPLAYS && trim());
  let json = `[${keep.map((r) => JSON.stringify(r)).join(',')}]`;
  while (json.length > MAX_BYTES && trim()) json = `[${keep.map((r) => JSON.stringify(r)).join(',')}]`;
  try {
    localStorage.setItem(STORE_KEY, json);
  } catch {
    /* full or blocked: the list still lives in memory for this session */
  }
  return keep;
}
