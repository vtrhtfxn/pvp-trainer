import { describe, expect, it, vi } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { yawTowards } from '../src/core/math';
import type { KitId } from '../src/game/kits';
import { Duel } from '../src/net/Duel';
import { NetMatch } from '../src/net/NetMatch';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '../src/net/protocol';
import { Lobby, type Conn } from '../src/server/lobby';

class FakeNet {
  connected = true;
  out: ClientMsg[] = [];
  send(m: ClientMsg) {
    this.out.push(JSON.parse(JSON.stringify(m)) as ClientMsg);
  }
}

/** A 2v2 on the server: two people (seats 0 and 2, red) against two server bots (1 and 3). */
function teamRoom(kit: KitId) {
  const duel = new Duel(['Ann', 'Bot B1', 'Bea', 'Bot B2'], kit);
  duel.makeBot(1, DIFFICULTIES.lt3);
  duel.makeBot(3, DIFFICULTIES.lt3);
  const people = [0, 2];
  const nets = people.map(() => new FakeNet());
  const clients = people.map((seat, k) => new NetMatch(nets[k] as never, seat, kit, 4));
  const deliver = (k: number, m: ServerMsg) => clients[k].handle(JSON.parse(JSON.stringify(m)) as ServerMsg);
  for (let k = 0; k < 2; k++) deliver(k, { t: 'start', countdown: 3, kit, you: people[k], seats: 4 });
  let now = 0;
  duel.clock = () => now;
  for (const c of clients) c.clock = () => now;
  let n = 0;
  const tick = () => {
    now += 50;
    for (let k = 0; k < 2; k++) {
      clients[k].tick();
      for (const m of nets[k].out) {
        const relay = duel.receive(people[k], m);
        if (relay) deliver(1 - k, relay);
      }
      nets[k].out.length = 0;
    }
    for (const e of duel.tick()) {
      if (e.mv) for (let k = 0; k < 2; k++) deliver(k, e.mv);
      const to = e.motion?.to ?? e.teleport?.to;
      const k = people.indexOf(to ?? -1);
      if (k >= 0 && e.motion) deliver(k, { t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      if (k >= 0 && e.teleport) deliver(k, { t: 'teleport', ...e.teleport });
    }
    const state = duel.stateMessage(++n, [0, 0, 0, 0]);
    for (let k = 0; k < 2; k++) deliver(k, state);
    for (const { to, msg } of duel.takeOutbox()) for (let k = 0; k < 2; k++) if (to < 0 || to === people[k]) deliver(k, msg);
  };
  return { duel, clients, tick };
}

describe('online 2v2', () => {
  it('two people against two server bots: everyone is drawn, the bots move and fight', () => {
    const r = teamRoom('sword');
    for (let t = 0; t < 120 && r.duel.phase !== 'fight'; t++) r.tick();
    expect(r.duel.phase).toBe('fight');
    const c = r.clients[0];
    expect(c.fighters).toHaveLength(4);
    expect(c.fighters.map((f) => f.team)).toEqual([0, 1, 0, 1]);
    expect(c.player).toBe(c.fighters[0]);
    expect(c.fighters[2].name).toBe('Bea');
    const startZ = c.fighters[1].pos.z;
    for (let t = 0; t < 80; t++) r.tick();
    // The bots came for us — and the client drew them moving (from their relayed moves).
    expect(Math.abs(c.fighters[1].pos.z - startZ)).toBeGreaterThan(2);
    expect(Math.hypot(c.fighters[3].pos.x - r.duel.fighters[3].pos.x, c.fighters[3].pos.z - r.duel.fighters[3].pos.z)).toBeLessThan(2);
    expect(r.duel.fighters[0].stats.damageTaken + r.duel.fighters[2].stats.damageTaken).toBeGreaterThan(0);
  });

  it('a click aimed at the second bot hits that bot, never a teammate', () => {
    const r = teamRoom('sword');
    for (let t = 0; t < 120 && r.duel.phase !== 'fight'; t++) r.tick();
    const d = r.duel;
    const me = d.fighters[0];
    const target = d.fighters[3];
    // Put bot 3 right in front of seat 0; the click says it saw the newest moment (no rewind).
    target.pos.set(me.pos.x, me.pos.y, me.pos.z - 2.5);
    me.attackStrengthTicker = 100;
    me.yaw = yawTowards(target.pos.x - me.pos.x, target.pos.z - me.pos.z);
    me.pitch = 0;
    d.queueAttack(0, 1e9, undefined, 3);
    d.resolveClicksNow(0);
    expect(target.health).toBeLessThan(20);
    // A click "aimed" at your teammate is judged against an enemy instead (or nobody).
    const mate = d.fighters[2];
    mate.pos.set(me.pos.x, me.pos.y, me.pos.z - 2.5);
    const hp = mate.health;
    me.attackStrengthTicker = 100;
    d.queueAttack(0, 1e9, undefined, 2);
    d.resolveClicksNow(0);
    expect(mate.health).toBe(hp);
  });

  it('the game ends when a whole team is down', () => {
    const r = teamRoom('sword');
    for (let t = 0; t < 120 && r.duel.phase !== 'fight'; t++) r.tick();
    const d = r.duel;
    d.fighters[1].health = 0;
    d.fighters[1].die();
    r.tick();
    expect(d.phase).toBe('fight');
    d.fighters[3].health = 0;
    d.fighters[3].die();
    r.tick();
    expect(d.phase).toBe('ended');
    expect(d.winner! % 2).toBe(0);
    expect(r.clients[1].winner?.team).toBe(0);
  });

  it('Bed Wars and SkyWars run 2v2 online with the server bots playing the mode', () => {
    for (const kit of ['bedwars', 'skywars'] as KitId[]) {
      const r = teamRoom(kit);
      for (let t = 0; t < 120 && r.duel.phase !== 'fight'; t++) r.tick();
      for (let t = 0; t < 300; t++) r.tick();
      expect(r.clients[0].kit.id).toBe(kit);
      // Teammates spawned side by side, on the same island.
      const [a, , b] = r.duel.fighters;
      expect(Math.sign(a.pos.z)).toBe(Math.sign(b.pos.z));
    }
  });
});

describe('2v2 room', () => {
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
  const last = <T extends ServerMsg['t']>(c: ReturnType<typeof conn>, t: T) => c.got.filter((m) => m.t === t).at(-1) as Extract<ServerMsg, { t: T }> | undefined;

  it('friends join the host’s team, can switch, and the host starts with bots in the empty places', () => {
    vi.useFakeTimers();
    const lobby = new Lobby();
    const host = conn();
    const friend = conn();
    lobby.connect(host);
    lobby.connect(friend);
    host.say({ t: 'join', room: 'TEAM', name: 'Host', v: PROTOCOL_VERSION, kit: 'uhc', squad: { tier: 'lt3' } });
    friend.say({ t: 'join', room: 'TEAM', name: 'Pal', v: PROTOCOL_VERSION });
    let v = last(friend, 'squad')!;
    expect(v.kit).toBe('uhc');
    expect(v.members.map((m) => [m.name, m.team])).toEqual([
      ['Host', 0],
      ['Pal', 0],
    ]);
    // Only the host starts it; a friend can switch sides.
    friend.say({ t: 'go' });
    expect(last(friend, 'start')).toBeUndefined();
    friend.say({ t: 'side', team: 1 });
    expect(last(host, 'squad')!.members[1].team).toBe(1);
    friend.say({ t: 'side', team: 0 });
    host.say({ t: 'go' });
    const hs = last(host, 'start')!;
    const fs = last(friend, 'start')!;
    expect(hs.seats).toBe(4);
    expect([hs.you, fs.you]).toEqual([0, 2]);
    const room = [...lobby.rooms.values()][0];
    expect(room.duel!.isBot(1) && room.duel!.isBot(3)).toBe(true);
    // The bots' moves reach both people.
    vi.advanceTimersByTime(250 * 50);
    expect(host.got.some((m) => m.t === 'mv' && m.i === 1)).toBe(true);
    // Someone leaving mid-game is replaced by a bot; the room goes on.
    friend.onClose?.();
    expect(room.duel!.isBot(2)).toBe(true);
    v = last(host, 'squad')!;
    expect(v.members).toHaveLength(1);
    lobby.closeAll();
    vi.useRealTimers();
  });

  it('a kit without 2v2 falls back to Sword; a fifth person is turned away', () => {
    const lobby = new Lobby();
    const cs = [conn(), conn(), conn(), conn(), conn()];
    for (const c of cs) lobby.connect(c);
    cs[0].say({ t: 'join', room: 'FIVE', name: 'A', v: PROTOCOL_VERSION, kit: 'cart', squad: { tier: 'ht3' } });
    for (const [k, c] of cs.slice(1).entries()) c.say({ t: 'join', room: 'FIVE', name: `P${k}`, v: PROTOCOL_VERSION });
    expect(last(cs[0], 'squad')!.kit).toBe('sword');
    expect(last(cs[0], 'squad')!.members.map((m) => m.team).sort()).toEqual([0, 0, 1, 1]);
    expect(last(cs[4], 'error')).toBeDefined();
    lobby.closeAll();
  });
});
