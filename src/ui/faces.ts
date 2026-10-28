/**
 * Little 8×8 pixel-art faces for the versus bar and the match breakdown — like the player heads
 * on a tournament broadcast. You get a Steve face; a bot gets its tier colour for hair and eyes.
 */

const FACE = ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SEPSSPES', 'SSSNNSSS', 'SSMMMMSS', 'SSMSSMSS'];

function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

const cache = new Map<string, string>();

/** A face as a data URL: 'you' (Steve) or a bot with its tier colour. */
export function faceUrl(kind: 'you' | 'bot', color = '#aaaaaa'): string {
  const key = `${kind}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pal: Record<string, string> =
    kind === 'you'
      ? { H: '#3b2a1a', S: '#b98563', E: '#ffffff', P: '#4a6fcf', N: '#9c6a4c', M: '#6b3e2e' }
      : { H: shade(color, 0.55), S: '#a9a9b5', E: '#ffffff', P: color, N: '#8f8f9c', M: '#5d5d68' };
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d')!;
  FACE.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      ctx.fillStyle = pal[ch];
      ctx.fillRect(x, y, 1, 1);
    }),
  );
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}
