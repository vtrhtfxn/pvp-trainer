import { describe, expect, it } from 'vitest';
import { BotBrain, ballistic } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import * as C from '../src/core/constants';
import { Rng } from '../src/core/rng';
import { damageAfterArmor, performAttack } from '../src/game/combat';
import { Fighter, SLOT_OFFHAND } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { World } from '../src/game/World';

const axeKit = kitById('axe');

/** a at z=2 facing -Z (toward b), b at z=0 facing +Z (toward a). */
function setup(dist = 2) {
  const world = new World(40);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, dist, 0, axeKit);
  b.reset(0, 0, Math.PI, axeKit);
  return { world, a, b };
}

function step(world: World, ...fs: Fighter[]) {
  for (const f of fs) f.snapshot();
  for (const f of fs) f.tick();
  world.tickEntities();
}

function charge(f: Fighter) {
  f.attackStrengthTicker = 100;
}

describe('axe kit loadout', () => {
  it('matches the tier-test kit: axe, sword, crossbow, bow, 6 arrows, shield, diamond armor', () => {
    const { a } = setup();
    expect(a.inventory.slice(0, 5).map((s) => s?.id)).toEqual(['diamond_axe', 'diamond_sword', 'crossbow', 'bow', 'arrow']);
    expect(a.inventory[4]?.count).toBe(6);
    expect(a.getSlot(SLOT_OFFHAND)?.id).toBe('shield');
    expect(a.armor.points).toBe(20);
    expect(a.armor.toughness).toBe(8);
    expect(a.armor.protectionEpf).toBe(0);
  });
});

describe('off hand', () => {
  it('right click falls through a sword to the off-hand shield', () => {
    const { a } = setup();
    a.selectSlot(1); // sword
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.useHand).toBe('off');
    expect(a.raisingShield()).toBe(true);
  });

  it('F swaps hands and a golden apple in the off hand is eaten behind a sword', () => {
    const { a, world } = setup();
    a.inventory[5] = { id: 'golden_apple', count: 2 };
    a.selectSlot(5);
    a.swapHands(); // apple -> off hand, shield -> main hand slot 5
    expect(a.offhand?.id).toBe('golden_apple');
    expect(a.inventory[5]?.id).toBe('shield');
    a.selectSlot(1);
    step(world, a);
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.useKind()).toBe('food');
    for (let i = 0; i < 40 && a.usingItem; i++) step(world, a);
    expect(a.offhand?.count).toBe(1);
    expect(a.effects.has('absorption')).toBe(true);
  });

  it('keeps an off-hand shield up while scrolling the hotbar', () => {
    const { a, world } = setup();
    a.selectSlot(1);
    a.startUsingItem(true);
    a.selectSlot(0);
    step(world, a);
    expect(a.raisingShield()).toBe(true);
  });
});

describe('shields', () => {
  it('blocks a front hit only after 5 ticks raised', () => {
    const { a, b, world } = setup();
    b.selectSlot(1);
    b.startUsingItem(true);
    for (let t = 0; t < C.SHIELD_RAISE_TICKS - 1; t++) step(world, a, b);
    expect(b.isBlocking()).toBe(false);
    step(world, a, b);
    expect(b.isBlocking()).toBe(true);

    a.selectSlot(1);
    step(world, a, b);
    charge(a);
    const r = performAttack(a, b);
    expect(r.blocked).toBe(true);
    expect(b.health).toBe(20);
    expect(b.shieldCooldown).toBe(0); // a sword does not disable
  });

  it('does not block a hit from behind', () => {
    const { a, b, world } = setup();
    b.yaw = 0; // turn away from a
    b.selectSlot(1);
    b.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a, b);
    a.selectSlot(1);
    step(world, a, b);
    charge(a);
    const r = performAttack(a, b);
    expect(r.hit).toBe(true);
    expect(b.health).toBeLessThan(20);
  });

  it('an axe disables the shield for 5 seconds', () => {
    const { a, b, world } = setup();
    b.selectSlot(1);
    b.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a, b);
    const r = performAttack(a, b); // slot 0 is the axe, cooldown not even charged
    expect(r.disabled).toBe(true);
    expect(b.usingItem).toBe(false);
    expect(b.shieldCooldown).toBe(C.SHIELD_DISABLE_TICKS);
    expect(b.startUsingItem(true)).toBe(false);
    for (let t = 0; t < C.SHIELD_DISABLE_TICKS; t++) step(world, a, b);
    expect(b.startUsingItem(true)).toBe(true);
  });
});

describe('attribute swapping', () => {
  it('switching and swinging on the same tick uses the old item attributes', () => {
    const { a, b, world } = setup();
    a.selectSlot(1); // sword
    for (let t = 0; t < 20; t++) step(world, a, b);
    expect(a.attrId).toBe('diamond_sword');
    // Same tick: axe in hand, sword attributes still applied.
    a.selectSlot(0);
    const r = performAttack(a, b);
    expect(r.swap).toBe(true);
    expect(r.scale).toBe(1); // the sword's charged cooldown, not the axe's reset one
    expect(r.damage).toBeCloseTo(damageAfterArmor(7, 20, 8), 4);
    step(world, a, b);
    expect(a.attrId).toBe('diamond_axe');
  });

  it('sword attributes with the axe effect: an attribute swap disables a shield at full charge', () => {
    const { a, b, world } = setup();
    a.selectSlot(1);
    b.selectSlot(1);
    b.startUsingItem(true);
    for (let t = 0; t < 20; t++) step(world, a, b);
    a.selectSlot(0);
    const r = performAttack(a, b);
    expect(r.swap && r.disabled).toBe(true);
  });

  it('a normal switch resets the cooldown on the next tick', () => {
    const { a, b, world } = setup();
    a.selectSlot(1);
    for (let t = 0; t < 20; t++) step(world, a, b);
    a.selectSlot(0);
    step(world, a, b);
    expect(a.attackStrengthScale(0.5)).toBeLessThan(0.1);
    expect(a.attackDelay()).toBe(20);
  });
});

describe('bows and crossbows', () => {
  it('a fully drawn bow hits a target 12 blocks away for 6–10 before armor', () => {
    const { a, b, world } = setup(12);
    a.selectSlot(3);
    a.pitch = ballistic(12, 1.0 - (C.EYE_HEIGHT - 0.1), C.BOW_MAX_SPEED)!.pitch;
    expect(a.startUsingItem(true)).toBe(true);
    for (let t = 0; t < 20; t++) step(world, a, b);
    a.releaseUsingItem();
    expect(a.countItem('arrow')).toBe(5);
    for (let t = 0; t < 20; t++) step(world, a, b);
    expect(a.stats.arrowHits).toBe(1);
    expect(b.health).toBeLessThan(20);
    expect(20 - b.health).toBeGreaterThan(damageAfterArmor(6, 20, 8) - 1e-6);
  });

  it('a crossbow loads in 25 ticks and fires on the next click', () => {
    const { a, b, world } = setup(8);
    a.selectSlot(2);
    a.startUsingItem(true);
    for (let t = 0; t < 10; t++) step(world, a, b);
    a.releaseUsingItem();
    expect(a.inventory[2]?.charged).toBeFalsy();
    step(world, a, b);
    a.rightClickDelay = 0;
    a.startUsingItem(true);
    for (let t = 0; t < 25; t++) step(world, a, b);
    a.releaseUsingItem();
    expect(a.inventory[2]?.charged).toBe(true);
    expect(a.countItem('arrow')).toBe(5);
    a.pitch = ballistic(8, 1.0 - (C.EYE_HEIGHT - 0.1), C.CROSSBOW_SPEED)!.pitch;
    expect(a.startUsingItem(true)).toBe(true);
    expect(a.inventory[2]?.charged).toBe(false);
    for (let t = 0; t < 10; t++) step(world, a, b);
    expect(b.health).toBeLessThan(20);
  });

  it('a raised shield stops arrows, and arrows can be picked back up', () => {
    const { a, b, world } = setup(8);
    b.selectSlot(1);
    b.startUsingItem(true);
    for (let t = 0; t < 6; t++) step(world, a, b);
    a.selectSlot(3);
    a.pitch = ballistic(8, 1.0 - (C.EYE_HEIGHT - 0.1), C.BOW_MAX_SPEED)!.pitch;
    a.startUsingItem(true);
    for (let t = 0; t < 20; t++) step(world, a, b);
    a.releaseUsingItem();
    for (let t = 0; t < 40; t++) step(world, a, b);
    expect(b.health).toBe(20);
    expect(b.stats.blocked).toBe(1);
    // The arrow bounced off and dropped a couple of blocks in front of b; b walks over it.
    b.releaseUsingItem();
    b.input.forward = 1;
    for (let t = 0; t < 30 && world.arrows.length; t++) step(world, a, b);
    expect(b.countItem('arrow')).toBe(7);
    expect(world.arrows.length).toBe(0);
  });
});

/** Bot vs bot in the Axe kit. */
function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number, maxTicks = 20 * 60 * 3) {
  const m = new Match(axeKit, DIFFICULTIES[botDiff], seed);
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

describe('axe bot', () => {
  it('blocks, disables shields and finishes duels', () => {
    let finished = 0;
    let disabled = 0;
    let blocked = 0;
    let swaps = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const m = duel('lt2', 'lt2', seed);
      if (m.phase === 'ended') finished++;
      disabled += m.bot.stats.shieldsDisabled + m.player.stats.shieldsDisabled;
      blocked += m.bot.stats.blocked + m.player.stats.blocked;
      swaps += m.bot.stats.attributeSwaps + m.player.stats.attributeSwaps;
    }
    expect(finished).toBeGreaterThanOrEqual(5);
    expect(disabled).toBeGreaterThan(6);
    expect(blocked).toBeGreaterThan(6);
    expect(swaps).toBeGreaterThan(3);
  });

  it('scales with difficulty', () => {
    let wins = 0;
    for (let seed = 30; seed < 38; seed++) {
      const m = duel('lt1', 'lt5', seed);
      if (m.winner === m.bot) wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(7);
  });

  it('Practice holds its shield up but never swings', () => {
    for (let seed = 50; seed < 53; seed++) {
      const m = duel('practice', 'lt3', seed, 20 * 40);
      expect(m.bot.stats.swings).toBe(0);
      expect(m.bot.stats.arrowsShot).toBe(0);
      expect(m.bot.stats.blocked).toBeGreaterThan(0);
    }
  });
});
