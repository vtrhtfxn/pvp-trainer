import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES, DIFFICULTY_ORDER, LEGACY_DIFFICULTY, type TierId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { Match } from '../src/game/Match';
import { performAttack } from '../src/game/combat';
import { kitById, type KitId } from '../src/game/kits';

/** A duel between two tiers; a timeout goes to whoever is better off. */
function duel(kit: KitId, bot: TierId, player: TierId, seed: number): 'bot' | 'player' {
  const m = new Match(kitById(kit), DIFFICULTIES[bot], seed);
  const pb = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES[player], new Rng(seed + 99), () => performAttack(m.player, m.bot));
  pb.resetRound();
  while (m.phase !== 'ended' && m.tickCount < 20 * 60 * 4) {
    if (m.phase === 'fight') {
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    m.world.events.length = 0;
    m.player.events.length = 0;
    m.bot.events.length = 0;
  }
  if (m.winner) return m.winner.id === 'bot' ? 'bot' : 'player';
  const score = (f: typeof m.bot) => f.effectiveHealth() + 20 * f.countItem('totem_of_undying');
  return score(m.bot) >= score(m.player) ? 'bot' : 'player';
}

describe('tier ladder', () => {
  it('has Practice then LT5 … HT1, and maps the old difficulty names onto it', () => {
    expect(DIFFICULTY_ORDER).toEqual(['practice', 'lt5', 'ht5', 'lt4', 'ht4', 'lt3', 'ht3', 'lt2', 'ht2', 'lt1', 'ht1']);
    for (const id of Object.values(LEGACY_DIFFICULTY)) expect(DIFFICULTIES[id]).toBeDefined();
  });

  it('gets stronger every tier: reach, reactions and click timing', () => {
    const tiers = DIFFICULTY_ORDER.slice(1).map((id) => DIFFICULTIES[id]);
    for (let i = 1; i < tiers.length; i++) {
      const [a, b] = [tiers[i - 1], tiers[i]];
      expect(b.maxReach).toBeGreaterThan(a.maxReach);
      expect(b.reactionTicks).toBeLessThanOrEqual(a.reactionTicks);
      expect(b.aimNoiseDeg).toBeLessThan(a.aimNoiseDeg);
      expect(b.neth.totemReact).toBeLessThanOrEqual(a.neth.totemReact);
      expect(b.crystal.clickGap).toBeLessThanOrEqual(a.crystal.clickGap);
    }
  });

  it('unlocks every item by LT2, only the basics at LT5', () => {
    const lt5 = DIFFICULTIES.lt5;
    expect(lt5.crystal.anchors || lt5.crystal.crossbow || lt5.crystal.surround || lt5.crystal.mine || lt5.uhc.water).toBe(false);
    for (const id of ['lt2', 'ht2', 'lt1', 'ht1'] as const) {
      const p = DIFFICULTIES[id];
      expect(p.crystal).toMatchObject({ anchors: true, crossbow: true, surround: true, mine: true, iframeTiming: true, pearls: 2 });
      expect(p.uhc).toMatchObject({ water: true, mine: true, pillar: true, lavaPickup: true });
      expect(p.axe).toMatchObject({ swap: true, ranged: 2 });
      expect(p.neth).toMatchObject({ hotbarTotem: true, rebuff: true });
      expect(p.neth.mendAt).toBeGreaterThan(0);
    }
  });

  const kits: KitId[] = ['sword', 'axe', 'neth_pot', 'diamond_pot', 'uhc', 'crystal', 'smp'];
  for (const kit of kits) {
    it(`${kit}: three tiers up wins`, () => {
      for (const [lo, hi] of [
        ['lt5', 'ht4'],
        ['ht4', 'lt2'],
        ['ht3', 'ht1'],
      ] as [TierId, TierId][]) {
        let wins = 0;
        for (let s = 0; s < 6; s++) {
          const hiIsBot = s % 2 === 0;
          const w = hiIsBot ? duel(kit, hi, lo, 300 + s) : duel(kit, lo, hi, 300 + s);
          if ((w === 'bot') === hiIsBot) wins++;
        }
        expect(wins, `${hi} vs ${lo}`).toBeGreaterThanOrEqual(5);
      }
    }, 120_000);
  }
});
