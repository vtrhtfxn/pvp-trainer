import { describe, expect, it } from 'vitest';
import { BotBrain } from '../src/ai/BotBrain';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { yawTowards } from '../src/core/math';
import { Rng } from '../src/core/rng';
import { performAttack, hurt } from '../src/game/combat';
import { kitById, type KitId } from '../src/game/kits';
import { Match, TEAM_KITS } from '../src/game/Match';

/** A 2v2 with the player played by a bot too, run until a team is down (or the time is up). */
function teamGame(kit: KitId, seed: number, maxTicks = 20 * 60 * 4) {
  const m = new Match(kitById(kit), DIFFICULTIES.ht3, seed, { allyProfile: DIFFICULTIES.ht3 });
  const pb: BotBrain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.ht3, new Rng(seed + 99), () => performAttack(m.player, pb.opponent));
  if (m.mode) pb.attachSky(m);
  pb.resetRound();
  while (m.phase !== 'ended' && m.tickCount < maxTicks) {
    if (m.phase === 'fight') {
      pb.chooseTarget(m.enemiesOf(m.player));
      pb.tick();
      m.useHeld = pb.useHeld;
    }
    m.tick();
    for (const f of m.fighters) {
      for (const v of [f.pos.x, f.pos.y, f.pos.z, f.vel.x, f.vel.y, f.health]) if (!Number.isFinite(v)) throw new Error(`non-finite state on ${f.name}`);
      f.events.length = 0;
    }
  }
  return m;
}

describe('2v2', () => {
  it('puts you and an ally against two bots, teammates side by side', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.lt3, 1, {});
    expect(m.fighters).toHaveLength(4);
    expect(m.fighters.map((f) => f.team)).toEqual([0, 1, 0, 1]);
    expect(m.ally!.pos.z).toBeCloseTo(m.player.pos.z);
    expect(Math.abs(m.ally!.pos.x - m.player.pos.x)).toBeGreaterThan(2);
  });

  it('teammates cannot hurt each other; enemies can', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.lt3, 1, {});
    expect(hurt(m.player, 5, m.ally, false).dealt).toBe(0);
    expect(m.player.health).toBe(20);
    expect(hurt(m.player, 5, m.bot2, false).dealt).toBeGreaterThan(0);
    expect(performAttack(m.ally!, m.player).hit).toBe(false);
  });

  it('a click goes to the enemy under the crosshair', () => {
    const m = new Match(kitById('sword'), DIFFICULTIES.lt3, 1, {});
    while (m.phase !== 'fight') m.tick();
    const p = m.player;
    const b2 = m.bot2!;
    b2.pos.set(p.pos.x, p.pos.y, p.pos.z - 2.5);
    m.bot.pos.set(p.pos.x + 8, p.pos.y, p.pos.z - 8);
    p.yaw = yawTowards(b2.pos.x - p.pos.x, b2.pos.z - p.pos.z);
    p.pitch = 0;
    expect(m.crosshairTarget(p)).toBe(b2);
  });

  it('every 2v2 kit plays to a finish, and the game only ends when a whole team is down', () => {
    for (const kit of TEAM_KITS) {
      const m = teamGame(kit, 3);
      if (m.phase === 'ended' && !m.mode) {
        const losers = m.fighters.filter((f) => f.team !== m.winner!.team);
        expect(losers.every((f) => f.dead), kit).toBe(true);
      }
      // Every fighter took part (dealt or took damage).
      expect(m.fighters.filter((f) => f.stats.damageDealt + f.stats.damageTaken > 0).length, kit).toBeGreaterThanOrEqual(3);
    }
  }, 300_000);

  it('Bed Wars and SkyWars 2v2 end with a winning team', () => {
    let ended = 0;
    for (const kit of ['bedwars', 'skywars'] as KitId[]) {
      for (let seed = 1; seed <= 2; seed++) if (teamGame(kit, seed, 20 * 60 * 10).phase === 'ended') ended++;
    }
    expect(ended).toBeGreaterThanOrEqual(3);
  }, 300_000);
});
