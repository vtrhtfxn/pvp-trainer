/** Bridge exposed by the macOS app's preload script (absent in the browser). */
interface PvpNative {
  /** The app's "Toggle Hitboxes ⌘M" menu item. */
  onToggleHitboxes(cb: () => void): void;
  readonly platform: string;
  /** CPU the app was built for ('x64', 'arm64'). Older app shells lack it. */
  readonly arch?: string;
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
  /**
   * The app's resourcepacks folder (newer app shells): list the packs in it (.zip files and
   * unzipped folders), read one, open the folder in Finder / Explorer.
   */
  packs?: {
    list(): Promise<string[]>;
    read(name: string): Promise<{ zip?: Uint8Array; files?: { name: string; data: Uint8Array }[] } | null>;
    openFolder(): Promise<void>;
  };
  /** The app's mods folder (newer app shells): list the .jar files in it, read one, open it. */
  mods?: {
    list(): Promise<string[]>;
    read(name: string): Promise<Uint8Array | null>;
    openFolder(): Promise<void>;
  };
  openDownload?(): Promise<void>;
}

interface Window {
  pvpNative?: PvpNative;
}
