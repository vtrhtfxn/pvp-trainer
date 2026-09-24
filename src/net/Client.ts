import { KITS } from '../game/kits';
import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'lobby' | 'playing' | 'closed' | 'error';

export interface NetHandlers {
  onStatus(status: NetStatus, detail: string): void;
  onMessage(msg: ServerMsg): void;
}

/** Thin WebSocket wrapper: reconnect is deliberately manual — a dropped duel is over. */
export class NetClient {
  private ws: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  status: NetStatus = 'idle';
  you = -1;
  room = '';
  detail = '';

  constructor(private readonly handlers: NetHandlers) {}

  /** Derives the server URL from wherever the page was served. */
  static defaultUrl(): string {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
    }
    // file:// pages and the macOS app (pvp://) have no usable host of their own.
    return 'ws://localhost:4180/ws';
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** The kit of the room we are in (from the lobby / start messages). */
  kit = 'sword';

  connect(address: string, room: string, name: string, kit = 'sword') {
    this.close();
    const url = normalizeServerUrl(address);
    this.setStatus('connecting', `Connecting to ${url} …`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus('error', `"${url}" is not a valid address. It should look like ws://192.168.1.23:4180/ws`);
      return;
    }
    this.ws = ws;
    this.room = '';
    this.you = -1;
    // A wrong IP just hangs until the OS gives up, which looks like the game is broken.
    const timeout = setTimeout(() => {
      // Only for this attempt: a later connect or a Disconnect must not be kicked by it.
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        this.setStatus('error', this.unreachable(url));
        this.close();
      }
    }, 8000);
    this.connectTimer = timeout;
    const clearTimer = () => clearTimeout(timeout);
    ws.onopen = () => {
      clearTimer();
      this.send({ t: 'join', room, name, v: PROTOCOL_VERSION, kit });
    };
    ws.onmessage = (e) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(e.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'joined') {
        this.you = msg.you;
        this.room = msg.room;
      } else if (msg.t === 'error') {
        this.setStatus('error', msg.message);
        this.close();
        return;
      } else if (msg.t === 'ping') {
        this.send({ t: 'pong', id: msg.id });
        return;
      } else if (msg.t === 'lobby') {
        this.kit = msg.kit;
        const kitName = KITS.find((k) => k.id === msg.kit)?.name ?? msg.kit;
        this.setStatus('lobby', `${kitName} kit · ${msg.players.length < 2 ? 'Waiting for an opponent…' : 'Starting…'}`);
      } else if (msg.t === 'start') {
        this.kit = msg.kit;
        this.setStatus('playing', '');
      }
      this.handlers.onMessage(msg);
    };
    ws.onerror = () => {
      clearTimer();
      if (this.status === 'connecting') this.setStatus('error', this.unreachable(url));
    };
    ws.onclose = () => {
      clearTimer();
      if (this.status !== 'error') this.setStatus('closed', 'Disconnected from the server.');
      this.ws = null;
    };
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.connectTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
  }

  /**
   * The overwhelmingly common cause is a page with no host of its own (game.html opened as a
   * file, or the desktop app): the address then defaults to localhost and there is nothing there.
   */
  private unreachable(url: string): string {
    if (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
      return `Nothing is running at ${url}. "localhost" means this computer — if you are not the host, type the host's address in Server (the one their server window prints, for example 192.168.1.23).`;
    }
    return `Could not reach ${url}. Check the host's server window is still open, that you typed the same address it prints, and that the host allowed it through their firewall.`;
  }

  private setStatus(s: NetStatus, detail: string) {
    this.status = s;
    this.detail = detail;
    this.handlers.onStatus(s, detail);
  }
}

/**
 * Accepts whatever people type for the server: "192.168.1.23", "192.168.1.23:4180",
 * "http://192.168.1.23:4180" (the address the server prints) or a full ws:// URL.
 */
export function normalizeServerUrl(input: string): string {
  let s = input.trim();
  if (!s) return NetClient.defaultUrl();
  s = s.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
  if (!/^wss?:\/\//i.test(s)) s = `ws://${s}`;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'ws:') u.port = '4180';
    if (u.pathname === '/' || u.pathname === '') u.pathname = '/ws';
    return u.toString();
  } catch {
    return s;
  }
}
