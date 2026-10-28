import { performAttack } from '../game/combat';
import type { Fighter } from '../game/Fighter';
import type { Match } from '../game/Match';

/**
 * Scripted opponents for the Trainer drills: each one presses the bot's keys the way a sparring
 * partner would for that drill — stand still, strafe, walk in and swing on a rhythm, or hold a
 * shield up — using the same physics and combat as a duel.
 */
/**
 * `pace` (0.5–1) is the drill's warm-up: bots strafe slower and swing less often while you are
 * still getting the hang of it, and reach full speed as you succeed (see DrillRun.pace).
 */
export type DrillBot = (m: Match, t: number, pace: number) => void;

const NO_INPUT = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };

/** Turns the bot to look at the player's chest. */
export function face(b: Fighter, p: Fighter, height = 1.2) {
  const dx = p.pos.x - b.pos.x;
  const dz = p.pos.z - b.pos.z;
  const dy = p.pos.y + height - (b.pos.y + b.eyeHeight());
  b.yaw = Math.atan2(-dx, -dz);
  b.pitch = Math.atan2(dy, Math.max(0.25, Math.hypot(dx, dz)));
}

function dist(m: Match): number {
  return Math.hypot(m.player.pos.x - m.bot.pos.x, m.player.pos.z - m.bot.pos.z);
}

/** Keeps to `range` blocks from the player: steps in when further, backs off when closer. */
function keepRange(m: Match, range: number, slack = 0.6): number {
  const d = dist(m);
  return d > range + slack ? 1 : d < range - slack ? -1 : 0;
}

/** Stands still, facing you. */
export const still: DrillBot = (m) => {
  const b = m.bot;
  face(b, m.player);
  b.input = { ...NO_INPUT };
};

/**
 * A target that strafes side to side at `range`, never attacks. `speed` 1 walks, 2 sprints.
 * It walks back in after your knockback, but never runs from you: step in and it stays hittable.
 */
export function strafer(opts: { range?: number; period?: number; speed?: number; /** Side-step strength, 0–1. */ strafe?: number } = {}): DrillBot {
  const range = opts.range ?? 3;
  const period = opts.period ?? 30;
  return (m, t, pace = 1) => {
    const b = m.bot;
    face(b, m.player);
    const dir = Math.floor(t / period) % 2 === 0 ? 1 : -1;
    const d = dist(m);
    const forward = d > range + 0.4 ? 1 : d < 1.2 ? -1 : 0;
    b.input = { ...NO_INPUT, forward, strafe: dir * pace * (opts.strafe ?? 1), sprint: (opts.speed ?? 1) > 1 && pace >= 1 };
  };
}

/**
 * Walks up and swings every `interval` ticks with a fully charged (sprint) hit — the drills for
 * jump resets, P-crits, hit selecting and blocking. `onSwing` sees each swing's tick.
 *
 * Like a real opponent it stays in the fight: after a swing it follows you in for a second (so
 * you can answer it), and between swings it waits at the edge of your reach (`hold`), where a
 * step forward puts it in range — never out at 3.5+ blocks where nothing can land.
 */
export function attacker(opts: {
  interval: [number, number];
  sprint?: boolean;
  range?: number;
  onSwing?: (t: number) => void;
  /** The tick from which the next swing may come (tests use it to time a reaction). */
  onPlan?: (next: number) => void;
  /** Where it waits between swings (default: just inside your 3-block reach). */
  hold?: number;
  /** Ticks it stays in after a swing. */
  linger?: number;
}): DrillBot {
  let next = 40;
  let stayUntil = -1;
  opts.onPlan?.(next);
  return (m, t, pace = 1) => {
    const b = m.bot;
    const p = m.player;
    face(b, p);
    const d = dist(m);
    const ready = t >= next && b.attackStrengthScale(0.5) >= 1;
    // Close in when a swing is due, follow you in right after one, else wait at the edge.
    const want = ready ? 2.3 : t < stayUntil ? 2.4 : opts.hold ?? 2.9;
    b.input = { ...NO_INPUT, forward: d > want + 0.2 ? 1 : d < Math.min(want - 0.9, 1.6) ? -1 : 0, sprint: !!opts.sprint && ready };
    if (ready && d <= (opts.range ?? 2.9)) {
      performAttack(b, p);
      opts.onSwing?.(t);
      stayUntil = t + (opts.linger ?? 20);
      // A slower pace means more time between its swings.
      const gap = opts.interval[0] + Math.floor(Math.random() * (opts.interval[1] - opts.interval[0] + 1));
      next = t + Math.round(gap / Math.max(0.5, pace));
      opts.onPlan?.(next);
    }
  };
}

/**
 * Holds its shield up at you (off hand) and strafes a little; puts it back up as soon as it is
 * off cooldown. `cooldown` shortens the 5 s disable so drills keep moving (undefined = vanilla).
 */
export function shielder(opts: { cooldown?: number } = {}): DrillBot {
  return (m, t, pace = 1) => {
    const b = m.bot;
    face(b, m.player);
    if (opts.cooldown !== undefined && b.shieldCooldown > opts.cooldown) b.shieldCooldown = opts.cooldown;
    const dir = Math.floor(t / 45) % 2 === 0 ? 1 : -1;
    b.input = { ...NO_INPUT, forward: keepRange(m, 2.6, 0.5), strafe: dir * 0.5 * pace };
    if (b.shieldCooldown > 0) {
      if (b.usingItem) b.stopUsingItem();
    } else if (!b.usingItem) {
      b.startUsingItem(true);
    }
  };
}
