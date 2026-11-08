import { describe, expect, it } from 'vitest';
import { B } from '../src/game/Blocks';
import { Match } from '../src/game/Match';
import { kitById } from '../src/game/kits';
import { DIFFICULTIES } from '../src/ai/difficulty';

const count = (m: Match, id: string) => [...m.player.inventory, m.player.offhand].reduce((n, s) => n + (s?.id === id ? s.count : 0), 0);

describe('ender chest refill (Crystal)', () => {
  it('right-clicking a placed ender chest refills the kit, every click', () => {
    const m = new Match(kitById('crystal'), DIFFICULTIES.practice, 1);
    while (m.phase !== 'fight') m.tick();
    const p = m.player;
    const crystals = count(m, 'end_crystal');
    const totems = count(m, 'totem_of_undying');
    expect(crystals).toBeGreaterThan(0);
    // Use most of it up.
    for (const s of p.inventory) if (s?.id === 'end_crystal') s.count = 1;
    const t = p.inventory.findIndex((s) => s?.id === 'totem_of_undying');
    p.inventory[t] = null;
    p.offhand = null;
    // An ender chest right in front, at the feet; look straight at it.
    const x = Math.floor(p.pos.x);
    const z = Math.floor(p.pos.z) - 2;
    m.world.blocks.set(x, Math.floor(p.pos.y), z, B.ENDER_CHEST);
    p.yaw = Math.atan2(-(x + 0.5 - p.pos.x), -(z + 0.5 - p.pos.z));
    p.pitch = -0.5;
    expect(p.crosshairBlock()?.id).toBe(B.ENDER_CHEST);
    expect(p.startUsingItem(true)).toBe(true);
    expect(count(m, 'end_crystal')).toBe(crystals);
    expect(count(m, 'totem_of_undying')).toBe(totems);
    expect((p.offhand as { id: string } | null)?.id).toBe('totem_of_undying');
    // Again after using some more: refilled again.
    for (const s of p.inventory) if (s?.id === 'end_crystal') s.count = 3;
    expect(p.startUsingItem(true)).toBe(true);
    expect(count(m, 'end_crystal')).toBe(crystals);
    // Nothing missing: nothing extra.
    expect(p.startUsingItem(true)).toBe(true);
    expect(count(m, 'end_crystal')).toBe(crystals);
  });
});
