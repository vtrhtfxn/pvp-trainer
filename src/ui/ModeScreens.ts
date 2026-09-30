import type { Fighter } from '../game/Fighter';
import { stackLore, stackName, type ItemStack } from '../game/items';
import type { ScoreLine } from '../game/modes/GameMode';
import { CURRENCY_COLORS, CURRENCY_NAMES, SHOP, SHOP_CATEGORIES, priceOf, wallet, type Currency, type ShopCategory, type ShopItem, type TeamGear } from '../game/modes/shop';
import { itemIcon } from '../render/itemIcons';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

function icon(s: ItemStack, size = 32): HTMLCanvasElement {
  const c = h('canvas', 'ms-icon');
  c.width = c.height = size;
  const src = itemIcon(s);
  if (src) {
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, size, size);
  }
  return c;
}

function tip(s: ItemStack): string {
  return [stackName(s), ...stackLore(s).filter(Boolean).slice(0, 5)].join('\n');
}

/** The minigame sidebar (like a server scoreboard) on the right of the screen. */
export class ScoreboardHud {
  private readonly root: HTMLDivElement;
  private last = '';

  constructor(parent: HTMLElement) {
    this.root = h('div', 'mode-scoreboard');
    this.root.style.display = 'none';
    parent.append(this.root);
  }

  /** The Scoreboard mod: hidden, or a size and background opacity (null = the default look). */
  private hidden = false;
  setStyle(o: { hide: boolean; background: number; scale: number } | null) {
    this.hidden = !!o?.hide;
    this.root.style.setProperty('--sb-scale', String(o ? o.scale : 1));
    this.root.style.setProperty('--sb-bg', String(o ? o.background : 0.45));
    if (this.hidden) this.hide();
  }

  update(lines: ScoreLine[] | null) {
    if (!lines || this.hidden) {
      this.hide();
      return;
    }
    const key = lines.map((l) => l.text + (l.color ?? '')).join('|');
    this.root.style.display = '';
    if (key === this.last) return;
    this.last = key;
    this.root.replaceChildren(
      ...lines.map((l, i) => {
        const d = h('div', i === 0 ? 'mode-sb-title' : 'mode-sb-line', l.text);
        if (l.color) d.style.color = l.color;
        return d;
      }),
    );
  }

  hide() {
    this.root.style.display = 'none';
    this.last = '';
  }
}

interface OverlayCallbacks {
  onClose(): void;
  onUiSound(): void;
}

/** The Bed Wars item shop (and team upgrades): tabs, then click to buy. */
export class ShopScreen {
  readonly root: HTMLDivElement;
  open = false;
  private tab: ShopCategory = 'Blocks';
  private msg = '';
  private f: Fighter | null = null;
  private gear: TeamGear | null = null;
  /** Buys an item: an error, null (bought), or undefined (sent to the server; see setMessage). */
  private buyFn: ((item: ShopItem) => string | null | undefined) | null = null;

  constructor(
    parent: HTMLElement,
    private readonly cb: OverlayCallbacks,
  ) {
    this.root = h('div', 'mode-overlay');
    this.root.style.display = 'none';
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.cb.onClose();
    });
    parent.append(this.root);
  }

  show(f: Fighter, gear: TeamGear, buyFn: (item: ShopItem) => string | null | undefined) {
    this.f = f;
    this.gear = gear;
    this.buyFn = buyFn;
    this.msg = '';
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide() {
    this.open = false;
    this.root.style.display = 'none';
  }

  /** The server's answer to a purchase (online). */
  setMessage(msg: string) {
    this.msg = msg;
    if (this.open) this.render();
  }

  /** The team's upgrades changed (online: the server's copy). */
  setGear(gear: TeamGear) {
    const changed = JSON.stringify(gear) !== JSON.stringify(this.gear);
    this.gear = gear;
    if (changed && this.open) this.render();
  }

  private walletKey = '';

  /** Re-draws only when what you can afford changed (picking up iron while it is open). */
  refreshIfChanged() {
    const f = this.f;
    if (!f) return;
    const k = (['iron_ingot', 'gold_ingot', 'diamond', 'emerald'] as Currency[]).map((c) => wallet(f, c)).join(',');
    if (k !== this.walletKey) this.render();
  }

  render() {
    const f = this.f;
    const g = this.gear;
    if (!f || !g) return;
    this.walletKey = (['iron_ingot', 'gold_ingot', 'diamond', 'emerald'] as Currency[]).map((c) => wallet(f, c)).join(',');
    const panel = h('div', 'mode-panel');
    panel.append(h('div', 'mode-title', this.tab === 'Upgrades' ? 'Team Upgrades' : 'Item Shop'));
    const tabs = h('div', 'mode-tabs');
    for (const c of SHOP_CATEGORIES) {
      const b = h('button', `mode-tab${c === this.tab ? ' selected' : ''}`, c);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        this.tab = c;
        this.render();
      });
      tabs.append(b);
    }
    panel.append(tabs);
    const money = h('div', 'mode-wallet');
    for (const c of ['iron_ingot', 'gold_ingot', 'diamond', 'emerald'] as Currency[]) {
      const s = h('span', '', `${CURRENCY_NAMES[c]}: ${wallet(f, c)}`);
      s.style.color = CURRENCY_COLORS[c];
      money.append(s);
    }
    panel.append(money);
    const grid = h('div', 'mode-shop-grid');
    for (const item of SHOP.filter((i) => i.category === this.tab)) {
      const { currency, amount } = priceOf(item, g);
      const lock = item.locked?.(f, g) ?? null;
      const afford = wallet(f, currency) >= amount;
      const b = h('button', `mode-item${lock ? ' locked' : afford ? '' : ' poor'}`);
      b.title = item.info ?? '';
      b.append(icon(item.icon), h('span', 'mode-item-name', item.name));
      const price = h('span', 'mode-item-price', lock ?? `${amount} ${CURRENCY_NAMES[currency]}`);
      if (!lock) price.style.color = CURRENCY_COLORS[currency];
      b.append(price);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        const err = this.buyFn?.(item);
        this.msg = err === undefined ? '…' : err ? `✘ ${err}` : `✔ Bought ${item.name}`;
        this.render();
      });
      grid.append(b);
    }
    panel.append(grid);
    panel.append(h('div', 'mode-msg', this.msg || 'Click to buy · Esc or E to close'));
    this.root.replaceChildren(panel);
  }
}

/** What the chest screen does with a click: offline straight on the mode, online via the server. */
export interface ChestActions {
  take(i: number): void;
  takeAll(): void;
  put(i: number): void;
}

/** A SkyWars chest: its 27 slots above your inventory; click a stack to move it across. */
export class ChestScreen {
  readonly root: HTMLDivElement;
  open = false;
  private f: Fighter | null = null;
  private items: (ItemStack | null)[] = [];
  private actions: ChestActions | null = null;
  private onChange: (() => void) | null = null;
  private invKey = '';

  constructor(
    parent: HTMLElement,
    private readonly cb: OverlayCallbacks,
  ) {
    this.root = h('div', 'mode-overlay');
    this.root.style.display = 'none';
    this.root.addEventListener('pointerdown', (e) => {
      if (e.target === this.root) this.cb.onClose();
    });
    parent.append(this.root);
  }

  show(f: Fighter, items: (ItemStack | null)[], actions: ChestActions, onChange: () => void) {
    this.f = f;
    this.items = items;
    this.actions = actions;
    this.onChange = onChange;
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide() {
    this.open = false;
    this.root.style.display = 'none';
  }

  /** New contents (online: the server's answer to a click). */
  setItems(items: (ItemStack | null)[]) {
    this.items = items;
    if (this.open) this.render();
  }

  private key(): string {
    const f = this.f!;
    return JSON.stringify([f.inventory, f.armorSlots, this.items]);
  }

  /** Re-draws when the inventory or the chest changed behind the screen (online snapshots). */
  refreshIfChanged() {
    if (this.open && this.f && this.key() !== this.invKey) this.render();
  }

  render() {
    const f = this.f;
    if (!f) return;
    this.invKey = this.key();
    const panel = h('div', 'mode-panel chest');
    panel.append(h('div', 'mode-title', 'Chest'));
    const slot = (s: ItemStack | null, onClick: () => void) => {
      const b = h('button', 'mode-slot');
      if (s) {
        b.append(icon(s, 28));
        if (s.count > 1) b.append(h('span', 'mode-count', String(s.count)));
        b.title = tip(s);
      }
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        onClick();
        this.onChange?.();
        this.render();
      });
      return b;
    };
    const chest = h('div', 'mode-slots');
    this.items.forEach((s, i) => chest.append(slot(s, () => this.actions?.take(i))));
    panel.append(chest);
    const takeAll = h('button', 'mc-btn mode-takeall', 'Take all');
    takeAll.addEventListener('click', () => {
      this.cb.onUiSound();
      this.actions?.takeAll();
      this.onChange?.();
      this.render();
    });
    panel.append(takeAll);
    panel.append(h('div', 'mode-sub', 'Your inventory (click to put back)'));
    const inv = h('div', 'mode-slots');
    for (let i = 9; i < 36; i++) inv.append(slot(f.inventory[i], () => this.actions?.put(i)));
    for (let i = 0; i < 9; i++) inv.append(slot(f.inventory[i], () => this.actions?.put(i)));
    panel.append(inv);
    panel.append(h('div', 'mode-msg', 'Click an item to move it · Esc or E to close'));
    this.root.replaceChildren(panel);
  }
}
