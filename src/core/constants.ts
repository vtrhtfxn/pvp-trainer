// Minecraft Java Edition 1.9+ values. Units: blocks, blocks/tick, ticks (20 per second).
// Sources: Minecraft Wiki (Tutorial:PvP (Java Edition), Melee attack, Knockback) and vanilla
// LivingEntity / Player / FoodData logic.

export const TPS = 20;
export const TICK_MS = 1000 / TPS;

// ---- Player body ----
export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_SNEAK_HEIGHT = 1.5;
export const EYE_HEIGHT = 1.62;
export const EYE_HEIGHT_SNEAK = 1.27;
export const MAX_HEALTH = 20;

// ---- Movement physics ----
export const GRAVITY = 0.08;
export const VERTICAL_DRAG = 0.98;
export const BLOCK_SLIPPERINESS = 0.6; // grass / stone
export const GROUND_FRICTION = BLOCK_SLIPPERINESS * 0.91; // 0.546
export const AIR_FRICTION = 0.91;
export const WALK_SPEED = 0.1; // movement_speed attribute
export const SPRINT_SPEED_MULT = 1.3; // +30% multiply_total modifier
export const AIR_ACCEL = 0.02;
export const AIR_ACCEL_SPRINT = 0.026;
export const JUMP_POWER = 0.42;
export const SPRINT_JUMP_BOOST = 0.2;
export const SNEAK_INPUT_MULT = 0.3;
export const USE_ITEM_INPUT_MULT = 0.2;
export const INPUT_DAMPING = 0.98;
export const JUMP_DELAY_TICKS = 10;
export const MIN_VELOCITY = 0.003;
export const SPRINT_MIN_FOOD = 6; // sprinting needs food > 6
export const DOUBLE_TAP_SPRINT_WINDOW = 7;

// ---- Combat ----
export const ATTACK_REACH = 3.0; // entity_interaction_range
export const INVULNERABLE_TICKS = 20;
export const IFRAME_WINDOW = 10; // hits while invulnerableTime > 10 only deal the excess damage
export const HURT_DURATION = 10;
export const BASE_KNOCKBACK = 0.4;
export const KNOCKBACK_PER_LEVEL = 0.5; // sprint counts as +1 level
export const MAX_KNOCKBACK_Y = 0.4;
export const CRIT_MULTIPLIER = 1.5;
export const STRONG_ATTACK_SCALE = 0.9; // cooldown needed for crits / sprint-knockback
export const SPRINT_HIT_SLOWDOWN = 0.6;
export const SWING_DURATION = 6;
export const FIST_DAMAGE = 1;
export const FIST_ATTACK_SPEED = 4;
export const USE_ITEM_DELAY = 4; // rightClickDelay after starting to use an item

// ---- Hunger ----
export const MAX_FOOD = 20;
export const START_SATURATION = 5;
export const EXHAUSTION_ATTACK = 0.1;
export const EXHAUSTION_DAMAGE = 0.1;
export const EXHAUSTION_JUMP = 0.05;
export const EXHAUSTION_SPRINT_JUMP = 0.2;
export const EXHAUSTION_SPRINT_PER_BLOCK = 0.1;
export const EXHAUSTION_HEAL = 6;
export const EXHAUSTION_MAX = 40;

// ---- Items ----
// Vanilla golden apples take 32 ticks (1.6 s). Set to 30 (1.5 s) as requested.
export const GOLDEN_APPLE_EAT_TICKS = 30;
