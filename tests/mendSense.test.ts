import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { ITEMS } from '../src/game/items';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';

/** A NethPot game with the two far apart and the bot's armor worn down to `left` (fractions, helmet first). */
function setup(tier: DifficultyId, left: number[], seed = 1) {
  const m = new Match(kitById('neth_pot'), DIFFICULTIES[tier], seed);
  while (m.phase !== 'fight') m.tick();
  const b = m.bot;
  b.armorSlots.forEach((st, i) => {
    if (st) st.damage = Math.round((ITEMS[st.id].maxDamage ?? 0) * (1 - left[i]));
  });
  const park = () => {
    // You stand still a long way off, unhurt: nothing for the bot to do but look after itself.
    m.player.pos.set(b.pos.x, m.player.pos.y, b.pos.z + 16 > 20 ? b.pos.z - 16 : b.pos.z + 16);
    m.player.health = m.player.maxHealth;
    b.health = b.maxHealth;
  };
  const frac = (i: number) => {
    const st = b.armorSlots[i];
    return st ? 1 - (st.damage ?? 0) / (ITEMS[st.id].maxDamage ?? 1) : null;
  };
  return { m, b, park, frac };
}

describe('mending sense', () => {
  it('LT1 and HT1 mend by armor: the healthier pieces come off, the worst is mended, they go back on', () => {
    for (const tier of ['lt1', 'ht1'] as DifficultyId[]) {
      const { m, b, park, frac } = setup(tier, [0.15, 0.6, 0.55, 0.6]);
      let fewest = 4;
      let helmetWhenBare = 0;
      for (let t = 0; t < 20 * 40; t++) {
        park();
        m.tick();
        const worn = b.armorSlots.filter((s) => s).length;
        if (worn < fewest) fewest = worn;
        if (worn < 4) helmetWhenBare = Math.max(helmetWhenBare, frac(0) ?? 0);
      }
      // Healthier pieces came off (as many as the potion-filled inventory had room for), and the
      // helmet (always kept on) got the XP.
      expect(fewest, tier).toBeLessThanOrEqual(3);
      expect(helmetWhenBare, tier).toBeGreaterThan(0.7);
      // In the end everything is back on and mended.
      expect(b.armorSlots.filter((s) => s).length, tier).toBe(4);
      for (let i = 0; i < 4; i++) expect(frac(i), `${tier} piece ${i}`).toBeGreaterThan(0.7);
    }
  }, 120_000);

  it('the armor goes straight back on when the opponent closes in', () => {
    const { m, b, park } = setup('ht1', [0.15, 0.6, 0.55, 0.6]);
    let t = 0;
    for (; t < 20 * 20 && b.armorSlots.filter((s) => s).length === 4; t++) {
      park();
      m.tick();
    }
    expect(b.armorSlots.filter((s) => s).length).toBeLessThan(4);
    // You run in to 5 blocks: within two seconds it is dressed again.
    for (let k = 0; k < 40; k++) {
      m.player.pos.set(b.pos.x, m.player.pos.y, b.pos.z + 5);
      m.player.health = m.player.maxHealth;
      b.health = b.maxHealth;
      m.tick();
    }
    expect(b.armorSlots.filter((s) => s).length).toBe(4);
  });

  it('lower tiers never take armor off to mend', () => {
    for (const tier of ['lt3', 'ht2'] as DifficultyId[]) {
      const { m, b, park } = setup(tier, [0.15, 0.6, 0.55, 0.6]);
      for (let t = 0; t < 20 * 20; t++) {
        park();
        m.tick();
        expect(b.armorSlots.filter((s) => s).length, tier).toBe(4);
      }
    }
  });

  it('LT2 and up take your mending as their chance to mend; lower tiers do not', () => {
    const bottles = (tier: DifficultyId, youMend: boolean) => {
      let used = 0;
      for (let seed = 1; seed <= 6; seed++) {
        // Worn, but not yet enough for this tier to mend on its own.
        const at = DIFFICULTIES[tier].neth.mendAt + 0.1;
        const { m, b, park } = setup(tier, [at, at, at, at], seed);
        const before = b.countItem('experience_bottle');
        const slot = m.player.inventory.findIndex((s) => s?.id === 'experience_bottle');
        for (let t = 0; t < 20 * 8; t++) {
          park();
          if (youMend && slot >= 0 && slot < 9) m.player.selectSlot(slot);
          else if (youMend) m.player.inventory[m.player.selected] = { id: 'experience_bottle', count: 16 };
          m.tick();
        }
        used += before - b.countItem('experience_bottle');
      }
      return used;
    };
    for (const tier of ['lt2', 'ht2', 'lt1', 'ht1'] as DifficultyId[]) {
      expect(bottles(tier, false), `${tier} alone`).toBe(0);
      expect(bottles(tier, true), `${tier} while you mend`).toBeGreaterThan(0);
    }
    expect(bottles('ht3', true), 'ht3 while you mend').toBe(0);
  }, 120_000);
});
