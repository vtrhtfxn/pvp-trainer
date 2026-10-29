/**
 * Kit logos drawn here rather than taken from an item: UHC's heart and Spear Mace's netherite
 * spear. Each is a 16×16 canvas like the item icons.
 */

/** UHC: the red heart with its dark "no regeneration" mark. Rows top to bottom, 7 wide. */
const HEART = ['.RR.RR.', 'RDRRRDR', 'RDDRDDR', 'SRDRDRS', '.SRRRS.', '..SRS..', '...S...'];
const HEART_COLORS: Record<string, string> = { R: '#ff1a1a', D: '#5c0a0a', S: '#c41717' };

function canvas16(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

export function uhcLogo(): HTMLCanvasElement {
  const [c, ctx] = canvas16();
  // 7×7 cells at 2 px, centred (a 1 px margin each side).
  HEART.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const col = HEART_COLORS[ch];
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(1 + x * 2, 2 + y * 2, 2, 2);
    }),
  );
  return c;
}

/**
 * Spear Mace: the spear in netherite — its texture with the diamond head turned to netherite's
 * dark greys and purples (the shaft keeps its colours, darkened a little).
 */
export function netheriteSpearLogo(spear: CanvasImageSource | undefined): HTMLCanvasElement | undefined {
  if (!spear) return undefined;
  const [c, ctx] = canvas16();
  ctx.drawImage(spear, 0, 0, 16, 16);
  const img = ctx.getImageData(0, 0, 16, 16);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    const lum = (r * 0.3 + g * 0.59 + b * 0.11) / 255;
    if (b > r + 20) {
      // The diamond head: netherite, light grey-mauve to almost black.
      d[i] = 40 + lum * 120;
      d[i + 1] = 34 + lum * 104;
      d[i + 2] = 40 + lum * 116;
    } else {
      // The shaft: a deep red-brown, like the netherite spear's.
      d[i] = Math.min(255, r * 0.62);
      d[i + 1] = g * 0.42;
      d[i + 2] = b * 0.5;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
