/**
 * PvP Trainer multiplayer server — Windows, macOS and Linux.
 *
 * Serves the game over HTTP and runs authoritative 1v1 duels over WebSocket. Movement is
 * client-authoritative and combat is server-authoritative, the same split Minecraft uses.
 * The duel runs the very same Fighter/combat code the browser does.
 *
 * Everything (duel simulation + WebSocket implementation) is bundled into one .mjs, so the
 * distributable needs no `npm install` — just Node and a double-click.
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Duel } from '../net/Duel';
import { KITS, type KitId } from '../game/kits';
import { CHAT_MAX, NET_TPS, PROTOCOL_VERSION, normalizeRoom, roomCode, type ClientMsg, type ServerMsg } from '../net/protocol';
import { attachWebSocket, type WsConnection } from './ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4180);
const TICK_MS = 1000 / NET_TPS;
const PING_EVERY = 40; // ticks

/** Packaged next to the server, or the dev build two directories up. */
const GAME_CANDIDATES = [
  path.join(HERE, 'game.html'),
  path.join(HERE, '..', 'dist', 'index.html'),
  path.join(process.cwd(), 'dist', 'index.html'),
];

const rooms = new Map<string, Room>();
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;

class Client {
  room: Room | null = null;
  seat = -1;
  name = 'Player';
  ping = 0;
  pingId = 0;
  private pingSentAt = 0;
  /** Chat flood guard: up to CHAT_BURST lines, refilled at one per CHAT_REFILL_MS. */
  private chatTokens = CHAT_BURST;
  private chatAt = Date.now();

  constructor(readonly ws: WsConnection) {}

  send(msg: ServerMsg) {
    this.ws.send(JSON.stringify(msg));
  }

  sendRaw(text: string) {
    this.ws.send(text);
  }

  startPing() {
    this.pingId++;
    this.pingSentAt = Date.now();
    this.send({ t: 'ping', id: this.pingId });
  }

  /** True if this client may send another chat line now. */
  takeChatToken(): boolean {
    const now = Date.now();
    this.chatTokens = Math.min(CHAT_BURST, this.chatTokens + (now - this.chatAt) / CHAT_REFILL_MS);
    this.chatAt = now;
    if (this.chatTokens < 1) return false;
    this.chatTokens--;
    return true;
  }

  gotPong(id: number) {
    if (id !== this.pingId) return;
    const rtt = Date.now() - this.pingSentAt;
    // Smooth it: one unlucky sample should not swing how far hits get rewound.
    this.ping = this.ping ? Math.round(this.ping * 0.7 + rtt * 0.3) : rtt;
    this.room?.duel?.setPing(this.seat, this.ping);
  }
}

class Room {
  readonly seats: (Client | null)[] = [null, null];
  duel: Duel | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private tick = 0;
  private rematchVotes = new Set<number>();

  /** The kit everyone in the room fights with — chosen by whoever created the room. */
  kit: KitId = 'sword';

  constructor(readonly code: string) {}

  get players(): Client[] {
    return this.seats.filter((s): s is Client => s !== null);
  }

  freeSeat(): number {
    return this.seats.findIndex((s) => s === null);
  }

  broadcast(msg: ServerMsg) {
    const text = JSON.stringify(msg);
    for (const c of this.players) c.sendRaw(text);
  }

  sendLobby() {
    this.broadcast({
      t: 'lobby',
      room: this.code,
      players: this.players.map((c) => ({ i: c.seat, name: c.name })),
      kit: this.kit,
    });
  }

  startIfReady() {
    if (this.players.length !== 2 || this.duel) return;
    const names: [string, string] = [this.seats[0]!.name, this.seats[1]!.name];
    this.duel = new Duel(names, this.kit);
    this.rematchVotes.clear();
    this.broadcast({ t: 'start', countdown: this.duel.countdownSeconds, kit: this.kit });
    this.timer = setInterval(() => this.step(), TICK_MS);
    log(`room ${this.code}: duel started — ${names[0]} vs ${names[1]}`);
  }

  private step() {
    try {
      this.stepDuel();
    } catch (err) {
      // One broken duel must not take every other room down with it.
      log(`room ${this.code}: duel crashed — ${(err as Error)?.stack ?? err}`);
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.duel = null;
      for (const c of this.players) c.send({ t: 'error', message: 'The duel hit an error on the server. Join the room again to play on.' });
    }
  }

  private stepDuel() {
    const duel = this.duel;
    if (!duel) return;
    this.tick++;
    for (const e of duel.tick()) {
      if (e.motion) this.seats[e.motion.to]?.send({ t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      if (e.teleport) this.seats[e.teleport.to]?.send({ t: 'teleport', id: e.teleport.id, x: e.teleport.x, y: e.teleport.y, z: e.teleport.z });
    }
    this.broadcast(duel.stateMessage(this.tick, [this.seats[0]?.ping ?? 0, this.seats[1]?.ping ?? 0]));
    if (this.tick % PING_EVERY === 0) for (const c of this.players) c.startPing();
    if (duel.phase === 'ended' && duel.phaseTicks === 1) {
      this.broadcast({ t: 'end', winner: duel.winner });
      log(`room ${this.code}: duel over — winner ${duel.winner ?? 'draw'}`);
    }
  }

  voteRematch(seat: number) {
    if (!this.duel || this.duel.phase !== 'ended') return;
    this.rematchVotes.add(seat);
    if (this.rematchVotes.size >= 2 && this.players.length === 2) {
      this.rematchVotes.clear();
      this.duel.reset();
      this.broadcast({ t: 'start', countdown: this.duel.countdownSeconds, kit: this.kit });
    }
  }

  leave(client: Client) {
    if (this.seats[client.seat] === client) this.seats[client.seat] = null;
    this.rematchVotes.delete(client.seat);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.duel = null;
    if (this.players.length === 0) {
      rooms.delete(this.code);
      log(`room ${this.code}: closed`);
    } else {
      this.sendLobby();
    }
  }
}

function handle(client: Client, msg: ClientMsg) {
  switch (msg.t) {
    case 'join': {
      if (msg.v !== PROTOCOL_VERSION) {
        client.send({
          t: 'error',
          message: `Version mismatch — the host is running a different build (server v${PROTOCOL_VERSION}, you v${msg.v}). Reload the page.`,
        });
        return;
      }
      if (client.room) return;
      client.name = String(msg.name || 'Player').slice(0, 16) || 'Player';
      let code = normalizeRoom(String(msg.room || ''));
      let room: Room;
      if (code) {
        room = rooms.get(code) ?? new Room(code);
        rooms.set(code, room);
      } else {
        do code = roomCode();
        while (rooms.has(code));
        room = new Room(code);
        rooms.set(code, room);
      }
      // A new room takes the creator's kit; joining an existing room keeps its kit.
      if (room.players.length === 0) {
        const kit = String(msg.kit ?? 'sword');
        room.kit = KITS.some((k) => k.id === kit && k.available) ? (kit as KitId) : 'sword';
      }
      const seat = room.freeSeat();
      if (seat < 0) {
        client.send({ t: 'error', message: `Room ${room.code} is full — it already has two fighters.` });
        return;
      }
      room.seats[seat] = client;
      client.room = room;
      client.seat = seat;
      client.send({ t: 'joined', you: seat, room: room.code });
      room.sendLobby();
      room.startIfReady();
      log(`${client.name} joined room ${room.code} as seat ${seat}`);
      return;
    }
    case 'move':
    case 'attack':
    case 'use':
    case 'mine':
    case 'slot':
    case 'swap':
    case 'inv':
      client.room?.duel?.receive(client.seat, msg);
      return;
    case 'rematch':
      client.room?.voteRematch(client.seat);
      return;
    case 'pong':
      client.gotPong(msg.id);
      return;
    case 'chat': {
      const room = client.room;
      if (!room) return;
      // Printable text only, trimmed to vanilla's limit.
      const text = String(msg.text ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, CHAT_MAX);
      const kind = msg.kind === 'say' || msg.kind === 'me' ? msg.kind : 'chat';
      if (!text) return;
      if (!client.takeChatToken()) {
        client.send({ t: 'chat', kind: 'chat', from: '', text: 'You are sending messages too quickly — wait a moment.' });
        return;
      }
      room.broadcast({ t: 'chat', kind, from: client.name, text });
      return;
    }
    default:
      return;
  }
}

// ---------------------------------------------------------------- http

let gameHtml: Buffer | null = null;
let gamePath = '';
for (const candidate of GAME_CANDIDATES) {
  if (existsSync(candidate)) {
    gamePath = candidate;
    gameHtml = readFileSync(candidate);
    break;
  }
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, version: PROTOCOL_VERSION }));
    return;
  }
  if (!gameHtml) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('game.html is missing next to the server.');
    return;
  }
  // Any path serves the game, so a mistyped URL still lands somewhere useful.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(gameHtml);
});

attachWebSocket(server, '/ws', (ws) => {
  const client = new Client(ws);
  ws.onMessage = (text) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(text) as ClientMsg;
    } catch {
      return;
    }
    if (msg && typeof msg.t === 'string') {
      try {
        handle(client, msg);
      } catch (err) {
        log(`error handling ${msg.t}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  ws.onClose = () => {
    if (client.room) {
      log(`${client.name} left room ${client.room.code}`);
      client.room.leave(client);
      client.room = null;
    }
  };
});

function log(line: string) {
  console.log(`  [${new Date().toTimeString().slice(0, 8)}] ${line}`);
}

/**
 * Every address someone else could actually reach. Carrier-grade NAT (100.64/10 — what a phone
 * hotspot or a school's cellular uplink hands out) and link-local addresses are not routable
 * from another machine, so they are listed as a warning rather than offered as the answer.
 */
function addresses() {
  const usable: { iface: string; address: string }[] = [];
  const local: { iface: string; address: string; why: string }[] = [];
  const unusable: { iface: string; address: string; why: string }[] = [];
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [p, q] = a.address.split('.').map(Number);
      if (p === 100 && q >= 64 && q <= 127) {
        unusable.push({ iface, address: a.address, why: 'carrier NAT' });
      } else if (p === 169 && q === 254) {
        unusable.push({ iface, address: a.address, why: 'link-local' });
      } else if (/^(bridge|utun|ap\d|awdl|llw)/.test(iface)) {
        // A bridge is Thunderbolt Bridge or macOS Internet Sharing: it has an address even
        // with nothing plugged into it, and Node cannot see link status. Only a machine
        // cabled to this one, or joined to its shared network, can use it.
        local.push({ iface, address: a.address, why: iface.startsWith('bridge') ? 'only for devices connected directly to this machine' : 'virtual interface' });
      } else {
        usable.push({ iface, address: a.address });
      }
    }
  }
  // Ordinary home/office LANs first — those are the ones that normally work.
  usable.sort((x, y) => Number(y.address.startsWith('192.168.')) - Number(x.address.startsWith('192.168.')));
  return { usable, local, unusable };
}

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log(`  Port ${PORT} is already in use — another copy of the server is probably running.`);
    console.log(`  Close it, or start this one on another port:  PORT=4181 node server.mjs`);
    console.log('');
  } else {
    console.log(`  Server error: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const { usable, local, unusable } = addresses();
  console.log('');
  console.log('  ========================================');
  console.log('   PvP Trainer - multiplayer server is up');
  console.log('  ========================================');
  console.log('');
  console.log(`  You (the host) play here:   http://localhost:${PORT}`);
  console.log('  Hosting does NOT stop you playing - open that link and join like anyone else.');
  console.log('');
  if (usable.length) {
    console.log('');
    console.log('  Everyone else on your network opens ONE of these in a browser:');
    for (const a of usable) console.log(`      http://${a.address}:${PORT}      (${a.iface})`);
    console.log('');
    console.log('  Friends with the PvP Trainer app (Windows or Mac) instead type the address');
    console.log(`  in Multiplayer -> Server, e.g.  ${usable[0].address}${PORT === 4180 ? '' : `:${PORT}`}`);
  } else {
    console.log('');
    console.log('  NOBODY ELSE CAN REACH THIS MACHINE.');
    console.log('  There is no ordinary network address here - you are not on the same Wi-Fi or');
    console.log('  Ethernet as anyone else. Either join their network and restart this, or let');
    console.log('  one of them host instead. To play across different networks, put every');
    console.log('  machine on Tailscale (https://tailscale.com) and use the host\'s Tailscale IP.');
  }
  if (local.length) {
    console.log('');
    console.log('  Probably not useful:');
    for (const a of local) console.log(`      http://${a.address}:${PORT}   (${a.iface} - ${a.why})`);
  }
  if (unusable.length) {
    console.log('');
    console.log('  Not shareable (other machines cannot route to these):');
    for (const a of unusable) console.log(`      ${a.address}  (${a.iface}, ${a.why})`);
  }
  if (!gameHtml) {
    console.log('');
    console.log('  !! game.html was not found next to this server, so the page will not load.');
  } else if (process.env.PVP_VERBOSE) {
    console.log(`  serving ${gamePath}`);
  }
  console.log('');
  console.log('  In the game: Multiplayer -> Host a new room, then read out the 4-letter code.');
  console.log('  Press Ctrl+C (or close this window) to stop.');
  console.log('');
  if (!process.env.PVP_NO_OPEN) openBrowser(`http://localhost:${PORT}`);
});

/** Opens the host's own browser so they never have to type the address themselves. */
function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    // A missing opener (no xdg-open on a bare Linux box) arrives as an async 'error' event —
    // unhandled, it would take the whole server down right after it started.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser to open; the address is printed above anyway */
  }
}
