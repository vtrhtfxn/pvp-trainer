// The only bridge between the app shell and the game. The menu owns ⌘M (macOS menu
// accelerators never reach the page), so the main process relays the toggle here.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pvpNative', {
  onToggleHitboxes: (cb) => ipcRenderer.on('pvp:toggle-hitboxes', () => cb()),
  platform: process.platform,
  /** Uncapped FPS is on for this launch. */
  uncapped: process.argv.includes('--pvp-uncapped=1'),
  /** Saves the Uncapped FPS choice; it applies when the app next starts. */
  setUncapped: (on) => ipcRenderer.invoke('pvp:set-uncapped', !!on),
  /** The game build this app is running (0: a local build). */
  build: () => ipcRenderer.invoke('pvp:build'),
  /** The refresh rate of the window's screen, in Hz (0 if unknown). */
  displayHz: () => ipcRenderer.invoke('pvp:display-hz'),
  /** A newer game was downloaded ({ kind: 'game', build }) or needs a new app ({ kind: 'app', build }). */
  onUpdate: (cb) => ipcRenderer.on('pvp:update', (_e, info) => cb(info)),
  /** Restarts the app (to run a downloaded update). */
  restart: () => ipcRenderer.invoke('pvp:restart'),
  /** Opens the download page in the browser. */
  openDownload: () => ipcRenderer.invoke('pvp:open-download'),
});
