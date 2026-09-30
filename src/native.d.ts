/** Bridge exposed by the macOS app's preload script (absent in the browser). */
interface PvpNative {
  /** The app's "Toggle Hitboxes ⌘M" menu item. */
  onToggleHitboxes(cb: () => void): void;
  readonly platform: string;
  /** Uncapped FPS (VSync off) is on for this launch. */
  readonly uncapped: boolean;
  /** Saves the Uncapped FPS choice for the next launch. */
  setUncapped(on: boolean): Promise<void>;
  /** The game build the app is running (0 for a local build). Older app shells lack it. */
  build?(): Promise<number>;
  /** Refresh rate of the window's screen in Hz (0 if unknown). */
  displayHz?(): Promise<number>;
  /** News from the updater: a newer game is ready (restart), or a new app is needed (download). */
  onUpdate?(cb: (info: { kind: 'game' | 'app'; build: number }) => void): void;
  restart?(): Promise<void>;
  openDownload?(): Promise<void>;
}

interface Window {
  pvpNative?: PvpNative;
}
