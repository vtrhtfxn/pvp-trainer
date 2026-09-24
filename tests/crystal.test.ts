import { describe, expect, it } from 'vitest';
import * as C from '../src/core/constants';
import { B } from '../src/game/Blocks';
import { damageAfterArmor, damageAfterProtection } from '../src/game/combat';
import { attackCrystal, canPlaceCrystal, crosshairCrystal } from '../src/game/crystals';
import { explode, explosionDamageAt } from '../src/game/Explosion';
import { Fighter, SLOT_OFFHAND } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { World } from '../src/game/World';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { Match } from '../src/game/Match';
import { performAttack } from '../src/game/combat';

const crystal = kitById('crystal');

/** a at (0.5, 0, dist+0.5) facing -Z toward b at (0.5, 0, 0.5). */
function setup(dist = 3) {
  const world = new World(undefined, 4);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0.5, dist + 0.5, 0, crystal);
  b.reset(0.5, 0.5, Math.PI, crystal);
  a.naturalRegen = b.naturalRegen = false;
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

function lookAt(f: Fighter, x: number, y: number, z: number) {
  const dx = x - f.pos.x;
  const dz = z - f.pos.z;
  f.yaw = Math.atan2(-dx, -dz);
  f.pitch = Math.atan2(y - (f.pos.y + f.eyeHeight()), Math.hypot(dx, dz));
}

describe('Crystal loadout', () => {
  it('matches the screenshot', () => {
    const { a } = setup();
    expect(a.inventory.slice(0, 9).map((s) => s?.id)).toEqual([
      'netherite_sword',
      'obsidian',
      'end_crystal',
      'respawn_anchor',
      'glowstone',
      'golden_apple',
      'ender_pearl',
      'crossbow',
      'totem_of_undying',
    ]);
    expect(a.getSlot(SLOT_OFFHAND)?.id).toBe('totem_of_undying');
    expect(a.countItem('totem_of_undying')).toBe(8);
    expect(a.countItem('ender_pearl')).toBe(80);
    expect(a.countItem('end_crystal')).toBe(128);
    expect(a.countItem('obsidian')).toBe(128);
    expect(a.countItem('respawn_anchor')).toBe(128);
    expect(a.countItem('experience_bottle')).toBe(128);
    expect(a.countItem('tipped_arrow', 'slow_falling')).toBe(64);
    expect(a.inventory.every((s) => s !== null)).toBe(true);
    expect(a.armor.protectionEpf).toBe(8);
    expect(a.armor.blastEpf).toBe(16);
    expect(a.armor.fallEpf).toBe(12);
  });
});

describe('end crystals', () => {
  it('only go on obsidian with room above, never onto a player or the grass floor', () => {
    const { world, a, b } = setup(4);
    const blocks = world.blocks;
    a.selectSlot(2);
    lookAt(a, 0.5, 0, 2.5); // the grass floor
    a.startUsingItem(true);
    expect(world.crystals.length).toBe(0);
    blocks.set(0, 0, 2, B.OBSIDIAN);
    a.rightClickDelay = 0;
    lookAt(a, 0.5, 1, 2.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(world.crystals.length).toBe(1);
    expect(world.crystals[0].y).toBe(1);
    // Obsidian under b's feet: b is in the space above it, so no crystal.
    blocks.set(0, -0, 0, B.AIR);
    expect(canPlaceCrystal(world, 0, 0, 0)).toBe(false);
    blocks.set(1, 0, 0, B.OBSIDIAN);
    b.pos.set(0.9, 1, 0.5); // standing on the edge of it
    expect(canPlaceCrystal(world, 1, 0, 0)).toBe(false);
    b.pos.set(0.5, 0, 0.5);
    expect(canPlaceCrystal(world, 1, 0, 0)).toBe(true);
  });

  it('a crystal at their feet (obsidian set into the ground): vanilla damage through Prot IV + 2× Blast IV pops a totem', () => {
    const { world, a, b } = setup(3);
    world.blocks.set(1, -1, 0, B.OBSIDIAN);
    const raw = explosionDamageAt(world, 1.5, 0, 0.5, 6, b.pos.x, b.pos.y, b.pos.z, 1.8);
    // 1 block away, fully exposed: impact 0.917 → 74.8 before armor.
    expect(raw).toBeCloseTo(((0.9166667 ** 2 + 0.9166667) / 2) * 84 + 1, 3);
    a.selectSlot(2);
    lookAt(a, 1.5, 0, 0.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(world.crystals[0].y).toBe(0);
    const expected = damageAfterProtection(damageAfterArmor(raw, 20, 12), 20);
    expect(expected).toBeGreaterThan(11);
    b.health = 10;
    attackCrystal(a, world.crystals[0]);
    expect(b.stats.totemsPopped).toBe(1);
    expect(b.health).toBe(1);
    // Blast Protection IV on two pieces = 120% explosion knockback resistance: no push at all.
    expect(Math.hypot(b.vel.x, b.vel.z)).toBeLessThan(1e-9);
    // Every downward ray starts on the obsidian's top face and dies in it: the ground around a
    // crystal sitting on obsidian survives (vanilla behaves the same).
    expect(world.blocks.get(1, -1, 0)).toBe(B.OBSIDIAN);
    expect(world.blocks.get(2, -1, 0)).toBe(B.GRASS);
  });

  it('knee-high crystal on obsidian placed on the grass: the block shields the legs (40% exposure)', () => {
    const { world, b } = setup(3);
    world.blocks.set(1, 0, 0, B.OBSIDIAN);
    const raw = explosionDamageAt(world, 1.5, 1, 0.5, 6, b.pos.x, b.pos.y, b.pos.z, 1.8);
    const full = ((1 - Math.SQRT2 / 12) ** 2 + (1 - Math.SQRT2 / 12)) / 2 * 84 + 1;
    expect(raw).toBeLessThan(full * 0.5);
  });

  it('without Blast Protection the blast throws you', () => {
    const { world, a, b } = setup(3);
    for (const s of b.armorSlots) delete s!.ench!.blastProtection;
    b.recomputeArmor();
    world.blocks.set(1, -1, 0, B.OBSIDIAN);
    a.selectSlot(2);
    lookAt(a, 1.5, 0, 0.5);
    expect(a.startUsingItem(true)).toBe(true);
    const cr = world.crystals[0];
    lookAt(a, cr.x, cr.y + 1, cr.z);
    expect(crosshairCrystal(a)).not.toBeNull();
    attackCrystal(a, cr);
    expect(b.vel.x).toBeLessThan(-0.3); // pushed away from the crystal (−X)
  });

  it('explosions blow away glowstone but not obsidian, and set off other crystals', () => {
    const { world, a, b } = setup(12);
    b.pos.set(20.5, 0, 20.5);
    const bl = world.blocks;
    bl.set(3, 1, -3, B.GLOWSTONE);
    bl.set(4, 0, -3, B.OBSIDIAN);
    bl.set(0, 0, -3, B.OBSIDIAN);
    bl.set(2, 0, -5, B.OBSIDIAN);
    const place = (x: number, z: number) => {
      a.selectSlot(2);
      a.rightClickDelay = 0;
      a.pos.set(x + 0.5, 0, z + 3.5);
      lookAt(a, x + 0.5, 1, z + 0.5);
      return a.startUsingItem(true);
    };
    expect(place(0, -3)).toBe(true);
    expect(place(2, -5)).toBe(true);
    expect(world.crystals.length).toBe(2);
    a.pos.set(0.5, 0, 20);
    attackCrystal(a, world.crystals[0]);
    expect(world.crystals.every((c) => c.removed)).toBe(true);
    expect(bl.get(3, 1, -3)).toBe(B.AIR);
    // A blast with open air under it (an anchor's, or anything not sitting on obsidian) digs a
    // crater in the grass.
    explode(world, 10.5, 0.5, 10.5, 5);
    let dug = 0;
    for (let x = 6; x <= 15; x++) for (let z = 6; z <= 15; z++) if (bl.get(x, -1, z) === B.AIR) dug++;
    expect(dug).toBeGreaterThan(5);
    expect(bl.get(4, 0, -3)).toBe(B.OBSIDIAN);
    expect(bl.get(0, 0, -3)).toBe(B.OBSIDIAN);
    expect(a.stats.crystalsBroken).toBe(2);
  });

  it('hurt immunity caps back-to-back crystals: a second blast within 10 ticks only adds the excess', () => {
    const { world, a, b } = setup(3);
    world.blocks.set(1, -1, 0, B.OBSIDIAN);
    const blow = () => {
      a.pos.set(0.5, 0, 3.5);
      a.selectSlot(2);
      a.rightClickDelay = 0;
      lookAt(a, 1.5, 0, 0.5);
      expect(a.startUsingItem(true)).toBe(true);
      attackCrystal(a, world.crystals[world.crystals.length - 1]);
    };
    b.absorption = 1000;
    blow();
    const first = 1000 - b.absorption;
    step(world, a, b);
    blow();
    const second = 1000 - b.absorption - first;
    expect(first).toBeGreaterThan(5);
    expect(second).toBeLessThan(0.01);
  });
});

describe('respawn anchors', () => {
  it('glowstone charges it; clicking with anything else blows it up (power 5) and starts fires', () => {
    const { world, a, b } = setup(6);
    const bl = world.blocks;
    a.selectSlot(3);
    lookAt(a, 0.5, 0, 2.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(bl.get(0, 0, 2)).toBe(B.RESPAWN_ANCHOR);
    a.selectSlot(4);
    a.rightClickDelay = 0;
    lookAt(a, 0.5, 0.5, 3);
    expect(a.startUsingItem(true)).toBe(true);
    expect(bl.anchorCharge(0, 0, 2)).toBe(1);
    expect(a.countItem('glowstone')).toBe(127);
    const hp = b.effectiveHealth();
    a.selectSlot(8); // the totem: any non-glowstone item
    a.rightClickDelay = 0;
    expect(a.startUsingItem(true)).toBe(true);
    expect([B.AIR, B.FIRE]).toContain(bl.get(0, 0, 2));
    expect(b.effectiveHealth() + b.stats.totemsPopped * 20).toBeLessThan(hp);
    let fire = 0;
    for (let x = -8; x <= 8; x++) for (let z = -6; z <= 10; z++) if (bl.get(x, 0, z) === B.FIRE) fire++;
    expect(fire).toBeGreaterThan(0);
    expect(a.stats.anchorsBlown).toBe(1);
  });
});

describe('ender pearls, crossbow, slow falling', () => {
  it('a pearl lands you where it hit for 5 fall damage (Feather Falling IV + Prot IV: 1 damage), 1 s cooldown', () => {
    const { world, a } = setup(20);
    a.selectSlot(6);
    a.yaw = Math.PI; // +Z, away
    a.pitch = 0.3;
    const start = a.pos.z;
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.cooldowns.get('ender_pearl')?.ticks).toBe(20);
    a.rightClickDelay = 0;
    expect(a.startUsingItem(true)).toBe(false);
    for (let t = 0; t < 80 && world.thrown.length; t++) step(world, a);
    expect(world.thrown.length).toBe(0);
    expect(a.pos.z - start).toBeGreaterThan(10);
    expect(20 - a.health).toBeCloseTo(damageAfterProtection(C.PEARL_DAMAGE, 20), 5);
  });

  it('Quick Charge III loads in 10 ticks; Multishot fires three Slow Falling arrows (30 s on hit)', () => {
    const { world, a, b } = setup(8);
    a.selectSlot(7);
    a.startUsingItem(true);
    for (let t = 0; t < 10; t++) step(world, a, b);
    a.releaseUsingItem();
    expect(a.inventory[7]?.charged).toBe(true);
    expect(a.countItem('tipped_arrow')).toBe(63);
    a.pitch = 0.05;
    a.yaw = 0;
    a.startUsingItem(true);
    expect(world.arrows.length).toBe(3);
    for (let t = 0; t < 10; t++) step(world, a, b);
    expect(b.effects.get('slow_falling')?.duration).toBeGreaterThan(560);
  });

  it('Slow Falling: gravity 0.01 and no fall distance', () => {
    const { world, a } = setup();
    a.addEffect('slow_falling', 0, 600);
    a.pos.y = 10;
    a.onGround = false;
    for (let t = 0; t < 20; t++) step(world, a);
    // Normal gravity would have dropped 7+ blocks by now.
    expect(a.pos.y).toBeGreaterThan(6);
    expect(a.fallDistance).toBe(0);
  });
});

function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number) {
  const m = new Match(crystal, DIFFICULTIES[botDiff], seed);
  const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[playerDiff], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  pb.resetRound();
  let insideBlock = 0;
  while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 3) {
    if (m.phase === 'fight') {
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    m.world.events.length = 0;
    for (const f of [m.player, m.bot]) {
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.health]) if (!Number.isFinite(v)) throw new Error('non-finite');
      f.events.length = 0;
    }
    // A bot never ends up inside a block.
    for (const f of [m.player, m.bot]) {
      const bb = f.aabb();
      if (m.world.blocks.boxHasSolid(bb.minX + 0.01, bb.minY + 0.01, bb.minZ + 0.01, bb.maxX - 0.01, bb.maxY - 0.01, bb.maxZ - 0.01)) insideBlock++;
    }
  }
  return { m, stuck: insideBlock };
}

describe('Crystal bot', () => {
  it('places obsidian, crystals and anchors, blows them up, and finishes duels', () => {
    const total = { placed: 0, broken: 0, anchors: 0 };
    for (let seed = 1; seed <= 3; seed++) {
      const { m, stuck } = duel('lt2', 'lt2', seed * 7);
      expect(m.phase).toBe('ended');
      expect(stuck).toBe(0);
      for (const f of [m.player, m.bot]) {
        total.placed += f.stats.crystalsPlaced;
        total.broken += f.stats.crystalsBroken;
        total.anchors += f.stats.anchorsBlown;
      }
    }
    expect(total.placed).toBeGreaterThan(5);
    expect(total.broken).toBeGreaterThan(5);
    expect(total.anchors).toBeGreaterThan(10);
  });

  it('scales with difficulty', () => {
    let wins = 0;
    for (let seed = 60; seed < 64; seed++) if (duel('lt1', 'lt3', seed).m.winner?.id === 'bot') wins++;
    expect(wins).toBeGreaterThanOrEqual(3);
  });

  it('the Practice bot never places or blows anything up', () => {
    const m = new Match(crystal, DIFFICULTIES.practice, 5);
    for (let i = 0; i < 400; i++) m.tick();
    expect(m.bot.stats.crystalsPlaced + m.bot.stats.anchorsBlown).toBe(0);
  });
});
