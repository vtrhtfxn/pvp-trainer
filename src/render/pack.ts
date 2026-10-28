/**
 * Textures from the Minecraft default resource pack (src/assets/pack), keyed by their path under
 * assets/minecraft/textures without the extension — e.g. "item/diamond_sword".
 * Everything is bundled (and inlined into the single-file build) and decoded once at startup.
 */
const urls = import.meta.glob('../assets/pack/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>;

type PackImage = HTMLImageElement | HTMLCanvasElement;
const images = new Map<string, PackImage>();

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
