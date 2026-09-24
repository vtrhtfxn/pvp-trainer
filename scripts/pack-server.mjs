// Builds "PvP Trainer Server/" on the Desktop: a self-contained folder that anyone with Node
// can unzip and double-click, on Windows, macOS or Linux. No npm install, no dependencies.

import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * --with-node bundles a portable node.exe (vendor/win-x64/node.exe) so the folder runs on a
 * locked-down Windows machine with no admin rights and nothing installed. It makes the download
 * ~35 MB instead of 450 KB, so it is opt-in.
 */
const withNode = process.argv.includes('--with-node');
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const OUT =
  positional[0] ?? path.join(homedir(), 'Desktop', withNode ? 'PvP Trainer Server (Windows)' : 'PvP Trainer Server');

const game = path.join(ROOT, 'dist', 'index.html');
const server = path.join(ROOT, 'dist-server', 'server.mjs');
for (const f of [game, server]) {
  if (!existsSync(f)) {
    console.error(`Missing ${path.relative(ROOT, f)} — run "npm run build && npm run build:server" first.`);
    process.exit(1);
  }
}

const portableNode = path.join(ROOT, 'vendor', 'win-x64', 'node.exe');
if (withNode && !existsSync(portableNode)) {
  console.error(`Missing vendor/win-x64/node.exe — download node-<version>-win-x64.zip from
https://nodejs.org/dist/ and extract node.exe (and its LICENSE) to vendor/win-x64/.`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
copyFileSync(server, path.join(OUT, 'server.mjs'));
copyFileSync(game, path.join(OUT, 'game.html'));
if (withNode) {
  copyFileSync(portableNode, path.join(OUT, 'node.exe'));
  const lic = path.join(ROOT, 'vendor', 'win-x64', 'NODE-LICENSE.txt');
  if (existsSync(lic)) copyFileSync(lic, path.join(OUT, 'NODE-LICENSE.txt'));
}

const bat = [
  '@echo off',
  'title PvP Trainer - multiplayer server',
  'cd /d "%~dp0"',
  'set "NODE_EXE=%~dp0node.exe"',
  'if not exist "%NODE_EXE%" (',
  '  where node >nul 2>nul',
  '  if errorlevel 1 (',
  '    echo.',
  '    echo   Node.js was not found and this copy does not include it.',
  '    echo   Ask for the "Windows" download, which needs no install.',
  '    echo.',
  '    pause',
  '    exit /b 1',
  '  )',
  '  set "NODE_EXE=node"',
  ')',
  '"%NODE_EXE%" server.mjs',
  'echo.',
  'echo   Server stopped.',
  'pause',
  '',
];
writeFileSync(path.join(OUT, 'START - Windows.bat'), bat.join('\r\n'));

const shell = [
  '#!/bin/bash',
  '# PvP Trainer multiplayer server (macOS / Linux)',
  'cd "$(dirname "$0")" || exit 1',
  'if ! command -v node >/dev/null 2>&1; then',
  '  echo ""',
  '  echo "  Node.js is not installed - the server needs it."',
  '  echo "  Get it from https://nodejs.org (the LTS build), then run this again."',
  '  echo ""',
  '  read -r -p "  Press Return to close."',
  '  exit 1',
  'fi',
  'node server.mjs',
  '',
].join('\n');
for (const name of ['START - Mac.command', 'start-linux.sh']) {
  const f = path.join(OUT, name);
  writeFileSync(f, shell);
  chmodSync(f, 0o755);
}

writeFileSync(
  path.join(OUT, 'READ ME FIRST.txt'),
  `PvP TRAINER - MULTIPLAYER SERVER
===============================

One person runs this. Everyone else just opens a link in a browser -
they do not need this folder, Node, or anything else.

The host plays too. Running the server does not stop you playing.


>>> THE ONE MISTAKE EVERYONE MAKES <<<
Do NOT double-click game.html to play multiplayer. Opened that way the
game has no idea where the server is, and it says:

    "Could not reach that server. Is it running?"

Multiplayer means EVERY player - the host included - opens the
http://...:4180 address in a browser. game.html on its own is for
solo play against the bot only.


STEP 1 - the host starts the server
-----------------------------------
Windows:  double-click  "START - Windows.bat"
Mac:      double-click  "START - Mac.command"
Linux:    ./start-linux.sh
${
  withNode
    ? `No installing, and no admin password needed. node.exe is already in
this folder and the launcher uses it.

IMPORTANT on a school or work PC: after downloading the .zip, right-click
it -> Properties -> tick "Unblock" -> OK, THEN extract it. Windows blocks
programs inside a downloaded zip otherwise. You must extract the folder -
running things from inside the zip preview does not work.

If SmartScreen shows "Windows protected your PC": More info -> Run anyway.`
    : `Needs Node.js. If it says so, install it from https://nodejs.org
(the big LTS button) and run it again. Nothing else to install.

Windows may show "Windows protected your PC" -> More info -> Run anyway.`
}

Windows Firewall will ask to allow it - say YES, and tick the
"Private networks" box, or nobody will be able to connect. That prompt
does not need an admin password.


STEP 2 - read the addresses it prints
-------------------------------------
    You (the host) play here:   http://localhost:4180

    Everyone else on your network opens ONE of these:
        http://192.168.1.23:4180      (Ethernet)

Send that second link to the other players. If it lists an address
under "Not shareable", ignore that one - nobody can reach it.


STEP 3 - play
-------------
Everyone opens their link IN A BROWSER (Chrome works best), then:

    Host:    Multiplayer -> Host a new room -> read out the 4-letter code
    Friend:  Multiplayer -> type that code  -> Join room code

The duel starts as soon as both of you are in. Two players per room;
open as many rooms as you like for more pairs.


EVERYONE MUST BE ON THE SAME NETWORK
------------------------------------
This only works between machines that can reach each other. Two people
on the same Ethernet or the same Wi-Fi are fine. Someone on a different
network - a different school SSID, a phone hotspot, or anything behind
carrier NAT - cannot join, no matter what address they use.

If you need to play across different networks, install Tailscale
(https://tailscale.com, free) on the host and on each player, log in
with the same account, and use the host's Tailscale IP in place of the
address above. It makes the machines behave as if they were on one
network.


OTHER THINGS
------------
Different port:   set PORT first, e.g.  PORT=4181 node server.mjs
Stop the server:  Ctrl+C, or just close the window
Solo play:        open game.html directly - no server needed

Fair warning: each player's own movement is trusted by the server
(Minecraft works the same way), so someone editing the page could move
in ways they shouldn't. Play with people you trust.

Not affiliated with Mojang or Microsoft.
`,
);

console.log(`Server package → ${OUT}`);
for (const f of ['server.mjs', 'game.html', 'START - Windows.bat', 'START - Mac.command', 'start-linux.sh', 'READ ME FIRST.txt']) {
  console.log(`  ${f}`);
}
