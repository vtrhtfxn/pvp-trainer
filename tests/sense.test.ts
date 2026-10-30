import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type TierId } from '../src/ai/difficulty';
import { B } from '../src/game/Blocks';
import { yawTowards } from '../src/core/math';
import { kitById, type KitId } from '../src/game/kits';
import { Match } from '../src/game/Match';

type Brain = Record<string, unknown>;

/** A match in its fight phase, the player `dist` blocks from the bot. */
function fight(kit: KitId, tier: TierId, seed: number, dist: number) {
  const m = new Match(kitById(kit), DIFFICULTIES[tier], seed);
  while (m.phase !== 'fight') m.tick();
  m.player.pos.set(m.bot.pos.x, m.bot.pos.y, m.bot.pos.z + dist);
  m.player.prevPos.copy(m.player.pos);
  return { m, brain: (m as unknown as { brain: Brain }).brain };
}

function run(m: Match, ticks: number, each: () => void) {
  for (let i = 0; i < ticks && m.phase === 'fight'; i++) {
    each();
    m.tick();
  }
}

const chase = (m: Match) => {
  const p = m.player;
  p.yaw = yawTowards(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
  p.input = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: true };
};
const still = (m: Match) => {
  m.player.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
};

describe('bot game sense (scales with the tier)', () => {
  it('Mace: slides in through the air from mid range — often from LT2 up, rarely at LT4', () => {
    const slides = (tier: TierId, seeds = 10) => {
      let n = 0;
      for (let seed = 1; seed <= seeds; seed++) {
        const { m, brain } = fight('mace', tier, seed, 12);
        let last = '';
        run(m, 120, () => {
          still(m);
          const l = String(brain.potLabel || '');
          if (l === 'Slide' && last !== 'Slide') n++;
          last = l;
        });
      }
      return n;
    };
    expect(slides('ht1')).toBeGreaterThanOrEqual(7);
    expect(slides('lt2')).toBeGreaterThanOrEqual(3);
    // Over 20 rounds each (a fixed count over 10 swings with every unrelated random draw).
    const lt2 = slides('lt2', 20);
    const lt4 = slides('lt4', 20);
    expect(lt4).toBeLessThan(lt2);
  }, 120_000);

  it('SMP: low and chased, a high tier pearls out to heal far more often than LT5', () => {
    const pearls = (tier: TierId) => {
      let n = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const { m } = fight('smp', tier, seed, 1.8);
        run(m, 5, () => still(m));
        m.bot.health = 5;
        run(m, 80, () => chase(m));
        n += m.bot.stats.pearlsThrown;
      }
      return n;
    };
    // Every tier has some sense now; the top ones use it far more often.
    const top = pearls('ht1');
    expect(top).toBeGreaterThan(0);
    expect(pearls('lt5')).toBeLessThan(top);
  }, 120_000);

  it('Spear Mace: low and chased, it Lunges away (or winds out)', () => {
    let escapes = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { m, brain } = fight('spear_mace', 'ht1', seed, 1.8);
      run(m, 5, () => still(m));
      m.bot.health = 5;
      let last = '';
      run(m, 60, () => {
        chase(m);
        const l = String(brain.potLabel || '');
        if (l === 'Escaping' && last !== 'Escaping') escapes++;
        last = l;
      });
      escapes += m.bot.stats.pearlsThrown;
    }
    expect(escapes).toBeGreaterThan(0);
  }, 120_000);

  it('UHC: you are low and backing off — it shoots to stop the heal (HT1 far more than LT5)', () => {
    const shots = (tier: TierId) => {
      let n = 0;
      for (let seed = 1; seed <= 5; seed++) {
        const { m } = fight('uhc', tier, seed, 8);
        m.player.health = 4;
        run(m, 120, () => {
          const p = m.player;
          p.yaw = yawTowards(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
          p.input = { forward: -1, strafe: 0, jump: false, sneak: false, sprint: false };
          for (const e of m.bot.events) if (e.type === 'shoot') n++;
        });
      }
      return n;
    };
    const top = shots('ht1');
    expect(top).toBeGreaterThan(0);
    expect(shots('lt5')).toBeLessThan(top);
  }, 120_000);

  it('UHC: low while you draw a bow on it — a plank wall goes up between you', () => {
    let walls = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { m } = fight('uhc', 'ht1', seed, 12);
      const before = m.world.blocks.count;
      m.bot.health = 6;
      const bow = m.player.inventory.findIndex((s) => s?.id === 'bow');
      m.player.selectSlot(bow);
      run(m, 140, () => {
        still(m);
        m.useHeld = true;
        const p = m.player;
        p.yaw = yawTowards(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
        if (!p.usingItem) p.startUsingItem(true);
      });
      let planks = 0;
      const b = m.bot;
      for (let dx = -3; dx <= 3; dx++)
        for (let dz = -3; dz <= 3; dz++)
          for (let dy = 0; dy <= 2; dy++) if (m.world.blocks.get(Math.floor(b.pos.x) + dx, Math.floor(b.pos.y) + dy, Math.floor(b.pos.z) + dz) === B.PLANKS) planks++;
      if (planks > 0 || m.world.blocks.count > before) walls++;
    }
    expect(walls).toBeGreaterThan(0);
  }, 120_000);
});
