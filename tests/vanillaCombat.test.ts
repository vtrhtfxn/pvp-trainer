import { describe, expect, it } from 'vitest';
import { Fighter } from '../src/game/Fighter';
import { World } from '../src/game/World';
import { performAttack } from '../src/game/combat';
import { kitById } from '../src/game/kits';
import * as B from '../src/game/Blocks';

/**
 * Rules checked against Minecraft's own code (Player.attack, canCriticalAttack, isSweepAttack,
 * doSweepAttack, causeExtraKnockback; ServerGamePacketListenerImpl's swing handling).
 */
const kit = kitById('sword');

function setup(n = 2) {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  a.reset(0, 2, 0, kit); // at z=2 looking toward -Z
  const others: Fighter[] = [];
  for (let i = 1; i < n; i++) {
    const f = new Fighter('bot', `B${i}`, world);
    f.reset(0, 0, Math.PI, kit);
    others.push(f);
  }
  world.fighters.push(a, ...others);
  return { world, a, b: others[0], others };
}

function step(...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
}

/** Puts `a` on the way down from a jump with the cooldown `ticks` after a reset. */
function fallingWithCharge(a: Fighter, b: Fighter, ticks: number) {
  a.input.jump = true;
  step(a, b);
  a.input.jump = false;
  for (let i = 0; i < 7; i++) step(a, b);
  a.pitch = Math.atan2(b.pos.y + 0.9 - (a.pos.y + 1.62), a.pos.z - b.pos.z);
  a.attackStrengthTicker = ticks;
}

describe('vanilla combat', () => {
  it('a sword hit one tick early still crits; two ticks early (84%) is a weak hit, as in Minecraft', () => {
    const early = setup();
    fallingWithCharge(early.a, early.b, 10); // (10 + 0.5) / 12.5 = 84%
    const r1 = performAttack(early.a, early.b);
    expect(r1.hit).toBe(true);
    expect(r1.scale).toBeCloseTo(0.84, 5);
    expect(r1.crit).toBe(false);

    const ok = setup();
    fallingWithCharge(ok.a, ok.b, 11); // 92%
    const r2 = performAttack(ok.a, ok.b);
    expect(r2.scale).toBeCloseTo(0.92, 5);
    expect(r2.crit).toBe(true);
  });

  it('throwing a pearl resets the attack cooldown (the server resets it on every swing)', () => {
    const { a, b } = setup();
    a.inventory[a.selected] = { id: 'ender_pearl', count: 4 };
    for (let i = 0; i < 20; i++) step(a, b);
    expect(a.attackStrengthScale(0.5)).toBe(1);
    expect(a.startUsingItem(true)).not.toBe(false);
    expect(a.attackStrengthTicker).toBe(0);
  });

  it('a click on a block resets the attack cooldown', () => {
    const { world, a, b } = setup();
    world.blocks.set(0, 1, 1, B.B.STONE);
    world.blocks.markPlaced(0, 1, 1);
    a.pitch = -0.5; // down at the block in front
    for (let i = 0; i < 20; i++) step(a, b);
    expect(a.attackStrengthScale(0.5)).toBe(1);
    expect(a.tickMining(true, true)).toBe(true);
    expect(a.attackStrengthTicker).toBe(0);
  });

  it('a sweep hits an enemy next to the target, not a teammate, and walking still sweeps', () => {
    const { a, b, others } = setup(4);
    const [, enemy, mate] = others;
    enemy.pos.set(0.9, 0, 0);
    enemy.prevPos.set(0.9, 0, 0);
    mate.pos.set(-0.9, 0, 0);
    mate.prevPos.set(-0.9, 0, 0);
    mate.team = a.team;
    step(a, ...others);
    a.pitch = Math.atan2(b.pos.y + 0.9 - (a.pos.y + 1.62), a.pos.z - b.pos.z);
    // Walking pace: 0.2 blocks this tick (under 2.5 × the 0.1 speed attribute).
    a.prevPos.set(a.pos.x, a.pos.y, a.pos.z + 0.2);
    a.attackStrengthTicker = 20;
    const r = performAttack(a, b);
    expect(r.hit && !r.crit && !r.sprint).toBe(true);
    expect(enemy.health).toBeLessThan(20);
    expect(Math.hypot(enemy.vel.x, enemy.vel.z)).toBeGreaterThan(0);
    expect(mate.health).toBe(20);
  });
});
