import type { Fighter } from '../game/Fighter';
import type { SpecCam, Watch } from '../game/Spectate';

const CAM_NAMES: Record<SpecCam, string> = {
  orbit: 'Orbit',
  followA: 'Follow ◀',
  followB: 'Follow ▶',
  povA: 'Eyes ◀',
  povB: 'Eyes ▶',
};

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

  constructor(parent: HTMLElement) {
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
    const help = s.help(CAM_NAMES[s.cam]);
    const key = `${title}|${help}`;
    if (key !== this.last) {
      this.last = key;
      this.score.textContent = title;
      this.help.textContent = help;
    }
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
}
