import { KITS, type KitId } from '../game/kits';
import { ITEMS, POTIONS, stackLore, stackName, type Enchants, type ItemId, type ItemStack, type PotionId } from '../game/items';
import {
  ENCHANT_INFO,
  MAX_CUSTOM_KITS,
  MAX_KIT_NAME,
  armorSlotOf,
  blankCustomKit,
  cleanKitName,
  customFromLoadout,
  enchantsFor,
  newCustomKitId,
  paletteItems,
  saveCustomKits,
  takesPotion,
  type CustomKitData,
} from '../game/customKits';
import { emptySlotIcon, itemIcon } from '../render/itemIcons';

type Area = 'hotbar' | 'main' | 'armor' | 'offhand';
interface SlotRef {
  area: Area;
  i: number;
}

export interface KitEditorCallbacks {
  onUiSound(): void;
  onBack(): void;
  /** Play the kit against the bot tier picked on the title screen. */
  onPlay(id: KitId): void;
}

const ARMOR_EMPTY = ['helmet', 'chestplate', 'leggings', 'boots'] as const;
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

function iconCanvas(src: CanvasImageSource | undefined, size = 32): HTMLCanvasElement {
  const c = h('canvas', { width: String(size), height: String(size), class: 'ke-icon' });
  if (src) {
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, size, size);
  }
  return c;
}

/**
 * The kit editor: slots laid out like the inventory (armor and off hand, the 27 inventory slots,
 * the hotbar), every item in a palette, and the picked slot's count, enchantments and potion.
 * Every change is saved at once.
 */
export class KitEditor {
  private kits: CustomKitData[];
  private current: CustomKitData | null = null;
  private slot: SlotRef = { area: 'hotbar', i: 0 };
  private search = '';
  private note = '';
  private confirmDelete = false;

  constructor(
    private readonly root: HTMLElement,
    kits: CustomKitData[],
    private readonly cb: KitEditorCallbacks,
  ) {
    this.kits = kits;
  }

  get list(): readonly CustomKitData[] {
    return this.kits;
  }

  /** Opens the editor on a kit (by id), or on a brand-new one. */
  open(id?: string) {
    this.current = this.kits.find((k) => k.id === id) ?? this.kits[0] ?? null;
    if (!this.current || id === 'new') this.current = this.create(blankCustomKit(this.freshName()));
    this.slot = { area: 'hotbar', i: 0 };
    this.note = '';
    this.confirmDelete = false;
    this.render();
  }

  private freshName(base = 'My Kit'): string {
    const names = new Set(this.kits.map((k) => k.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  private create(k: CustomKitData): CustomKitData | null {
    if (this.kits.length >= MAX_CUSTOM_KITS) {
      this.note = `You can keep up to ${MAX_CUSTOM_KITS} kits — delete one first.`;
      return this.current ?? this.kits[0] ?? null;
    }
    this.kits.push(k);
    this.save();
    return k;
  }

  private save() {
    saveCustomKits(this.kits);
  }

  private click(fn: () => void): () => void {
    return () => {
      this.cb.onUiSound();
      fn();
    };
  }

  private btn(label: string, fn: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', { class: `mc-btn ${cls}` }, label);
    b.addEventListener('click', this.click(fn));
    return b;
  }

  // ------------------------------------------------------------------ slots

  private get(ref: SlotRef): ItemStack | null {
    const k = this.current!;
    if (ref.area === 'offhand') return k.offhand;
    return (ref.area === 'hotbar' ? k.hotbar : ref.area === 'main' ? k.main : k.armor)[ref.i] ?? null;
  }

  private set(ref: SlotRef, s: ItemStack | null) {
    const k = this.current!;
    if (ref.area === 'offhand') k.offhand = s;
    else (ref.area === 'hotbar' ? k.hotbar : ref.area === 'main' ? k.main : k.armor)[ref.i] = s;
    this.save();
  }

  private place(id: ItemId) {
    if (!this.current) return;
    if (this.slot.area === 'armor' && armorSlotOf(id) !== this.slot.i) {
      this.note = `${ITEMS[id].name} doesn't go in the ${ARMOR_EMPTY[this.slot.i]} slot.`;
      this.render();
      return;
    }
    const prev = this.get(this.slot);
    const s: ItemStack = { id, count: ITEMS[id].maxStack };
    if (id === 'red_shulker_box') s.stored = 27;
    if (takesPotion(id)) s.potion = prev && prev.potion && takesPotion(prev.id) ? prev.potion : id === 'tipped_arrow' ? 'slow_falling' : 'healing';
    // Swapping one weapon or armor piece for another keeps whatever enchantments still apply.
    if (prev?.ench) {
      const ok = new Set(enchantsFor(id));
      const kept: Enchants = {};
      for (const [key, v] of Object.entries(prev.ench) as [keyof Enchants, number][]) if (ok.has(key)) kept[key] = v;
      if (Object.keys(kept).length) s.ench = kept;
    }
    this.set(this.slot, s);
    this.note = '';
    this.advance();
    this.render();
  }

  /** After filling a hotbar or inventory slot, move on to the next empty one. */
  private advance() {
    const { area, i } = this.slot;
    if (area !== 'hotbar' && area !== 'main') return;
    const arr = area === 'hotbar' ? this.current!.hotbar : this.current!.main;
    for (let j = i + 1; j < arr.length; j++) {
      if (!arr[j]) {
        this.slot = { area, i: j };
        return;
      }
    }
  }

  private slotEl(ref: SlotRef): HTMLElement {
    const s = this.get(ref);
    const sel = this.slot.area === ref.area && this.slot.i === ref.i;
    const icon = s ? itemIcon(s) : ref.area === 'armor' ? emptySlotIcon(ARMOR_EMPTY[ref.i]) : ref.area === 'offhand' ? emptySlotIcon('shield') : undefined;
    const b = h('button', { class: `ke-slot${sel ? ' selected' : ''}${s ? '' : ' empty'}`, title: s ? [stackName(s), ...stackLore(s).filter(Boolean).slice(0, 4)].join('\n') : 'Empty' });
    b.append(iconCanvas(icon));
    if (s && s.count > 1) b.append(h('span', { class: 'ke-count' }, String(s.count)));
    b.addEventListener('click', this.click(() => {
      this.slot = ref;
      this.note = '';
      this.render();
    }));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.cb.onUiSound();
      this.slot = ref;
      this.set(ref, null);
      this.render();
    });
    return b;
  }

  // ------------------------------------------------------------------ render

  render() {
    const root = this.root;
    root.replaceChildren();
    const panel = h('div', { class: 'menu-panel ke-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Kit Editor'));
    panel.append(h('div', { class: 'tiers-sub' }, 'Build your own kit: pick a slot, then an item. Right-click a slot to empty it. Changes save by themselves.'));
    const cols = h('div', { class: 'ke-cols' });
    cols.append(this.kitList());
    if (this.current) cols.append(this.editorColumn(), this.sideColumn());
    panel.append(cols);
    if (this.note) panel.append(h('div', { class: 'ke-note' }, this.note));
    const bottom = h('div', { class: 'btn-row three' });
    if (this.current) {
      const id = this.current.id;
      bottom.append(this.btn('Play vs bot', () => this.cb.onPlay(id), 'big'));
      bottom.append(
        this.btn(this.confirmDelete ? 'Really delete?' : 'Delete kit', () => {
          if (!this.confirmDelete) {
            this.confirmDelete = true;
            this.render();
            return;
          }
          this.kits = this.kits.filter((k) => k.id !== id);
          this.save();
          this.current = this.kits[0] ?? null;
          this.confirmDelete = false;
          this.render();
        }, this.confirmDelete ? 'danger' : ''),
      );
    }
    bottom.append(this.btn('Back', () => this.cb.onBack()));
    panel.append(bottom);
    root.append(panel);
  }

  private kitList(): HTMLElement {
    const box = h('div', { class: 'ke-kits' });
    box.append(h('div', { class: 'trainer-group' }, `Your kits (${this.kits.length}/${MAX_CUSTOM_KITS})`));
    for (const k of this.kits) {
      const b = this.btn(k.name, () => {
        this.current = k;
        this.slot = { area: 'hotbar', i: 0 };
        this.confirmDelete = false;
        this.note = '';
        this.render();
      }, `trainer-drill${this.current?.id === k.id ? ' selected' : ''}`);
      box.append(b);
    }
    box.append(this.btn('+ New kit', () => {
      this.current = this.create(blankCustomKit(this.freshName()));
      this.slot = { area: 'hotbar', i: 0 };
      this.render();
    }));
    if (this.current) {
      box.append(this.btn('Duplicate', () => {
        const c = this.current!;
        this.current = this.create({ ...JSON.parse(JSON.stringify(c)), id: newCustomKitId(), name: this.freshName(cleanKitName(`${c.name} copy`)) });
        this.render();
      }));
    }
    // Start from any built-in kit's items.
    const sel = h('select', { class: 'ke-select' });
    sel.append(h('option', { value: '' }, 'Copy a built-in kit…'));
    for (const k of KITS) sel.append(h('option', { value: k.id }, k.name));
    sel.addEventListener('change', () => {
      const k = KITS.find((x) => x.id === sel.value);
      if (!k) return;
      this.cb.onUiSound();
      this.current = this.create(customFromLoadout(this.freshName(`${k.name} (custom)`), k, { naturalRegen: k.naturalRegen, noHunger: k.noHunger }));
      this.render();
    });
    box.append(sel);
    return box;
  }

  private editorColumn(): HTMLElement {
    const k = this.current!;
    const col = h('div', { class: 'ke-main' });
    const name = h('input', { class: 'ke-name', maxlength: String(MAX_KIT_NAME), value: k.name, spellcheck: 'false' });
    name.addEventListener('change', () => {
      k.name = cleanKitName(name.value);
      name.value = k.name;
      this.save();
      this.render();
    });
    col.append(h('label', { class: 'ke-label' }, 'Name', name));

    const gear = h('div', { class: 'ke-row' });
    for (let i = 0; i < 4; i++) gear.append(this.slotEl({ area: 'armor', i }));
    gear.append(h('span', { class: 'ke-gap' }), this.slotEl({ area: 'offhand', i: 0 }));
    col.append(h('div', { class: 'ke-caption' }, 'Armor · Off hand'), gear);

    col.append(h('div', { class: 'ke-caption' }, 'Inventory'));
    const inv = h('div', { class: 'ke-grid' });
    for (let i = 0; i < 27; i++) inv.append(this.slotEl({ area: 'main', i }));
    col.append(inv);
    col.append(h('div', { class: 'ke-caption' }, 'Hotbar'));
    const bar = h('div', { class: 'ke-grid' });
    for (let i = 0; i < 9; i++) bar.append(this.slotEl({ area: 'hotbar', i }));
    col.append(bar);

    const rules = h('div', { class: 'ke-rules' });
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, tip: string) => {
      const cb = h('input', { type: 'checkbox' });
      cb.checked = get();
      cb.addEventListener('change', () => {
        this.cb.onUiSound();
        set(cb.checked);
        this.save();
      });
      rules.append(h('label', { title: tip }, cb, label));
    };
    toggle('Natural regeneration', () => k.naturalRegen, (v) => (k.naturalRegen = v), 'Off: health only comes back from golden apples, heads and potions (like UHC).');
    toggle('Hunger off', () => k.noHunger, (v) => (k.noHunger = v), 'Hunger never drops, so you can always sprint.');
    col.append(rules);
    return col;
  }

  private sideColumn(): HTMLElement {
    const col = h('div', { class: 'ke-side' });
    col.append(this.slotDetail());
    const search = h('input', { class: 'ke-search', placeholder: 'Search items…', value: this.search, spellcheck: 'false' });
    const grid = h('div', { class: 'ke-palette' });
    const fill = () => {
      grid.replaceChildren();
      const q = this.search.trim().toLowerCase();
      for (const id of paletteItems()) {
        const def = ITEMS[id];
        if (q && !def.name.toLowerCase().includes(q) && !id.includes(q)) continue;
        const fits = this.slot.area !== 'armor' || armorSlotOf(id) === this.slot.i;
        const sample: ItemStack = { id, count: 1, potion: takesPotion(id) ? (id === 'tipped_arrow' ? 'slow_falling' : 'healing') : undefined };
        const b = h('button', { class: `ke-item${fits ? '' : ' dim'}`, title: def.name });
        b.append(iconCanvas(itemIcon(sample), 28));
        b.addEventListener('click', this.click(() => this.place(id)));
        grid.append(b);
      }
    };
    search.addEventListener('input', () => {
      this.search = search.value;
      fill();
    });
    fill();
    col.append(search, grid);
    return col;
  }

  private slotDetail(): HTMLElement {
    const box = h('div', { class: 'ke-detail' });
    const s = this.get(this.slot);
    const where = this.slot.area === 'armor' ? ARMOR_EMPTY[this.slot.i] : this.slot.area === 'offhand' ? 'off hand' : this.slot.area === 'hotbar' ? `hotbar ${this.slot.i + 1}` : `inventory ${this.slot.i + 1}`;
    if (!s) {
      box.append(h('div', { class: 'ke-detail-title' }, `Empty ${where} slot`), h('div', { class: 'ke-hint' }, 'Click an item below to put it here.'));
      return box;
    }
    const def = ITEMS[s.id];
    const redraw = () => {
      this.save();
      this.render();
    };
    box.append(h('div', { class: 'ke-detail-title' }, `${stackName(s)} · ${where}`));

    if (def.maxStack > 1) {
      const count = h('input', { type: 'number', min: '1', max: String(def.maxStack), value: String(s.count), class: 'ke-num' });
      count.addEventListener('change', () => {
        const n = Math.floor(Number(count.value));
        s.count = Number.isFinite(n) ? Math.min(Math.max(n, 1), def.maxStack) : 1;
        redraw();
      });
      box.append(
        h('div', { class: 'ke-line' }, h('span', {}, 'Count'), count, this.btn('1', () => ((s.count = 1), redraw()), 'ke-mini'), this.btn(`${def.maxStack}`, () => ((s.count = def.maxStack), redraw()), 'ke-mini')),
      );
    }

    if (s.id === 'red_shulker_box') {
      const n = h('input', { type: 'number', min: '0', max: '27', value: String(s.stored ?? 0), class: 'ke-num' });
      n.addEventListener('change', () => {
        const v = Math.floor(Number(n.value));
        s.stored = Number.isFinite(v) ? Math.min(Math.max(v, 0), 27) : 0;
        if (!s.stored) delete s.stored;
        redraw();
      });
      box.append(h('div', { class: 'ke-line' }, h('span', {}, 'TNT carts inside'), n));
    }

    if (takesPotion(s.id)) {
      const sel = h('select', { class: 'ke-select' });
      for (const p of Object.values(POTIONS)) {
        if (s.id === 'tipped_arrow' && p.id === 'healing') continue;
        const o = h('option', { value: p.id }, p.name);
        if (s.potion === p.id) o.selected = true;
        sel.append(o);
      }
      sel.addEventListener('change', () => {
        this.cb.onUiSound();
        s.potion = sel.value as PotionId;
        redraw();
      });
      box.append(h('div', { class: 'ke-line' }, h('span', {}, 'Potion'), sel));
    }

    const allowed = enchantsFor(s.id);
    if (allowed.length) {
      const ench = h('div', { class: 'ke-ench' });
      for (const info of ENCHANT_INFO) {
        if (!allowed.includes(info.key)) continue;
        const sel = h('select', { class: 'ke-select' });
        for (let lvl = 0; lvl <= info.max; lvl++) {
          const o = h('option', { value: String(lvl) }, lvl === 0 ? '—' : info.max === 1 ? 'Yes' : ROMAN[lvl]);
          if ((s.ench?.[info.key] ?? 0) === lvl) o.selected = true;
          sel.append(o);
        }
        sel.addEventListener('change', () => {
          this.cb.onUiSound();
          const lvl = Number(sel.value);
          const e: Enchants = { ...(s.ench ?? {}) };
          if (lvl > 0) e[info.key] = lvl;
          else delete e[info.key];
          if (Object.keys(e).length) s.ench = e;
          else delete s.ench;
          redraw();
        });
        ench.append(h('label', {}, h('span', {}, info.name), sel));
      }
      box.append(ench);
    }
    box.append(this.btn('Empty this slot', () => {
      this.set(this.slot, null);
      this.render();
    }, 'ke-mini'));
    return box;
  }
}
