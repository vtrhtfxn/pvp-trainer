import { describe, expect, it } from 'vitest';
import { Fighter } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { World } from '../src/game/World';

/** Throws a wind charge straight down after 15 ticks standing still or sprinting. */
function launch(sprint: boolean) {
  const world = new World(60);
  const a = new Fighter('player', 'A', world);
  const b = new Fighter('bot', 'B', world);
  world.fighters.push(a, b);
  a.reset(0, 20, 0, kitById('mace'));
  b.reset(30, -20, 0, kitById('mace'));
  a.selectSlot(a.inventory.findIndex((s) => s?.id === 'wind_charge'));
  const y0 = a.pos.y;
  let apex = 0;
  let launchVel: { vx: number; vy: number; vz: number } | null = null;
  for (let i = 0; i < 80; i++) {
    a.yaw = 0;
    a.pitch = -Math.PI / 2 + 0.02;
    a.input = { forward: sprint ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint };
    if (i === 15) a.startUsingItem(true);
    a.snapshot();
    b.snapshot();
    a.tick();
    b.tick();
    world.tickEntities();
    for (const e of a.events) if (e.type === 'windLaunch' && !launchVel) launchVel = e;
    a.events.length = 0;
    apex = Math.max(apex, a.pos.y - y0);
    if (i > 20 && a.onGround) break;
  }
  return { apex, launchVel: launchVel! };
}

describe('wind charge at your feet', () => {
  it('launches about 6 blocks standing still', () => {
    const { apex, launchVel } = launch(false);
    expect(apex).toBeGreaterThan(5.5);
    expect(apex).toBeLessThan(6.6);
    expect(Math.hypot(launchVel.vx, launchVel.vz)).toBeLessThan(0.05);
  });

  it('goes up while sprinting instead of flinging you forward', () => {
    // The charge carries your real movement (0.28 a tick), so it bursts under you, not behind.
    const { apex, launchVel } = launch(true);
    expect(apex).toBeGreaterThan(4.8);
    expect(Math.hypot(launchVel.vx, launchVel.vz)).toBeLessThan(0.38);
  });
});
