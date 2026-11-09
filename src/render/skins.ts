import * as THREE from 'three';
import { cleanSkin, SKIN_MAX, type Skin } from '../net/skin';

export { cleanSkin, SKIN_MAX, type Skin };

/**
 * Player skins: a standard Minecraft skin PNG (64×64, or the old 64×32 layout), "classic" (4 px
 * arms, Steve) or "slim" (3 px arms, Alex). Yours is kept in localStorage and sent to the people
 * you play online, so they see it too. Without one, the game's default player is drawn.
 */

const KEY = 'pvp.skin';

export function loadSkin(): Skin | null {
  try {
    return cleanSkin(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    return null;
  }
}

export function saveSkin(s: Skin | null) {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the skin lasts until the page closes.
  }
}

/** Copies a w×h rectangle, mirrored left-to-right (the old layout's left limbs from the right ones). */
function copyMirrored(x: CanvasRenderingContext2D, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
  x.save();
  x.translate(dx + w, dy);
  x.scale(-1, 1);
  x.drawImage(x.canvas, sx, sy, w, h, 0, 0, w, h);
  x.restore();
}

/**
 * Any accepted skin image → a clean 64×64 canvas, as vanilla's skin loader does: the old 64×32
 * layout gets its left arm and leg (mirrored copies of the right ones), the base layer is made
 * fully opaque, and an old skin's hat that is solid all over is cleared (old skins filled it).
 * HD skins (128×128, …) are scaled down. Throws for an image that isn't a skin.
 */
export function normalizeSkin(img: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const { width: w, height: h } = img;
  const legacy = w === h * 2;
  if (!(w === h || legacy) || w < 64 || w > 1024 || w % 64) throw new Error(`That isn't a Minecraft skin (it's ${w}×${h}; skins are 64×64 or 64×32).`);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.imageSmoothingEnabled = false;
  x.drawImage(img, 0, 0, w, h, 0, 0, 64, legacy ? 32 : 64);
  if (legacy) {
    // Each limb's six faces, mirrored as a whole: top, bottom, then the four sides.
    const limb = (sx: number, sy: number, dx: number, dy: number) => {
      copyMirrored(x, sx + 4, sy, 4, 4, dx + 4, dy);
      copyMirrored(x, sx + 8, sy, 4, 4, dx + 8, dy);
      copyMirrored(x, sx, sy + 4, 4, 12, dx + 8, dy + 4);
      copyMirrored(x, sx + 4, sy + 4, 4, 12, dx + 4, dy + 4);
      copyMirrored(x, sx + 8, sy + 4, 4, 12, dx, dy + 4);
      copyMirrored(x, sx + 12, sy + 4, 4, 12, dx + 12, dy + 4);
    };
    limb(0, 16, 16, 48); // leg
    limb(40, 16, 32, 48); // arm
  }
  const d = x.getImageData(0, 0, 64, 64);
  const a = (px: number, py: number) => (py * 64 + px) * 4 + 3;
  const opaque = (x0: number, y0: number, x1: number, y1: number) => {
    for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) d.data[a(px, py)] = 255;
  };
  opaque(0, 0, 32, 16);
  opaque(0, 16, 64, 32);
  opaque(16, 48, 48, 64);
  if (legacy) {
    let solid = true;
    for (let py = 0; py < 16 && solid; py++) for (let px = 32; px < 64; px++) if (d.data[a(px, py)] < 128) solid = false;
    if (solid) for (let py = 0; py < 16; py++) for (let px = 32; px < 64; px++) d.data[a(px, py)] = 0;
    // Nothing in the new overlay places.
    for (let py = 32; py < 64; py++) for (let px = 0; px < 64; px++) if (!(py >= 48 && px >= 16 && px < 48)) d.data[a(px, py)] = 0;
  }
  x.putImageData(d, 0, 0);
  return c;
}

/** A slim (Alex) skin leaves the 4th column of the arm's back face empty. */
export function looksSlim(c: HTMLCanvasElement): boolean {
  const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(54, 20, 2, 12).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false;
  return true;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load that image'));
    img.src = src;
  });
}

/** A skin from a PNG file the player picked. */
export async function skinFromFile(file: File): Promise<{ canvas: HTMLCanvasElement; slim: boolean }> {
  const url = URL.createObjectURL(file);
  try {
    const canvas = normalizeSkin(await loadImage(url));
    return { canvas, slim: looksSlim(canvas) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A Minecraft account's current skin, by username (through mc-heads.net, which allows it). */
export async function skinFromUsername(name: string): Promise<{ canvas: HTMLCanvasElement; slim: boolean }> {
  const n = name.trim();
  if (!/^[A-Za-z0-9_]{1,16}$/.test(n)) throw new Error('Minecraft usernames are 1–16 letters, digits or _');
  let img: HTMLImageElement;
  try {
    img = await loadImage(`https://mc-heads.net/skin/${encodeURIComponent(n)}`);
  } catch {
    throw new Error('Could not download that skin (check the name and your connection)');
  }
  const canvas = normalizeSkin(img);
  return { canvas, slim: looksSlim(canvas) };
}

export function toSkin(canvas: HTMLCanvasElement, slim: boolean): Skin {
  const png = canvas.toDataURL('image/png');
  if (png.length > SKIN_MAX) throw new Error('That skin is too detailed to send online');
  return { png, slim };
}

const textures = new Map<string, THREE.Texture>();

/** The skin's texture (made once per skin; it fills in as soon as the image has decoded). */
export function skinTexture(png: string): THREE.Texture {
  let t = textures.get(png);
  if (!t) {
    const img = new Image();
    t = new THREE.Texture(img);
    const tex = t;
    img.onload = () => (tex.needsUpdate = true);
    img.src = png;
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    // Forget the oldest when many players have come and gone.
    if (textures.size > 32) {
      const [k, old] = textures.entries().next().value!;
      old.dispose();
      textures.delete(k);
    }
    textures.set(png, t);
  }
  return t;
}
