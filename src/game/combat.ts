import * as C from '../core/constants';
import { V3, rayAABB } from '../core/math';
import { applyKnockback, type Fighter } from './Fighter';
import { sharpnessBonus } from './items';

/** Damage after armor points and toughness (CombatRules.getDamageAfterAbsorb). */
export function damageAfterArmor(damage: number, armor: number, toughness: number): number {
  const f = 2 + toughness / 4;
  const effective = Math.min(Math.max(armor - damage / f, armor * 0.2), 20);
  return damage * (1 - effective / 25);
}

/** Damage after Protection enchantments (CombatRules.getDamageAfterMagicAbsorb). */
export function damageAfterProtection(damage: number, epf: number): number {
  const f = Math.min(Math.max(epf, 0), 20);
  return damage * (1 - f / 25);
}

const tmpEye = new V3();
const tmpDir = new V3();

/** Distance along the attacker's crosshair ray to the target hitbox, or -1 if out of reach. */
export function rayDistanceToTarget(attacker: Fighter, target: Fighter, reach = C.ATTACK_REACH): number {
  if (target.dead) return -1;
  attacker.eyePos(tmpEye);
  attacker.look(tmpDir);
  const t = rayAABB(tmpEye, tmpDir, target.aabb());
  return t >= 0 && t <= reach ? t : -1;
}

export interface HurtResult {
  damaged: boolean;
  fullHit: boolean;
  dealt: number;
}

/** LivingEntity.hurt + Player.actuallyHurt for a melee hit. */
export function hurt(target: Fighter, amount: number, attacker: Fighter, crit: boolean): HurtResult {
  if (target.dead || amount <= 0) return { damaged: false, fullHit: false, dealt: 0 };
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

  let dmg = damageAfterArmor(applied, target.armor.points, target.armor.toughness);
  dmg = damageAfterProtection(dmg, target.armor.protectionEpf);
  const absorbed = Math.min(target.absorption, dmg);
  target.absorption -= absorbed;
  const toHealth = dmg - absorbed;
  if (toHealth > 0) {
    target.causeExhaustion(C.EXHAUSTION_DAMAGE);
    target.health -= toHealth;
  }
  target.stats.damageTaken += dmg;
  target.stats.combo = 0;
  if (fullHit) {
    const dx = attacker.pos.x - target.pos.x;
    const dz = attacker.pos.z - target.pos.z;
    // Minecraft yaw of the victim: mcYaw = 180° - our yaw.
    const mcYawDeg = 180 - (target.yaw * 180) / Math.PI;
    target.hurtDir = (Math.atan2(dz, dx) * 180) / Math.PI - mcYawDeg;
  }
  target.events.push({ type: 'hurt', attacker, damage: dmg, crit });
  if (target.health <= 1e-4) target.die();
  return { damaged: true, fullHit, dealt: dmg };
}

export interface AttackOutcome {
  hit: boolean;
  reach: number;
  crit: boolean;
  sprint: boolean;
  scale: number;
  damage: number;
}

/**
 * A left click: Minecraft.startAttack + Player.attack. Clicking always swings and resets
 * the attack cooldown, even when it misses — that is what punishes spam-clicking in 1.9+.
 */
export function performAttack(attacker: Fighter, target: Fighter): AttackOutcome {
  const miss: AttackOutcome = { hit: false, reach: -1, crit: false, sprint: false, scale: 0, damage: 0 };
  if (attacker.dead || attacker.usingItem) return miss;
  attacker.stats.swings++;
  const reach = rayDistanceToTarget(attacker, target);
  if (reach < 0) {
    attacker.resetAttackStrength();
    attacker.swing();
    attacker.events.push({ type: 'miss' });
    return miss;
  }

  const def = attacker.heldDef();
  const scale = attacker.attackStrengthScale(0.5);
  let base = def.attackDamage * (0.2 + scale * scale * 0.8);
  const ench = sharpnessBonus(def.sharpness) * scale;
  attacker.resetAttackStrength();

  const strong = scale > C.STRONG_ATTACK_SCALE;
  let kbLevel = def.knockback;
  let sprint = false;
  if (attacker.serverSprinting && strong) {
    kbLevel++;
    sprint = true;
  }
  const crit = strong && attacker.fallDistance > 0 && !attacker.onGround && !attacker.serverSprinting;
  if (crit) base *= C.CRIT_MULTIPLIER;
  const total = base + ench;

  // The server computes knockback on its own copy of the victim's velocity and sends the
  // result to the victim's client (ClientboundSetEntityMotionPacket), which replaces its own.
  const kbVel = target.serverVel.clone();
  const res = hurt(target, total, attacker, crit);
  attacker.swing();
  if (!res.damaged) {
    attacker.events.push({ type: 'noDamage', target });
    return { ...miss, reach };
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
  });
  return { hit: true, reach, crit, sprint, scale, damage: res.dealt };
}

/** Soft entity push when two hitboxes overlap (Entity.push). */
export function pushApart(a: Fighter, b: Fighter) {
  if (a.dead || b.dead) return;
  const A = a.aabb();
  const B = b.aabb();
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
