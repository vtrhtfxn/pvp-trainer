/**
 * The rooms and duels of a multiplayer server, independent of how players connect: the Node
 * server feeds it WebSocket connections, and a player hosting from inside the game (online play
 * over the internet) feeds it WebRTC data channels. Nothing here touches Node or the DOM.
 */

import { Duel } from '../net/Duel';
import { KITS, type KitId } from '../game/kits';
import { CHAT_MAX, NET_TPS, PROTOCOL_VERSION, cleanChat, cleanName, normalizeRoom, roomCode, type ClientMsg, type ServerMsg } from '../net/protocol';

/** One player's connection: text messages both ways. */
export interface Conn {
  send(text: string): void;
  close(code?: number): void;
  onMessage: ((text: string) => void) | null;
  onClose: (() => void) | null;
  /**
   * The network round trip as the connection itself measures it, ms (WebRTC does, from its own
   * keep-alives), or null. Shown as the player's ping: unlike the ping/pong the lobby measures,
   * it does not include waiting for either game to finish drawing a frame.
   */
  rtt?(): number | null;
}

const TICK_MS = 1000 / NET_TPS;
const PING_EVERY = 40; // ticks
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 1500;
/** Messages a client may send per second (moves and clicks run at ~20–40); the rest are dropped. */
const MSG_RATE = 150;
const MSG_BURST = 300;

export class LobbyClient {
  room: Room | null = null;
  seat = -1;
  name = 'Player';
  ping = 0;
  pingId = 0;
  private pingSentAt = 0;
  /** Chat flood guard: up to CHAT_BURST lines, refilled at one per CHAT_REFILL_MS. */
  private chatTokens = CHAT_BURST;
  private chatAt = Date.now();
  /** Message flood guard (every message type). */
  private msgTokens = MSG_BURST;
  private msgAt = Date.now();

  constructor(readonly ws: Conn) {}

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

  /** True if this client may send another message now. */
  takeMsgToken(): boolean {
    const now = Date.now();
    this.msgTokens = Math.min(MSG_BURST, this.msgTokens + ((now - this.msgAt) / 1000) * MSG_RATE);
    this.msgAt = now;
    if (this.msgTokens < 1) return false;
    this.msgTokens--;
    return true;
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

  /** The ping shown to players: the connection's own network round trip when it has one. */
  get shownPing(): number {
    const r = this.ws.rtt?.();
    return r === null || r === undefined ? this.ping : r;
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
  constructor(
    readonly code: string,
    private readonly lobby: Lobby,
  ) {}

  readonly seats: (LobbyClient | null)[] = [null, null];
  duel: Duel | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tick = 0;
  private rematchVotes = new Set<number>();

  /** The kit everyone in the room fights with — chosen by whoever created the room. */
  kit: KitId = 'sword';


  get players(): LobbyClient[] {
    return this.seats.filter((s): s is LobbyClient => s !== null);
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
    this.startClock();
    this.lobby.log(`room ${this.code}: duel started — ${names[0]} vs ${names[1]}`);
  }

  /**
   * Ticks on a fixed schedule. setInterval re-arms from whenever its callback ran, so every late
   * tick (a busy or throttled host) pushed all later ones back and the lost time was never made
   * up — the game ran slow and in lurches. This keeps to the schedule and catches up a few
   * missed ticks at once; after a long stall it resets instead of fast-forwarding.
   */
  private startClock() {
    this.stopClock();
    let due = performance.now() + TICK_MS;
    let warned = 0;
    const run = () => {
      const now = performance.now();
      let n = 0;
      while (now >= due && n < 4) {
        this.step();
        if (!this.duel) return;
        due += TICK_MS;
        n++;
      }
      if (now - due > TICK_MS * 4) {
        if (now - warned > 60_000) {
          warned = now;
          this.lobby.log(`room ${this.code}: the server fell ${Math.round(now - due)} ms behind — is this computer busy, asleep or on low power?`);
        }
        due = now + TICK_MS;
      }
      this.timer = setTimeout(run, Math.max(0, due - performance.now()));
    };
    this.timer = setTimeout(run, TICK_MS);
  }

  private stopClock() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private step() {
    try {
      this.stepDuel();
    } catch (err) {
      // One broken duel must not take every other room down with it.
      this.lobby.log(`room ${this.code}: duel crashed — ${(err as Error)?.stack ?? err}`);
      this.stopClock();
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
      if (e.teleport) this.seats[e.teleport.to]?.send({ t: 'teleport', id: e.teleport.id, x: e.teleport.x, y: e.teleport.y, z: e.teleport.z, yaw: e.teleport.yaw });
    }
    this.broadcast(duel.stateMessage(this.tick, [this.seats[0]?.shownPing ?? 0, this.seats[1]?.shownPing ?? 0]));
    // Bed Wars / SkyWars: scoreboards, announcements, chest contents, shop answers.
    for (const { to, msg } of duel.takeOutbox()) {
      if (to < 0) this.broadcast(msg);
      else this.seats[to]?.send(msg);
    }
    if (this.tick % PING_EVERY === 0) for (const c of this.players) c.startPing();
    if (duel.phase === 'ended' && duel.phaseTicks === 1) {
      this.broadcast({ t: 'end', winner: duel.winner });
      this.lobby.log(`room ${this.code}: duel over — winner ${duel.winner ?? 'draw'}`);
    }
  }

  resolveNow(seat: number) {
    const duel = this.duel;
    if (!duel) return;
    try {
      const { hit, events } = duel.resolveClicksNow(seat);
      if (!hit) return;
      for (const e of events) if (e.motion) this.seats[e.motion.to]?.send({ t: 'motion', vx: e.motion.vx, vy: e.motion.vy, vz: e.motion.vz });
      this.broadcast(duel.stateMessage(this.tick, [this.seats[0]?.shownPing ?? 0, this.seats[1]?.shownPing ?? 0]));
    } catch (err) {
      this.lobby.log(`room ${this.code}: swing failed — ${(err as Error)?.stack ?? err}`);
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

  leave(client: LobbyClient) {
    if (this.seats[client.seat] === client) this.seats[client.seat] = null;
    this.rematchVotes.delete(client.seat);
    this.stopClock();
    this.duel = null;
    if (this.players.length === 0) {
      this.lobby.rooms.delete(this.code);
      this.lobby.log(`room ${this.code}: closed`);
    } else {
      this.sendLobby();
    }
  }
}


export interface LobbyOptions {
  /** Connections and rooms one server takes: plenty for a LAN, and a cap on what a flood can use. */
  maxClients?: number;
  maxRooms?: number;
  log?: (line: string) => void;
}

export class Lobby {
  readonly rooms = new Map<string, Room>();
  readonly clients = new Set<LobbyClient>();
  readonly log: (line: string) => void;
  private readonly maxClients: number;
  private readonly maxRooms: number;

  constructor(opts: LobbyOptions = {}) {
    this.maxClients = opts.maxClients ?? 64;
    this.maxRooms = opts.maxRooms ?? 32;
    this.log = opts.log ?? (() => {});
  }

  /** A new player connection: it joins a room with its first message. */
  connect(ws: Conn) {
    if (this.clients.size >= this.maxClients) {
      ws.send(JSON.stringify({ t: 'error', message: 'This server is full right now. Try again in a minute.' } satisfies ServerMsg));
      ws.close(1013);
      return;
    }
    const client = new LobbyClient(ws);
    this.clients.add(client);
    ws.onMessage = (text) => {
      if (!client.takeMsgToken()) return;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(text) as ClientMsg;
      } catch {
        return;
      }
      if (msg && typeof msg === 'object' && typeof msg.t === 'string') {
        try {
          this.handle(client, msg);
        } catch (err) {
          this.log(`error handling ${msg.t}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    ws.onClose = () => {
      this.clients.delete(client);
      if (client.room) {
        this.log(`${client.name} left room ${client.room.code}`);
        client.room.leave(client);
        client.room = null;
      }
    };
  }

  /** Ends every duel and drops every connection (the host stopped hosting). */
  closeAll() {
    for (const c of [...this.clients]) {
      c.ws.onClose?.();
      c.ws.close();
    }
  }

  private handle(client: LobbyClient, msg: ClientMsg) {
    switch (msg.t) {
      case 'join': {
        if (msg.v !== PROTOCOL_VERSION) {
          const theirs = Number(msg.v);
          client.send({
            t: 'error',
            message: `Version mismatch — the host is running a different build (server v${PROTOCOL_VERSION}, you v${Number.isFinite(theirs) ? theirs : '?'}). Reload the page.`,
          });
          return;
        }
        if (client.room) return;
        client.name = cleanName(msg.name);
        let code = normalizeRoom(String(msg.room || ''));
        let room: Room;
        const existing = code ? this.rooms.get(code) : undefined;
        if (!existing && this.rooms.size >= this.maxRooms) {
          client.send({ t: 'error', message: 'This server has too many rooms open right now. Try again in a minute.' });
          return;
        }
        if (existing) {
          room = existing;
        } else if (code) {
          room = new Room(code, this);
          this.rooms.set(code, room);
        } else {
          do code = roomCode();
          while (this.rooms.has(code));
          room = new Room(code, this);
          this.rooms.set(code, room);
        }
        // A new room takes the creator's kit; joining an existing room keeps its kit.
        if (room.players.length === 0) {
          const kit = String(msg.kit ?? 'sword');
          room.kit = KITS.some((k) => k.id === kit && k.available) ? (kit as KitId) : 'sword';
        }
        const seat = room.freeSeat();
        if (seat < 0) {
          client.send({ t: 'error', message: `Room ${room.code} is full — it already has two fighters.` });
          if (room.players.length === 0) this.rooms.delete(room.code);
          return;
        }
        room.seats[seat] = client;
        client.room = room;
        client.seat = seat;
        client.send({ t: 'joined', you: seat, room: room.code });
        room.sendLobby();
        room.startIfReady();
        this.log(`${client.name} joined room ${room.code} as seat ${seat}`);
        return;
      }
      case 'move':
      case 'attack':
      case 'use':
      case 'mine':
      case 'slot':
      case 'swap':
      case 'inv':
      case 'buy':
      case 'chest': {
        const room = client.room;
        const relay = room?.duel?.receive(client.seat, msg);
        // Moves go straight on to the opponent: waiting for the next tick would re-time them to
        // the server's clock, which is what made fighters stutter and jump on each other's screens.
        if (relay && room) room.seats[1 - client.seat]?.send(relay);
        // A swing is resolved as it arrives and both players get the result at once, rather
        // than up to a tick (50 ms) later.
        if (msg.t === 'attack' && room) room.resolveNow(client.seat);
        return;
      }
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
        const text = cleanChat(msg.text, CHAT_MAX);
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
}
