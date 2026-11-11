import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { Lobby, type Conn } from '../src/server/lobby';

function conn() {
  const got: ServerMsg[] = [];
  const c: Conn & { got: ServerMsg[]; say(m: object): void; last<T extends ServerMsg['t']>(t: T): Extract<ServerMsg, { t: T }> | undefined } = {
    got,
    send: (t) => got.push(JSON.parse(t) as ServerMsg),
    close: () => undefined,
    onMessage: null,
    onClose: null,
    say: (m) => c.onMessage?.(JSON.stringify(m)),
    last: (t) => got.filter((m) => m.t === t).at(-1) as never,
  };
  return c;
}

describe('party minigames online', () => {
  it('a Whodunit room: people join, the host sets the size, bots fill it, everyone gets a result', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const people = Array.from({ length: 3 }, conn);
    for (const c of people) lobby.connect(c);
    const [host, b, c] = people;
    host.say({ t: 'join', room: 'MANOR', name: 'Host', v: PROTOCOL_VERSION, kit: 'whodunit', squad: { tier: 'lt3', size: 99 } });
    // Capped at the game's limit; no teams to pick.
    expect(host.last('squad')).toMatchObject({ kit: 'whodunit', size: 15, started: false });
    b.say({ t: 'join', room: 'MANOR', name: 'Bea', v: PROTOCOL_VERSION });
    c.say({ t: 'join', room: 'MANOR', name: 'Cy', v: PROTOCOL_VERSION });
    expect(c.last('squad')!.members.map((m) => m.name)).toEqual(['Host', 'Bea', 'Cy']);
    // Only the host resizes, never below the people there or the game's minimum.
    b.say({ t: 'size', n: 5 });
    expect(host.last('squad')!.size).toBe(15);
    host.say({ t: 'size', n: 1 });
    expect(host.last('squad')!.size).toBe(3);
    host.say({ t: 'size', n: 7 });
    expect(host.last('squad')!.size).toBe(7);
    b.say({ t: 'go' });
    expect(lobby.rooms.get('MANOR')!.duel).toBeNull();
    host.say({ t: 'go' });
    const duel = lobby.rooms.get('MANOR')!.duel!;
    expect(duel.seats).toBe(7);
    expect(people.map((p) => p.last('start'))).toMatchObject([
      { kit: 'whodunit', you: 0, seats: 7 },
      { you: 1, seats: 7 },
      { you: 2, seats: 7 },
    ]);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => duel.isBot(i))).toEqual([false, false, false, true, true, true, true]);
    // Every one for themselves.
    expect(new Set(duel.fighters.map((f) => f.team)).size).toBe(7);
    // A fourth person can't join a game in progress.
    const late = conn();
    lobby.connect(late);
    late.say({ t: 'join', room: 'MANOR', name: 'Late', v: PROTOCOL_VERSION });
    expect(late.got.at(-1)).toMatchObject({ t: 'error' });
    // Someone leaves: a bot plays on in their place.
    c.onClose?.();
    expect(duel.isBot(2)).toBe(true);
    // Play it out (the people stand still; the bots do the rest, or the clock runs out).
    for (let i = 0; i < 20 * 60 * 6 && duel.phase !== 'ended'; i++) vi.advanceTimersByTime(50);
    expect(duel.phase).toBe('ended');
    vi.advanceTimersByTime(200);
    const end = host.last('end')!;
    expect(end.winner).not.toBeNull();
    // The murderer alone, or the whole innocent side (six of the seven seats).
    expect([1, 6]).toContain(end.ws!.length);
    lobby.closeAll();
    vi.useRealTimers();
  }, 120_000);

  it('Sumo, Crumble and Hot Potato rooms start at any size and name one winner', () => {
    vi.useFakeTimers();
    for (const [kit, size] of [
      ['sumo', 8],
      ['crumble', 12],
      ['hotpotato', 5],
    ] as const) {
      const lobby = new Lobby();
      const a = conn();
      const b = conn();
      lobby.connect(a);
      lobby.connect(b);
      a.say({ t: 'join', room: 'PARTY', name: 'A', v: PROTOCOL_VERSION, kit, squad: { tier: 'ht3', size } });
      b.say({ t: 'join', room: 'PARTY', name: 'B', v: PROTOCOL_VERSION });
      a.say({ t: 'go' });
      const duel = lobby.rooms.get('PARTY')!.duel!;
      expect(duel.seats, kit).toBe(size);
      // (A person's falling comes from their own game; these two send nothing, so they're taken
      // out by hand once the fight starts and the bots play on.)
      while (duel.phase !== 'fight') vi.advanceTimersByTime(50);
      for (const i of [0, 1]) {
        duel.fighters[i].health = 0;
        duel.fighters[i].die();
      }
      const over = () => (duel.phase as string) === 'ended';
      for (let i = 0; i < 20 * 60 * 8 && !over(); i++) vi.advanceTimersByTime(50);
      expect(over(), kit).toBe(true);
      vi.advanceTimersByTime(200);
      expect(a.last('end')!.ws, kit).toHaveLength(1);
      lobby.closeAll();
    }
    vi.useRealTimers();
  }, 240_000);

  it('nametags online say what the game allows: who is lit in Hot Potato, nothing in Whodunit', () => {
    vi.useFakeTimers();
    for (const kit of ['hotpotato', 'whodunit'] as const) {
      const lobby = new Lobby();
      const a = conn();
      lobby.connect(a);
      a.say({ t: 'join', room: 'TAGS', name: 'A', v: PROTOCOL_VERSION, kit, squad: { tier: 'lt3', size: 4 } });
      a.say({ t: 'go' });
      const duel = lobby.rooms.get('TAGS')!.duel!;
      // Into the fight, and past Hot Potato's two seconds before someone is lit.
      while (duel.phase !== 'fight') vi.advanceTimersByTime(50);
      vi.advanceTimersByTime(4000);
      const tags = a.last('mode')!.tags!;
      expect(tags, kit).toHaveLength(4);
      if (kit === 'whodunit') expect(tags).toEqual(['', '', '', '']);
      else expect(tags.filter((t) => t === 'IT!'), kit).toHaveLength(1);
      lobby.closeAll();
    }
    vi.useRealTimers();
  });
});
