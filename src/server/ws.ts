/**
 * A minimal RFC 6455 WebSocket server, just enough for this game's small JSON messages.
 *
 * It exists so the distributable server is a single file with no `npm install` — a friend on
 * Windows can unzip it and double-click a .bat. Text frames only; binary frames are ignored.
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'; // RFC 6455 §1.3

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

/** Refuse absurd frames rather than buffering them; nothing here is near this size. */
const MAX_MESSAGE = 1 << 20;

type Bytes = Buffer<ArrayBufferLike>;

export class WsConnection {
  private buffer: Bytes = Buffer.alloc(0);
  private fragments: Bytes[] = [];
  private fragmentOp = 0;
  private closed = false;

  onMessage: ((text: string) => void) | null = null;
  onClose: (() => void) | null = null;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.feed(Buffer.from(chunk)));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
    socket.on('end', () => this.finish());
  }

  get open(): boolean {
    return !this.closed && this.socket.writable;
  }

  send(text: string) {
    if (!this.open) return;
    this.socket.write(frame(OP_TEXT, Buffer.from(text, 'utf8')));
  }

  close(code = 1000) {
    if (this.closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    try {
      this.socket.write(frame(OP_CLOSE, payload));
    } catch {
      /* already gone */
    }
    this.finish();
    this.socket.end();
  }

  private finish() {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
  }

  private feed(chunk: Bytes) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    // A single TCP chunk can hold several frames, or a fraction of one.
    for (;;) {
      const parsed = this.readFrame();
      if (!parsed) return;
      const { fin, opcode, payload } = parsed;
      if (opcode === OP_CLOSE) {
        this.close(1000);
        return;
      }
      if (opcode === OP_PING) {
        if (this.open) this.socket.write(frame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_PONG) continue;
      if (opcode === OP_BINARY) continue; // this protocol is JSON text only

      if (opcode === OP_TEXT || opcode === OP_CONTINUATION) {
        if (opcode === OP_TEXT) {
          this.fragments = [payload];
          this.fragmentOp = OP_TEXT;
        } else {
          this.fragments.push(payload);
        }
        const total = this.fragments.reduce((n, b) => n + b.length, 0);
        if (total > MAX_MESSAGE) {
          this.close(1009);
          return;
        }
        if (fin && this.fragmentOp === OP_TEXT) {
          const text = Buffer.concat(this.fragments).toString('utf8');
          this.fragments = [];
          this.fragmentOp = 0;
          this.onMessage?.(text);
        }
      }
    }
  }

  /** Pulls one whole frame out of the buffer, or returns null if more bytes are needed. */
  private readFrame(): { fin: boolean; opcode: number; payload: Bytes } | null {
    const b = this.buffer;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < offset + 2) return null;
      len = b.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (b.length < offset + 8) return null;
      const big = b.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      offset += 8;
    }
    // Every client-to-server frame must be masked (RFC 6455 §5.1).
    if (!masked) {
      this.close(1002);
      return null;
    }
    if (b.length < offset + 4 + len) return null;
    const mask = b.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = b[offset + i] ^ mask[i & 3];
    this.buffer = b.subarray(offset + len);
    return { fin, opcode, payload };
  }
}

function frame(opcode: number, payload: Bytes): Bytes {
  const len = payload.length;
  let header: Bytes;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** Upgrades matching requests on an existing HTTP server. */
export function attachWebSocket(server: Server, path: string, onConnection: (ws: WsConnection) => void) {
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = (req.url ?? '/').split('?')[0];
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
    if (url !== path || upgrade !== 'websocket' || typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    const ws = new WsConnection(socket);
    if (head && head.length) socket.unshift(head);
    onConnection(ws);
  });
}
