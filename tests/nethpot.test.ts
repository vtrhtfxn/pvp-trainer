import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import * as C from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { damageAfterArmor, damageAfterProtection, hurt, performAttack } from '../src/game/combat';
import { Fighter, SLOT_ARMOR, SLOT_OFFHAND } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { World } from '../src/game/World';
import { fromSlot, itemTotals, toSlot } from '../src/net/protocol';

const neth = kitById('neth_pot');

function setup(dist = 2) {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, dist, 0, neth);
  b.reset(0, 0, Math.PI, neth);
  // Exact health numbers: no saturation healing in the middle of a measurement.
  a.naturalRegen = b.naturalRegen = false;
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

/** Looks straight down and throws whatever is in `slot`. */
function throwDown(f: Fighter, slot: number) {
  f.selectSlot(slot);
  f.pitch = -Math.PI / 2 + 0.01;
  return f.startUsingItem(true);
}

describe('NethPot loadout', () => {
  it('matches the tier-test inventory', () => {
    const { a } = setup();
    expect(a.inventory[0]?.id).toBe('netherite_sword');
    expect(a.inventory[0]?.ench).toEqual({ sharpness: 5, fireAspect: 2, unbreaking: 3, mending: 1 });
    expect(a.offhand?.id).toBe('totem_of_undying');
    expect(a.countItem('totem_of_undying')).toBe(3);
    expect(a.countItem('golden_apple')).toBe(64);
    expect(a.countItem('experience_bottle')).toBe(128);
    expect(a.countItem('splash_potion', 'strength')).toBe(3);
    expect(a.countItem('splash_potion', 'swiftness')).toBe(3);
    expect(a.countItem('splash_potion', 'fire_resistance')).toBe(3);
    expect(a.countItem('splash_potion', 'healing')).toBe(21);
    expect(a.inventory.every((s) => s !== null)).toBe(true);
    expect(a.armor.points).toBe(20);
    expect(a.armor.toughness).toBe(12);
    expect(a.armor.protectionEpf).toBe(16);
    expect(a.armor.knockbackResistance).toBeCloseTo(0.4, 6);
  });
});

describe('splash potions', () => {
  it('a healing pot thrown straight down heals 8 (4 hearts) at full strength', () => {
    const { a, world } = setup(8);
    a.health = 6;
    expect(throwDown(a, 5)).toBe(true);
    expect(a.inventory[5]).toBeNull(); // potions don't stack: the slot empties
    for (let t = 0; t < 10 && world.thrown.length; t++) step(world, a);
    expect(world.thrown.length).toBe(0);
    // It lands a hair from our feet: round(scale × 8) is still 8.
    expect(a.health).toBe(14);
  });

  it('heals less the further away it lands, and nothing beyond 4 blocks', () => {
    const { a, b, world } = setup(3);
    a.health = 4;
    b.health = 4;
    throwDown(a, 5);
    for (let t = 0; t < 10; t++) step(world, a, b);
    expect(a.health).toBe(12);
    // b is 3 blocks from the splash: scale 0.25 → round(2) = 2.
    expect(b.health).toBe(6);
  });

  it('Strength II adds 6 attack damage and Speed II makes you 40% faster', () => {
    const { a, b, world } = setup(8);
    throwDown(a, 3);
    for (let t = 0; t < 6; t++) step(world, a, b);
    const st = a.effects.get('strength');
    expect(st?.amplifier).toBe(1);
    expect(st!.duration).toBeGreaterThan(1700);
    a.selectSlot(0);
    step(world, a, b);
    expect(a.attackDamage()).toBe(8 + 6);
    a.rightClickDelay = 0;
    throwDown(a, 4);
    for (let t = 0; t < 6; t++) step(world, a, b);
    expect(a.movementSpeed()).toBeCloseTo(C.WALK_SPEED * 1.4, 6);
    a.sprinting = true;
    expect(a.movementSpeed()).toBeCloseTo(C.WALK_SPEED * 1.3 * 1.4, 6);
  });
});

describe('fire aspect and fire resistance', () => {
  it('Fire Aspect II sets the target on fire for 8 s; burning hurts through armor', () => {
    const { a, b, world } = setup(2);
    a.attackStrengthTicker = 100;
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(b.fireTicks).toBe(160);
    // Wait out the i-frames, then the next fire tick deals 1 × (1 − 16/25) through Protection IV.
    for (let t = 0; t < 21; t++) step(world, a, b);
    const before = b.health;
    for (let t = 0; t < 20; t++) step(world, a, b);
    expect(before - b.health).toBeCloseTo(damageAfterProtection(1, 16), 5);
  });

  it('Fire Resistance cancels burning damage', () => {
    const { a, b, world } = setup(2);
    b.addEffect('fire_resistance', 0, 9600);
    b.ignite(160);
    for (let t = 0; t < 80; t++) step(world, a, b);
    expect(b.health).toBe(20);
  });
});

describe('totems', () => {
  it('a lethal hit pops the off-hand totem: 1 HP, Regeneration II, Absorption II, Fire Resistance', () => {
    const { a, b } = setup();
    b.addEffect('strength', 1, 100);
    b.health = 2;
    hurt(b, 100, a, false);
    expect(b.dead).toBe(false);
    expect(b.health).toBe(1);
    expect(b.offhand).toBeNull();
    expect(b.effects.has('strength')).toBe(false);
    expect(b.effects.get('regeneration')).toEqual({ amplifier: 1, duration: C.TOTEM_REGEN_TICKS });
    expect(b.absorption).toBe(8);
    expect(b.effects.has('fire_resistance')).toBe(true);
    expect(b.stats.totemsPopped).toBe(1);
  });

  it('with no totem in either hand you die', () => {
    const { a, b } = setup();
    b.offhand = null;
    b.selectSlot(0);
    hurt(b, 100, a, false);
    expect(b.dead).toBe(true);
  });

  it('a hotbar totem in the main hand works too, and F re-totems', () => {
    const { a, b } = setup();
    b.offhand = null;
    b.selectSlot(1);
    hurt(b, 100, a, false);
    expect(b.dead).toBe(false);
    expect(b.inventory[1]).toBeNull();
    // Refill from the inventory with F over the spare (slot 9).
    b.swapSlots(9, SLOT_OFFHAND);
    expect(b.getSlot(SLOT_OFFHAND)?.id).toBe('totem_of_undying');
  });
});

describe('durability and mending', () => {
  it('hits wear armor by damage / 4 per piece and the sword by 1 (Unbreaking can skip)', () => {
    const { a, b } = setup();
    // Without Unbreaking the numbers are exact.
    for (const f of [a, b]) {
      for (const s of [...f.armorSlots, f.inventory[0]]) delete s!.ench!.unbreaking;
    }
    a.attackStrengthTicker = 100;
    performAttack(a, b);
    const dealt = 8 + 3; // full-charge non-crit netherite sword with Sharpness V
    for (const s of b.armorSlots) expect(s!.damage).toBe(Math.floor(dealt / 4));
    expect(a.inventory[0]!.damage).toBe(1);
  });

  it('armor breaks at its max durability', () => {
    const { a, b } = setup();
    b.armorSlots[0]!.damage = 406;
    delete b.armorSlots[0]!.ench!.unbreaking;
    hurt(b, 4, a, false);
    expect(b.armorSlots[0]).toBeNull();
    expect(b.armor.points).toBe(17);
  });

  it('an XP bottle drops 3–11 XP, and Mending repairs 2 durability per point', () => {
    const { a, world } = setup(12);
    for (const s of a.armorSlots) s!.damage = 100;
    a.inventory[3] = { id: 'experience_bottle', count: 64 };
    throwDown(a, 3);
    let xp = 0;
    for (let t = 0; t < 60; t++) {
      step(world, a);
      for (const e of a.events) if (e.type === 'xpPickup') xp += e.value;
      a.events.length = 0;
    }
    expect(world.orbs.length).toBe(0);
    expect(xp).toBeGreaterThanOrEqual(3);
    expect(xp).toBeLessThanOrEqual(11);
    const repaired = a.armorSlots.reduce((n, s) => n + (100 - (s!.damage ?? 0)), 0);
    expect(repaired).toBe(xp * 2);
    expect(a.stats.repaired).toBe(xp * 2);
  });
});

describe('knockback and crits', () => {
  it('netherite takes 40% less knockback than diamond', () => {
    const { a, b } = setup();
    a.attackStrengthTicker = 100;
    const vx0 = b.vel.z;
    performAttack(a, b);
    const netherite = Math.abs(b.vel.z - vx0 / 2);
    const d = setup();
    for (let i = 0; i < 4; i++) d.b.armorSlots[i] = { id: (['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'] as const)[i], count: 1 };
    d.b.recomputeArmor();
    d.a.attackStrengthTicker = 100;
    performAttack(d.a, d.b);
    const diamond = Math.abs(d.b.vel.z - vx0 / 2);
    expect(netherite / diamond).toBeCloseTo(0.6, 2);
  });

  it('a strength crit: (8 + 6) × 1.5 + 3 before armor', () => {
    const { a, b } = setup();
    a.addEffect('strength', 1, 1800);
    a.attackStrengthTicker = 100;
    a.onGround = false;
    a.fallDistance = 0.3;
    const r = performAttack(a, b);
    expect(r.crit).toBe(true);
    const expected = damageAfterProtection(damageAfterArmor(24, 20, 12), 16);
    expect(r.damage).toBeCloseTo(expected, 4);
  });
});

describe('online slots', () => {
  it('round-trips potions, durability and every enchantment', () => {
    const { a } = setup();
    a.armorSlots[1]!.damage = 57;
    for (let i = 0; i < 41; i++) {
      const s = a.getSlot(i);
      expect(fromSlot(toSlot(s))).toEqual(s);
    }
    expect(fromSlot(toSlot(a.getSlot(SLOT_ARMOR + 1)))?.damage).toBe(57);
  });

  it('durability is part of an item total (no repairing by rearranging)', () => {
    const t1 = itemTotals([toSlot({ id: 'netherite_helmet', count: 1, damage: 50 })]);
    const t2 = itemTotals([toSlot({ id: 'netherite_helmet', count: 1 })]);
    expect([...t1.keys()]).not.toEqual([...t2.keys()]);
  });
});

/** Bot vs bot in NethPot. */
function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number, maxTicks = 20 * 60 * 5) {
  const m = new Match(neth, DIFFICULTIES[botDiff], seed);
  const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[playerDiff], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  pb.resetRound();
  while (m.phase !== 'ended' && m.tickCount < maxTicks) {
    if (m.phase === 'fight') {
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    for (const f of [m.player, m.bot]) {
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.health, f.yaw, f.pitch]) {
        if (!Number.isFinite(v)) throw new Error(`non-finite state on ${f.id}`);
      }
      f.events.length = 0;
    }
  }
  return m;
}

describe('NethPot bot', () => {
  it('pots, buffs, re-totems and finishes duels', () => {
    let finished = 0;
    const sum = { pots: 0, totems: 0, crits: 0, repaired: 0, xp: 0, ticks: 0 };
    for (let seed = 1; seed <= 4; seed++) {
      const m = duel('lt2', 'lt2', seed);
      if (m.phase === 'ended') finished++;
      for (const f of [m.player, m.bot]) {
        sum.pots += f.stats.potsThrown;
        sum.totems += f.stats.totemsPopped;
        sum.crits += f.stats.crits;
        sum.repaired += f.stats.repaired;
        sum.xp += f.stats.xpBottles;
      }
      sum.ticks += m.fightTicks;
    }
    console.log('hard vs hard', finished, sum);
    expect(finished).toBeGreaterThanOrEqual(3);
    expect(sum.pots).toBeGreaterThan(20);
    expect(sum.totems).toBeGreaterThan(4);
    expect(sum.crits).toBeGreaterThan(20);
  });

  it('scales with difficulty', () => {
    let wins = 0;
    for (let seed = 30; seed < 36; seed++) {
      const m = duel('lt1', 'lt5', seed);
      if (m.winner === m.bot) wins++;
    }
    console.log('expert beat easy', wins, '/ 6');
    expect(wins).toBeGreaterThanOrEqual(5);
  });
});
