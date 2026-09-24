import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES } from '../src/ai/difficulty';
import * as C from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { damageAfterArmor, performAttack, smashBonus } from '../src/game/combat';
import { windExplosion } from '../src/game/Explosion';
import { Fighter, SLOT_OFFHAND } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { World } from '../src/game/World';

const mace = kitById('mace');

function setup() {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0.5, 0.5, 0, mace);
  b.reset(0.5, -1.5, Math.PI, mace);
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

function aimAt(a: Fighter, b: Fighter) {
  const dx = b.pos.x - a.pos.x;
  const dz = b.pos.z - a.pos.z;
  a.yaw = Math.atan2(-dx, -dz);
  a.pitch = Math.atan2(b.pos.y + 0.9 - (a.pos.y + a.eyeHeight()), Math.hypot(dx, dz));
}

describe('Mace loadout', () => {
  it('matches the reference inventory', () => {
    const { a } = setup();
    expect(a.inventory.slice(0, 9).map((s) => s?.id)).toEqual([
      'netherite_sword',
      'netherite_axe',
      'mace',
      'elytra',
      'wind_charge',
      'mace',
      'shield',
      'golden_apple',
      'ender_pearl',
    ]);
    expect(a.inventory[2]?.ench).toEqual({ density: 5, windBurst: 3, unbreaking: 3 });
    expect(a.inventory[5]?.ench).toEqual({ breach: 4, unbreaking: 3 });
    expect(a.getSlot(SLOT_OFFHAND)?.id).toBe('totem_of_undying');
    expect(a.countItem('totem_of_undying')).toBe(2);
    expect(a.countItem('wind_charge')).toBe(128);
    expect(a.countItem('ender_pearl')).toBe(64);
    expect(a.countItem('golden_apple')).toBe(128);
    expect(a.countItem('splash_potion', 'strength') + a.countItem('splash_potion', 'swiftness')).toBe(21);
    expect(a.armor.protectionEpf).toBe(16);
  });
});

describe('Mace mechanics', () => {
  it('smash bonus: 4/block to 3, 2/block to 8, then 1/block; Density +0.5/level/block', () => {
    expect(smashBonus(2)).toBe(8);
    expect(smashBonus(5)).toBe(16);
    expect(smashBonus(10)).toBe(24);
    expect(smashBonus(10, 5)).toBe(49);
  });

  it('Breach IV takes 0.6 off the armor fraction', () => {
    // 20 armor, 12 toughness, 10 damage: 18/25 = 0.72 blocked, 0.12 with Breach IV.
    expect(damageAfterArmor(10, 20, 12)).toBeCloseTo(2.8, 5);
    expect(damageAfterArmor(10, 20, 12, 4)).toBeCloseTo(8.8, 5);
  });

  it('a 10-block Density V smash crits, stops the fall and Wind Burst throws the attacker back up', () => {
    const { world, a, b } = setup();
    a.selectSlot(2);
    step(world, a, b);
    a.attackStrengthTicker = 100;
    a.onGround = false;
    a.fallDistance = 10;
    a.pos.y = 1;
    aimAt(a, b);
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(r.crit).toBe(true);
    // (6 × 1.5 + 49) raw through Netherite Prot IV.
    expect(r.damage).toBeCloseTo(13.9, 1);
    expect(a.fallDistance).toBe(0);
    expect(a.vel.y).toBeGreaterThan(2);
    expect(a.stats.smashes).toBe(1);
  });

  it('no smash while gliding or from a short fall', () => {
    const { world, a, b } = setup();
    a.selectSlot(2);
    step(world, a, b);
    a.attackStrengthTicker = 100;
    a.onGround = false;
    a.fallDistance = 1.2;
    aimAt(a, b);
    performAttack(a, b);
    expect(a.stats.smashes).toBe(0);
  });

  it('a wind charge at your feet launches you ~7 blocks, and the fall back costs nothing', () => {
    const { world, a } = setup();
    world.fighters.length = 1;
    a.selectSlot(4);
    a.pitch = -Math.PI / 2 + 0.01;
    step(world, a);
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.cooldowns.has('wind_charge')).toBe(true);
    let top = 0;
    for (let t = 0; t < 80; t++) {
      step(world, a);
      top = Math.max(top, a.pos.y);
      if (t > 5 && a.onGround) break;
    }
    expect(top).toBeGreaterThan(6);
    expect(top).toBeLessThan(9);
    expect(a.health).toBe(C.MAX_HEALTH);
  });

  it('elytra: right click swaps it on, a jump in the air glides, the chestplate swaps back', () => {
    const { world, a } = setup();
    world.fighters.length = 1;
    windExplosion(world, a.pos.x, a.pos.y, a.pos.z, 3.5, 2.2);
    for (let t = 0; t < 12; t++) step(world, a);
    a.selectSlot(3);
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.armorSlots[1]?.id).toBe('elytra');
    expect(a.inventory[3]?.id).toBe('netherite_chestplate');
    expect(a.armor.points).toBe(12);
    for (let t = 0; t < 12; t++) step(world, a);
    a.input = { ...a.input, jump: true };
    step(world, a);
    a.input = { ...a.input, jump: false };
    expect(a.fallFlying).toBe(true);
    expect(a.height()).toBeCloseTo(0.6);
    a.pitch = -0.15;
    const z0 = a.pos.z;
    for (let t = 0; t < 40; t++) step(world, a);
    expect(Math.abs(a.pos.z - z0)).toBeGreaterThan(5);
    a.selectSlot(3);
    a.startUsingItem(true);
    step(world, a);
    expect(a.fallFlying).toBe(false);
    expect(a.armorSlots[1]?.id).toBe('netherite_chestplate');
  });
});

describe('Mace bot', () => {
  it('wind-charges up, glides with the elytra and lands smashes', () => {
    const used = { wind: 0, smashes: 0, elytra: 0, finished: 0 };
    for (let seed = 1; seed <= 3; seed++) {
      const m = new Match(mace, DIFFICULTIES.ht1, seed);
      const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.lt2, new Rng(seed + 99), () => performAttack(m.player, m.bot));
      pb.resetRound();
      while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 4) {
        if (m.phase === 'fight') {
          pb.tick();
          m.useHeld = pb.useHeld;
        }
        m.tick();
        for (const f of [m.player, m.bot]) {
          for (const e of f.events) if (e.type === 'equip' && e.id === 'elytra') used.elytra++;
          f.events.length = 0;
        }
        m.world.events.length = 0;
      }
      if (m.phase === 'ended') used.finished++;
      used.wind += m.bot.stats.windCharges + m.player.stats.windCharges;
      used.smashes += m.bot.stats.smashes + m.player.stats.smashes;
    }
    expect(used.finished).toBeGreaterThanOrEqual(2);
    expect(used.wind).toBeGreaterThan(5);
    expect(used.smashes).toBeGreaterThan(3);
  }, 60_000);

  it('glides in from far away: elytra on at the top, dive, chestplate back, smash', () => {
    const m = new Match(mace, DIFFICULTIES.ht1, 3);
    while (m.phase !== 'fight') m.tick();
    let equips = 0;
    m.player.pos.set(0.5, 0, 16);
    m.bot.pos.set(0.5, 0, -2);
    m.bot.onGround = false;
    m.bot.vel.set(0, 2.2, 0);
    for (let t = 0; t < 120 && !m.bot.stats.smashes; t++) {
      m.tick();
      m.player.pos.set(0.5, 0, 16);
      m.player.vel.set(0, 0, 0);
      for (const e of m.bot.events) if (e.type === 'equip') equips++;
      m.bot.events.length = 0;
      m.player.events.length = 0;
    }
    expect(equips).toBeGreaterThanOrEqual(2);
    expect(m.bot.stats.smashes).toBe(1);
    expect(m.bot.stats.maxSmash).toBeGreaterThan(12);
  });
});
