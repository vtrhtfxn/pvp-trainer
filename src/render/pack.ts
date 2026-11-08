/**
 * Textures from the Minecraft default resource pack (src/assets/pack), keyed by their path under
 * assets/minecraft/textures without the extension — e.g. "item/diamond_sword".
 * Everything is bundled (and inlined into the single-file build) and decoded once at startup.
 */
const urls = import.meta.glob('../assets/pack/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>;

import { ICON_SPRITES, TEAM_LEATHER, WIDGET_SPRITES, type PackFile, type ParsedPack } from './resourcePack';

type PackImage = HTMLImageElement | HTMLCanvasElement;
const images = new Map<string, PackImage>();
/** The default pack's size of each texture (a resource pack's may be bigger: 32×, 64×…). */
const defaultSizes = new Map<string, [number, number]>();
/** URLs of textures a resource pack replaced (for CSS and <img>). */
const overrideUrls = new Map<string, string>();
/** A resource pack's image → the size of the default texture it replaces. */
const logical = new WeakMap<object, [number, number]>();

/** The size to draw a texture at in GUI pixels (a 32× pack's 18×18 heart: 9×9). */
export function drawSize(img: CanvasImageSource & { width: number; height: number }): [number, number] {
  return logical.get(img) ?? [img.width, img.height];
}

function keyOf(path: string): string {
  return path.replace(/^.*assets\/pack\//, '').replace(/\.png$/, '');
}

export async function loadPack(): Promise<void> {
  await Promise.all(
    Object.entries(urls).map(
      ([path, url]) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            images.set(keyOf(path), img);
            defaultSizes.set(keyOf(path), [img.naturalWidth, img.naturalHeight]);
            resolve();
          };
          // A missing texture falls back to the procedural one; never block startup on it.
          img.onerror = () => resolve();
          img.src = url;
        }),
    ),
  );
}

/** The bundled URL of a pack file, for use in CSS/HTML. */
export function packUrl(name: string): string | undefined {
  const over = overrideUrls.get(name);
  if (over) return over;
  for (const [path, url] of Object.entries(urls)) if (keyOf(path) === name) return url;
  return undefined;
}

export function packImage(name: string): PackImage | undefined {
  return images.get(name);
}

/** Adds a texture built at runtime (e.g. a tinted potion) under a pack-style name. */
export function registerPackImage(name: string, img: PackImage) {
  images.set(name, img);
  pixels.delete(name);
}

const pixels = new Map<string, ImageData>();

/**
 * Reads every small texture's pixels at once (SceneRenderer.prewarm, after the tinted potion and
 * other runtime textures are registered): all of them drawn onto one canvas and
 * read back in a single getImageData. Reading one texture back costs about as much as reading
 * them all (the browser has to sync with the GPU), and doing it the first time a fighter held
 * each item stalled that frame by up to ~100 ms.
 */
export function preloadPixels() {
  const items = [...images].filter(([k, img]) => !pixels.has(k) && img.width <= 64 && img.height <= 64);
  if (!items.length) return;
  const W = 1024;
  let x = 0;
  let y = 0;
  let row = 0;
  const placed: [string, PackImage, number, number][] = [];
  for (const [k, img] of items) {
    if (x + img.width > W) {
      x = 0;
      y += row;
      row = 0;
    }
    placed.push([k, img, x, y]);
    x += img.width;
    row = Math.max(row, img.height);
  }
  const c = document.createElement('canvas');
  c.width = W;
  c.height = y + row;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return;
  for (const [, img, px, py] of placed) ctx.drawImage(img, px, py);
  const all = ctx.getImageData(0, 0, c.width, c.height);
  for (const [k, img, px, py] of placed) {
    const out = new ImageData(img.width, img.height);
    for (let r = 0; r < img.height; r++) {
      const from = ((py + r) * all.width + px) * 4;
      out.data.set(all.data.subarray(from, from + img.width * 4), r * img.width * 4);
    }
    pixels.set(k, out);
  }
}

/** The pixels of a pack texture (for meshing item sprites). */
export function packPixels(name: string): ImageData | null {
  const ready = pixels.get(name);
  if (ready) return ready;
  const img = images.get(name);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height);
  pixels.set(name, data);
  return data;
}

/**
 * Frames in an animated vertical strip (fire, lava): its height over its width — a resource
 * pack's strip may have more or fewer than the default.
 */
export function stripFrames(name: string, fallback: number): number {
  const img = images.get(name);
  return img && img.width > 0 ? Math.max(1, Math.round(img.height / img.width)) : fallback;
}

/** The game's own texture names (what a resource pack can replace). */
export function packKeys(): ReadonlySet<string> {
  return new Set(Object.keys(urls).map(keyOf));
}

/**
 * The size a texture is drawn at, in GUI pixels: the default pack's. A 32× pack's 18×18 heart is
 * drawn in the same 9×9 GUI space (sharper on a high-DPI screen), never twice as big.
 */
export function packSize(name: string): [number, number] | undefined {
  return defaultSizes.get(name);
}

function decode(bytes: Uint8Array): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    img.src = url;
  });
}

async function load(f: PackFile): Promise<HTMLImageElement | null> {
  try {
    return await decode(await f.read());
  } catch {
    return null;
  }
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/**
 * A pack's version of a texture, shaped like the game's: an animated strip (h = n × w) where the
 * game uses a single square picture keeps its first frame only.
 */
function fit(key: string, img: HTMLImageElement): PackImage {
  const def = defaultSizes.get(key);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (def && def[0] === def[1] && h > w && h % w === 0) {
    const [c, ctx] = canvas(w, w);
    ctx.drawImage(img, 0, 0, w, w, 0, 0, w, w);
    return c;
  }
  return img;
}

/** Leather (grey) tinted with a dye colour, with its untinted overlay on top (DyeableLeatherItem). */
function dye(base: HTMLImageElement, overlay: HTMLImageElement | null, color: string): HTMLCanvasElement {
  const [c, ctx] = canvas(base.naturalWidth, base.naturalHeight);
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(base, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  if (overlay) ctx.drawImage(overlay, 0, 0, c.width, c.height);
  return c;
}

/**
 * Puts a resource pack's textures in place of the default ones. Called once at startup, before
 * anything is built from them (item models, block meshes, icons, tinted potions). Returns how
 * many textures it replaced.
 */
export async function applyResourcePack(pack: ParsedPack): Promise<number> {
  let n = 0;
  const put = (key: string, img: PackImage) => {
    images.set(key, img);
    pixels.delete(key);
    const def = defaultSizes.get(key);
    if (def) logical.set(img, def);
    overrideUrls.set(key, img instanceof HTMLCanvasElement ? img.toDataURL() : img.src);
    n++;
  };
  await Promise.all(
    [...pack.textures].map(async ([key, f]) => {
      const img = await load(f);
      if (img) put(key, fit(key, img));
    }),
  );
  // Old packs: the HUD comes from two atlases, cut up here into today's sprites.
  const cut = async (f: PackFile | undefined, spec: Record<string, [number, number, number, number]>) => {
    const atlas = f && (await load(f));
    if (!atlas) return;
    const k = atlas.naturalWidth / 256;
    for (const [key, [x, y, w, h]] of Object.entries(spec)) {
      if (pack.textures.has(key)) continue; // the pack has the modern sprite too
      const [c, ctx] = canvas(w * k, h * k);
      ctx.drawImage(atlas, x * k, y * k, w * k, h * k, 0, 0, c.width, c.height);
      // An empty spot on the atlas keeps the default sprite (some packs only redraw a few).
      const a = ctx.getImageData(0, 0, c.width, c.height).data;
      let seen = false;
      for (let i = 3; i < a.length && !seen; i += 4) seen = a[i] > 0;
      if (seen) put(key, c);
    }
  };
  await cut(pack.atlases.icons, ICON_SPRITES);
  await cut(pack.atlases.widgets, WIDGET_SPRITES);
  // Team armor is the pack's leather, dyed red and blue.
  const leather = new Map<string, HTMLImageElement>();
  await Promise.all(
    [...pack.leather].map(async ([key, f]) => {
      const img = await load(f);
      if (img) leather.set(key, img);
    }),
  );
  for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
    const base = leather.get(`item/leather_${piece}`);
    if (!base) continue;
    for (const team of ['red', 'blue'] as const) put(`item/${team}_leather_${piece}`, dye(base, leather.get(`item/leather_${piece}_overlay`) ?? null, TEAM_LEATHER[team]));
  }
  for (const layer of [1, 2]) {
    const base = leather.get(`models/armor/leather_layer_${layer}`);
    if (!base) continue;
    for (const team of ['red', 'blue'] as const) put(`models/armor/${team}_layer_${layer}`, dye(base, leather.get(`models/armor/leather_layer_${layer}_overlay`) ?? null, TEAM_LEATHER[team]));
  }
  return n;
}
