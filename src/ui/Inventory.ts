import { INV_SIZE, SLOT_ARMOR, SLOT_OFFHAND, type Fighter } from '../game/Fighter';
import { ITEMS, sameItem, stackLore, stackName, type ItemStack } from '../game/items';
import { drawDurabilityBar, emptySlotIcon, itemIcon } from '../render/itemIcons';

export interface InventoryCallbacks {
  /** Something moved: resync (online) and play a sound. */
  onChange(): void;
  onClose(): void;
}

interface SlotEl {
  index: number;
  root: HTMLDivElement;
  canvas: HTMLCanvasElement;
  count: HTMLSpanElement;
  key: string;
}

const EMPTY_ICONS = ['helmet', 'chestplate', 'leggings', 'boots'] as const;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

function place(e: HTMLElement, x: number, y: number) {
  e.style.left = `calc(var(--gui) * ${x}px)`;
  e.style.top = `calc(var(--gui) * ${y}px)`;
}

/**
 * The survival inventory screen (InventoryScreen / InventoryMenu), laid out on vanilla's
 * 176×166 GUI grid: armor, the player preview, the off-hand slot, the 2×2 crafting grid, the
 * main inventory and the hotbar.
 *
 * Controls follow AbstractContainerScreen: left click picks up / places / swaps a stack, right
 * click takes half or places one, shift-click quick-moves, 1–9 over a slot swaps it with that
 * hotbar slot and F swaps it with the off hand. Dragging a stack onto another slot and letting go
 * drops it there, so "drag the shield onto the off-hand slot" works as you would expect.
 */
export class InventoryScreen {
  readonly root: HTMLDivElement;
  /** Transparent window the 3D player preview is drawn behind. */
  readonly preview: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly slots: SlotEl[] = [];
  private readonly cursor: HTMLDivElement;
  private readonly cursorCanvas: HTMLCanvasElement;
  private readonly cursorCount: HTMLSpanElement;
  private readonly tooltip: HTMLDivElement;
  private fighter: Fighter | null = null;
  private carried: ItemStack | null = null;
  private carriedFrom = -1;
  private dragFrom = -1;
  private hovered = -1;
  private cursorKey = '';
  mouseX = 0;
  mouseY = 0;
  open = false;

  constructor(
    parent: HTMLElement,
    private readonly cb: InventoryCallbacks,
  ) {
    this.root = el('div', 'inv-screen', parent);
    this.root.style.display = 'none';
    this.panel = el('div', 'inv-panel', this.root);

    // Player preview window (vanilla 26,8 → 75,78).
    this.preview = el('div', 'inv-preview', this.panel);
    place(this.preview, 25, 7);

    const label = el('div', 'inv-label', this.panel);
    label.textContent = 'Crafting';
    place(label, 97, 5);
    // Decorative 2×2 crafting grid, arrow and result slot (the kits need no crafting).
    for (let r = 0; r < 2; r++) for (let c = 0; c < 2; c++) place(el('div', 'inv-slot deco', this.panel), 97 + c * 18, 17 + r * 18);
    place(el('div', 'inv-arrow', this.panel), 135, 27);
    const result = el('div', 'inv-slot deco result', this.panel);
    place(result, 149, 23);

    for (let i = 0; i < 4; i++) this.addSlot(SLOT_ARMOR + i, 7, 7 + i * 18);
    this.addSlot(SLOT_OFFHAND, 76, 61);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 9; c++) this.addSlot(9 + r * 9 + c, 7 + c * 18, 83 + r * 18);
    for (let c = 0; c < 9; c++) this.addSlot(c, 7 + c * 18, 141);

    this.cursor = el('div', 'inv-cursor', this.root);
    this.cursorCanvas = el('canvas', 'inv-icon', this.cursor);
    this.cursorCanvas.width = this.cursorCanvas.height = 16;
    this.cursorCount = el('span', 'inv-count', this.cursor);
    this.tooltip = el('div', 'inv-tooltip', this.root);

    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    this.root.addEventListener('pointermove', (e) => this.onMove(e));
    this.root.addEventListener('pointerup', (e) => this.onUp(e));
    this.root.addEventListener('pointerdown', (e) => {
      // Clicking the dark backdrop outside the panel closes, like clicking away in vanilla.
      if (e.target === this.root && !this.carried) this.cb.onClose();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  private addSlot(index: number, x: number, y: number) {
    const root = el('div', 'inv-slot', this.panel);
    place(root, x, y);
    const canvas = el('canvas', 'inv-icon', root);
    canvas.width = canvas.height = 16;
    const count = el('span', 'inv-count', root);
    root.addEventListener('pointerdown', (e) => this.onDown(e, index));
    root.addEventListener('pointerenter', () => (this.hovered = index));
    root.addEventListener('pointerleave', () => {
      if (this.hovered === index) this.hovered = -1;
    });
    this.slots.push({ index, root, canvas, count, key: '?' });
  }

  show(f: Fighter) {
    this.fighter = f;
    this.open = true;
    this.carried = null;
    this.carriedFrom = this.dragFrom = -1;
    this.root.style.display = '';
    this.refresh();
  }

  /** Closes the screen; anything still on the cursor goes back into the inventory. */
  hide() {
    if (!this.open) return;
    const f = this.fighter;
    if (f && this.carried) {
      const c = this.carried;
      if (this.carriedFrom >= 0 && !f.getSlot(this.carriedFrom) && this.mayPlace(this.carriedFrom, c)) f.setSlot(this.carriedFrom, c);
      else if (!f.addItem(c)) {
        for (let i = 0; i < INV_SIZE && c.count > 0; i++) {
          if (!f.getSlot(i)) {
            f.setSlot(i, { ...c });
            c.count = 0;
          }
        }
      }
      this.carried = null;
      this.cb.onChange();
    }
    this.open = false;
    this.hovered = -1;
    this.root.style.display = 'none';
    this.tooltip.style.display = 'none';
  }

  // ------------------------------------------------------------------ rules

  private mayPlace(index: number, s: ItemStack): boolean {
    if (index >= SLOT_ARMOR && index < SLOT_OFFHAND) return ITEMS[s.id].armor?.slot === index - SLOT_ARMOR;
    return true;
  }

  private maxIn(index: number, s: ItemStack): number {
    return index >= SLOT_ARMOR && index < SLOT_OFFHAND ? 1 : ITEMS[s.id].maxStack;
  }

  private same(a: ItemStack, b: ItemStack): boolean {
    return sameItem(a, b);
  }

  /** Slot.safeInsert / pickup for a left click. */
  private leftClick(index: number) {
    const f = this.fighter!;
    const slot = f.getSlot(index);
    const c = this.carried;
    if (!c) {
      if (!slot) return;
      f.setSlot(index, null);
      this.carried = slot;
      this.carriedFrom = index;
    } else if (!slot) {
      if (!this.mayPlace(index, c)) return;
      const n = Math.min(c.count, this.maxIn(index, c));
      f.setSlot(index, { ...c, count: n });
      c.count -= n;
      if (c.count <= 0) this.carried = null;
    } else if (this.same(slot, c)) {
      const n = Math.min(c.count, this.maxIn(index, slot) - slot.count);
      if (n <= 0) return;
      slot.count += n;
      c.count -= n;
      if (c.count <= 0) this.carried = null;
    } else {
      if (!this.mayPlace(index, c) || c.count > this.maxIn(index, c)) return;
      f.setSlot(index, c);
      this.carried = slot;
      this.carriedFrom = index;
    }
    this.cb.onChange();
  }

  /** Right click: take half, or place one. */
  private rightClick(index: number) {
    const f = this.fighter!;
    const slot = f.getSlot(index);
    const c = this.carried;
    if (!c) {
      if (!slot) return;
      const take = Math.ceil(slot.count / 2);
      this.carried = { ...slot, count: take };
      this.carriedFrom = index;
      slot.count -= take;
      if (slot.count <= 0) f.setSlot(index, null);
    } else if (!slot) {
      if (!this.mayPlace(index, c)) return;
      f.setSlot(index, { ...c, count: 1 });
      if (--c.count <= 0) this.carried = null;
    } else if (this.same(slot, c) && slot.count < this.maxIn(index, slot)) {
      slot.count++;
      if (--c.count <= 0) this.carried = null;
    } else return;
    this.cb.onChange();
  }

  /** InventoryMenu.quickMoveStack (shift-click). */
  private quickMove(index: number) {
    const f = this.fighter!;
    const s = f.getSlot(index);
    if (!s) return;
    const armorSlot = ITEMS[s.id].armor?.slot;
    const tryRange = (from: number, to: number): boolean => {
      for (let i = from; i < to && s.count > 0; i++) {
        const t = f.getSlot(i);
        if (t && this.same(t, s) && t.count < ITEMS[s.id].maxStack) {
          const n = Math.min(s.count, ITEMS[s.id].maxStack - t.count);
          t.count += n;
          s.count -= n;
        }
      }
      for (let i = from; i < to && s.count > 0; i++) {
        if (!f.getSlot(i)) {
          f.setSlot(i, { ...s });
          s.count = 0;
        }
      }
      return s.count <= 0;
    };
    let moved = false;
    if (index >= SLOT_ARMOR) moved = tryRange(9, 36) || tryRange(0, 9);
    else if (armorSlot !== undefined && !f.getSlot(SLOT_ARMOR + armorSlot)) {
      f.setSlot(SLOT_ARMOR + armorSlot, { ...s });
      s.count = 0;
      moved = true;
    } else if (s.id === 'shield' && !f.offhand) {
      f.setSlot(SLOT_OFFHAND, { ...s });
      s.count = 0;
      moved = true;
    } else if (index < 9) moved = tryRange(9, 36);
    else moved = tryRange(0, 9);
    if (s.count <= 0) f.setSlot(index, null);
    if (moved || s.count <= 0) this.cb.onChange();
  }

  /** Number key / F over a slot: ClickType.SWAP with a hotbar slot or the off hand. */
  private swapWith(index: number, other: number) {
    const f = this.fighter!;
    if (index === other) return;
    const a = f.getSlot(index);
    const b = f.getSlot(other);
    if (b && !this.mayPlace(index, b)) return;
    if (a && !this.mayPlace(other, a)) return;
    f.setSlot(index, b);
    f.setSlot(other, a);
    this.cb.onChange();
  }

  // ------------------------------------------------------------------ events

  private onDown(e: PointerEvent, index: number) {
    if (!this.fighter) return;
    e.preventDefault();
    if (e.button === 0 && e.shiftKey && !this.carried) this.quickMove(index);
    else if (e.button === 0) {
      const picking = !this.carried && !!this.fighter.getSlot(index);
      this.leftClick(index);
      this.dragFrom = picking ? index : -1;
    } else if (e.button === 2) this.rightClick(index);
    this.refresh();
  }

  private onUp(e: PointerEvent) {
    if (e.button !== 0 || this.dragFrom < 0) return;
    // Dropped onto a different slot: put it there. Released on the same slot: it stays on the
    // cursor, so click-to-pick-up / click-to-place works too.
    if (this.carried && this.hovered >= 0 && this.hovered !== this.dragFrom) {
      this.leftClick(this.hovered);
      // A swap leaves the other stack on the cursor; send it back where the drag started.
      if (this.carried && !this.fighter!.getSlot(this.dragFrom) && this.mayPlace(this.dragFrom, this.carried)) {
        this.fighter!.setSlot(this.dragFrom, this.carried);
        this.carried = null;
      }
      this.refresh();
    }
    this.dragFrom = -1;
  }

  private onMove(e: PointerEvent) {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    this.cursor.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
    this.updateTooltip();
  }

  private onKey(e: KeyboardEvent) {
    if (!this.open || !this.fighter) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.cb.onClose();
      return;
    }
    if (this.hovered < 0 || this.carried) return;
    if (e.code.startsWith('Digit')) {
      const n = Number(e.code.slice(5));
      if (n >= 1 && n <= 9) {
        e.preventDefault();
        this.swapWith(this.hovered, n - 1);
        this.refresh();
      }
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      this.swapWith(this.hovered, SLOT_OFFHAND);
      this.refresh();
    }
  }

  // ------------------------------------------------------------------ drawing

  /** Redraws any slot whose contents changed (cheap: called every frame while open). */
  refresh() {
    const f = this.fighter;
    if (!f || !this.open) return;
    for (const s of this.slots) {
      const st = f.getSlot(s.index);
      const empty = s.index >= SLOT_ARMOR && s.index < SLOT_OFFHAND ? EMPTY_ICONS[s.index - SLOT_ARMOR] : s.index === SLOT_OFFHAND ? 'shield' : null;
      const key = st ? `${st.id}:${st.count}:${st.charged ? 1 : 0}:${st.ench ? 1 : 0}:${st.potion ?? ''}:${st.damage ?? 0}` : `-${empty ?? ''}`;
      s.root.classList.toggle('selected', s.index === f.selected);
      if (key === s.key) continue;
      s.key = key;
      this.paint(s.canvas, s.count, st, empty);
    }
    const c = this.carried;
    const ck = c ? `${c.id}:${c.count}:${c.charged ? 1 : 0}` : '';
    if (ck !== this.cursorKey) {
      this.cursorKey = ck;
      this.cursor.style.display = c ? '' : 'none';
      if (c) this.paint(this.cursorCanvas, this.cursorCount, c, null);
    }
    this.updateTooltip();
  }

  private paint(canvas: HTMLCanvasElement, count: HTMLSpanElement, st: ItemStack | null, empty: (typeof EMPTY_ICONS)[number] | 'shield' | null) {
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 16, 16);
    if (st) {
      const icon = itemIcon(st);
      if (icon) ctx.drawImage(icon, 0, 0);
      drawDurabilityBar(ctx, st, -1, 0);
    } else if (empty) {
      const icon = emptySlotIcon(empty);
      if (icon) {
        ctx.globalAlpha = 0.9;
        ctx.drawImage(icon, 0, 0, 16, 16);
        ctx.globalAlpha = 1;
      }
    }
    count.textContent = st && st.count > 1 ? String(st.count) : '';
  }

  private updateTooltip() {
    const f = this.fighter;
    const st = f && this.hovered >= 0 && !this.carried ? f.getSlot(this.hovered) : null;
    if (!st) {
      this.tooltip.style.display = 'none';
      return;
    }
    const name = stackName(st);
    const lore = stackLore(st);
    const html = `<b class="${st.ench ? 'ench' : ''}">${name}</b>${lore.map((l) => `<span class="${l.startsWith(' ') ? 'attr' : ''}">${l || '&nbsp;'}</span>`).join('')}`;
    if (this.tooltip.innerHTML !== html) this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';
    this.tooltip.style.transform = `translate(${this.mouseX + 14}px, ${this.mouseY - 18}px)`;
  }
}
