import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../ai/difficulty';
import type { FighterStats } from '../game/Fighter';
import { KITS, customKitList, isCustomKit, kitById, type KitDef, type KitId } from '../game/kits';
import type { CustomKitData } from '../game/customKits';
import { KitEditor } from './KitEditor';
import { ACTION_GROUPS, ACTION_LABELS, DEFAULT_KEYS, conflicts, keyName, type Action } from '../input/keybinds';
import type { Sprite } from './sprites';
import { DEFAULT_SETTINGS, saveSettings, type Records, type Settings } from './settings';
import { MAX_FIRST_TO, TIER_POINTS, clampFirstTo, totalPoints, type MyTiers } from '../game/series';
import type { ReplayData } from '../game/replay';
import type { CoachReport } from '../game/coach';
import logoUrl from '../assets/logo.png';
import { DRILLS, DRILL_GROUPS, type DrillBest, type DrillDef, type DrillResult } from '../trainer/drills';

export interface MenuCallbacks {
  onStart(): void;
  /** Bot vs Bot: watch tier `a` fight tier `b` in `kit`. */
  onSpectate(kit: KitId, a: DifficultyId, b: DifficultyId): void;
  /** Trainer: start a drill. */
  onDrill(id: string): void;
  /** Trainer: the best result of each drill. */
  drillProgress(): Record<string, DrillBest>;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSettingsChanged(): void;
  onUiSound(): void;
  onConnect(url: string, room: string, name: string): void;
  /** Online over the internet: host a game in this window / join a friend's by its code. */
  onHostOnline(name: string): void;
  onJoinOnline(code: string, name: string): void;
  onLeaveOnline(): void;
  /** Opens the Marketplace (mods and resource packs). */
  onMarketplace(): void;
  /** How many mods are installed (for the Marketplace button). */
  installedMods(): number;
  /** The tiers earned so far (My Tiers). */
  myTiers(): MyTiers;
  /** Replays: watch, star (keep for good) or delete a saved duel. */
  onWatchReplay(r: ReplayData): void;
  /** Match Coach for a saved replay. */
  onCoachReplay(r: ReplayData): void;
  onStarReplay(id: string): void;
  onDeleteReplay(id: string): void;
}

/** Title-screen card that stands for all custom kits. */
const CUSTOM_CARD = 'custom';

type SettingsTab = 'video' | 'controls' | 'keys' | 'sound' | 'hud' | 'chat';
const TAB_LABELS: Record<SettingsTab, string> = {
  video: 'Video',
  controls: 'Controls',
  keys: 'Key Binds',
  sound: 'Sound',
  hud: 'HUD',
  chat: 'Chat',
};

type ScreenName = 'main' | 'pause' | 'settings' | 'controls' | 'results' | 'multiplayer' | 'tiers' | 'versus' | 'trainer' | 'kits' | 'subtiers' | 'replays' | 'coach';

export interface ResultData {
  won: boolean;
  seconds: number;
  player: FighterStats;
  bot: FighterStats;
  botName: string;
  newBestCombo: boolean;
  /** Online duels are not recorded against a bot difficulty. */
  online?: boolean;
  /** Commands changed the duel, so it was not recorded. */
  unrecorded?: boolean;
  /** The "first to" series this round finished (absent for a single duel). */
  series?: { target: number; you: number; bot: number };
  /** A tier this win earned (My Tiers). */
  tierEarned?: { name: string; color: string; kit: string; points: number };
  /** The series was won, but commands changed it, so no tier. */
  tierBlocked?: boolean;
}

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

/** Title screen, pause menu, settings, controls and the post-duel results screen. */
export class Menus {
  /** "Build N" in the title screen's footer (the desktop app's release number). */
  private readonly buildEl = h('span', { class: 'build-tag' });

  setBuild(n: number) {
    this.buildEl.textContent = n > 0 ? ` · Build ${n}` : '';
  }

  private readonly screens: Record<ScreenName, HTMLDivElement>;
  private settingsReturn: 'main' | 'pause' = 'main';
  private recordEl!: HTMLDivElement;
  private readonly settingsRepaint: (() => void)[] = [];
  private netStatusEl!: HTMLDivElement;
  private netRoomEl!: HTMLDivElement;
  private nameInput!: HTMLInputElement;
  private roomInput!: HTMLInputElement;
  private serverInput!: HTMLInputElement;
  private diffDesc!: HTMLDivElement;
  private ftValue!: HTMLDivElement;
  private kitInfo!: HTMLDivElement;
  private marketBtns: HTMLButtonElement[] = [];
  private settingsTab: SettingsTab = 'video';
  private settingsBody!: HTMLDivElement;
  private tabButtons = {} as Record<SettingsTab, HTMLButtonElement>;
  /** The key-bind button waiting for a key, if any. */
  private binding: { action: Action; btn: HTMLButtonElement } | null = null;
  private controlsTable!: HTMLDivElement;
  private readonly kitEditor: KitEditor;

  constructor(
    parent: HTMLElement,
    private readonly settings: Settings,
    private records: Records,
    private readonly kitIcons: Record<string, Sprite>,
    private readonly cb: MenuCallbacks,
    customKits: CustomKitData[] = [],
  ) {
    this.screens = {
      main: this.buildMain(),
      pause: this.buildPause(),
      settings: this.buildSettings(),
      controls: this.buildControls(),
      multiplayer: this.buildMultiplayer(),
      results: h('div', { class: 'screen results' }),
      tiers: h('div', { class: 'screen tiers' }),
      versus: h('div', { class: 'screen versus' }),
      trainer: h('div', { class: 'screen trainer' }),
      kits: h('div', { class: 'screen kit-editor' }),
      subtiers: h('div', { class: 'screen subtiers' }),
      replays: h('div', { class: 'screen replays' }),
      coach: h('div', { class: 'screen coach' }),
    };
    this.kitEditor = new KitEditor(this.screens.kits, customKits, {
      onUiSound: () => this.cb.onUiSound(),
      onBack: () => this.show('main'),
      onPlay: (id) => {
        this.settings.kit = id;
        saveSettings(this.settings);
        this.cb.onStart();
      },
    });
    for (const s of Object.values(this.screens)) {
      s.style.display = 'none';
      parent.appendChild(s);
    }
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', { class: `mc-btn ${cls}` }, label);
    b.addEventListener('click', () => {
      this.cb.onUiSound();
      onClick();
    });
    return b;
  }

  hideAll() {
    for (const s of Object.values(this.screens)) s.style.display = 'none';
  }

  show(name: ScreenName) {
    this.hideAll();
    this.screens[name].style.display = '';
    if (name === 'main') this.refreshMain();
    if (name === 'tiers') this.renderTiers();
    if (name === 'versus') this.renderVersus();
    if (name === 'trainer') this.renderTrainer();
    if (name === 'kits') this.kitEditor.render();
    if (name === 'subtiers') this.renderSubtiers();
    if (name === 'replays') this.renderReplays();
    if (name === 'controls') this.refreshControls();
    if (name === 'settings') this.renderSettings();
    for (const b of this.marketBtns) b.textContent = this.marketLabel();
  }

  private marketLabel(): string {
    const n = this.cb.installedMods();
    return n ? `Marketplace (${n} mod${n === 1 ? '' : 's'})` : 'Marketplace';
  }

  /** Where "Done" in the Marketplace goes back to. */
  get settingsFrom(): 'main' | 'pause' {
    return this.settingsReturn;
  }

  get visible(): boolean {
    return Object.values(this.screens).some((s) => s.style.display !== 'none');
  }

  // ------------------------------------------------------------------ main menu

  private buildMain(): HTMLDivElement {
    const root = h('div', { class: 'screen main-menu' });
    const panel = h('div', { class: 'menu-panel' });
    const logo = h(
      'div',
      { class: 'logo' },
      h('img', { class: 'logo-img', src: logoUrl, alt: 'PvP Trainer', draggable: 'false' }),
      h('div', { class: 'splash' }, 'Now with 1.8 PvP!'),
    );
    panel.append(logo);

    panel.append(h('div', { class: 'section-title' }, 'Game mode'));
    const grid = h('div', { class: 'kit-grid' });
    for (const kit of KITS.filter((k) => !k.subtier)) {
      const icon = this.kitIcons[kit.icon];
      const iconEl = h('canvas', { class: 'kit-icon', width: '16', height: '16' });
      if (icon) {
        const ctx = iconEl.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(icon, 0, 0, 16, 16);
      }
      const card = h(
        'button',
        { class: `kit-card${kit.available ? '' : ' locked'}`, 'data-kit': kit.id, title: kit.summary },
        iconEl,
        h('span', { class: 'kit-name' }, kit.name),
      );
      if (!kit.available) card.append(h('span', { class: 'soon' }, 'SOON'));
      card.addEventListener('click', () => {
        if (!kit.available) return;
        this.cb.onUiSound();
        this.settings.kit = kit.id as KitId;
        saveSettings(this.settings);
        this.refreshMain();
      });
      grid.append(card);
    }
    // One card for every kit you made; the kit info below picks between them.
    const customCard = h(
      'button',
      { class: 'kit-card', 'data-kit': CUSTOM_CARD, title: 'Build your own kits: any items, enchantments and potions.' },
      this.iconEl('custom'),
      h('span', { class: 'kit-name' }, 'Custom'),
    );
    customCard.addEventListener('click', () => {
      this.cb.onUiSound();
      const kits = customKitList();
      if (!kits.length) {
        this.openKitEditor('new');
        return;
      }
      if (!isCustomKit(this.settings.kit) || !kits.some((k) => k.id === this.settings.kit)) this.settings.kit = kits[0].id;
      saveSettings(this.settings);
      this.refreshMain();
    });
    grid.append(customCard);
    panel.append(grid);
    this.kitInfo = h('div', { class: 'kit-info' });
    panel.append(this.kitInfo);

    panel.append(h('div', { class: 'section-title' }, 'Bot tier'));
    const diffs = h('div', { class: 'diff-row' });
    for (const id of DIFFICULTY_ORDER) {
      const d = DIFFICULTIES[id];
      const b = h('button', { class: id === 'practice' ? 'diff-btn diff-practice' : 'diff-btn', 'data-diff': id }, d.name);
      b.style.setProperty('--diff', d.color);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        this.settings.difficulty = id as DifficultyId;
        saveSettings(this.settings);
        this.refreshMain();
      });
      diffs.append(b);
    }
    panel.append(diffs);
    this.diffDesc = h('div', { class: 'diff-desc' });
    panel.append(this.diffDesc);

    // First to N: rounds against the same bot until one side has N wins.
    const setFt = (n: number) => {
      this.settings.firstTo = clampFirstTo(n);
      saveSettings(this.settings);
      this.refreshMain();
    };
    this.ftValue = h('div', { class: 'ft-value' });
    panel.append(
      h(
        'div',
        { class: 'ft-row', title: `Rounds against the same bot until one side has this many wins (up to ${MAX_FIRST_TO}). Win a series against a tier bot to earn that tier in My Tiers.` },
        h('span', { class: 'section-title' }, 'First to'),
        this.button('−', () => setFt(this.settings.firstTo - 1), 'ft-btn'),
        this.ftValue,
        this.button('+', () => setFt(this.settings.firstTo + 1), 'ft-btn'),
      ),
    );

    panel.append(this.button('Start Duel', () => this.cb.onStart(), 'big'));
    panel.append(
      h(
        'div',
        { class: 'btn-row five' },
        this.button('Trainer', () => this.show('trainer'), 'trainer-btn'),
        this.button('Subtiers', () => this.show('subtiers'), 'subtier-btn'),
        this.button('Bot vs Bot', () => this.show('versus')),
        this.button('Replays', () => this.show('replays'), 'replay-btn'),
        this.button('Multiplayer', () => this.show('multiplayer'), 'online'),
      ),
    );
    const market = this.button('Marketplace', () => {
      this.settingsReturn = 'main';
      this.cb.onMarketplace();
    }, 'market-btn');
    this.marketBtns.push(market);
    panel.append(
      h(
        'div',
        { class: 'btn-row four' },
        this.button('Settings', () => this.openSettings('main')),
        this.button('Controls', () => this.show('controls')),
        this.button('My Tiers', () => this.show('tiers')),
        market,
      ),
    );
    this.recordEl = h('div', { class: 'record' });
    panel.append(this.recordEl);
    root.append(panel);
    root.append(
      h(
        'div',
        { class: 'credits' },
        'Not affiliated with Mojang. Textures: Minecraft default resource pack (Mojang). Player rig (CC-BY 4.0) by lewisglasgow2005.',
        this.buildEl,
      ),
    );
    return root;
  }

  private iconEl(key: string): HTMLCanvasElement {
    const el = h('canvas', { class: 'kit-icon', width: '16', height: '16' });
    const icon = this.kitIcons[key];
    if (icon) {
      const ctx = el.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(icon, 0, 0, 16, 16);
    }
    return el;
  }

  /** Opens the kit editor on a custom kit (or 'new' for a fresh one). */
  openKitEditor(id?: string) {
    this.show('kits');
    this.kitEditor.open(id);
  }

  /** The chips under a custom kit: switch kit, edit it, or make another. */
  private customKitInfo(kit: KitDef): HTMLElement {
    const row = h('div', { class: 'custom-kit-row' });
    for (const k of customKitList()) {
      const b = this.button(k.name, () => {
        this.settings.kit = k.id;
        saveSettings(this.settings);
        this.refreshMain();
      }, `custom-chip${k.id === kit.id ? ' selected' : ''}`);
      row.append(b);
    }
    row.append(this.button('Edit', () => this.openKitEditor(kit.id), 'custom-chip edit'));
    row.append(this.button('+ New', () => this.openKitEditor('new'), 'custom-chip edit'));
    return row;
  }

  refreshMain(records?: Records) {
    if (records) this.records = records;
    const kit = kitById(this.settings.kit);
    const d = DIFFICULTIES[this.settings.difficulty];
    const cardId = kit.custom ? CUSTOM_CARD : kit.id;
    this.screens.main.querySelector('.subtier-btn')?.classList.toggle('selected', !!kit.subtier);
    this.screens.main.querySelectorAll<HTMLElement>('.kit-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.kit === cardId);
    });
    this.screens.main.querySelectorAll<HTMLElement>('.diff-btn').forEach((b) => {
      b.classList.toggle('selected', b.dataset.diff === d.id);
    });
    this.kitInfo.replaceChildren(
      h('div', { class: 'kit-summary' }, kit.custom ? `${kit.name} — your own kit (offline: bots and Bot vs Bot; earns no tier).` : kit.summary),
      h('ul', {}, ...kit.contents.map((c) => h('li', {}, c))),
    );
    if (kit.custom) this.kitInfo.append(this.customKitInfo(kit));
    this.diffDesc.textContent = d.tagline;
    const ft = this.settings.firstTo;
    this.ftValue.textContent = ft === 1 ? 'FT1 — single duel' : `FT${ft} — first to ${ft} wins`;
    this.diffDesc.style.color = d.color;
    const r = this.records[`${kit.id}:${d.id}`];
    this.recordEl.textContent = r
      ? `Record vs ${d.name}: ${r.wins}W – ${r.losses}L · best combo ${r.bestCombo}`
      : `No duels vs ${d.name} yet`;
  }

  // ------------------------------------------------------------------ pause

  private restartBtn!: HTMLElement;

  /** Online there is nothing to restart: that would quietly leave the match for a bot duel. */
  setOnline(online: boolean) {
    this.restartBtn.style.display = online ? 'none' : '';
  }

  private buildPause(): HTMLDivElement {
    const root = h('div', { class: 'screen pause' });
    const panel = h('div', { class: 'menu-panel small' });
    panel.append(h('div', { class: 'screen-title' }, 'Game Paused'));
    panel.append(this.button('Back to Duel', () => this.cb.onResume(), 'big'));
    this.restartBtn = this.button('Restart Duel', () => this.cb.onRestart());
    panel.append(this.restartBtn);
    panel.append(this.button('Settings', () => this.openSettings('pause')));
    const market = this.button('Marketplace', () => {
      this.settingsReturn = 'pause';
      this.cb.onMarketplace();
    }, 'market-btn');
    this.marketBtns.push(market);
    panel.append(market);
    panel.append(this.button('Quit to Title', () => this.cb.onQuit()));
    root.append(panel);
    return root;
  }

  // ------------------------------------------------------------------ settings

  openSettings(from: 'main' | 'pause') {
    this.settingsReturn = from;
    this.show('settings');
  }

  private buildSettings(): HTMLDivElement {
    const root = h('div', { class: 'screen settings' });
    const panel = h('div', { class: 'menu-panel wide' });
    panel.append(h('div', { class: 'screen-title' }, 'Options'));
    const tabs = h('div', { class: 'settings-tabs' });
    for (const t of Object.keys(TAB_LABELS) as SettingsTab[]) {
      const b = h('button', { class: 'settings-tab' }, TAB_LABELS[t]);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        this.settingsTab = t;
        this.renderSettings();
      });
      this.tabButtons[t] = b;
      tabs.append(b);
    }
    panel.append(tabs);
    this.settingsBody = h('div', { class: 'settings-body' });
    panel.append(this.settingsBody);
    panel.append(this.button('Done', () => this.show(this.settingsReturn), 'big'));
    root.append(panel);
    // Key binding: the next key or mouse button pressed is the new bind (Esc unbinds).
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.binding) return;
        e.preventDefault();
        e.stopPropagation();
        this.finishBinding(e.code === 'Escape' ? '' : e.code);
      },
      true,
    );
    window.addEventListener(
      'mousedown',
      (e) => {
        if (!this.binding || e.target === this.binding.btn) return;
        e.preventDefault();
        e.stopPropagation();
        this.finishBinding(`Mouse${e.button}`);
      },
      true,
    );
    return root;
  }

  private finishBinding(code: string) {
    const b = this.binding;
    if (!b) return;
    this.binding = null;
    this.settings.keys[b.action] = code;
    this.saveAndApply();
    this.renderSettings();
  }

  private saveAndApply() {
    saveSettings(this.settings);
    this.cb.onSettingsChanged();
  }

  /** Builds the open tab of the options screen. */
  private renderSettings() {
    const s = this.settings;
    this.binding = null;
    this.settingsRepaint.length = 0;
    for (const [t, b] of Object.entries(this.tabButtons)) b.classList.toggle('on', t === this.settingsTab);
    const body = this.settingsBody;
    body.replaceChildren();
    let grid = h('div', { class: 'settings-grid' });
    body.append(grid);
    const section = (title: string) => {
      body.append(h('div', { class: 'settings-section' }, title));
      grid = h('div', { class: 'settings-grid' });
      body.append(grid);
    };
    const changed = () => this.saveAndApply();
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string, hint = '') => {
      const out = h('span', { class: 'slider-value' });
      const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      const wrap = h('label', { class: 'mc-slider' }, input, out);
      if (hint) wrap.title = hint;
      const paint = () => {
        const v = Number(input.value);
        out.textContent = `${label}: ${fmt(v)}`;
        wrap.style.setProperty('--p', String((v - min) / (max - min)));
      };
      input.value = String(get());
      paint();
      input.addEventListener('input', () => {
        set(Number(input.value));
        paint();
        changed();
      });
      grid.append(wrap);
    };
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void, hint = '') => {
      const b = h('button', { class: 'mc-btn' });
      if (hint) b.title = hint;
      const paint = () => (b.textContent = `${label}: ${get() ? 'ON' : 'OFF'}`);
      paint();
      this.settingsRepaint.push(paint);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        set(!get());
        paint();
        changed();
      });
      grid.append(b);
    };
    const cycle = <T extends string>(label: string, options: [T, string][], get: () => T, set: (v: T) => void, hint = '') => {
      const b = h('button', { class: 'mc-btn' });
      if (hint) b.title = hint;
      const paint = () => {
        const cur = options.find(([v]) => v === get()) ?? options[0];
        b.textContent = `${label}: ${cur[1]}`;
      };
      paint();
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        const i = options.findIndex(([v]) => v === get());
        set(options[(i + 1) % options.length][0]);
        paint();
        changed();
      });
      grid.append(b);
    };
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const vol = (v: number) => (v === 0 ? 'OFF' : pct(v));

    switch (this.settingsTab) {
      case 'video': {
        slider('FOV', 30, 110, 1, () => s.fov, (v) => (s.fov = v), (v) => (v === 70 ? 'Normal' : v === 110 ? 'Quake Pro' : String(v)));
        slider('FOV Effects', 0, 1, 0.05, () => s.fovEffects, (v) => (s.fovEffects = v), pct, 'How much sprinting, speed and bows widen or narrow the view');
        slider('Hand FOV', 30, 110, 1, () => s.handFov, (v) => (s.handFov = v), (v) => (v === 70 ? 'Normal' : String(v)), 'Field of view of your hand and held item only');
        slider('Third Person Distance', 1, 12, 0.5, () => s.thirdPersonDistance, (v) => (s.thirdPersonDistance = v), (v) => `${v} blocks`);
        slider('Brightness', 0, 1, 0.01, () => s.brightness, (v) => (s.brightness = v), (v) => (v === 0 ? 'Moody' : v === 1 ? 'Bright' : v === 0.5 ? 'Default' : `+${Math.round(v * 100)}%`), 'How bright nights and storms are');
        slider('GUI Scale', 0, 4, 1, () => s.guiScale, (v) => (s.guiScale = v), (v) => (v === 0 ? 'Auto' : String(v)));
        slider('Damage Tilt', 0, 1, 0.05, () => s.damageTilt, (v) => (s.damageTilt = v), pct);
        toggle('View Bobbing', () => s.viewBobbing, (v) => (s.viewBobbing = v));
        section('Performance');
        slider(
          'Max Framerate',
          30,
          260,
          10,
          () => (s.maxFps === 0 ? 260 : s.maxFps),
          (v) => (s.maxFps = v >= 260 ? 0 : v),
          (v) => (v >= 260 ? 'Unlimited' : `${v} fps`),
          'Caps the frame rate to save power. Unlimited = your screen’s refresh rate (60 Hz screen = 60 FPS) unless Uncapped FPS is on',
        );
        slider(
          'Render Scale',
          20,
          100,
          5,
          () => (s.renderScale === 0 ? 20 : s.renderScale),
          (v) => (s.renderScale = v < 25 ? 0 : v),
          (v) => (v < 25 ? 'Auto' : `${v}%`),
          'Auto lowers the resolution only when frames get slow. Lower = smoother on weak computers',
        );
        const native = window.pvpNative;
        // Not offered on macOS, where switching VSync off starves the window server (see electron/main.cjs).
        if (native?.setUncapped && native.platform !== 'darwin') {
          // Lives in the app shell (a Chromium switch), not in the game's settings.
          let want = native.uncapped;
          const b = h('button', { class: 'mc-btn' });
          b.title = 'VSync off: more FPS and slightly quicker input, but can stutter and makes laptops hot. Applies when you restart the app';
          const paint = () => (b.textContent = `Uncapped FPS: ${want ? 'ON' : 'OFF'}${want !== native.uncapped ? ' (restart app)' : ''}`);
          paint();
          b.addEventListener('click', () => {
            this.cb.onUiSound();
            want = !want;
            void native.setUncapped(want);
            paint();
          });
          grid.append(b);
        }
        cycle<'all' | 'decreased' | 'minimal'>(
          'Particles',
          [
            ['all', 'All'],
            ['decreased', 'Decreased'],
            ['minimal', 'Minimal'],
          ],
          () => s.particles,
          (v) => (s.particles = v),
        );
        cycle<'auto' | 'on' | 'off'>(
          'Smooth Edges',
          [
            ['auto', 'Auto'],
            ['on', 'ON'],
            ['off', 'OFF'],
          ],
          () => s.antialias,
          (v) => (s.antialias = v),
          'Anti-aliasing (MSAA). Auto turns it off on high-density screens, where it costs a lot. Applies after a restart',
        );
        toggle('Entity Shadows', () => s.entityShadows, (v) => (s.entityShadows = v));
        toggle('Clouds', () => s.clouds, (v) => (s.clouds = v));
        toggle('Fog', () => s.fog, (v) => (s.fog = v));
        toggle('Menu Background', () => s.menuBackground, (v) => (s.menuBackground = v), 'The duel playing behind the title screen (off saves power)');
        if (!window.pvpNative) toggle('Fullscreen (blocks Ctrl+W)', () => s.fullscreenLock, (v) => (s.fullscreenLock = v));
        section('Hand');
        toggle('Show Hand', () => s.showHand, (v) => (s.showHand = v));
        slider('Hand Size', 0.5, 1.5, 0.05, () => s.handScale, (v) => (s.handScale = v), pct);
        slider('Hand X', -0.5, 0.5, 0.01, () => s.handX, (v) => (s.handX = v), (v) => v.toFixed(2), 'Moves both hands apart (+) or together (−)');
        slider('Hand Y', -0.5, 0.5, 0.01, () => s.handY, (v) => (s.handY = v), (v) => v.toFixed(2));
        slider('Hand Z', -0.5, 0.5, 0.01, () => s.handZ, (v) => (s.handZ = v), (v) => v.toFixed(2), 'Toward the screen (+) or away (−)');
        const reset = this.button('Reset Hand', () => {
          s.handX = s.handY = s.handZ = 0;
          s.handScale = 1;
          s.handFov = DEFAULT_SETTINGS.handFov;
          changed();
          this.renderSettings();
        });
        grid.append(reset);
        break;
      }
      case 'controls': {
        slider('Sensitivity', 0, 1, 0.005, () => s.sensitivity, (v) => (s.sensitivity = v), (v) => (v === 0 ? '*yawn*' : v === 1 ? 'HYPERSPEED!!!' : `${Math.round(v * 200)}%`));
        slider(
          'Vertical Sensitivity',
          -0.005,
          1,
          0.005,
          () => s.sensitivityY,
          (v) => (s.sensitivityY = v < 0 ? -1 : v),
          (v) => (v < 0 ? 'Same' : `${Math.round(v * 200)}%`),
          'Up/down mouse speed on its own (slide left for "Same")',
        );
        toggle('Invert Mouse', () => s.invertY, (v) => (s.invertY = v));
        toggle('Raw Mouse Input', () => s.rawInput, (v) => (s.rawInput = v));
        toggle('Toggle Sprint', () => s.toggleSprint, (v) => (s.toggleSprint = v));
        toggle('Toggle Sneak', () => s.toggleSneak, (v) => (s.toggleSneak = v));
        toggle('Double-tap W Sprint', () => s.doubleTapSprint, (v) => (s.doubleTapSprint = v));
        toggle('Invert Hotbar Scroll', () => s.invertScroll, (v) => (s.invertScroll = v));
        break;
      }
      case 'keys': {
        body.replaceChildren();
        const bad = conflicts(s.keys);
        const list = h('div', { class: 'keybinds' });
        for (const g of ACTION_GROUPS) {
          list.append(h('div', { class: 'settings-section' }, g.title));
          for (const a of g.actions) {
            const btn = h('button', { class: `mc-btn key-btn${bad.has(a) ? ' conflict' : ''}` }, keyName(s.keys[a]));
            btn.addEventListener('click', () => {
              this.cb.onUiSound();
              this.renderSettings();
              const again = this.settingsBody.querySelector<HTMLButtonElement>(`[data-action="${a}"]`);
              if (!again) return;
              again.textContent = `> ${keyName(s.keys[a])} <`;
              again.classList.add('listening');
              this.binding = { action: a, btn: again };
            });
            btn.dataset.action = a;
            const reset = h('button', { class: 'mc-btn key-reset' }, 'Reset');
            (reset as HTMLButtonElement).disabled = s.keys[a] === DEFAULT_KEYS[a];
            reset.addEventListener('click', () => {
              this.cb.onUiSound();
              s.keys[a] = DEFAULT_KEYS[a];
              changed();
              this.renderSettings();
            });
            list.append(h('div', { class: 'key-row' }, h('span', { class: 'key-label' }, ACTION_LABELS[a]), btn, reset));
          }
        }
        body.append(list);
        const all = this.button('Reset Keys', () => {
          s.keys = { ...DEFAULT_KEYS };
          changed();
          this.renderSettings();
        });
        body.append(h('div', { class: 'keybind-foot' }, all, h('span', { class: 'mk-note' }, 'Click a key, then press the new key or mouse button. Esc = not bound. Red = used twice.')));
        break;
      }
      case 'sound': {
        slider('Master Volume', 0, 1, 0.05, () => s.volume, (v) => (s.volume = v), vol);
        slider('Players', 0, 1, 0.05, () => s.volumePlayers, (v) => (s.volumePlayers = v), vol, 'Hits, hurt, shields, bows, explosions');
        slider('Footsteps', 0, 1, 0.05, () => s.volumeSteps, (v) => (s.volumeSteps = v), vol);
        slider('Blocks & World', 0, 1, 0.05, () => s.volumeBlocks, (v) => (s.volumeBlocks = v), vol, 'Blocks, buckets, eating, potions, pickups, rain and thunder');
        slider('Menus & Countdown', 0, 1, 0.05, () => s.volumeUi, (v) => (s.volumeUi = v), vol);
        break;
      }
      case 'hud': {
        toggle('Practice Panel', () => s.showPracticePanel, (v) => (s.showPracticePanel = v), 'The box with reach, combo, CPS and the next-hit coach');
        toggle('Reach Display', () => s.showReach, (v) => (s.showReach = v));
        toggle('Combo Counter', () => s.showCombo, (v) => (s.showCombo = v));
        toggle('CPS Counter', () => s.showCps, (v) => (s.showCps = v));
        toggle('Next-hit Coach', () => s.showNextHit, (v) => (s.showNextHit = v));
        toggle('Hit Feedback', () => s.hitFeedback, (v) => (s.hitFeedback = v));
        toggle('Opponent Health Bar', () => s.showOpponentBar, (v) => (s.showOpponentBar = v));
        toggle('Opponent Nametag', () => s.showNametag, (v) => (s.showNametag = v));
        toggle('Effect List', () => s.showEffects, (v) => (s.showEffects = v));
        toggle(/Mac|iP(hone|ad)/.test(navigator.platform) ? 'Hitboxes (⌘M)' : 'Hitboxes (Ctrl+M)', () => s.showHitboxes, (v) => (s.showHitboxes = v));
        break;
      }
      case 'chat': {
        cycle<'shown' | 'commands' | 'hidden'>(
          'Chat',
          [
            ['shown', 'Shown'],
            ['commands', 'Commands Only'],
            ['hidden', 'Hidden'],
          ],
          () => s.chatVisibility,
          (v) => (s.chatVisibility = v),
        );
        slider('Text Opacity', 0.1, 1, 0.01, () => s.chatOpacity, (v) => (s.chatOpacity = v), pct);
        slider('Background Opacity', 0, 1, 0.01, () => s.chatBackground, (v) => (s.chatBackground = v), pct);
        slider('Chat Text Size', 0.5, 1.5, 0.05, () => s.chatScale, (v) => (s.chatScale = v), pct);
        slider('Chat Width', 40, 320, 1, () => s.chatWidth, (v) => (s.chatWidth = v), (v) => `${v}px`);
        break;
      }
    }
  }

  /** Repaints the settings toggles after a setting changed from outside the menu (⌘M). */
  refreshSettings() {
    for (const paint of this.settingsRepaint) paint();
  }

  // ------------------------------------------------------------------ controls

  private buildControls(): HTMLDivElement {
    const root = h('div', { class: 'screen controls' });
    const panel = h('div', { class: 'menu-panel wide' });
    panel.append(h('div', { class: 'screen-title' }, 'Controls & Mechanics'));
    this.controlsTable = h('div', { class: 'controls-table' });
    panel.append(this.controlsTable);
    const tips = h(
      'ul',
      { class: 'tips' },
      h('li', {}, 'Reach is 3 blocks. Sprint hits deal extra knockback and cancel your sprint.'),
      h('li', {}, 'W-tap (release W for a moment) after a sprint hit to get sprint knockback again.'),
      h(
        'li',
        {},
        'Crit = hit while falling, airborne and NOT sprinting (server-side): 1.5× base damage. A sprint hit always wins over a crit, so release sprint before you click.',
      ),
      h(
        'li',
        {},
        'After a sprint hit your sprint is cancelled and the server never hears you restart it, so every later hit can crit — until you actually stop sprinting and get Sprint KB back. The "Next hit" line tells you which one you are about to land.',
      ),
      h('li', {}, 'Jump the moment you get hit (jump-reset) to take less knockback.'),
      h('li', {}, 'Full hunger + saturation heals fast. Golden apples give Regen II + Absorption.'),
      h('li', {}, 'With hitboxes on, a box turns yellow while that fighter is inside the other one\u2019s 3-block reach.'),
      h('li', {}, 'Practice difficulty never swings back — use it to drill combos, W-taps and reach. In the Axe kit it keeps its shield up, so you can drill shield disables.'),
      h('li', {}, 'Shield: blocks everything from the front half once it has been up for 0.25 s. You cannot attack while it is raised — lower it first.'),
      h('li', {}, 'An axe hit on a raised shield disables it for 5 s, at any charge.'),
      h('li', {}, 'NethPot: look straight down to pot — a splash heals less the further from your feet it lands (nothing past 4 blocks). Healing II is 4 hearts at best.'),
      h('li', {}, 'NethPot: after a totem pops, re-totem fast — slot key + F with a hotbar totem, or E, hover a totem, F.'),
      h('li', {}, 'P-crit: when a hit knocks you up, let go of sprint and hit on the way down — a crit without jumping.'),
      h('li', {}, 'UHC: hold left click to mine (axe for planks, sword for webs); right click places blocks and pours buckets — a bucket ignores players, so aim at the floor under their feet to lava them. Water puts fire out.'),
      h('li', {}, 'Mace: look straight down and throw a wind charge to fly up; smash on the way down — the longer the fall, the harder (Density for big falls, Breach for short ones). From high up: elytra on (right click it), jump to glide, dive, chestplate back on, smash.'),
      h('li', {}, 'Crystal: right click obsidian with a crystal, then left click the crystal. Knee-high crystals are half blocked by their own obsidian, so blow craters and set obsidian into the ground for foot-level hits.'),
      h('li', {}, 'Crystal: anchor = place, glowstone, then click it with anything else (your totem slot is safest). Blasts within 0.5 s of each other only deal the difference.'),
      h('li', {}, 'Diamond Pot: combos win — W-tap between sprint hits to keep them in the air. Low? Sprint away and pot at your feet (the potion carries your speed). Eat steak before hunger stops your sprint.'),
      h(
        'li',
        {},
        'Attribute swap: press a hotbar key and click on the same tick (within 50 ms). The hit uses the OLD item\u2019s damage and cooldown with the NEW item\u2019s effect — e.g. a fully charged sword hit that still disables a shield with the axe.',
      ),
    );
    panel.append(tips);
    panel.append(this.button('Done', () => this.show('main'), 'big'));
    root.append(panel);
    return root;
  }


  /** The controls table, spelled with the current key binds. */
  private refreshControls() {
    const k = this.settings.keys;
    const n = (a: Action) => keyName(k[a]);
    const rows: [string, string][] = [
      [`${n('forward')} ${n('left')} ${n('back')} ${n('right')}`, 'Move'],
      [n('jump'), 'Jump (hold to bunny-hop) · double-tap to fly in creative'],
      [n('sprint'), `Sprint (${this.settings.toggleSprint ? 'toggle' : 'hold'}) · or double-tap ${n('forward')}`],
      [n('sneak'), `Sneak${this.settings.toggleSneak ? ' (toggle)' : ''}`],
      [n('attack'), 'Attack — full damage every 0.6 s, clicking early resets the cooldown. Hold on a block to mine it'],
      [`${n('use')} (hold)`, 'Use: eat, raise the shield, draw the bow, load / fire the crossbow, throw a splash potion or XP bottle, place a block, pour or fill a bucket. Main hand first, then off hand'],
      [`${n('hotbar1')} – ${n('hotbar9')} / Scroll`, 'Hotbar (switching items resets the attack cooldown on the next tick)'],
      [n('swapHands'), 'Swap main hand and off hand'],
      [n('inventory'), `Inventory — drag or click items, shift-click to quick-move, hotbar keys / ${n('swapHands')} over a slot to swap`],
      [n('chat'), 'Chat — and commands like /tick rate 10, /reach 4, /effect give @s speed, /gamemode creative, /time set night. /help lists them all'],
      [n('command'), 'Open chat with a / already typed'],
      [`${n('perspective')} or V`, 'Toggle third person'],
      ['⌘M (or F3 + B)', 'Toggle combat hitboxes — white box, red eye line, blue reach ray'],
      ['Esc', 'Pause'],
      [n('rematch'), 'Rematch after a duel'],
    ];
    this.controlsTable.replaceChildren();
    for (const [key, v] of rows) this.controlsTable.append(h('kbd', {}, key), h('span', {}, v));
  }

  // ------------------------------------------------------------------ multiplayer

  private buildMultiplayer(): HTMLDivElement {
    const root = h('div', { class: 'screen multiplayer' });
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Multiplayer'));

    const field = (parent: HTMLElement, label: string, value: string, placeholder: string, maxLength = 32) => {
      const input = h('input', { class: 'mc-input', type: 'text', placeholder, maxlength: String(maxLength) });
      input.value = value;
      parent.append(h('label', { class: 'mp-field' }, h('span', {}, label), input));
      return input;
    };
    const name = () => {
      const n = this.nameInput.value.trim() || 'Player';
      saveNetName(n);
      return n;
    };

    // ---- over the internet (the host's game is the server; WebRTC straight between the two)
    panel.append(
      h(
        'div',
        { class: 'mp-intro' },
        'Play a friend anywhere over the internet — different homes, different Wi-Fi. One of you hosts and reads out the code, the other types it in. Nothing to install or run.',
      ),
    );
    this.nameInput = field(panel, 'Your name', loadNetName(), 'Steve', 16);
    this.netRoomEl = h('div', { class: 'mp-room' });
    this.netStatusEl = h('div', { class: 'mp-status' });
    panel.append(this.netRoomEl, this.netStatusEl);
    panel.append(this.button('Host online game', () => this.cb.onHostOnline(name()), 'big online'));
    const code = h('input', { class: 'mc-input mp-code', type: 'text', placeholder: 'Friend\u2019s code', maxlength: '8', autocomplete: 'off', spellcheck: 'false' });
    const join = () => this.cb.onJoinOnline(code.value, name());
    code.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') join();
    });
    panel.append(h('div', { class: 'mp-join' }, code, this.button('Join', join, 'big')));
    panel.append(h('div', { class: 'mp-hint' }, 'The host\u2019s kit (picked on the main menu) is the one you both play.'));

    // ---- same network: the Node server (rooms, many players, browsers without the app)
    const lan = h('details', { class: 'mp-lan' });
    lan.append(h('summary', {}, 'Same network (LAN server)'));
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      lan.append(
        h('div', { class: 'mp-warn' }, 'Not the host? Type the host\u2019s address in ', h('b', {}, 'Server'), ' (the one their server window prints, for example 192.168.1.23).'),
      );
    }
    this.roomInput = field(lan, 'Room code', '', 'blank = create a new one', 8);
    this.serverInput = field(lan, 'Server', loadNetServer(), '192.168.1.23 (the host\u2019s address)', 120);
    const go = (room: string) => {
      const server = this.serverInput.value.trim() || defaultServerUrl();
      saveNetServer(server);
      this.cb.onConnect(server, room, name());
    };
    lan.append(
      h('div', { class: 'btn-row' }, this.button('Host a new room', () => go('')), this.button('Join room code', () => go(this.roomInput.value.trim()))),
    );
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go(this.roomInput.value.trim());
    });
    lan.append(
      h(
        'div',
        { class: 'mp-help' },
        'Run the server (',
        h('code', {}, 'npm run server'),
        ', or the START launcher). Players type the address it prints in Server — or open that http:// address in a browser.',
      ),
    );
    panel.append(lan);

    panel.append(
      h(
        'div',
        { class: 'btn-row' },
        this.button('Disconnect', () => this.cb.onLeaveOnline()),
        this.button('Back', () => this.show('main')),
      ),
    );
    root.append(panel);
    return root;
  }


  setNetStatus(status: string, detail: string, room: string) {
    if (!this.netStatusEl) return;
    this.netStatusEl.textContent = detail;
    this.netStatusEl.className = `mp-status ${status}`;
    this.netRoomEl.textContent = room ? `Game code: ${room}` : '';
    this.netRoomEl.style.display = room ? '' : 'none';
    if (room && this.roomInput && !this.roomInput.value) this.roomInput.value = room;
  }

  // ------------------------------------------------------------------ Trainer

  private trainerPick = DRILLS[0].id;

  private renderTrainer() {
    const root = this.screens.trainer;
    root.replaceChildren();
    const progress = this.cb.drillProgress();
    const panel = h('div', { class: 'menu-panel trainer-panel' });
    const passed = DRILLS.filter((d) => progress[d.id]?.passed).length;
    panel.append(h('div', { class: 'screen-title' }, 'Trainer'));
    panel.append(h('div', { class: 'tiers-sub' }, `Drill the real 1.9+ techniques against a bot that sets each one up. ${passed} / ${DRILLS.length} passed.`));
    const cols = h('div', { class: 'trainer-cols' });
    const list = h('div', { class: 'trainer-list' });
    for (const group of DRILL_GROUPS) {
      const drills = DRILLS.filter((d) => d.group === group);
      if (!drills.length) continue;
      list.append(h('div', { class: 'trainer-group' }, group));
      for (const d of drills) {
        const best = progress[d.id];
        const b = this.button('', () => {
          this.trainerPick = d.id;
          this.renderTrainer();
        }, `trainer-drill${this.trainerPick === d.id ? ' selected' : ''}`);
        b.replaceChildren(h('span', {}, d.name), h('span', { class: best?.passed ? 'done' : '' }, best?.passed ? '✔' : '★'.repeat(d.level)));
        list.append(b);
      }
    }
    cols.append(list, this.drillDetail(DRILLS.find((d) => d.id === this.trainerPick) ?? DRILLS[0], progress));
    panel.append(cols);
    panel.append(this.button('Back', () => this.show('main')));
    root.append(panel);
  }

  private drillDetail(d: DrillDef, progress: Record<string, DrillBest>): HTMLElement {
    const box = h('div', { class: 'trainer-detail' });
    const best = progress[d.id];
    const goal = d.timeTicks ? `${d.goal}% over ${d.timeTicks / 20} s` : `${d.goal} successful attempts`;
    box.append(h('h3', {}, d.name));
    box.append(h('div', { class: 'trainer-meta' }, `${kitById(d.kit).name} kit · ${'★'.repeat(d.level)}${'☆'.repeat(3 - d.level)} · Goal: ${goal}`));
    if (best) {
      const bits = [best.passed ? 'Passed' : 'Not passed yet', `best ${Math.round(best.best)}%`];
      if (best.fastest !== undefined) bits.push(`fastest ${best.fastest.toFixed(1)} s`);
      box.append(h('div', { class: 'trainer-meta' }, bits.join(' · ')));
    }
    box.append(h('ol', {}, ...d.how.map((s) => h('li', {}, s))));
    box.append(h('div', { class: 'trainer-why' }, h('b', {}, 'Why it works: '), d.why));
    box.append(this.button('Start drill', () => this.cb.onDrill(d.id), 'big'));
    return box;
  }

  showDrillResult(d: DrillDef, r: DrillResult, newBest: boolean, onRetry: () => void) {
    const root = this.screens.results;
    root.replaceChildren();
    root.classList.toggle('won', r.passed);
    root.classList.toggle('lost', !r.passed);
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'result-title' }, r.passed ? 'Drill passed!' : 'Keep practising'));
    panel.append(h('div', { class: 'result-sub' }, `${d.name} · ${kitById(d.kit).name} kit`));
    const table = h('div', { class: 'stats-table' });
    const rows: [string, string][] = r.score !== undefined
      ? [['Score', `${Math.round(r.score)}% (goal ${d.goal}%)`], ['Time', `${r.seconds.toFixed(1)} s`]]
      : [
          ['Successes', `${r.successes} / ${d.goal}`],
          ['Misses', `${r.fails}`],
          ['Accuracy', `${Math.round(r.accuracy * 100)}%`],
          ['Best streak', `${r.bestStreak}`],
          ['Time', `${r.seconds.toFixed(1)} s`],
        ];
    for (const [a, b] of rows) table.append(h('span', {}, a), h('span', {}, b), h('span', {}, ''));
    panel.append(table);
    if (newBest) panel.append(h('div', { class: 'result-tier' }, 'New personal best!'));
    panel.append(this.button('Try again (R)', onRetry, 'big'));
    panel.append(h('div', { class: 'btn-row' }, this.button('All drills', () => this.show('trainer')), this.button('Title Screen', () => this.cb.onQuit())));
    root.append(panel);
    this.show('results');
  }

  // ------------------------------------------------------------------ Bot vs Bot

  private renderVersus() {
    const root = this.screens.versus;
    root.replaceChildren();
    const s = this.settings;
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Bot vs Bot'));
    panel.append(h('div', { class: 'tiers-sub' }, 'Pick a kit and two tiers, then watch them fight round after round. Any tier can fight any tier.'));

    panel.append(h('div', { class: 'section-title' }, 'Kit'));
    const kits = h('div', { class: 'versus-kits' });
    for (const kit of [...KITS, ...customKitList()]) {
      const b = this.button(kit.name, () => {
        s.kit = kit.id as KitId;
        saveSettings(s);
        this.renderVersus();
      }, `versus-kit${s.kit === kit.id ? ' selected' : ''}`);
      kits.append(b);
    }
    panel.append(kits);

    const tierRow = (label: string, key: 'versusA' | 'versusB') => {
      panel.append(h('div', { class: 'section-title' }, label));
      const row = h('div', { class: 'diff-row' });
      for (const id of DIFFICULTY_ORDER) {
        if (id === 'practice') continue;
        const d = DIFFICULTIES[id];
        const b = h('button', { class: `diff-btn${s[key] === id ? ' selected' : ''}` }, d.name);
        b.style.setProperty('--diff', d.color);
        b.addEventListener('click', () => {
          this.cb.onUiSound();
          s[key] = id;
          saveSettings(s);
          this.renderVersus();
        });
        row.append(b);
      }
      panel.append(row);
    };
    tierRow('Left bot', 'versusA');
    tierRow('Right bot', 'versusB');

    const a = DIFFICULTIES[s.versusA];
    const b = DIFFICULTIES[s.versusB];
    const vs = h('div', { class: 'versus-line' }, h('b', {}, a.name), ' vs ', h('b', {}, b.name), ` · ${kitById(s.kit).name}`);
    (vs.children[0] as HTMLElement).style.color = a.color;
    (vs.children[1] as HTMLElement).style.color = b.color;
    panel.append(vs);
    panel.append(this.button('Watch', () => this.cb.onSpectate(s.kit, s.versusA, s.versusB), 'big'));
    panel.append(this.button('Back', () => this.show('main')));
    root.append(panel);
  }

  // ------------------------------------------------------------------ Subtiers

  private renderSubtiers() {
    const root = this.screens.subtiers;
    root.replaceChildren();
    const s = this.settings;
    const subs = KITS.filter((k) => k.subtier);
    if (!kitById(s.kit).subtier) {
      s.kit = subs[0].id;
      saveSettings(s);
    }
    const kit = kitById(s.kit);
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Subtiers'));
    panel.append(h('div', { class: 'tiers-sub' }, 'Side kits from the tier lists, with their own tier ladder and their own place in My Tiers.'));
    const grid = h('div', { class: 'kit-grid subtier-grid' });
    for (const k of subs) {
      const card = h('button', { class: `kit-card${k.id === kit.id ? ' selected' : ''}`, title: k.summary }, this.iconEl(k.icon), h('span', { class: 'kit-name' }, k.name));
      card.addEventListener('click', () => {
        this.cb.onUiSound();
        s.kit = k.id;
        saveSettings(s);
        this.renderSubtiers();
      });
      grid.append(card);
    }
    panel.append(grid);
    panel.append(h('div', { class: 'kit-info' }, h('div', { class: 'kit-summary' }, kit.summary), h('ul', {}, ...kit.contents.map((c) => h('li', {}, c)))));

    panel.append(h('div', { class: 'section-title' }, 'Bot tier'));
    const row = h('div', { class: 'diff-row' });
    for (const id of DIFFICULTY_ORDER) {
      const d = DIFFICULTIES[id];
      const b = h('button', { class: `${id === 'practice' ? 'diff-btn diff-practice' : 'diff-btn'}${s.difficulty === id ? ' selected' : ''}` }, d.name);
      b.style.setProperty('--diff', d.color);
      b.addEventListener('click', () => {
        this.cb.onUiSound();
        s.difficulty = id;
        saveSettings(s);
        this.renderSubtiers();
      });
      row.append(b);
    }
    panel.append(row);
    const d = DIFFICULTIES[s.difficulty];
    const desc = h('div', { class: 'diff-desc' }, d.tagline);
    desc.style.color = d.color;
    panel.append(desc);
    const held = this.cb.myTiers()[kit.id];
    panel.append(h('div', { class: 'tiers-sub' }, `Your ${kit.name} tier: ${held ? DIFFICULTIES[held].name : 'Unranked'} · First to ${s.firstTo} (change it on the title screen)`));
    panel.append(this.button('Start Duel', () => this.cb.onStart(), 'big'));
    panel.append(h('div', { class: 'btn-row' }, this.button('Watch Bot vs Bot', () => this.show('versus')), this.button('Back', () => this.show('main'))));
    root.append(panel);
  }

  // ------------------------------------------------------------------ My Tiers

  private renderTiers() {
    const root = this.screens.tiers;
    root.replaceChildren();
    const tiers = this.cb.myTiers();
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'My Tiers'));
    panel.append(h('div', { class: 'tiers-total' }, `${totalPoints(tiers)} points`));
    panel.append(
      h('div', { class: 'tiers-sub' }, 'Win a series (First to, on the title screen) against a tier bot to earn that tier in that kit. Your best tier in each kit counts.'),
    );
    const list = h('div', { class: 'tiers-list' });
    const ordered = [...KITS.filter((k) => !k.subtier), ...KITS.filter((k) => k.subtier)];
    for (const kit of ordered) {
      if (kit === ordered.find((k) => k.subtier)) list.append(h('div', { class: 'tiers-section' }, 'Subtiers'));
      const iconEl = h('canvas', { width: '16', height: '16' });
      const icon = this.kitIcons[kit.icon];
      if (icon) {
        const ctx = iconEl.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(icon, 0, 0, 16, 16);
      }
      const t = tiers[kit.id];
      const badge = h('span', { class: `tiers-badge${t ? '' : ' none'}` }, t ? DIFFICULTIES[t].name : 'Unranked');
      if (t) badge.style.setProperty('--tier', DIFFICULTIES[t].color);
      list.append(h('div', { class: 'tiers-row' }, iconEl, h('span', {}, kit.name), badge, h('span', { class: 'tiers-pts' }, t ? `${TIER_POINTS[t]} pts` : '—')));
    }
    panel.append(list);
    const table = h('div', { class: 'tiers-table' });
    for (const [id, pts] of Object.entries(TIER_POINTS)) {
      const d = DIFFICULTIES[id as DifficultyId];
      const cell = h('span', {}, h('b', {}, d.name), `${pts} pts`);
      cell.style.setProperty('--tier', d.color);
      table.append(cell);
    }
    panel.append(table);
    panel.append(this.button('Done', () => this.show('main'), 'big'));
    root.append(panel);
  }

  // ------------------------------------------------------------------ replays

  private replayList: ReplayData[] = [];

  /** The saved replays changed (a duel finished, one was starred or deleted). */
  setReplays(list: ReplayData[]) {
    this.replayList = list;
    if (this.screens.replays.style.display !== 'none') this.renderReplays();
  }

  private renderReplays() {
    const root = this.screens.replays;
    root.replaceChildren();
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Replays'));
    panel.append(
      h(
        'div',
        { class: 'tiers-sub' },
        'Every duel you finish against a bot is saved here. Watch it back from any angle, slowed down or sped up. ★ keeps one for good; the oldest of the rest make room for new ones.',
      ),
    );
    const list = h('div', { class: 'replay-list' });
    if (!this.replayList.length) list.append(h('div', { class: 'replay-empty' }, 'No replays yet — finish a duel and it appears here.'));
    for (const r of this.replayList) {
      const kit = r.customKit ?? kitById(r.kitId as KitId);
      const iconEl = h('canvas', { width: '16', height: '16' });
      const icon = this.kitIcons[kit.icon];
      if (icon) {
        const ctx = iconEl.getContext('2d')!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(icon, 0, 0, 16, 16);
      }
      const tier = (DIFFICULTIES as Record<string, { name: string; color: string }>)[r.profileId];
      const secs = Math.floor(r.fightTicks / 20);
      const len = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
      const when = new Date(r.date);
      const result = h('span', { class: `replay-result ${r.winner === 'player' ? 'won' : 'lost'}` }, r.winner === 'player' ? 'Win' : 'Loss');
      const vs = h('span', { class: 'replay-vs' }, `${kit.name} vs `, h('b', {}, tier?.name ?? r.botName));
      if (tier) (vs.lastChild as HTMLElement).style.color = tier.color;
      const meta = h('span', { class: 'replay-meta' }, `${len} · ${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      const star = this.button(r.starred ? '★' : '☆', () => this.cb.onStarReplay(r.id), `replay-star${r.starred ? ' on' : ''}`);
      star.title = r.starred ? 'Starred: never deleted to make room' : 'Star: keep this replay for good';
      const del = this.button('✕', () => this.cb.onDeleteReplay(r.id), 'replay-del');
      del.title = 'Delete';
      const watch = this.button('Watch', () => this.cb.onWatchReplay(r), 'replay-watch');
      const coach = this.button('Coach', () => this.cb.onCoachReplay(r), 'replay-coach');
      coach.title = 'What to improve, from this duel';
      list.append(h('div', { class: 'replay-row' }, star, iconEl, result, h('div', { class: 'replay-info' }, vs, meta), coach, watch, del));
    }
    panel.append(list);
    panel.append(this.button('Done', () => this.show('main'), 'big'));
    root.append(panel);
  }

  // ------------------------------------------------------------------ coach

  /** Match Coach: the duel's numbers and what to work on, each tip with moments to watch. */
  showCoach(report: CoachReport, onWatch: (tick: number) => void, onBack: () => void) {
    const root = this.screens.coach;
    root.replaceChildren();
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Coach'));
    const stats = h('div', { class: 'coach-stats' });
    for (const s of report.stats) stats.append(h('div', { class: 'coach-stat' }, h('b', {}, s.value), h('span', {}, s.label)));
    panel.append(stats);
    const list = h('div', { class: 'coach-tips' });
    const problems = report.tips.filter((t) => !t.good);
    const shown = [...problems.slice(0, 4), ...report.tips.filter((t) => t.good).slice(0, 2)];
    for (const t of shown) {
      const head = h('div', { class: 'coach-tip-title' }, h('span', { class: `coach-mark ${t.good ? 'good' : 'fix'}` }, t.good ? '✔' : '!'), t.title);
      const tip = h('div', { class: `coach-tip ${t.good ? 'good' : 'fix'}` }, head, h('div', { class: 'coach-tip-detail' }, t.detail));
      if (t.moments.length) {
        const moments = h('div', { class: 'coach-moments' }, h('span', {}, 'Watch:'));
        for (const k of t.moments) {
          const secs = Math.max(0, Math.floor((k - 60) / 20));
          moments.append(this.button(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`, () => onWatch(k), 'coach-moment'));
        }
        tip.append(moments);
      }
      list.append(tip);
    }
    if (!shown.length) list.append(h('div', { class: 'replay-empty' }, 'Nothing to report.'));
    panel.append(list);
    panel.append(this.button('Back', onBack, 'big'));
    root.append(panel);
    this.show('coach');
  }

  // ------------------------------------------------------------------ results

  showResults(r: ResultData, onRematch: () => void, onReplay?: () => void, onCoach?: () => void) {
    const root = this.screens.results;
    root.replaceChildren();
    root.classList.toggle('won', r.won);
    root.classList.toggle('lost', !r.won);
    const panel = h('div', { class: 'menu-panel' });
    const title = r.series ? (r.won ? 'Series Won!' : 'Series Lost!') : r.won ? 'Victory!' : 'You Died!';
    panel.append(h('div', { class: 'result-title' }, title));
    if (r.series) {
      panel.append(h('div', { class: 'result-sub' }, `FT${r.series.target} · You ${r.series.you} – ${r.series.bot} ${r.botName}`));
    }
    if (r.tierEarned) {
      const t = h('div', { class: 'result-tier' }, 'New tier: ', h('b', {}, r.tierEarned.name), ` in ${r.tierEarned.kit} · +${r.tierEarned.points} pts`);
      t.style.setProperty('--tier', r.tierEarned.color);
      panel.append(t);
    } else if (r.tierBlocked) {
      panel.append(h('div', { class: 'result-note' }, 'Commands changed this series, so it didn’t earn a tier.'));
    }
    const mins = Math.floor(r.seconds / 60);
    const secs = Math.floor(r.seconds % 60);
    panel.append(
      h('div', { class: 'result-sub' }, `${r.won ? `You beat ${r.botName}` : `Slain by ${r.botName}`} in ${mins}:${String(secs).padStart(2, '0')}`),
    );
    const acc = (s: FighterStats) => (s.swings ? `${Math.round((s.hits / s.swings) * 100)}%` : '—');
    const reach = (s: FighterStats) => (s.hits ? (s.reachSum / s.hits).toFixed(2) : '—');
    const rows: [string, string, string][] = [
      ['Hits', `${r.player.hits}`, `${r.bot.hits}`],
      ['Accuracy', acc(r.player), acc(r.bot)],
      ['Critical hits', `${r.player.crits}`, `${r.bot.crits}`],
      ['Sprint hits', `${r.player.sprintHits}`, `${r.bot.sprintHits}`],
      ['Longest combo', `${r.player.maxCombo}${r.newBestCombo ? ' ★' : ''}`, `${r.bot.maxCombo}`],
      ['Damage dealt', `${(r.player.damageDealt / 2).toFixed(1)} ❤`, `${(r.bot.damageDealt / 2).toFixed(1)} ❤`],
      ['Golden apples', `${r.player.gapplesEaten}`, `${r.bot.gapplesEaten}`],
      ...(r.player.blocked + r.bot.blocked + r.player.shieldsDisabled + r.bot.shieldsDisabled > 0
        ? ([
            ['Hits blocked', `${r.player.blocked}`, `${r.bot.blocked}`],
            ['Shields disabled', `${r.player.shieldsDisabled}`, `${r.bot.shieldsDisabled}`],
            ['Attribute swaps', `${r.player.attributeSwaps}`, `${r.bot.attributeSwaps}`],
          ] as [string, string, string][])
        : []),
      ...(r.player.potsThrown + r.bot.potsThrown + r.player.totemsPopped + r.bot.totemsPopped > 0
        ? ([
            ['Pots thrown', `${r.player.potsThrown}`, `${r.bot.potsThrown}`],
            ['Totems popped', `${r.player.totemsPopped}`, `${r.bot.totemsPopped}`],
            ['XP bottles', `${r.player.xpBottles}`, `${r.bot.xpBottles}`],
          ] as [string, string, string][])
        : []),
      ...(r.player.arrowsShot + r.bot.arrowsShot > 0
        ? ([['Arrows hit', `${r.player.arrowHits}/${r.player.arrowsShot}`, `${r.bot.arrowHits}/${r.bot.arrowsShot}`]] as [string, string, string][])
        : []),
      ['Avg reach', reach(r.player), reach(r.bot)],
    ];
    if (r.unrecorded) panel.append(h('div', { class: 'result-note' }, 'Commands changed this duel, so it wasn’t recorded.'));
    const table = h('div', { class: 'stats-table' });
    table.append(h('span', {}, ''), h('b', {}, 'You'), h('b', {}, 'Bot'));
    for (const [a, b, c] of rows) table.append(h('span', {}, a), h('span', {}, b), h('span', {}, c));
    panel.append(table);
    panel.append(this.button(r.online ? 'Rematch (R) — both must agree' : 'Rematch (R)', onRematch, 'big'));
    if (onReplay) {
      const row = h('div', { class: `btn-row${onCoach ? ' three' : ''}` });
      if (onCoach) row.append(this.button('Coach', onCoach, 'coach-btn'));
      row.append(this.button('Watch Replay', onReplay, 'replay-btn'), this.button('Title Screen', () => this.cb.onQuit()));
      panel.append(row);
    } else panel.append(this.button('Title Screen', () => this.cb.onQuit()));
    root.append(panel);
    this.show('results');
  }
}

const NAME_KEY = 'pvp-trainer.net.name';
const SERVER_KEY = 'pvp-trainer.net.server';

function defaultServerUrl(): string {
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }
  // file:// pages and the macOS app (pvp://) have no usable host of their own.
  return 'ws://localhost:4180/ws';
}

function loadNetName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveNetName(v: string) {
  try {
    localStorage.setItem(NAME_KEY, v);
  } catch {
    /* ignore */
  }
}

function loadNetServer(): string {
  try {
    return localStorage.getItem(SERVER_KEY) || defaultServerUrl();
  } catch {
    return defaultServerUrl();
  }
}

function saveNetServer(v: string) {
  try {
    localStorage.setItem(SERVER_KEY, v);
  } catch {
    /* ignore */
  }
}
