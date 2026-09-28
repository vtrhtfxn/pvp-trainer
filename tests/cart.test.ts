import { describe, expect, it } from 'vitest';
import { Arrow } from '../src/game/Arrow';
import { B } from '../src/game/Blocks';
import { explode } from '../src/game/Explosion';
import { Fighter } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { placeCart } from '../src/game/TntCart';
import { World } from '../src/game/World';

function setup(kit = 'cart') {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, 8, 0, kitById(kit as never)); // at z=8 looking toward -Z
  b.reset(0, 0, Math.PI, kitById(kit as never));
  return { world, a, b };
}

function run(world: World, ticks: number, ...fs: Fighter[]) {
  for (let i = 0; i < ticks; i++) {
    for (const f of fs) f.snapshot();
    for (const f of fs) f.tick();
    world.tickEntities();
  }
}

function arrowAt(world: World, owner: Fighter, fromZ: number, toX: number, toY: number, toZ: number, burning: boolean) {
  const ar = new Arrow(owner, toX, toY, fromZ, false);
  ar.shoot(0, 0, toZ - fromZ, 3, 0, world.rng);
  if (burning) ar.fireTicks = 100;
  world.spawnArrow(ar);
  return ar;
}

describe('Cart', () => {
  it('lays rails on solid ground, along the way you face', () => {
    const { world, a } = setup();
    a.selectSlot(8); // rails
    a.pitch = -Math.PI / 2 + 0.01; // straight down at our feet' block... look at the floor ahead
    a.pitch = -1.2;
    expect(a.startUsingItem(true)).toBe(true);
    const placed = [...Array(9).keys()].map((d) => world.blocks.get(0, 0, 8 - d)).indexOf(B.RAIL);
    expect(placed).toBeGreaterThanOrEqual(0);
    expect(world.blocks.railAxis(0, 0, 8 - placed)).toBe(0); // facing -Z: a north–south rail
  });

  it('a burning arrow blows a TNT minecart up at once; a cold one just breaks it', () => {
    const { world, a, b } = setup();
    world.blocks.set(0, 0, 2, B.RAIL);
    const cart = placeCart(world, a, 0, 0, 2);
    expect(world.carts).toHaveLength(1);
    arrowAt(world, a, 6, 0.5, 0.35, 2, false);
    run(world, 4);
    expect(cart.removed).toBe(true);
    expect(b.health).toBe(20); // no blast

    const hot = placeCart(world, a, 0, 0, 2);
    arrowAt(world, a, 6, 0.5, 0.35, 2, true);
    run(world, 4);
    expect(hot.removed).toBe(true);
    // B stands two blocks away: a power 4–8.5 blast takes a totem or a big chunk of health.
    expect(b.stats.damageTaken).toBeGreaterThan(5);
  });

  it('an arrow shot through fire catches, and flint and steel makes that fire', () => {
    const { world, a } = setup();
    a.selectSlot(0);
    // Put the flint and steel in hand and light the floor two blocks ahead.
    a.inventory[0] = { id: 'flint_and_steel', count: 1 };
    a.pitch = -0.9;
    expect(a.startUsingItem(true)).toBe(true);
    let fz = NaN;
    for (let z = 8; z > 0; z--) if (world.blocks.get(0, 0, z) === B.FIRE) fz = z;
    expect(fz).not.toBeNaN();
    expect(a.inventory[0]?.damage).toBe(1);
    const ar = arrowAt(world, a, fz + 3, 0.5, 0.5, fz - 3, false);
    run(world, 2);
    expect(ar.fireTicks).toBeGreaterThan(0);
  });

  it('a blast lights carts nearby with a short fuse, and they go off in turn', () => {
    const { world, a } = setup();
    world.blocks.set(5, 0, -5, B.RAIL);
    const cart = placeCart(world, a, 5, 0, -5);
    explode(world, 3, 0.5, -5, 4, { source: a });
    expect(cart.primed).toBe(true);
    expect(cart.fuse).toBeLessThanOrEqual(38);
    run(world, 40);
    expect(cart.removed).toBe(true);
  });

  it('a rail goes when the block under it does', () => {
    const { world } = setup();
    world.blocks.set(3, 0, 3, B.OBSIDIAN);
    world.blocks.set(3, 1, 3, B.RAIL);
    world.blocks.set(3, 0, 3, B.AIR);
    expect(world.blocks.get(3, 1, 3)).toBe(B.AIR);
  });
});

describe('Diamond SMP items', () => {
  it('fills every slot, with Depth Strider boots and one totem', () => {
    const k = kitById('dia_smp');
    expect([...k.hotbar, ...k.main!].every(Boolean)).toBe(true);
    expect(k.armor[3]?.ench).toMatchObject({ featherFalling: 4, depthStrider: 3 });
    expect(k.armor[2]?.ench?.swiftSneak).toBe(3);
    const all = [...k.hotbar, ...k.main!, k.offhand];
    const count = (id: string, potion?: string) => all.filter((s) => s?.id === id && (!potion || s.potion === potion)).reduce((n, s) => n + s!.count, 0);
    expect(count('splash_potion', 'strength')).toBe(15);
    expect(count('splash_potion', 'long_swiftness')).toBe(3);
    expect(count('splash_potion', 'fire_resistance')).toBe(3);
    expect(count('golden_apple')).toBe(128);
    expect(count('water_bucket')).toBe(4);
    expect(count('totem_of_undying')).toBe(1);
    expect(count('chorus_fruit')).toBe(3);
  });

  it('chorus fruit teleports you within 8 blocks when eaten', () => {
    const { world, a } = setup('dia_smp');
    const slot = a.inventory.findIndex((s) => s?.id === 'chorus_fruit');
    a.inventory[0] = a.inventory[slot];
    a.selectSlot(0);
    const x0 = a.pos.x;
    const z0 = a.pos.z;
    expect(a.startUsingItem(true)).toBe(true);
    run(world, 33, a);
    const moved = Math.hypot(a.pos.x - x0, a.pos.z - z0);
    expect(moved).toBeGreaterThan(0.01);
    expect(moved).toBeLessThanOrEqual(8 * Math.SQRT2 + 0.01);
    expect(a.cooldowns.has('chorus_fruit')).toBe(true);
  });

  it('Depth Strider III swims much faster', () => {
    const speed = (ds: number) => {
      const { world, a } = setup('dia_smp');
      for (let x = -3; x <= 3; x++) for (let z = -12; z <= 9; z++) world.blocks.set(x, 0, z, B.WATER, 8, true);
      a.armorSlots[3] = { id: 'diamond_boots', count: 1, ench: ds ? { depthStrider: ds } : undefined };
      a.input.forward = 1;
      run(world, 20, a);
      const z0 = a.pos.z;
      run(world, 20, a);
      return z0 - a.pos.z;
    };
    expect(speed(3)).toBeGreaterThan(speed(0) * 1.8);
  });
});
