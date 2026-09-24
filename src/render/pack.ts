/**
 * Textures from the Bare Bones resource pack (src/assets/pack), keyed by their path under
 * assets/minecraft/textures without the extension — e.g. "item/diamond_sword".
 * Everything is bundled (and inlined into the single-file build) and decoded once at startup.
 */
const urls = import.meta.glob('../assets/pack/**/*.png', { eager: true, query: '?url', import: 'default' }) as Record<
  string,
  string
>;

const images = new Map<string, HTMLImageElement>();

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

export function packImage(name: string): HTMLImageElement | undefined {
  return images.get(name);
}

/** The pixels of a pack texture (for meshing item sprites). */
export function packPixels(name: string): ImageData | null {
  const img = images.get(name);
  if (!img) return null;
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}
