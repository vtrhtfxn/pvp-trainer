import type { Fighter } from '../game/Fighter';
import type { ItemStack } from '../game/items';
import type { SpecCam, Watch } from '../game/Spectate';

const CAMS: SpecCam[] = ['orbit', 'followA', 'followB', 'povA', 'povB', 'free'];

/** What each camera is called, with the fighters' names in it. */
function camName(cam: SpecCam, a: string, b: string): string {
  switch (cam) {
    case 'orbit':
      return 'Orbit';
    case 'followA':
      return `Follow ${a}`;
    case 'followB':
      return `Follow ${b}`;
    case 'povA':
      return `${a} POV`;
    case 'povB':
      return `${b} POV`;
    default:
      return 'Free cam';
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent.appendChild(e);
  return e;
}

interface Side {
  root: HTMLDivElement;
  name: HTMLDivElement;
  hp: HTMLDivElement;
  abs: HTMLDivElement;
  text: HTMLDivElement;
}

/** The Bot vs Bot overlay: both fighters' health, the round score, camera and speed. */
export class SpectatorHud {
  readonly root: HTMLDivElement;
  private readonly sides: [Side, Side];
  private readonly score: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly barFill: HTMLDivElement;
  private readonly barText: HTMLDivElement;
  private bannerTimer = 0;
  private last = '';
  /** Camera buttons (click one, or press its number). */
  private readonly cams: HTMLDivElement;
  private readonly camButtons = new Map<SpecCam, HTMLButtonElement>();
  /** In a POV camera: the watched fighter's hotbar, as they see it. */
  private readonly hotbar: HTMLCanvasElement;
  private hotbarKey = '';

  constructor(
    parent: HTMLElement,
    private readonly onCam: (cam: SpecCam) => void = () => {},
    private readonly icon: (s: ItemStack) => CanvasImageSource | undefined = () => undefined,
  ) {
    this.root = el('div', 'spec-hud', parent);
    const side = (cls: string): Side => {
      const root = el('div', `spec-side ${cls}`, this.root);
      const name = el('div', 'spec-name', root);
      const bar = el('div', 'spec-bar', root);
      const hp = el('div', 'spec-hp', bar);
      const abs = el('div', 'spec-abs', bar);
      const text = el('div', 'spec-text', root);
      return { root, name, hp, abs, text };
    };
    this.sides = [side('left'), side('right')];
    this.score = el('div', 'spec-score', this.root);
    this.banner = el('div', 'spec-banner', this.root);
    this.help = el('div', 'spec-help', this.root);
    this.hotbar = el('canvas', 'spec-hotbar', this.root);
    this.hotbar.width = 9 * 20 + 2;
    this.hotbar.height = 22;
    this.cams = el('div', 'spec-cams', this.root);
    CAMS.forEach((cam, i) => {
      const b = el('button', 'spec-cam', this.cams);
      b.dataset.key = String(i + 1);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onCam(cam);
      });
      this.camButtons.set(cam, b);
    });
    this.bar = el('div', 'spec-progress', this.root);
    this.barFill = el('div', 'spec-progress-fill', this.bar);
    this.barText = el('div', 'spec-progress-text', this.bar);
    this.hide();
  }

  show() {
    this.root.style.display = '';
    this.last = '';
  }

  hide() {
    this.root.style.display = 'none';
  }

  announce(text: string, color: string) {
    this.banner.textContent = text;
    this.banner.style.color = color;
    this.banner.style.opacity = '1';
    this.bannerTimer = 2.2;
  }

  update(s: Watch, dt: number) {
    const paint = (side: Side, f: Fighter, name: string, color: string, label: string) => {
      side.name.textContent = name;
      side.name.style.color = color;
      side.hp.style.width = `${(Math.max(0, f.health) / f.maxHealth) * 100}%`;
      side.abs.style.width = `${Math.min(100, (f.absorption / f.maxHealth) * 100)}%`;
      const totems = f.countItem('totem_of_undying');
      side.text.textContent = `${(Math.max(0, f.health) / 2).toFixed(1)} ❤${f.absorption > 0 ? ` +${(f.absorption / 2).toFixed(1)}` : ''}${totems ? ` · ${totems} totem${totems > 1 ? 's' : ''}` : ''}${label ? ` · ${label}` : ''}`;
    };
    paint(this.sides[0], s.match.player, s.nameA, s.colorA, s.label('a'));
    paint(this.sides[1], s.match.bot, s.nameB, s.colorB, s.label('b'));
    const title = s.title();
    const help = s.help(camName(s.cam, s.nameA, s.nameB));
    const key = `${title}|${help}|${s.cam}|${s.nameA}|${s.nameB}`;
    if (key !== this.last) {
      this.last = key;
      this.score.textContent = title;
      this.help.textContent = help;
      for (const [cam, b] of this.camButtons) {
        b.textContent = `${b.dataset.key} ${camName(cam, s.nameA, s.nameB)}`;
        b.classList.toggle('on', cam === s.cam);
      }
    }
    const pov = s.cam === 'povA' ? s.match.player : s.cam === 'povB' ? s.match.bot : null;
    this.hotbar.style.display = pov ? '' : 'none';
    if (pov) this.paintHotbar(pov);
    const pr = s.progress();
    this.bar.style.display = pr ? '' : 'none';
    if (pr) {
      this.barFill.style.width = `${pr.total ? (pr.at / pr.total) * 100 : 0}%`;
      if (this.barText.textContent !== pr.text) this.barText.textContent = pr.text;
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0.5) this.banner.style.opacity = String(Math.max(0, this.bannerTimer / 0.5));
    }
  }

  /** The watched fighter's nine hotbar slots, the selected one outlined. */
  private paintHotbar(f: Fighter) {
    const key = `${f.selected}|${f.inventory
      .slice(0, 9)
      .map((st) => (st ? `${st.id}:${st.count}` : ''))
      .join(',')}`;
    if (key === this.hotbarKey) return;
    this.hotbarKey = key;
    const ctx = this.hotbar.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.hotbar.width, this.hotbar.height);
    for (let i = 0; i < 9; i++) {
      const x = 1 + i * 20;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, 1, 20, 20);
      ctx.strokeStyle = i === f.selected ? '#ffffff' : '#555';
      ctx.lineWidth = i === f.selected ? 2 : 1;
      ctx.strokeRect(x + 0.5, 1.5, 19, 19);
      const st = f.inventory[i];
      const img = st ? this.icon(st) : undefined;
      if (img) ctx.drawImage(img, x + 2, 3, 16, 16);
      if (st && st.count > 1) {
        ctx.font = '8px monospace';
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'right';
        ctx.fillText(String(st.count), x + 19, 19);
      }
    }
  }
}
