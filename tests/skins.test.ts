import { describe, expect, it, vi } from 'vitest';
import { Lobby, type Conn } from '../src/server/lobby';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { cleanSkin, SKIN_MAX } from '../src/net/skin';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAA==';

function conn() {
  const got: ServerMsg[] = [];
  const c: Conn & { got: ServerMsg[]; say(m: object): void } = {
    got,
    send: (t) => got.push(JSON.parse(t) as ServerMsg),
    close: () => undefined,
    onMessage: null,
    onClose: null,
    say: (m) => c.onMessage?.(JSON.stringify(m)),
  };
  return c;
}

describe('skins', () => {
  it('accepts only a PNG data URL of sensible size', () => {
    expect(cleanSkin({ png: PNG, slim: 1 })).toEqual({ png: PNG, slim: true });
    expect(cleanSkin({ png: 'https://evil.example/x.png' })).toBeNull();
    expect(cleanSkin({ png: 'data:image/svg+xml;base64,AAAA' })).toBeNull();
    expect(cleanSkin({ png: 'data:image/png;base64,<script>' })).toBeNull();
    expect(cleanSkin({ png: PNG + 'A'.repeat(SKIN_MAX) })).toBeNull();
    expect(cleanSkin('nope')).toBeNull();
  });

  it('everyone in an online room gets the skins of the others, by name', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.connect(a);
    lobby.connect(b);
    a.say({ t: 'join', room: 'SKINS', name: 'Techno', v: PROTOCOL_VERSION, kit: 'sword', skin: { png: PNG, slim: false } });
    // A bad skin is dropped (the player is still let in, as the default player).
    b.say({ t: 'join', room: 'SKINS', name: 'Guest', v: PROTOCOL_VERSION, kit: 'sword', skin: { png: 'javascript:alert(1)', slim: true } });
    const got = b.got.filter((m) => m.t === 'skins').at(-1);
    expect(got).toEqual({ t: 'skins', list: [{ name: 'Techno', png: PNG, slim: false }] });
    expect(b.got.some((m) => m.t === 'start')).toBe(true);
    // Guest's bad skin never reaches Techno.
    expect(a.got.some((m) => m.t === 'skins')).toBe(false);
    lobby.closeAll();
    vi.useRealTimers();
  });
});
