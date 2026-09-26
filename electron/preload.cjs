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
});
