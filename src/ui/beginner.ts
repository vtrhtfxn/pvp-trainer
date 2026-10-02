import type { DifficultyId } from '../ai/difficulty';
import type { DrillBest } from '../trainer/drills';
import type { Records } from './settings';

/**
 * Getting started: a short path for new players through the drills that matter most, with two
 * easy duels in between, shown on the title screen until it is finished or hidden.
 */

export interface BeginnerStep {
  id: string;
  title: string;
  /** One line on what it teaches. */
  blurb: string;
  /** A Trainer drill to pass, or a sword duel against a bot tier. */
  drill?: string;
  duel?: { tier: DifficultyId; win: boolean };
}

export const BEGINNER_STEPS: BeginnerStep[] = [
  { id: 'cooldown', title: 'Full-charge hits', blurb: 'Wait for the attack cooldown so every hit does full damage.', drill: 'cooldown' },
  { id: 'wtap', title: 'Sprint hits (W-tap)', blurb: 'Hit while sprinting to knock them back further.', drill: 'wtap' },
  { id: 'crit', title: 'Jump crits', blurb: 'Hit on the way down from a jump for 50% more damage.', drill: 'crit' },
  { id: 'first-duel', title: 'Your first duel', blurb: 'Try it all on the Practice bot. Win or lose, it counts.', duel: { tier: 'practice', win: false } },
  { id: 'spacing', title: 'Spacing (S-tap)', blurb: 'Back off after a hit so their swing falls short.', drill: 'spacing' },
  { id: 'lt5', title: 'Beat an LT5 bot', blurb: 'Win a sword duel against the first ranked tier.', duel: { tier: 'lt5', win: true } },
];

export function stepDone(s: BeginnerStep, drills: Record<string, DrillBest>, records: Records): boolean {
  if (s.drill) return !!drills[s.drill]?.passed;
  if (s.duel) {
    const r = records[`sword:${s.duel.tier}`];
    return !!r && (s.duel.win ? r.wins > 0 : r.wins + r.losses > 0);
  }
  return false;
}

/** How far along the path is: the first step not done yet (null once all are done). */
export function beginnerProgress(drills: Record<string, DrillBest>, records: Records): { done: number; next: BeginnerStep | null } {
  const done = BEGINNER_STEPS.filter((s) => stepDone(s, drills, records)).length;
  return { done, next: BEGINNER_STEPS.find((s) => !stepDone(s, drills, records)) ?? null };
}

const HIDDEN_KEY = 'pvp-trainer.beginner.hidden';

export function beginnerHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function setBeginnerHidden(hidden: boolean) {
  try {
    if (hidden) localStorage.setItem(HIDDEN_KEY, '1');
    else localStorage.removeItem(HIDDEN_KEY);
  } catch {
    /* blocked storage: it just shows again next time */
  }
}
