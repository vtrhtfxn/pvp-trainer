import * as THREE from 'three';
import { Rng } from '../core/rng';
import { packImage } from './pack';

/** Procedurally painted 16×16 textures in the spirit of Minecraft's default pack. */

type Painter = (ctx: CanvasRenderingContext2D, rng: Rng) => void;

function hex(c: string): [number, number, number] {
  const n = parseInt(c.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function px(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, alpha = 1) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 1, 1);
  ctx.globalAlpha = 1;
}

function pick(rng: Rng, palette: string[], weights?: number[]): string {
  if (!weights) return palette[Math.floor(rng.next() * palette.length)];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (let i = 0; i < palette.length; i++) {
    r -= weights[i];
    if (r <= 0) return palette[i];
  }
  return palette[palette.length - 1];
}

function shade(c: string, f: number): string {
  const [r, g, b] = hex(c);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v * f)));
  return `rgb(${cl(r)},${cl(g)},${cl(b)})`;
}

const GRASS = ['#6aa23c', '#78b046', '#83ba4f', '#5f9434', '#8dc25a', '#72a942'];
const DIRT = ['#8a5d3b', '#79512f', '#96684a', '#6a472a', '#9e7453', '#7f5636'];
const STONE = ['#7c7c7c', '#858585', '#747474', '#8e8e8e', '#6d6d6d'];
const BARK = ['#6b5033', '#5b4329', '#76593a', '#4e3924', '#665033'];
const LEAVES = ['#3c7a26', '#4a8a30', '#326b1f', '#579a39', '#2d5f1b'];
const PLANKS = ['#a4834f', '#9b7a47', '#b08e59', '#8e6e40'];
const GLOW = ['#fbe1a2', '#e7bb69', '#c98f41', '#fff3c9', '#ad6d2e', '#f0cc7f'];

const painters: Record<string, Painter> = {
  grass_top(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) px(ctx, x, y, pick(rng, GRASS, [3, 4, 3, 2, 1, 3]));
  },
  dirt(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const c = rng.chance(0.04) ? pick(rng, ['#8a8a8a', '#6f6f6f']) : pick(rng, DIRT, [3, 3, 2, 2, 1, 3]);
        px(ctx, x, y, c);
      }
  },
  grass_side(ctx, rng) {
    painters.dirt(ctx, rng);
    for (let x = 0; x < 16; x++) {
      const depth = 3 + (rng.chance(0.5) ? 1 : 0) + (rng.chance(0.2) ? 1 : 0);
      for (let y = 0; y < depth; y++) px(ctx, x, y, pick(rng, GRASS, [3, 4, 3, 2, 1, 3]));
    }
  },
  stone(ctx, rng) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(ctx, x, y, pick(rng, STONE));
  },
  stone_bricks(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const row = Math.floor(y / 4);
        const off = row % 2 === 0 ? 0 : 4;
        const bx = (x + off) % 8;
        const by = y % 4;
        let c = pick(rng, STONE);
        if (by === 3 || bx === 7) c = shade('#5e5e5e', rng.range(0.9, 1.05));
        else if (by === 0 || bx === 0) c = shade(c, 1.14);
        else if (by === 2 && bx === 6) c = shade(c, 0.85);
        px(ctx, x, y, c);
      }
  },
  mossy_stone_bricks(ctx, rng) {
    painters.stone_bricks(ctx, rng);
    const moss = ['#5b7a38', '#4b6a2e', '#6c8a45', '#3f5c27'];
    for (let i = 0; i < 5; i++) {
      const cx = rng.int(0, 15);
      const cy = rng.int(0, 15);
      const r = rng.range(1.2, 3);
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++)
          if (Math.hypot(x - cx, y - cy) < r && rng.chance(0.8)) px(ctx, x, y, pick(rng, moss));
    }
  },
  cracked_stone_bricks(ctx, rng) {
    painters.stone_bricks(ctx, rng);
    let x = rng.int(2, 13);
    let y = 0;
    while (y < 16) {
      px(ctx, x, y, '#3e3e3e');
      if (rng.chance(0.5)) x += rng.chance(0.5) ? 1 : -1;
      x = Math.max(0, Math.min(15, x));
      y++;
    }
  },
  oak_log(ctx, rng) {
    for (let x = 0; x < 16; x++) {
      const base = pick(rng, BARK);
      for (let y = 0; y < 16; y++) px(ctx, x, y, rng.chance(0.25) ? pick(rng, BARK) : base);
    }
  },
  oak_log_top(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        let c: string;
        if (d > 6.5) c = pick(rng, BARK);
        else c = Math.floor(d) % 2 === 0 ? '#b8935c' : '#a27f4c';
        if (d <= 6.5 && rng.chance(0.15)) c = shade(c, 0.92);
        px(ctx, x, y, c);
      }
  },
  oak_leaves(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) px(ctx, x, y, rng.chance(0.16) ? '#1d3f12' : pick(rng, LEAVES, [3, 3, 2, 2, 1]));
  },
  oak_planks(ctx, rng) {
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c = pick(rng, PLANKS, [4, 3, 2, 1]);
        if (y % 4 === 3) c = '#6e5431';
        if ((y % 8 < 4 && x === 3) || (y % 8 >= 4 && x === 11)) c = y % 4 === 3 ? c : '#7d6039';
        px(ctx, x, y, c);
      }
  },
  glowstone(ctx, rng) {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(ctx, x, y, pick(rng, GLOW, [3, 3, 2, 2, 1, 3]));
  },
  diamond_armor(ctx, rng) {
    const pal = ['#43d9c6', '#2fbfae', '#6fe9da', '#27a597', '#9ff3e8'];
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        let c = pick(rng, pal, [4, 4, 2, 2, 1]);
        if (x === 0 || y === 0) c = '#a8f7ee';
        if (x === 15 || y === 15 || x === 1 || y === 1) c = x === 15 || y === 15 ? '#0f5f58' : '#58e3d3';
        px(ctx, x, y, c);
      }
  },
  diamond_helmet_front(ctx, rng) {
    painters.diamond_armor(ctx, rng);
    // Face opening so the eyes and mouth stay visible
    for (let y = 5; y < 16; y++) for (let x = 3; x < 13; x++) ctx.clearRect(x, y, 1, 1);
    for (let x = 3; x < 13; x++) px(ctx, x, 4, '#0f5f58');
  },
};

const cache = new Map<string, THREE.CanvasTexture>();

// Resource-pack block textures, with the plains biome tints vanilla applies to grass and leaves.
const GRASS_TINT = '#91bd59';
const FOLIAGE_TINT = '#77ab2f';
const PACK_BLOCKS: Record<string, { tex: string; tint?: string; overlay?: string }> = {
  grass_top: { tex: 'block/grass_block_top', tint: GRASS_TINT },
  grass_side: { tex: 'block/grass_block_side', overlay: 'block/grass_block_side_overlay' },
  dirt: { tex: 'block/dirt' },
  stone_bricks: { tex: 'block/stone_bricks' },
  mossy_stone_bricks: { tex: 'block/mossy_stone_bricks' },
  cracked_stone_bricks: { tex: 'block/cracked_stone_bricks' },
  oak_log: { tex: 'block/oak_log' },
  oak_log_top: { tex: 'block/oak_log_top' },
  oak_leaves: { tex: 'block/oak_leaves', tint: FOLIAGE_TINT },
  oak_planks: { tex: 'block/oak_planks' },
  cobblestone: { tex: 'block/cobblestone' },
  obsidian: { tex: 'block/obsidian' },
  stone: { tex: 'block/stone' },
  glowstone: { tex: 'block/glowstone' },
};

/** Multiplies a grayscale texture by a biome colour, keeping its alpha. */
function tinted(img: CanvasImageSource, tint: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, 16, 16);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = tint;
  ctx.fillRect(0, 0, 16, 16);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(img, 0, 0, 16, 16);
  return c;
}

function packCanvas(name: string): HTMLCanvasElement | null {
  const spec = PACK_BLOCKS[name];
  const img = spec && packImage(spec.tex);
  if (!spec || !img) return null;
  if (spec.tint) return tinted(img, spec.tint);
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0, 16, 16);
  const over = spec.overlay && packImage(spec.overlay);
  if (over) ctx.drawImage(tinted(over, GRASS_TINT), 0, 0);
  return c;
}

export function canvasFor(name: string, seed = 1): HTMLCanvasElement {
  const pack = packCanvas(name);
  if (pack) return pack;
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  painters[name](ctx, new Rng(seed * 7919 + name.length * 131 + name.charCodeAt(0)));
  return c;
}

export function blockTexture(name: string): THREE.CanvasTexture {
  let t = cache.get(name);
  if (!t) {
    t = new THREE.CanvasTexture(canvasFor(name));
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestMipmapLinearFilter;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    cache.set(name, t);
  }
  return t;
}

/** Scrolling purple "enchantment glint" texture. */
export function glintTexture(): THREE.CanvasTexture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const rng = new Rng(42);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let s = 0.5 + 0.5 * Math.sin((u * 2 + v) * Math.PI * 4);
      s *= 0.6 + 0.4 * Math.sin((u - v * 2) * Math.PI * 6 + 1.3);
      s = Math.pow(Math.max(0, s), 2.2) * (0.8 + rng.next() * 0.3);
      const i = (y * size + x) * 4;
      img.data[i] = 160 * s;
      img.data[i + 1] = 90 * s;
      img.data[i + 2] = 255 * s;
      img.data[i + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Small white sprites for particles. */
export function particleTexture(kind: 'star' | 'square' | 'smoke'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 8;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  if (kind === 'square') ctx.fillRect(1, 1, 6, 6);
  else if (kind === 'smoke') {
    ctx.fillRect(2, 1, 4, 6);
    ctx.fillRect(1, 2, 6, 4);
  } else {
    ctx.fillRect(3, 0, 2, 8);
    ctx.fillRect(0, 3, 8, 2);
    ctx.fillRect(2, 2, 4, 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}
