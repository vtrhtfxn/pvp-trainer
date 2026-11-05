import { describe, expect, it } from 'vitest';
import { Duel } from '../src/net/Duel';
import { NetMatch } from '../src/net/NetMatch';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';

class FakeNet {
  connected = true;
  out: ClientMsg[] = [];
  send(m: ClientMsg) {
    this.out.push(JSON.parse(JSON.stringify(m)) as ClientMsg);
  }
}

describe('watching an online game (tournament spectators)', () => {
  it('follows both fighters from the server and never sends anything', () => {
    const duel = new Duel(['Ann', 'Bob'], 'sword');
    const nets = [new FakeNet(), new FakeNet()];
    const players = [0, 1].map((i) => new NetMatch(nets[i] as never, i, 'sword'));
    const watchNet = new FakeNet();
    const watcher = new NetMatch(watchNet as never, -1, 'sword');
    expect(watcher.spectator).toBe(true);
    let now = 0;
    duel.clock = () => now;
    for (const c of [...players, watcher]) c.clock = () => now;
    const all = (m: ServerMsg) => {
      for (const c of [...players, watcher]) c.handle(JSON.parse(JSON.stringify(m)) as ServerMsg);
    };
    all({ t: 'start', countdown: 3, kit: 'sword' });
    const spawn = players[0].player.pos.clone();
    let n = 0;
    for (let t = 0; t < 200; t++) {
      now += 50;
      if (duel.phase === 'fight') {
        // Ann walks forward.
        players[0].player.input = { forward: 1, strafe: 0, jump: false, sneak: false, sprint: false };
      }
      for (let i = 0; i < 2; i++) {
        players[i].tick();
        for (const m of nets[i].out) {
          const relay = duel.receive(i, m);
          if (relay && relay.t === 'mv') {
            players[1 - i].handle(JSON.parse(JSON.stringify(relay)) as ServerMsg);
            // The server tags each move with its seat for watchers.
            watcher.handle(JSON.parse(JSON.stringify({ ...relay, i })) as ServerMsg);
          }
        }
        nets[i].out.length = 0;
      }
      duel.tick();
      all(duel.stateMessage(++n, [0, 0]));
      watcher.tick();
    }
    expect(duel.phase).toBe('fight');
    expect(watchNet.out).toHaveLength(0);
    expect(watcher.player.name).toBe('Ann');
    expect(watcher.bot.name).toBe('Bob');
    // Ann's walk shows up on the watcher's screen (played back a little behind).
    const ann = players[0].player.pos;
    expect(Math.hypot(ann.x - spawn.x, ann.z - spawn.z)).toBeGreaterThan(3);
    const seen = watcher.player.pos;
    expect(Math.hypot(seen.x - ann.x, seen.z - ann.z)).toBeLessThan(2);
    expect(Math.hypot(seen.x - duel.fighters[0].pos.x, seen.z - duel.fighters[0].pos.z)).toBeLessThan(2);
    expect(watcher.player.health).toBe(duel.fighters[0].health);
  });
});
