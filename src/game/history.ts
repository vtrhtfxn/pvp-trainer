import type { FighterStats } from './Fighter';

/**
 * Your duel history: one small entry per finished duel (against bots, online, in a Gauntlet or a
 * tournament), kept on this computer. The Progress screen turns it into trends — are your aim,
 * crits, combos and trades getting better? — and picks the one thing worth practising next.
 */

export type DuelMode = 'bot' | 'online' | 'gauntlet' | 'tournament' | '2v2';

export interface DuelEntry {
  /** Date.now() when it ended. */
  at: number;
  kit: string;
  /** The bot's tier ('practice', 'lt5' … 'ht1') or 'online'. */
  tier: string;
  mode: DuelMode;
  won: boolean;
  secs: number;
  swings: number;
  hits: number;
  crits: number;
  combo: number;
  /** Damage dealt and taken, in half hearts. */
  dealt: number;
  taken: number;
  /** Average reach of your hits (blocks), 0 without hits. */
  reach: number;
}

export function entryFrom(
  stats: FighterStats,
  o: { kit: string; tier: string; mode: DuelMode; won: boolean; secs: number },
  at = Date.now(),
): DuelEntry {
  return {
    at,
    ...o,
    secs: Math.round(o.secs),
    swings: stats.swings,
    hits: stats.hits,
    crits: stats.crits,
    combo: stats.maxCombo,
    dealt: Math.round(stats.damageDealt * 10) / 10,
    taken: Math.round(stats.damageTaken * 10) / 10,
    reach: stats.hits ? Math.round((stats.reachSum / stats.hits) * 100) / 100 : 0,
  };
}

// ------------------------------------------------------------------ summaries

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

export interface Rates {
  /** Hits per swing. */
  accuracy: number;
  /** Crits per hit. */
  critRate: number;
  /** Average best combo. */
  combo: number;
  /** Damage dealt per damage taken. */
  trade: number;
  winRate: number;
}

export function rates(list: readonly DuelEntry[]): Rates {
  return {
    accuracy: ratio(sum(list.map((e) => e.hits)), sum(list.map((e) => e.swings))),
    critRate: ratio(sum(list.map((e) => e.crits)), sum(list.map((e) => e.hits))),
    combo: ratio(sum(list.map((e) => e.combo)), list.length),
    trade: ratio(sum(list.map((e) => e.dealt)), Math.max(1, sum(list.map((e) => e.taken)))),
    winRate: ratio(list.filter((e) => e.won).length, list.length),
  };
}

/** Wins in a row at the end of the list (newest last), and the longest run anywhere. */
export function streaks(list: readonly DuelEntry[]): { current: number; best: number } {
  let best = 0;
  let run = 0;
  for (const e of list) {
    run = e.won ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return { current: run, best };
}

export interface KitLine {
  kit: string;
  duels: number;
  wins: number;
  accuracy: number;
}

export function perKit(list: readonly DuelEntry[]): KitLine[] {
  const by = new Map<string, DuelEntry[]>();
  for (const e of list) by.set(e.kit, [...(by.get(e.kit) ?? []), e]);
  return [...by.entries()]
    .map(([kit, es]) => ({ kit, duels: es.length, wins: es.filter((e) => e.won).length, accuracy: rates(es).accuracy }))
    .sort((a, b) => b.duels - a.duels);
}

/**
 * One value per duel over the last `n` (oldest first), each a rolling average of up to `win`
 * duels so one odd game doesn't make the line jump.
 */
export function trend(list: readonly DuelEntry[], pick: (r: Rates) => number, n = 30, win = 5): number[] {
  const out: number[] = [];
  const start = Math.max(0, list.length - n);
  for (let i = start; i < list.length; i++) out.push(pick(rates(list.slice(Math.max(0, i - win + 1), i + 1))));
  return out;
}

export interface Focus {
  title: string;
  why: string;
  /** The Trainer drill that practises it (null: nothing stands out). */
  drill: string | null;
}

/** Below these, a stat is worth working on (rough marks for a decent player against bots). */
const TARGET = { accuracy: 0.6, critRate: 0.22, combo: 3, trade: 1.1 };

/**
 * The one thing to practise next: of accuracy, crits, combos and trades, the one furthest
 * below its mark over your last 10 duels (needs 3 or more).
 */
export function focus(list: readonly DuelEntry[]): Focus | null {
  const recent = list.slice(-10).filter((e) => e.swings > 0);
  if (recent.length < 3) return null;
  const r = rates(recent);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const gaps: (Focus & { gap: number })[] = [
    {
      gap: 1 - r.accuracy / TARGET.accuracy,
      title: 'Aim',
      why: `Only ${pct(r.accuracy)} of your swings land. Keep your crosshair on them and click when they're in reach, not before.`,
      drill: 'aim',
    },
    {
      gap: 1 - r.critRate / TARGET.critRate,
      title: 'Crits',
      why: `${pct(r.critRate)} of your hits are crits. Jump, and hit them on the way down — a crit does 50% more.`,
      drill: 'crit',
    },
    {
      gap: 1 - r.combo / TARGET.combo,
      title: 'Combos',
      why: `Your best combo averages ${r.combo.toFixed(1)} hits. W-tap after each sprint hit so the next one still knocks them back.`,
      drill: 'combo',
    },
    {
      gap: 1 - r.trade / TARGET.trade,
      title: 'Trading',
      why: `You deal ${r.trade.toFixed(2)}× the damage you take. Hold the edge of your reach and step in only when your sword is charged.`,
      drill: 'spacing',
    },
  ];
  gaps.sort((a, b) => b.gap - a.gap);
  const worst = gaps[0];
  if (worst.gap <= 0) {
    return { title: 'Looking sharp', why: `Aim ${pct(r.accuracy)}, crits ${pct(r.critRate)}, combos ${r.combo.toFixed(1)} — all above the marks. Try a tier up.`, drill: null };
  }
  return { title: worst.title, why: worst.why, drill: worst.drill };
}

// ------------------------------------------------------------------ storage

const KEY = 'pvp-trainer.history.v1';
/** Kept duels (the oldest go first). */
export const HISTORY_MAX = 400;

export function loadHistory(): DuelEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e): e is DuelEntry =>
        !!e && typeof e === 'object' && typeof e.kit === 'string' && typeof e.won === 'boolean' && Number.isFinite(e.at) && Number.isFinite(e.swings) && Number.isFinite(e.hits),
    );
  } catch {
    return [];
  }
}

export function saveHistory(list: readonly DuelEntry[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-HISTORY_MAX)));
  } catch {
    /* storage blocked: it lasts this session */
  }
}

/** Adds a finished duel (newest last) and saves. */
export function recordDuel(list: DuelEntry[], e: DuelEntry): DuelEntry[] {
  list.push(e);
  if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
  saveHistory(list);
  return list;
}
