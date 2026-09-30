import type { Fighter } from '../game/Fighter';
import { ITEMS, POTIONS, stackName, type ItemId, type ItemStack, type PotionId } from '../game/items';
import { drawDurabilityBar, itemIcon } from '../render/itemIcons';
import { packImage } from '../render/pack';
import { MOD_BY_ID, type ModId, type ModManager } from './registry';

/** Everything the widgets show, gathered once per frame by the game. */
export interface WidgetFrame {
  fps: number;
  frameMs: number;
  /** The screen's refresh rate in Hz (desktop app; 0 = unknown). FPS can't be shown faster. */
  displayHz: number;
  ping: number | null;
  player: Fighter;
  keys: { forward: boolean; left: boolean; back: boolean; right: boolean; jump: boolean; attack: boolean; use: boolean };
  cps: { left: number; right: number };
  /** Sprint state as the ToggleSprint mod words it. */
  sprint: 'toggled' | 'held' | 'vanilla' | null;
  sneakToggled: boolean;
  /** HUD GUI scale (the widgets follow it). */
  gui: number;
  /** In a duel (widgets are hidden on the title screen unless the HUD editor is open). */
  inGame: boolean;
  /** The opponent (Target HUD), their name colour, and how far your last hit reached. */
  opponent: Fighter | null;
  opponentColor: string;
  lastReach: number | null;
}

const WIDGETS: ModId[] = [
  'fps',
  'togglesprint',
  'coords',
  'potcounter',
  'totemcounter',
  'itemcounter',
  'keystrokes',
  'targethud',
  'reachdisplay',
  'combocounter',
  'cpscounter',
  'directionhud',
  'speedometer',
  'clock',
];

/** Compass points in Minecraft degrees (0 = south, 90 = west). */
const COMPASS: [number, string][] = [
  [0, 'S'],
  [45, 'SW'],
  [90, 'W'],
  [135, 'NW'],
  [180, 'N'],
  [225, 'NE'],
  [270, 'E'],
  [315, 'SE'],
];

/** Minecraft's heading for our yaw (ours: 0 = north, Minecraft: 0 = south). */
function mcHeading(yaw: number): number {
  return (((180 - (yaw * 180) / Math.PI) % 360) + 360) % 360;
}

/** One line of text in a widget, with the usual colour / background options. */
function textBox(text: string, color: unknown, bg: unknown): string {
  return `<div class="mw-text${bg ? ' bg' : ''}" style="color:${esc(String(color))}">${text}</div>`;
}

const ICON_CACHE = new Map<string, string>();
/** A data-URL icon for an item (cached; drawn from the pack). */
function iconUrl(st: ItemStack): string {
  const key = `${st.id}:${st.potion ?? ''}`;
  let url = ICON_CACHE.get(key);
  if (url === undefined) {
    url = itemIcon(st)?.toDataURL() ?? '';
    ICON_CACHE.set(key, url);
  }
  return url;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const FACINGS: [string, string][] = [
  ['south', 'Towards positive Z'],
  ['west', 'Towards negative X'],
  ['north', 'Towards negative Z'],
  ['east', 'Towards positive X'],
];

/**
 * The mods' HUD pieces. Each widget is a small DOM box at a spot you choose in the HUD editor
 * (saved as a fraction of the screen); its HTML only changes when what it shows changes.
 */
export class ModHud {
  readonly root: HTMLDivElement;
  private readonly boxes = new Map<ModId, HTMLDivElement>();
  private readonly last = new Map<ModId, string>();
  private readonly armor: HTMLCanvasElement;
  private readonly armorCtx: CanvasRenderingContext2D;
  private armorKey = '';
  private readonly crosshair: HTMLCanvasElement;
  private crosshairKey = '';
  editing = false;
  /**
   * The practice panel (top-left). Widgets placed on top of it, or on each other, are pushed down
   * until nothing draws over anything else (checked a few times a second, not every frame).
   */
  avoid: HTMLElement | null = null;
  private readonly nudge = new Map<ModId, number>();
  private nudgeCheckedAt = 0;
  private drag: { id: ModId; dx: number; dy: number } | null = null;

  constructor(
    parent: HTMLElement,
    private readonly mods: ModManager,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'mod-hud';
    parent.appendChild(this.root);
    for (const id of WIDGETS) {
      const el = document.createElement('div');
      el.className = `mod-widget mod-${id}`;
      el.dataset.mod = id;
      el.style.display = 'none';
      el.addEventListener('pointerdown', (e) => this.startDrag(e, id));
      this.root.appendChild(el);
      this.boxes.set(id, el);
    }
    this.armor = document.createElement('canvas');
    this.armor.className = 'mod-armorhud';
    this.armorCtx = this.armor.getContext('2d')!;
    this.root.appendChild(this.armor);
    this.crosshair = document.createElement('canvas');
    this.crosshair.className = 'mod-crosshair';
    this.root.appendChild(this.crosshair);
    window.addEventListener('pointermove', (e) => this.moveDrag(e));
    window.addEventListener('pointerup', () => {
      this.drag = null;
    });
    mods.onChange(() => {
      this.last.clear();
      this.armorKey = '';
      this.crosshairKey = '';
    });
  }

  // ------------------------------------------------------------------ HUD editor

  private startDrag(e: PointerEvent, id: ModId) {
    if (!this.editing) return;
    const el = this.boxes.get(id)!;
    const r = el.getBoundingClientRect();
    this.drag = { id, dx: e.clientX - r.left, dy: e.clientY - r.top };
    e.preventDefault();
  }

  private moveDrag(e: PointerEvent) {
    if (!this.drag) return;
    const el = this.boxes.get(this.drag.id)!;
    const w = window.innerWidth;
    const h = window.innerHeight;
    let x = e.clientX - this.drag.dx;
    let y = e.clientY - this.drag.dy;
    // Snap to the screen edges and centre lines.
    const snap = 8;
    const bw = el.offsetWidth;
    const bh = el.offsetHeight;
    if (Math.abs(x) < snap) x = 0;
    if (Math.abs(x + bw - w) < snap) x = w - bw;
    if (Math.abs(x + bw / 2 - w / 2) < snap) x = w / 2 - bw / 2;
    if (Math.abs(y) < snap) y = 0;
    if (Math.abs(y + bh - h) < snap) y = h - bh;
    x = Math.max(0, Math.min(w - bw, x));
    y = Math.max(0, Math.min(h - bh, y));
    this.mods.setPos(this.drag.id, { x: x / w, y: y / h });
  }

  setEditing(v: boolean) {
    this.editing = v;
    this.root.classList.toggle('editing', v);
    this.last.clear();
  }

  // ------------------------------------------------------------------ per frame

  update(f: WidgetFrame | null) {
    const show = !!f && (f.inGame || this.editing);
    this.root.style.setProperty('--gui', String(f?.gui ?? 2));
    for (const id of WIDGETS) {
      const el = this.boxes.get(id)!;
      const on = show && this.mods.on(id);
      const html = on ? this.render(id, f!) : '';
      const visible = on && html !== '';
      if ((el.style.display === 'none') === visible) el.style.display = visible ? '' : 'none';
      if (!visible) continue;
      if (this.last.get(id) !== html) {
        el.innerHTML = html;
        this.last.set(id, html);
      }
      const p = this.mods.pos(id);
      const scale = Number(this.mods.cfg(id, 'scale') ?? 1);
      const x = `${Math.round(p.x * window.innerWidth)}px`;
      const top = `${Math.round(p.y * window.innerHeight) + (this.editing ? 0 : (this.nudge.get(id) ?? 0))}px`;
      const left = p.right ? 'auto' : x;
      const right = p.right ? x : 'auto';
      if (el.style.left !== left) el.style.left = left;
      if (el.style.right !== right) el.style.right = right;
      if (el.style.top !== top) el.style.top = top;
      el.classList.toggle('right', !!p.right);
      const sc = String(scale);
      if (el.style.getPropertyValue('--s') !== sc) el.style.setProperty('--s', sc);
    }
    if (show && !this.editing) this.checkOverlap();
    this.drawArmor(show && this.mods.on('armorhud') ? f! : null);
    this.drawCrosshair(!!f && f.inGame && this.mods.on('crosshair'));
  }

  /**
   * Moves widgets that would sit on the practice panel, or on each other, down until they are
   * clear — top to bottom, so a widget pushed down can in turn push the next one.
   */
  private checkOverlap() {
    const now = performance.now();
    if (now - this.nudgeCheckedAt < 250) return;
    this.nudgeCheckedAt = now;
    const panel = this.avoid;
    const taken: { left: number; right: number; top: number; bottom: number }[] = [];
    if (panel && panel.style.display !== 'none' && panel.offsetParent) {
      const pr = panel.getBoundingClientRect();
      if (pr.height) taken.push(pr);
    }
    const boxes = WIDGETS.filter((id) => this.boxes.get(id)!.style.display !== 'none').map((id) => {
      const r = this.boxes.get(id)!.getBoundingClientRect();
      const top = r.top - (this.nudge.get(id) ?? 0);
      return { id, left: r.left, right: r.right, top, height: r.height };
    });
    boxes.sort((a, b) => a.top - b.top);
    const next = new Map<ModId, number>();
    for (const b of boxes) {
      let top = b.top;
      for (let guard = 0; guard < 12; guard++) {
        const hit = taken.find((t) => b.left < t.right && b.right > t.left && top < t.bottom && top + b.height > t.top);
        if (!hit) break;
        top = Math.ceil(hit.bottom + 4);
      }
      if (top !== b.top) next.set(b.id, top - b.top);
      taken.push({ left: b.left, right: b.right, top, bottom: top + b.height });
    }
    this.nudge.clear();
    for (const [id, v] of next) this.nudge.set(id, v);
  }

  private render(id: ModId, f: WidgetFrame): string {
    const p = f.player;
    const cfg = (k: string) => this.mods.cfg(id, k);
    switch (id) {
      case 'fps': {
        const parts = [`${Math.round(f.fps)} FPS`];
        if (cfg('showMs')) parts.push(`${f.frameMs.toFixed(1)} ms`);
        if (cfg('showHz') && f.displayHz > 0) parts.push(`${f.displayHz} Hz screen`);
        if (cfg('showPing') && f.ping !== null) parts.push(`${Math.round(f.ping)} ms ping`);
        const bg = cfg('background') ? ' bg' : '';
        return `<div class="mw-text${bg}" style="color:${esc(String(cfg('color')))}">${parts.join(' · ')}</div>`;
      }
      case 'togglesprint': {
        let t = '';
        if (p.flying) t = '[Flying]';
        else if (p.sneaking) t = f.sneakToggled ? '[Sneaking (Toggled)]' : '[Sneaking (Key Held)]';
        else if (f.sprint === 'toggled') t = '[Sprinting (Toggled)]';
        else if (f.sprint === 'held') t = '[Sprinting (Key Held)]';
        else if (f.sprint === 'vanilla') t = '[Sprinting (Vanilla)]';
        if (!t && this.editing) t = '[Sprinting (Toggled)]';
        return t ? `<div class="mw-text" style="color:${esc(String(cfg('color')))}">${t}</div>` : '';
      }
      case 'coords': {
        const d = Number(cfg('decimals'));
        const lines = [`XYZ: ${p.pos.x.toFixed(d)} / ${p.pos.y.toFixed(d)} / ${p.pos.z.toFixed(d)}`];
        if (cfg('facing')) {
          // Minecraft yaw: 0 = south (+Z). Ours: 0 = north (-Z).
          const mc = (((180 - (p.yaw * 180) / Math.PI) % 360) + 360) % 360;
          const [dir, desc] = FACINGS[Math.round(mc / 90) % 4];
          lines.push(`Facing: ${dir} (${desc})`);
        }
        return `<div class="mw-text bg">${lines.join('<br>')}</div>`;
      }
      case 'potcounter': {
        const which = cfg('which');
        const rows: string[] = [];
        const kinds: PotionId[] = which === 'all' ? (Object.keys(POTIONS) as PotionId[]) : ['healing'];
        for (const k of kinds) {
          const n = p.countItem('splash_potion', k);
          if (!n && (which === 'all' || (cfg('hideWhenNone') && !this.editing))) continue;
          const st: ItemStack = { id: 'splash_potion', count: 1, potion: k };
          rows.push(`<div class="mw-count" title="${esc(stackName(st))}"><img src="${iconUrl(st)}"><b>${n}</b></div>`);
        }
        if (!rows.length && this.editing) rows.push(`<div class="mw-count"><img src="${iconUrl({ id: 'splash_potion', count: 1, potion: 'healing' })}"><b>0</b></div>`);
        return rows.join('');
      }
      case 'totemcounter': {
        const n = p.countItem('totem_of_undying');
        if (!n && cfg('hideWhenNone') && !this.editing) return '';
        return `<div class="mw-count"><img src="${iconUrl({ id: 'totem_of_undying', count: 1 })}"><b>${n}</b></div>`;
      }
      case 'itemcounter': {
        const ids: ItemId[] = ['golden_apple', 'ender_pearl', 'arrow', 'end_crystal', 'obsidian', 'wind_charge', 'experience_bottle', 'cobweb'];
        const rows: string[] = [];
        for (const id2 of ids) {
          if (!cfg(id2)) continue;
          let n = p.countItem(id2);
          if (id2 === 'arrow') n += p.countItem('tipped_arrow');
          if (id2 === 'golden_apple') n += p.countItem('golden_head');
          if (!n && !this.editing) continue;
          rows.push(`<div class="mw-count" title="${esc(ITEMS[id2].name)}"><img src="${iconUrl({ id: id2, count: 1 })}"><b>${n}</b></div>`);
        }
        return rows.join('');
      }
      case 'keystrokes': {
        const k = f.keys;
        const key = (label: string, on: boolean, cls = '') => `<div class="ks-key${on ? ' on' : ''}${cls}">${label}</div>`;
        let html = `<div class="ks-row">${key('W', k.forward, ' ks-w')}</div><div class="ks-row">${key('A', k.left)}${key('S', k.back)}${key('D', k.right)}</div>`;
        if (cfg('mouse')) {
          const cps = !!cfg('cps');
          html += `<div class="ks-row">${key(cps ? `LMB<small>${f.cps.left} CPS</small>` : 'LMB', k.attack, ' ks-mouse')}${key(cps ? `RMB<small>${f.cps.right} CPS</small>` : 'RMB', k.use, ' ks-mouse')}</div>`;
        }
        if (cfg('space')) html += `<div class="ks-row">${key('<i class="ks-bar"></i>', k.jump, ' ks-space')}</div>`;
        return `<div class="ks" style="--ks-on:${esc(String(cfg('pressed')))}">${html}</div>`;
      }
      case 'targethud':
        return this.targetHud(f);
      case 'reachdisplay': {
        const r = f.lastReach;
        const text = r === null ? (this.editing ? '3.00 blocks' : '— blocks') : `${r.toFixed(Number(cfg('decimals')))} blocks`;
        return textBox(text, cfg('color'), cfg('background'));
      }
      case 'combocounter': {
        const n = p.stats.combo;
        if (!n && cfg('hideZero') && !this.editing) return '';
        return textBox(`${n} Combo`, cfg('color'), cfg('background'));
      }
      case 'cpscounter': {
        const text = cfg('right') ? `${f.cps.left} | ${f.cps.right} CPS` : `${f.cps.left} CPS`;
        return textBox(text, cfg('color'), cfg('background'));
      }
      case 'directionhud': {
        const h = mcHeading(p.yaw);
        const marks: string[] = [];
        for (const [deg, label] of COMPASS) {
          const d = ((deg - h + 540) % 360) - 180;
          if (Math.abs(d) > 90) continue;
          const big = label.length === 1 ? ' big' : '';
          marks.push(`<span class="dh-mark${big}" style="left:${(50 + (d / 90) * 50).toFixed(1)}%">${label}</span>`);
        }
        const deg = cfg('degrees') ? `<div class="dh-deg">${Math.round(h) % 360}°</div>` : '';
        return `<div class="mw-dir"><div class="dh-strip">${marks.join('')}<i class="dh-tick"></i></div>${deg}</div>`;
      }
      case 'speedometer': {
        const dx = p.pos.x - p.prevPos.x;
        const dy = cfg('vertical') ? p.pos.y - p.prevPos.y : 0;
        const dz = p.pos.z - p.prevPos.z;
        // One tick's movement × 20 ticks a second.
        const bps = Math.hypot(dx, dy, dz) * 20;
        return textBox(`${bps.toFixed(2)} b/s`, cfg('color'), cfg('background'));
      }
      case 'clock': {
        const d = new Date();
        let hh = d.getHours();
        let suffix = '';
        if (cfg('twelve')) {
          suffix = hh < 12 ? ' AM' : ' PM';
          hh = hh % 12 || 12;
        }
        const pad = (n: number) => String(n).padStart(2, '0');
        const text = `${cfg('twelve') ? hh : pad(hh)}:${pad(d.getMinutes())}${cfg('seconds') ? `:${pad(d.getSeconds())}` : ''}${suffix}`;
        return textBox(text, cfg('color'), cfg('background'));
      }
      default:
        return '';
    }
  }

  /** Target HUD: the opponent's name, health bar, hearts, armor, held item and distance. */
  private targetHud(f: WidgetFrame): string {
    const cfg = (k: string) => this.mods.cfg('targethud', k);
    const o = f.opponent;
    if (!o) return this.editing ? '<div class="mw-target"><div class="tg-name">Opponent</div><div class="tg-bar"><i style="width:75%"></i></div><div class="tg-row">15.0 ❤</div></div>' : '';
    const p = f.player;
    const dist = Math.hypot(o.pos.x - p.pos.x, o.pos.y - p.pos.y, o.pos.z - p.pos.z);
    if (cfg('onlyNear') && dist > 8 && !this.editing) return '';
    const hp = Math.max(0, o.health);
    const pct = Math.max(0, Math.min(100, (hp / o.maxHealth) * 100));
    const color = pct > 60 ? '#55ff55' : pct > 30 ? '#ffd23f' : '#ff5555';
    const abs = o.absorption > 0 ? ` <span class="tg-abs">+${(o.absorption / 2).toFixed(1)}</span>` : '';
    const row = [`${(hp / 2).toFixed(1)} ❤${abs}`];
    if (cfg('armor')) row.push(`Armor ${o.armor.points}`);
    if (cfg('distance')) row.push(`${dist.toFixed(1)} m`);
    const icons: string[] = [];
    if (cfg('held')) {
      const held = o.heldStack();
      if (held) icons.push(`<img src="${iconUrl(held)}" title="${esc(stackName(held))}">`);
    }
    if (cfg('armor')) for (const a of o.armorSlots) if (a) icons.push(`<img src="${iconUrl(a)}" title="${esc(stackName(a))}">`);
    const dead = o.dead ? ' dead' : '';
    return (
      `<div class="mw-target${dead}">` +
      `<div class="tg-name" style="color:${esc(f.opponentColor)}">${esc(o.name)}</div>` +
      `<div class="tg-bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>` +
      `<div class="tg-row">${row.join(' · ')}</div>` +
      (icons.length ? `<div class="tg-items">${icons.join('')}</div>` : '') +
      `</div>`
    );
  }

  /** uku's Armor HUD: the four armor slots beside the hotbar, in hotbar style. */
  private drawArmor(f: WidgetFrame | null) {
    const c = this.armor;
    if (!f) {
      if (c.style.display !== 'none') c.style.display = 'none';
      return;
    }
    const p = f.player;
    const mode = String(this.mods.cfg('armorhud', 'durability'));
    const showEmpty = !!this.mods.cfg('armorhud', 'showEmpty');
    const side = this.mods.cfg('armorhud', 'side');
    const slots = [0, 1, 2, 3].map((i) => p.armorSlots[i]);
    const key = `${f.gui}|${mode}|${showEmpty}|${side}|${slots.map((s) => (s ? `${s.id}:${s.damage ?? 0}` : '-')).join(',')}`;
    if (c.style.display === 'none') c.style.display = '';
    if (key === this.armorKey) return;
    this.armorKey = key;
    const k = f.gui;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 4 * 20 + 2;
    const h = 22;
    c.width = w * k * dpr;
    c.height = h * k * dpr;
    c.style.width = `${w * k}px`;
    c.style.height = `${h * k}px`;
    // Beside the hotbar (182 px wide, centred, 1 px above the bottom), past the off-hand slot.
    const offset = (91 + 6) * k;
    c.style.left = side === 'left' ? `calc(50% - ${offset + w * k}px)` : `calc(50% + ${offset}px)`;
    const x = this.armorCtx;
    x.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    x.imageSmoothingEnabled = false;
    x.clearRect(0, 0, w, h);
    const bar = packImage('gui/sprites/hud/hotbar');
    for (let i = 0; i < 4; i++) {
      const st = slots[i];
      if (!st && !showEmpty) continue;
      const sx = i * 20;
      if (bar) x.drawImage(bar, 0, 0, 22, 22, sx, 0, 22, 22);
      else {
        x.fillStyle = 'rgba(0,0,0,0.55)';
        x.fillRect(sx, 0, 22, 22);
      }
      if (!st) continue;
      const icon = itemIcon(st);
      if (icon) x.drawImage(icon, sx + 3, 3, 16, 16);
      const max = ITEMS[st.id].maxDamage ?? 0;
      if (mode === 'bar') drawDurabilityBar(x, st, sx + 2, 3);
      else if (mode !== 'none' && max) {
        const left = max - (st.damage ?? 0);
        const text = mode === 'percent' ? `${Math.round((left / max) * 100)}%` : String(left);
        x.font = '8px Minecraft, "Pixelify Sans", monospace';
        x.textAlign = 'center';
        x.fillStyle = '#3f3f3f';
        x.fillText(text, sx + 12, 21);
        x.fillStyle = left / max < 0.25 ? '#ff5555' : '#ffffff';
        x.fillText(text, sx + 11, 20);
      }
    }
  }

  /** Custom Crosshair: drawn on a canvas at the screen centre (the vanilla one is hidden). */
  private drawCrosshair(on: boolean) {
    const c = this.crosshair;
    document.body.classList.toggle('custom-crosshair', on);
    if (!on) {
      if (c.style.display !== 'none') c.style.display = 'none';
      return;
    }
    if (c.style.display === 'none') c.style.display = '';
    const g = (k: string) => this.mods.cfg('crosshair', k);
    const key = ['style', 'color', 'size', 'gap', 'thickness', 'outline', 'dot'].map((k) => String(g(k))).join('|');
    if (key === this.crosshairKey) return;
    this.crosshairKey = key;
    const size = Number(g('size'));
    const gap = Number(g('gap'));
    const th = Number(g('thickness'));
    const R = size + gap + th + 3;
    const px = R * 2 + 1;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const k = 2 * dpr; // crosshair pixels are drawn at 2 screen pixels
    c.width = px * k;
    c.height = px * k;
    c.style.width = `${px * 2}px`;
    c.style.height = `${px * 2}px`;
    const x = c.getContext('2d')!;
    x.setTransform(k, 0, 0, k, 0, 0);
    x.clearRect(0, 0, px, px);
    const cx = R;
    const color = String(g('color'));
    const rects: [number, number, number, number][] = [];
    const style = g('style');
    const half = Math.floor(th / 2);
    if (style === 'cross' || style === 'plus' || style === 't') {
      const gp = style === 'plus' ? 0 : gap;
      if (style !== 't') rects.push([cx - half, cx - gp - size, th, size]); // up
      rects.push([cx - half, cx + gp + 1, th, size]); // down
      rects.push([cx - gp - size, cx - half, size, th]); // left
      rects.push([cx + gp + 1, cx - half, size, th]); // right
      if (style === 'plus') rects.push([cx - half, cx - half, th, th]);
    }
    if (style === 'dot' || g('dot')) rects.push([cx - half, cx - half, th, th]);
    if (g('outline')) {
      x.fillStyle = 'rgba(0,0,0,0.85)';
      for (const [a, b, w, h] of rects) x.fillRect(a - 1, b - 1, w + 2, h + 2);
    }
    if (style === 'circle') {
      x.lineWidth = th;
      if (g('outline')) {
        x.strokeStyle = 'rgba(0,0,0,0.85)';
        x.lineWidth = th + 2;
        x.beginPath();
        x.arc(cx + 0.5, cx + 0.5, size, 0, Math.PI * 2);
        x.stroke();
        x.lineWidth = th;
      }
      x.strokeStyle = color;
      x.beginPath();
      x.arc(cx + 0.5, cx + 0.5, size, 0, Math.PI * 2);
      x.stroke();
    }
    x.fillStyle = color;
    for (const [a, b, w, h] of rects) x.fillRect(a, b, w, h);
  }
}

/** What each widget is called in the HUD editor. */
export function widgetName(id: ModId): string {
  return MOD_BY_ID[id].name;
}
