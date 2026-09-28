import { describe, expect, it } from 'vitest';
import { Fighter } from '../src/game/Fighter';
import { World } from '../src/game/World';
import { legacyDamageAfterArmor, legacyDamageAfterProtection, performAttack, rayDistanceToTarget } from '../src/game/combat';
import { armorStatsOf, kitById } from '../src/game/kits';
import { Duel } from '../src/net/Duel';

const kit = kitById('sword18');

/** Two fighters 2 blocks apart facing each other; `naked` strips the defender's armor. */
function setup(legacy = true, naked = true) {
  const world = new World(40);
  world.legacyCombat = legacy;
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  a.reset(0, 2, 0, kit);
  b.reset(0, 0, Math.PI, kit);
  if (naked) {
    b.armorSlots = [null, null, null, null];
    b.armor = armorStatsOf([]);
  }
  return { world, a, b };
}

function step(...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
}

describe('1.8 combat', () => {
  it('has no cooldown: a Sharpness V diamond sword hits for 8 + 6.25 every time', () => {
    const { a, b } = setup();
    expect(a.attackStrengthScale(0)).toBe(1);
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(r.scale).toBe(1);
    expect(20 - b.health).toBeCloseTo(14.25, 5);
    // Right after its own swing, the next click is just as strong (only hurt immunity stops it).
    b.health = 20;
    b.invulnerableTime = 0;
    b.lastHurt = 0;
    performAttack(a, b);
    expect(20 - b.health).toBeCloseTo(14.25, 5);
  });

  it('crits while sprinting, ×1.5 on the weapon damage before Sharpness', () => {
    const { a, b } = setup();
    a.sprinting = a.serverSprinting = true;
    a.onGround = false;
    a.fallDistance = 0.3;
    const r = performAttack(a, b);
    expect(r.crit).toBe(true);
    expect(r.sprint).toBe(true);
    expect(20 - b.health).toBeCloseTo(8 * 1.5 + 6.25, 5);
  });

  it('a blocking sword takes (1 + damage) / 2', () => {
    const { a, b } = setup();
    b.startUsingItem(true);
    expect(b.swordBlocking()).toBe(true);
    performAttack(a, b);
    expect(20 - b.health).toBeCloseTo((1 + 14.25) / 2, 5);
  });

  it('blocking stops a sprint, so a block-hit resets it', () => {
    const { a } = setup();
    a.input.forward = 1;
    a.input.sprint = true;
    for (let i = 0; i < 5; i++) step(a);
    expect(a.serverSprinting).toBe(true);
    a.startUsingItem(true);
    step(a);
    expect(a.sprinting).toBe(false);
    expect(a.serverSprinting).toBe(false);
    a.releaseUsingItem();
    step(a);
    expect(a.serverSprinting).toBe(true);
  });

  it('uses the 1.8 armor and random Protection formulas', () => {
    expect(legacyDamageAfterArmor(10, 20)).toBeCloseTo(2, 5);
    // Protection IV on all four pieces: EPF 5 each = 20, rolled 10..20.
    expect(armorStatsOf(kit.armor).legacyEpf).toBe(20);
    expect(legacyDamageAfterProtection(10, 20, 0)).toBeCloseTo(6, 5);
    expect(legacyDamageAfterProtection(10, 20, 0.999)).toBeCloseTo(2, 5);
  });

  it('knocks an airborne player up too (no 1.9 airborne exception)', () => {
    const { a, b } = setup();
    b.onGround = false;
    b.vel.y = -0.2;
    b.serverVel.y = -0.2;
    performAttack(a, b);
    expect(b.vel.y).toBeCloseTo(0.3, 5); // -0.2 / 2 + 0.4
  });

  it('adds 0.5 per level of sprint knockback, slows the attacker and drops its sprint', () => {
    const { a, b } = setup();
    a.sprinting = a.serverSprinting = true;
    a.vel.z = -0.2;
    b.serverVel.set(0, 0, 0);
    performAttack(a, b);
    // Pushed away from the attacker (−Z): 0.4 base plus 0.5 for the sprint.
    expect(b.vel.z).toBeCloseTo(-0.9, 5);
    expect(b.vel.y).toBeCloseTo(0.5, 5); // 0.4 + 0.1
    expect(a.serverSprinting).toBe(false);
    expect(a.vel.z).toBeCloseTo(-0.12, 5);
  });

  it('grows hitboxes by 0.1 like 1.8 did', () => {
    for (const legacy of [false, true]) {
      const { a, b } = setup(legacy);
      b.pos.x = 0.36; // the crosshair passes 0.36 from their middle: inside 0.4, outside 0.33
      expect(rayDistanceToTarget(a, b) >= 0).toBe(legacy);
    }
  });

  it('runs online with 1.8 rules too', () => {
    const d = new Duel(['A', 'B'], 'sword18');
    expect(d.world.legacyCombat).toBe(true);
    expect(new Duel(['A', 'B'], 'sword').world.legacyCombat).toBe(false);
  });

  it('only 1.8 swords block', () => {
    const { b } = setup(false);
    expect(b.startUsingItem(true)).toBe(false);
  });
});
