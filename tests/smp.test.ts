import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES } from '../src/ai/difficulty';
import * as C from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { performAttack } from '../src/game/combat';
import { Fighter, SLOT_OFFHAND, type FighterEvent } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { World } from '../src/game/World';

const smp = kitById('smp');

/** a at z=dist facing -Z (toward b), b at z=0 facing +Z. */
function setup(dist = 2) {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, dist, 0, smp);
  b.reset(0, 0, Math.PI, smp);
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

describe('SMP loadout', () => {
  it('matches the reference inventory', () => {
    const { a } = setup();
    expect(a.inventory.slice(0, 9).map((s) => s?.potion ?? s?.id)).toEqual([
      'netherite_sword',
      'golden_apple',
      'ender_pearl',
      'netherite_axe',
      'netherite_sword',
      'strength',
      'swiftness',
      'fire_resistance',
      'totem_of_undying',
    ]);
    expect(a.inventory[0]?.ench).toEqual({ sharpness: 5, fireAspect: 2, sweepingEdge: 3 });
    expect(a.inventory[4]?.ench).toEqual({ sharpness: 5, fireAspect: 2, sweepingEdge: 3, knockback: 1 });
    expect(a.inventory[3]?.ench).toEqual({ sharpness: 5 });
    expect(a.countItem('splash_potion', 'strength')).toBe(12);
    expect(a.countItem('splash_potion', 'swiftness')).toBe(12);
    expect(a.countItem('splash_potion', 'fire_resistance')).toBe(3);
    expect(a.countItem('golden_apple')).toBe(128);
    expect(a.countItem('ender_pearl')).toBe(32);
    expect(a.countItem('experience_bottle')).toBe(64);
    expect(a.countItem('totem_of_undying')).toBe(1);
    expect(a.getSlot(SLOT_OFFHAND)).toMatchObject({ id: 'shield', ench: { unbreaking: 3, mending: 1 } });
    expect(a.armorSlots[2]?.ench).toMatchObject({ protection: 4, swiftSneak: 3 });
    expect(a.armorSlots[3]?.ench).toMatchObject({ protection: 4, featherFalling: 4 });
    expect(a.armor.protectionEpf).toBe(16);
    expect(a.armor.fallEpf).toBe(12);
  });
});

describe('SMP mechanics', () => {
  it('Swift Sneak III: sneaking at 75% of walking speed instead of 30%', () => {
    const { world, a } = setup(6);
    const plain = new Fighter('bot', 'P', world);
    world.fighters.push(plain);
    plain.reset(10, 6, 0, smp);
    plain.armorSlots[2] = { id: 'netherite_leggings', count: 1 };
    for (const f of [a, plain]) f.input = { forward: 1, strafe: 0, jump: false, sneak: true, sprint: false };
    const z0 = [a.pos.z, plain.pos.z];
    for (let i = 0; i < 40; i++) step(world, a, plain);
    const ratio = Math.abs(a.pos.z - z0[0]) / Math.abs(plain.pos.z - z0[1]);
    expect(ratio).toBeCloseTo(0.75 / 0.3, 1);
  });

  it('a blocked hit of 3+ damage wears the shield by 1 + damage; the netherite axe disables it', () => {
    const { world, a, b } = setup(2);
    b.getSlot(SLOT_OFFHAND)!.ench = {}; // no Unbreaking, so the wear is exact
    b.selectSlot(0);
    expect(b.startUsingItem(true)).toBe(true);
    for (let i = 0; i < C.SHIELD_RAISE_TICKS + 1; i++) step(world, a, b);
    expect(b.isBlocking()).toBe(true);
    a.selectSlot(0);
    a.attackStrengthTicker = 100;
    const r = performAttack(a, b);
    expect(r.blocked).toBe(true);
    // Netherite sword 8 + Sharpness V 3 = 11 → 12 durability.
    expect(b.getSlot(SLOT_OFFHAND)?.damage).toBe(12);
    a.selectSlot(3);
    a.attackStrengthTicker = 100;
    for (let i = 0; i < 12; i++) step(world, a, b);
    a.attackStrengthTicker = 100;
    const r2 = performAttack(a, b);
    expect(r2.disabled).toBe(true);
    expect(b.shieldCooldown).toBeGreaterThan(0);
  });

  it('a full-charge sword hit standing on the ground sweeps; a sprint hit does not', () => {
    const { world, a, b } = setup(2);
    for (let i = 0; i < 3; i++) step(world, a, b);
    a.attackStrengthTicker = 100;
    performAttack(a, b);
    expect(a.events.some((e: FighterEvent) => e.type === 'sweep')).toBe(true);
    a.events.length = 0;
    for (let i = 0; i < 25; i++) step(world, a, b);
    a.sprinting = a.serverSprinting = true;
    a.attackStrengthTicker = 100;
    b.invulnerableTime = 0;
    performAttack(a, b);
    expect(a.events.some((e: FighterEvent) => e.type === 'sweep')).toBe(false);
  });
});

describe('SMP bot', () => {
  it('blocks, disables shields, buffs, eats, mends, pearls and swaps its totem in', () => {
    const used = { disables: 0, pots: 0, gapples: 0, xp: 0, pearls: 0, swaps: 0, blocked: 0 };
    let finished = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const m = new Match(smp, DIFFICULTIES.lt2, seed);
      const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.lt2, new Rng(seed + 99), () => performAttack(m.player, m.bot));
      pb.resetRound();
      while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 4) {
        if (m.phase === 'fight') {
          pb.tick();
          m.useHeld = pb.useHeld;
        }
        m.tick();
        for (const f of [m.player, m.bot]) {
          for (const e of f.events) if (e.type === 'swapHands') used.swaps++;
          f.events.length = 0;
        }
        m.world.events.length = 0;
      }
      if (m.phase === 'ended') finished++;
      for (const f of [m.player, m.bot]) {
        used.disables += f.stats.shieldsDisabled;
        used.pots += f.stats.potsThrown;
        used.gapples += f.stats.gapplesEaten;
        used.xp += f.stats.xpBottles;
        used.pearls += f.stats.pearlsThrown;
        used.blocked += f.stats.blocked;
      }
    }
    expect(finished).toBeGreaterThanOrEqual(2);
    expect(used.disables).toBeGreaterThan(0);
    expect(used.blocked).toBeGreaterThan(0);
    expect(used.pots).toBeGreaterThan(5);
    expect(used.gapples).toBeGreaterThan(3);
    expect(used.xp).toBeGreaterThan(0);
    expect(used.pearls).toBeGreaterThan(0);
    expect(used.swaps).toBeGreaterThan(0);
  }, 60_000);
});
