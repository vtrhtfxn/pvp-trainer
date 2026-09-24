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
  /** Shield, axe and ranged play for the Axe kit. */
  axe: AxeSkill;
  /** Potions, totems and mending for NethPot. */
  neth: NethSkill;
}

export interface NethSkill {
  /** Health at which it throws Splash Healing (a second pot below this − 5). */
  potHP: number;
  /** Degrees it misses "straight down" by when potting — a sloppier pot lands further away and heals less. */
  potNoiseDeg: number;
  /** Ticks between two pots thrown back to back. */
  potGap: number;
  /** Ticks to open the inventory and make the first move (then 2 ticks per extra move). */
  invTicks: number;
  /** Ticks before it notices its off-hand totem popped. */
  totemReact: number;
  /** Keeps a totem in the hotbar and re-totems with slot key + F instead of the inventory. */
  hotbarTotem: boolean;
  /** Re-applies Strength / Speed / Fire Resistance when they run out (otherwise only at the start). */
  rebuff: boolean;
  /** Mends armor with XP bottles once any piece drops below this fraction of durability (0 = never). */
  mendAt: number;
  /** Chance to go for a punish crit (P-crit) when it gets hit. */
  pcrit: number;
  /** Eats a golden apple for absorption when the opponent is at least this far away. */
  gapDist: number;
}

export interface AxeSkill {
  /** Chance, per exchange, that the bot uses its shield when it is threatened. */
  shieldChance: number;
  /**
   * Ticks of warning the bot needs before your hit to have its shield up. A shield only blocks
   * 5 ticks after it is raised, so anything below 5 means some hits get through.
   */
  shieldLead: number;
  /** Extra ticks before it notices you raised or lowered your shield. */
  shieldReact: number;
  /** Disables your shield with an attribute swap: switch to the axe and swing on the same tick. */
  swap: boolean;
  /** Without swapping: ticks between pulling out the axe and swinging it. */
  axeDelay: [number, number];
  /** Chance it drops its own shield and hits you when you pull out your axe. */
  readAxe: number;
  /** 0 = melee only, 1 = uses the crossbow, 2 = crossbow and bow. */
  ranged: 0 | 1 | 2;
  /** Aim error (degrees) on arrows. */
  rangedNoiseDeg: number;
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
    axe: { shieldChance: 0.85, shieldLead: 5, shieldReact: 4, swap: false, axeDelay: [12, 20], readAxe: 0, ranged: 0, rangedNoiseDeg: 4 },
    neth: { potHP: 8, potNoiseDeg: 14, potGap: 6, invTicks: 30, totemReact: 20, hotbarTotem: false, rebuff: false, mendAt: 0, pcrit: 0, gapDist: 6 },
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
    axe: { shieldChance: 0.35, shieldLead: 2, shieldReact: 6, swap: false, axeDelay: [10, 18], readAxe: 0, ranged: 0, rangedNoiseDeg: 4 },
    neth: { potHP: 7, potNoiseDeg: 16, potGap: 6, invTicks: 30, totemReact: 24, hotbarTotem: false, rebuff: false, mendAt: 0, pcrit: 0, gapDist: 7 },
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
    axe: { shieldChance: 0.6, shieldLead: 4, shieldReact: 4, swap: false, axeDelay: [4, 8], readAxe: 0.3, ranged: 1, rangedNoiseDeg: 2.5 },
    neth: { potHP: 9, potNoiseDeg: 9, potGap: 4, invTicks: 14, totemReact: 10, hotbarTotem: true, rebuff: true, mendAt: 0.5, pcrit: 0.25, gapDist: 6.5 },
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
    axe: { shieldChance: 0.82, shieldLead: 5, shieldReact: 2, swap: true, axeDelay: [2, 4], readAxe: 0.6, ranged: 2, rangedNoiseDeg: 1.2 },
    neth: { potHP: 10, potNoiseDeg: 4, potGap: 3, invTicks: 8, totemReact: 5, hotbarTotem: true, rebuff: true, mendAt: 0.7, pcrit: 0.55, gapDist: 6 },
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
    axe: { shieldChance: 0.95, shieldLead: 6, shieldReact: 1, swap: true, axeDelay: [1, 2], readAxe: 0.85, ranged: 2, rangedNoiseDeg: 0.6 },
    neth: { potHP: 11, potNoiseDeg: 2, potGap: 2, invTicks: 5, totemReact: 3, hotbarTotem: true, rebuff: true, mendAt: 0.8, pcrit: 0.8, gapDist: 5.5 },
  },
};

export const DIFFICULTY_ORDER: DifficultyId[] = ['practice', 'easy', 'normal', 'hard', 'expert'];
