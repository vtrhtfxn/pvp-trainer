import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'lobby' | 'playing' | 'closed' | 'error';

export interface NetHandlers {
  onStatus(status: NetStatus, detail: string): void;
  onMessage(msg: ServerMsg): void;
}

/** Thin WebSocket wrapper: reconnect is deliberately manual — a dropped duel is over. */
export class NetClient {
  private ws: WebSocket | null = null;
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

  connect(url: string, room: string, name: string) {
    this.close();
    this.setStatus('connecting', `Connecting to ${url} …`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.setStatus('error', `"${url}" is not a valid address. It should look like ws://192.168.1.23:4180/ws`);
      return;
    }
    this.ws = ws;
    // A wrong IP just hangs until the OS gives up, which looks like the game is broken.
    const timeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        this.setStatus('error', this.unreachable(url));
        ws.close();
      }
    }, 8000);
    const clearTimer = () => clearTimeout(timeout);
    ws.onopen = () => {
      clearTimer();
      this.send({ t: 'join', room, name, v: PROTOCOL_VERSION });
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
        this.setStatus('lobby', msg.players.length < 2 ? 'Waiting for an opponent…' : 'Starting…');
      } else if (msg.t === 'start') {
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
   * The overwhelmingly common cause is opening game.html by double-clicking it: the page then
   * has no host of its own, so the address defaults to localhost and there is nothing there.
   */
  private unreachable(url: string): string {
    const openedAsFile = location.protocol !== 'http:' && location.protocol !== 'https:';
    if (openedAsFile) {
      return `Nothing is running at ${url}. You opened the game as a file — for multiplayer, open the http:// address the host's server window prints (for example http://192.168.1.23:4180) instead of double-clicking game.html.`;
    }
    if (/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url)) {
      return `Nothing is running at ${url}. "localhost" means this computer — if you are not the host, put the host's address here instead.`;
    }
    return `Could not reach ${url}. Check the host's server window is still open, that you typed the same address it prints, and that the host allowed it through their firewall.`;
  }

  private setStatus(s: NetStatus, detail: string) {
    this.status = s;
    this.detail = detail;
    this.handlers.onStatus(s, detail);
  }
}
