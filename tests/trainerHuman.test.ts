import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { DrillRun, drillById } from '../src/trainer/drills';

/** A human-ish player: aim lags 3 ticks behind the bot, knows the technique, 60 s per drill. */
function human(id: string) {
  const def = drillById(id)!;
  const m = new Match(kitById(def.kit), DIFFICULTIES[def.profile ?? 'practice'], 7);
  const run = new DrillRun(def, m);
  const hist: { x: number; z: number; y: number }[] = [];
  let hurtAt = -99, swingSeen = -99, lastBotCharge = 1;
  let swings = 0;
  let lastHitAt = -99;
  for (let i = 0; i < 20 * 60 && !run.result; i++) {
    const p = m.player, b = m.bot;
    hist.push({ x: b.pos.x, z: b.pos.z, y: b.pos.y });
    const seen = hist[Math.max(0, hist.length - 4)];
    const dx = seen.x - p.pos.x, dz = seen.z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(seen.y + 1.2 - (p.pos.y + p.eyeHeight()), Math.hypot(dx, dz));
    const d = Math.hypot(dx, dz);
    const charged = p.attackStrengthScale(0.5) >= 1;
    if (p.hurtTime === 9) hurtAt = run.t;
    const bc = b.attackStrengthScale(0);
    if (bc < lastBotCharge - 0.5) swingSeen = run.t;
    lastBotCharge = bc;
    const inReach = d < 3.0;
    let click = false;
    const inp = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    if (id === 'cooldown' || id === 'wtap') { inp.forward = d > 2.5 ? 1 : 0; inp.sprint = id === 'wtap'; click = charged && inReach; }
    if (id === 'crit' || id === 'critchain') { inp.forward = d > 2.3 ? 1 : 0; inp.jump = p.onGround && p.attackStrengthScale(0.5) > 0.75; click = charged && !p.onGround && p.fallDistance > 0 && inReach; }
    if (id === 'spacing') {
      // Spacing reads the live reach readout, not the lagged view.
      const live = Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
      // Hold ground at the edge, hit it as it walks in, S-tap for a moment after each hit.
      const sTap = run.t - lastHitAt < 5;
      inp.forward = sTap ? -1 : live > 3.1 ? 1 : 0;
      click = charged && live < 3.25 && live > 2.8;
      if (click) lastHitAt = run.t;
    }
    if (id === 'pcrit') { inp.forward = d > 2.4 ? 1 : 0; click = charged && run.t - hurtAt < 20 && !p.onGround && p.fallDistance > 0 && inReach; }
    if (id === 'hitselect') { inp.forward = d > 2.6 ? 1 : 0; const since = run.t - swingSeen; click = charged && since >= 3 && since <= 9 && inReach; }
    p.input = inp;
    if (click) { m.queueClick(); swings++; }
    m.tick();
    run.update();
    for (const f of [m.player, m.bot]) f.events.length = 0;
    m.world.events.length = 0;
  }
  return run;
}

describe('Trainer drills are passable by a human-like player', () => {
  // Aim lags 3 ticks behind the bot and it clicks on its own read of the distance — no perfect
  // knowledge. The drill bots must stay hittable for this player to pass in a minute.
  for (const id of ['cooldown', 'wtap', 'crit', 'spacing', 'critchain', 'pcrit', 'hitselect']) {
    it(id, () => {
      const run = human(id);
      expect(run.result?.passed, `${id}: ${run.successes} ok / ${run.fails} fail`).toBe(true);
    });
  }
});
