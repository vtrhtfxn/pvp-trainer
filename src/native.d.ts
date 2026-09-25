/** Bridge exposed by the macOS app's preload script (absent in the browser). */
interface PvpNative {
  /** The app's "Toggle Hitboxes ⌘M" menu item. */
  onToggleHitboxes(cb: () => void): void;
  readonly platform: string;
  /** Uncapped FPS (VSync off) is on for this launch. */
  readonly uncapped: boolean;
  /** Saves the Uncapped FPS choice for the next launch. */
  setUncapped(on: boolean): Promise<void>;
}

interface Window {
  pvpNative?: PvpNative;
}
