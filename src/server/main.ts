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

import { PROTOCOL_VERSION } from '../net/protocol';
import { Lobby } from './lobby';
import { attachWebSocket } from './ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4180);

/** Packaged next to the server, or the dev build two directories up. */
const GAME_CANDIDATES = [
  path.join(HERE, 'game.html'),
  path.join(HERE, '..', 'dist', 'index.html'),
  path.join(process.cwd(), 'dist', 'index.html'),
];

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
    res.end(JSON.stringify({ ok: true, rooms: lobby.rooms.size, version: PROTOCOL_VERSION }));
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

const lobby = new Lobby({ maxClients: 64, maxRooms: 32, log });

attachWebSocket(server, '/ws', (ws) => lobby.connect(ws));

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
