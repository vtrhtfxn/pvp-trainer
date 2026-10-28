import { describe, expect, it } from 'vitest';
import { B } from '../src/game/Blocks';
import { LUNGE_IMPULSE, performAttack } from '../src/game/combat';
import { Fighter } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { shulkerPotions } from '../src/game/items';
import { World } from '../src/game/World';

/** A at z = d looking toward -Z at B at z = 0, both in the Spear Mace kit. */
function setup(d = 3.5) {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, d, 0, kitById('spear_mace'));
  b.reset(0, 0, Math.PI, kitById('spear_mace'));
  a.selectSlot(7); // the spear
  for (let i = 0; i < 40; i++) a.tick(); // full cooldown
  return { world, a, b };
}

const count = (f: Fighter, id: string, potion?: string) =>
  [...f.inventory, f.offhand].reduce((n, s) => n + (s && s.id === id && (!potion || s.potion === potion) ? s.count : 0), 0);

describe('Spear Mace kit', () => {
  it('has exactly the listed gear', () => {
    const { a } = setup();
    expect(count(a, 'wind_charge')).toBe(256);
    expect(count(a, 'ender_pearl')).toBe(48);
    expect(count(a, 'golden_apple')).toBe(64);
    expect(count(a, 'cooked_beef')).toBe(64);
    expect(count(a, 'totem_of_undying')).toBe(2);
    expect(count(a, 'splash_potion', 'strength')).toBe(10);
    expect(count(a, 'splash_potion', 'swiftness')).toBe(10);
    const spear = a.inventory.find((s) => s?.id === 'netherite_spear')!;
    expect(spear.ench).toEqual({ lunge: 3, sharpness: 5, unbreaking: 3 });
    expect(a.inventory.find((s) => s?.id === 'mace')!.ench).toEqual({ density: 5, windBurst: 1, unbreaking: 3 });
    expect(a.armorSlots[3]!.ench).toEqual({ protection: 4, featherFalling: 4, unbreaking: 3 });
    const box = shulkerPotions(a.inventory.find((s) => s?.id === 'purple_shulker_box')!.stored!);
    expect(box.filter((p) => p === 'strength')).toHaveLength(14);
    expect(box.filter((p) => p === 'swiftness')).toHaveLength(13);
  });

  it('the purple shulker box hands out its potions when opened', () => {
    const { world, a } = setup();
    for (let i = 9; i < 36; i++) a.inventory[i] = null; // make room
    world.blocks.set(2, 0, 2, B.SHULKER_POTS, 27);
    expect(a.openShulker(2, 0, 2)).toBe(27);
    expect(count(a, 'splash_potion', 'strength')).toBe(14);
    expect(count(a, 'splash_potion', 'swiftness')).toBe(13);
    expect(world.blocks.shulkerCarts(2, 0, 2)).toBe(0);
  });
});

describe('spear jab', () => {
  it('reaches 4.5 blocks but not under 2, and only with a full cooldown', () => {
    const far = setup(4.4);
    expect(performAttack(far.a, far.b).hit).toBe(true);
    // Straight away again: still recharging, so nothing happens at all (no weak jab).
    const again = performAttack(far.a, far.b);
    expect(again.hit).toBe(false);
    const near = setup(1.5);
    expect(performAttack(near.a, near.b).hit).toBe(false);
    const out = setup(5.2);
    expect(performAttack(out.a, out.b).hit).toBe(false);
  });

  it('never crits and never sprint-knocks', () => {
    const { a, b } = setup(3);
    a.serverSprinting = a.sprinting = true;
    a.onGround = false;
    a.fallDistance = 1;
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(r.crit).toBe(false);
    expect(r.sprint).toBe(false);
  });

  it('Lunge throws you forward along your facing, flat, and costs hunger', () => {
    const { a, b } = setup(3);
    a.pitch = -1; // looking down: still a flat push
    const sat = a.food.saturation + a.food.level;
    performAttack(a, b);
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeCloseTo(LUNGE_IMPULSE * 3, 1);
    expect(a.vel.z).toBeLessThan(0); // toward the target (-Z)
    expect(a.food.saturation + a.food.level).toBeLessThan(sat + 1e-9);
    expect(a.events.some((e) => e.type === 'lunge')).toBe(true);
  });

  it('no Lunge when hungry (under 7 food) or in water', () => {
    const hungry = setup(3);
    hungry.a.food.level = 6;
    hungry.a.food.saturation = 0;
    performAttack(hungry.a, hungry.b);
    expect(Math.hypot(hungry.a.vel.x, hungry.a.vel.z)).toBeLessThan(0.1);
  });
});

describe('spear charge', () => {
  it('hits for 1.2 × closing speed once lowered, only above 4.6 blocks/s', () => {
    const run = (speedBlocksPerTick: number) => {
      const { a, b } = setup(4);
      a.selectSlot(7);
      expect(a.startUsingItem(true)).toBe(true);
      expect(a.useKind()).toBe('spear');
      let hit: { damage: number; speed: number } | null = null;
      for (let i = 0; i < 12 && !hit; i++) {
        a.vel.set(0, 0, -speedBlocksPerTick); // running at the target
        a.events.length = 0;
        a.tick();
        const e = a.events.find((x) => x.type === 'spearCharge');
        if (e && e.type === 'spearCharge') hit = e;
        a.pos.set(0, 0, 4); // hold the distance
      }
      return { hit, b };
    };
    const fast = run(0.35); // 7 blocks/s
    expect(fast.hit).not.toBeNull();
    expect(fast.hit!.speed).toBeCloseTo(7, 0);
    expect(fast.b.health).toBeLessThan(20);
    const slow = run(0.2); // 4 blocks/s: under the threshold
    expect(slow.hit).toBeNull();
    expect(slow.b.health).toBe(20);
  });
});

describe('Spear Mace bots', () => {
  it('jab with Lunge on the way in (and still smash with the mace)', async () => {
    const { DIFFICULTIES } = await import('../src/ai/difficulty');
    const { Spectate } = await import('../src/game/Spectate');
    const s = new Spectate(kitById('spear_mace'), DIFFICULTIES.ht1, DIFFICULTIES.ht1, 3);
    let lunges = 0;
    let smashes = 0;
    for (let i = 0; i < 20 * 120; i++) {
      s.tick();
      for (const f of [s.match.player, s.match.bot]) {
        for (const e of f.events) {
          if (e.type === 'lunge') lunges++;
          if (e.type === 'smash') smashes++;
        }
        f.events.length = 0;
      }
      s.match.world.events.length = 0;
    }
    expect(lunges).toBeGreaterThan(0);
    expect(smashes).toBeGreaterThan(0);
  }, 60000);
});
