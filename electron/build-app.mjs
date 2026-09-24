// Packages the built game as a desktop app in dist-app/.
//   macOS (default on a Mac): "PvP Trainer.app". Host architecture by default; pass --universal
//     for a universal binary, or --arch=x64 / --arch=arm64.
//   Windows: --win (from any OS) builds "PvP Trainer-win32-x64/" plus a ready-to-send
//     "PvP Trainer (Windows).zip" with a read-me for friends.

import { packager } from '@electron/packager';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
  console.error('dist/index.html is missing — run "npm run build" first.');
  process.exit(1);
}

const win = process.argv.includes('--win');
const archArg = process.argv.find((a) => a.startsWith('--arch='));
const arch = process.argv.includes('--universal') ? 'universal' : (archArg?.slice(7) ?? (win ? 'x64' : process.arch));

const WINDOWS_README = `PvP TRAINER - WINDOWS
====================

1. Right-click the .zip -> Extract All (do not run it from inside the zip).
2. Open the "PvP Trainer" folder and double-click "PvP Trainer.exe".
   If Windows says "Windows protected your PC": More info -> Run anyway.

All 8 kits work against the bots (LT5 up to HT1) with no internet and no
install. Ctrl+W, Ctrl+R and the other browser shortcuts do nothing here,
so sprinting can never close the game. F11 = fullscreen.


PLAYING WITH FRIENDS (same Wi-Fi / network)
-------------------------------------------
One person hosts. On the host's Mac, run the server
("Start Server.command" in the project, or "npm run server").
Its window prints an address such as  http://192.168.1.23:4180

Everyone else:
  1. Open PvP Trainer -> Multiplayer.
  2. In "Server", type the host's address, e.g.  192.168.1.23
  3. Create a room: "Host a new room" - you get a 4-letter code.
     Join a room: type the code in "Room code" -> "Join room code".

Hosting a room uses the kit you picked on the main menu; joining plays
the room's kit. Two players per room, as many rooms as you like.

If it cannot connect: check the host's server window is still open, that
you are on the same network, and that the host allowed the server through
their firewall.

Not affiliated with Mojang or Microsoft.
`;

const paths = await packager({
  dir: ROOT,
  out: path.join(ROOT, 'dist-app'),
  name: 'PvP Trainer',
  appBundleId: 'dev.pvptrainer.app',
  appCategoryType: 'public.app-category.games',
  platform: win ? 'win32' : 'darwin',
  arch,
  icon: path.join(ROOT, 'electron', win ? 'icon.ico' : 'icon.icns'),
  overwrite: true,
  // Nothing in node_modules ships — three.js and the fonts are already inlined into dist.
  prune: false,
  // Only the app shell and the single-file build ship; nothing else is needed at runtime.
  ignore: [
    /^\/src($|\/)/,
    /^\/tests($|\/)/,
    /^\/node_modules($|\/)/,
    /^\/dist-app($|\/)/,
    /^\/dist-server($|\/)/,
    /^\/(scripts|vendor)($|\/)/,
    /^\/Start Server\.command$/,
    /^\/\.(git|claude|DS_Store)/,
    /^\/New Folder With Items($|\/)/,
    /^\/[^/]+\.glb$/,
    /^\/(index\.html|vite\.config\.ts|vite\.server\.config\.ts|tsconfig\.json|package-lock\.json|README\.md)$/,
    /^\/electron\/(make-icon|build-app)\.mjs$/,
  ],
  win32metadata: { ProductName: 'PvP Trainer', FileDescription: 'PvP Trainer', CompanyName: 'PvP Trainer' },
  extendInfo: {
    NSHumanReadableCopyright: 'Not affiliated with Mojang or Microsoft.',
    LSMinimumSystemVersion: '11.0',
  },
});

for (const p of paths) console.log(`app → ${path.relative(process.cwd(), p)}`);

if (win) {
  const { execFileSync } = await import('node:child_process');
  const dir = paths[0];
  // Chromium's UI translations are unused (the game is in English): ~40 MB less to send.
  const locales = path.join(dir, 'locales');
  for (const f of fs.readdirSync(locales)) if (f !== 'en-US.pak') fs.rmSync(path.join(locales, f));
  fs.writeFileSync(path.join(dir, 'READ ME FIRST.txt'), WINDOWS_README.replace(/\n/g, '\r\n'));
  const zip = path.join(ROOT, 'dist-app', 'PvP Trainer (Windows).zip');
  fs.rmSync(zip, { force: true });
  const folder = 'PvP Trainer';
  const staged = path.join(ROOT, 'dist-app', folder);
  fs.rmSync(staged, { recursive: true, force: true });
  fs.renameSync(dir, staged);
  execFileSync('zip', ['-qry9', zip, folder], { cwd: path.join(ROOT, 'dist-app') });
  console.log(`zip → ${path.relative(process.cwd(), zip)} (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
}
