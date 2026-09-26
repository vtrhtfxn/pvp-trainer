import { describe, expect, it } from 'vitest';
import { Duel } from '../src/net/Duel';
import { normalizeRoom, roomCode } from '../src/net/protocol';

/**
 * Moves a fighter and reports it, the way a client's move packet would.
 * Yaw 0 faces -Z, yaw PI faces +Z (the engine's convention, see lookDir).
 */
function place(d: Duel, i: number, x: number, z: number, yaw: number, opts: { sprint?: boolean; onGround?: boolean } = {}) {
  d.fighters[i].applyMove(x, 0, z, yaw, 0, opts.onGround ?? true, opts.sprint ?? false, false);
}

const FACE_NEG_Z = 0;
const FACE_POS_Z = Math.PI;

/** One server tick: the motion pushes it produced, and the hit / miss fighter events. */
function step(d: Duel) {
  const out = d.tick();
  const ev = d.takeEvents();
  const attack = ev.find((e) => e.e.type === 'attack');
  const miss = ev.find((e) => e.e.type === 'miss');
  return {
    motion: out.find((e) => e.motion)?.motion,
    hit: attack ? { by: attack.on, ...(attack.e as { fullHit: boolean; damage: number; sprint: boolean; target: { f: number } }) } : undefined,
    miss: miss ? { by: miss.on } : undefined,
  };
}

function runTo(d: Duel, phase: 'fight') {
  for (let i = 0; i < 200 && d.phase !== phase; i++) d.tick();
}

/** Stands both fighters still long enough that the server's rewind history is filled. */
function settle(d: Duel, ticks = 6) {
  for (let t = 0; t < ticks; t++) {
    place(d, 1, 0, 0, FACE_POS_Z);
    place(d, 0, 0, 2, FACE_NEG_Z);
    d.tick();
    d.fighters[1].invulnerableTime = 0;
    d.fighters[1].health = 20;
  }
}

describe('online duel', () => {
  it('resolves a hit server-side and emits knockback for the victim only', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    expect(d.phase).toBe('fight');
    settle(d);

    d.fighters[0].attackStrengthTicker = 100;
    d.queueAttack(0);
    const { hit, motion } = step(d);
    expect(hit?.target.f).toBe(1);
    expect(hit?.by).toBe(0);
    expect(hit?.fullHit).toBe(true);
    // Diamond Sharpness V through Diamond Prot IV.
    expect(hit?.damage).toBeCloseTo(1.08, 2);
    expect(d.fighters[1].health).toBeLessThan(20);

    expect(motion?.to).toBe(1);
    expect(motion?.vy).toBeCloseTo(0.3608, 3);
    expect(Math.hypot(motion!.vx, motion!.vz)).toBeCloseTo(0.4, 2);
  });

  it('reports a miss when the crosshair ray is out of reach', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    for (let t = 0; t < 6; t++) {
      place(d, 1, 0, 0, FACE_POS_Z);
      place(d, 0, 0, 6, FACE_NEG_Z);
      d.tick();
    }
    d.fighters[0].attackStrengthTicker = 100;
    d.queueAttack(0);
    expect(step(d).miss?.by).toBe(0);
    expect(d.fighters[1].health).toBe(20);
  });

  it('applies the sprint-knockback rule to a networked fighter', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    for (let t = 0; t < 6; t++) {
      place(d, 1, 0, 0, FACE_POS_Z);
      place(d, 0, 0, 2.2, FACE_NEG_Z, { sprint: t >= 4 });
      d.tick();
    }
    expect(d.fighters[0].serverSprinting).toBe(true);
    d.fighters[0].attackStrengthTicker = 100;
    d.queueAttack(0);
    expect(step(d).hit?.sprint).toBe(true);
  });

  it('ends the duel and names a winner', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    settle(d);
    d.fighters[1].health = 0.5;
    d.fighters[0].attackStrengthTicker = 100;
    d.queueAttack(0);
    d.tick();
    expect(d.fighters[1].dead).toBe(true);
    expect(d.phase).toBe('ended');
    expect(d.winner).toBe(0);
  });

  it('keeps a jumping victim in the air, using the vy they reported', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    // The victim climbs; the server only knows they are rising because the move packet says so.
    let y = 0;
    let vy = 0.42;
    let rising = 0;
    for (let t = 0; t < 10; t++) {
      d.fighters[1].applyMove(0, y, 0, FACE_POS_Z, 0, t === 0, false, false, vy);
      d.fighters[0].applyMove(0, 0, 2, FACE_NEG_Z, -0.15, true, false, false, -0.0784);
      if (t === 3) {
        rising = d.fighters[1].vel.y;
        expect(rising).toBeGreaterThan(0);
        d.fighters[0].attackStrengthTicker = 100;
        d.queueAttack(0);
      }
      const motion = step(d).motion;
      if (t === 3) {
        expect(motion, 'the hit should land').toBeDefined();
        // The knockback handed back must keep the climb, not the server's own falling guess.
        expect(motion!.vy).toBeCloseTo(rising, 5);
        expect(motion!.vy).toBeGreaterThan(0);
        expect(d.fighters[1].serverVel.y).toBeGreaterThan(0);
        expect(Math.hypot(motion!.vx, motion!.vz)).toBeCloseTo(0.4, 2);
      }
      y += vy;
      vy = (vy - 0.08) * 0.98;
    }
  });

  it('makes unambiguous room codes', () => {
    for (let i = 0; i < 50; i++) expect(roomCode()).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
    expect(normalizeRoom('  ab-3d ')).toBe('AB3D');
  });
});

describe('lag compensation', () => {
  /** A target sliding sideways: the case where a stale position makes swings miss. */
  function strafingDuel(ping: number) {
    const d = new Duel(['Attacker', 'Runner']);
    runTo(d, 'fight');
    d.setPing(0, ping);
    d.setPing(1, ping);
    let x = -1.2;
    for (let t = 0; t < 10; t++) {
      x += 0.28; // roughly sprint speed
      place(d, 1, x, 0, Math.PI);
      place(d, 0, 0, 2.2, FACE_NEG_Z);
      d.tick();
    }
    return d;
  }

  /** Aims fighter 0 at a point, the way a player lines up their crosshair. */
  function aimAt(d: Duel, at: { x: number; z: number }) {
    const f = d.fighters[0];
    f.yaw = Math.atan2(-(at.x - f.pos.x), -(at.z - f.pos.z));
    f.pitch = 0;
    f.attackStrengthTicker = 100;
  }

  it('lands a swing aimed where the attacker saw the target', () => {
    const d = strafingDuel(120);
    aimAt(d, d.rewoundPosition(1, 0));
    d.queueAttack(0);
    const hit = step(d).hit;
    expect(hit, 'a swing aimed at the seen position should connect').toBeDefined();
    expect(hit?.by).toBe(0);
  });

  it('compensates by more than a hitbox width, which is why hits used to vanish', () => {
    const d = strafingDuel(120);
    const seen = d.rewoundPosition(1, 0);
    const now = d.fighters[1].pos;
    const gap = Math.hypot(seen.x - now.x, seen.z - now.z);
    // The hitbox is 0.6 wide: a gap larger than that means a swing aimed at the seen position
    // could not possibly touch the current one, so without the rewind it would simply miss.
    expect(gap).toBeGreaterThan(0.6);
  });

  it('still misses a swing aimed nowhere near the target', () => {
    const d = strafingDuel(120);
    const seen = d.rewoundPosition(1, 0);
    aimAt(d, { x: seen.x + 6, z: seen.z });
    d.queueAttack(0);
    expect(step(d).miss?.by).toBe(0);
  });

  it('rewinds further for a laggier attacker, and clamps', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    d.setPing(0, 0);
    expect(d.rewindTicksFor(0)).toBe(2); // interpolation delay only
    d.setPing(0, 100);
    expect(d.rewindTicksFor(0)).toBe(3); // + 50 ms one-way latency
    d.setPing(0, 5000);
    expect(d.rewindTicksFor(0)).toBe(10); // clamped
  });
});

describe('online inventory', () => {
  it('accepts a rearrangement but rejects one that creates items', async () => {
    const { SLOT_COUNT } = await import('../src/game/Fighter');
    const { toSlot } = await import('../src/net/protocol');
    const d = new Duel(['A', 'B']);
    const f = d.fighters[0];
    const layout = Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k)));
    // Move the sword from hotbar 0 to main slot 20.
    const moved = [...layout];
    moved[20] = moved[0];
    moved[0] = null;
    expect(d.setInventory(0, moved)).toBe(true);
    expect(f.inventory[20]?.id).toBe('diamond_sword');
    // Doubling the sword is refused.
    const dup = Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k)));
    dup[5] = dup[20];
    expect(d.setInventory(0, dup)).toBe(false);
    expect(f.countItem('diamond_sword')).toBe(1);
    // Armor slots only take the matching piece.
    const bad = Array.from({ length: SLOT_COUNT }, (_, k) => toSlot(f.getSlot(k)));
    [bad[36], bad[39]] = [bad[39], bad[36]];
    expect(d.setInventory(0, bad)).toBe(false);
  });

  it('swaps hands on F', () => {
    const d = new Duel(['A', 'B']);
    runTo(d, 'fight');
    d.queueSwap(0);
    d.tick();
    expect(d.fighters[0].offhand?.id).toBe('diamond_sword');
    expect(d.fighters[0].heldStack()).toBeNull();
  });
});
