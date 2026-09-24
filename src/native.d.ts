/** Bridge exposed by the macOS app's preload script (absent in the browser). */
interface PvpNative {
  /** The app's "Toggle Hitboxes ⌘M" menu item. */
  onToggleHitboxes(cb: () => void): void;
  readonly platform: string;
}

interface Window {
  pvpNative?: PvpNative;
}
