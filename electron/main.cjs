// Desktop app shell for PvP Trainer (macOS and Windows).
//
// The built game (dist/index.html) is served over a private "pvp://" scheme rather than
// file://, so it gets a real web origin: localStorage keeps your settings and records, and
// pointer lock behaves exactly like it does in Chrome.
//
// It keeps itself up to date: every build of main is published as a GitHub Release (see
// .github/workflows/app.yml). At launch the app checks the latest one; a newer game (one
// HTML file) is downloaded in the background and used from the next start — the game offers a
// Restart button. A release that needs a newer app shell than this one only offers the
// download page instead.

const { app, BrowserWindow, Menu, ipcMain, protocol, net, screen, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const updater = require('./updater.cjs');

const SCHEME = 'pvp';
const HOST = 'game';
const REPO = 'vtrhtfxn/pvp-trainer';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
/** Bumped (in shell-version.json) whenever main.cjs / preload.cjs change in a way a game build relies on. */
const SHELL_VERSION = Number(require('./shell-version.json').shell) || 1;
/** `--smoke-test`: load the game, print whether it started, and quit (used by the build workflow). */
const SMOKE = process.argv.includes('--smoke-test');

/** The game that came with the app, and where downloaded updates go. */
const BUNDLED = path.join(__dirname, '..', 'dist');
const UPDATES = path.join(app.getPath('userData'), 'game');

/** The newest game this shell can run: a downloaded update, or the one in the app. */
const GAME = updater.pickGame({ bundledDir: BUNDLED, updatesDir: UPDATES, shellVersion: SHELL_VERSION, allowUpdates: app.isPackaged && !SMOKE });
const ROOT = GAME.dir;

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Linux CI machines have no GPU: let the smoke test render in software there. (macOS keeps its
// normal Metal path — Chromium has no software renderer on the Mac.)
if (SMOKE && process.platform === 'linux') {
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}

// Chromium throttles requestAnimationFrame in occluded windows, which would stall the
// fixed-step simulation the moment the window loses focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Frames are paced to the screen (VSync): 60 FPS on a 60 Hz display, 120 on a ProMotion one.
//
// Windows only: Options → Video → Uncapped FPS switches VSync and Chromium's frame-rate limit
// off (a Chromium switch, so it applies on the next launch). Never on macOS: there the game then
// draws hundreds of frames a second that the window server never shows — the FPS counter reads
// huge numbers while the screen updates about ten times a second.
const DISPLAY_FILE = path.join(app.getPath('userData'), 'display.json');
function readUncapped() {
  if (process.platform === 'darwin') return false;
  try {
    return JSON.parse(fs.readFileSync(DISPLAY_FILE, 'utf8')).uncapped === true;
  } catch {
    return false;
  }
}
const uncapped = readUncapped();
if (uncapped) {
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
}
// Use the GPU for everything it can do, even on drivers Chromium is cautious about.
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
// Windows: don't let a window that is partly covered be treated as hidden (it would throttle).
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
/** Only the game page itself may talk to the app shell. */
function fromGame(event) {
  const url = event.senderFrame?.url ?? '';
  return url.startsWith(`${SCHEME}://${HOST}/`);
}

ipcMain.handle('pvp:set-uncapped', (e, on) => {
  if (!fromGame(e)) return;
  try {
    fs.mkdirSync(path.dirname(DISPLAY_FILE), { recursive: true });
    fs.writeFileSync(DISPLAY_FILE, JSON.stringify({ uncapped: !!on }));
  } catch {
    /* read-only profile: stays as it is */
  }
});

/** @type {BrowserWindow | null} */
let win = null;

function serveDist() {
  protocol.handle(SCHEME, (request) => {
    let file;
    try {
      const url = new URL(request.url);
      if (url.host !== HOST) return new Response('Not found', { status: 404 });
      const rel = decodeURIComponent(url.pathname);
      file = path.join(ROOT, rel === '/' ? 'index.html' : rel);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    // Never serve anything outside dist/, whatever the URL asks for (".." or, on Windows,
    // another drive — path.relative then returns an absolute path, not one starting with "..").
    const inside = path.relative(ROOT, file);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function toggleHitboxes() {
  win?.webContents.send('pvp:toggle-hitboxes');
}

function buildMenu() {
  // Windows / Linux: no menu bar at all. Its default shortcuts (Ctrl+W closes the window,
  // Ctrl+R reloads) sit right next to the game's keys — Ctrl is sprint, W is forward — and
  // would end a duel mid-fight. The game handles Ctrl+M itself; F11 is wired up below.
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Game',
      submenu: [
        // ⌘M is the in-game hitbox toggle, so Minimize moves to ⌥⌘M (see the Window menu).
        { label: 'Toggle Hitboxes', accelerator: 'CmdOrCtrl+M', click: toggleHitboxes },
        { type: 'separator' },
        { label: 'Reload Game', accelerator: 'Shift+CmdOrCtrl+R', click: () => win?.webContents.reload() },
      ],
    },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize', accelerator: 'Alt+Command+M' }, { role: 'zoom' }, { role: 'close' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 540,
    backgroundColor: '#1b1b1b',
    title: 'PvP Trainer',
    icon: process.platform === 'win32' ? path.join(__dirname, 'icon.ico') : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [`--pvp-uncapped=${uncapped ? 1 : 0}`],
    },
  });

  win.once('ready-to-show', () => win?.show());
  if (process.platform !== 'darwin') {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F11') {
        event.preventDefault();
        win?.setFullScreen(!win.isFullScreen());
      } else if (input.key === 'F12' && input.control && input.shift) {
        win?.webContents.toggleDevTools();
      }
    });
  }
  // The game has no outbound links; if one ever appears, hand it to the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the game: any navigation away from it goes to the browser
  // instead (https only), so no other page ever gets the app bridge.
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(`${SCHEME}://${HOST}/`)) return;
    event.preventDefault();
    if (url.startsWith('https://')) void shell.openExternal(url);
  });
  // Pointer lock and fullscreen are all the game asks for; camera, microphone, location,
  // notifications and the rest are refused without a prompt.
  const ALLOWED = new Set(['pointerLock', 'fullscreen']);
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED.has(permission)));
  win.webContents.session.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  win.on('closed', () => {
    win = null;
  });

  void win.loadURL(`${SCHEME}://${HOST}/index.html`);
}

// ---------------------------------------------------------------- updates

/** Update news for the game, queued until its page has loaded. */
let updateInfo = null;
function tellGame() {
  if (updateInfo && win && !win.webContents.isLoading()) win.webContents.send('pvp:update', updateInfo);
}

async function fetchWithTimeout(url, ms, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await net.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function checkForUpdate() {
  const fetch = (url) =>
    fetchWithTimeout(url, url.includes('api.github.com') ? 10000 : 120000, {
      headers: { accept: url.includes('api.github.com') ? 'application/vnd.github+json' : '*/*', 'user-agent': 'PvP-Trainer-app' },
    });
  const info = await updater.checkForUpdate({ fetch, repo: REPO, currentBuild: GAME.build, shellVersion: SHELL_VERSION, updatesDir: UPDATES });
  if (!info) return;
  updateInfo = info;
  tellGame();
}

ipcMain.handle('pvp:restart', (e) => {
  if (!fromGame(e)) return;
  app.relaunch();
  app.exit(0);
});
ipcMain.handle('pvp:open-download', (e) => {
  if (!fromGame(e)) return;
  void shell.openExternal(RELEASES);
});
ipcMain.handle('pvp:build', (e) => (fromGame(e) ? GAME.build : 0));
/** The refresh rate of the screen the window is on (60, 120 on ProMotion, …). */
ipcMain.handle('pvp:display-hz', (e) => {
  if (!fromGame(e) || !win) return 0;
  return Math.round(screen.getDisplayMatching(win.getBounds()).displayFrequency || 0);
});

app.whenReady().then(() => {
  if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
    const { dialog } = require('electron');
    dialog.showErrorBox('PvP Trainer', 'dist/index.html is missing.\n\nRun "npm run build" first.');
    app.quit();
    return;
  }
  serveDist();
  buildMenu();
  createWindow();
  if (SMOKE) {
    smokeTest();
    return;
  }
  win.webContents.on('did-finish-load', tellGame);
  // Only a packaged app updates itself; `npm run app` always runs your own build.
  if (app.isPackaged) checkForUpdate().catch(() => {});
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

/** Loads the game and reports whether it started (the build workflow runs this on a Mac). */
function smokeTest() {
  const done = (ok, msg) => {
    const line = `SMOKE ${ok ? 'OK' : 'FAIL'}: ${msg}`;
    console.log(line);
    // Windows GUI apps have no console to print to: CI reads the result from this file instead.
    if (process.env.PVP_SMOKE_OUT) {
      try {
        require('node:fs').writeFileSync(process.env.PVP_SMOKE_OUT, `${line}\n`);
      } catch {
        /* the console line is still there */
      }
    }
    app.exit(ok ? 0 : 1);
  };
  const giveUp = setTimeout(() => done(false, 'timed out after 90 s'), 90000);
  win.webContents.once('did-fail-load', (_e, code, desc) => done(false, `load failed ${code} ${desc}`));
  win.webContents.once('did-finish-load', async () => {
    for (;;) {
      const r = await win.webContents
        .executeJavaScript(`(() => { const l = document.getElementById('loading'); return { started: !!window.__pvp, text: l ? l.textContent.trim() : '', title: document.title }; })()`)
        .catch((err) => ({ started: false, text: String(err) }));
      if (r.started) {
        clearTimeout(giveUp);
        done(true, `game started (${r.title})`);
        return;
      }
      if (/Failed to start/.test(r.text)) {
        clearTimeout(giveUp);
        // GitHub's Mac runners are virtual machines without a GPU. Everything up to WebGL has
        // worked by then (the app, its pvp:// server, the scripts, fonts, textures and model),
        // so the build workflow accepts that one failure — and nothing else.
        if (process.env.PVP_SMOKE_NO_GPU_OK === '1' && /Error creating WebGL context/.test(r.text)) {
          done(true, `game loaded; this machine has no GPU for WebGL (${r.text})`);
          return;
        }
        done(false, r.text);
        return;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  });
}
