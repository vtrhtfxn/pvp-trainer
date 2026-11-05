import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type TierId } from '../src/ai/difficulty';
import { yawTowards } from '../src/core/math';
import { kitById, type KitId } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { ITEMS } from '../src/game/items';

function dura(kit: KitId, tier: TierId, seed: number, secs: number) {
  const m = new Match(kitById(kit), DIFFICULTIES[tier], seed);
  while (m.phase !== 'fight') m.tick();
  let lowTicks = 0, lowFighting = 0, ate = 0, minArmor = 1, deaths = 0, mends = 0;
  const g0 = m.bot.countItem('golden_apple');
  const labels = new Map<string, number>();
  for (let t = 0; t < 20 * secs; t++) {
    if (m.phase !== 'fight') { deaths++; break; }
    const p = m.player;
    p.health = 20; // you, never in danger: the bot has to save itself
    const d = Math.hypot(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
    p.yaw = yawTowards(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
    p.pitch = 0.15;
    p.input = { forward: d > 2.6 ? 1 : 0, strafe: t % 40 < 20 ? 1 : -1, jump: false, sneak: false, sprint: true };
    if (t % 11 === 0 && p.attackStrengthScale(0.5) > 0.9) m.queueClick();
    m.tick();
    for (const e of m.bot.events) if (e.type === 'throw' && (e as { kind: string }).kind === 'xp') mends++;
    m.bot.events.length = 0; p.events.length = 0; m.world.events.length = 0;
    const eff = m.bot.effectiveHealth();
    const l = (m as unknown as { brain: { label: string } }).brain.label;
    if (eff <= 5) {
      lowTicks++;
      if (l === 'Fighting' || l === 'Blocking') lowFighting++;
      labels.set(l, (labels.get(l) ?? 0) + 1);
    }
    for (const s of m.bot.armorSlots) if (s && ITEMS[s.id].maxDamage) minArmor = Math.min(minArmor, 1 - (s.damage ?? 0) / ITEMS[s.id].maxDamage!);
  }
  ate = g0 - m.bot.countItem('golden_apple');
  return { lowFighting, lowTicks, ate, text: `${kit.padEnd(8)} ${tier}: died ${deaths}, ticks at <=2.5 hearts ${lowTicks} (of them still fighting ${lowFighting}), gaps eaten ${ate}, xp thrown ${mends}, worst armor ${(minArmor * 100).toFixed(0)}% | low labels ${[...labels].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}:${v}`).join(' ')}` };
}

describe('a nearly dead bot heals (SMP and Diamond SMP)', () => {
  it('at 2½ hearts or less it stops fighting and eats, even against a full-health player who keeps hitting', () => {
    for (const kit of ['smp', 'dia_smp'] as KitId[]) {
      const r = dura(kit, 'lt4', 3, 90);
      expect(r.lowFighting, r.text).toBeLessThanOrEqual(5);
      expect(r.ate, r.text).toBeGreaterThan(0);
    }
  }, 300000);
});
