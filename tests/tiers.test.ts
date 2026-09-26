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

  it('climbs in small steps at the bottom: HT5 is only a little stronger than LT5', () => {
    const low = (['lt5', 'ht5', 'lt4', 'ht4', 'lt3'] as const).map((id) => DIFFICULTIES[id]);
    for (let i = 1; i < low.length; i++) {
      const [a, b] = [low[i - 1], low[i]];
      expect(b.chargeMin - a.chargeMin, `${b.id} click timing`).toBeLessThanOrEqual(0.1);
      expect(a.reactionTicks - b.reactionTicks, `${b.id} reactions`).toBeLessThanOrEqual(0.6);
      expect(a.aimNoiseDeg - b.aimNoiseDeg, `${b.id} aim`).toBeLessThanOrEqual(0.6);
      expect(b.maxReach - a.maxReach, `${b.id} reach`).toBeLessThanOrEqual(0.1);
    }
    const [lt5, ht5] = [DIFFICULTIES.lt5, DIFFICULTIES.ht5];
    expect(ht5.chargeMin - lt5.chargeMin).toBeLessThan(0.05);
    expect(ht5.missClickChance).toBeGreaterThan(0.08);
  });

  it('only sprint-jumps after you from LT2 up (a sprinting player can keep up with the rest)', () => {
    for (const id of ['lt5', 'ht5', 'lt4', 'ht4', 'lt3', 'ht3'] as const) expect(DIFFICULTIES[id].chaseSprintJump, id).toBe(false);
    for (const id of ['lt2', 'ht2', 'lt1', 'ht1'] as const) expect(DIFFICULTIES[id].chaseSprintJump, id).toBe(true);
  });

  it('unlocks every item by LT1, only the basics up to HT4', () => {
    for (const id of ['lt5', 'ht5', 'lt4', 'ht4'] as const) {
      const p = DIFFICULTIES[id];
      expect(p.crystal.anchors || p.crystal.crossbow || p.crystal.surround || p.crystal.mine || p.uhc.water || p.axe.swap, id).toBe(false);
    }
    for (const id of ['lt1', 'ht1'] as const) {
      const p = DIFFICULTIES[id];
      expect(p.crystal).toMatchObject({ anchors: true, crossbow: true, surround: true, mine: true, iframeTiming: true, pearls: 2 });
      expect(p.uhc).toMatchObject({ water: true, mine: true, pillar: true, lavaPickup: true });
      expect(p.axe).toMatchObject({ swap: true, ranged: 2 });
      expect(p.neth).toMatchObject({ hotbarTotem: true, rebuff: true });
      expect(p.neth.mendAt).toBeGreaterThan(0);
    }
  });

  // The low steps are small on purpose, so a single step can go either way between two bots:
  // a few tiers up must win.
  const kits: KitId[] = ['sword', 'axe', 'neth_pot', 'diamond_pot', 'uhc', 'crystal', 'smp', 'mace'];
  for (const kit of kits) {
    it(`${kit}: a few tiers up wins`, () => {
      for (const [lo, hi] of [
        ['lt5', 'ht3'],
        ['lt4', 'lt2'],
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
