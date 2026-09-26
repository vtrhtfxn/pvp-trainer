import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { performAttack } from '../src/game/combat';
import { kitById, type KitDef } from '../src/game/kits';
import { Match } from '../src/game/Match';

/** The Sword kit with golden apples, for the retreat-and-eat game other kits (UHC) still play. */
const SWORD_APPLES: KitDef = {
  ...kitById('sword'),
  hotbar: [...kitById('sword').hotbar, { id: 'golden_apple', count: 5 }],
  noHunger: false,
};

/** Bot vs bot: the "player" is driven by a second brain so we can simulate whole duels. */
function duel(botDiff: DifficultyId, playerDiff: DifficultyId, seed: number, maxTicks = 20 * 60 * 4, kit = kitById('sword')) {
  const m = new Match(kit, DIFFICULTIES[botDiff], seed);
  const playerBrain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[playerDiff], new Rng(seed + 99), () =>
    performAttack(m.player, m.bot),
  );
  const states = new Set<string>();
  let minBotHp = 20;
  let maxMove = 0;
  while (m.phase !== 'ended' && m.tickCount < maxTicks) {
    if (m.phase === "fight") { playerBrain.tick(); m.useHeld = playerBrain.state === "eat"; }
    m.tick();
    states.add(m.brain.state);
    minBotHp = Math.min(minBotHp, m.bot.health);
    maxMove = Math.max(maxMove, Math.hypot(m.bot.pos.x, m.bot.pos.z + 6));
    for (const f of [m.player, m.bot]) {
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.vel.z, f.health, f.yaw, f.pitch]) {
        if (!Number.isFinite(v)) throw new Error(`non-finite state on ${f.id}`);
      }
      f.events.length = 0;
    }
  }
  return { m, states, minBotHp, maxMove };
}

describe('bot duels', () => {
  it('fights, retreats to eat golden apples, and finishes a duel', () => {
    let finished = 0;
    let ate = 0;
    let retreated = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { m, states } = duel('lt2', 'lt2', seed, undefined, SWORD_APPLES);
      if (m.phase === 'ended') finished++;
      if (m.bot.stats.gapplesEaten > 0) ate++;
      if (states.has('retreat')) retreated++;
      expect(m.bot.stats.hits).toBeGreaterThan(10);
      expect(m.player.pos.y).toBeGreaterThanOrEqual(0);
    }
    expect(finished).toBeGreaterThan(3);
    expect(ate).toBeGreaterThan(3);
    expect(retreated).toBeGreaterThan(3);
  });

  it('never attacks on Practice, but still moves and heals', () => {
    let moved = 0;
    for (let seed = 20; seed < 26; seed++) {
      const { m, maxMove } = duel('practice', 'lt3', seed);
      // The practice bot may swing zero times: no hits, no damage dealt, player untouched.
      expect(m.bot.stats.swings).toBe(0);
      expect(m.bot.stats.hits).toBe(0);
      expect(m.bot.stats.damageDealt).toBe(0);
      expect(m.player.health).toBe(20);
      expect(m.player.stats.damageTaken).toBe(0);
      // ...and it is still a moving target, not a statue.
      if (maxMove > 3) moved++;
    }
    expect(moved).toBe(6);
  });

  it('scales with difficulty', () => {
    let expertWins = 0;
    for (let seed = 10; seed < 18; seed++) {
      const { m } = duel('lt1', 'lt5', seed);
      if (m.winner === m.bot) expertWins++;
    }
    expect(expertWins).toBeGreaterThanOrEqual(7);
  });
});
