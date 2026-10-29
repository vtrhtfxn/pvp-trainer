import * as C from '../core/constants';
import { B } from '../game/Blocks';
import { STRONG_ATTACK_SCALE } from '../core/constants';
import { canSmash, shieldFaces, smashBonus } from '../game/combat';
import { bowPower, type Fighter } from '../game/Fighter';
import { EFFECT_NAMES, ITEMS, formatTicks, type EffectId, type FoodProps, type ItemStack } from '../game/items';
import { estimateRegen } from '../mods/appleskin';
import type { ModManager } from '../mods/registry';
import { drawDurabilityBar, itemIcon } from '../render/itemIcons';
import { packImage, packUrl } from '../render/pack';
import { faceUrl } from './faces';

/** Which fluid the player's eyes are in, if any. */
function eyeFluid(p: Fighter): 'water' | 'lava' | null {
  const b = p.world.blocks;
  if (!b.count) return null;
  const ey = p.pos.y + p.eyeHeight();
  const x = Math.floor(p.pos.x);
  const y = Math.floor(ey);
  const z = Math.floor(p.pos.z);
  const id = b.get(x, y, z);
  if ((id !== B.WATER && id !== B.LAVA) || ey > y + b.fluidHeight(x, y, z)) return null;
  return id === B.WATER ? 'water' : 'lava';
}

const ROMAN = ['', ' II', ' III', ' IV', ' V'];
const effectIconCss = new Map<EffectId, string>();
function effectIcon(id: EffectId): string {
  let css = effectIconCss.get(id);
  if (css === undefined) {
    const url = packUrl(`mob_effect/${id}`);
    css = url ? ` style="background-image:url(${url})"` : '';
    effectIconCss.set(id, css);
  }
  return css;
}
import { makeHudSprites, type HudSprites, type Sprite } from './sprites';
import type { Settings } from './settings';

/** Room either side of the 182-px hotbar for the off-hand slot. */
const PAD = 30;
const HUD_W = 182 + PAD * 2;
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
function nextHit(p: Fighter, target: Fighter): { text: string; cls: string } {
  const charge = p.attackStrengthScale(0.5);
  if (target.isBlocking() && shieldFaces(target, p.pos.x, p.pos.z)) {
    return p.heldDef().disablesShield ? { text: 'AXE · disables the shield', cls: 'ok' } : { text: 'SHIELD UP · swap to axe', cls: 'no' };
  }
  // A mace smash ignores the cooldown for its bonus: show it whenever it would trigger.
  if (canSmash(p)) {
    const e = p.heldStack()?.ench ?? {};
    return { text: `SMASH +${smashBonus(p.fallDistance, e.density ?? 0).toFixed(0)} · ${p.fallDistance.toFixed(1)} blocks`, cls: 'kb' };
  }
  if (p.fallFlying) return { text: 'gliding · swap to the chestplate, then smash', cls: 'mid' };
  // Spear: a jab only with a full bar, 2–4.5 blocks; a lowered spear hits on closing speed.
  if (p.heldDef().spear) {
    if (p.useKind() === 'spear') return { text: p.useTicks() < p.heldDef().spear!.chargeDelay ? 'lowering…' : 'CHARGE · run at them (4.6+ b/s)', cls: 'kb' };
    if (charge < 1) return { text: `spear charging ${Math.round(charge * 100)}%`, cls: 'no' };
    return { text: 'JAB · 2–4.5 blocks · Lunge', cls: 'ok' };
  }
  if (p.world.legacyCombat) {
    // 1.8: sprint knockback and crits stack, and there is no charge to wait for.
    const crit = p.fallDistance > 0 && !p.onGround;
    if (p.serverSprinting) return { text: crit ? 'SPRINT KB + CRIT' : 'SPRINT KB', cls: 'kb' };
    if (crit) return { text: 'CRIT', cls: 'ok' };
    return { text: p.sprinting ? 'sprint not sent yet · W-tap' : 'no sprint · W-tap or block-hit', cls: 'mid' };
  }
  if (charge <= STRONG_ATTACK_SCALE) return { text: `charging ${Math.round(charge * 100)}%`, cls: 'no' };
  if (p.serverSprinting) return { text: 'SPRINT KB', cls: 'kb' };
  if (p.fallDistance > 0 && !p.onGround) return { text: 'CRIT', cls: 'ok' };
  if (!p.onGround) return { text: 'full · still rising', cls: 'mid' };
  return { text: 'full · jump, then hit falling', cls: 'mid' };
}

/** The food in hand that eating would use (main hand first, like vanilla). */
function heldFood(p: Fighter): FoodProps | null {
  for (const st of [p.heldStack(), p.offhand]) {
    const food = st ? ITEMS[st.id].food : undefined;
    if (food) return food;
  }
  return null;
}

type TitleKind = 'title' | 'subtitle' | 'actionbar' | 'clear';
/** Vanilla /title times: 10 ticks in, 70 on screen, 20 out. */
const TITLE_IN = 10;
const TITLE_STAY = 70;
const TITLE_OUT = 20;

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
  readonly practice: HTMLDivElement;
  private readonly feedback: HTMLDivElement;
  private readonly versus: HTMLDivElement;
  private readonly you: VersusSide;
  private readonly them: VersusSide;
  private readonly vsTimer: HTMLDivElement;
  private readonly vsPips: HTMLDivElement;
  private readonly effects: HTMLDivElement;
  private readonly center: HTMLDivElement;
  private readonly fire: HTMLDivElement;
  private readonly totem: HTMLDivElement;
  private readonly fluidTint: HTMLDivElement;
  private readonly titleBox: HTMLDivElement;
  private readonly titleMain: HTMLDivElement;
  private readonly titleSub: HTMLDivElement;
  private readonly actionbar: HTMLDivElement;
  private readonly seriesEl: HTMLDivElement;
  private titleTime = 0;
  private actionTime = 0;
  private readonly sprites: HudSprites;
  /** Last HTML written to the practice panel / effect list (reading innerHTML back is slow). */
  private practiceHtml = '';
  private effectsHtml = '';
  private timerText = '';
  private uses: number[] = [];
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

  constructor(
    parent: HTMLElement,
    private readonly mods: ModManager | null = null,
  ) {
    this.root = el('div', 'hud', parent);
    this.sprites = makeHudSprites();
    this.canvas = el('canvas', 'hud-bars', this.root);
    this.ctx = this.canvas.getContext('2d')!;
    this.attackBar = el('div', 'attack-bar', this.root);
    this.attackFill = el('div', 'attack-fill', this.attackBar);
    this.attackFull = el('div', 'attack-full', this.root);
    this.eatBar = el('div', 'eat-bar', this.root);
    this.eatFill = el('div', 'eat-fill', this.eatBar);
    this.practice = el('div', 'practice', this.root);
    this.feedback = el('div', 'feedback', this.root);
    // The versus bar: you on the left, the opponent on the right, the fight clock between.
    this.versus = el('div', 'versus', this.root);
    this.you = new VersusSide(this.versus, 'left');
    const mid = el('div', 'vs-center', this.versus);
    this.vsTimer = el('div', 'vs-timer', mid);
    this.vsPips = el('div', 'vs-label', mid);
    this.vsPips.textContent = 'VS';
    this.them = new VersusSide(this.versus, 'right');
    this.effects = el('div', 'effects', this.root);
    this.center = el('div', 'center-text', this.root);
    // ScreenEffectRenderer.renderFire: two sheets of flame over the bottom corners.
    // Drawn under the rest of the HUD, like vanilla (the hotbar sits on top of the flames).
    this.fire = el('div', 'fire-overlay', this.root);
    this.root.prepend(this.fire);
    // Head under water or lava: tint the view (vanilla's fog colour).
    this.fluidTint = el('div', 'fluid-tint', this.root);
    this.root.prepend(this.fluidTint);
    const fireUrl = packUrl('block/fire_0');
    for (const side of ['left', 'right']) {
      const d = el('div', `fire-sheet ${side}`, this.fire);
      if (fireUrl) d.style.backgroundImage = `url(${fireUrl})`;
    }
    // GameRenderer.displayItemActivation: the totem flies up out of the screen centre.
    this.totem = el('div', 'totem-pop', this.root);
    this.titleBox = el('div', 'title-box', this.root);
    this.titleMain = el('div', 'title-main', this.titleBox);
    this.titleSub = el('div', 'title-sub', this.titleBox);
    this.actionbar = el('div', 'actionbar', this.root);
    this.seriesEl = el('div', 'series-score', this.root);
    this.seriesEl.style.display = 'none';
  }

  /**
   * The match score between the bars, broadcast style: ◆ for a round won, ◇ still to win —
   * yours on the left, theirs on the right. null shows "VS" (a single duel).
   */
  setPips(score: { you: number; them: number; target: number } | null) {
    if (!score) {
      this.vsPips.textContent = 'VS';
      return;
    }
    const pips = (n: number) => '◆'.repeat(Math.min(n, score.target)) + '◇'.repeat(Math.max(0, score.target - n));
    this.vsPips.innerHTML = `<span class="pips you">${pips(score.you)}</span><span class="pips them">${pips(score.them)}</span>`;
  }

  /** The "first to" score under the opponent's bar; null hides it (a single duel). */
  setSeries(text: string | null) {
    this.seriesEl.textContent = text ?? '';
    this.seriesEl.style.display = text ? '' : 'none';
  }

  /** /title: a big title (with its subtitle), the action bar above the hotbar, or clear. */
  showTitle(kind: TitleKind, text: string) {
    if (kind === 'clear') {
      this.titleTime = 0;
      this.titleMain.textContent = '';
      this.titleSub.textContent = '';
      this.titleBox.style.opacity = '0';
      return;
    }
    if (kind === 'actionbar') {
      this.actionbar.textContent = text;
      this.actionTime = 60;
      this.actionbar.style.opacity = '1';
      return;
    }
    if (kind === 'subtitle') {
      this.titleSub.textContent = text;
      return;
    }
    this.titleMain.textContent = text;
    this.titleTime = TITLE_IN + TITLE_STAY + TITLE_OUT;
    this.paintTitle();
  }

  private paintTitle() {
    const t = this.titleTime;
    const total = TITLE_IN + TITLE_STAY + TITLE_OUT;
    const a = t <= 0 ? 0 : t > TITLE_STAY + TITLE_OUT ? (total - t) / TITLE_IN : t < TITLE_OUT ? t / TITLE_OUT : 1;
    this.titleBox.style.opacity = a.toFixed(2);
    // Vanilla keeps the subtitle for the next title once this one is gone.
    if (t <= 0) this.titleMain.textContent = '';
  }

  /** Clicks in the last second (left, right) for the CPS counter and the Keystrokes mod. */
  cps(now: number): { left: number; right: number } {
    while (this.clicks.length && now - this.clicks[0] >= 1000) this.clicks.shift();
    while (this.uses.length && now - this.uses[0] >= 1000) this.uses.shift();
    return { left: this.clicks.length, right: this.uses.length };
  }

  registerUse(now: number) {
    this.uses.push(now);
  }

  /** Plays the totem-of-undying screen animation. */
  showTotem() {
    const icon = itemIcon({ id: 'totem_of_undying', count: 1 });
    if (!icon) return;
    if (!this.totem.firstChild) {
      const img = document.createElement('img');
      img.src = icon.toDataURL();
      this.totem.appendChild(img);
    }
    this.totem.classList.remove('show');
    void this.totem.offsetWidth; // restart the CSS animation
    this.totem.classList.add('show');
  }

  setVisible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  /** The vanilla crosshair belongs on screen: the HUD is up and no custom crosshair replaces it. */
  get crosshairShown(): boolean {
    return this.root.style.display !== 'none' && !document.body.classList.contains('custom-crosshair');
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

  get guiScale(): number {
    return this.scale;
  }

  registerClick(now: number) {
    this.clicks.push(now);
  }

  resetRound(player: Fighter) {
    this.you.reset();
    this.them.reset();
    this.lastHealth = this.displayHealth = player.health;
    this.healthBlinkUntil = 0;
    this.feedback.textContent = '';
    this.feedbackTimer = 0;
    this.clicks = [];
    this.uses = [];
    this.lastKey = '';
    this.showTitle('clear', '');
    this.actionTime = 0;
    this.actionbar.style.opacity = '0';
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
    if (this.titleTime > 0) {
      this.titleTime--;
      this.paintTitle();
    }
    if (this.actionTime > 0) {
      this.actionTime--;
      this.actionbar.style.opacity = Math.min(1, this.actionTime / 20).toFixed(2);
    }
  }

  showFeedback(text: string, cls: string) {
    this.feedback.textContent = text;
    this.feedback.className = `feedback show ${cls}`;
    this.feedbackTimer = 16;
  }

  /** Takes down the big centre text (VICTORY, a countdown number…) at once. */
  clearCenter() {
    this.centerTimer = 0;
    this.center.classList.remove('show');
  }

  showCenter(text: string, cls = '', ticks = 30) {
    this.center.textContent = text;
    // Restart the pop for every new text (each countdown number lands on its own).
    this.center.className = 'center-text';
    void this.center.offsetWidth;
    this.center.className = `center-text show pop ${cls}`;
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
      /** Tier shown on the opponent's badge (LT5…HT1, or a short label online). */
      botTag: string;
      playerName: string;
      lastReach: number | null;
      now: number;
      firstPerson: boolean;
      /** Ticks fought this round (the clock in the middle of the versus bar). */
      fightTicks: number;
    },
  ) {
    const burning = info.firstPerson && player.onFire && !player.dead && !player.effects.has('fire_resistance');
    this.fire.style.display = burning ? '' : 'none';
    if (burning) {
      const lower = this.mods?.on('lowfire') ? Number(this.mods.cfg('lowfire', 'lower')) : 0;
      const v = lower.toFixed(2);
      if (this.fire.style.getPropertyValue('--fire-lower') !== v) this.fire.style.setProperty('--fire-lower', v);
    }
    const eye = eyeFluid(player);
    this.fluidTint.className = `fluid-tint${info.firstPerson && eye ? ` ${eye}` : ''}`;

    // ---- crosshair + attack indicator (Gui.renderCrosshair)
    const charge = player.attackStrengthScale(0);
    // 1.8 had no attack indicator (and no cooldown to show).
    const fullAndAiming = info.aimingAtBot && charge >= 1 && player.attackDelay() > 5 && !player.world.legacyCombat;
    this.attackFull.style.display = fullAndAiming ? 'block' : 'none';
    this.attackBar.style.display = !fullAndAiming && charge < 1 ? 'block' : 'none';
    this.attackFill.style.width = `${Math.min(100, (Math.floor(charge * 17) / 16) * 100)}%`;

    // Use progress: eating, drawing a bow, loading a crossbow.
    const kind = player.useKind();
    let progress = -1;
    if (kind === 'food') progress = 1 - player.useItemRemaining / player.useItemDuration;
    else if (kind === 'bow') progress = bowPower(player.useTicks());
    else if (kind === 'crossbow') progress = Math.min(1, player.useTicks() / C.CROSSBOW_CHARGE_TICKS);
    this.eatBar.style.display = progress >= 0 ? 'block' : 'none';
    if (progress >= 0) {
      this.eatFill.style.width = `${progress * 100}%`;
      this.eatBar.classList.toggle('full', kind !== 'food' && progress >= 1);
    }

    // ---- practice overlay
    const cps = this.cps(info.now);
    const showPanel = settings.showPracticePanel ? '' : 'none';
    if (this.practice.style.display !== showPanel) this.practice.style.display = showPanel;
    const html = settings.showPracticePanel ? this.practiceLines(player, bot, settings, info.lastReach, cps.left) : '';
    if (this.practiceHtml !== html) {
      this.practiceHtml = html;
      this.practice.innerHTML = html;
    }

    // ---- versus bar
    const showVs = settings.showOpponentBar ? '' : 'none';
    if (this.versus.style.display !== showVs) this.versus.style.display = showVs;
    if (settings.showOpponentBar) {
      this.you.update(player, info.playerName, 'YOU', '#55ffff', '', 'you');
      this.them.update(bot, info.botName, info.botTag, info.botColor, info.botStatus, 'bot');
      const secs = Math.floor(info.fightTicks / 20);
      const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      if (clock !== this.timerText) {
        this.timerText = clock;
        this.vsTimer.textContent = clock;
      }
    }

    // ---- effects (top right)
    let effHtml = '';
    if (settings.showEffects) {
      for (const [id, e] of player.effects) {
        const name = `${EFFECT_NAMES[id]}${ROMAN[e.amplifier] ?? ` ${e.amplifier + 1}`}`;
        // Vanilla blinks the icon through the last 10 seconds.
        const blink = e.duration <= 200 && Math.floor(e.duration / 10) % 2 === 0 ? ' blink' : '';
        effHtml += `<div class="effect ${id}${blink}"><i${effectIcon(id)}></i><span>${name}<br><em>${formatTicks(e.duration)}</em></span></div>`;
      }
    }
    if (this.effectsHtml !== effHtml) {
      this.effectsHtml = effHtml;
      this.effects.innerHTML = effHtml;
    }

    this.drawBars(player);
  }

  /** The practice panel: reach, combo, CPS, the next-hit coach, fire and shield timers, sprint KB. */
  private practiceLines(player: Fighter, bot: Fighter, settings: Settings, lastReach: number | null, cps: number): string {
    const lines: string[] = [];
    if (settings.showReach) lines.push(`<b>Reach</b> ${lastReach !== null ? lastReach.toFixed(2) : '—'}`);
    if (settings.showCombo) lines.push(`<b>Combo</b> ${player.stats.combo}`);
    if (settings.showCps) lines.push(`<b>CPS</b> ${cps}`);
    if (settings.showNextHit) {
      const n = nextHit(player, bot);
      lines.push(`<b>Next hit</b> <span class="${n.cls}">${n.text}</span>`);
      // Attribute swap window: the item in hand is not the one whose attributes apply yet.
      const held = player.heldStack()?.id ?? null;
      if (held !== player.attrId) {
        lines.push(`<b>Attributes</b> <span class="kb">${player.attrId ? ITEMS[player.attrId].name : 'Hand'} (swap)</span>`);
      }
    }
    if (settings.showNextHit && (player.onFire || bot.onFire)) {
      const t = (f: Fighter) =>
        f.onFire ? `<span class="${f.effects.has('fire_resistance') ? 'ok' : 'no'}">${(f.fireTicks / 20).toFixed(1)}s</span>` : '<span class="ok">—</span>';
      lines.push(`<b>Burning</b> ${t(player)} · <b>Bot</b> ${t(bot)}`);
    }
    if (player.shieldCooldown > 0 || bot.shieldCooldown > 0) {
      const t = (n: number) => (n > 0 ? `<span class="no">${(n / 20).toFixed(1)}s</span>` : '<span class="ok">ready</span>');
      lines.push(`<b>Shield</b> ${t(player.shieldCooldown)} · <b>Bot</b> ${t(bot.shieldCooldown)}`);
    }
    const ready = player.serverSprinting;
    lines.push(
      `<b>Sprint KB</b> <span class="${ready ? 'ok' : 'no'}">${ready ? 'ready' : player.sprinting ? 'W-tap!' : 'off'}</span>`,
    );
    return lines.join('<br>');
  }

  private drawBars(p: Fighter) {
    const hp = Math.ceil(Math.max(0, p.health));
    const abs = Math.ceil(p.absorption);
    const regen = p.effects.has('regeneration');
    const blinking = this.healthBlinkUntil > this.tickCount && Math.floor((this.healthBlinkUntil - this.tickCount) / 3) % 2 === 1;
    // Gui.HeartType: wither beats poison; hunger turns the drumsticks green.
    const heartType = p.effects.has('wither') ? 'withered_' : p.effects.has('poison') ? 'poisoned_' : '';
    const hungry = p.effects.has('hunger');
    const mods = this.mods;
    const skin = mods?.on('appleskin') ?? false;
    const cfg = (k: string) => !!mods?.cfg('appleskin', k);
    const food = skin && (cfg('foodPreview') || cfg('healthPreview')) ? heldFood(p) : null;
    const gain = food && cfg('healthPreview') ? estimateRegen(p, food) : 0;
    // AppleSkin's flashing preview: alpha pulses 0.1..0.9 (stepped so the canvas isn't redrawn every frame).
    const flash = food ? Math.round((0.5 + 0.4 * Math.sin(this.tickCount * 0.3)) * 8) / 8 : 0;
    const slotKey = (st: ItemStack | null) => (st ? `${st.id}${st.count}${st.charged ? 'c' : ''}${st.potion ?? ''}${st.damage ?? ''}` : '-');
    let bar = slotKey(p.offhand);
    for (let i = 0; i < 9; i++) bar += `,${slotKey(p.inventory[i])}`;
    const key = [
      hp,
      abs,
      p.maxHealth,
      heartType,
      hungry,
      p.food.level,
      p.food.saturation <= 0 ? this.tickCount : 0,
      regen ? this.tickCount : 0,
      hp <= 4 ? this.tickCount : 0,
      blinking,
      this.displayHealth,
      p.selected,
      bar,
      p.armor.points,
      p.shieldCooldown,
      [...p.cooldowns.values()].map((c) => c.ticks).join(','),
      skin ? `${cfg('saturation') ? p.food.saturation.toFixed(1) : ''}|${cfg('exhaustion') ? p.food.exhaustion.toFixed(2) : ''}|${food ? `${food.nutrition}:${flash}:${gain.toFixed(1)}` : ''}` : '',
    ].join('|');
    if (key === this.lastKey) return;
    this.lastKey = key;

    const c = this.ctx;
    const k = this.scale * this.dpr;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, HUD_W, HUD_H);
    const bottom = HUD_H;
    const draw = (s: Sprite | HTMLImageElement, x: number, y: number) => c.drawImage(s, x, y);
    const pack = (name: string, fallback: Sprite) => packImage(`gui/sprites/hud/${name}`) ?? fallback;
    const rand = (seed: number) => {
      const x = Math.sin(seed * 12.9898) * 43758.5453;
      return x - Math.floor(x);
    };
    const S = this.sprites;

    // Hotbar (Gui.renderItemHotbar)
    const hx = PAD;
    const hy = bottom - 22;
    const hotbarImg = packImage('gui/sprites/hud/hotbar');
    if (hotbarImg) c.drawImage(hotbarImg, hx, hy);
    else this.drawPlainHotbar(hx, hy);
    const selImg = packImage('gui/sprites/hud/hotbar_selection');
    const sx = hx - 1 + p.selected * 20;
    if (selImg) c.drawImage(selImg, sx, hy - 1);
    else this.drawPlainSelection(sx + 1, hy);
    if (p.offhand) {
      const offImg = packImage('gui/sprites/hud/hotbar_offhand_left');
      if (offImg) c.drawImage(offImg, hx - 29, hy - 1);
      this.drawSlotItem(p, p.offhand, hx - 26, hy + 3);
    }
    for (let i = 0; i < 9; i++) {
      const st = p.inventory[i];
      if (st) this.drawSlotItem(p, st, hx + 3 + i * 20, hy + 3);
    }

    // Experience bar (empty — kits start at level 0)
    const xy = bottom - 29;
    c.fillStyle = '#101010';
    c.fillRect(hx, xy, 182, 5);
    c.fillStyle = '#2b3d18';
    c.fillRect(hx + 1, xy + 1, 180, 3);

    // Hearts (Gui.renderHearts): one container per 2 max health, then absorption.
    const heartsTop = bottom - 39;
    const maxHearts = Math.ceil(p.maxHealth / 2);
    const absHearts = Math.ceil(abs / 2);
    const slots = maxHearts + absHearts;
    const rows = Math.ceil(slots / 10);
    const rowH = Math.max(10 - (rows - 2), 3);
    const regenIdx = regen ? this.tickCount % Math.ceil(p.maxHealth + 5) : -1;
    const heart = (name: string, fb: Sprite) => packImage(`gui/sprites/hud/heart/${name}`) ?? fb;
    const full = heart(`${heartType}full`, S.heartFull);
    const half = heart(`${heartType}half`, S.heartHalf);
    const previewTo = Math.min(p.maxHealth, Math.ceil(hp + gain));
    for (let i = slots - 1; i >= 0; i--) {
      const row = Math.floor(i / 10);
      const x = hx + (i % 10) * 8;
      let y = heartsTop - row * rowH;
      if (hp <= 4) y += Math.floor(rand(this.tickCount * 31 + i) * 2);
      if (i === regenIdx) y -= 2;
      draw(blinking ? heart('container_blinking', S.heartContainerBlink) : heart('container', S.heartContainer), x, y);
      if (i < maxHearts) {
        if (blinking && i * 2 < this.displayHealth) {
          if (i * 2 + 1 < this.displayHealth) draw(heart(`${heartType}full_blinking`, S.heartFullBlink), x, y);
          else draw(heart(`${heartType}half_blinking`, S.heartHalfBlink), x, y);
        }
        if (i * 2 + 1 < hp) draw(full, x, y);
        else if (i * 2 + 1 === hp) draw(half, x, y);
        // AppleSkin: the health this food would give back, flashing.
        if (gain > 0 && i * 2 + 2 > hp && i * 2 < previewTo) {
          c.globalAlpha = flash;
          draw(i * 2 + 1 < previewTo ? full : half, x, y);
          c.globalAlpha = 1;
        }
      } else {
        const j = i - maxHearts;
        if (j * 2 + 1 < abs) draw(heart('absorbing_full', S.goldFull), x, y);
        else if (j * 2 + 1 === abs) draw(heart('absorbing_half', S.goldHalf), x, y);
      }
    }

    // Armor
    const armor = p.armor.points;
    if (armor > 0) {
      const ay = heartsTop - (rows - 1) * rowH - 10;
      for (let i = 0; i < 10; i++) {
        const x = hx + i * 8;
        if (i * 2 + 1 < armor) draw(pack('armor_full', S.armorFull), x, ay);
        else if (i * 2 + 1 === armor) draw(pack('armor_half', S.armorHalf), x, ay);
        else draw(pack('armor_empty', S.armorEmpty), x, ay);
      }
    }

    // Hunger (right to left)
    const lvl = p.food.level;
    const suffix = hungry ? '_hunger' : '';
    const fEmpty = pack(`food_empty${suffix}`, S.foodEmpty);
    const fFull = pack(`food_full${suffix}`, S.foodFull);
    const fHalf = pack(`food_half${suffix}`, S.foodHalf);
    // AppleSkin exhaustion underlay: how close the next point of saturation/hunger loss is.
    if (skin && cfg('exhaustion') && p.food.exhaustion > 0) {
      const w = Math.min(1, p.food.exhaustion / 4) * 81;
      c.fillStyle = 'rgba(255,255,255,0.28)';
      c.fillRect(hx + 182 - w, heartsTop, w, 9);
    }
    const foodTo = food && cfg('foodPreview') ? Math.min(20, lvl + food.nutrition) : lvl;
    const satTo = food ? Math.min(p.food.saturation + food.nutrition * food.saturationModifier * 2, foodTo) : p.food.saturation;
    for (let i = 0; i < 10; i++) {
      const x = hx + 182 - i * 8 - 9;
      let y = heartsTop;
      if (p.food.saturation <= 0 && this.tickCount % (lvl * 3 + 1) === 0) y += Math.floor(rand(this.tickCount + i * 7) * 3) - 1;
      draw(fEmpty, x, y);
      if (i * 2 + 1 < lvl) draw(fFull, x, y);
      else if (i * 2 + 1 === lvl) draw(fHalf, x, y);
      if (foodTo > lvl && i * 2 + 2 > lvl && i * 2 < foodTo) {
        c.globalAlpha = flash;
        draw(i * 2 + 1 < foodTo ? fFull : fHalf, x, y);
        c.globalAlpha = 1;
      }
      // AppleSkin saturation overlay: a gold rim, one icon per 2 saturation (quarters in between).
      if (skin && cfg('saturation')) {
        const cur = Math.max(0, Math.min(2, p.food.saturation - i * 2));
        const next = food ? Math.max(0, Math.min(2, satTo - i * 2)) : 0;
        if (cur > 0) this.drawSaturation(x, y, cur, 1);
        if (next > cur) this.drawSaturation(x, y, next, flash);
      }
    }
  }

  /** One AppleSkin saturation rim around a 9×9 drumstick, `amount` 0..2 filling it clockwise. */
  private drawSaturation(x: number, y: number, amount: number, alpha: number) {
    const c = this.ctx;
    c.globalAlpha = alpha;
    c.fillStyle = '#ffd24a';
    const q = Math.ceil(amount * 2); // quarters
    // top edge, right edge, bottom edge, left edge — like AppleSkin's 4 overlay stages
    if (q >= 1) c.fillRect(x + 1, y, 7, 1);
    if (q >= 2) c.fillRect(x + 8, y + 1, 1, 7);
    if (q >= 3) c.fillRect(x + 1, y + 8, 7, 1);
    if (q >= 4) c.fillRect(x, y + 1, 1, 7);
    c.globalAlpha = 1;
  }

  /** One item in a hotbar slot: icon, count, and the white cooldown sweep for shields. */
  private drawSlotItem(p: Fighter, st: ItemStack, x: number, y: number) {
    const c = this.ctx;
    const icon = itemIcon(st);
    if (icon) c.drawImage(icon, x, y, 16, 16);
    const cd = p.cooldowns.get(st.id);
    if (cd || (st.id === 'shield' && p.shieldCooldown > 0)) {
      // ItemRenderer's cooldown sweep: a white veil that shrinks from the top.
      const f = cd ? cd.ticks / cd.total : p.shieldCooldown / C.SHIELD_DISABLE_TICKS;
      const top = Math.floor(16 * (1 - f));
      c.fillStyle = 'rgba(255,255,255,0.5)';
      c.fillRect(x, y + top, 16, 16 - top);
    }
    drawDurabilityBar(c, st, x - 1, y);
    if (st.count > 1) {
      c.font = '8px Minecraft, "Pixelify Sans", monospace';
      c.textAlign = 'right';
      c.textBaseline = 'alphabetic';
      c.fillStyle = '#3f3f3f';
      c.fillText(String(st.count), x + 18, y + 17);
      c.fillStyle = '#ffffff';
      c.fillText(String(st.count), x + 17, y + 16);
    }
  }

  private drawPlainHotbar(x0: number, hy: number) {
    const c = this.ctx;
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(x0, hy, 182, 22);
    c.fillStyle = '#595959';
    c.fillRect(x0, hy, 182, 1);
    c.fillRect(x0, hy + 21, 182, 1);
    c.fillRect(x0, hy, 1, 22);
    c.fillRect(x0 + 181, hy, 1, 22);
  }

  private drawPlainSelection(sx: number, hy: number) {
    const c = this.ctx;
    c.fillStyle = '#ffffff';
    c.fillRect(sx - 1, hy - 1, 24, 2);
    c.fillRect(sx - 1, hy + 21, 24, 2);
    c.fillRect(sx - 1, hy - 1, 2, 24);
    c.fillRect(sx + 21, hy - 1, 2, 24);
  }
}

/**
 * One fighter's half of the versus bar: tier badge, name, a big health number and a segmented,
 * slanted health bar (one segment per heart) whose colour follows the health left. Damage leaves
 * a white trail that drains after a moment; healing flashes; absorption is a gold segment; low
 * health pulses. Under it: the combo counter, totems left and the bot's status.
 */
class VersusSide {
  private readonly root: HTMLDivElement;
  private readonly badge: HTMLDivElement;
  private readonly face: HTMLImageElement;
  private readonly tag: HTMLSpanElement;
  private readonly name: HTMLDivElement;
  private readonly hp: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  private readonly absorb: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private key = '';
  private lastHealth = -1;
  private lastCombo = 0;

  constructor(parent: HTMLElement, side: 'left' | 'right') {
    this.root = el('div', `vs-side ${side}`, parent);
    this.badge = el('div', 'vs-badge', this.root);
    this.face = el('img', 'vs-face', this.badge);
    this.face.alt = '';
    this.tag = el('span', 'vs-tag', this.badge);
    const body = el('div', 'vs-body', this.root);
    const top = el('div', 'vs-top', body);
    this.name = el('div', 'vs-name', top);
    this.hp = el('div', 'vs-hp', top);
    const bar = el('div', 'vs-bar', body);
    this.ghost = el('div', 'vs-ghost', bar);
    this.fill = el('div', 'vs-fill', bar);
    this.absorb = el('div', 'vs-absorb', bar);
    el('div', 'vs-ticks', bar);
    this.sub = el('div', 'vs-sub', body);
  }

  reset() {
    this.key = '';
    this.lastHealth = -1;
    this.lastCombo = 0;
  }

  update(f: Fighter, name: string, tag: string, color: string, status: string, kind: 'you' | 'bot') {
    const health = Math.max(0, f.health);
    const totems = (f.offhand?.id === 'totem_of_undying' ? 1 : 0) + f.countItem('totem_of_undying');
    const combo = f.stats.combo;
    const key = `${name}|${tag}|${color}|${health.toFixed(2)}|${f.absorption}|${f.maxHealth}|${status}|${combo}|${totems}`;
    if (key === this.key) return;
    this.key = key;
    const max = f.maxHealth || 20;
    const frac = Math.min(1, health / max);
    this.name.textContent = name;
    this.tag.textContent = tag;
    this.badge.style.setProperty('--tier', color);
    const src = faceUrl(kind, color);
    if (this.face.getAttribute('src') !== src) this.face.src = src;
    this.hp.innerHTML = `${(health / 2).toFixed(1)}<i>❤</i>${f.absorption > 0 ? `<b>+${(f.absorption / 2).toFixed(1)}</b>` : ''}`;
    this.fill.style.width = `${frac * 100}%`;
    // Green → yellow → red with the health left.
    this.root.style.setProperty('--hue', String(Math.round(120 * Math.max(0, Math.min(1, (frac - 0.15) / 0.7)))));
    this.root.classList.toggle('low', frac > 0 && frac <= 0.3);
    if (this.lastHealth >= 0 && health < this.lastHealth) {
      // The white trail stays where the health was and drains after a beat.
      this.ghost.classList.remove('draining');
      void this.ghost.offsetWidth;
      this.ghost.classList.add('draining');
      this.flash('hit');
    } else if (this.lastHealth >= 0 && health > this.lastHealth + 0.01) this.flash('heal');
    this.ghost.style.width = `${frac * 100}%`;
    if (this.lastHealth < 0 || health > this.lastHealth) {
      // Healing (or a new round): no trail.
      this.ghost.classList.remove('draining');
    }
    this.lastHealth = health;
    // Absorption: a gold stripe along the top of the bar (it shows even at full health).
    this.absorb.style.width = `${Math.min(1, f.absorption / max) * 100}%`;
    const bits: string[] = [];
    if (combo >= 2) bits.push(`<span class="vs-combo${combo > this.lastCombo ? ' bump' : ''}">${combo} COMBO</span>`);
    if (totems > 0) bits.push(`<span class="vs-totems">⛨ ${totems}</span>`);
    if (status) bits.push(`<span class="vs-status">${status}</span>`);
    this.sub.innerHTML = bits.join('');
    this.lastCombo = combo;
  }

  private flash(kind: 'hit' | 'heal') {
    this.root.classList.remove('hit', 'heal');
    void this.root.offsetWidth;
    this.root.classList.add(kind);
  }
}
