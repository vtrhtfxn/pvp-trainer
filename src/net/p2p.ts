import { Peer, type DataConnection, type PeerOptions } from 'peerjs';
import { Lobby, type Conn } from '../server/lobby';
import type { SocketLike } from './Client';

/**
 * Online play over the internet, with no server to run: whoever hosts runs the game's server
 * (the same Lobby the Node server uses) inside their own game, and their friend connects to it
 * directly over WebRTC — which gets through ordinary home routers (NAT) with the help of public
 * STUN servers. A free signalling service (PeerJS's public server) only introduces the two
 * games to each other; the duel itself goes straight between them.
 *
 * The host's friend finds them by a short code: the host registers as PEER_PREFIX + code.
 */

const PEER_PREFIX = 'pvp-trainer-duel-';
/** No vowels (no accidental words), no look-alikes. 28^5 ≈ 17 million codes. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
export const ONLINE_CODE_LENGTH = 5;

const ICE: RTCConfiguration = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

/** Where the signalling server is (tests point this at a local one). */
let signalling: Partial<PeerOptions> = {};
export function setSignalling(opts: Partial<PeerOptions>) {
  signalling = opts;
}

function peerOptions(): PeerOptions {
  return { config: ICE, debug: 0, ...signalling };
}

export function onlineCode(rng: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < ONLINE_CODE_LENGTH; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return s;
}

export function normalizeOnlineCode(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

const NO_DIRECT =
  'Could not connect directly to your friend. Some networks block direct connections (strict school or office Wi-Fi, some mobile hotspots). Try the other person hosting, or another network.';

/** A dropped "disconnected" ICE state often comes back; give it this long before giving up. */
const ICE_GRACE_MS = 6000;

/** Watches a data channel's connection; calls `lost` once if it fails for good. */
function watchIce(c: DataConnection, lost: () => void) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  c.on('iceStateChanged', (state) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (state === 'failed' || state === 'closed') lost();
    else if (state === 'disconnected') timer = setTimeout(lost, ICE_GRACE_MS);
  });
}

/** A data channel as the Lobby sees a player. */
function channelConn(c: DataConnection): Conn {
  let closed = false;
  const conn: Conn = {
    send(text) {
      if (!closed && c.open) {
        try {
          void c.send(text);
        } catch {
          /* closing */
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      c.close();
    },
    onMessage: null,
    onClose: null,
    rtt: () => rtt,
  };
  // The network round trip, from WebRTC's own connectivity checks (once a second).
  let rtt: number | null = null;
  const poll = setInterval(() => {
    const pc = c.peerConnection;
    if (closed || !pc) return;
    pc.getStats()
      .then((stats) => {
        let sel: string | null = null;
        stats.forEach((s) => {
          if (s.type === 'transport' && s.selectedCandidatePairId) sel = s.selectedCandidatePairId;
        });
        stats.forEach((s) => {
          if (s.type === 'candidate-pair' && (s.id === sel || (!sel && s.nominated)) && typeof s.currentRoundTripTime === 'number') {
            rtt = Math.round(s.currentRoundTripTime * 1000);
          }
        });
      })
      .catch(() => {});
  }, 1000);
  const finish = () => {
    clearInterval(poll);
    if (closed && !conn.onClose) return;
    closed = true;
    const cb = conn.onClose;
    conn.onClose = null;
    cb?.();
  };
  c.on('data', (d) => {
    if (typeof d === 'string') conn.onMessage?.(d);
  });
  c.on('close', finish);
  c.on('error', finish);
  watchIce(c, () => {
    finish();
    c.close();
  });
  return conn;
}

/**
 * The host's own client talks to the Lobby in its page through this pipe. Messages are
 * delivered on a microtask, like a network would deliver them later, so nothing re-enters.
 */
function loopback(onClosed: () => void): { client: SocketLike; server: Conn } {
  let open = true;
  const client: SocketLike = {
    readyState: 0,
    send(text) {
      if (open) queueMicrotask(() => open && server.onMessage?.(text));
    },
    close() {
      if (!open) return;
      open = false;
      (client as { readyState: number }).readyState = 3;
      server.onClose?.();
      onClosed();
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const server: Conn = {
    send(text) {
      if (open) queueMicrotask(() => open && client.onmessage?.({ data: text }));
    },
    close() {
      client.close();
    },
    onMessage: null,
    onClose: null,
  };
  queueMicrotask(() => {
    if (!open) return;
    (client as { readyState: number }).readyState = 1;
    client.onopen?.();
  });
  return { client, server };
}

/** Hosting an online game: a Lobby in this page, reachable as PEER_PREFIX + code. */
export class OnlineHost {
  readonly lobby = new Lobby({ maxClients: 4, maxRooms: 1 });
  private destroyed = false;

  private constructor(
    readonly code: string,
    private readonly peer: Peer,
  ) {
    peer.on('connection', (c) => {
      if (this.destroyed) {
        c.close();
        return;
      }
      // PeerJS can report 'open' more than once for one channel: one player, one seat.
      let joined = false;
      c.on('open', () => {
        if (joined || this.destroyed) return;
        joined = true;
        this.lobby.connect(channelConn(c));
      });
    });
    // Losing the signalling server keeps running duels going; reconnect so friends can still join.
    peer.on('disconnected', () => {
      if (!this.destroyed) setTimeout(() => !this.destroyed && !peer.destroyed && peer.reconnect(), 2000);
    });
  }

  /** Registers a free code with the signalling server (a taken one is retried with another). */
  static start(timeoutMs = 15000): Promise<OnlineHost> {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        tries++;
        const code = onlineCode();
        const peer = new Peer(PEER_PREFIX + code, peerOptions());
        const timer = setTimeout(() => {
          peer.destroy();
          reject(new Error('The matchmaking service did not answer. Check your internet connection and try again.'));
        }, timeoutMs);
        peer.on('open', () => {
          clearTimeout(timer);
          resolve(new OnlineHost(code, peer));
        });
        peer.on('error', (e) => {
          if (peer.open) return; // errors about a single connection, once hosting
          clearTimeout(timer);
          peer.destroy();
          if (e.type === 'unavailable-id' && tries < 5) attempt();
          else if (e.type === 'browser-incompatible') reject(new Error('This browser cannot make direct connections (WebRTC). Use the PvP Trainer app, Chrome, Edge or Firefox.'));
          else reject(new Error('Could not reach the matchmaking service. Check your internet connection and try again.'));
        });
      };
      attempt();
    });
  }

  /** The host's own connection to the game it hosts. Closing it stops hosting. */
  localSocket(): SocketLike {
    const { client, server } = loopback(() => this.destroy());
    this.lobby.connect(server);
    return client;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lobby.closeAll();
    this.peer.destroy();
  }
}

/** Joining a friend's online game by its code: a SocketLike over a WebRTC data channel. */
export function joinOnline(code: string): SocketLike {
  const peer = new Peer(peerOptions());
  let channel: DataConnection | null = null;
  let done = false;
  const sock: SocketLike = {
    readyState: 0,
    send(text) {
      if (channel?.open) void channel.send(text);
    },
    close() {
      if (done) return;
      done = true;
      (sock as { readyState: number }).readyState = 3;
      peer.destroy();
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  /** Gives up with a reason the player can act on. */
  const fail = (why: string) => {
    if (done) return;
    sock.failure = why;
    const wasOpen = sock.readyState === 1;
    sock.close();
    if (wasOpen) sock.onclose?.();
    else sock.onerror?.();
  };
  peer.on('open', () => {
    const c = peer.connect(PEER_PREFIX + code, { reliable: true, serialization: 'raw' });
    channel = c;
    c.on('open', () => {
      // Only once: a second 'open' would send a second join, and the room would be "full".
      if (done || sock.readyState !== 0) return;
      (sock as { readyState: number }).readyState = 1;
      sock.onopen?.();
    });
    c.on('data', (d) => {
      if (typeof d === 'string') sock.onmessage?.({ data: d });
    });
    c.on('close', () => fail('The host left the game.'));
    c.on('error', () => fail(sock.readyState === 1 ? 'The connection to the host was lost.' : NO_DIRECT));
    watchIce(c, () => fail(sock.readyState === 1 ? 'The connection to the host was lost.' : NO_DIRECT));
  });
  peer.on('error', (e) => {
    if (e.type === 'peer-unavailable') fail(`No game is being hosted with code ${code}. Check the code with your friend — it changes every time they host.`);
    else if (e.type === 'browser-incompatible') fail('This browser cannot make direct connections (WebRTC). Use the PvP Trainer app, Chrome, Edge or Firefox.');
    else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
      if (sock.readyState !== 1) fail('Could not reach the matchmaking service. Check your internet connection and try again.');
    } else fail(NO_DIRECT);
  });
  return sock;
}

/** How long a join may take: finding a route through two routers can take a while. */
export const JOIN_TIMEOUT_MS = 20000;
export const JOIN_TIMEOUT_TEXT = NO_DIRECT;
