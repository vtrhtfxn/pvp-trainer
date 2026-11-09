/** A player's skin as it is stored and sent online (the drawing side is src/render/skins.ts). */

export interface Skin {
  /** The skin as a 64×64 PNG data URL. */
  png: string;
  slim: boolean;
}

/** Longest skin data URL accepted (a 64×64 PNG is a few KB; this leaves room for noisy ones). */
export const SKIN_MAX = 24000;
const PREFIX = 'data:image/png;base64,';

/** A skin as it might arrive from storage or the network: the right shape, or null. */
export function cleanSkin(v: unknown): Skin | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as { png?: unknown; slim?: unknown };
  if (typeof s.png !== 'string' || !s.png.startsWith(PREFIX) || s.png.length > SKIN_MAX) return null;
  if (!/^[A-Za-z0-9+/=]*$/.test(s.png.slice(PREFIX.length))) return null;
  return { png: s.png, slim: !!s.slim };
}
