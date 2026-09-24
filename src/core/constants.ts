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

// ---- Shields (Java 1.9+)
/** A raised shield only blocks once it has been held up this long (LivingEntity.isBlocking). */
export const SHIELD_RAISE_TICKS = 5;
/** An axe hit on a raised shield puts it on cooldown for 5 s. */
export const SHIELD_DISABLE_TICKS = 100;
/** Items with an open-ended use (shield, bow, loading crossbow) — vanilla's 72000. */
export const USE_FOREVER = 72000;

// ---- Bows, crossbows and arrows (AbstractArrow / BowItem / CrossbowItem)
export const BOW_FULL_DRAW_TICKS = 20;
export const BOW_MAX_SPEED = 3;
export const CROSSBOW_CHARGE_TICKS = 25;
export const CROSSBOW_SPEED = 3.15;
export const ARROW_BASE_DAMAGE = 2;
export const ARROW_GRAVITY = 0.05;
export const ARROW_DRAG = 0.99;
export const ARROW_INACCURACY = 0.0172275;
/** Arrows stuck in the ground vanish after a minute (1200 ticks). */
export const ARROW_DESPAWN_TICKS = 1200;

// ---- Thrown items (ThrowableProjectile, ThrownSplashPotion, ThrownExperienceBottle)
/** Splash potions and XP bottles are thrown 20° above the crosshair (shootFromRotation). */
export const THROW_PITCH_OFFSET_DEG = 20;
export const POTION_THROW_SPEED = 0.5;
export const POTION_GRAVITY = 0.05;
export const XP_BOTTLE_THROW_SPEED = 0.7;
export const XP_BOTTLE_GRAVITY = 0.07;
export const THROWN_DRAG = 0.99;
/** Splash radius: full strength on a direct hit, fading linearly to nothing 4 blocks out. */
export const SPLASH_RADIUS = 4;

// ---- Experience orbs and Mending
export const XP_ORB_GRAVITY = 0.03;
export const XP_ORB_FOLLOW_RANGE = 8;
/** Player.takeXpDelay: one orb every 2 ticks. */
export const XP_PICKUP_DELAY = 2;
/** Mending repairs 2 durability per experience point. */
export const MENDING_DURABILITY_PER_XP = 2;

// ---- Fire, totems
/** Fire Aspect sets the target alight for 4 s per level. */
export const FIRE_ASPECT_TICKS_PER_LEVEL = 80;
/** Burning deals 1 damage every 20 ticks (Entity.baseTick), ignoring armor points. */
export const FIRE_DAMAGE = 1;
export const TOTEM_REGEN_TICKS = 900; // Regeneration II, 45 s
export const TOTEM_ABSORPTION_TICKS = 100; // Absorption II, 5 s
export const TOTEM_FIRE_RES_TICKS = 800; // Fire Resistance, 40 s
