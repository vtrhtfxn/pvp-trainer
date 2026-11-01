import type { Fighter } from '../game/Fighter';
import { ITEMS, type ItemId, type ItemStack } from '../game/items';
import type { BroadcastInfo } from '../game/TourneyWatch';
import { itemIcon } from '../render/itemIcons';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** What the inventory row counts, most telling first; the first few either fighter has are shown. */
const COUNTED: { id: ItemId; potion?: string }[] = [
  { id: 'splash_potion', potion: 'healing' },
  { id: 'golden_apple' },
  { id: 'totem_of_undying' },
  { id: 'ender_pearl' },
  { id: 'wind_charge' },
  { id: 'end_crystal' },
  { id: 'experience_bottle' },
  { id: 'cooked_beef' },
  { id: 'arrow' },
  { id: 'cobweb' },
];

function count(f: Fighter, c: { id: ItemId; potion?: string }): number {
  let n = 0;
  for (let i = 0; i < 41; i++) {
    const s = f.getSlot(i);
    if (s && s.id === c.id && (!c.potion || s.potion === c.potion)) n += s.count;
  }
  return n;
}

/** Durability left on an armor piece (null: none worn). */
function durability(s: ItemStack | null): number | null {
  if (!s) return null;
  const max = ITEMS[s.id].maxDamage;
  return max ? max - (s.damage ?? 0) : null;
}

const iconUrls = new Map<string, string>();
function iconUrl(s: ItemStack): string {
  const key = `${s.id}:${s.potion ?? ''}`;
  let u = iconUrls.get(key);
  if (u === undefined) {
    u = itemIcon(s)?.toDataURL() ?? '';
    iconUrls.set(key, u);
  }
  return u;
}

function icon(s: ItemStack, parent: HTMLElement) {
  const img = el('img', 'bc-ico', parent);
  img.src = iconUrl(s);
  img.alt = '';
}

/** Ten hearts: full, half or empty (and the absorption on top as a gold number). */
function hearts(f: Fighter, parent: HTMLElement) {
  const box = el('div', 'bc-hearts', parent);
  const hp = Math.max(0, f.health);
  for (let i = 0; i < 10; i++) {
    const left = hp - i * 2;
    el('span', `bc-heart ${left >= 2 ? 'full' : left >= 1 ? 'half' : 'empty'}`, box);
  }
  if (f.absorption > 0) el('span', 'bc-abs', box, `+${Math.ceil(f.absorption / 2)}`);
}

/** Best of three: two diamonds a side, filled for each game won. */
function diamonds(wins: number, parent: HTMLElement) {
  const box = el('div', 'bc-diamonds', parent);
  for (let i = 0; i < 2; i++) el('span', `bc-dia${i < wins ? ' won' : ''}`, box);
}

const clock = (ticks: number) => {
  const s = Math.floor(ticks / 20);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The tournament broadcast overlay, PvP Champs style: the kit and whose pick it was, both
 * fighters' names, hearts, seeds and series diamonds around a crest; their inventories (pots,
 * apples, totems… and armor durability) underneath; the series and match clock on the right; and
 * an intro card before every game.
 */
export class BroadcastHud {
  readonly root: HTMLDivElement;
  private readonly top: HTMLDivElement;
  private readonly inv: HTMLDivElement;
  private readonly side: HTMLDivElement;
  private readonly introEl: HTMLDivElement;
  private last = '';
  private introTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'bc', parent);
    this.top = el('div', 'bc-top', this.root);
    this.inv = el('div', 'bc-inv', this.root);
    this.side = el('div', 'bc-side', this.root);
    this.introEl = el('div', 'bc-intro', this.root);
    this.root.style.display = 'none';
  }

  show() {
    this.root.style.display = '';
  }

  hide() {
    this.root.style.display = 'none';
    this.last = '';
  }

  /** Redraws when anything shown changed (health to the half heart, counts, the clock). */
  update(info: BroadcastInfo, a: Fighter, b: Fighter, fightTicks: number) {
    const shown = COUNTED.filter((c) => count(a, c) + count(b, c) > 0).slice(0, 4);
    const sig = JSON.stringify([
      info.kit.id,
      info.pickedBy,
      info.wins,
      [a, b].map((f) => [f.name, Math.ceil(f.health), Math.ceil(f.absorption), shown.map((c) => count(f, c)), f.armorSlots.map(durability)]),
      Math.floor(fightTicks / 20),
    ]);
    if (sig === this.last) return;
    this.last = sig;

    // ---- top bar
    this.top.replaceChildren();
    const kit = el('div', 'bc-kit', this.top);
    el('div', 'bc-kit-name', kit, info.kit.name.toUpperCase());
    el('div', 'bc-kit-pick', kit, info.pickedBy);
    const bar = el('div', 'bc-bar', this.top);
    const player = (f: Fighter, seed: number, wins: number, right: boolean) => {
      const p = el('div', `bc-player${right ? ' right' : ''}`, bar);
      const row = el('div', 'bc-prow', p);
      el('div', 'bc-name', row, f.name.toUpperCase());
      hearts(f, row);
      const sub = el('div', 'bc-psub', p);
      el('span', 'bc-seed', sub, `Seed ${seed}`);
      diamonds(wins, sub);
    };
    player(a, info.seeds[0], info.wins[0], false);
    const crest = el('div', 'bc-crest', bar);
    el('div', 'bc-crest-a', crest, 'PVP');
    el('div', 'bc-crest-b', crest, 'CHAMPS');
    player(b, info.seeds[1], info.wins[1], true);

    // ---- inventory row: theirs mirrored around the label
    this.inv.replaceChildren();
    const half = (f: Fighter, right: boolean) => {
      const h = el('div', `bc-inv-side${right ? ' right' : ''}`, this.inv);
      const items = shown.map((c) => () => {
        const cell = el('span', 'bc-cell', h);
        if (right) icon({ id: c.id, count: 1, potion: c.potion as never }, cell);
        el('b', '', cell, String(count(f, c)));
        if (!right) icon({ id: c.id, count: 1, potion: c.potion as never }, cell);
      });
      const armor = [0, 1, 2, 3].map((i) => () => {
        const s = f.armorSlots[i];
        const d = durability(s);
        if (!s || d === null) return;
        const cell = el('span', 'bc-cell armor', h);
        if (right) icon(s, cell);
        el('b', '', cell, String(d));
        if (!right) icon(s, cell);
      });
      // Left: consumables then armor (outside in); right: armor then consumables.
      for (const draw of right ? [...armor, ...items] : [...items, ...armor.reverse()]) draw();
    };
    half(a, false);
    el('div', 'bc-inv-label', this.inv, 'INVENTORY');
    half(b, true);

    // ---- right-hand panel
    this.side.replaceChildren();
    el('div', 'bc-side-title', this.side, 'PVP TRAINER CHAMPS');
    el('div', 'bc-side-line', this.side, `⚔ ${info.round}`);
    el('div', 'bc-side-line', this.side, `Series ${info.wins[0]} – ${info.wins[1]} (Best of 3)`);
    el('div', 'bc-side-line', this.side, `Game ${info.game} · ${info.kit.name}`);
    el('div', 'bc-side-line', this.side, `⏱ Match time: ${clock(fightTicks)}`);
  }

  /** The card that sweeps in before a game: round and game, the two names, the kit. */
  intro(lines: { top: string; a: string; b: string; kit: string; colorA: string; colorB: string }, only = false) {
    const e = this.introEl;
    // Before your own game: just the card (your HUD has its own bar).
    if (only) {
      this.root.classList.add('intro-only');
      this.show();
    } else this.root.classList.remove('intro-only');
    e.replaceChildren();
    el('div', 'bc-intro-top', e, lines.top);
    const vs = el('div', 'bc-intro-vs', e);
    const a = el('span', 'bc-intro-name', vs, lines.a);
    a.style.color = lines.colorA;
    el('span', 'bc-intro-x', vs, 'VS');
    const b = el('span', 'bc-intro-name', vs, lines.b);
    b.style.color = lines.colorB;
    el('div', 'bc-intro-kit', e, lines.kit);
    e.classList.remove('on');
    void e.offsetWidth; // restart the animation
    e.classList.add('on');
    if (this.introTimer) clearTimeout(this.introTimer);
    this.introTimer = setTimeout(() => {
      e.classList.remove('on');
      if (this.root.classList.contains('intro-only')) {
        this.root.classList.remove('intro-only');
        this.hide();
      }
    }, 3600);
  }
}
