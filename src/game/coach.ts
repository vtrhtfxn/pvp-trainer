import { FrameFeeder, type ReplayData } from './replay';
import { replayMatch } from './ReplayWatch';

/**
 * Match Coach: re-runs a duel's replay and looks at how you fought — every swing with its
 * cooldown, crit and sprint, every miss, every hit you took and what you were doing — then turns
 * the biggest leaks into tips, each with the moments to watch.
 */

export interface CoachTip {
  id: string;
  /** Problem tips first (higher = worse); strengths are 0. */
  weight: number;
  good: boolean;
  title: string;
  detail: string;
  /** Replay ticks worth watching (the frame index), earliest first. */
  moments: number[];
}

export interface CoachReport {
  /** Headline numbers, already formatted. */
  stats: { label: string; value: string }[];
  tips: CoachTip[];
}

interface Tally {
  swings: number;
  hits: number;
  misses: number;
  missesInRange: number;
  weak: number;
  strong: number;
  strongOnGroundNoSprint: number;
  crits: number;
  critChances: number;
  sprintHits: number;
  taken: number;
  takenOnGround: number;
  jumpResets: number;
  trades: number;
  hitWhileEating: number;
  combos: number[];
  ticks: Record<string, number[]>;
}

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

/** Moments spread over the duel: at most `n`, keeping them apart. */
function pick(ticks: number[], n = 3, gap = 60): number[] {
  const out: number[] = [];
  for (const t of ticks) {
    if (out.length >= n) break;
    if (!out.length || t - out[out.length - 1] >= gap) out.push(t);
  }
  return out;
}

export function analyze(data: ReplayData): CoachReport {
  const m = replayMatch(data);
  const feeder = new FrameFeeder();
  const p = m.player;
  const b = m.bot;
  const t: Tally = {
    swings: 0,
    hits: 0,
    misses: 0,
    missesInRange: 0,
    weak: 0,
    strong: 0,
    strongOnGroundNoSprint: 0,
    crits: 0,
    critChances: 0,
    sprintHits: 0,
    taken: 0,
    takenOnGround: 0,
    jumpResets: 0,
    trades: 0,
    hitWhileEating: 0,
    combos: [],
    ticks: {},
  };
  const mark = (k: string, tick: number) => (t.ticks[k] ??= []).push(tick);
  let combo = 0;
  let lastHitAt = -100;
  let eating = false;
  let wasOnGround = true;
  /** Hits taken on the ground, waiting a tick to see whether a jump followed. */
  const pendingReset: number[] = [];
  let jumpedAt = -100;
  const legacy = m.world.legacyCombat;

  for (let i = 0; i < data.frames.length; i++) {
    feeder.apply(m, data.frames[i]);
    const airborne = !p.onGround && p.vel.y < 0;
    m.tick();
    const fighting = m.phase === 'fight' || (m.phase === 'ended' && m.phaseTicks <= 1);
    if (fighting) collect(i);
    for (const f of [p, b]) f.events.length = 0;
    m.world.events.length = 0;
    m.mode?.takeAnnouncements();
    wasOnGround = p.onGround;
    if (m.phase === 'ended' && m.phaseTicks > 1) break;

    function collect(tick: number) {
      for (const e of p.events) {
        if (e.type === 'jump') {
          jumpedAt = tick;
        } else if (e.type === 'eatStart') {
          eating = true;
        } else if (e.type === 'eatDone') {
          eating = false;
        } else if (e.type === 'miss') {
          t.swings++;
          t.misses++;
          const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
          if (d < p.entityReach() + 0.6) {
            t.missesInRange++;
            mark('miss', tick);
          }
        } else if (e.type === 'attack' && e.target === b) {
          t.swings++;
          t.hits++;
          combo++;
          lastHitAt = tick;
          if (!legacy && e.scale < 0.9) {
            t.weak++;
            mark('weak', tick);
          } else {
            t.strong++;
            if (e.crit) t.crits++;
            // A crit needed you falling as you swung; on the ground you could have jumped first.
            if (e.crit || airborne) t.critChances++;
            else mark('nocrit', tick);
            if (e.sprint) t.sprintHits++;
            else if (wasOnGround) {
              t.strongOnGroundNoSprint++;
              mark('nosprint', tick);
            }
          }
        } else if (e.type === 'hurt' && e.attacker === b) {
          t.taken++;
          if (combo > 0) t.combos.push(combo);
          combo = 0;
          if (tick - lastHitAt <= 10) {
            t.trades++;
            mark('trade', tick);
          }
          if (eating || p.usingItem) {
            t.hitWhileEating++;
            mark('eat', tick);
          }
          if (wasOnGround && !legacy) {
            t.takenOnGround++;
            pendingReset.push(tick);
          }
        }
      }
      // A jump reset: jumping on (or right around) the tick the knockback lands.
      while (pendingReset.length && tick - pendingReset[0] >= 1) {
        const h = pendingReset.shift()!;
        if (Math.abs(jumpedAt - h) <= 1) t.jumpResets++;
        else mark('noreset', h);
      }
      if (p.events.some((e) => e.type === 'jump')) jumpedAt = tick;
    }
  }
  if (combo > 0) t.combos.push(combo);
  return report(t, legacy, data);
}

function report(t: Tally, legacy: boolean, data: ReplayData): CoachReport {
  const tips: CoachTip[] = [];
  const maxCombo = Math.max(0, ...t.combos);
  const tip = (id: string, weight: number, title: string, detail: string, key?: string) =>
    tips.push({ id, weight, good: weight === 0, title, detail, moments: key ? pick(t.ticks[key] ?? []) : [] });

  const stats = [
    { label: 'Accuracy', value: t.swings ? `${pct(t.hits, t.swings)}%` : '—' },
    { label: 'Full-charge hits', value: legacy ? '—' : t.hits ? `${pct(t.strong, t.hits)}%` : '—' },
    { label: 'Crits', value: t.strong ? `${pct(t.crits, t.strong)}%` : '—' },
    { label: 'Sprint hits', value: t.strong ? `${pct(t.sprintHits, t.strong)}%` : '—' },
    { label: 'Jump resets', value: legacy ? '—' : t.takenOnGround ? `${t.jumpResets}/${t.takenOnGround}` : '—' },
    { label: 'Best combo', value: String(maxCombo) },
  ];

  if (t.swings < 3 && t.taken < 3) {
    tip('short', 0, 'Too short to judge', 'Fight a little longer and the coach has more to look at.');
    return { stats, tips };
  }

  // 1.9+ cooldown: a swing before the bar refills does a fraction of the damage and no crit.
  if (!legacy && t.hits >= 4) {
    const w = pct(t.weak, t.hits);
    if (w >= 25) {
      tip(
        'weak',
        w,
        `${w}% of your hits were spam clicks`,
        `A swing before the attack cooldown refills does far less damage, never crits and has no sprint knockback. Wait for the bar (about 0.6 s with a sword) — fewer, full hits win trades.`,
        'weak',
      );
    } else if (w <= 8) tip('weak-good', 0, 'You timed your cooldown well', `${100 - w}% of your hits were at full charge.`);
  }

  if (t.swings >= 6) {
    const missRate = pct(t.missesInRange, t.swings);
    if (missRate >= 30) {
      tip(
        'aim',
        missRate * 0.8,
        `${missRate}% of your swings missed at close range`,
        'The opponent was in reach but your crosshair was not on them. Keep the crosshair on their body while strafing — the Trainer’s Aim tracking drill practises exactly this.',
        'miss',
      );
    }
  }

  if (t.strong >= 4) {
    const crit = pct(t.crits, t.strong);
    if (crit < 15 && (t.ticks.nocrit?.length ?? 0) >= 3) {
      tip(
        'crit',
        40 - crit,
        `Only ${crit}% of your full hits were crits`,
        'A crit (hit while falling) does 50% more damage. Jump, and swing on the way down — practise it in the Trainer’s Jump crits drill.',
        'nocrit',
      );
    } else if (crit >= 40) tip('crit-good', 0, 'Great crit rate', `${crit}% of your full hits were crits.`);
    const sprint = pct(t.sprintHits, t.strong);
    if (sprint < 30 && t.strongOnGroundNoSprint >= 3) {
      tip(
        'wtap',
        35 - sprint,
        `Only ${sprint}% of your hits had sprint knockback`,
        'A hit while sprinting knocks them much further, which is how you keep a combo going. Let go of W for a moment (W-tap) between hits so the next one sprints again.',
        'nosprint',
      );
    }
  }

  if (t.hits >= 4 && t.trades >= 3) {
    const share = pct(t.trades, t.taken);
    if (share >= 40) {
      tip(
        'trade',
        share * 0.6,
        `You traded hits ${t.trades} times`,
        'Right after you hit them, they hit you back. Back off a step after each hit (S-tap) so their swing falls short, then come back in — the Trainer’s Spacing drill.',
        'trade',
      );
    }
  }

  if (!legacy && t.takenOnGround >= 4) {
    const r = pct(t.jumpResets, t.takenOnGround);
    if (r < 20) {
      tip(
        'reset',
        30 - r,
        `You jump-reset ${t.jumpResets} of ${t.takenOnGround} hits`,
        'Jumping on the same tick their hit lands cuts the knockback, so you stay in the fight. Practise the timing in the Trainer’s Jump reset drill.',
        'noreset',
      );
    } else if (r >= 50) tip('reset-good', 0, 'Strong jump resets', `You reset ${r}% of the hits you took on the ground.`);
  }

  if (t.hitWhileEating >= 2) {
    tip(
      'eat',
      20 + t.hitWhileEating * 4,
      `You were hit ${t.hitWhileEating} times while eating`,
      'Eating takes over a second and slows you to a walk. Get distance first (or wait until they are knocked away), then eat.',
      'eat',
    );
  }

  if (maxCombo >= 5) tip('combo', 0, `${maxCombo}-hit combo`, 'You kept them in a combo — that is how duels are won.');
  if (data.winner === 'player' && !tips.some((x) => !x.good)) {
    tip('clean', 0, 'Clean fight', 'Nothing big to fix in this one. Try a higher tier.');
  }

  tips.sort((a, b) => b.weight - a.weight);
  return { stats, tips };
}
