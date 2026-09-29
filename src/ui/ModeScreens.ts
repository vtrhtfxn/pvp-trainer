import type { Fighter } from '../game/Fighter';
import { ITEMS, stackLore, stackName, type ItemStack } from '../game/items';
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

  update(lines: ScoreLine[] | null) {
    if (!lines) {
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
  private buyFn: ((item: ShopItem) => string | null) | null = null;

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

  show(f: Fighter, gear: TeamGear, buyFn: (item: ShopItem) => string | null) {
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
        const err = this.buyFn?.(item) ?? null;
        this.msg = err ? `✘ ${err}` : `✔ Bought ${item.name}`;
        this.render();
      });
      grid.append(b);
    }
    panel.append(grid);
    panel.append(h('div', 'mode-msg', this.msg || 'Click to buy · Esc or E to close'));
    this.root.replaceChildren(panel);
  }
}

/** A SkyWars chest: its 27 slots above your inventory; click a stack to move it across. */
export class ChestScreen {
  readonly root: HTMLDivElement;
  open = false;
  private f: Fighter | null = null;
  private items: (ItemStack | null)[] = [];
  private onChange: (() => void) | null = null;

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

  show(f: Fighter, items: (ItemStack | null)[], onChange: () => void) {
    this.f = f;
    this.items = items;
    this.onChange = onChange;
    this.open = true;
    this.root.style.display = '';
    this.render();
  }

  hide() {
    this.open = false;
    this.root.style.display = 'none';
  }

  /** Chest → you: as much as fits. */
  private take(i: number) {
    const f = this.f!;
    const s = this.items[i];
    if (!s) return;
    const copy = { ...s };
    f.addItem(copy);
    this.items[i] = copy.count > 0 ? copy : null;
    // Armor goes straight on if that slot is empty (a common quality-of-life plugin rule).
    this.autoEquip();
  }

  private autoEquip() {
    const f = this.f!;
    for (let i = 0; i < f.inventory.length; i++) {
      const s = f.inventory[i];
      const a = s ? ITEMS[s.id].armor : undefined;
      if (!s || !a || a.glider || f.armorSlots[a.slot]) continue;
      f.armorSlots[a.slot] = s;
      f.inventory[i] = null;
    }
    f.recomputeArmor();
  }

  /** You → chest: into the first empty slot. */
  private put(i: number) {
    const f = this.f!;
    const s = f.inventory[i];
    if (!s) return;
    const j = this.items.findIndex((x) => !x);
    if (j < 0) return;
    this.items[j] = s;
    f.inventory[i] = null;
  }

  render() {
    const f = this.f;
    if (!f) return;
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
    this.items.forEach((s, i) => chest.append(slot(s, () => this.take(i))));
    panel.append(chest);
    const takeAll = h('button', 'mc-btn mode-takeall', 'Take all');
    takeAll.addEventListener('click', () => {
      this.cb.onUiSound();
      for (let i = 0; i < this.items.length; i++) this.take(i);
      this.onChange?.();
      this.render();
    });
    panel.append(takeAll);
    panel.append(h('div', 'mode-sub', 'Your inventory (click to put back)'));
    const inv = h('div', 'mode-slots');
    for (let i = 9; i < 36; i++) inv.append(slot(f.inventory[i], () => this.put(i)));
    for (let i = 0; i < 9; i++) inv.append(slot(f.inventory[i], () => this.put(i)));
    panel.append(inv);
    panel.append(h('div', 'mode-msg', 'Click an item to move it · Esc or E to close'));
    this.root.replaceChildren(panel);
  }
}
