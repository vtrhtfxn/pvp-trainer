import { describe, expect, it, vi } from 'vitest';
import { Lobby, type Conn } from '../src/server/lobby';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';

function conn() {
  const got: ServerMsg[] = [];
  const c: Conn & { got: ServerMsg[]; closed: boolean; say(m: object): void } = {
    got,
    closed: false,
    send: (t) => got.push(JSON.parse(t) as ServerMsg),
    close: () => {
      c.closed = true;
    },
    onMessage: null,
    onClose: null,
    say: (m) => c.onMessage?.(JSON.stringify(m)),
  };
  return c;
}

describe('Lobby (shared by the LAN server and online hosting)', () => {
  it('seats two players in a room and starts the duel with the creator’s kit', () => {
    vi.useFakeTimers();
    const lobby = new Lobby({ maxRooms: 1 });
    const a = conn();
    const b = conn();
    lobby.connect(a);
    lobby.connect(b);
    a.say({ t: 'join', room: 'QWRTZ', name: 'Host', v: PROTOCOL_VERSION, kit: 'crystal' });
    b.say({ t: 'join', room: 'QWRTZ', name: 'Guest', v: PROTOCOL_VERSION, kit: 'sword' });
    expect(a.got.find((m) => m.t === 'joined')).toMatchObject({ you: 0, room: 'QWRTZ' });
    expect(b.got.find((m) => m.t === 'joined')).toMatchObject({ you: 1 });
    expect(b.got.find((m) => m.t === 'start')).toMatchObject({ kit: 'crystal' });
    vi.advanceTimersByTime(500);
    expect(b.got.some((m) => m.t === 'state')).toBe(true);
    // A third player is turned away; a second room is over the limit.
    const c = conn();
    lobby.connect(c);
    c.say({ t: 'join', room: 'QWRTZ', name: 'X', v: PROTOCOL_VERSION });
    expect(c.got.at(-1)).toMatchObject({ t: 'error' });
    const d = conn();
    lobby.connect(d);
    d.say({ t: 'join', room: 'OTHER', name: 'Y', v: PROTOCOL_VERSION });
    expect(d.got.at(-1)).toMatchObject({ t: 'error' });
    // The guest leaving puts the host back in the lobby; closeAll ends everything.
    b.onClose?.();
    expect(a.got.at(-1)).toMatchObject({ t: 'lobby' });
    lobby.closeAll();
    expect(a.closed).toBe(true);
    expect(lobby.rooms.size).toBe(0);
    vi.useRealTimers();
  });

  it('turns away an older game version', () => {
    const lobby = new Lobby();
    const a = conn();
    lobby.connect(a);
    a.say({ t: 'join', room: '', name: 'Old', v: PROTOCOL_VERSION - 1 });
    expect(a.got[0]).toMatchObject({ t: 'error' });
  });
});
