import { STRONG_ATTACK_SCALE } from '../core/constants';
import type { Fighter } from '../game/Fighter';
import type { ItemId } from '../game/items';
import { makeHudSprites, type HudSprites, type Sprite } from './sprites';
import type { Settings } from './settings';

const HUD_W = 182;
const HUD_H = 64;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

/**
 * What a landed hit would be right now, using exactly the checks in performAttack:
 * strong = charge > 0.9, sprint-KB = strong && server-side sprinting, crit = strong &&
 * falling && airborne && NOT server-side sprinting. Sprint-KB always wins over a crit.
 */
function nextHit(p: Fighter): { text: string; cls: string } {
  const charge = p.attackStrengthScale(0.5);
  if (charge <= STRONG_ATTACK_SCALE) return { text: `charging ${Math.round(charge * 100)}%`, cls: 'no' };
  if (p.serverSprinting) return { text: 'SPRINT KB', cls: 'kb' };
  if (p.fallDistance > 0 && !p.onGround) return { text: 'CRIT', cls: 'ok' };
  if (!p.onGround) return { text: 'full · still rising', cls: 'mid' };
  return { text: 'full · jump, then hit falling', cls: 'mid' };
}

/** Minecraft-style in-game HUD plus practice overlays (reach, combo, CPS, hit feedback). */
export class HUD {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly attackBar: HTMLDivElement;
  private readonly attackFill: HTMLDivElement;
  private readonly attackFull: HTMLDivElement;
  private readonly eatBar: HTMLDivElement;
  private readonly eatFill: HTMLDivElement;
  private readonly practice: HTMLDivElement;
  private readonly feedback: HTMLDivElement;
  private readonly opponent: HTMLDivElement;
  private readonly oppName: HTMLDivElement;
  private readonly oppHealth: HTMLDivElement;
  private readonly oppAbsorb: HTMLDivElement;
  private readonly oppText: HTMLDivElement;
  private readonly effects: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly sprites: HudSprites;
  private icons: Partial<Record<ItemId, Sprite>> = {};
  private scale = 2;
  private dpr = 1;
  private lastKey = '';
  private feedbackTimer = 0;
  private healthBlinkUntil = 0;
  private lastHealth = 20;
  private displayHealth = 20;
  private tickCount = 0;
  private clicks: number[] = [];
  private centerTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);
    this.sprites = makeHudSprites();
    this.canvas = el('canvas', 'hud-bars', this.root);
    this.ctx = this.canvas.getContext('2d')!;
    el('div', 'crosshair', this.root);
    this.attackBar = el('div', 'attack-bar', this.root);
    this.attackFill = el('div', 'attack-fill', this.attackBar);
    this.attackFull = el('div', 'attack-full', this.root);
    this.eatBar = el('div', 'eat-bar', this.root);
    this.eatFill = el('div', 'eat-fill', this.eatBar);
    this.practice = el('div', 'practice', this.root);
    this.feedback = el('div', 'feedback', this.root);
    this.opponent = el('div', 'opponent', this.root);
    this.oppName = el('div', 'opp-name', this.opponent);
    const bar = el('div', 'opp-bar', this.opponent);
    this.oppHealth = el('div', 'opp-health', bar);
    this.oppAbsorb = el('div', 'opp-absorb', bar);
    this.oppText = el('div', 'opp-text', this.opponent);
    this.effects = el('div', 'effects', this.root);
    this.center = el('div', 'center-text', this.root);
  }

  setIcons(icons: Partial<Record<ItemId, Sprite>>) {
    this.icons = icons;
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  layout(settings: Settings) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const auto = Math.max(1, Math.min(4, Math.floor(w / 320), Math.floor(h / 240)));
    this.scale = settings.guiScale > 0 ? settings.guiScale : auto;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = HUD_W * this.scale * this.dpr;
    this.canvas.height = HUD_H * this.scale * this.dpr;
    this.canvas.style.width = `${HUD_W * this.scale}px`;
    this.canvas.style.height = `${HUD_H * this.scale}px`;
    this.root.style.setProperty('--gui', String(this.scale));
    this.lastKey = '';
  }

  registerClick(now: number) {
    this.clicks.push(now);
  }

  resetRound(player: Fighter) {
    this.lastHealth = this.displayHealth = player.health;
    this.healthBlinkUntil = 0;
    this.feedback.textContent = '';
    this.feedbackTimer = 0;
    this.clicks = [];
    this.lastKey = '';
  }

  /** Called once per game tick. */
  tick(player: Fighter) {
    this.tickCount++;
    const hp = Math.ceil(player.health);
    if (hp < this.lastHealth) this.healthBlinkUntil = this.tickCount + 20;
    else if (hp > this.lastHealth) this.healthBlinkUntil = this.tickCount + 10;
    if (this.tickCount > this.healthBlinkUntil) this.displayHealth = hp;
    this.lastHealth = hp;
    if (this.feedbackTimer > 0 && --this.feedbackTimer === 0) this.feedback.classList.remove('show');
    if (this.centerTimer > 0 && --this.centerTimer === 0) this.center.classList.remove('show');
  }

  showFeedback(text: string, cls: string) {
    this.feedback.textContent = text;
    this.feedback.className = `feedback show ${cls}`;
    this.feedbackTimer = 16;
  }

  showCenter(text: string, cls = '', ticks = 30) {
    this.center.textContent = text;
    this.center.className = `center-text show ${cls}`;
    this.centerTimer = ticks;
  }

  update(
    player: Fighter,
    bot: Fighter,
    settings: Settings,
    info: {
      aimingAtBot: boolean;
      botName: string;
      botColor: string;
      botStatus: string;
      lastReach: number | null;
      now: number;
    },
  ) {
    // ---- crosshair + attack indicator (Gui.renderCrosshair)
    const charge = player.attackStrengthScale(0);
    const fullAndAiming = info.aimingAtBot && charge >= 1 && player.attackDelay() > 5;
    this.attackFull.style.display = fullAndAiming ? 'block' : 'none';
    this.attackBar.style.display = !fullAndAiming && charge < 1 ? 'block' : 'none';
    this.attackFill.style.width = `${Math.min(100, (Math.floor(charge * 17) / 16) * 100)}%`;

    const eating = player.usingItem;
    this.eatBar.style.display = eating ? 'block' : 'none';
    if (eating) this.eatFill.style.width = `${(1 - player.useItemRemaining / player.useItemDuration) * 100}%`;

    // ---- practice overlay
    this.clicks = this.clicks.filter((t) => info.now - t < 1000);
    const lines: string[] = [];
    if (settings.showReach) lines.push(`<b>Reach</b> ${info.lastReach !== null ? info.lastReach.toFixed(2) : '—'}`);
    if (settings.showCombo) lines.push(`<b>Combo</b> ${player.stats.combo}`);
    if (settings.showCps) lines.push(`<b>CPS</b> ${this.clicks.length}`);
    if (settings.showNextHit) {
      const n = nextHit(player);
      lines.push(`<b>Next hit</b> <span class="${n.cls}">${n.text}</span>`);
    }
    const ready = player.serverSprinting;
    lines.push(
      `<b>Sprint KB</b> <span class="${ready ? 'ok' : 'no'}">${ready ? 'ready' : player.sprinting ? 'W-tap!' : 'off'}</span>`,
    );
    const html = lines.join('<br>');
    if (this.practice.innerHTML !== html) this.practice.innerHTML = html;

    // ---- opponent bar
    this.opponent.style.display = settings.showOpponentBar ? '' : 'none';
    if (settings.showOpponentBar) {
      this.oppName.textContent = info.botName;
      this.oppName.style.color = info.botColor;
      this.oppHealth.style.width = `${(Math.max(0, bot.health) / bot.maxHealth) * 100}%`;
      this.oppAbsorb.style.width = `${(bot.absorption / bot.maxHealth) * 100}%`;
      const t = `${(Math.max(0, bot.health) / 2).toFixed(1)} ❤${bot.absorption > 0 ? ` +${(bot.absorption / 2).toFixed(1)}` : ''}${info.botStatus ? ` · ${info.botStatus}` : ''}`;
      if (this.oppText.textContent !== t) this.oppText.textContent = t;
    }

    // ---- effects (top right)
    const eff: string[] = [];
    for (const [id, e] of player.effects) {
      const secs = Math.ceil(e.duration / 20);
      const time = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const name = id === 'regeneration' ? `Regeneration ${e.amplifier === 1 ? 'II' : 'I'}` : 'Absorption';
      eff.push(`<div class="effect ${id}"><i></i><span>${name}<br><em>${time}</em></span></div>`);
    }
    const effHtml = eff.join('');
    if (this.effects.innerHTML !== effHtml) this.effects.innerHTML = effHtml;

    this.drawBars(player);
  }

  private drawBars(p: Fighter) {
    const hp = Math.ceil(Math.max(0, p.health));
    const abs = Math.ceil(p.absorption);
    const regen = p.effects.has('regeneration');
    const blinking = this.healthBlinkUntil > this.tickCount && Math.floor((this.healthBlinkUntil - this.tickCount) / 3) % 2 === 1;
    const key = [
      hp,
      abs,
      p.food.level,
      p.food.saturation <= 0 ? this.tickCount : 0,
      regen ? this.tickCount : 0,
      hp <= 4 ? this.tickCount : 0,
      blinking,
      this.displayHealth,
      p.selected,
      p.hotbar.map((s) => (s ? `${s.id}${s.count}` : '-')).join(','),
      p.armor.points,
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const c = this.ctx;
    const k = this.scale * this.dpr;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, HUD_W, HUD_H);
    const bottom = HUD_H;
    const draw = (s: Sprite, x: number, y: number) => c.drawImage(s, x, y);
    const rand = (seed: number) => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };

    // Hotbar
    const hy = bottom - 22;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(0, hy, HUD_W, 22);
    c.fillStyle = '#595959';
    c.fillRect(0, hy, HUD_W, 1);
    c.fillRect(0, hy + 21, HUD_W, 1);
    c.fillRect(0, hy, 1, 22);
    c.fillRect(HUD_W - 1, hy, 1, 22);
    for (let i = 0; i < 9; i++) {
      const x = 1 + i * 20;
      c.fillStyle = 'rgba(139,139,139,0.35)';
      c.fillRect(x + 1, hy + 1, 18, 1);
      c.fillRect(x + 1, hy + 1, 1, 18);
      c.fillStyle = 'rgba(20,20,20,0.6)';
      c.fillRect(x + 19, hy + 1, 1, 20);
    }
    for (let i = 0; i < 9; i++) {
      const s = p.hotbar[i];
      if (!s) continue;
      const icon = this.icons[s.id];
      if (icon) c.drawImage(icon, 3 + i * 20, hy + 3, 16, 16);
      if (s.count > 1) {
        c.font = '7px "Pixelify Sans", monospace';
        c.textAlign = 'right';
        c.textBaseline = 'alphabetic';
        c.fillStyle = '#3f3f3f';
        c.fillText(String(s.count), 3 + i * 20 + 18, hy + 20);
        c.fillStyle = '#ffffff';
        c.fillText(String(s.count), 3 + i * 20 + 17, hy + 19);
      }
    }
    // Selection frame
    const sx = -1 + p.selected * 20 + 1;
    c.fillStyle = '#ffffff';
    c.fillRect(sx - 1, hy - 1, 24, 2);
    c.fillRect(sx - 1, hy + 21, 24, 2);
    c.fillRect(sx - 1, hy - 1, 2, 24);
    c.fillRect(sx + 21, hy - 1, 2, 24);
    c.fillStyle = '#9d9d9d';
    c.fillRect(sx + 1, hy + 1, 20, 1);
    c.fillRect(sx + 1, hy + 20, 20, 1);
    c.fillRect(sx + 1, hy + 1, 1, 20);
    c.fillRect(sx + 20, hy + 1, 1, 20);

    // Experience bar (empty — kits start at level 0)
    const xy = bottom - 29;
    c.fillStyle = '#101010';
    c.fillRect(0, xy, HUD_W, 5);
    c.fillStyle = '#2b3d18';
    c.fillRect(1, xy + 1, HUD_W - 2, 3);

    // Hearts (Gui.renderHearts)
    const heartsTop = bottom - 39;
    const absHearts = Math.ceil(abs / 2);
    const slots = 10 + absHearts;
    const rows = Math.ceil(slots / 10);
    const rowH = Math.max(10 - (rows - 2), 3);
    const regenIdx = regen ? this.tickCount % 25 : -1;
    for (let i = slots - 1; i >= 0; i--) {
      const row = Math.floor(i / 10);
      const x = (i % 10) * 8;
      let y = heartsTop - row * rowH;
      if (hp <= 4) y += Math.floor(rand(this.tickCount * 31 + i) * 2);
      if (i === regenIdx) y -= 2;
      draw(blinking ? this.sprites.heartContainerBlink : this.sprites.heartContainer, x, y);
      if (i < 10) {
        if (blinking && i * 2 < this.displayHealth) {
          if (i * 2 + 1 < this.displayHealth) draw(this.sprites.heartFullBlink, x, y);
          else draw(this.sprites.heartHalfBlink, x, y);
        }
        if (i * 2 + 1 < hp) draw(this.sprites.heartFull, x, y);
        else if (i * 2 + 1 === hp) draw(this.sprites.heartHalf, x, y);
      } else {
        const j = i - 10;
        if (j * 2 + 1 < abs) draw(this.sprites.goldFull, x, y);
        else if (j * 2 + 1 === abs) draw(this.sprites.goldHalf, x, y);
      }
    }

    // Armor
    const armor = p.armor.points;
    if (armor > 0) {
      const ay = heartsTop - (rows - 1) * rowH - 10;
      for (let i = 0; i < 10; i++) {
        const x = i * 8;
        if (i * 2 + 1 < armor) draw(this.sprites.armorFull, x, ay);
        else if (i * 2 + 1 === armor) draw(this.sprites.armorHalf, x, ay);
        else draw(this.sprites.armorEmpty, x, ay);
      }
    }

    // Hunger
    const food = p.food.level;
    for (let i = 0; i < 10; i++) {
      const x = HUD_W - i * 8 - 9;
      let y = heartsTop;
      if (p.food.saturation <= 0 && this.tickCount % (food * 3 + 1) === 0) y += Math.floor(rand(this.tickCount + i * 7) * 3) - 1;
      draw(this.sprites.foodEmpty, x, y);
      if (i * 2 + 1 < food) draw(this.sprites.foodFull, x, y);
      else if (i * 2 + 1 === food) draw(this.sprites.foodHalf, x, y);
    }
  }
}
