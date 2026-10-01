import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, type DifficultyId } from '../src/ai/difficulty';
import { Rng } from '../src/core/rng';
import { defaultGameRules } from '../src/game/World';
import { kitById, type BuiltinKitId } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { ReplayRecorder, loadReplays, saveReplays, MAX_REPLAYS, type ReplayData } from '../src/game/replay';
import { ReplayWatch, dropEvents, replayMatch } from '../src/game/ReplayWatch';
import { SHOP } from '../src/game/modes/shop';
import { Skywars } from '../src/game/modes/Skywars';

const header = (kit: BuiltinKitId, tier: DifficultyId, seed: number) => ({
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
  date: 1_700_000_000_000 + seed,
});

/** A fake player: random keys, mouse, clicks, hotbar, right clicks and screen actions. */
function play(kit: BuiltinKitId, tier: DifficultyId, seed: number, ticks: number) {
  const h = header(kit, tier, seed);
  const m = replayMatch({ ...h, id: '', frames: [], checks: [], winner: null, fightTicks: 0 });
  const rec = new ReplayRecorder(h);
  m.recorder = rec;
  rec.start(m.player);
  const r = new Rng(seed * 31 + 5);
  const trace: number[][] = [];
  for (let t = 0; t < ticks && m.phase !== 'ended'; t++) {
    const p = m.player;
    // Face the bot, more or less, so hits land.
    const want = Math.atan2(-(m.bot.pos.x - p.pos.x), -(m.bot.pos.z - p.pos.z));
    p.yaw = want + r.gauss() * 0.2;
    p.pitch = r.range(-0.3, 0.3);
    p.input = { forward: r.chance(0.8) ? 1 : r.int(-1, 1), strafe: r.int(-1, 1), jump: r.chance(0.15), sneak: r.chance(0.03), sprint: r.chance(0.7) };
    p.doubleTapSprint = r.chance(0.5);
    m.useHeld = r.chance(0.1);
    m.attackHeld = r.chance(0.05);
    if (r.chance(0.3)) m.queueClick(r.chance(0.5) ? Number.NaN : r.range(0, 4));
    if (r.chance(0.04)) m.queueSlot(r.int(0, 8));
    if (r.chance(0.02)) m.queueUse();
    if (r.chance(0.01)) m.queueSwapHands();
    if (r.chance(0.01)) m.act({ k: 'stopUse' });
    // An inventory screen moving items around between ticks.
    if (r.chance(0.01)) {
      const a = r.int(0, 35);
      const b = r.int(0, 35);
      const sa = p.getSlot(a);
      p.setSlot(a, p.getSlot(b));
      p.setSlot(b, sa);
    }
    // /weather between ticks (rain puts out fire).
    if (r.chance(0.01)) {
      m.world.raining = !m.world.raining;
      m.recorder!.act({ k: 'env', raining: m.world.raining, dayTime: m.world.dayTime, rules: { ...m.world.rules } });
    }
    if (m.phase === 'fight' && r.chance(0.02)) m.act({ k: 'buy', key: SHOP[r.int(0, SHOP.length - 1)].key });
    if (m.mode instanceof Skywars && m.phase === 'fight' && r.chance(0.02)) {
      const c = m.mode.layout.islandChests[0][0];
      m.act({ k: 'open', ...c });
      m.act({ k: 'take', ...c, i: r.int(0, 26) });
    }
    m.tick();
    dropEvents(m);
    trace.push([p.pos.x, p.pos.y, p.pos.z, p.health, m.bot.pos.x, m.bot.pos.y, m.bot.pos.z, m.bot.health, p.selected]);
  }
  const winner = m.winner ? (m.winner === m.player ? 'player' : 'bot') : null;
  const data = rec.finish(winner, m.fightTicks)!;
  // Through JSON, like localStorage.
  return { data: JSON.parse(JSON.stringify(data)) as ReplayData, trace, m };
}

function rerun(data: ReplayData) {
  const w = new ReplayWatch(data);
  w.seek(0);
  const trace: number[][] = [];
  while (w.t < w.total) {
    w.tick();
    const m = w.match;
    dropEvents(m);
    const p = m.player;
    trace.push([p.pos.x, p.pos.y, p.pos.z, p.health, m.bot.pos.x, m.bot.pos.y, m.bot.pos.z, m.bot.health, p.selected]);
  }
  return { w, trace };
}

const KITS: BuiltinKitId[] = ['sword', 'sword18', 'axe', 'uhc', 'diamond_pot', 'neth_pot', 'crystal', 'smp', 'mace', 'cart', 'dia_smp', 'bedwars', 'skywars'];

describe('replays', () => {
  for (const kit of KITS) {
    it(`re-run ${kit} exactly, tick for tick`, () => {
      const { data, trace } = play(kit, 'ht3', 11, 20 * 40);
      expect(data.frames.length).toBe(trace.length);
      const again = rerun(data);
      expect(again.w.desynced).toBe(false);
      expect(again.trace).toEqual(trace);
    }, 60000);
  }

  it('really depends on the recording: one changed click changes the fight', () => {
    const { data, trace } = play('sword', 'ht3', 5, 20 * 30);
    // The fight happened: both took damage.
    expect(trace.some((t) => t[3] < 20)).toBe(true);
    expect(trace.some((t) => t[7] < 20)).toBe(true);
    const at = data.frames.findIndex((f, i) => i > 100 && f.c);
    data.frames[at].c = undefined;
    data.frames[at].y = (data.frames[at].y ?? 0) + 2;
    expect(rerun(data).trace).not.toEqual(trace);
  });

  it('the recording is small', () => {
    const { data } = play('sword', 'ht3', 4, 20 * 60);
    // A minute of play, with the mouse moving every tick.
    expect(JSON.stringify(data).length).toBeLessThan(160_000);
  });

  it('seeking back and forth lands on the same state as playing through', () => {
    const { data, trace } = play('crystal', 'lt2', 7, 20 * 30);
    expect(data.frames.length).toBeGreaterThan(200);
    const w = new ReplayWatch(data);
    w.seek(400);
    w.seek(150);
    expect(w.t).toBe(150);
    const p = w.match.player;
    expect([p.pos.x, p.pos.y, p.pos.z, p.health]).toEqual(trace[149].slice(0, 4));
    w.seekBy(5);
    const to = Math.min(250, w.total);
    expect(w.t).toBe(to);
    expect(w.match.bot.health).toBe(trace[to - 1][7]);
  });

  it('seeking to the end of a long Bed Wars game is quick', () => {
    const { data } = play('bedwars', 'ht2', 3, 20 * 180);
    const w = new ReplayWatch(data);
    const t0 = performance.now();
    w.seek(w.total);
    const ms = performance.now() - t0;
    expect(w.t).toBe(data.frames.length);
    // Seeking back re-runs from the start: it has to stay well under a second.
    expect(ms).toBeLessThan(1500);
  }, 60000);

  it('notices a replay that no longer matches the game', () => {
    const { data } = play('sword', 'ht3', 9, 20 * 20);
    data.checks[5] ^= 1;
    const { w } = rerun(data);
    expect(w.desynced).toBe(true);
  });

  it('ends paused on the result', () => {
    const { data } = play('sword', 'practice', 2, 20 * 8);
    const { w } = rerun(data);
    w.tick();
    expect(w.paused).toBe(true);
    w.togglePause();
    expect(w.paused).toBe(false);
    expect(w.t).toBe(w.start);
  });

  it('a duel to the death is recorded with its winner', () => {
    // Stand still against HT1: the bot wins.
    const m = new Match(kitById('sword'), DIFFICULTIES.ht1, 3);
    const rec = new ReplayRecorder(header('sword', 'ht1', 3));
    m.recorder = rec;
    rec.start(m.player);
    for (let t = 0; t < 20 * 120 && m.phase !== 'ended'; t++) {
      m.tick();
      dropEvents(m);
    }
    expect(m.winner).toBe(m.bot);
    const data = rec.finish('bot', m.fightTicks)!;
    const { w } = rerun(data);
    expect(w.match.player.dead).toBe(true);
    expect(w.match.phase).toBe('ended');
  }, 60000);
});

describe('saved replays', () => {
  const fake = (i: number, starred = false): ReplayData => ({
    ...header('sword', 'ht3', i),
    id: `r${i}`,
    frames: [{}],
    checks: [],
    winner: 'player',
    fightTicks: 1,
    starred,
  });

  it('keeps the newest, never drops a starred one, and survives a reload', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const list = [fake(0, true), ...Array.from({ length: MAX_REPLAYS + 5 }, (_, i) => fake(i + 1))];
    const kept = saveReplays(list);
    expect(kept.length).toBe(MAX_REPLAYS);
    expect(kept.some((r) => r.id === 'r0')).toBe(true);
    expect(kept[0].id).toBe(`r${MAX_REPLAYS + 5}`);
    expect(loadReplays().map((r) => r.id)).toEqual(kept.map((r) => r.id));
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
