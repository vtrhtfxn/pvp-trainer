import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId } from '../ai/difficulty';
import type { FighterStats } from '../game/Fighter';
import { KITS, kitById, type KitId } from '../game/kits';
import type { Sprite } from './sprites';
import { saveSettings, type Records, type Settings } from './settings';

export interface MenuCallbacks {
  onStart(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSettingsChanged(): void;
  onUiSound(): void;
  onConnect(url: string, room: string, name: string): void;
  onLeaveOnline(): void;
}

type ScreenName = 'main' | 'pause' | 'settings' | 'controls' | 'results' | 'multiplayer';

export interface ResultData {
  won: boolean;
  seconds: number;
  player: FighterStats;
  bot: FighterStats;
  botName: string;
  newBestCombo: boolean;
  /** Online duels are not recorded against a bot difficulty. */
  online?: boolean;
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
  private kitInfo!: HTMLDivElement;

  constructor(
    parent: HTMLElement,
    private readonly settings: Settings,
    private records: Records,
    private readonly kitIcons: Record<string, Sprite>,
    private readonly cb: MenuCallbacks,
  ) {
    this.screens = {
      main: this.buildMain(),
      pause: this.buildPause(),
      settings: this.buildSettings(),
      controls: this.buildControls(),
      multiplayer: this.buildMultiplayer(),
      results: h('div', { class: 'screen results' }),
    };
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
      h('div', { class: 'logo-top' }, 'PVP'),
      h('div', { class: 'logo-bottom' }, 'TRAINER'),
      h('div', { class: 'splash' }, '1.9+ combat!'),
    );
    panel.append(logo);

    panel.append(h('div', { class: 'section-title' }, 'Game mode'));
    const grid = h('div', { class: 'kit-grid' });
    for (const kit of KITS) {
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

    panel.append(this.button('Start Duel', () => this.cb.onStart(), 'big'));
    panel.append(this.button('Multiplayer — fight a friend', () => this.show('multiplayer'), 'big online'));
    panel.append(
      h(
        'div',
        { class: 'btn-row' },
        this.button('Settings', () => this.openSettings('main')),
        this.button('Controls', () => this.show('controls')),
      ),
    );
    this.recordEl = h('div', { class: 'record' });
    panel.append(this.recordEl);
    root.append(panel);
    root.append(
      h(
        'div',
        { class: 'credits' },
        'Not affiliated with Mojang. Textures: Bare Bones resource pack. Player rig (CC-BY 4.0) by lewisglasgow2005.',
      ),
    );
    return root;
  }

  refreshMain(records?: Records) {
    if (records) this.records = records;
    const kit = kitById(this.settings.kit);
    const d = DIFFICULTIES[this.settings.difficulty];
    this.screens.main.querySelectorAll<HTMLElement>('.kit-card').forEach((c) => {
      c.classList.toggle('selected', c.dataset.kit === kit.id);
    });
    this.screens.main.querySelectorAll<HTMLElement>('.diff-btn').forEach((b) => {
      b.classList.toggle('selected', b.dataset.diff === d.id);
    });
    this.kitInfo.replaceChildren(
      h('div', { class: 'kit-summary' }, kit.summary),
      h('ul', {}, ...kit.contents.map((c) => h('li', {}, c))),
    );
    this.diffDesc.textContent = d.tagline;
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
    const s = this.settings;
    const root = h('div', { class: 'screen settings' });
    const panel = h('div', { class: 'menu-panel wide' });
    panel.append(h('div', { class: 'screen-title' }, 'Settings'));
    const grid = h('div', { class: 'settings-grid' });
    const changed = () => {
      saveSettings(s);
      this.cb.onSettingsChanged();
    };
    const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
      const out = h('span', { class: 'slider-value' });
      const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
      const wrap = h('label', { class: 'mc-slider' }, input, out);
      const paint = () => {
        out.textContent = `${label}: ${fmt(get())}`;
        wrap.style.setProperty('--p', String((get() - min) / (max - min)));
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
    const toggle = (label: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = h('button', { class: 'mc-btn' });
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
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    slider('Sensitivity', 0, 1, 0.005, () => s.sensitivity, (v) => (s.sensitivity = v), (v) => `${Math.round(v * 200)}%`);
    slider('FOV', 30, 110, 1, () => s.fov, (v) => (s.fov = v), (v) => (v === 70 ? 'Normal' : v === 110 ? 'Quake Pro' : String(v)));
    slider('FOV Effects', 0, 1, 0.05, () => s.fovEffects, (v) => (s.fovEffects = v), pct);
    slider('Damage Tilt', 0, 1, 0.05, () => s.damageTilt, (v) => (s.damageTilt = v), pct);
    slider('Volume', 0, 1, 0.05, () => s.volume, (v) => (s.volume = v), pct);
    slider('GUI Scale', 0, 4, 1, () => s.guiScale, (v) => (s.guiScale = v), (v) => (v === 0 ? 'Auto' : String(v)));
    toggle('Toggle Sprint (Ctrl)', () => s.toggleSprint, (v) => (s.toggleSprint = v));
    toggle('Double-tap W Sprint', () => s.doubleTapSprint, (v) => (s.doubleTapSprint = v));
    toggle('View Bobbing', () => s.viewBobbing, (v) => (s.viewBobbing = v));
    toggle('Raw Mouse Input', () => s.rawInput, (v) => (s.rawInput = v));
    if (!window.pvpNative) toggle('Fullscreen (blocks Ctrl+W)', () => s.fullscreenLock, (v) => (s.fullscreenLock = v));
    toggle('Reach Display', () => s.showReach, (v) => (s.showReach = v));
    toggle('Combo Counter', () => s.showCombo, (v) => (s.showCombo = v));
    toggle('CPS Counter', () => s.showCps, (v) => (s.showCps = v));
    toggle('Next-hit Coach', () => s.showNextHit, (v) => (s.showNextHit = v));
    toggle('Hit Feedback', () => s.hitFeedback, (v) => (s.hitFeedback = v));
    toggle('Opponent Health Bar', () => s.showOpponentBar, (v) => (s.showOpponentBar = v));
    toggle(/Mac|iP(hone|ad)/.test(navigator.platform) ? 'Hitboxes (⌘M)' : 'Hitboxes (Ctrl+M)', () => s.showHitboxes, (v) => (s.showHitboxes = v));
    panel.append(grid);
    panel.append(this.button('Done', () => this.show(this.settingsReturn), 'big'));
    root.append(panel);
    return root;
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
    const rows: [string, string][] = [
      ['W A S D', 'Move'],
      ['Space', 'Jump (hold to bunny-hop)'],
      ['Ctrl', 'Sprint (toggle by default) · or double-tap W'],
      ['Shift', 'Sneak'],
      ['Left Click', 'Attack — full damage every 0.6 s, clicking early resets the cooldown. Hold on a block to mine it'],
      ['Right Click (hold)', 'Use: eat, raise the shield, draw the bow, load / fire the crossbow, throw a splash potion or XP bottle, place a block, pour or fill a bucket. Main hand first, then off hand'],
      ['1 – 9 / Scroll', 'Hotbar (switching items resets the attack cooldown on the next tick)'],
      ['F', 'Swap main hand and off hand'],
      ['E', 'Inventory — drag or click items, shift-click to quick-move, 1–9 / F over a slot to swap'],
      ['F5 or V', 'Toggle third person'],
      ['⌘M (or F3 + B)', 'Toggle combat hitboxes — white box, red eye line, blue 3-block reach ray'],
      ['Esc', 'Pause'],
      ['R', 'Rematch after a duel'],
    ];
    const table = h('div', { class: 'controls-table' });
    for (const [k, v] of rows) table.append(h('kbd', {}, k), h('span', {}, v));
    panel.append(table);
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


  // ------------------------------------------------------------------ multiplayer

  private buildMultiplayer(): HTMLDivElement {
    const root = h('div', { class: 'screen multiplayer' });
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'screen-title' }, 'Multiplayer'));
    panel.append(
      h(
        'div',
        { class: 'mp-intro' },
        'Real 1v1 over your network. One of you runs the server, everyone connects to it — then share a room code.',
      ),
    );
    // Opened by double-clicking game.html there is no server behind the page, so the address
    // below defaults to this computer — which is wrong for everyone except the host.
    if (location.protocol !== 'http:' && location.protocol !== 'https:') {
      panel.append(
        h(
          'div',
          { class: 'mp-warn' },
          'Not the host? Type the host\u2019s address in ',
          h('b', {}, 'Server'),
          ' (the one their server window prints, for example 192.168.1.23).',
        ),
      );
    }

    const field = (label: string, value: string, placeholder: string, maxLength = 32) => {
      const input = h('input', { class: 'mc-input', type: 'text', placeholder, maxlength: String(maxLength) });
      input.value = value;
      const wrap = h('label', { class: 'mp-field' }, h('span', {}, label), input);
      panel.append(wrap);
      return input;
    };

    panel.append(
      h('div', { class: 'mp-hint' }, 'Hosting uses the kit you picked on the main menu (every kit works online); joining plays the host\u2019s kit.'),
    );
    this.nameInput = field('Your name', loadNetName(), 'Steve', 16);
    this.roomInput = field('Room code', '', 'blank = create a new one', 8);
    this.serverInput = field('Server', loadNetServer(), '192.168.1.23 (the host\u2019s address)', 120);
    panel.append(
      h('div', { class: 'mp-hint' }, 'Server = the host\u2019s machine. Joining someone else? Type their address, e.g. 192.168.1.23.'),
    );

    this.netStatusEl = h('div', { class: 'mp-status' });
    this.netRoomEl = h('div', { class: 'mp-room' });
    panel.append(this.netRoomEl, this.netStatusEl);

    const go = (room: string) => {
      const name = this.nameInput.value.trim() || 'Player';
      const server = this.serverInput.value.trim() || defaultServerUrl();
      saveNetName(name);
      saveNetServer(server);
      this.cb.onConnect(server, room, name);
    };
    panel.append(this.button('Host a new room', () => go(''), 'big'));
    panel.append(this.button('Join room code', () => go(this.roomInput.value.trim()), 'big'));
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go(this.roomInput.value.trim());
    });
    panel.append(
      h(
        'div',
        { class: 'btn-row' },
        this.button('Disconnect', () => this.cb.onLeaveOnline()),
        this.button('Back', () => this.show('main')),
      ),
    );
    panel.append(
      h(
        'div',
        { class: 'mp-help' },
        'To host: run the server (',
        h('code', {}, 'npm run server'),
        ', or the START launcher). Players type the address it prints in Server — or open that http:// address in a browser. Same network only.',
      ),
    );
    root.append(panel);
    return root;
  }

  setNetStatus(status: string, detail: string, room: string) {
    if (!this.netStatusEl) return;
    this.netStatusEl.textContent = detail;
    this.netStatusEl.className = `mp-status ${status}`;
    this.netRoomEl.textContent = room ? `Room code: ${room}` : '';
    this.netRoomEl.style.display = room ? '' : 'none';
    if (room && this.roomInput && !this.roomInput.value) this.roomInput.value = room;
  }

  // ------------------------------------------------------------------ results

  showResults(r: ResultData, onRematch: () => void) {
    const root = this.screens.results;
    root.replaceChildren();
    root.classList.toggle('won', r.won);
    root.classList.toggle('lost', !r.won);
    const panel = h('div', { class: 'menu-panel' });
    panel.append(h('div', { class: 'result-title' }, r.won ? 'Victory!' : 'You Died!'));
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
    const table = h('div', { class: 'stats-table' });
    table.append(h('span', {}, ''), h('b', {}, 'You'), h('b', {}, 'Bot'));
    for (const [a, b, c] of rows) table.append(h('span', {}, a), h('span', {}, b), h('span', {}, c));
    panel.append(table);
    panel.append(this.button(r.online ? 'Rematch (R) — both must agree' : 'Rematch (R)', onRematch, 'big'));
    panel.append(this.button('Title Screen', () => this.cb.onQuit()));
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
