import { keyName, type KeyBinds } from '../input/keybinds';
import { MODS, MOD_BY_ID, type ModCategory, type ModDef, type ModId, type ModManager, type ModOption } from '../mods/registry';
import { itemIcon } from '../render/itemIcons';
import { packImage } from '../render/pack';
import type { ItemId } from '../game/items';

export interface MarketplaceCallbacks {
  onClose(): void;
  onEditHud(): void;
  onUiSound(): void;
  /** The current key binds (to show which key a mod uses). */
  binds(): KeyBinds;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

/** 16×16 pixel icons for mods that have no item texture. */
function drawIcon(name: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const x = c.getContext('2d')!;
  const px = (col: string, pts: [number, number, number?, number?][]) => {
    x.fillStyle = col;
    for (const [a, b, w = 1, hh = 1] of pts) x.fillRect(a, b, w, hh);
  };
  switch (name) {
    case 'fps':
      px('#1e1e1e', [[0, 3, 16, 10]]);
      px('#55ff55', [[2, 5, 1, 6], [3, 5, 2, 1], [3, 7, 1, 1], [6, 5, 1, 6], [7, 5, 2, 1], [8, 6, 1, 1], [7, 7, 2, 1], [11, 5, 3, 1], [11, 6, 1, 1], [11, 7, 3, 1], [13, 8, 1, 2], [11, 10, 3, 1]]);
      break;
    case 'keys':
      px('#3a3a3a', [[6, 1, 4, 4], [1, 6, 4, 4], [6, 6, 4, 4], [11, 6, 4, 4], [1, 11, 14, 4]]);
      px('#ffffff', [[6, 6, 4, 4]]);
      px('#9a9a9a', [[7, 2, 2, 2], [2, 7, 2, 2], [12, 7, 2, 2]]);
      break;
    case 'damage':
      px('#8b0000', [[2, 2, 4, 1], [9, 2, 4, 1], [1, 3, 13, 4], [2, 7, 11, 2], [4, 9, 7, 2], [6, 11, 3, 2]]);
      px('#ff3b3b', [[2, 3, 3, 3], [9, 3, 3, 3], [3, 6, 9, 2], [5, 8, 5, 2], [7, 10, 1, 1]]);
      px('#ffffff', [[3, 3, 1, 1]]);
      px('#ffd23f', [[10, 11, 5, 1], [12, 9, 1, 5]]);
      break;
    case 'hitcolor':
      px('#c68642', [[4, 1, 8, 7]]);
      px('#3c2a1a', [[4, 1, 8, 2]]);
      px('#ffffff', [[5, 4, 2, 1], [9, 4, 2, 1]]);
      px('#2b2bff', [[6, 4, 1, 1], [10, 4, 1, 1]]);
      px('#5a8fd6', [[3, 8, 10, 8]]);
      x.fillStyle = 'rgba(255,0,0,0.45)';
      x.fillRect(3, 1, 10, 15);
      break;
    case 'crit':
      px('#ffffff', [[7, 1, 2, 14], [1, 7, 14, 2]]);
      px('#d0d0ff', [[4, 4, 2, 2], [10, 4, 2, 2], [4, 10, 2, 2], [10, 10, 2, 2]]);
      break;
    case 'eye':
      px('#ffffff', [[3, 6, 10, 4], [5, 5, 6, 6]]);
      px('#3b7dd8', [[6, 6, 4, 4]]);
      px('#101010', [[7, 7, 2, 2], [2, 7, 1, 2], [13, 7, 1, 2], [4, 5, 1, 1], [11, 5, 1, 1], [4, 10, 1, 1], [11, 10, 1, 1]]);
      break;
    default:
      px('#888', [[2, 2, 12, 12]]);
  }
  return c;
}

export function modIcon(def: ModDef): CanvasImageSource | undefined {
  const [kind, name] = def.icon.split(':');
  if (kind === 'item') return itemIcon({ id: name as ItemId, count: 1, potion: name === 'splash_potion' ? 'healing' : undefined });
  if (kind === 'pack') return packImage(def.icon.slice(5));
  return drawIcon(name);
}

function iconCanvas(src: CanvasImageSource | undefined, size = 16): HTMLCanvasElement {
  const c = h('canvas', { class: 'mk-icon', width: String(size), height: String(size) });
  const x = c.getContext('2d')!;
  x.imageSmoothingEnabled = false;
  if (src) x.drawImage(src, 0, 0, size, size);
  return c;
}

type Tab = 'mods' | 'packs';

/**
 * The Marketplace: Mods (install, switch on/off, settings, uninstall) and Resource Packs.
 * Opened from the title screen and the pause menu.
 */
export class Marketplace {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly tabs: Record<Tab, HTMLButtonElement>;
  private tab: Tab = 'mods';
  private filter: 'All' | 'Installed' | ModCategory = 'All';
  private query = '';
  private detail: ModId | null = null;

  constructor(
    parent: HTMLElement,
    private readonly mods: ModManager,
    private readonly cb: MarketplaceCallbacks,
  ) {
    this.root = h('div', { class: 'screen marketplace' });
    const panel = h('div', { class: 'menu-panel market' });
    const head = h('div', { class: 'mk-head' }, h('div', { class: 'screen-title' }, 'Marketplace'));
    this.tabs = {
      mods: h('button', { class: 'mk-tab' }, 'Mods'),
      packs: h('button', { class: 'mk-tab' }, 'Resource Packs'),
    };
    for (const t of ['mods', 'packs'] as Tab[]) {
      this.tabs[t].addEventListener('click', () => {
        this.cb.onUiSound();
        this.tab = t;
        this.detail = null;
        this.render();
      });
    }
    head.append(h('div', { class: 'mk-tabs' }, this.tabs.mods, this.tabs.packs));
    panel.append(head);
    this.body = h('div', { class: 'mk-body' });
    panel.append(this.body);
    const done = h('button', { class: 'mc-btn big' }, 'Done');
    done.addEventListener('click', () => {
      this.cb.onUiSound();
      this.cb.onClose();
    });
    panel.append(done);
    this.root.append(panel);
    this.root.style.display = 'none';
    parent.appendChild(this.root);
    mods.onChange(() => {
      if (this.root.style.display !== 'none') this.render();
    });
  }

  show() {
    this.detail = null;
    this.root.style.display = '';
    this.render();
  }

  hide() {
    this.root.style.display = 'none';
  }

  get open(): boolean {
    return this.root.style.display !== 'none';
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', { class: `mc-btn ${cls}` }, label);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.cb.onUiSound();
      onClick();
    });
    return b;
  }

  private render() {
    this.tabs.mods.classList.toggle('on', this.tab === 'mods');
    this.tabs.packs.classList.toggle('on', this.tab === 'packs');
    this.tabs.mods.textContent = `Mods (${MODS.length})`;
    this.body.replaceChildren();
    if (this.tab === 'packs') this.renderPacks();
    else if (this.detail) this.renderDetail(MOD_BY_ID[this.detail]);
    else this.renderMods();
  }

  private renderMods() {
    const bar = h('div', { class: 'mk-bar' });
    const search = h('input', { class: 'mc-input mk-search', type: 'text', placeholder: 'Search mods…' });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList(list);
    });
    bar.append(search);
    const chips = h('div', { class: 'mk-chips' });
    for (const f of ['All', 'Installed', 'HUD', 'Visual', 'Utility'] as const) {
      const c = h('button', { class: `mk-chip${this.filter === f ? ' on' : ''}` }, f === 'Installed' ? `Installed (${this.mods.installedCount})` : f);
      c.addEventListener('click', () => {
        this.cb.onUiSound();
        this.filter = f;
        this.render();
      });
      chips.append(c);
    }
    bar.append(chips);
    this.body.append(bar);
    const list = h('div', { class: 'mk-list' });
    this.body.append(list);
    this.renderList(list);
    const hasWidget = MODS.some((m) => m.widget && this.mods.states[m.id].installed);
    const edit = this.button('Edit HUD Layout', () => this.cb.onEditHud());
    if (!hasWidget) {
      edit.disabled = true;
      edit.title = 'Install a HUD mod first (FPS, Keystrokes, counters…)';
    }
    this.body.append(h('div', { class: 'mk-foot' }, edit, h('span', { class: 'mk-note' }, 'All mods are built in — installing one just switches it on. Nothing is downloaded.')));
  }

  private renderList(list: HTMLDivElement) {
    list.replaceChildren();
    const q = this.query.trim().toLowerCase();
    const shown = MODS.filter((m) => {
      const s = this.mods.states[m.id];
      if (this.filter === 'Installed' && !s.installed) return false;
      if (this.filter !== 'All' && this.filter !== 'Installed' && m.category !== this.filter) return false;
      return !q || `${m.name} ${m.description} ${m.category}`.toLowerCase().includes(q);
    });
    if (!shown.length) list.append(h('div', { class: 'mk-empty' }, this.filter === 'Installed' ? 'No mods installed yet — pick one below “All”.' : 'No mods match that.'));
    for (const m of shown) list.append(this.card(m));
  }

  private card(m: ModDef): HTMLDivElement {
    const s = this.mods.states[m.id];
    const card = h('div', { class: `mk-card${s.installed ? ' installed' : ''}${s.installed && !s.enabled ? ' off' : ''}` });
    const text = h(
      'div',
      { class: 'mk-text' },
      h('div', { class: 'mk-name' }, m.name, h('span', { class: `mk-cat ${m.category.toLowerCase()}` }, m.category)),
      h('div', { class: 'mk-desc' }, m.description),
    );
    if (m.key) text.append(h('div', { class: 'mk-key' }, `Key: ${keyName(this.cb.binds()[m.key])} (change it in Options → Key Binds)`));
    const actions = h('div', { class: 'mk-actions' });
    if (!s.installed) {
      actions.append(this.button('Install', () => this.mods.install(m.id), 'mk-install'));
    } else {
      actions.append(this.button(s.enabled ? 'Enabled' : 'Disabled', () => this.mods.setEnabled(m.id, !s.enabled), s.enabled ? 'mk-on' : 'mk-off'));
      actions.append(this.button('Settings', () => {
        this.detail = m.id;
        this.render();
      }));
    }
    card.append(iconCanvas(modIcon(m), 32), text, actions);
    card.addEventListener('click', () => {
      if (!s.installed) return;
      this.cb.onUiSound();
      this.detail = m.id;
      this.render();
    });
    return card;
  }

  private renderDetail(m: ModDef) {
    const s = this.mods.states[m.id];
    const top = h(
      'div',
      { class: 'mk-detail-head' },
      iconCanvas(modIcon(m), 48),
      h(
        'div',
        { class: 'mk-text' },
        h('div', { class: 'mk-name big' }, m.name, h('span', { class: `mk-cat ${m.category.toLowerCase()}` }, m.category)),
        h('div', { class: 'mk-desc' }, m.description),
        m.basedOn ? h('div', { class: 'mk-based' }, `A built-in take on ${m.basedOn} — not the original mod or its code.`) : '',
      ),
    );
    this.body.append(top);
    const grid = h('div', { class: 'settings-grid mk-options' });
    const enabled = this.button(`Enabled: ${s.enabled ? 'ON' : 'OFF'}`, () => this.mods.setEnabled(m.id, !s.enabled));
    grid.append(enabled);
    for (const o of m.options) grid.append(this.optionControl(m, o));
    this.body.append(grid);
    const row = h('div', { class: 'btn-row three' });
    row.append(
      this.button('< Back', () => {
        this.detail = null;
        this.render();
      }),
      this.button('Reset Settings', () => this.mods.resetConfig(m.id)),
      this.button('Uninstall', () => {
        this.mods.uninstall(m.id);
        this.detail = null;
        this.render();
      }, 'mk-uninstall'),
    );
    if (m.widget) row.append(this.button('Move on screen…', () => this.cb.onEditHud()));
    this.body.append(row);
  }

  private optionControl(m: ModDef, o: ModOption): HTMLElement {
    const v = this.mods.cfg(m.id, o.key);
    switch (o.type) {
      case 'toggle':
        return this.button(`${o.label}: ${v ? 'ON' : 'OFF'}`, () => this.mods.set(m.id, o.key, !v));
      case 'select': {
        const idx = Math.max(0, o.options.findIndex(([val]) => val === v));
        return this.button(`${o.label}: ${o.options[idx][1]}`, () => this.mods.set(m.id, o.key, o.options[(idx + 1) % o.options.length][0]));
      }
      case 'color': {
        const input = h('input', { type: 'color' });
        input.value = String(v);
        input.addEventListener('input', () => this.mods.set(m.id, o.key, input.value));
        return h('label', { class: 'mc-btn mk-color' }, `${o.label}`, input);
      }
      case 'slider': {
        const out = h('span', { class: 'slider-value' });
        const input = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step) });
        const wrap = h('label', { class: 'mc-slider' }, input, out);
        const paint = (n: number) => {
          const shown = o.unit === '%' ? `${Math.round(n * 100)}%` : o.unit === 'x' ? `${n}×` : o.unit === 'px' ? `${n} px` : String(n);
          out.textContent = `${o.label}: ${shown}`;
          wrap.style.setProperty('--p', String((n - o.min) / (o.max - o.min)));
        };
        input.value = String(v);
        paint(Number(v));
        input.addEventListener('input', () => {
          paint(Number(input.value));
          this.mods.set(m.id, o.key, Number(input.value));
        });
        return wrap;
      }
    }
  }

  private renderPacks() {
    const list = h('div', { class: 'mk-list' });
    const icon = packImage('pack');
    const card = h(
      'div',
      { class: 'mk-card installed' },
      iconCanvas(icon, 32),
      h(
        'div',
        { class: 'mk-text' },
        h('div', { class: 'mk-name' }, 'Bare Bones 1.21.11', h('span', { class: 'mk-cat visual' }, 'Default')),
        h('div', { class: 'mk-desc' }, 'The textures the game uses: a clean take on the vanilla look. Always on.'),
      ),
      h('div', { class: 'mk-actions' }, h('span', { class: 'mk-active' }, '✓ Active')),
    );
    list.append(card);
    list.append(h('div', { class: 'mk-empty' }, 'More resource packs are coming to the Marketplace soon.'));
    this.body.append(list);
  }
}
