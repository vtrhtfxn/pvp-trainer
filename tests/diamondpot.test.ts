import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { damageAfterArmor, damageAfterProtection, performAttack } from '../src/game/combat';
import { Fighter } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { World } from '../src/game/World';

const kit = kitById('diamond_pot');

function setup(dist = 2) {
  const world = new World(40);
  world.damageMultiplier = kit.damageMultiplier ?? 1;
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, dist, 0, kit);
  b.reset(0, 0, Math.PI, kit);
  a.naturalRegen = b.naturalRegen = false;
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

describe('Diamond Pot loadout', () => {
  it('matches the Pot PvP kit', () => {
    const { a } = setup();
    expect(a.inventory[0]).toEqual({ id: 'diamond_sword', count: 1, ench: { sharpness: 5 } });
    expect(a.countItem('splash_potion', 'healing')).toBe(26);
    expect(a.countItem('splash_potion', 'strength')).toBe(3);
    expect(a.countItem('splash_potion', 'swiftness')).toBe(3);
    expect(a.countItem('splash_potion', 'regeneration')).toBe(3);
    expect(a.offhand).toEqual({ id: 'cooked_beef', count: 5 });
    expect(a.inventory.every((s) => s !== null)).toBe(true);
    expect(a.armorSlots.every((s) => s?.ench?.protection === 4 && s.ench.unbreaking === 3)).toBe(true);
    expect(a.armor.knockbackResistance).toBe(0);
    expect(a.countItem('totem_of_undying')).toBe(0);
  });
});

describe('Diamond Pot rules', () => {
  it('all damage is boosted by 33% before armor', () => {
    const { a, b } = setup();
    a.attackStrengthTicker = 100;
    const r = performAttack(a, b);
    expect(r.damage).toBeCloseTo(damageAfterProtection(damageAfterArmor(10 * 1.33, 20, 8), 16), 5);
  });

  it('a Regeneration splash gives Regeneration I for 1:30', () => {
    const { a, world } = setup(8);
    a.selectSlot(0);
    a.inventory[1] = { id: 'splash_potion', count: 1, potion: 'regeneration' };
    a.selectSlot(1);
    a.pitch = -Math.PI / 2 + 0.01;
    a.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a);
    const e = a.effects.get('regeneration');
    expect(e?.amplifier).toBe(0);
    expect(e!.duration).toBeGreaterThan(1700);
  });

  it('steak in the off hand is eaten behind the sword, but only when hungry', () => {
    const { a, world } = setup(8);
    expect(a.startUsingItem(true)).toBe(false); // full hunger: steak is not edible
    a.food.level = 10;
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.useHand).toBe('off');
    for (let t = 0; t < 40 && a.usingItem; t++) step(world, a);
    expect(a.food.level).toBe(18);
    expect(a.offhand?.count).toBe(4);
    expect(a.stats.gapplesEaten).toBe(0);
  });
});

function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number) {
  const m = new Match(kit, DIFFICULTIES[botDiff], seed);
  const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[playerDiff], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  pb.resetRound();
  while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 5) {
    if (m.phase === 'fight') {
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    for (const f of [m.player, m.bot]) f.events.length = 0;
  }
  return m;
}

describe('Diamond Pot bot', () => {
  it('fights for combos (mostly sprint hits), pots, buffs and finishes duels', () => {
    let finished = 0;
    let hits = 0;
    let sprint = 0;
    let crits = 0;
    let pots = 0;
    let combo = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const m = duel('lt2', 'lt2', seed);
      if (m.phase === 'ended') finished++;
      for (const f of [m.player, m.bot]) {
        hits += f.stats.hits;
        sprint += f.stats.sprintHits;
        crits += f.stats.crits;
        pots += f.stats.potsThrown;
        combo = Math.max(combo, f.stats.maxCombo);
      }
    }
    expect(finished).toBe(4);
    expect(sprint / hits).toBeGreaterThan(0.6);
    expect(crits / hits).toBeLessThan(0.3);
    expect(pots).toBeGreaterThan(30);
    expect(combo).toBeGreaterThanOrEqual(5);
  });

  it('scales with difficulty', () => {
    let wins = 0;
    for (let seed = 40; seed < 46; seed++) if (duel('lt1', 'lt3', seed).winner?.id === 'bot') wins++;
    expect(wins).toBeGreaterThanOrEqual(5);
  });
});
