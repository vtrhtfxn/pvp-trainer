import { describe, expect, it } from 'vitest';
import { draftOpen, draftStep, matchById, teamSlot } from '../src/game/tournament';
import { DRAFT_TURN_MS, OnlineTourney, type TourHooks } from '../src/net/tourney';

function setup(size: 4 | 8 = 4, people = 2) {
  let now = 0;
  const log: string[] = [];
  const duel = { on: false, a: -1, b: -1 };
  const local: { pid: number; kit: string }[] = [];
  const hooks: TourHooks = {
    changed: () => {},
    startDuel: (a, b, kit) => {
      Object.assign(duel, { on: true, a, b });
      log.push(`duel ${a}v${b} ${kit}`);
    },
    stopDuel: () => {
      duel.on = false;
    },
    playLocal: (pid, kit) => {
      local.push({ pid, kit });
      log.push(`local ${pid} ${kit}`);
    },
  };
  const tour = new OnlineTourney(size, 'open', hooks, () => now, 99);
  for (let i = 0; i < people; i++) expect(tour.join({ pid: i + 1, name: `P${i + 1}`, rating: 4 })).toBe(true);
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 250) {
      now += 250;
      tour.tick();
    }
  };
  return { tour, advance, duel, local, log };
}

/** Plays whatever is live until the tournament ends: people make their draft moves, win or lose games. */
function playOut(s: ReturnType<typeof setup>, pickFor = true) {
  const { tour, advance, duel, local } = s;
  for (let guard = 0; guard < 2000 && tour.t!.champion === null; guard++) {
    const v = tour.view(1);
    const live = v.live;
    if (live?.stage === 'draft' && pickFor) {
      const m = matchById(tour.t!, live.match);
      const step = draftStep(m.draft!);
      if (step && step.kind !== 'decider') {
        const e = tour.t!.entrants[m.players[teamSlot(m.draft!, step.team)]!];
        if (e.pid !== undefined) tour.draft(e.pid, draftOpen(m.draft!)[0]);
      }
    }
    if (live?.stage === 'game') {
      if (live.pve) {
        const l = local.pop();
        if (l) tour.result(l.pid, l.pid === 1);
      } else if (duel.on) tour.duelEnded(duel.a);
    }
    advance(1000);
  }
}

describe('online tournament', () => {
  it('lets only the host start it, then plays the bracket to a champion', () => {
    const s = setup(4, 2);
    expect(s.tour.start(2)).toMatch(/host/);
    expect(s.tour.start(1)).toBeNull();
    expect(s.tour.join({ pid: 9, name: 'Late', rating: 1 })).toBe(false);
    expect(s.tour.t!.entrants.filter((e) => e.pid !== undefined)).toHaveLength(2);
    playOut(s);
    expect(s.tour.t!.champion).not.toBeNull();
    expect(s.tour.t!.matches.every((m) => m.winner !== null)).toBe(true);
  });

  it('runs person vs person as a duel and person vs bot in that person’s game', () => {
    const s = setup(4, 2);
    s.tour.start(1);
    playOut(s);
    expect(s.log.some((l) => l.startsWith('duel'))).toBe(true);
    expect(s.log.some((l) => l.startsWith('local'))).toBe(true);
  });

  it('makes a bot choice for someone who runs out of time', () => {
    const s = setup(4, 1);
    s.tour.start(1);
    const live = s.tour.view(1).live!;
    expect(live.stage).toBe('draft');
    const m = matchById(s.tour.t!, live.match);
    s.advance(DRAFT_TURN_MS + 3000);
    expect(m.draft!.bans[0]).not.toBeNull();
    expect(m.draft!.bans[1]).not.toBeNull();
  });

  it('hands a leaver’s place to a bot and carries on', () => {
    const s = setup(8, 3);
    s.tour.start(1);
    s.tour.leave(3);
    const e = s.tour.t!.entrants.find((x) => x.name.startsWith('P3'))!;
    expect(e.tier).not.toBeNull();
    expect(e.name).toMatch(/\(bot\)/);
    playOut(s);
    expect(s.tour.t!.champion).not.toBeNull();
  });

  it('a person who leaves mid-duel: the other one plays on against the bot', () => {
    const s = setup(4, 2);
    s.tour.start(1);
    // Draft and break until the first duel between the two people (if they meet in round 1).
    for (let i = 0; i < 200 && !s.duel.on && s.tour.t!.champion === null; i++) {
      const live = s.tour.view(1).live;
      if (live?.stage === 'game' && live.pve) {
        const l = s.local.pop();
        if (l) s.tour.result(l.pid, true);
      }
      if (live?.stage === 'draft') {
        const m = matchById(s.tour.t!, live.match);
        const step = draftStep(m.draft!);
        if (step && step.kind !== 'decider') {
          const e = s.tour.t!.entrants[m.players[teamSlot(m.draft!, step.team)]!];
          if (e.pid !== undefined) s.tour.draft(e.pid, draftOpen(m.draft!)[0]);
        }
      }
      s.advance(1000);
    }
    expect(s.duel.on).toBe(true);
    const stayer = s.duel.a === 1 ? 1 : s.duel.b === 1 ? 1 : s.duel.a;
    const leaver = stayer === s.duel.a ? s.duel.b : s.duel.a;
    s.tour.leave(leaver);
    expect(s.duel.on).toBe(false);
    s.advance(6000);
    expect(s.local.at(-1)?.pid).toBe(stayer);
  });
});
