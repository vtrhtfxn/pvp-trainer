import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { B } from '../src/game/Blocks';
import { Match } from '../src/game/Match';
import { kitById } from '../src/game/kits';
import { BED_GONE_TICKS, CRUMBLE_TICKS } from '../src/game/modes/Bedwars';

/** A minigame with nobody moving, fast-forwarded to `at` ticks into the fight. */
function idle(kit: 'bedwars' | 'skywars', at: number) {
  const m = new Match(kitById(kit), DIFFICULTIES.lt3, 1);
  m.botDriver = () => {};
  while (m.phase !== 'fight') m.tick();
  m.fightTicks = at;
  return m;
}

function solidFarOut(m: Match, r: number): number {
  const b = m.world.blocks;
  let n = 0;
  for (let x = -b.half; x < b.half; x++)
    for (let z = -b.half; z < b.half; z++) {
      if (Math.hypot(x + 0.5, z + 0.5) <= r) continue;
      for (let y = -12; y < 16; y++) if (b.get(x, y, z) !== B.AIR) n++;
    }
  return n;
}

describe('minigame timelines', () => {
  it('Bed Wars: generator tiers, then beds gone, then the map crumbles in to the middle', () => {
    const m = idle('bedwars', 20 * 60 * 5 - 2);
    const said: string[] = [];
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        m.player.health = m.bot.health = 20;
        // Both stand on the middle island (it stays), so the game goes on while the edge comes in.
        if (m.fightTicks >= 20 * 60 * 7) {
          m.player.pos.set(0.5, 0, 0.5);
          m.bot.pos.set(2.5, 0, 0.5);
          m.player.vel.set(0, 0, 0);
          m.bot.vel.set(0, 0, 0);
        }
        m.tick();
        for (const a of m.mode!.takeAnnouncements()) said.push(a.text);
      }
    };
    run(4);
    expect(said.some((s) => s.includes('Diamond Generators have been upgraded to Tier II'))).toBe(true);
    expect(m.mode!.scoreboard(m, m.player).some((l) => l.text.startsWith('Emerald II in'))).toBe(true);
    m.fightTicks = BED_GONE_TICKS - 1;
    run(2);
    expect(said.some((s) => s.includes('All beds have been destroyed'))).toBe(true);
    m.fightTicks = CRUMBLE_TICKS - 1;
    const before = solidFarOut(m, 12);
    expect(before).toBeGreaterThan(100);
    run(2);
    expect(said.some((s) => s.includes('SUDDEN DEATH'))).toBe(true);
    // ~53 steps of 1.5 s: everything past the middle island is gone.
    run(30 * 60);
    expect(solidFarOut(m, 12)).toBe(0);
    expect(m.world.blocks.get(0, -1, 0)).not.toBe(B.AIR);
  });

  it('Bed Wars: your bed breaking shows BED DESTROYED', () => {
    const m = idle('bedwars', 100);
    const bed = (m.mode as unknown as { layout: { teams: { bed: { x: number; y: number; z: number }[] }[] } }).layout.teams[0].bed;
    for (const c of bed) m.world.blocks.set(c.x, c.y, c.z, B.AIR);
    m.tick();
    expect(m.mode!.title(m, m.player)?.title).toBe('BED DESTROYED!');
    for (let i = 0; i < 80; i++) m.tick();
    expect(m.mode!.title(m, m.player)?.title ?? '').not.toBe('BED DESTROYED!');
  });

  it('SkyWars: chests refill twice, then sudden death crumbles the far islands', () => {
    const m = idle('skywars', 20 * 60 * 3 - 1);
    const said: string[] = [];
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        m.player.health = m.bot.health = 20;
        // Both stand on the middle island (it stays), so the game goes on while the edge comes in.
        if (m.fightTicks >= 20 * 60 * 7) {
          m.player.pos.set(0.5, 0, 0.5);
          m.bot.pos.set(2.5, 0, 0.5);
          m.player.vel.set(0, 0, 0);
          m.bot.vel.set(0, 0, 0);
        }
        m.tick();
        for (const a of m.mode!.takeAnnouncements()) said.push(a.text);
      }
    };
    run(2);
    m.fightTicks = 20 * 60 * 6 - 1;
    run(2);
    expect(said.filter((s) => s.includes('refilled')).length).toBe(2);
    m.fightTicks = 20 * 60 * 8 - 1;
    run(2 + 30 * 45);
    expect(said.some((s) => s.includes('SUDDEN DEATH'))).toBe(true);
    expect(solidFarOut(m, 11)).toBe(0);
  });
});
