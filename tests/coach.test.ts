import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { analyze } from '../src/game/coach';
import { ReplayRecorder, type ReplayData } from '../src/game/replay';
import { dropEvents, replayMatch } from '../src/game/ReplayWatch';
import { defaultGameRules } from '../src/game/World';

/** Records a duel where `play` drives the player every tick. */
function record(tier: DifficultyId, seed: number, play: (m: ReturnType<typeof replayMatch>, tick: number) => void, ticks = 20 * 40, kit = 'sword'): ReplayData {
  const h = {
    v: 1,
    kitId: kit,
    profileId: tier,
    seed,
    playerName: 'You',
    botName: `${DIFFICULTIES[tier].name} Bot`,
    rules: defaultGameRules(),
    attrs: { player: {}, bot: {} },
    gameModes: { player: 'survival', bot: 'survival' },
    dayTime: 6000,
    raining: false,
    date: 1,
  };
  const m = replayMatch({ ...h, id: '', frames: [], checks: [], winner: null, fightTicks: 0 });
  const rec = new ReplayRecorder(h);
  m.recorder = rec;
  rec.start(m.player);
  for (let i = 0; i < ticks && m.phase !== 'ended'; i++) {
    const p = m.player;
    const b = m.bot;
    p.yaw = Math.atan2(-(b.pos.x - p.pos.x), -(b.pos.z - p.pos.z));
    p.pitch = 0.1;
    play(m, i);
    m.tick();
    dropEvents(m);
  }
  return rec.finish(m.winner ? (m.winner === m.player ? 'player' : 'bot') : null, m.fightTicks)!;
}

describe('Match Coach', () => {
  it('calls out spam clicking', () => {
    const data = record('ht3', 2, (m) => {
      const d = Math.hypot(m.bot.pos.x - m.player.pos.x, m.bot.pos.z - m.player.pos.z);
      m.player.input = { forward: d > 2.5 ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint: true };
      m.queueClick();
    });
    const r = analyze(data);
    const ids = r.tips.map((t) => t.id);
    expect(ids).toContain('weak');
    const weak = r.tips.find((t) => t.id === 'weak')!;
    expect(weak.moments.length).toBeGreaterThan(0);
    // Problems come before strengths.
    expect(r.tips[0].good).toBe(false);
  });

  it('a patient player who jumps for crits gets no spam or crit tip', () => {
    const data = record('lt5', 3, (m) => {
      const p = m.player;
      const d = Math.hypot(m.bot.pos.x - p.pos.x, m.bot.pos.z - p.pos.z);
      p.input = { forward: d > 2.6 ? 1 : 0, strafe: 0, jump: p.onGround && d < 3.2, sneak: false, sprint: true };
      if (p.attackStrengthScale(0) >= 1 && !p.onGround && p.vel.y < 0 && d < 3) m.queueClick();
    });
    const r = analyze(data);
    const ids = r.tips.map((t) => t.id);
    expect(ids).not.toContain('weak');
    expect(ids).not.toContain('crit');
    expect(r.stats.find((s) => s.label === 'Crits')!.value).not.toBe('0%');
  });

  it('notices hits taken while eating', () => {
    // UHC has golden apples: stand still eating next to an HT2 bot.
    const data = record(
      'ht2',
      5,
      (m) => {
        m.player.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
        const slot = m.player.slotOf('golden_apple');
        if (slot >= 0 && slot < 9 && m.player.selected !== slot) m.queueSlot(slot);
        m.useHeld = true;
      },
      20 * 40,
      'uhc',
    );
    const eat = analyze(data).tips.find((t) => t.id === 'eat');
    expect(eat).toBeDefined();
    expect(eat!.moments.length).toBeGreaterThan(0);
  });

  it('every moment is a tick inside the recording', () => {
    const data = record('ht3', 4, (m, i) => {
      m.player.input = { forward: 1, strafe: i % 40 < 20 ? 1 : -1, jump: false, sneak: false, sprint: true };
      if (i % 3 === 0) m.queueClick();
    });
    for (const t of analyze(data).tips) for (const k of t.moments) expect(k).toBeGreaterThanOrEqual(0), expect(k).toBeLessThan(data.frames.length);
  });
});
