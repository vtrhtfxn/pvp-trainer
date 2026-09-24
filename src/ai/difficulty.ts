export type DifficultyId = 'practice' | 'easy' | 'normal' | 'hard' | 'expert';

export interface BotProfile {
  id: DifficultyId;
  name: string;
  tagline: string;
  color: string;
  /** Ticks of delay before the bot "sees" where you are. */
  reactionTicks: number;
  /** 0..1 how much the bot leads your movement to compensate its delay. */
  predict: number;
  /** Fraction of the aim error corrected each tick. */
  aimGain: number;
  maxTurnDeg: number;
  aimNoiseDeg: number;
  /** Bot never swings beyond this distance. */
  maxReach: number;
  /** Practice dummy: moves and heals like normal, but never swings at you. */
  passive: boolean;
  /** Attack-cooldown threshold for a swing, sampled uniformly per swing. */
  chargeMin: number;
  chargeMax: number;
  /** Swing at 92% charge when a crit or sprint hit is available (faster combos). */
  halfSwing: boolean;
  missClickChance: number;
  wtapChance: number;
  wtapTicks: [number, number];
  stapChance: number;
  critChance: number;
  jumpResetChance: number;
  hitSelectChance: number;
  strafeChance: number;
  strafeSwitch: [number, number];
  /** Preferred distance while the sword recharges. */
  spacing: number;
  spacingDiscipline: number;
  chaseSprintJump: boolean;
  /** Health (+absorption) at which the bot runs away to eat. */
  retreatHP: number;
  /** Health (+absorption) the bot wants before it comes back. */
  returnHP: number;
  eatDistance: number;
  maxRetreatTicks: number;
  fleeStyle: 'backpedal' | 'run' | 'sprintjump';
  eatMove: 'stand' | 'walk' | 'sprintjump';
  abortEatDistance: number;
  partingShot: boolean;
  punishEating: boolean;
  maxGapsPerRetreat: number;
  comboEscape: 'none' | 'jumpreset' | 'shold';
}

export const DIFFICULTIES: Record<DifficultyId, BotProfile> = {
  // Easy's movement, aim and healing — with every attack removed, so you can work on
  // combos, reach and W-taps against a target that still moves like a player.
  practice: {
    id: 'practice',
    name: 'Practice',
    tagline: 'Moves like Easy but never attacks — free combo and reach practice.',
    color: '#55ffff',
    reactionTicks: 8,
    predict: 0,
    aimGain: 0.22,
    maxTurnDeg: 9,
    aimNoiseDeg: 5,
    maxReach: 2.5,
    passive: true,
    chargeMin: 0.5,
    chargeMax: 1,
    halfSwing: false,
    missClickChance: 0,
    wtapChance: 0,
    wtapTicks: [2, 4],
    stapChance: 0,
    critChance: 0,
    jumpResetChance: 0,
    hitSelectChance: 0,
    strafeChance: 0.25,
    strafeSwitch: [30, 70],
    spacing: 2.2,
    spacingDiscipline: 0,
    chaseSprintJump: false,
    retreatHP: 6,
    returnHP: 12,
    eatDistance: 3,
    maxRetreatTicks: 40,
    fleeStyle: 'backpedal',
    eatMove: 'stand',
    abortEatDistance: 0,
    partingShot: false,
    punishEating: false,
    maxGapsPerRetreat: 1,
    comboEscape: 'none',
  },
  easy: {
    id: 'easy',
    name: 'Easy',
    tagline: 'Slow reactions, sloppy aim, spams clicks.',
    color: '#55ff55',
    reactionTicks: 8,
    predict: 0,
    aimGain: 0.22,
    maxTurnDeg: 9,
    aimNoiseDeg: 5,
    maxReach: 2.5,
    passive: false,
    chargeMin: 0.5,
    chargeMax: 1,
    halfSwing: false,
    missClickChance: 0.05,
    wtapChance: 0.1,
    wtapTicks: [2, 4],
    stapChance: 0,
    critChance: 0.05,
    jumpResetChance: 0,
    hitSelectChance: 0,
    strafeChance: 0.25,
    strafeSwitch: [30, 70],
    spacing: 2.2,
    spacingDiscipline: 0,
    chaseSprintJump: false,
    retreatHP: 6,
    returnHP: 12,
    eatDistance: 3,
    maxRetreatTicks: 40,
    fleeStyle: 'backpedal',
    eatMove: 'stand',
    abortEatDistance: 0,
    partingShot: false,
    punishEating: false,
    maxGapsPerRetreat: 1,
    comboEscape: 'none',
  },
  normal: {
    id: 'normal',
    name: 'Normal',
    tagline: 'Times its hits, sometimes W-taps and crits.',
    color: '#ffff55',
    reactionTicks: 5,
    predict: 0.3,
    aimGain: 0.4,
    maxTurnDeg: 15,
    aimNoiseDeg: 3,
    maxReach: 2.8,
    passive: false,
    chargeMin: 0.9,
    chargeMax: 1,
    halfSwing: false,
    missClickChance: 0.01,
    wtapChance: 0.45,
    wtapTicks: [2, 3],
    stapChance: 0.1,
    critChance: 0.2,
    jumpResetChance: 0.15,
    hitSelectChance: 0.15,
    strafeChance: 0.5,
    strafeSwitch: [20, 45],
    spacing: 3.1,
    spacingDiscipline: 0.35,
    chaseSprintJump: true,
    retreatHP: 7,
    returnHP: 14,
    eatDistance: 5.5,
    maxRetreatTicks: 70,
    fleeStyle: 'run',
    eatMove: 'walk',
    abortEatDistance: 2.2,
    partingShot: false,
    punishEating: true,
    maxGapsPerRetreat: 1,
    comboEscape: 'jumpreset',
  },
  hard: {
    id: 'hard',
    name: 'Hard',
    tagline: 'W-taps, jump-resets, crits and heals smart.',
    color: '#ffaa00',
    reactionTicks: 3,
    predict: 0.6,
    aimGain: 0.6,
    maxTurnDeg: 25,
    aimNoiseDeg: 1.6,
    maxReach: 2.95,
    passive: false,
    chargeMin: 0.95,
    chargeMax: 1,
    halfSwing: true,
    missClickChance: 0,
    wtapChance: 0.8,
    wtapTicks: [1, 2],
    stapChance: 0.25,
    critChance: 0.35,
    jumpResetChance: 0.45,
    hitSelectChance: 0.4,
    strafeChance: 0.75,
    strafeSwitch: [12, 35],
    spacing: 3.3,
    spacingDiscipline: 0.65,
    chaseSprintJump: true,
    retreatHP: 8,
    returnHP: 16,
    eatDistance: 6.5,
    maxRetreatTicks: 90,
    fleeStyle: 'sprintjump',
    eatMove: 'sprintjump',
    abortEatDistance: 2.5,
    partingShot: true,
    punishEating: true,
    maxGapsPerRetreat: 2,
    comboEscape: 'jumpreset',
  },
  expert: {
    id: 'expert',
    name: 'Expert',
    tagline: 'Tier-tester level: near-perfect timing and spacing.',
    color: '#ff5555',
    reactionTicks: 2,
    predict: 0.9,
    aimGain: 0.8,
    maxTurnDeg: 40,
    aimNoiseDeg: 0.8,
    maxReach: 3.0,
    passive: false,
    chargeMin: 0.97,
    chargeMax: 1,
    halfSwing: true,
    missClickChance: 0,
    wtapChance: 0.95,
    wtapTicks: [1, 1],
    stapChance: 0.35,
    critChance: 0.4,
    jumpResetChance: 0.7,
    hitSelectChance: 0.6,
    strafeChance: 0.9,
    strafeSwitch: [8, 25],
    spacing: 3.4,
    spacingDiscipline: 0.85,
    chaseSprintJump: true,
    retreatHP: 9,
    returnHP: 17,
    eatDistance: 7.5,
    maxRetreatTicks: 110,
    fleeStyle: 'sprintjump',
    eatMove: 'sprintjump',
    abortEatDistance: 2.8,
    partingShot: true,
    punishEating: true,
    maxGapsPerRetreat: 2,
    comboEscape: 'shold',
  },
};

export const DIFFICULTY_ORDER: DifficultyId[] = ['practice', 'easy', 'normal', 'hard', 'expert'];
