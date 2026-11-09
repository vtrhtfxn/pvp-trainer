import { normalizeSkin, skinFromFile, skinFromUsername, toSkin, type Skin } from '../render/skins';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

/** [skin x, y, w, h] → where it goes in the flat preview (front or back), 16×32 px figure. */
type Rect = [number, number, number, number, number, number];

/** The flat front view: base layer then outer layer, like the skin site previews. */
function frontRects(slim: boolean): Rect[] {
  const a = slim ? 3 : 4;
  return [
    [8, 8, 8, 8, 4, 0], // head
    [20, 20, 8, 12, 4, 8], // body
    [44, 20, a, 12, 4 - a, 8], // right arm (on the left of the picture)
    [36, 52, a, 12, 12, 8], // left arm
    [4, 20, 4, 12, 4, 20], // right leg
    [20, 52, 4, 12, 8, 20], // left leg
    [40, 8, 8, 8, 4, 0], // hat
    [20, 36, 8, 12, 4, 8], // jacket
    [44, 36, a, 12, 4 - a, 8],
    [52, 52, a, 12, 12, 8],
    [4, 36, 4, 12, 4, 20],
    [4, 52, 4, 12, 8, 20],
  ];
}

function backRects(slim: boolean): Rect[] {
  const a = slim ? 3 : 4;
  return [
    [24, 8, 8, 8, 4, 0],
    [32, 20, 8, 12, 4, 8],
    [48 + a, 20, a, 12, 12, 8], // right arm's back (on the right from behind)
    [40 + a, 52, a, 12, 4 - a, 8], // left arm's back
    [12, 20, 4, 12, 8, 20],
    [28, 52, 4, 12, 4, 20],
    [56, 8, 8, 8, 4, 0],
    [32, 36, 8, 12, 4, 8],
    [48 + a, 36, a, 12, 12, 8],
    [56 + a, 52, a, 12, 4 - a, 8],
    [12, 36, 4, 12, 8, 20],
    [12, 52, 4, 12, 4, 20],
  ];
}

function drawFigure(src: HTMLCanvasElement, out: HTMLCanvasElement, rects: Rect[]) {
  const x = out.getContext('2d')!;
  x.imageSmoothingEnabled = false;
  x.clearRect(0, 0, out.width, out.height);
  const s = out.width / 16;
  for (const [sx, sy, w, hh, dx, dy] of rects) x.drawImage(src, sx, sy, w, hh, dx * s, dy * s, w * s, hh * s);
}

function canvasOf(png: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(normalizeSkin(img));
    img.onerror = () => reject(new Error('bad skin'));
    img.src = png;
  });
}

/**
 * Options → Skin: upload a skin PNG or get a Minecraft player's skin by username, pick classic
 * (Steve) or slim (Alex) arms, or go back to the default. Online, the others see it too.
 */
export function renderSkinPicker(body: HTMLElement, sound: () => void, current: () => Skin | null, set: (s: Skin | null) => void) {
  const box = h('div', 'rp skin');
  body.append(box);
  const status = h('div', 'rp-status', '');
  const front = h('canvas', 'skin-fig');
  const back = h('canvas', 'skin-fig');
  front.width = back.width = 128;
  front.height = back.height = 256;
  const none = h('div', 'skin-none', 'Default player');
  const figs = h('div', 'skin-figs', front, back, none);

  let canvas: HTMLCanvasElement | null = null;
  const paint = () => {
    const s = current();
    front.style.display = back.style.display = canvas ? '' : 'none';
    none.style.display = canvas ? 'none' : '';
    if (canvas && s) {
      drawFigure(canvas, front, frontRects(s.slim));
      drawFigure(canvas, back, backRects(s.slim));
    }
    classic.classList.toggle('on', !!s && !s.slim);
    slim.classList.toggle('on', !!s && s.slim);
    classic.disabled = slim.disabled = reset.disabled = !s;
  };
  const use = (c: HTMLCanvasElement, isSlim: boolean, what: string) => {
    try {
      set(toSkin(c, isSlim));
      canvas = c;
      status.textContent = `Now wearing ${what}${isSlim ? ' (slim arms)' : ''}.`;
    } catch (e) {
      status.textContent = (e as Error).message;
    }
    paint();
  };

  const file = h('input', '');
  file.type = 'file';
  file.accept = 'image/png,.png';
  file.style.display = 'none';
  const upload = h('button', 'mc-btn', 'Upload Skin (.png)…');
  upload.addEventListener('click', () => {
    sound();
    file.click();
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    try {
      const got = await skinFromFile(f);
      use(got.canvas, got.slim, `“${f.name.replace(/\.png$/i, '')}”`);
    } catch (e) {
      status.textContent = (e as Error).message || 'That file could not be read.';
    }
  });

  const name = h('input', 'mc-input skin-name');
  name.placeholder = 'Minecraft username';
  name.maxLength = 16;
  const get = h('button', 'mc-btn', 'Get Skin');
  const fetchSkin = async () => {
    sound();
    status.textContent = `Getting ${name.value.trim()}'s skin…`;
    try {
      const got = await skinFromUsername(name.value);
      use(got.canvas, got.slim, `${name.value.trim()}'s skin`);
    } catch (e) {
      status.textContent = (e as Error).message;
    }
  };
  get.addEventListener('click', () => void fetchSkin());
  name.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') void fetchSkin();
  });

  const classic = h('button', 'mc-btn skin-arm', 'Classic arms');
  const slim = h('button', 'mc-btn skin-arm', 'Slim arms');
  for (const [b, v] of [
    [classic, false],
    [slim, true],
  ] as const) {
    b.addEventListener('click', () => {
      sound();
      const s = current();
      if (s && s.slim !== v) set({ png: s.png, slim: v });
      paint();
    });
  }
  const reset = h('button', 'mc-btn', 'Use Default');
  reset.addEventListener('click', () => {
    sound();
    set(null);
    canvas = null;
    status.textContent = 'Back to the default player.';
    paint();
  });

  box.append(
    h('div', 'rp-intro', 'Upload a Minecraft skin (a 64×64 or old 64×32 .png from any skin site), or type a Minecraft username to wear that player’s skin. Online, the people you play see it too.'),
    h('div', 'rp-actions', upload, file, name, get),
    h('div', 'skin-main', figs, h('div', 'skin-side', h('div', 'rp-actions', classic, slim), h('div', 'rp-actions', reset))),
    status,
  );
  const s = current();
  if (s) {
    void canvasOf(s.png)
      .then((c) => {
        canvas = c;
        paint();
      })
      .catch(() => paint());
  }
  paint();
}
