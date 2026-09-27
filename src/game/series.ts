import type { DifficultyId, TierId } from '../ai/difficulty';
import type { KitId } from './kits';

/** Longest "first to" a series can be set to. */
export const MAX_FIRST_TO = 20;

/**
 * A "first to N" series against one bot: rounds are replayed against the same kit and tier until
 * one side has N round wins.
 */
export interface Series {
  kit: KitId;
  tier: DifficultyId;
  target: number;
  you: number;
  bot: number;
  /** Commands changed some round, so the series can't earn a tier. */
  modified: boolean;
}

export function newSeries(kit: KitId, tier: DifficultyId, target: number): Series {
  return { kit, tier, target: clampFirstTo(target), you: 0, bot: 0, modified: false };
}

export function clampFirstTo(n: number): number {
  return Math.max(1, Math.min(MAX_FIRST_TO, Math.round(Number.isFinite(n) ? n : 1)));
}

/** Scores a round; returns who took the series, or null while it goes on. */
export function scoreRound(s: Series, won: boolean, modified: boolean): 'you' | 'bot' | null {
  if (won) s.you++;
  else s.bot++;
  s.modified ||= modified;
  if (s.you >= s.target) return 'you';
  if (s.bot >= s.target) return 'bot';
  return null;
}

// ---------------------------------------------------------------- My Tiers

/** Points for holding each tier in a kit (added up over every kit). */
export const TIER_POINTS: Record<TierId, number> = {
  lt5: 1,
  ht5: 2,
  lt4: 3,
  ht4: 4,
  lt3: 6,
  ht3: 10,
  lt2: 20,
  ht2: 30,
  lt1: 45,
  ht1: 60,
};

/** The best tier you have beaten in each kit. */
export type MyTiers = Partial<Record<KitId, TierId>>;

export function isTier(id: DifficultyId): id is TierId {
  return id in TIER_POINTS;
}

/** Winning a series against a tier bot earns that tier in that kit, if it beats the one you have. */
export function awardTier(tiers: MyTiers, kit: KitId, tier: DifficultyId): boolean {
  if (!isTier(tier)) return false;
  const cur = tiers[kit];
  if (cur && TIER_POINTS[cur] >= TIER_POINTS[tier]) return false;
  tiers[kit] = tier;
  return true;
}

export function totalPoints(tiers: MyTiers): number {
  let n = 0;
  for (const t of Object.values(tiers)) if (t && isTier(t)) n += TIER_POINTS[t];
  return n;
}

const TIERS_KEY = 'pvp-trainer.tiers.v1';

export function loadMyTiers(): MyTiers {
  try {
    const raw = localStorage.getItem(TIERS_KEY);
    if (raw) {
      const out: MyTiers = {};
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, string>)) {
        if (isTier(v as DifficultyId)) out[k as KitId] = v as TierId;
      }
      return out;
    }
  } catch {
    /* storage unavailable */
  }
  return {};
}

export function saveMyTiers(t: MyTiers) {
  try {
    localStorage.setItem(TIERS_KEY, JSON.stringify(t));
  } catch {
    /* ignore */
  }
}
