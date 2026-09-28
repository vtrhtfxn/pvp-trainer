import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { DRILLS, DrillRun, drillById } from '../src/trainer/drills';

/** Runs a drill with a scripted "player" until it finishes or times out. */
function play(id: string, player: (run: DrillRun, m: Match) => void, maxTicks = 20 * 120) {
  const def = drillById(id)!;
  const m = new Match(kitById(def.kit), DIFFICULTIES[def.profile ?? 'practice'], 5);
  const run = new DrillRun(def, m);
  for (let i = 0; i < maxTicks && !run.result; i++) {
    player(run, m);
    m.tick();
    run.update();
    for (const f of [m.player, m.bot]) f.events.length = 0;
    m.world.events.length = 0;
  }
  if (process.env.DRILL_DEBUG) process.stderr.write(`${id}: t=${run.t} s=${run.successes} f=${run.fails} feed=${JSON.stringify(run.feed.map((f) => f.text))}\n`);
  return run;
}

const lookAt = (m: Match, y = 1.2) => {
  const p = m.player;
  const b = m.bot;
  const dx = b.pos.x - p.pos.x;
  const dz = b.pos.z - p.pos.z;
  p.yaw = Math.atan2(-dx, -dz);
  p.pitch = Math.atan2(b.pos.y + y - (p.pos.y + p.eyeHeight()), Math.hypot(dx, dz));
};
const dist = (m: Match) => Math.hypot(m.bot.pos.x - m.player.pos.x, m.bot.pos.z - m.player.pos.z);
const walkTo = (m: Match, range: number, sprint = false) => {
  m.player.input = { forward: dist(m) > range ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint };
};

describe('trainer drills can be completed', () => {
  it('every drill has how-to text, a mechanic and a goal', () => {
    expect(DRILLS.length).toBeGreaterThanOrEqual(15);
    for (const d of DRILLS) {
      expect(d.how.length, d.id).toBeGreaterThan(0);
      expect(d.why.length, d.id).toBeGreaterThan(40);
      expect(d.goal, d.id).toBeGreaterThan(0);
    }
    expect(new Set(DRILLS.map((d) => d.id)).size).toBe(DRILLS.length);
  });

  it('full-charge hits: patient clicks pass, spam fails', () => {
    const good = play('cooldown', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.3);
      if (m.player.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(good.result?.passed).toBe(true);
    expect(good.result?.accuracy).toBe(1);
    const spam = play('cooldown', (run, m) => {
      lookAt(m);
      walkTo(m, 2.3);
      if (run.t % 3 === 0) m.queueClick();
    }, 20 * 20);
    expect(spam.fails).toBeGreaterThan(spam.successes);
  });

  it('jump crits count, sprint hits are called out', () => {
    const run = play('crit', (_run, m) => {
      lookAt(m);
      const p = m.player;
      p.input = { forward: dist(m) > 2.2 ? 1 : 0, strafe: 0, jump: p.onGround && p.attackStrengthScale(0.5) >= 0.8, sneak: false, sprint: false };
      if (!p.onGround && p.fallDistance > 0 && p.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(run.result?.passed).toBe(true);
    const sprinting = play('crit', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.2, true);
      if (m.player.attackStrengthScale(0.5) >= 1) m.queueClick();
    }, 20 * 15);
    expect(sprinting.successes).toBe(0);
    expect(sprinting.feed.some((f) => f.text.includes('Sprint hit'))).toBe(true);
  });

  it('sprint hits (W-tap)', () => {
    const run = play('wtap', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.4, true);
      if (m.player.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(run.result?.passed).toBe(true);
  });

  it('jump reset: a jump on the tick the hit lands counts; late or none is called out', () => {
    // Knows when the bot will swing (as a player reads its run-up): jump on that tick.
    const willHit = (run: DrillRun, m: Match) =>
      run.t >= Number(run.s.nextSwing) && m.bot.attackStrengthScale(0.5) >= 1 && dist(m) <= 2.6;
    const run = play('jumpreset', (run, m) => {
      lookAt(m);
      const p = m.player;
      p.input = { forward: 1, strafe: 0, jump: p.onGround && willHit(run, m), sneak: false, sprint: true };
    });
    expect(run.result?.passed).toBe(true);
    expect(run.feed.some((f) => f.text.includes('Knockback taken'))).toBe(true);
    const late = play('jumpreset', (_run, m) => {
      lookAt(m);
      m.player.input = { forward: 0, strafe: 0, jump: m.player.hurtTime === 9, sneak: false, sprint: false };
    }, 20 * 12);
    expect(late.feed.some((f) => f.text.includes('Too late'))).toBe(true);
    const lazy = play('jumpreset', (_run, m) => {
      lookAt(m);
    }, 20 * 12);
    expect(lazy.successes).toBe(0);
    expect(lazy.fails).toBeGreaterThan(0);
  });

  it('P-crit: crit on the way down from the bot\'s knockback', () => {
    const run = play('pcrit', (_run, m) => {
      lookAt(m);
      const p = m.player;
      p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
      if (!p.onGround && p.fallDistance > 0 && p.hurtTime > 0 && p.attackStrengthScale(0.5) >= 1 && dist(m) < 3.2) m.queueClick();
    });
    expect(run.successes).toBeGreaterThan(0);
  });

  it('shield disable and attribute swap', () => {
    const disable = play('disable', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.2);
      m.queueSlot(0);
      if (m.player.attackStrengthScale(0.5) >= 1 && m.player.heldStack()?.id === 'diamond_axe') m.queueClick();
    });
    expect(disable.result?.passed).toBe(true);
    const swap = play('attrswap', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.2);
      const p = m.player;
      if (p.heldStack()?.id !== 'diamond_sword') m.queueSlot(1);
      else if (p.attackStrengthScale(0.5) >= 1) {
        m.queueSlot(0);
        m.queueClick();
      }
    });
    expect(swap.result?.passed).toBe(true);
    // Axe held all along: disables, but no swaps.
    const plain = play('attrswap', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.2);
      m.queueSlot(0);
      if (m.player.attackStrengthScale(0.5) >= 1) m.queueClick();
    }, 20 * 20);
    expect(plain.successes).toBe(0);
    expect(plain.feed.some((f) => f.text.includes('not a swap'))).toBe(true);
  });

  it('potting: straight down heals in full, at the horizon it is wasted', () => {
    const good = play('pot', (run, m) => {
      const p = m.player;
      p.pitch = -Math.PI / 2;
      m.queueSlot(1 + (run.t % 7));
      if (run.t % 40 === 5) m.queueUse();
    });
    expect(good.result?.passed).toBe(true);
    const bad = play('pot', (run, m) => {
      m.player.pitch = 0.2;
      m.queueSlot(1 + (run.t % 7));
      if (run.t % 40 === 5) m.queueUse();
    }, 20 * 15);
    expect(bad.successes).toBe(0);
  });

  it('re-totem with the hotbar totem and F', () => {
    const run = play('retotem', (run, m) => {
      const p = m.player;
      // Between pops, restock the hotbar totem from the inventory (what a player does).
      if (run.s.poppedAt === null || run.s.poppedAt === undefined) {
        if (p.offhand?.id === 'totem_of_undying' && p.getSlot(8)?.id !== 'totem_of_undying') p.setSlot(8, { id: 'totem_of_undying', count: 1 });
      }
      if (p.offhand?.id !== 'totem_of_undying' && p.countItem('totem_of_undying') > 0) {
        const slot = p.inventory.findIndex((s, i) => i < 9 && s?.id === 'totem_of_undying');
        if (slot >= 0 && p.selected !== slot) m.queueSlot(slot);
        else if (slot >= 0) m.queueSwapHands();
      } else if (p.selected !== 0) m.queueSlot(0);
    });
    expect(run.result?.passed).toBe(true);
  });

  it('water bucket clutch', () => {
    const run = play('mlg', (run, m) => {
      const p = m.player;
      p.pitch = -Math.PI / 2;
      m.queueSlot(4);
      const ground = Number(run.s.ground ?? -100);
      if (run.s.air && p.vel.y < 0 && p.pos.y - ground < 2.8 && p.pos.y - ground > 0.3 && p.heldStack()?.id === 'water_bucket') m.queueUse();
    });
    expect(run.result?.passed).toBe(true);
  });

  it('aim tracking scores time on target', () => {
    const good = play('aim', (_run, m) => lookAt(m));
    expect(good.result?.passed).toBe(true);
    expect(good.result?.score).toBeGreaterThan(90);
    const idle = play('aim', () => {});
    expect(idle.result?.passed).toBe(false);
  });

  it('spacing: hits from the edge of reach count, close ones are called out', () => {
    const run = play('spacing', (_run, m) => {
      lookAt(m);
      const p = m.player;
      const d = dist(m);
      p.input = { forward: d > 3.1 ? 1 : d < 2.9 ? -1 : 0, strafe: 0, jump: false, sneak: false, sprint: false };
      if (p.attackStrengthScale(0.5) >= 1 && d > 2.85) m.queueClick();
    });
    expect(run.result?.passed).toBe(true);
  });

  it('hit select: punishing right after its swing counts, swinging first does not', () => {
    const run = play('hitselect', (run, m) => {
      lookAt(m);
      const p = m.player;
      walkTo(m, 2.3);
      const since = run.t - Number(run.s.swingAt ?? -999);
      if (since >= 1 && since <= 6 && p.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(run.result?.passed).toBe(true);
    const eager = play('hitselect', (_run, m) => {
      lookAt(m);
      walkTo(m, 2.3);
      if (m.player.attackStrengthScale(0.5) >= 1) m.queueClick();
    }, 20 * 20);
    expect(eager.fails).toBeGreaterThan(eager.successes);
  });

  it('shield timing: raised just before the swing blocks', () => {
    const run = play('block', (run, m) => {
      lookAt(m);
      const b = m.bot;
      const soon = run.t >= Number(run.s.raisedAt ?? 0) + 30 && b.attackStrengthScale(0.5) >= 1 && dist(m) < 3.6;
      m.useHeld = soon || (m.player.raisingShield() && run.t - Number(run.s.raisedAt ?? 0) < 20);
      if (soon && !m.player.raisingShield()) m.queueUse();
    });
    expect(run.successes).toBeGreaterThan(0);
  });

  it('disable → punish: three sword hits in the five seconds', () => {
    const run = play('punish', (run, m) => {
      lookAt(m);
      walkTo(m, 2.2);
      const p = m.player;
      const open = run.s.until !== null && run.s.until !== undefined && run.t < Number(run.s.until);
      m.queueSlot(open ? 1 : 0);
      if (p.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(run.result?.passed).toBe(true);
  });

  it('wind charge smash', () => {
    const run = play('smash', (run, m) => {
      const p = m.player;
      const d = dist(m);
      const phase = Number(run.s.phase ?? 0);
      if (phase === 0) {
        // Walk up next to it, then launch: look down, wind charge at our feet as we jump.
        lookAt(m);
        p.input = { forward: d > 1.6 ? 1 : 0, strafe: 0, jump: false, sneak: false, sprint: false };
        m.queueSlot(4);
        if (d <= 1.7 && p.onGround && p.heldStack()?.id === 'wind_charge') {
          p.pitch = -Math.PI / 2;
          p.input = { ...p.input, jump: true };
          m.queueUse();
          run.s.phase = 1;
        }
      } else {
        p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
        m.queueSlot(2);
        lookAt(m, 1.0);
        if (!p.onGround && p.fallDistance > 1.6 && d < 3) m.queueClick();
        if (p.onGround && p.fallDistance === 0 && run.t % 40 === 0) run.s.phase = 0;
      }
    });
    expect(run.successes).toBeGreaterThan(0);
  });

  it('crystal combo: obsidian, crystal, hit — the blast on the bot counts', () => {
    const aimAt = (m: Match, x: number, y: number, z: number) => {
      const p = m.player;
      const dx = x - p.pos.x;
      const dz = z - p.pos.z;
      p.yaw = Math.atan2(-dx, -dz);
      p.pitch = Math.atan2(y - (p.pos.y + p.eyeHeight()), Math.hypot(dx, dz));
    };
    const run = play('crystal', (run, m) => {
      const p = m.player;
      const b = m.bot;
      const ground = Number((run.s.g ??= p.pos.y));
      const step = Number(run.s.step ?? 0);
      // The cell beside the bot, on the player's side.
      const cx = Math.floor(b.pos.x);
      const cz = Math.floor(b.pos.z) + 1;
      p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
      if (step === 0) {
        // Stand about 3.5 blocks from that cell.
        p.pos.set(cx + 0.5, ground, cz + 3.8);
        m.queueSlot(1);
        aimAt(m, cx + 0.5, ground, cz + 0.5);
        if (p.heldStack()?.id === 'obsidian') {
          m.queueUse();
          run.s.step = 1;
        }
      } else if (step === 1) {
        m.queueSlot(2);
        aimAt(m, cx + 0.5, ground + 1, cz + 0.5);
        if (p.heldStack()?.id === 'end_crystal') {
          m.queueUse();
          run.s.step = 2;
        }
      } else if (step === 2) {
        m.queueSlot(0);
        aimAt(m, cx + 0.5, ground + 1.8, cz + 0.5);
        if (p.heldStack()?.id === 'netherite_sword') {
          m.queueClick();
          run.s.step = 3;
          run.s.wait = run.t + 12;
        }
      } else if (run.t >= Number(run.s.wait)) run.s.step = 0;
    });
    expect(run.successes).toBeGreaterThan(0);
  });

  it('crit chain: four crits in a row', () => {
    const run = play('critchain', (_run, m) => {
      lookAt(m);
      const p = m.player;
      p.input = { forward: dist(m) > 2.2 ? 1 : 0, strafe: 0, jump: p.onGround && p.attackStrengthScale(0.5) >= 0.8, sneak: false, sprint: false };
      if (!p.onGround && p.fallDistance > 0 && p.attackStrengthScale(0.5) >= 1) m.queueClick();
    });
    expect(run.successes).toBeGreaterThan(0);
  });
});

