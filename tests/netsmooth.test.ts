import { describe, expect, it } from 'vitest';
import { Duel } from '../src/net/Duel';
import { MAX_REWIND_MS } from '../src/net/protocol';
import { PROFILES, simulate } from './netsim';

/**
 * How smoothly each player sees the other over real networks. The simulator runs both
 * clients' frame loops, the server's timer and links with latency, jitter and Wi-Fi stalls.
 */
describe('opponent movement over a real network', () => {
  it('a wired LAN: smooth, and only ~100 ms behind', () => {
    const r = simulate({ seconds: 15, seed: 1, fps: [60, 60], ...PROFILES.wired });
    expect(r.teleports).toBe(0);
    expect(r.freezePerMille).toBe(0);
    expect(r.delayMs).toBeLessThanOrEqual(120);
  });

  it('ordinary Wi-Fi with jitter and stalls: no jumps, no freezes', () => {
    for (const fps of [
      [60, 60],
      [144, 30],
    ] as [number, number][]) {
      const r = simulate({ seconds: 15, seed: 2, fps, ...PROFILES.wifi });
      expect(r.teleports, JSON.stringify(r)).toBe(0);
      expect(r.freezePerMille, JSON.stringify(r)).toBe(0);
      expect(r.maxSpeed).toBeLessThan(r.truthMax * 1.3);
    }
  });

  it('a host whose timer keeps running late (a busy or throttled computer)', () => {
    const r = simulate({ seconds: 15, seed: 3, fps: [60, 60], ...PROFILES.sleepyHost });
    expect(r.teleports, JSON.stringify(r)).toBe(0);
    expect(r.freezePerMille, JSON.stringify(r)).toBe(0);
  });

  it('PCs that hitch (frames of 120–400 ms now and then) on Wi-Fi', () => {
    const r = simulate({ seconds: 20, seed: 7, fps: [60, 60], ...PROFILES.hitchyPcs });
    expect(r.teleports, JSON.stringify(r)).toBe(0);
    expect(r.freezePerMille, JSON.stringify(r)).toBe(0);
  });

  it('very bad Wi-Fi (350 ms stalls every second or so): smooth, at the cost of more delay', () => {
    const r = simulate({ seconds: 15, seed: 4, fps: [60, 60], ...PROFILES.badWifi });
    expect(r.teleports, JSON.stringify(r)).toBe(0);
    expect(r.freezePerMille, JSON.stringify(r)).toBeLessThanOrEqual(2);
    expect(r.maxSpeed).toBeLessThan(r.truthMax * 1.3);
  });
});

describe('lag compensation by what the attacker saw', () => {
  /** A runner strafing across in front of the attacker, one move per tick, at a fixed clock. */
  function strafe() {
    const d = new Duel(['Attacker', 'Runner']);
    let now = 0;
    d.clock = () => now;
    for (let i = 0; i < 200 && d.phase !== 'fight'; i++) d.tick();
    let x = -1.4;
    for (let q = 1; q <= 12; q++) {
      now += 50;
      x += 0.28;
      d.receive(1, { t: 'move', q, x, y: 0, z: 0, yaw: Math.PI, pitch: 0, g: true, sp: true, sn: false, vy: 0 });
      d.receive(0, { t: 'move', q, x: 0, y: 0, z: 2.2, yaw: 0, pitch: 0, g: true, sp: false, sn: false, vy: 0 });
      d.tick();
    }
    return { d, setNow: (t: number) => (now = t), now: () => now };
  }

  const aim = (d: Duel, x: number, z: number) => {
    const f = d.fighters[0];
    f.yaw = Math.atan2(-(x - f.pos.x), -(z - f.pos.z));
    f.pitch = 0;
    f.attackStrengthTicker = 100;
  };

  const swing = (d: Duel, view?: number) => {
    d.queueAttack(0, view);
    d.tick();
    return d.takeEvents().find((e) => e.e.type === 'attack' || e.e.type === 'miss')?.e.type;
  };

  it('a swing at where the runner was on screen lands, even though they have moved on', () => {
    const { d } = strafe();
    // The attacker's screen showed move 6 (x ≈ 0.28); the runner is now at x ≈ 1.96.
    aim(d, -1.4 + 0.28 * 6, 0);
    expect(Math.abs(d.fighters[1].pos.x - (-1.4 + 0.28 * 6))).toBeGreaterThan(1.2);
    expect(swing(d, 6)).toBe('attack');
  });

  it('the same swing without the rewind (claiming to see the present) misses', () => {
    const { d } = strafe();
    aim(d, -1.4 + 0.28 * 6, 0);
    expect(swing(d, 12)).toBe('miss');
  });

  it('a view older than the rewind limit is not honoured', () => {
    const { d, setNow, now } = strafe();
    setNow(now() + MAX_REWIND_MS);
    aim(d, -1.4 + 0.28 * 2, 0);
    expect(swing(d, 2)).toBe('miss');
  });

  it('moves are relayed to the opponent as they arrive, stamped with the sender tick', () => {
    const d = new Duel(['A', 'B']);
    const relay = d.receive(1, { t: 'move', q: 41, x: 1, y: 0, z: 0, yaw: 0, pitch: 0, g: true, sp: true, sn: true, vy: 0 });
    expect(relay).toMatchObject({ t: 'mv', q: 41, x: 1, f: 1 | 2 | 4 });
  });
});

describe('opponent playback after a pause', () => {
  it('when their game stalls for 3 s, playback picks up again within a second', async () => {
    const { NetMatch } = await import('../src/net/NetMatch');
    let now = 0;
    const net = { connected: true, send() {} };
    const c = new NetMatch(net as never, 1, 'sword');
    c.clock = () => now;
    c.handle({ t: 'start', countdown: 3, kit: 'sword' });
    const move = (q: number, x: number) => c.handle({ t: 'mv', q, x, y: 0, z: 0, yaw: 0, pitch: 0, f: 1 });
    let q = 0;
    const run = (ticks: number, moving: boolean) => {
      for (let t = 0; t < ticks; t++) {
        now += 50;
        if (moving) move(++q, q * 0.2);
        c.tick();
      }
    };
    run(40, true);
    // Their tab went to the background: nothing for 3 s, then they carry on from where they were.
    run(60, false);
    run(20, true);
    const drawnX = c.bot.pos.x;
    // Drawn within a few ticks of the newest move, not stuck at the old spot.
    expect(q * 0.2 - drawnX).toBeLessThan(0.2 * 8);
    expect(q * 0.2 - drawnX).toBeGreaterThan(0);
  });
});
