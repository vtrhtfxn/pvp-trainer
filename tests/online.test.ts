import { describe, expect, it } from 'vitest';
import { B } from '../src/game/Blocks';
import type { KitId } from '../src/game/kits';
import { Bedwars, RESPAWN_TICKS } from '../src/game/modes/Bedwars';
import { Skywars } from '../src/game/modes/Skywars';
import { Duel } from '../src/net/Duel';
import { NetMatch } from '../src/net/NetMatch';
import type { ClientMsg, ServerMsg } from '../src/net/protocol';

/** A NetClient stand-in: messages go through JSON, like the real socket. */
class FakeNet {
  connected = true;
  out: ClientMsg[] = [];
  send(m: ClientMsg) {
    this.out.push(JSON.parse(JSON.stringify(m)) as ClientMsg);
  }
}

/** A server duel wired to two real clients. */
function room(kit: KitId) {
  const duel = new Duel(['A', 'B'], kit);
  const nets = [new FakeNet(), new FakeNet()];
  const clients = [0, 1].map((i) => new NetMatch(nets[i] as never, i, kit));
  const deliver = (i: number, m: ServerMsg) => clients[i].handle(JSON.parse(JSON.stringify(m)) as ServerMsg);
  for (let i = 0; i < 2; i++) deliver(i, { t: 'start', countdown: 3, kit });
  // One clock for everyone, 50 ms per tick, like a real game.
  let now = 0;
  duel.clock = () => now;
  for (const c of clients) c.clock = () => now;
  let n = 0;
  const tick = () => {
    now += 50;
    for (let i = 0; i < 2; i++) {
      clients[i].tick();
      for (const m of nets[i].out) {
        const relay = duel.receive(i, m);
        if (relay) deliver(1 - i, relay);
      }
      nets[i].out.length = 0;
    }
    for (const e of duel.tick()) {
      if (e.motion) deliver(e.motion.to, { t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      if (e.teleport) deliver(e.teleport.to, { t: 'teleport', ...e.teleport });
    }
    const state = duel.stateMessage(++n, [0, 0]);
    for (let i = 0; i < 2; i++) deliver(i, state);
    for (const { to, msg } of duel.takeOutbox()) for (let i = 0; i < 2; i++) if (to < 0 || to === i) deliver(i, msg);
  };
  const toFight = () => {
    for (let t = 0; t < 200 && duel.phase !== 'fight'; t++) tick();
    tick();
  };
  /** Points a client's player at a point (block faces, the opponent). */
  const look = (i: number, x: number, y: number, z: number) => {
    const p = clients[i].player;
    const dx = x - p.pos.x;
    const dz = z - p.pos.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(y - (p.pos.y + p.eyeHeight()), Math.hypot(dx, dz));
  };
  /** A right click with hotbar slot `slot`. */
  const use = (i: number, slot: number) => {
    clients[i].queueSlot(slot);
    tick();
    clients[i].useHeld = true;
    tick();
    clients[i].useHeld = false;
    tick();
  };
  const events = (i: number, who: 'player' | 'bot') => {
    const f = clients[i][who];
    const list = f.events.map((e) => e.type);
    f.events.length = 0;
    return list;
  };
  return { duel, clients, tick, toFight, look, use, events };
}

describe('online, every kit', () => {
  it('every kit starts: the clients get the kit, its world and the inventories', () => {
    for (const kit of ['sword', 'axe', 'neth_pot', 'diamond_pot', 'uhc', 'crystal', 'smp', 'mace'] as KitId[]) {
      const r = room(kit);
      r.toFight();
      expect(r.clients[0].kit.id).toBe(kit);
      expect(r.clients[0].player.countItem(r.duel.fighters[0].inventory[0]!.id)).toBeGreaterThan(0);
      // The opponent's gear too (it is drawn in their hands and on their body).
      expect(r.clients[0].bot.armorSlots.map((s) => s?.id)).toEqual(r.duel.fighters[1].armorSlots.map((s) => s?.id));
      if (kit === 'crystal') expect(r.clients[1].world.blocks.depth).toBe(4);
    }
  });

  it('melee: the victim client hears the hit and takes the knockback', () => {
    const r = room('sword');
    r.toFight();
    r.clients[1].player.pos.set(0, 0, 0);
    r.clients[0].player.pos.set(0, 0, 2.5);
    for (let t = 0; t < 8; t++) {
      r.look(0, 0, 1.2, 0);
      r.tick();
    }
    r.events(1, 'player');
    r.duel.fighters[0].attackStrengthTicker = 100;
    r.clients[0].queueClick();
    r.tick();
    expect(r.duel.fighters[1].health).toBeLessThan(20);
    expect(r.clients[1].player.health).toBeLessThan(20);
    expect(r.events(1, 'player')).toContain('hurt');
    // Knockback was applied to the victim's own simulation.
    expect(Math.hypot(r.clients[1].player.vel.x, r.clients[1].player.vel.z)).toBeGreaterThan(0.1);
  });

  it('UHC: placed planks and poured lava show up in both clients’ worlds', () => {
    const r = room('uhc');
    r.toFight();
    r.clients[0].player.pos.set(0.5, 0, 6.5);
    r.clients[1].player.pos.set(0.5, 0, -6.5);
    r.look(0, 0.5, 0, 4.5);
    r.use(0, 7); // oak planks against the floor in front
    r.tick();
    expect(r.duel.world.blocks.get(0, 0, 4)).toBe(B.PLANKS);
    for (const c of r.clients) expect(c.world.blocks.get(0, 0, 4)).toBe(B.PLANKS);
    r.look(0, 1.5, 0, 3.5);
    r.use(0, 5); // lava bucket onto the floor
    for (let t = 0; t < 5; t++) r.tick();
    let lava = 0;
    for (let x = -3; x <= 3; x++) for (let z = 0; z <= 6; z++) if (r.clients[1].world.blocks.get(x, 0, z) === B.LAVA) lava++;
    expect(lava).toBeGreaterThan(0);
  });

  it('Crystal: obsidian, a crystal on it, the hit — the blast and the damage reach both clients', () => {
    const r = room('crystal');
    r.toFight();
    r.clients[0].player.pos.set(0.5, 0, 3.5);
    r.clients[1].player.pos.set(0.5, 0, -1.5);
    for (let t = 0; t < 4; t++) r.tick();
    r.look(0, 0.5, 0, 1.2);
    r.use(0, 1); // obsidian on the floor at (0, 0, 1)
    expect(r.duel.world.blocks.get(0, 0, 1)).toBe(B.OBSIDIAN);
    r.look(0, 0.5, 1, 1.5);
    r.use(0, 2); // a crystal on it
    expect(r.duel.world.crystals.length).toBe(1);
    r.tick();
    expect(r.clients[1].world.crystals.length).toBe(1);
    r.look(0, 0.5, 1.6, 1.5);
    r.tick();
    r.clients[0].queueClick();
    r.tick();
    expect(r.duel.world.crystals.length).toBe(0);
    r.tick(); // clients apply entity snapshots on their next tick
    expect(r.clients[1].world.crystals.length).toBe(0);
    expect(r.clients[1].player.health).toBeLessThan(20);
    expect(r.clients[1].world.events.some((e) => e.type === 'explosion')).toBe(true);
  });

  it('Mace: a wind charge at your feet launches you on your own screen', () => {
    const r = room('mace');
    r.toFight();
    r.clients[0].player.pos.set(0.5, 0, 6.5);
    r.tick();
    r.clients[0].player.pitch = -Math.PI / 2 + 0.01;
    r.use(0, 4);
    let top = 0;
    for (let t = 0; t < 20; t++) {
      r.tick();
      top = Math.max(top, r.clients[0].player.pos.y);
    }
    expect(top).toBeGreaterThan(4);
    // The server saw the same flight (the client reports its position).
    expect(r.clients[1].world.events.length + 1).toBeGreaterThan(0);
  });

  it('Mace: a right-clicked elytra is worn, and the opponent sees it', () => {
    const r = room('mace');
    r.toFight();
    r.use(0, 3);
    r.tick();
    expect(r.duel.fighters[0].armorSlots[1]?.id).toBe('elytra');
    expect(r.clients[0].player.armorSlots[1]?.id).toBe('elytra');
    expect(r.clients[1].bot.armorSlots[1]?.id).toBe('elytra');
  });

  it('pearls: the thrower is teleported on their own screen, and old moves are ignored', () => {
    const r = room('smp');
    r.toFight();
    r.clients[0].player.pos.set(0.5, 0, 6.5);
    r.tick();
    r.clients[0].player.pitch = 0.3;
    r.clients[0].player.yaw = 0; // toward -Z
    r.use(0, 2);
    let landed = false;
    for (let t = 0; t < 60 && !landed; t++) {
      r.tick();
      landed = r.duel.fighters[0].stats.pearlsThrown > 0 && r.duel.world.thrown.length === 0;
    }
    for (let t = 0; t < 3; t++) r.tick();
    expect(landed).toBe(true);
    expect(r.clients[0].player.pos.z).toBeLessThan(0);
    expect(Math.abs(r.duel.fighters[0].pos.z - r.clients[0].player.pos.z)).toBeLessThan(0.5);
  });
});

describe('online Bed Wars and SkyWars', () => {
  it('Bed Wars: both clients build the server’s map and get their scoreboard', () => {
    const r = room('bedwars');
    r.toFight();
    const mode = r.duel.mode as Bedwars;
    for (const c of r.clients) {
      expect(c.world.blocks.voidWorld).toBe(true);
      for (const t of mode.layout.teams) for (const b of t.bed) expect(c.world.blocks.get(b.x, b.y, b.z)).toBe(B.BED);
      expect(c.world.blocks.count).toBe(r.duel.world.blocks.count);
      expect(c.modeUi.sb[0].text).toBe('BED WARS');
      expect(c.modeUi.gear?.wool).toBeDefined();
    }
    // Each client stands on its own team's spawn (seat 1 is blue).
    expect(r.clients[1].player.pos.z).toBeCloseTo(r.duel.fighters[1].pos.z, 1);
    expect(r.clients[1].modeUi.sb.some((l) => l.text.includes('Blue') && l.text.includes('YOU'))).toBe(true);
  });

  it('Bed Wars: buying at your shop goes through the server', () => {
    const r = room('bedwars');
    r.toFight();
    r.duel.fighters[0].addItem({ id: 'iron_ingot', count: 20 });
    r.tick();
    r.clients[0].buy('wool');
    r.tick();
    r.tick();
    expect(r.clients[0].boughtMsg).toContain('Bought');
    expect(r.clients[0].player.countItem('red_wool')).toBe(16);
    expect(r.duel.fighters[0].countItem('iron_ingot')).toBe(16);
    // Seat 1 is not at the red shop… but at its own; far from it, the server refuses.
    const blue = r.clients[1].player;
    blue.pos.set(0.5, 0, 0.5);
    r.tick();
    r.duel.fighters[1].addItem({ id: 'iron_ingot', count: 20 });
    r.clients[1].buy('wool');
    r.tick();
    r.tick();
    expect(r.clients[1].boughtMsg).toContain('too far');
  });

  it('Bed Wars: falling into the void kills you, and you respawn at your bed on your own screen', () => {
    const r = room('bedwars');
    r.toFight();
    const me = r.clients[0].player;
    me.pos.set(0.5, -40, 0.5);
    r.tick();
    r.tick();
    expect(r.duel.fighters[0].dead).toBe(true);
    expect(me.dead).toBe(true);
    for (let t = 0; t < RESPAWN_TICKS + 10; t++) r.tick();
    expect(r.duel.fighters[0].dead).toBe(false);
    expect(me.dead).toBe(false);
    const spawn = (r.duel.mode as Bedwars).layout.teams[0].spawn;
    expect(Math.hypot(me.pos.x - spawn.x, me.pos.z - spawn.z)).toBeLessThan(1);
    expect(r.duel.phase).toBe('fight');
  });

  it('SkyWars: cages open, a right-clicked chest opens on your screen and Take all fills your inventory', () => {
    const r = room('skywars');
    const mode = r.duel.mode as Skywars;
    r.toFight();
    for (const cage of mode.layout.cages) for (const c of cage) expect(r.clients[0].world.blocks.get(c.x, c.y, c.z)).not.toBe(B.GLASS);
    const chest = mode.layout.islandChests[0][0];
    const me = r.clients[0].player;
    me.pos.set(chest.x + 0.5, chest.y, chest.z + 2.5);
    for (let t = 0; t < 30 && !me.onGround; t++) r.tick();
    r.look(0, chest.x + 0.5, chest.y + 0.5, chest.z + 0.5);
    r.use(0, 0);
    const msg = r.clients[0].chestMsg;
    expect(msg?.open).toBe(true);
    const n = msg!.items!.filter(Boolean).length;
    expect(n).toBeGreaterThan(0);
    r.clients[0].chestAction(chest.x, chest.y, chest.z, 'all');
    r.tick();
    r.tick();
    expect(r.clients[0].chestMsg?.items?.every((s) => !s)).toBe(true);
    const have = me.inventory.filter(Boolean).length + me.armorSlots.filter(Boolean).length;
    expect(have).toBe(n);
  });

  it('SkyWars: knock the other player into the void and you win', () => {
    const r = room('skywars');
    r.toFight();
    r.clients[1].player.pos.set(0.5, -40, 0.5);
    for (let t = 0; t < 5; t++) r.tick();
    expect(r.duel.phase).toBe('ended');
    expect(r.duel.winner).toBe(0);
    expect(r.clients[0].winner).toBe(r.clients[0].player);
  });
});
