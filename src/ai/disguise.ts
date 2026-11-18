import { Rng } from '../core/rng';

/**
 * Bots that look like people (offline only): a username of the kind players pick, and a skin of
 * their own drawn here from scratch — so the opponent isn't a "HT4 Bot" in the default look.
 * Everything comes from a seed, so a replay shows the same names and skins again.
 */

const WORDS_A = ['Shadow', 'Frost', 'Blaze', 'Night', 'Storm', 'Swift', 'Silent', 'Crimson', 'Dark', 'Lucky', 'Toxic', 'Iron', 'Golden', 'Rapid', 'Lazy', 'Sneaky', 'Wild', 'Cosmic', 'Pixel', 'Turbo', 'Mystic', 'Noble', 'Salty', 'Frozen', 'Hyper'];
const WORDS_B = ['Wolf', 'Fox', 'Viper', 'Hawk', 'Ninja', 'Blade', 'Knight', 'Ghost', 'Tiger', 'Panda', 'Raven', 'Comet', 'Reaper', 'Archer', 'Slayer', 'Bear', 'Falcon', 'Dragon', 'Clutch', 'Combo', 'Crit', 'Strafe', 'Pearl', 'Pot', 'Tap'];
const SHORT = ['zed', 'kio', 'nyx', 'vex', 'lumi', 'rex', 'axo', 'kaz', 'jin', 'ryo', 'milo', 'nova', 'echo', 'juno', 'zaya', 'oli', 'tobi', 'remy', 'kai', 'ezra'];

/** A username like the ones people pick (3–16 letters, digits and _). */
export function botUsername(rng: Rng): string {
  const a = WORDS_A[rng.int(0, WORDS_A.length - 1)];
  const b = WORDS_B[rng.int(0, WORDS_B.length - 1)];
  const s = SHORT[rng.int(0, SHORT.length - 1)];
  const n = String(rng.int(1, 999));
  const pick = rng.int(0, 7);
  let name: string;
  switch (pick) {
    case 0:
      name = `${a}${b}`;
      break;
    case 1:
      name = `${a}${b}${n}`;
      break;
    case 2:
      name = `${a.toLowerCase()}_${b.toLowerCase()}`;
      break;
    case 3:
      name = `xX${b}Xx`;
      break;
    case 4:
      name = `${s}${n}`;
      break;
    case 5:
      name = `${s}_${b.toLowerCase()}`;
      break;
    case 6:
      name = `${b}${s.charAt(0).toUpperCase()}${s.slice(1)}`;
      break;
    default:
      name = `its${s}`;
  }
  return name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

/** Different usernames for `n` bots. */
export function botUsernames(seed: number, n: number): string[] {
  const rng = new Rng(seed ^ 0x5eed);
  const out: string[] = [];
  while (out.length < n) {
    const name = botUsername(rng);
    if (!out.some((o) => o.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

type RGB = [number, number, number];

const SKIN_TONES: RGB[] = [
  [244, 208, 177],
  [233, 185, 149],
  [208, 156, 117],
  [176, 121, 84],
  [141, 92, 61],
  [104, 66, 44],
];
const HAIR: RGB[] = [
  [40, 28, 20],
  [74, 48, 30],
  [120, 80, 40],
  [196, 158, 92],
  [230, 214, 160],
  [20, 20, 24],
  [150, 40, 30],
  [90, 90, 96],
];
const CLOTH: RGB[] = [
  [40, 90, 170],
  [180, 40, 40],
  [40, 140, 70],
  [30, 30, 36],
  [230, 230, 235],
  [120, 60, 160],
  [230, 150, 30],
  [30, 150, 160],
  [90, 70, 50],
  [200, 60, 120],
  [60, 60, 70],
];
const EYES: RGB[] = [
  [60, 90, 160],
  [70, 50, 30],
  [50, 120, 70],
  [40, 40, 40],
];

/** What a generated skin is made of (exported for tests). */
export interface SkinRecipe {
  skin: RGB;
  hair: RGB;
  eyes: RGB;
  shirt: RGB;
  trim: RGB;
  pants: RGB;
  shoes: RGB;
  /** 0 short, 1 long (down the back of the head), 2 a cap. */
  hairStyle: 0 | 1 | 2;
  sleeves: 'short' | 'long';
  stripe: boolean;
}

export function skinRecipe(rng: Rng): SkinRecipe {
  const pick = <T>(a: readonly T[]) => a[rng.int(0, a.length - 1)];
  const shirt = pick(CLOTH);
  let pants = pick(CLOTH);
  if (pants === shirt) pants = CLOTH[(CLOTH.indexOf(shirt) + 3) % CLOTH.length];
  return {
    skin: pick(SKIN_TONES),
    hair: pick(HAIR),
    eyes: pick(EYES),
    shirt,
    trim: pick(CLOTH),
    pants,
    shoes: pick([[40, 40, 44], [90, 60, 40], [230, 230, 230], [30, 30, 30]] as RGB[]),
    hairStyle: rng.int(0, 2) as 0 | 1 | 2,
    sleeves: rng.chance(0.5) ? 'short' : 'long',
    stripe: rng.chance(0.4),
  };
}

/**
 * Paints a classic (4 px arm) 64×64 skin into `px` (RGBA, 64×64): the standard layout — head at
 * the top left, body, arms and legs below, the left limbs on the bottom half.
 */
export function paintSkin(px: Uint8ClampedArray, r: SkinRecipe, rng: Rng) {
  const set = (x: number, y: number, c: RGB, shade = 1) => {
    const i = (y * 64 + x) * 4;
    // A little per-pixel variation, like a hand-drawn skin.
    const v = shade * (0.93 + rng.next() * 0.1);
    px[i] = Math.min(255, c[0] * v);
    px[i + 1] = Math.min(255, c[1] * v);
    px[i + 2] = Math.min(255, c[2] * v);
    px[i + 3] = 255;
  };
  const rect = (x0: number, y0: number, w: number, h: number, c: RGB, shade = 1) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(x, y, c, shade);
  };
  // Head (base layer): top 8..16,0..8; bottom 16..24,0..8; sides 0..32,8..16 (right, front, left, back).
  rect(0, 0, 32, 16, r.skin);
  rect(8, 0, 8, 8, r.hair); // top
  rect(24, 8, 8, 8, r.hair); // back
  const hairDown = r.hairStyle === 1 ? 6 : 2;
  for (const fx of [0, 8, 16, 24]) rect(fx, 8, 8, fx === 8 ? 2 : fx === 24 ? 8 : hairDown, r.hair); // fringe and sides
  // Face (front = 8..16, 8..16): eyes on row 12, mouth row 14.
  rect(9, 12, 2, 1, [245, 245, 245]);
  rect(13, 12, 2, 1, [245, 245, 245]);
  set(10, 12, r.eyes);
  set(13, 12, r.eyes);
  rect(11, 14, 2, 1, [Math.round(r.skin[0] * 0.7), Math.round(r.skin[1] * 0.55), Math.round(r.skin[2] * 0.5)]);
  if (r.hairStyle === 2) {
    // A cap: the hat layer (32..64, 0..16) — top, front rows and a brim.
    rect(40, 0, 8, 8, r.trim);
    for (const fx of [32, 40, 48, 56]) rect(fx, 8, 8, 3, r.trim);
  }
  // Body (16..40, 16..32): shirt, a stripe across the chest.
  rect(16, 16, 24, 16, r.shirt);
  rect(20, 16, 8, 4, r.shirt, 1.05);
  if (r.stripe) rect(16, 24, 24, 2, r.trim);
  // Arms: right 40..56, 16..32; left 32..48, 48..64. Sleeves, then skin, hands at the bottom.
  for (const [ax, ay] of [
    [40, 16],
    [32, 48],
  ]) {
    rect(ax, ay, 16, 16, r.skin);
    const sleeve = r.sleeves === 'long' ? 11 : 5;
    rect(ax, ay + 4, 16, sleeve, r.shirt);
    rect(ax + 4, ay, 4, 4, r.shirt); // shoulder top (the face beside it is the underside of the hand)
  }
  // Legs: right 0..16, 16..32; left 16..32, 48..64. Trousers, shoes at the bottom.
  for (const [lx, ly] of [
    [0, 16],
    [16, 48],
  ]) {
    rect(lx, ly, 16, 16, r.pants);
    rect(lx, ly + 13, 16, 3, r.shoes);
    rect(lx + 8, ly, 4, 4, r.shoes); // soles
  }
}

/**
 * A generated skin as a PNG data URL, and its face (8×8, the hat layer on top) for the versus
 * bar. Needs a canvas: in the browser.
 */
export function generateSkin(seed: number): { png: string; face: string } | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(64, 64);
  const rng = new Rng(seed);
  paintSkin(img.data, skinRecipe(rng), rng);
  ctx.putImageData(img, 0, 0);
  const png = c.toDataURL('image/png');
  const f = document.createElement('canvas');
  f.width = f.height = 8;
  const fx = f.getContext('2d');
  if (!fx) return null;
  fx.drawImage(c, 8, 8, 8, 8, 0, 0, 8, 8);
  fx.drawImage(c, 40, 8, 8, 8, 0, 0, 8, 8);
  return { png, face: f.toDataURL('image/png') };
}
