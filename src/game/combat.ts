import * as C from '../core/constants';
import { V3, rayAABB, type AABB } from '../core/math';
import { applyKnockback, type Fighter } from './Fighter';
import type { RayHit } from './Blocks';
import { defOf, sharpnessBonus } from './items';
import { windExplosion } from './Explosion';

/**
 * Damage after armor points and toughness (CombatRules.getDamageAfterAbsorb). Breach (on the
 * attacker's mace) takes 0.15 per level straight off the armor's damage-reduction fraction.
 */
export function damageAfterArmor(damage: number, armor: number, toughness: number, breach = 0): number {
  const f = 2 + toughness / 4;
  const effective = Math.min(Math.max(armor - damage / f, armor * 0.2), 20);
  let fraction = effective / 25;
  if (breach > 0) fraction = Math.min(1, Math.max(0, fraction - 0.15 * breach));
  return damage * (1 - fraction);
}

/**
 * MaceItem.getAttackDamageBonus: a smash adds 4 per block for the first 3 blocks fallen, 2 per
 * block up to 8, then 1 per block — plus Density's 0.5 per level per block.
 */
export function smashBonus(fall: number, density = 0): number {
  const base = fall <= 3 ? 4 * fall : fall <= 8 ? 12 + 2 * (fall - 3) : 22 + (fall - 8);
  return base + 0.5 * density * fall;
}

export function canSmash(f: Fighter): boolean {
  return f.heldStack()?.id === 'mace' && f.fallDistance > C.SMASH_MIN_FALL && !f.fallFlying;
}

/** Damage after Protection enchantments (CombatRules.getDamageAfterMagicAbsorb). */
export function damageAfterProtection(damage: number, epf: number): number {
  const f = Math.min(Math.max(epf, 0), 20);
  return damage * (1 - f / 25);
}

const tmpEye = new V3();
const tmpDir = new V3();
const tmpBox: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const rayHit: RayHit = { t: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, id: 0 };

/** Distance along the attacker's crosshair ray to the target hitbox, or -1 if out of reach. */
export function rayDistanceToTarget(attacker: Fighter, target: Fighter, reach = C.ATTACK_REACH): number {
  if (target.dead) return -1;
  attacker.eyePos(tmpEye);
  attacker.look(tmpDir);
  const t = rayAABB(tmpEye, tmpDir, target.aabbInto(tmpBox));
  if (t < 0 || t > reach) return -1;
  // A block between us (placed planks, a pillar) is what the crosshair hits instead.
  const blocks = attacker.world.blocks;
  if (blocks.count && blocks.raycast(tmpEye.x, tmpEye.y, tmpEye.z, tmpDir.x, tmpDir.y, tmpDir.z, t, 'outline', rayHit)) return -1;
  return t;
}

/**
 * LivingEntity.isDamageSourceBlocked: a raised shield covers the whole front half — the source
 * (attacker, or the arrow itself) only has to be in front of the defender's horizontal facing.
 */
export function shieldFaces(defender: Fighter, fromX: number, fromZ: number): boolean {
  let dx = defender.pos.x - fromX;
  let dz = defender.pos.z - fromZ;
  const len = Math.hypot(dx, dz);
  if (len < 1e-7) return false;
  dx /= len;
  dz /= len;
  // View vector with pitch 0: (-sin yaw, -cos yaw) in our convention.
  return dx * -Math.sin(defender.yaw) + dz * -Math.cos(defender.yaw) < 0;
}

export interface HurtResult {
  damaged: boolean;
  fullHit: boolean;
  dealt: number;
}

const NO_DAMAGE: HurtResult = { damaged: false, fullHit: false, dealt: 0 };

/**
 * LivingEntity.hurt + Player.actuallyHurt. `fire` is burning (the on_fire damage type): Fire
 * Resistance cancels it outright, and it skips armor points (so it doesn't wear armor either)
 * but Protection still reduces it. Lethal damage pops a totem if one is held.
 */
/** Damage types with their own enchantment protection (Blast Protection, Feather Falling). */
export type DamageKind = 'generic' | 'explosion' | 'fall';

export function hurt(
  target: Fighter,
  amount: number,
  attacker: Fighter | null,
  crit: boolean,
  fire = false,
  bypassArmor = fire,
  kind: DamageKind = 'generic',
  breach = 0,
): HurtResult {
  if (target.dead || amount <= 0) return NO_DAMAGE;
  if (fire && target.effects.has('fire_resistance')) return NO_DAMAGE;
  amount *= target.world.damageMultiplier;
  let fullHit: boolean;
  let applied: number;
  if (target.invulnerableTime > C.IFRAME_WINDOW) {
    if (amount <= target.lastHurt) return { damaged: false, fullHit: false, dealt: 0 };
    applied = amount - target.lastHurt;
    target.lastHurt = amount;
    fullHit = false;
  } else {
    target.lastHurt = amount;
    target.invulnerableTime = C.INVULNERABLE_TICKS;
    applied = amount;
    target.hurtTime = target.hurtDuration = C.HURT_DURATION;
    fullHit = true;
  }

  let dmg = applied;
  if (!bypassArmor) {
    target.damageArmor(applied);
    dmg = damageAfterArmor(applied, target.armor.points, target.armor.toughness, breach);
  }
  const a = target.armor;
  dmg = damageAfterProtection(dmg, a.protectionEpf + (kind === 'explosion' ? a.blastEpf : kind === 'fall' ? a.fallEpf : 0));
  const absorbed = Math.min(target.absorption, dmg);
  target.absorption -= absorbed;
  const toHealth = dmg - absorbed;
  if (toHealth > 0) {
    target.causeExhaustion(C.EXHAUSTION_DAMAGE);
    target.health -= toHealth;
  }
  target.stats.damageTaken += dmg;
  target.stats.combo = 0;
  if (fullHit && attacker) {
    const dx = attacker.pos.x - target.pos.x;
    const dz = attacker.pos.z - target.pos.z;
    // Minecraft yaw of the victim: mcYaw = 180° - our yaw.
    const mcYawDeg = 180 - (target.yaw * 180) / Math.PI;
    target.hurtDir = (Math.atan2(dz, dx) * 180) / Math.PI - mcYawDeg;
  }
  target.events.push({ type: 'hurt', attacker, damage: dmg, crit, fire });
  if (target.health <= 1e-4 && !target.tryTotem()) target.die();
  return { damaged: true, fullHit, dealt: dmg };
}

export interface AttackOutcome {
  hit: boolean;
  reach: number;
  crit: boolean;
  sprint: boolean;
  scale: number;
  damage: number;
  /** The swing landed on a raised shield. */
  blocked: boolean;
  /** ...and it was an axe, so that shield is now on cooldown. */
  disabled: boolean;
  /** Used the previous item's attack attributes (hotbar swap on the same tick). */
  swap: boolean;
}

/**
 * A left click: Minecraft.startAttack + Player.attack. Clicking always swings and resets
 * the attack cooldown, even when it misses — that is what punishes spam-clicking in 1.9+.
 */
export function performAttack(attacker: Fighter, target: Fighter): AttackOutcome {
  const miss: AttackOutcome = { hit: false, reach: -1, crit: false, sprint: false, scale: 0, damage: 0, blocked: false, disabled: false, swap: false };
  if (attacker.dead || attacker.usingItem) return miss;
  attacker.stats.swings++;
  const reach = rayDistanceToTarget(attacker, target);
  if (reach < 0) {
    attacker.resetAttackStrength();
    attacker.swing();
    attacker.events.push({ type: 'miss' });
    return miss;
  }

  // Attack damage and the cooldown come from the attribute item (what was held at the last
  // tick); enchantments and special effects come from the weapon in hand right now.
  const weapon = attacker.heldStack();
  const swap = (weapon?.id ?? null) !== attacker.attrId;
  const scale = attacker.attackStrengthScale(0.5);
  let base = attacker.attackDamage() * (0.2 + scale * scale * 0.8);
  const ench = sharpnessBonus(weapon?.ench?.sharpness ?? 0) * scale;
  attacker.resetAttackStrength();

  if (target.isBlocking() && shieldFaces(target, attacker.pos.x, attacker.pos.z)) {
    return hitShield(attacker, target, reach, scale, swap, base + ench);
  }

  const strong = scale > C.STRONG_ATTACK_SCALE;
  // The Knockback enchantment adds a level on top of the sprint's.
  let kbLevel = weapon?.ench?.knockback ?? 0;
  let sprint = false;
  if (attacker.serverSprinting && strong) {
    kbLevel++;
    sprint = true;
  }
  // The mace's smash bonus (Item.getAttackDamageBonus) joins the damage after the cooldown
  // scaling and before the crit check, so a critical smash multiplies it too.
  const smash = canSmash(attacker);
  const fall = attacker.fallDistance;
  if (smash) base += smashBonus(fall, weapon?.ench?.density ?? 0);
  // Gliding counts as falling (an elytra holds fall distance at 1), so elytra hits can crit.
  const crit = strong && attacker.fallDistance > 0 && !attacker.onGround && !attacker.inWater && !attacker.serverSprinting;
  if (crit) base *= C.CRIT_MULTIPLIER;
  const total = base + ench;

  // The server computes knockback on its own copy of the victim's velocity and sends the
  // result to the victim's client (ClientboundSetEntityMotionPacket), which replaces its own.
  const kbVel = target.serverVel.clone();
  const res = hurt(target, total, attacker, crit, false, false, 'generic', weapon?.ench?.breach ?? 0);
  attacker.swing();
  if (smash && res.damaged) {
    // MaceItem.hurtEnemy: the attacker stops falling (vy 0.01) and takes no damage from the rest
    // of the fall; Wind Burst then launches them from where they are.
    attacker.vel.y = attacker.serverVel.y = 0.01;
    attacker.fallDistance = 0;
    attacker.impulseY = attacker.pos.y;
    attacker.stats.smashes++;
    attacker.stats.maxSmash = Math.max(attacker.stats.maxSmash, res.dealt);
    attacker.events.push({ type: 'smash', fall, damage: res.dealt });
  }
  if (!res.damaged) {
    attacker.events.push({ type: 'noDamage', target });
    return { ...miss, reach, scale };
  }

  // Weapon wear and Fire Aspect only follow a hit that actually did damage.
  if (weapon) {
    const cost = defOf(weapon).hitCost ?? 0;
    const fa = weapon.ench?.fireAspect ?? 0;
    if (fa > 0 && !target.dead) target.ignite(fa * C.FIRE_ASPECT_TICKS_PER_LEVEL);
    if (cost) attacker.damageItem(attacker.selected, cost);
  }

  const resist = 1 - target.armor.knockbackResistance;
  if (res.fullHit) {
    applyKnockback(
      kbVel,
      C.BASE_KNOCKBACK * resist,
      attacker.pos.x - target.pos.x,
      attacker.pos.z - target.pos.z,
      target.onGround,
    );
  }
  if (kbLevel > 0) {
    if (res.fullHit) {
      // Pushes along the attacker's facing (Minecraft passes sin(yaw), -cos(yaw)).
      applyKnockback(
        kbVel,
        kbLevel * C.KNOCKBACK_PER_LEVEL * resist,
        Math.sin(attacker.yaw),
        Math.cos(attacker.yaw),
        target.onGround,
      );
    }
    attacker.vel.x *= C.SPRINT_HIT_SLOWDOWN;
    attacker.vel.z *= C.SPRINT_HIT_SLOWDOWN;
    attacker.serverVel.x *= C.SPRINT_HIT_SLOWDOWN;
    attacker.serverVel.z *= C.SPRINT_HIT_SLOWDOWN;
    attacker.sprinting = false;
    attacker.serverSprinting = false;
  }
  if (res.fullHit) {
    // 15w49a: an airborne victim takes horizontal knockback only. Their own vertical motion is
    // left completely alone — that is what lets a jump keep its arc through a hit, and what
    // makes jump-resets work. Only a grounded victim gets the upward component.
    const vy = target.onGround ? kbVel.y : target.vel.y;
    target.vel.set(kbVel.x, vy, kbVel.z);
    // LivingEntity.knockback keeps the result on the server entity too, where it decays with
    // friction. The next hit's `vel / 2` term starts from it, which is what makes knockback
    // stack through a combo instead of resetting to the same push every time.
    target.serverVel.set(kbVel.x, vy, kbVel.z);
  }

  // Player.attack's sweep: a full-charge sword hit with no crit, no sprint knockback, on the
  // ground and barely moving. It would also hit anyone else within a block of the target (for
  // 1 + damage × level/(level+1) with Sweeping Edge) — in a duel there is no one else, so it is
  // just the sweep arc and sound.
  const moved = Math.hypot(attacker.pos.x - attacker.prevPos.x, attacker.pos.z - attacker.prevPos.z);
  if (strong && !crit && !sprint && attacker.onGround && moved < attacker.movementSpeed() && defOf(weapon).tool === 'sword') {
    const d = attacker.look(new V3());
    attacker.events.push({ type: 'sweep', x: attacker.pos.x + d.x, y: attacker.pos.y + attacker.height() * 0.5, z: attacker.pos.z + d.z });
  }

  // Wind Burst (post-attack, after the hit's knockback): a radius-3.5 gust at the attacker's feet
  // that launches them back up — and pushes the target away too.
  const wb = smash ? (weapon?.ench?.windBurst ?? 0) : 0;
  if (wb > 0) windExplosion(attacker.world, attacker.pos.x, attacker.pos.y, attacker.pos.z, 3.5, [1.2, 1.75, 2.2][wb - 1] ?? 1.5 + 0.35 * wb);

  attacker.causeExhaustion(C.EXHAUSTION_ATTACK);
  const s = attacker.stats;
  s.hits++;
  if (crit) s.crits++;
  if (sprint) s.sprintHits++;
  s.damageDealt += res.dealt;
  s.combo++;
  s.maxCombo = Math.max(s.maxCombo, s.combo);
  s.reachSum += reach;
  s.maxReach = Math.max(s.maxReach, reach);
  if (swap) s.attributeSwaps++;
  attacker.events.push({
    type: 'attack',
    target,
    crit,
    sprint,
    strong,
    enchanted: ench > 0,
    scale,
    damage: res.dealt,
    reach,
    fullHit: res.fullHit,
    swap,
  });
  return { hit: true, reach, crit, sprint, scale, damage: res.dealt, blocked: false, disabled: false, swap };
}

/**
 * A melee hit that lands on a raised shield (LivingEntity.hurt with the damage fully blocked):
 * no damage and no knockback reach the defender's client, the attacker keeps their sprint, and
 * an axe in the attacker's hand disables the shield. The defender still gets fresh i-frames
 * with lastHurt = 0, so a follow-up inside half a second deals full damage without knockback.
 */
function hitShield(attacker: Fighter, target: Fighter, reach: number, scale: number, swap: boolean, damage: number): AttackOutcome {
  const weapon = defOf(attacker.heldStack());
  attacker.swing();
  target.damageShield(damage);
  if (target.invulnerableTime <= C.IFRAME_WINDOW) {
    target.lastHurt = 0;
    target.invulnerableTime = C.INVULNERABLE_TICKS;
    // The server still knocks its own copy back; it is simply never sent to the client.
    applyKnockback(target.serverVel, C.BASE_KNOCKBACK, attacker.pos.x - target.pos.x, attacker.pos.z - target.pos.z, target.onGround);
  }
  const disabled = !!weapon.disablesShield;
  if (disabled) {
    target.disableShield();
    attacker.stats.shieldsDisabled++;
    // mcpvp.club stuns: the disable clears hurt immunity, so the follow-up lands at once.
    if (attacker.world.shieldStuns) {
      target.invulnerableTime = 0;
      target.lastHurt = 0;
    }
  }
  target.stats.blocked++;
  target.events.push({ type: 'shieldBlock', attacker });
  attacker.events.push({ type: 'hitShield', target, disabled, swap });
  return { hit: false, reach, crit: false, sprint: false, scale, damage: 0, blocked: true, disabled, swap };
}

/** One tick of burning (Entity.baseTick every 20 fire ticks). */
export function burn(target: Fighter) {
  hurt(target, C.FIRE_DAMAGE, null, false, true);
}

/** Fall damage: bypasses armor points, not Protection. */
export function fallHurt(target: Fighter, amount: number) {
  hurt(target, amount, null, false, false, true, 'fall');
}

/** Entity.lavaHurt: 4 fire damage that armor does reduce. */
export function lavaHurt(target: Fighter) {
  hurt(target, C.LAVA_DAMAGE, null, false, true, false);
}

const boxA: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
const boxB: AABB = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

/** Soft entity push when two hitboxes overlap (Entity.push). */
export function pushApart(a: Fighter, b: Fighter) {
  if (a.dead || b.dead) return;
  const A = a.aabbInto(boxA);
  const B = b.aabbInto(boxB);
  if (A.maxX <= B.minX || A.minX >= B.maxX || A.maxY <= B.minY || A.minY >= B.maxY || A.maxZ <= B.minZ || A.minZ >= B.maxZ) {
    return;
  }
  let dx = b.pos.x - a.pos.x;
  let dz = b.pos.z - a.pos.z;
  let d = Math.max(Math.abs(dx), Math.abs(dz));
  if (d < 0.01) return;
  d = Math.sqrt(d);
  dx /= d;
  dz /= d;
  const inv = Math.min(1 / d, 1);
  dx *= inv * 0.05;
  dz *= inv * 0.05;
  a.vel.x -= dx;
  a.vel.z -= dz;
  b.vel.x += dx;
  b.vel.z += dz;
}
