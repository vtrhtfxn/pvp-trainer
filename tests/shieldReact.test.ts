import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type TierId } from '../src/ai/difficulty';
import { yawTowards } from '../src/core/math';
import { kitById, type KitId } from '../src/game/kits';
import { Match } from '../src/game/Match';

/**
 * Shield tapping (up 14 ticks, down 6, up again) next to the bot: how many ticks after the
 * latest raise each disable lands.
 */
function tapping(kit: KitId, tier: TierId, seed: number): number[] {
  const m = new Match(kitById(kit), DIFFICULTIES[tier], seed);
  while (m.phase !== 'fight') m.tick();
  const p = m.player;
  const out: number[] = [];
  let lastRaise = -1;
  let phase = 0;
  for (let t = 0; t < 20 * 60 && out.length < 6; t++) {
    p.health = 20;
    m.bot.health = 20;
    const b = m.bot;
    const d = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    p.yaw = yawTowards(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    p.pitch = Math.atan2(b.pos.y + 1 - (p.pos.y + 1.62), d);
    p.input = { forward: d > 2.8 ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint: false };
    let up = false;
    if (p.shieldCooldown <= 0 && d < 4) {
      phase = (phase + 1) % 20;
      up = phase < 14;
      if (up && !m.useHeld) lastRaise = t;
    } else phase = 0;
    m.useHeld = up;
    const before = p.shieldCooldown;
    m.tick();
    if (before <= 0 && p.shieldCooldown > 0) out.push(t - lastRaise);
    for (const f of m.fighters) f.events.length = 0;
    m.world.events.length = 0;
  }
  return out;
}

describe('bots react to a raised shield, not to one they saw earlier', () => {
  it('tapping the shield never gets it disabled faster than the tier’s reaction time', () => {
    for (const kit of ['dia_smp', 'smp', 'axe'] as KitId[]) {
      for (const tier of ['ht3', 'ht2', 'lt2'] as TierId[]) {
        const react = DIFFICULTIES[tier].axe.shieldReact;
        const all = [1, 2].flatMap((s) => tapping(kit, tier, s));
        expect(all.length, `${kit} ${tier}`).toBeGreaterThan(0);
        expect(Math.min(...all), `${kit} ${tier}: ${all.join(',')}`).toBeGreaterThanOrEqual(react);
      }
    }
  }, 300_000);
});
