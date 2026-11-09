import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { matchJar } from '../src/mods/jarMods';
import { ModManager } from '../src/mods/registry';
import { PROTOCOL_VERSION, type ServerMsg } from '../src/net/protocol';
import { Lobby, type Conn } from '../src/server/lobby';

function fightMatch() {
  const m = new Match(kitById('sword'), DIFFICULTIES.practice, 3);
  while (m.phase !== 'fight') m.tick();
  // Keep the bot out of it.
  m.bot.pos.set(m.player.pos.x + 30, m.bot.pos.y, m.player.pos.z);
  return m;
}

/** Bottles thrown in one second of holding right click. */
function throwsPerSecond(fastXp: boolean): number {
  const m = fightMatch();
  const p = m.player;
  p.fastXp = fastXp;
  p.inventory[p.selected] = { id: 'experience_bottle', count: 64 };
  p.pitch = 1.2;
  m.useHeld = true;
  for (let i = 0; i < 20; i++) m.tick();
  return 64 - (p.inventory[p.selected]?.count ?? 0);
}

describe('FastXP', () => {
  it('throws a bottle every tick instead of every 4', () => {
    const slow = throwsPerSecond(false);
    const fast = throwsPerSecond(true);
    expect(slow).toBeGreaterThanOrEqual(4);
    expect(slow).toBeLessThanOrEqual(6);
    expect(fast).toBeGreaterThanOrEqual(18);
  });
});

describe('Responsive Shields', () => {
  it('a shield blocks at once with 0 ticks, after 5 with vanilla', () => {
    // The tick the shield goes up is tick 0.
    for (const [raise, firstBlockingTick] of [
      [0, 0],
      [5, 4],
    ] as const) {
      const m = fightMatch();
      const p = m.player;
      p.shieldRaiseTicks = raise;
      p.offhand = { id: 'shield', count: 1 };
      p.inventory[p.selected] = null;
      m.useHeld = true;
      m.queueUse();
      let at = -1;
      for (let t = 0; t < 10 && at < 0; t++) {
        m.tick();
        if (p.isBlocking()) at = t;
      }
      expect(at).toBe(firstBlockingTick);
    }
  });

  it('is installed from the start, and its jar (Shield Fix) maps to it', () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: () => {} };
    const mods = new ModManager();
    expect(mods.on('responsiveshields')).toBe(true);
    expect(mods.cfg('responsiveshields', 'raise')).toBe(0);
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(matchJar('shieldfix')).toEqual({ kind: 'builtin', mods: ['responsiveshields'] });
    expect(matchJar('fastxp')).toEqual({ kind: 'builtin', mods: ['fastxp'] });
    expect(matchJar('bactromod')).toEqual({ kind: 'builtin', mods: ['bactromod'] });
  });
});

describe('Armor HUD settings', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: () => {} };
  });
  afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  it('the old single durability choice becomes the new switches', () => {
    store.set('pvp-trainer.mods.v1', JSON.stringify({ armorhud: { installed: true, enabled: true, config: { durability: 'percent' } } }));
    const mods = new ModManager();
    expect(mods.cfg('armorhud', 'percent')).toBe(true);
    expect(mods.cfg('armorhud', 'bar')).toBe(false);
    expect(mods.cfg('armorhud', 'numbers')).toBe(false);
  });
});

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

describe('online: host rules and FastXP', () => {
  it('the host’s raise time applies to people; each player’s FastXP to them', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    lobby.shieldRaiseTicks = 5;
    const a = conn();
    const b = conn();
    lobby.connect(a);
    lobby.connect(b);
    a.say({ t: 'join', room: 'RULES', name: 'A', v: PROTOCOL_VERSION, kit: 'sword', opts: { fastXp: true } });
    b.say({ t: 'join', room: 'RULES', name: 'B', v: PROTOCOL_VERSION, kit: 'sword' });
    const duel = lobby.rooms.get('RULES')!.duel!;
    expect(duel.fighters.map((f) => f.shieldRaiseTicks)).toEqual([5, 5]);
    expect(duel.fighters.map((f) => f.fastXp)).toEqual([true, false]);
    b.say({ t: 'opts', fastXp: true });
    expect(duel.fighters[1].fastXp).toBe(true);
    lobby.closeAll();
    vi.useRealTimers();
  });
});

describe('online: voice chat signalling', () => {
  it('passes call addresses around the room, to newcomers too, and clears them on leave', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const a = conn();
    const b = conn();
    lobby.connect(a);
    lobby.connect(b);
    a.say({ t: 'join', room: 'VOICE', name: 'A', v: PROTOCOL_VERSION, kit: 'sword' });
    a.say({ t: 'voice', id: 'peer-a-123' });
    b.say({ t: 'join', room: 'VOICE', name: 'B', v: PROTOCOL_VERSION, kit: 'sword' });
    expect(b.got).toContainEqual({ t: 'voice', name: 'A', id: 'peer-a-123' });
    b.say({ t: 'voice', id: 'peer-b-456' });
    expect(a.got).toContainEqual({ t: 'voice', name: 'B', id: 'peer-b-456' });
    // A bad address is treated as "no voice".
    b.say({ t: 'voice', id: '<script>' });
    expect(a.got.at(-1)).toEqual({ t: 'voice', name: 'B', id: '' });
    a.onClose?.();
    expect(b.got.filter((m) => m.t === 'voice').at(-1)).toEqual({ t: 'voice', name: 'A', id: '' });
    lobby.closeAll();
    vi.useRealTimers();
  });
});
