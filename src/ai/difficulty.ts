/**
 * Bot strength follows the PvP tier lists: Low Tier 5 (weakest) up to High Tier 1 (the best
 * players there are). Practice is a passive sparring partner outside the ladder.
 */
export type TierId = 'lt5' | 'ht5' | 'lt4' | 'ht4' | 'lt3' | 'ht3' | 'lt2' | 'ht2' | 'lt1' | 'ht1';
export type DifficultyId = 'practice' | TierId;

export interface BotProfile {
  id: DifficultyId;
  name: string;
  tagline: string;
  color: string;
  /** Ticks of delay before the bot "sees" where you are (may be fractional). */
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
  /** Blocks, buckets and webs for UHC. */
  uhc: UhcSkill;
  /** End crystals, respawn anchors and pearls for the Crystal kit. */
  crystal: CrystalSkill;
  /** Wind charges, elytra and mace smashes for the Mace kit. */
  mace: MaceSkill;
}

export interface MaceSkill {
  /** Chance, each time it could, that it wind-charges itself up for a smash. */
  launch: number;
  /** How well it steers in the air onto you (0..1: share of ticks it gets the direction right). */
  steer: number;
  /** Swaps to the elytra after a Wind Burst launch, glides over and dives in, chestplate back on. */
  elytra: boolean;
  /** Picks whichever mace (Density or Breach) does more against your armor at that fall height. */
  pickMace: boolean;
  /** Against your smash: 0 = nothing, 1 = sidestep, 2 = sidestep or raise the shield. */
  defend: number;
  /** Blocks of extra fall it waits for before smashing (more damage, less margin). */
  smashDepth: number;
}

export interface CrystalSkill {
  /** Ticks between two clicks of a combo (obsidian → crystal → hit, anchor → glowstone → blow). */
  clickGap: number;
  /** Ticks it holds its aim on a block or crystal before it clicks. */
  aimSettle: number;
  /** Ticks between two crystal or anchor combos. */
  comboGap: number;
  /** Ticks between looking for a new spot (it re-thinks only this often). */
  thinkTicks: number;
  /** How much its own damage counts against a spot (0 = ignores it). */
  selfWeight: number;
  /** Least damage (after armor) a spot must do to the opponent to be worth it. */
  minDamage: number;
  /** Uses respawn anchors (place, charge with glowstone, blow up). */
  anchors: boolean;
  /** Waits for the opponent's hurt immunity to run out before it blows something up. */
  iframeTiming: boolean;
  /** Hits crystals the opponent placed when that hurts them more than itself. */
  breakTheirs: boolean;
  /** 0 = no pearls, 1 = pearls in from far away, 2 = also pearls out when it is about to die. */
  pearls: 0 | 1 | 2;
  /** Walls itself in (ender chests, else obsidian) to eat when it is low. */
  surround: boolean;
  /** Loads the crossbow with Slow Falling arrows and shoots when you are out of crystal range. */
  crossbow: boolean;
  /**
   * Uses the pickaxe: digs the ground beside you to set obsidian in for foot-level crystals,
   * and mines your surround open.
   */
  mine: boolean;
}

export interface UhcSkill {
  /** Chance, per opening, to pour lava at your feet. */
  lava: number;
  /** Picks its lava back up afterwards (so it can use it again and doesn't walk into it). */
  lavaPickup: boolean;
  /** Chance, per opening, to web you as you come in (or itself when it is being comboed). */
  web: number;
  /** Puts itself out and washes webs off with a water bucket (and picks the water back up). */
  water: boolean;
  /** Pillars up 3 blocks to eat golden apples when it is low and you are close. */
  pillar: boolean;
  /** Breaks blocks in its way (and the pillar you are standing on). */
  mine: boolean;
  /** Eats a golden head (1 s, off cooldown) below this health. */
  headHP: number;
  /** Ticks it holds its aim on a block before it clicks (human settle time). */
  aimSettle: number;
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
  /**
   * Chance, per round, that it throws Strength II and Speed II on itself. The low tiers mostly
   * fight unbuffed, so they are no faster and hit no harder than you do without your own pots.
   */
  buffChance: number;
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

type Skills = Omit<BotProfile, 'id' | 'name' | 'tagline' | 'color' | 'passive'>;

/** Skill 0 = LT5: slow reactions, sloppy aim, short reach, spams clicks. */
const BASIC: Skills = {
  reactionTicks: 6,
  predict: 0.55,
  aimGain: 0.35,
  maxTurnDeg: 16,
  aimNoiseDeg: 3.8,
  maxReach: 2.4,
  chargeMin: 0.4,
  chargeMax: 1,
  halfSwing: false,
  missClickChance: 0.1,
  wtapChance: 0.05,
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
  axe: { shieldChance: 0.25, shieldLead: 1, shieldReact: 7, swap: false, axeDelay: [12, 20], readAxe: 0, ranged: 0, rangedNoiseDeg: 4 },
  neth: { potHP: 7, potNoiseDeg: 16, potGap: 6, invTicks: 30, totemReact: 30, hotbarTotem: false, rebuff: false, mendAt: 0, pcrit: 0, gapDist: 7, buffChance: 0 },
  uhc: { lava: 0.15, lavaPickup: false, web: 0, water: false, pillar: false, mine: false, headHP: 6, aimSettle: 8 },
  crystal: {
    clickGap: 8, aimSettle: 6, comboGap: 30, thinkTicks: 8, selfWeight: 0.3, minDamage: 1,
    anchors: false, iframeTiming: false, breakTheirs: false, pearls: 0, surround: false, crossbow: false, mine: false,
  },
  mace: { launch: 0.25, steer: 0.4, elytra: false, pickMace: false, defend: 0, smashDepth: 0 },
};

/** Skill 2 (from LT2 up): starts to space and W-tap; anchors, pearls, water and a crossbow come in. */
const DECENT: Skills = {
  ...BASIC,
  reactionTicks: 4,
  predict: 0.75,
  aimGain: 0.45,
  maxTurnDeg: 20,
  aimNoiseDeg: 2.6,
  maxReach: 2.65,
  chargeMin: 0.75,
  missClickChance: 0.03,
  wtapChance: 0.25,
  wtapTicks: [2, 4],
  stapChance: 0.05,
  critChance: 0.1,
  jumpResetChance: 0.05,
  hitSelectChance: 0.05,
  strafeChance: 0.35,
  strafeSwitch: [25, 55],
  spacing: 2.7,
  spacingDiscipline: 0.15,
  // Sprint-jumping (7 blocks/s) outruns a player who only sprints (5.6): LT2 and up only.
  chaseSprintJump: true,
  retreatHP: 6.5,
  returnHP: 13,
  eatDistance: 4.5,
  maxRetreatTicks: 55,
  fleeStyle: 'run',
  eatMove: 'walk',
  // Walking while eating can't get away anyway: aborting would only waste the apple.
  abortEatDistance: 0,
  comboEscape: 'jumpreset',
  axe: { shieldChance: 0.5, shieldLead: 3, shieldReact: 5, swap: false, axeDelay: [7, 12], readAxe: 0.15, ranged: 1, rangedNoiseDeg: 3.2 },
  neth: { potHP: 8, potNoiseDeg: 12, potGap: 5, invTicks: 20, totemReact: 18, hotbarTotem: false, rebuff: true, mendAt: 0.4, pcrit: 0.1, gapDist: 7, buffChance: 0.6 },
  uhc: { lava: 0.3, lavaPickup: false, web: 0.15, water: true, pillar: false, mine: true, headHP: 8, aimSettle: 6 },
  crystal: {
    clickGap: 6, aimSettle: 4, comboGap: 20, thinkTicks: 6, selfWeight: 0.5, minDamage: 1.2,
    anchors: true, iframeTiming: false, breakTheirs: false, pearls: 1, surround: false, crossbow: false, mine: false,
  },
  mace: { launch: 0.55, steer: 0.6, elytra: false, pickMace: true, defend: 1, smashDepth: 0.3 },
};

/** Skill 4 = HT2: times its hits, sometimes W-taps and crits; uses the crossbow and hotbar totems. */
const GOOD: Skills = {
  reactionTicks: 3,
  predict: 0.9,
  aimGain: 0.5,
  maxTurnDeg: 22,
  aimNoiseDeg: 2.1,
  maxReach: 2.8,
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
  spacing: 2.95,
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
  neth: { potHP: 9, potNoiseDeg: 9, potGap: 4, invTicks: 12, totemReact: 9, hotbarTotem: true, rebuff: true, mendAt: 0.5, pcrit: 0.25, gapDist: 6.5, buffChance: 1 },
  uhc: { lava: 0.4, lavaPickup: true, web: 0.25, water: true, pillar: false, mine: true, headHP: 9, aimSettle: 5 },
  crystal: {
    clickGap: 4, aimSettle: 3, comboGap: 14, thinkTicks: 5, selfWeight: 0.7, minDamage: 1.5,
    anchors: true, iframeTiming: false, breakTheirs: true, pearls: 1, surround: false, crossbow: true, mine: false,
  },
  mace: { launch: 0.8, steer: 0.75, elytra: true, pickMace: true, defend: 1, smashDepth: 0.6 },
};

/** Skill 6 = LT1: W-taps, jump-resets, crits, attribute swaps, surrounds and digs — every item. */
const STRONG: Skills = {
  reactionTicks: 3,
  predict: 0.95,
  aimGain: 0.6,
  maxTurnDeg: 25,
  aimNoiseDeg: 1.6,
  maxReach: 2.9,
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
  spacing: 3.15,
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
  neth: { potHP: 10, potNoiseDeg: 4, potGap: 3, invTicks: 7, totemReact: 5, hotbarTotem: true, rebuff: true, mendAt: 0.7, pcrit: 0.55, gapDist: 6, buffChance: 1 },
  uhc: { lava: 0.7, lavaPickup: true, web: 0.5, water: true, pillar: true, mine: true, headHP: 11, aimSettle: 3 },
  crystal: {
    clickGap: 2, aimSettle: 2, comboGap: 6, thinkTicks: 3, selfWeight: 0.9, minDamage: 2,
    anchors: true, iframeTiming: true, breakTheirs: true, pearls: 2, surround: true, crossbow: true, mine: true,
  },
  mace: { launch: 0.9, steer: 0.88, elytra: true, pickMace: true, defend: 2, smashDepth: 1 },
};

/** Skill 8 (between LT1 and HT1): tier-tester level — near-perfect timing and spacing. */
const ELITE: Skills = {
  ...STRONG,
  reactionTicks: 2,
  predict: 1,
  aimGain: 0.8,
  maxTurnDeg: 40,
  aimNoiseDeg: 0.8,
  maxReach: 2.97,
  chargeMin: 0.97,
  wtapChance: 0.95,
  wtapTicks: [1, 1],
  stapChance: 0.35,
  critChance: 0.4,
  jumpResetChance: 0.7,
  hitSelectChance: 0.6,
  strafeChance: 0.9,
  strafeSwitch: [8, 25],
  spacing: 3.3,
  spacingDiscipline: 0.85,
  retreatHP: 9,
  returnHP: 17,
  eatDistance: 7.5,
  maxRetreatTicks: 110,
  abortEatDistance: 2.8,
  comboEscape: 'shold',
  axe: { shieldChance: 0.95, shieldLead: 6, shieldReact: 1, swap: true, axeDelay: [1, 2], readAxe: 0.85, ranged: 2, rangedNoiseDeg: 0.6 },
  neth: { potHP: 11, potNoiseDeg: 2, potGap: 2, invTicks: 4, totemReact: 3, hotbarTotem: true, rebuff: true, mendAt: 0.8, pcrit: 0.8, gapDist: 5.5, buffChance: 1 },
  uhc: { lava: 0.9, lavaPickup: true, web: 0.7, water: true, pillar: true, mine: true, headHP: 12, aimSettle: 1 },
  crystal: { ...STRONG.crystal, clickGap: 1, aimSettle: 1, comboGap: 3, thinkTicks: 2, selfWeight: 1 },
  mace: { launch: 0.97, steer: 0.95, elytra: true, pickMace: true, defend: 2, smashDepth: 1.3 },
};

/** Skill 9 = HT1: the best there is — one-tick reactions, perfect spacing, no wasted clicks. */
const BEST: Skills = {
  ...ELITE,
  reactionTicks: 1,
  predict: 1,
  aimGain: 0.9,
  maxTurnDeg: 55,
  aimNoiseDeg: 0.4,
  maxReach: 3.0,
  chargeMin: 0.98,
  wtapChance: 1,
  stapChance: 0.4,
  critChance: 0.45,
  jumpResetChance: 0.85,
  hitSelectChance: 0.75,
  strafeChance: 0.95,
  strafeSwitch: [6, 20],
  spacing: 3.4,
  spacingDiscipline: 0.95,
  retreatHP: 9.5,
  returnHP: 18,
  eatDistance: 8,
  maxRetreatTicks: 120,
  abortEatDistance: 3,
  axe: { shieldChance: 0.98, shieldLead: 7, shieldReact: 0, swap: true, axeDelay: [1, 1], readAxe: 0.95, ranged: 2, rangedNoiseDeg: 0.4 },
  neth: { potHP: 11.5, potNoiseDeg: 1, potGap: 1, invTicks: 2, totemReact: 1, hotbarTotem: true, rebuff: true, mendAt: 0.85, pcrit: 0.9, gapDist: 5, buffChance: 1 },
  uhc: { lava: 0.95, lavaPickup: true, web: 0.8, water: true, pillar: true, mine: true, headHP: 12.5, aimSettle: 1 },
  crystal: { ...ELITE.crystal, clickGap: 0, comboGap: 1, thinkTicks: 1, selfWeight: 1.1 },
  mace: { launch: 1, steer: 1, elytra: true, pickMace: true, defend: 2, smashDepth: 1.5 },
};

/**
 * The hand-tuned profiles, spaced out on a skill scale from 0 (BASIC) to 9 (BEST). Tiers sit
 * somewhere on this scale (TIER_SKILL) and blend the two profiles either side of them.
 */
const ANCHORS: [number, Skills][] = [
  [0, BASIC],
  [2, DECENT],
  [4, GOOD],
  [6, STRONG],
  [8, ELITE],
  [9, BEST],
];

/**
 * Where each tier sits on that scale. The low tiers are packed close together, so each step up
 * from LT5 is a small one and HT4 / LT3 stay beatable; the scale only opens up near the top.
 */
const TIER_SKILL: Record<TierId, number> = { lt5: 0, ht5: 0.25, lt4: 0.5, ht4: 0.8, lt3: 1.2, ht3: 1.7, lt2: 2.5, ht2: 4, lt1: 6, ht1: 9 };

/**
 * Blends two profiles: numbers (and number pairs) linearly — whole numbers stay whole — while
 * on/off skills and styles come from the weaker one, so each skill unlocks at a hand-tuned tier.
 */
/** Numbers that are really levels (0 off, 1, 2 …): like on/off skills, the weaker tier's value. */
const LEVELS = new Set(['ranged', 'pearls', 'defend', 'maxGapsPerRetreat']);
/** Numbers where 0 means "never": a blend must not switch them on early. */
const ZERO_OFF = new Set(['abortEatDistance']);
/**
 * Whole numbers that may blend to fractions: a reaction time of 4.5 ticks is played (see
 * BotBrain.perceive), and rounding it would make it drop a whole tick between two tiers.
 */
const FRACTIONAL = new Set(['reactionTicks']);

function blend<T>(a: T, b: T, t: number, key = ''): T {
  if (LEVELS.has(key) || (ZERO_OFF.has(key) && a === 0)) return a;
  if (typeof a === 'number' && typeof b === 'number') {
    const v = a + (b - a) * t;
    const whole = Number.isInteger(a) && Number.isInteger(b) && !FRACTIONAL.has(key);
    return (whole ? Math.round(v) : Math.round(v * 1000) / 1000) as T;
  }
  if (Array.isArray(a)) return a.map((x, i) => blend(x, (b as unknown[])[i], t)) as T;
  if (a && typeof a === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) out[k] = blend((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], t, k);
    return out as T;
  }
  return a;
}

/** The profile at any point of the skill scale (0 = BASIC … 9 = BEST); tiers use TIER_SKILL. */
export function skillsAt(skill: number): Skills {
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    const [ia, a] = ANCHORS[i];
    const [ib, b] = ANCHORS[i + 1];
    if (skill >= ia && skill < ib) return blend(a, b, (skill - ia) / (ib - ia));
  }
  return ANCHORS[ANCHORS.length - 1][1];
}

const TIERS: { id: TierId; name: string; tagline: string; color: string }[] = [
  { id: 'lt5', name: 'LT5', tagline: 'Low Tier 5 — slow reactions, sloppy aim, short reach, spams clicks. Basic items only.', color: '#aaaaaa' },
  { id: 'ht5', name: 'HT5', tagline: 'High Tier 5 — a touch quicker and steadier than LT5. Basic items only.', color: '#55ff55' },
  { id: 'lt4', name: 'LT4', tagline: 'Low Tier 4 — waits a little longer between clicks, so more of its hits count. Basic items only.', color: '#55ffaa' },
  { id: 'ht4', name: 'HT4', tagline: 'High Tier 4 — steadier aim, a bit more reach, the odd W-tap. Basic items only.', color: '#55ffff' },
  { id: 'lt3', name: 'LT3', tagline: 'Low Tier 3 — quicker reactions and cleaner clicks. Basic items only.', color: '#7f7fff' },
  { id: 'ht3', name: 'HT3', tagline: 'High Tier 3 — times its hits well, starts to crit and jump-reset. Basic items only.', color: '#ffff55' },
  { id: 'lt2', name: 'LT2', tagline: 'Low Tier 2 — sprint-jumps after you; anchors, pearls, water buckets, the crossbow and re-buffing come in.', color: '#ffaa00' },
  { id: 'ht2', name: 'HT2', tagline: 'High Tier 2 — full-charge hits; hotbar totems, lava pickup, Slow Falling crossbow, elytra.', color: '#ff5555' },
  { id: 'lt1', name: 'LT1', tagline: 'Low Tier 1 — every item: attribute swaps, surrounds, digging, pillars, hurt-immunity timing.', color: '#ff55ff' },
  { id: 'ht1', name: 'HT1', tagline: 'High Tier 1 — the best there is: one-tick reactions, full reach, no wasted clicks.', color: '#aa00aa' },
];

export const DIFFICULTIES = {
  // LT5's movement, aim and healing with every attack removed, so you can drill combos, reach
  // and W-taps against a target that still moves like a player.
  practice: {
    ...BASIC,
    id: 'practice',
    name: 'Practice',
    tagline: 'Moves like LT5 but never attacks — free combo and reach practice.',
    color: '#ffffff',
    passive: true,
    missClickChance: 0,
    wtapChance: 0,
    critChance: 0,
    axe: { ...BASIC.axe, shieldChance: 0.85, shieldLead: 5, shieldReact: 4, axeDelay: [12, 20] },
    neth: { ...BASIC.neth, potHP: 8, potNoiseDeg: 14, totemReact: 20, gapDist: 6 },
    uhc: { ...BASIC.uhc, lava: 0, water: true, mine: true, headHP: 8 },
    crystal: { ...BASIC.crystal, clickGap: 10, aimSettle: 8, comboGap: 40, thinkTicks: 10, selfWeight: 1, minDamage: 99 },
    mace: { ...BASIC.mace, launch: 0 },
  },
  ...Object.fromEntries(TIERS.map((t) => [t.id, { ...skillsAt(TIER_SKILL[t.id]), ...t, passive: false }])),
} as Record<DifficultyId, BotProfile>;

export const DIFFICULTY_ORDER: DifficultyId[] = ['practice', ...TIERS.map((t) => t.id)];

/** Settings saved before the tier ladder used these names. */
export const LEGACY_DIFFICULTY: Record<string, DifficultyId> = { easy: 'lt5', normal: 'lt3', hard: 'lt2', expert: 'lt1' };
