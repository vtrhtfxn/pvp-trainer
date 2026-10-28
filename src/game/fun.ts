import type { DifficultyId } from '../ai/difficulty';
import type { FighterStats } from './Fighter';
import type { KitId } from './kits';

/**
 * The things that make duels add up to something: the Gauntlet (every tier in a row on three
 * lives), Advancements (Minecraft-style goals with a toast when you get one) and the kill
 * effects they unlock (a finisher that plays when the opponent goes down).
 */

// ------------------------------------------------------------------ Gauntlet

/** The ladder, bottom to top: one round against each. */
export const GAUNTLET_TIERS: DifficultyId[] = ['lt5', 'ht5', 'lt4', 'ht4', 'lt3', 'ht3', 'lt2', 'ht2', 'lt1', 'ht1'];
export const GAUNTLET_LIVES = 3;

export interface Gauntlet {
  kit: KitId;
  /** Index into GAUNTLET_TIERS of the bot you face now. */
  round: number;
  lives: number;
  /** Rounds cleared so far. */
  cleared: number;
}

export function newGauntlet(kit: KitId): Gauntlet {
  return { kit, round: 0, lives: GAUNTLET_LIVES, cleared: 0 };
}

export function gauntletTier(g: Gauntlet): DifficultyId {
  return GAUNTLET_TIERS[Math.min(g.round, GAUNTLET_TIERS.length - 1)];
}

/**
 * Scores a round. A win moves you up a tier; a loss costs a life and you face the same tier
 * again. 'cleared' after the top tier falls, 'over' with no lives left.
 */
export function gauntletRound(g: Gauntlet, won: boolean): 'next' | 'retry' | 'cleared' | 'over' {
  if (won) {
    g.cleared++;
    g.round++;
    return g.round >= GAUNTLET_TIERS.length ? 'cleared' : 'next';
  }
  g.lives--;
  return g.lives <= 0 ? 'over' : 'retry';
}

const GAUNTLET_KEY = 'pvp-trainer.gauntlet.best';

/** Best Gauntlet run per kit (rounds cleared). */
export function loadGauntletBest(): Record<string, number> {
  return readJson<Record<string, number>>(GAUNTLET_KEY, {});
}

/** Records a finished run; returns true if it beat the best for that kit. */
export function saveGauntletBest(kit: string, cleared: number): boolean {
  const best = loadGauntletBest();
  if (cleared <= (best[kit] ?? 0)) return false;
  best[kit] = cleared;
  writeJson(GAUNTLET_KEY, best);
  return true;
}

// ------------------------------------------------------------------ kill effects

export type KillEffectId = 'none' | 'lightning' | 'hearts' | 'totem' | 'firework' | 'ender' | 'dragon' | 'rainbow';

export interface KillEffect {
  id: KillEffectId;
  name: string;
  desc: string;
  /** The advancement that unlocks it (none: always yours). */
  unlock?: string;
}

export const KILL_EFFECTS: KillEffect[] = [
  { id: 'none', name: 'None', desc: 'Just the win.' },
  { id: 'lightning', name: 'Lightning', desc: 'A bolt from the sky strikes where they fell.', unlock: 'first_blood' },
  { id: 'hearts', name: 'Heartbreaker', desc: 'A burst of red hearts.', unlock: 'combo5' },
  { id: 'totem', name: 'Totem Burst', desc: 'A totem pop — that didn’t save them.', unlock: 'clutch' },
  { id: 'firework', name: 'Firework', desc: 'A firework bursts over them.', unlock: 'flawless' },
  { id: 'ender', name: 'Ender', desc: 'They vanish in a cloud of ender particles.', unlock: 'allrounder' },
  { id: 'rainbow', name: 'Rainbow Finale', desc: 'Three fireworks in every colour.', unlock: 'gauntlet10' },
  { id: 'dragon', name: 'Dragon’s Breath', desc: 'Purple and gold, with a roar.', unlock: 'ht1' },
];

const EFFECT_KEY = 'pvp-trainer.killEffect';

export function loadKillEffect(unlocked: Set<string>): KillEffectId {
  const id = readJson<string>(EFFECT_KEY, 'none');
  return KILL_EFFECTS.some((e) => e.id === id && effectUnlocked(e, unlocked)) ? (id as KillEffectId) : 'none';
}

export function saveKillEffect(id: KillEffectId) {
  writeJson(EFFECT_KEY, id);
}

export function effectUnlocked(e: KillEffect, unlocked: Set<string>): boolean {
  return !e.unlock || unlocked.has(e.unlock);
}

// ------------------------------------------------------------------ advancements

/** What can earn an advancement: a finished duel, the Trainer, or a Gauntlet run. */
export type AdvEvent =
  | {
      kind: 'duel';
      won: boolean;
      kit: string;
      tier: string;
      stats: FighterStats;
      seconds: number;
      /** Your health (in half hearts) when it ended. */
      health: number;
      online: boolean;
      /** A tier was earned in My Tiers. */
      tierEarned: boolean;
      /** Kits you have won at least one duel with (any tier). */
      kitsWon: number;
    }
  | { kind: 'drills'; passed: number; total: number }
  | { kind: 'gauntlet'; cleared: number; total: number }
  | { kind: 'tournament'; won: boolean; size: number };

export interface Advancement {
  id: string;
  title: string;
  desc: string;
  /** Minecraft's frames: a task, a goal, or a challenge (the purple "Challenge Complete!"). */
  frame: 'task' | 'goal' | 'challenge';
  test(e: AdvEvent): boolean;
}

const HIGH_TIERS = new Set(['ht3', 'lt2', 'ht2', 'lt1', 'ht1']);
const win = (e: AdvEvent): e is Extract<AdvEvent, { kind: 'duel' }> => e.kind === 'duel' && e.won;

export const ADVANCEMENTS: Advancement[] = [
  { id: 'first_blood', title: 'First Blood', desc: 'Win a duel.', frame: 'task', test: (e) => win(e) },
  { id: 'combo5', title: 'Combo Starter', desc: 'Land a 5-hit combo.', frame: 'task', test: (e) => e.kind === 'duel' && e.stats.maxCombo >= 5 },
  { id: 'combo10', title: 'Unstoppable', desc: 'Land a 10-hit combo.', frame: 'challenge', test: (e) => e.kind === 'duel' && e.stats.maxCombo >= 10 },
  { id: 'crits', title: 'Critical Thinking', desc: 'Land 8 critical hits in one duel.', frame: 'goal', test: (e) => e.kind === 'duel' && e.stats.crits >= 8 },
  { id: 'speedrun', title: 'Speedrunner', desc: 'Win a duel in under 15 seconds.', frame: 'goal', test: (e) => win(e) && e.seconds < 15 && e.tier !== 'practice' },
  { id: 'clutch', title: 'Clutch', desc: 'Win with 2 hearts or less left.', frame: 'goal', test: (e) => win(e) && e.health <= 4 },
  { id: 'flawless', title: 'Untouchable', desc: 'Win a duel without taking any damage.', frame: 'challenge', test: (e) => win(e) && e.stats.damageTaken === 0 && e.tier !== 'practice' },
  { id: 'tier', title: 'Climbing the Ladder', desc: 'Earn a tier in My Tiers.', frame: 'task', test: (e) => e.kind === 'duel' && e.tierEarned },
  { id: 'ht3', title: 'High Tier', desc: 'Beat an HT3 bot or higher.', frame: 'goal', test: (e) => win(e) && HIGH_TIERS.has(e.tier) },
  { id: 'ht1', title: 'Legend', desc: 'Beat an HT1 bot.', frame: 'challenge', test: (e) => win(e) && e.tier === 'ht1' },
  { id: 'allrounder', title: 'Jack of All Trades', desc: 'Win duels with 5 different kits.', frame: 'goal', test: (e) => e.kind === 'duel' && e.kitsWon >= 5 },
  { id: 'online', title: 'Worthy Opponent', desc: 'Win an online duel.', frame: 'goal', test: (e) => win(e) && e.online },
  { id: 'student', title: 'Student', desc: 'Pass 5 Trainer drills.', frame: 'task', test: (e) => e.kind === 'drills' && e.passed >= 5 },
  { id: 'graduate', title: 'Graduate', desc: 'Pass every Trainer drill.', frame: 'challenge', test: (e) => e.kind === 'drills' && e.passed >= e.total },
  { id: 'gauntlet3', title: 'Warming Up', desc: 'Clear 3 rounds of a Gauntlet.', frame: 'task', test: (e) => e.kind === 'gauntlet' && e.cleared >= 3 },
  { id: 'tourney', title: 'Main Event', desc: 'Win a tournament.', frame: 'goal', test: (e) => e.kind === 'tournament' && e.won },
  { id: 'tourney32', title: 'Last One Standing', desc: 'Win a 32-player tournament.', frame: 'challenge', test: (e) => e.kind === 'tournament' && e.won && e.size >= 32 },
  { id: 'gauntlet10', title: 'Gauntlet Champion', desc: 'Clear a whole Gauntlet, LT5 to HT1.', frame: 'challenge', test: (e) => e.kind === 'gauntlet' && e.cleared >= e.total },
];

const ADV_KEY = 'pvp-trainer.advancements';

export function loadAdvancements(): Set<string> {
  const list = readJson<unknown>(ADV_KEY, []);
  return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && ADVANCEMENTS.some((a) => a.id === x)) : []);
}

/** Checks an event; saves and returns the advancements it just earned (in list order). */
export function earnAdvancements(e: AdvEvent, have: Set<string>): Advancement[] {
  const fresh = ADVANCEMENTS.filter((a) => !have.has(a.id) && a.test(e));
  if (!fresh.length) return [];
  for (const a of fresh) have.add(a.id);
  writeJson(ADV_KEY, [...have]);
  return fresh;
}

/** The kill effects an advancement unlocks. */
export function rewardsOf(advId: string): KillEffect[] {
  return KILL_EFFECTS.filter((k) => k.unlock === advId);
}

// ------------------------------------------------------------------ storage

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeJson(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* blocked storage: it lasts this session */
  }
}
