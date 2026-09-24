import { describe, expect, it } from 'vitest';
import { BotBrain, ballistic } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { Match } from '../src/game/Match';
import * as C from '../src/core/constants';
import { B } from '../src/game/Blocks';
import { performAttack } from '../src/game/combat';
import { Fighter, SLOT_OFFHAND } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { World } from '../src/game/World';

const uhc = kitById('uhc');

/** a at z=dist facing -Z (toward b), b at z=0 facing +Z. Positions at block centres. */
function setup(dist = 3) {
  const world = new World(24);
  world.shieldStuns = true;
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0.5, dist + 0.5, 0, uhc);
  b.reset(0.5, 0.5, Math.PI, uhc);
  a.naturalRegen = b.naturalRegen = false;
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

/** Points `f` at the centre of a block face / position. */
function lookAt(f: Fighter, x: number, y: number, z: number) {
  const ex = f.pos.x;
  const ey = f.pos.y + f.eyeHeight();
  const ez = f.pos.z;
  const dx = x - ex;
  const dz = z - ez;
  f.yaw = Math.atan2(-dx, -dz);
  f.pitch = Math.atan2(y - ey, Math.hypot(dx, dz));
}

describe('UHC loadout', () => {
  it('matches the mcpvp.club tier-test kit', () => {
    const { a } = setup();
    const ids = a.inventory.slice(0, 9).map((s) => s?.id);
    expect(ids).toEqual(['diamond_sword', 'diamond_axe', 'golden_head', 'golden_apple', 'water_bucket', 'lava_bucket', 'crossbow', 'oak_planks', 'cobweb']);
    expect(a.getSlot(SLOT_OFFHAND)?.id).toBe('shield');
    expect(a.countItem('water_bucket')).toBe(4);
    expect(a.countItem('lava_bucket')).toBe(2);
    expect(a.countItem('oak_planks')).toBe(128);
    expect(a.countItem('cobweb')).toBe(8);
    expect(a.countItem('arrow')).toBe(10);
    expect(a.countItem('golden_apple')).toBe(8);
    expect(a.countItem('golden_head')).toBe(2);
    expect(a.armor.protectionEpf).toBe(10);
    expect(a.inventory[0]?.ench?.sharpness).toBe(3);
  });
});

describe('blocks', () => {
  it('places planks on the floor, stands on them, and never places into a player', () => {
    const { a, b, world } = setup(3);
    a.selectSlot(7);
    // Into b's feet: the floor under b is behind b's hitbox, so nothing is placed.
    lookAt(a, 0.5, 0, 0.9);
    a.startUsingItem(true);
    a.stopUsingItem(); // (the click fell through to the shield)
    expect(world.blocks.get(0, 0, 0)).toBe(B.AIR);
    expect(a.countItem('oak_planks')).toBe(128);
    // The floor cell between them, z = 2.
    a.rightClickDelay = 0;
    lookAt(a, 0.5, 0, 2.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(world.blocks.get(0, 0, 2)).toBe(B.PLANKS);
    expect(a.countItem('oak_planks')).toBe(127);
    // Walk onto the block: collision lifts nothing, it stops us instead (no step-up for 1 block).
    b.yaw = Math.PI;
    b.input.forward = 1;
    for (let t = 0; t < 30; t++) step(world, a, b);
    expect(b.pos.z).toBeLessThan(2 - 0.3 + 1e-6);
  });

  it('a 3-high pillar: jump and place under yourself', () => {
    const { a, world } = setup(6);
    a.selectSlot(7);
    for (let n = 0; n < 3; n++) {
      a.input.jump = true;
      for (let t = 0; t < 30; t++) {
        a.pitch = -Math.PI / 2 + 0.001;
        step(world, a);
        if (a.pos.y > n + 1.05 && a.vel.y < 0.2) {
          a.startUsingItem(true);
        }
        if (a.onGround && a.pos.y >= n + 1) break;
      }
    }
    a.input.jump = false;
    for (let t = 0; t < 20; t++) step(world, a);
    expect(a.pos.y).toBe(3);
    expect(world.blocks.get(0, 2, 6)).toBe(B.PLANKS);
  });

  it('mining times: Efficiency III axe on planks 4 ticks, sword on cobweb 8, fist on planks 60', () => {
    const { a, world } = setup(3);
    const mine = (slot: number, id: number) => {
      world.blocks.set(0, 0, 2, id);
      a.selectSlot(slot);
      for (let t = 0; t < 30; t++) step(world, a); // equip settles
      lookAt(a, 0.5, 0.5, 3);
      let ticks = 0;
      a.tickMining(true, true);
      ticks++;
      while (world.blocks.get(0, 0, 2) !== B.AIR && ticks < 200) {
        a.tickMining(true, false);
        ticks++;
      }
      return ticks;
    };
    expect(mine(1, B.PLANKS)).toBe(4);
    expect(mine(0, B.COBWEB)).toBe(8);
    a.inventory[4] = null;
    expect(mine(4, B.PLANKS)).toBe(60);
  });

  it('broken planks drop and get picked up', () => {
    const { a, b, world } = setup(2);
    b.pos.set(10.5, 0, 10.5); // out of pickup range
    world.blocks.set(0, 0, 1, B.PLANKS);
    a.selectSlot(1);
    lookAt(a, 0.5, 0.5, 2);
    for (let t = 0; t < 10; t++) a.tickMining(true, t === 0);
    expect(world.blocks.get(0, 0, 1)).toBe(B.AIR);
    expect(world.items.length).toBe(1);
    for (let t = 0; t < 20; t++) step(world, a);
    // Walk over to where it landed.
    a.pos.set(world.items[0].pos.x, 0, world.items[0].pos.z + 0.5);
    for (let t = 0; t < 5; t++) step(world, a);
    expect(world.items.length).toBe(0);
    expect(a.countItem('oak_planks')).toBe(129);
  });
});

describe('buckets and fluids', () => {
  it('water spreads 7 blocks on flat ground and recedes when picked back up', () => {
    const { a, world } = setup(8);
    a.selectSlot(4);
    lookAt(a, 0.5, 0, 6.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.inventory[4]?.id).toBe('bucket');
    expect(world.blocks.isSource(0, 0, 6)).toBe(true);
    for (let t = 0; t < 60; t++) world.blocks.tick();
    expect(world.blocks.get(0, 0, 6 - 7)).toBe(B.WATER);
    expect(world.blocks.get(0, 0, 6 - 8)).toBe(B.AIR);
    // Pick it back up.
    a.rightClickDelay = 0;
    lookAt(a, 0.5, 0.5, 6.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.inventory[4]?.id).toBe('water_bucket');
    for (let t = 0; t < 60; t++) world.blocks.tick();
    expect(world.blocks.count).toBe(0);
  });

  it('lava poured at their feet burns: 4 damage through armor, fire for 15 s; water puts it out', () => {
    const { a, b, world } = setup(3);
    a.selectSlot(5);
    // Buckets ignore players: aim straight through b at the floor it stands on.
    lookAt(a, 0.5, 0, 0.5);
    expect(a.startUsingItem(true)).toBe(true);
    expect(world.blocks.get(0, 0, 0)).toBe(B.LAVA);
    step(world, a, b);
    expect(b.inLava).toBe(true);
    expect(b.health).toBeLessThan(20);
    expect(b.fireTicks).toBeGreaterThan(250);
    // b pours water at its own feet: the source lava hardens into obsidian and the fire goes out.
    b.selectSlot(4);
    b.pitch = -Math.PI / 2 + 0.01;
    b.pos.z = 1.2; // step half out
    expect(b.startUsingItem(true)).toBe(true);
    step(world, a, b);
    expect(world.blocks.get(0, 0, 0)).toBe(B.OBSIDIAN);
    for (let t = 0; t < 3; t++) step(world, a, b);
    expect(b.inWater).toBe(true);
    expect(b.fireTicks).toBe(0);
  });

  it('cobwebs slow you to a crawl and cancel knockback', () => {
    const { a, b, world } = setup(2);
    world.blocks.set(0, 0, 0, B.COBWEB);
    world.blocks.set(0, 1, 0, B.COBWEB);
    step(world, a, b);
    expect(b.inWeb).toBe(true);
    a.attackStrengthTicker = 100;
    a.selectSlot(0);
    for (let t = 0; t < 20; t++) step(world, a, b);
    a.attackStrengthTicker = 100;
    const z0 = b.pos.z;
    performAttack(a, b);
    for (let t = 0; t < 10; t++) step(world, a, b);
    expect(Math.abs(b.pos.z - z0)).toBeLessThan(0.15);
  });
});

describe('UHC items', () => {
  it('golden head: 1 s, Regeneration III (4 hearts over 5 s), Absorption I, 10 s cooldown', () => {
    const { a, world } = setup(8);
    a.health = 10;
    a.selectSlot(2);
    for (let t = 0; t < 2; t++) step(world, a);
    expect(a.startUsingItem(true)).toBe(true);
    for (let t = 0; t < 20; t++) step(world, a);
    expect(a.usingItem).toBe(false);
    expect(a.effects.get('regeneration')?.amplifier).toBe(2);
    expect(a.absorption).toBe(4);
    expect(a.cooldowns.get('golden_head')?.ticks).toBeGreaterThan(190);
    a.rightClickDelay = 0;
    // On cooldown: the click falls through to the off-hand shield instead.
    a.startUsingItem(true);
    expect(a.useKind()).toBe('shield');
    a.stopUsingItem();
    for (let t = 0; t < 100; t++) step(world, a);
    expect(a.health).toBe(18);
    for (let t = 0; t < 100; t++) step(world, a);
    a.rightClickDelay = 0;
    a.startUsingItem(true);
    expect(a.useKind()).toBe('food');
  });

  it('natural regeneration is off', () => {
    const { a, world } = setup();
    a.health = 10;
    for (let t = 0; t < 400; t++) step(world, a);
    expect(a.health).toBe(10);
  });

  it('stuns: disabling a shield clears hurt immunity so the follow-up lands at once', () => {
    const { a, b, world } = setup(2);
    b.selectSlot(0);
    b.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a, b);
    a.selectSlot(1);
    for (let t = 0; t < 20; t++) step(world, a, b);
    const r = performAttack(a, b);
    expect(r.disabled).toBe(true);
    expect(b.invulnerableTime).toBe(0);
    const r2 = performAttack(a, b);
    expect(r2.hit).toBe(true);
    expect(b.health).toBeLessThan(20);
  });

  it('a Piercing crossbow bolt goes through a raised shield; Power adds a point of arrow damage', () => {
    const { a, b, world } = setup(8);
    b.selectSlot(0);
    b.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a, b);
    a.selectSlot(6);
    a.startUsingItem(true);
    for (let t = 0; t < 26; t++) step(world, a, b);
    a.releaseUsingItem();
    a.pitch = ballistic(8, 1.0 - (C.EYE_HEIGHT - 0.1), C.CROSSBOW_SPEED)!.pitch;
    a.yaw = 0;
    expect(a.startUsingItem(true)).toBe(true);
    for (let t = 0; t < 10; t++) step(world, a, b);
    expect(b.health).toBeLessThan(20);
    expect(b.stats.blocked).toBe(0);
  });
});

/** Bot vs bot in UHC; counts the UHC tricks both sides use. */
function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number) {
  const m = new Match(uhc, DIFFICULTIES[botDiff], seed);
  const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[playerDiff], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  pb.resetRound();
  const used = { lava: 0, water: 0, web: 0, planks: 0, broken: 0 };
  while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 4) {
    if (m.phase === 'fight') {
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    for (const e of m.world.events) {
      if (e.type === 'blockPlace' && e.block === B.COBWEB) used.web++;
      if (e.type === 'blockPlace' && e.block === B.PLANKS) used.planks++;
      if (e.type === 'blockBreak') used.broken++;
    }
    m.world.events.length = 0;
    for (const f of [m.player, m.bot]) {
      for (const e of f.events) if (e.type === 'bucket' && !e.fill) e.fluid === B.LAVA ? used.lava++ : used.water++;
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.health]) if (!Number.isFinite(v)) throw new Error('non-finite');
      f.events.length = 0;
    }
  }
  return { m, used };
}

describe('UHC bot', () => {
  it('uses lava, water, webs and blocks, and finishes duels', () => {
    const total = { lava: 0, water: 0, web: 0, planks: 0, broken: 0 };
    let finished = 0;
    for (let seed = 1; seed <= 5; seed++) {
      const { m, used } = duel('lt2', 'lt1', seed * 3);
      if (m.phase === 'ended') finished++;
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += used[k];
    }
    expect(finished).toBe(5);
    expect(total.lava).toBeGreaterThan(2);
    expect(total.water).toBeGreaterThan(2);
    expect(total.web).toBeGreaterThan(2);
    expect(total.planks).toBeGreaterThan(2);
  });

  it('scales with difficulty', () => {
    let wins = 0;
    for (let seed = 60; seed < 66; seed++) if (duel('lt1', 'lt3', seed).m.winner?.id === 'bot') wins++;
    expect(wins).toBeGreaterThanOrEqual(5);
  });
});
