/** Hand-made pixel art for the HUD (hearts, hunger, armor) and the kit icons. */

export type Sprite = HTMLCanvasElement;

function fromMap(map: string[], palette: Record<string, string>): Sprite {
  const h = map.length;
  const w = map[0].length;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ch = map[y][x];
      const col = palette[ch];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    }
  return c;
}

/** Keeps only the columns [x0, x1) of a sprite. */
function crop(src: Sprite, x0: number, x1: number): Sprite {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  c.getContext('2d')!.drawImage(src, x0, 0, x1 - x0, src.height, x0, 0, x1 - x0, src.height);
  return c;
}

const HEART = [
  '.oo...oo.',
  'offo.offo',
  'ohffoffdo',
  'ohfffffdo',
  '.offffdo.',
  '..offdo..',
  '...odo...',
  '....o....',
  '.........',
];
const HEART_CONTAINER = [
  '.oo...oo.',
  'oeeo.oeeo',
  'oeeeoeeeo',
  'oeeeeeeeo',
  '.oeeeeeo.',
  '..oeeeo..',
  '...oeo...',
  '....o....',
  '.........',
];
const DRUMSTICK = [
  '.....ooo.',
  '....ohlho',
  '...ohmmmo',
  '..ommmmdo',
  '..ommmdo.',
  '.obodddo.',
  'obbboo...',
  'obobo....',
  '.o.o.....',
];
const DRUMSTICK_EMPTY = [
  '.....ooo.',
  '....oeeeo',
  '...oeeeeo',
  '..oeeeeeo',
  '..oeeeeo.',
  '.oeoeeeo.',
  'oeeeoo...',
  'oeoeo....',
  '.o.o.....',
];
const CHEST = [
  '.oo...oo.',
  'ohhooohho',
  'ohffffffo',
  '.offfffo.',
  '.offfffo.',
  '.offfffo.',
  '.offfdfo.',
  '.ooooooo.',
  '.........',
];

export interface HudSprites {
  heartContainer: Sprite;
  heartContainerBlink: Sprite;
  heartFull: Sprite;
  heartHalf: Sprite;
  heartFullBlink: Sprite;
  heartHalfBlink: Sprite;
  goldFull: Sprite;
  goldHalf: Sprite;
  foodFull: Sprite;
  foodHalf: Sprite;
  foodEmpty: Sprite;
  armorFull: Sprite;
  armorHalf: Sprite;
  armorEmpty: Sprite;
  regenIcon: Sprite;
  absorbIcon: Sprite;
}

export function makeHudSprites(): HudSprites {
  const red = { o: '#1b0303', f: '#f01e1e', h: '#ffb1b1', d: '#b50e0e' };
  const redBlink = { o: '#ffffff', f: '#f01e1e', h: '#ffb1b1', d: '#b50e0e' };
  const gold = { o: '#2b1b00', f: '#f5c421', h: '#fff4b3', d: '#c28b00' };
  const heartFull = fromMap(HEART, red);
  const heartFullBlink = fromMap(HEART, redBlink);
  const goldFull = fromMap(HEART, gold);
  const food = { o: '#2a1204', h: '#f2b07a', l: '#ffd9ae', m: '#c56b2c', d: '#8a3f13', b: '#efe7d4' };
  const foodFull = fromMap(DRUMSTICK, food);
  const armorPal = { o: '#1f1f1f', h: '#ffffff', f: '#cfcfcf', d: '#9a9a9a' };
  const armorFull = fromMap(CHEST, armorPal);
  return {
    heartContainer: fromMap(HEART_CONTAINER, { o: '#141414', e: '#3a3a3a' }),
    heartContainerBlink: fromMap(HEART_CONTAINER, { o: '#ffffff', e: '#3a3a3a' }),
    heartFull,
    heartHalf: crop(heartFull, 0, 5),
    heartFullBlink,
    heartHalfBlink: crop(heartFullBlink, 0, 5),
    goldFull,
    goldHalf: crop(goldFull, 0, 5),
    foodFull,
    foodHalf: crop(foodFull, 4, 9),
    foodEmpty: fromMap(DRUMSTICK_EMPTY, { o: '#141414', e: '#3a3a3a' }),
    armorFull,
    armorHalf: crop(armorFull, 0, 5),
    armorEmpty: fromMap(CHEST, { o: '#1f1f1f', h: '#3a3a3a', f: '#3a3a3a', d: '#3a3a3a' }),
    regenIcon: fromMap(HEART, { o: '#3b0a22', f: '#e35ea6', h: '#ffc2e3', d: '#a52a70' }),
    absorbIcon: fromMap(HEART, gold),
  };
}

// ------------------------------------------------------------------ kit icons (16×16)

function canvas16(): [Sprite, (x: number, y: number, c: string) => void] {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  return [
    c,
    (x, y, col) => {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x), Math.round(y), 1, 1);
    },
  ];
}

function potion(liquid: string, dark: string, light: string): Sprite {
  const [c, p] = canvas16();
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const dx = x - 7.5;
      const dy = y - 10;
      const d = Math.hypot(dx, dy);
      if (d < 5.2) p(x, y, d > 4.3 ? '#2a2a3a' : dy < -1.5 ? '#cfe3ff' : dx < -1 && dy < 1 ? light : dy > 2 ? dark : liquid);
    }
  for (let y = 2; y < 6; y++) for (let x = 6; x < 10; x++) p(x, y, x === 6 || x === 9 ? '#2a2a3a' : '#d7e8ff');
  for (let x = 6; x < 10; x++) p(x, 1, '#8a5a2b');
  p(8, 8, '#ffffff');
  return c;
}

export function makeKitIcon(kind: string, sword?: Sprite, apple?: Sprite): Sprite {
  if (kind === 'sword' && sword) return sword;
  if (kind === 'uhc' && apple) return apple;
  const [c, p] = canvas16();
  switch (kind) {
    case 'axe': {
      for (let i = 0; i < 11; i++) p(3 + i, 13 - i, i < 8 ? '#6b4a22' : '#2a1a08');
      const head = ['..ooo...', '.odddo..', 'odlddo..', 'odddddo.', '.oddddo.', '..oddo..', '...oo...'];
      head.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch !== '.') p(7 + x, 1 + y, ch === 'o' ? '#0b3b37' : ch === 'l' ? '#b9fff6' : '#35d6c5');
        }),
      );
      break;
    }
    case 'potion':
      return potion('#f24a6b', '#a11c3b', '#ff9fb2');
    case 'neth_potion':
      return potion('#7b2fd6', '#4a1586', '#c39bff');
    case 'crystal': {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const d = Math.abs(x - 7.5) + Math.abs(y - 7.5);
          if (d < 3.5) p(x, y, d < 1.6 ? '#ffd1f4' : '#e25bd0');
          else if (d > 5.5 && d < 7) p(x, y, '#bfe9ff');
          else if (d >= 7 && d < 7.6) p(x, y, '#4a6f86');
        }
      break;
    }
    case 'smp': {
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const d = Math.hypot(x - 7.5, y - 7.5);
          if (d < 6) p(x, y, d > 5 ? '#082a26' : x + y < 12 ? '#3fbfa8' : x + y < 17 ? '#1f8a78' : '#135c50');
        }
      p(5, 5, '#c9fff4');
      p(6, 5, '#c9fff4');
      p(5, 6, '#c9fff4');
      break;
    }
    case 'mace': {
      for (let i = 0; i < 9; i++) p(3 + i, 14 - i, i < 7 ? '#5b3a1e' : '#2e1d0c');
      for (let y = 0; y < 16; y++)
        for (let x = 0; x < 16; x++) {
          const d = Math.hypot(x - 11, y - 4.5);
          if (d < 3.6) p(x, y, d > 2.8 ? '#262626' : x < 11 && y < 5 ? '#d8d8d8' : '#8f8f8f');
        }
      for (const [x, y] of [
        [11, 0],
        [15, 4],
        [7, 4],
        [11, 8],
      ])
        p(x, y, '#5a5a5a');
      break;
    }
    default: {
      for (let y = 3; y < 13; y++) for (let x = 3; x < 13; x++) p(x, y, '#777');
    }
  }
  return c;
}
