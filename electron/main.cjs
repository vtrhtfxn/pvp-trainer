// Desktop app shell for PvP Trainer (macOS and Windows).
//
// The built game (dist/index.html) is served over a private "pvp://" scheme rather than
// file://, so it gets a real web origin: localStorage keeps your settings and records, and
// pointer lock behaves exactly like it does in Chrome.

const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const SCHEME = 'pvp';
const HOST = 'game';
const ROOT = path.join(__dirname, '..', 'dist');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

// Chromium throttles requestAnimationFrame in occluded windows, which would stall the
// fixed-step simulation the moment the window loses focus.
app.commandLine.appendSwitch('disable-renderer-backgrounding');

// Frames are paced to the screen (VSync) unless the player turns on Options → Video →
// Uncapped FPS. Uncapped runs as fast as the machine can, out of step with the display: more
// FPS and slightly quicker input, but stutter, heat and throttling on laptops — so it is
// opt-in, and it is a Chromium switch, so it takes effect on the next launch.
const DISPLAY_FILE = path.join(app.getPath('userData'), 'display.json');
function readUncapped() {
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
