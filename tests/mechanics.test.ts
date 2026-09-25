import { describe, expect, it } from 'vitest';
import { Fighter } from '../src/game/Fighter';
import { World } from '../src/game/World';
import { damageAfterArmor, damageAfterProtection, performAttack } from '../src/game/combat';
import { kitById } from '../src/game/kits';

const kit = kitById('sword');

function setup() {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  a.reset(0, 2, 0, kit); // at z=2 looking toward -Z
  b.reset(0, 0, Math.PI, kit); // at z=0 looking toward +Z
  return { world, a, b };
}

function step(...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
}

describe('movement', () => {
  it('walks at 4.317 m/s and sprints at 5.612 m/s', () => {
    const { a } = setup();
    a.input.forward = 1;
    for (let i = 0; i < 40; i++) step(a);
    const z0 = a.pos.z;
    for (let i = 0; i < 20; i++) step(a);
    expect((z0 - a.pos.z)).toBeCloseTo(4.317, 2);

    a.input.sprint = true;
    for (let i = 0; i < 40; i++) step(a);
    const z1 = a.pos.z;
    for (let i = 0; i < 20; i++) step(a);
    expect(z1 - a.pos.z).toBeCloseTo(5.612, 2);
  });

  it('jumps 1.25 blocks high and lands after 12 ticks', () => {
    const { a } = setup();
    a.input.jump = true;
    step(a);
    a.input.jump = false;
    let maxY = a.pos.y;
    let ticks = 1;
    while (!a.onGround && ticks < 40) {
      step(a);
      maxY = Math.max(maxY, a.pos.y);
      ticks++;
    }
    expect(maxY).toBeCloseTo(1.2522, 3);
    expect(ticks).toBe(12);
  });
});

describe('damage', () => {
  it('matches vanilla armor formulas for the Sword kit', () => {
    const full = damageAfterProtection(damageAfterArmor(10, 20, 8), 16); // 7 base + 3 sharpness
    expect(full).toBeCloseTo(1.08, 3);
    const crit = damageAfterProtection(damageAfterArmor(13.5, 20, 8), 16);
    expect(crit).toBeCloseTo(1.6281, 3);
  });

  it('charges the sword in 12 ticks and punishes early clicks', () => {
    const { a, b } = setup();
    a.attackStrengthTicker = 12;
    const first = performAttack(a, b);
    expect(first.hit).toBe(true);
    expect(first.scale).toBe(1);
    step(a, b);
    step(a, b);
    // early click: tiny damage multiplier and blocked by the hurt-immunity window
    const early = performAttack(a, b);
    expect(early.scale).toBeLessThan(0.3);
    for (let i = 0; i < 20; i++) step(a, b);
    expect(a.attackStrengthScale(0.5)).toBe(1);
  });

  it('requires a sprint reset (W-tap) between sprint-knockback hits', () => {
    const { a, b } = setup();
    a.input.forward = 1;
    a.input.sprint = true;
    step(a, b);
    expect(a.serverSprinting).toBe(true);
    a.attackStrengthTicker = 12;
    b.pos.z = a.pos.z - 2.5;
    const hit1 = performAttack(a, b);
    expect(hit1.sprint).toBe(true);
    // Keep holding W + sprint: the client re-sprints instantly, the server never hears about it.
    for (let i = 0; i < 12; i++) {
      step(a);
      b.pos.set(a.pos.x, 0, a.pos.z - 2.5);
      b.invulnerableTime = 0;
    }
    expect(a.sprinting).toBe(true);
    expect(a.serverSprinting).toBe(false);
    a.attackStrengthTicker = 12;
    expect(performAttack(a, b).sprint).toBe(false);

    // W-tap: release forward for a tick, press again.
    a.input.forward = 0;
    step(a);
    a.input.forward = 1;
    step(a);
    expect(a.serverSprinting).toBe(true);
    b.pos.set(a.pos.x, 0, a.pos.z - 2.5);
    b.invulnerableTime = 0;
    a.attackStrengthTicker = 12;
    expect(performAttack(a, b).sprint).toBe(true);
  });

  it('applies vanilla knockback velocities', () => {
    const { a, b } = setup();
    // settle so the server-side velocity reaches its grounded steady state
    step(a, b);
    a.attackStrengthTicker = 12;
    performAttack(a, b);
    expect(b.vel.y).toBeCloseTo(0.3608, 3);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeCloseTo(0.4, 3);

    const s = setup();
    s.a.input.forward = 1;
    s.a.input.sprint = true;
    step(s.a, s.b);
    s.a.pos.z = 2;
    s.a.attackStrengthTicker = 12;
    const r = performAttack(s.a, s.b);
    expect(r.sprint).toBe(true);
    expect(s.b.vel.y).toBeCloseTo(0.4, 3);
    expect(Math.hypot(s.b.vel.x, s.b.vel.z)).toBeCloseTo(0.7, 2);
  });

  it('leaves a jumping victim\u2019s arc alone instead of slamming them down', () => {
    const { a, b } = setup();
    b.input.jump = true;
    step(a, b);
    b.input.jump = false;
    for (let i = 0; i < 4; i++) step(a, b);
    expect(b.onGround).toBe(false);
    const risingVy = b.vel.y;
    expect(risingVy).toBeGreaterThan(0); // still on the way up
    a.attackStrengthTicker = 12;
    a.pitch = Math.atan2(b.pos.y + 0.9 - (a.pos.y + 1.62), a.pos.z - b.pos.z);
    expect(performAttack(a, b).hit).toBe(true);
    // 15w49a: an airborne victim takes horizontal knockback only. Getting hit mid-jump must
    // not cancel the jump — the arc continues untouched.
    expect(b.vel.y).toBeCloseTo(risingVy, 6);
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeGreaterThan(0.3);
  });

  it('stacks knockback across a combo (the server keeps the previous impulse)', () => {
    const { a, b } = setup();
    step(a, b);
    const push = () => {
      b.invulnerableTime = 0;
      b.health = 20;
      a.attackStrengthTicker = 12;
      a.pos.z = b.pos.z + 2;
      const r = performAttack(a, b);
      expect(r.hit).toBe(true);
      return Math.hypot(b.vel.x, b.vel.z);
    };
    const first = push();
    for (let i = 0; i < 13; i++) step(b);
    const second = push();
    // The server's decayed copy of the last knockback feeds the `velocity / 2` term.
    expect(b.serverVel.z).not.toBe(0);
    expect(second).toBeGreaterThan(first);
  });

  it('only allows crits while falling and not (server-)sprinting', () => {
    const { a, b } = setup();
    a.input.jump = true;
    step(a, b);
    a.input.jump = false;
    for (let i = 0; i < 7; i++) step(a, b);
    expect(a.fallDistance).toBeGreaterThan(0);
    const eyeY = a.pos.y + 1.62;
    a.pitch = Math.atan2(b.pos.y + 0.9 - eyeY, a.pos.z - b.pos.z);
    a.attackStrengthTicker = 12;
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(r.crit).toBe(true);
  });
});

describe('Sword kit', () => {
  it('has no golden apples, and hunger stays full so you can always sprint', () => {
    const { a } = setup();
    expect(a.countItem('golden_apple')).toBe(0);
    a.food.locked = true; // what Match / Duel set up for the Sword kit
    a.health = 12;
    a.input.forward = 1;
    a.input.sprint = true;
    for (let i = 0; i < 20 * 300; i++) {
      a.input.jump = i % 12 === 0;
      if (i % 100 === 0) a.pos.set(0, a.pos.y, 10);
      step(a);
      if (!a.sprinting && !a.horizontalCollision) throw new Error(`lost sprint at tick ${i} (food ${a.food.level})`);
    }
    expect(a.food.level).toBe(20);
    expect(a.food.saturation).toBe(0);
    expect(a.health).toBe(20); // natural regeneration keeps going (1 HP every 4 s)
  });
});

describe('golden apple', () => {
  // The Sword kit has none any more: hand them out in slot 2.
  const setupApples = () => {
    const s = setup();
    s.a.inventory[1] = { id: 'golden_apple', count: 5 };
    return s;
  };

  it('takes 32 ticks (1.6 s) and gives Regeneration II + Absorption', () => {
    const { a } = setupApples();
    a.health = 10;
    a.selectSlot(1);
    for (let i = 0; i < 3; i++) step(a); // item switch settles
    expect(a.startUsingItem()).toBe(true);
    let ticks = 0;
    while (a.usingItem && ticks < 100) {
      step(a);
      ticks++;
    }
    expect(ticks).toBe(32);
    expect(a.inventory[1]?.count).toBe(4);
    expect(a.absorption).toBe(4);
    expect(a.effects.get('regeneration')?.amplifier).toBe(1);
    const before = a.health;
    for (let i = 0; i < 100; i++) step(a);
    // 4 HP from Regeneration II plus saturation-boosted natural regen
    expect(a.health - before).toBeGreaterThan(4);
  });

  it('slows movement to 20% while eating', () => {
    const { a } = setupApples();
    a.selectSlot(1);
    for (let i = 0; i < 3; i++) step(a);
    a.input.forward = 1;
    a.startUsingItem();
    for (let i = 0; i < 10; i++) step(a);
    const z0 = a.pos.z;
    for (let i = 0; i < 10; i++) step(a);
    const speed = (z0 - a.pos.z) / 10;
    expect(speed).toBeLessThan(0.05);
  });
});

describe('audit regressions', () => {
  it('a gapple eaten under a totem’s Absorption II keeps its Absorption I for later', async () => {
    const { World } = await import('../src/game/World');
    const { Fighter } = await import('../src/game/Fighter');
    const { kitById } = await import('../src/game/kits');
    const world = new World(20);
    const f = new Fighter('player', 'A', world);
    world.fighters.push(f);
    f.reset(0.5, 0.5, 0, kitById('neth_pot'));
    f.addEffect('absorption', 1, 100); // totem
    f.absorption = 2; // some of it already soaked up
    f.addEffect('absorption', 0, 2400); // gapple
    expect(f.effects.get('absorption')?.amplifier).toBe(1);
    for (let i = 0; i < 120; i++) f.tick();
    const e = f.effects.get('absorption');
    expect(e?.amplifier).toBe(0);
    expect(e!.duration).toBeGreaterThan(2200);
    expect(f.absorption).toBe(4);
  });

  it('the arena walls go up forever: nobody leaves above build height', async () => {
    const { World } = await import('../src/game/World');
    const world = new World(40);
    const r = world.move(39.5, 20, 0, 3, 0, 0, 0.3, 1.8);
    expect(r.x).toBeLessThan(40);
  });
});
