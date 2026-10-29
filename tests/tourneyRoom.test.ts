import { describe, expect, it, vi } from 'vitest';
import { draftOpen, draftStep, teamSlot } from '../src/game/tournament';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import type { TourView } from '../src/net/tourney';
import { Lobby, type Conn } from '../src/server/lobby';

function conn() {
  const got: ServerMsg[] = [];
  const c: Conn & { got: ServerMsg[]; say(m: object): void } = {
    got,
    send: (t) => got.push(JSON.parse(t) as ServerMsg),
    close: () => {},
    onMessage: null,
    onClose: null,
    say: (m) => c.onMessage?.(JSON.stringify(m)),
  };
  return c;
}

const lastView = (c: ReturnType<typeof conn>): TourView | undefined =>
  (c.got.filter((m) => m.t === 'tour').at(-1) as Extract<ServerMsg, { t: 'tour' }> | undefined)?.view;

describe('online tournament room', () => {
  it('runs a bracket of three people and bots to a champion over the wire', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const people = [conn(), conn(), conn()];
    for (const p of people) lobby.connect(p);
    people[0].say({ t: 'join', room: 'CUP', name: 'Host', v: PROTOCOL_VERSION, tour: { size: 8, field: 'rising' }, rating: 5 });
    people[1].say({ t: 'join', room: 'CUP', name: 'Ann', v: PROTOCOL_VERSION, rating: 3 });
    people[2].say({ t: 'join', room: 'CUP', name: 'Ann', v: PROTOCOL_VERSION });
    const v0 = lastView(people[0])!;
    expect(v0.members.map((m) => m.name)).toEqual(['Host', 'Ann', 'Ann (2)']);
    expect(v0.tour).toBeNull();
    // Only the host can start it.
    people[1].say({ t: 'tstart' });
    expect(lastView(people[0])!.tour).toBeNull();
    people[0].say({ t: 'tstart' });
    expect(lastView(people[2])!.tour!.entrants).toHaveLength(8);

    const room = [...lobby.rooms.values()][0];
    let duels = 0;
    let locals = 0;
    const answered = new Set<string>();
    for (let s = 0; s < 4000; s++) {
      vi.advanceTimersByTime(250);
      for (const p of people) {
        const v = lastView(p);
        const t = v?.tour;
        if (!v || !t || !v.live) continue;
        const m = t.matches.find((x) => x.id === v.live!.match)!;
        const step = m.draft && draftStep(m.draft);
        if (v.live.stage === 'draft' && step && step.kind !== 'decider') {
          const e = t.entrants[m.players[teamSlot(m.draft!, step.team)]!];
          if (e.pid === v.you) p.say({ t: 'tdraft', kit: draftOpen(m.draft!)[0] });
        }
        // A game against a bot: report it (won by whoever was asked first).
        let at = -1;
        for (let i = p.got.length - 1; i >= 0 && at < 0; i--) if (p.got[i].t === 'tplay') at = i;
        const key = `${people.indexOf(p)}:${at}`;
        if (at >= 0 && !answered.has(key)) {
          answered.add(key);
          locals++;
          p.say({ t: 'tresult', won: people.indexOf(p) === 0 });
        }
      }
      // A person-vs-person duel: once it's on, one of them falls.
      const duel = room.duel;
      if (duel && duel.phase === 'fight') {
        duels++;
        const f = duel.fighters[1];
        f.health = 0;
        f.die();
      }
      if (lastView(people[0])!.tour!.champion !== null) break;
    }
    const t = lastView(people[1])!.tour!;
    expect(t.champion).not.toBeNull();
    expect(locals).toBeGreaterThan(0);
    expect(duels).toBeGreaterThan(0);
    // Every duel told its two players their seats.
    expect(people.flatMap((p) => p.got.filter((m) => m.t === 'start')).every((m) => (m as { you?: number }).you !== undefined)).toBe(true);
    lobby.closeAll();
    vi.useRealTimers();
  }, 60_000);

  it('turns people away once it has started, and replaces a leaver with a bot', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.connect(a);
    lobby.connect(b);
    a.say({ t: 'join', room: 'CUP', name: 'Host', v: PROTOCOL_VERSION, tour: { size: 4, field: 'open' } });
    b.say({ t: 'join', room: 'CUP', name: 'Bea', v: PROTOCOL_VERSION });
    a.say({ t: 'tstart' });
    const late = conn();
    lobby.connect(late);
    late.say({ t: 'join', room: 'CUP', name: 'Late', v: PROTOCOL_VERSION });
    expect(late.got.at(-1)).toMatchObject({ t: 'error' });
    b.onClose?.();
    const t = lastView(a)!.tour!;
    expect(t.entrants.find((e) => e.name.startsWith('Bea'))!.tier).not.toBeNull();
    lobby.closeAll();
    vi.useRealTimers();
  });
});
