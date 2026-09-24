import type { ItemStack } from '../game/items';
import { POTIONS, durabilityFraction, isEnchanted, type PotionId } from '../game/items';
import { packImage, registerPackImage } from './pack';

/** Pack texture shown for a stack in the GUI (and meshed for the hand). */
export function itemTextureName(s: Pick<ItemStack, 'id' | 'charged' | 'potion'>): string {
  if (s.id === 'crossbow') return s.charged ? 'item/crossbow_arrow' : 'item/crossbow_standby';
  if (s.id === 'splash_potion') return potionTexture(s.potion ?? 'healing');
  return `item/${s.id}`;
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
  else {
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
