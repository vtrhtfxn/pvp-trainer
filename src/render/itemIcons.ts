import type { ItemStack } from '../game/items';
import { ITEMS, POTIONS, durabilityFraction, isEnchanted, type PotionId } from '../game/items';
import { packImage, registerPackImage } from './pack';

/** Pack texture shown for a stack in the GUI (and meshed for the hand). */
export function itemTextureName(s: Pick<ItemStack, 'id' | 'charged' | 'potion'>): string {
  if (s.id === 'crossbow') return s.charged ? 'item/crossbow_arrow' : 'item/crossbow_standby';
  if (s.id === 'splash_potion') return potionTexture(s.potion ?? 'healing');
  if (s.id === 'tipped_arrow') return tippedArrowTexture(s.potion ?? 'slow_falling');
  if (s.id === 'respawn_anchor') return 'block/respawn_anchor_side0';
  if (s.id === 'ender_chest') return enderChestFace();
  // Block items use their block texture (a cube in the GUI and the hand; a flat sprite for webs).
  if (ITEMS[s.id].places !== undefined) return `block/${s.id}`;
  return `item/${s.id}`;
}

/** Block items drawn as a little isometric cube (the vanilla GUI block model). */
export function isCubeItem(id: string): boolean {
  return id === 'oak_planks' || id === 'cobblestone' || id === 'obsidian' || id === 'glowstone' || id === 'respawn_anchor' || id === 'ender_chest';
}

/** Top texture of a cube item when it differs from its sides. */
function cubeTop(id: string): string | null {
  if (id === 'respawn_anchor') return 'block/respawn_anchor_top_off';
  if (id === 'ender_chest') return enderChestLid();
  return null;
}

/** The first 16×16 frame of a pack texture (animated ones are vertical strips). */
function frame(name: string): HTMLCanvasElement | null {
  const img = packImage(name);
  if (!img) return null;
  const [c, ctx] = blank();
  ctx.drawImage(img, 0, 0, img.width, img.width, 0, 0, 16, 16);
  return c;
}

/** Ender chest front, assembled from the chest entity texture (lid front over body front). */
function enderChestFace(): string {
  const name = 'item/ender_chest_face';
  if (packImage(name)) return name;
  const tex = packImage('entity/chest/ender');
  const [c, ctx] = blank();
  if (tex) {
    const k = tex.width / 64;
    ctx.drawImage(tex, 14 * k, 14 * k, 14 * k, 5 * k, 1, 1, 14, 5);
    ctx.drawImage(tex, 14 * k, 33 * k, 14 * k, 10 * k, 1, 6, 14, 10);
    ctx.drawImage(tex, 1 * k, 1 * k, 2 * k, 4 * k, 7, 4, 2, 4);
  }
  registerPackImage(name, c);
  return name;
}

function enderChestLid(): string {
  const name = 'item/ender_chest_lid';
  if (packImage(name)) return name;
  const tex = packImage('entity/chest/ender');
  const [c, ctx] = blank();
  if (tex) {
    const k = tex.width / 64;
    ctx.drawImage(tex, 14 * k, 0, 14 * k, 14 * k, 1, 1, 14, 14);
  }
  registerPackImage(name, c);
  return name;
}

/** Tipped arrows: the arrow head tinted with the potion colour over the shaft. */
export function tippedArrowTexture(potion: PotionId): string {
  const name = `item/tipped_arrow_${potion}`;
  if (packImage(name)) return name;
  const base = packImage('item/tipped_arrow_base');
  const head = packImage('item/tipped_arrow_head');
  if (!base || !head) return 'item/arrow';
  const [c, ctx] = blank();
  ctx.drawImage(head, 0, 0, 16, 16);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `#${POTIONS[potion].color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, 16, 16);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(head, 0, 0, 16, 16);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.drawImage(base, 0, 0, 16, 16);
  registerPackImage(name, c);
  return name;
}

/**
 * Isometric 16×16 cube: top, left and right faces of `top`/`side` textures with vanilla's GUI
 * shading (top 1, left 0.8, right 0.6).
 */
export function isoCube(top: CanvasImageSource, left: CanvasImageSource, right: CanvasImageSource = left): HTMLCanvasElement {
  const [c, ctx] = blank();
  const face = (img: CanvasImageSource, shade: number, m: [number, number, number, number, number, number]) => {
    const [fc, fx] = blank();
    fx.drawImage(img, 0, 0, 16, 16);
    fx.globalCompositeOperation = 'source-atop';
    fx.fillStyle = `rgba(0,0,0,${1 - shade})`;
    fx.fillRect(0, 0, 16, 16);
    ctx.setTransform(...m);
    ctx.drawImage(fc, 0, 0);
  };
  face(top, 1, [0.4375, -0.21875, 0.4375, 0.21875, 1, 4.5]);
  face(left, 0.8, [0.4375, 0.21875, 0, 0.46875, 1, 4.5]);
  face(right, 0.6, [0.4375, -0.21875, 0, 0.46875, 8, 8]);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

// A golden head: a Steve-style 8×8 head painted in gold (H hair, S skin, E eye, P pupil, M mouth).
const HEAD_FACE = ['HHHHHHHH', 'HHHHHHHH', 'HSSSSSSH', 'SSSSSSSS', 'SEPSSPES', 'SSSMMSSS', 'SSMSSMSS', 'SSMMMMSS'];
const HEAD_SIDE = ['HHHHHHHH', 'HHHHHHHH', 'HHHHHHSS', 'HHHHSSSS', 'HHSSSSSS', 'HSSSSSSS', 'SSSSSSSS', 'SSSSSSSS'];
const HEAD_TOP = ['HHHHHHHH', 'HHhHHHhH', 'HHHHhHHH', 'hHHHHHHH', 'HHHhHHHh', 'HHHHHHHH', 'HhHHHhHH', 'HHHHHHHH'];
const HEAD_COLORS: Record<string, string> = {
  H: '#9a7410',
  h: '#b88c1c',
  S: '#f2c53d',
  E: '#fff6c8',
  P: '#6b4300',
  M: '#b07a14',
};

function paintHead(rows: string[]): HTMLCanvasElement {
  const [c, ctx] = blank();
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      ctx.fillStyle = HEAD_COLORS[ch];
      ctx.fillRect(x * 2, y * 2, 2, 2);
    }),
  );
  return c;
}

/**
 * The server's Golden Head is a golden player-head item. Drawn as an isometric head and
 * registered as the pack texture item/golden_head (icons, hand, dropped items all use it).
 */
export function registerGoldenHead() {
  registerPackImage('item/golden_head', isoCube(paintHead(HEAD_TOP), paintHead(HEAD_SIDE), paintHead(HEAD_FACE)));
}

/**
 * Splash potions are two layers in vanilla (item/splash_potion.json): the liquid overlay tinted
 * with the potion colour, under the bottle. They are baked into one texture per potion and
 * registered with the pack, so icons, hand meshes and thrown sprites all share it.
 */
export function potionTexture(potion: PotionId): string {
  const name = `item/splash_potion_${potion}`;
  if (packImage(name)) return name;
  const bottle = packImage('item/splash_potion');
  const overlay = packImage('item/potion_overlay');
  if (!bottle || !overlay) return 'item/splash_potion';
  const c = document.createElement('canvas');
  c.width = bottle.width;
  c.height = bottle.height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(overlay, 0, 0);
  // Multiply the (white) overlay by the colour, keeping its alpha.
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = `#${POTIONS[potion].color.toString(16).padStart(6, '0')}`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(overlay, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(bottle, 0, 0);
  registerPackImage(name, c);
  return name;
}

/** ItemRenderer's durability bar: 13 px, green → red, under the item. */
export function drawDurabilityBar(ctx: CanvasRenderingContext2D, st: ItemStack, x: number, y: number) {
  const f = durabilityFraction(st);
  if (f === null) return;
  const w = Math.round(13 * f);
  ctx.fillStyle = '#000';
  ctx.fillRect(x + 2, y + 13, 13, 2);
  ctx.fillStyle = `hsl(${Math.round(f * 120)}, 100%, 50%)`;
  ctx.fillRect(x + 2, y + 13, w, 1);
}

const cache = new Map<string, HTMLCanvasElement>();

function blank(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Shield icon: the front of the plate from the entity texture, like the GUI's 3D model face-on. */
function shieldIcon(): HTMLCanvasElement | undefined {
  const tex = packImage('entity/shield_base_nopattern');
  if (!tex) return undefined;
  const [c, ctx] = blank();
  const k = tex.width / 64;
  // ShieldModel plate: texOffs(0,0), box 12×22×1 → front face at (1,1) size 12×22.
  ctx.drawImage(tex, 1 * k, 1 * k, 12 * k, 22 * k, 3.5, 0, 9, 16);
  // Handle hint and a darker rim, so it reads at 16 px.
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(3.5, 0, 9, 1);
  ctx.fillRect(3.5, 15, 9, 1);
  return c;
}

/** Enchantment glint for GUI icons: a purple sheen clipped to the sprite. */
function glint(src: HTMLCanvasElement): HTMLCanvasElement {
  const [c, ctx] = blank();
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-atop';
  const g = ctx.createLinearGradient(0, 16, 16, 0);
  g.addColorStop(0, 'rgba(128,64,255,0.10)');
  g.addColorStop(0.45, 'rgba(170,110,255,0.45)');
  g.addColorStop(0.6, 'rgba(128,64,255,0.12)');
  g.addColorStop(1, 'rgba(160,90,255,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 16);
  return c;
}

/** 16×16 icon for a stack, or undefined if its texture is missing. */
export function itemIcon(s: ItemStack): HTMLCanvasElement | undefined {
  const tex = s.id === 'shield' ? 'shield' : itemTextureName(s);
  const ench = isEnchanted(s);
  const key = `${tex}${ench ? '+' : ''}`;
  let c = cache.get(key);
  if (c) return c;
  let base: HTMLCanvasElement | undefined;
  if (s.id === 'shield') base = shieldIcon();
  else if (isCubeItem(s.id)) {
    const side = frame(tex);
    const topName = cubeTop(s.id);
    const top = topName ? frame(topName) : side;
    if (side && top) base = isoCube(top, side);
  } else {
    const img = packImage(tex);
    if (img) {
      const [bc, ctx] = blank();
      ctx.drawImage(img, 0, 0, 16, 16);
      base = bc;
    }
  }
  if (!base) return undefined;
  c = ench ? glint(base) : base;
  cache.set(key, c);
  return c;
}

/** Empty-slot outline for armor and the off hand. */
export function emptySlotIcon(kind: 'helmet' | 'chestplate' | 'leggings' | 'boots' | 'shield'): CanvasImageSource | undefined {
  return packImage(`item/empty_armor_slot_${kind}`);
}
