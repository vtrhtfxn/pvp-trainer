/**
 * The Marketplace's mods. They all ship inside the game (nothing is downloaded) but start
 * uninstalled: installing one in the Marketplace turns it on and gives it a settings page.
 * They are PvP Trainer's own takes on popular PvP client mods, named after the mods they copy.
 */

export type ModId =
  | 'appleskin'
  | 'fps'
  | 'armorhud'
  | 'hurtcam'
  | 'potcounter'
  | 'totemcounter'
  | 'itemcounter'
  | 'damageindicator'
  | 'keystrokes'
  | 'togglesprint'
  | 'coords'
  | 'zoom'
  | 'crosshair'
  | 'lowfire'
  | 'lowshield'
  | 'hitcolor'
  | 'particles'
  | 'freelook';

export type ModCategory = 'HUD' | 'Visual' | 'Utility';
export type OptValue = number | string | boolean;

export type ModOption =
  | { key: string; label: string; type: 'toggle' }
  | { key: string; label: string; type: 'slider'; min: number; max: number; step: number; unit?: 'x' | '%' | 'px' | '' }
  | { key: string; label: string; type: 'select'; options: [string, string][] }
  | { key: string; label: string; type: 'color' };

export interface ModDef {
  id: ModId;
  name: string;
  /** "Based on …" credit line in the Marketplace. */
  basedOn?: string;
  description: string;
  category: ModCategory;
  /** Icon: an item id ("item:golden_apple"), a pack texture ("pack:item/spyglass") or a drawn one ("draw:fps"). */
  icon: string;
  defaults: Record<string, OptValue>;
  options: ModOption[];
  /**
   * A HUD element you can move in the HUD editor; its default spot as a fraction of the screen
   * (x from the right edge when `right`). Once dragged it is kept as a top-left position.
   */
  widget?: { x: number; y: number; right?: boolean };
  /** Needs a key (Options → Key Binds → Mods). */
  key?: 'zoom' | 'freelook';
}

const scale = (label = 'Size'): ModOption => ({ key: 'scale', label, type: 'slider', min: 0.5, max: 2, step: 0.05, unit: 'x' });

export const MODS: ModDef[] = [
  {
    id: 'appleskin',
    name: 'AppleSkin',
    basedOn: 'the AppleSkin mod',
    description: 'Shows your hidden saturation on the hunger bar, the exhaustion building toward the next point, and — while you hold food — how much hunger and health it will give back. Adds hunger/saturation to food tooltips.',
    category: 'HUD',
    icon: 'item:golden_apple',
    defaults: { saturation: true, exhaustion: true, foodPreview: true, healthPreview: true, tooltip: true },
    options: [
      { key: 'saturation', label: 'Saturation overlay', type: 'toggle' },
      { key: 'exhaustion', label: 'Exhaustion underlay', type: 'toggle' },
      { key: 'foodPreview', label: 'Hunger preview when holding food', type: 'toggle' },
      { key: 'healthPreview', label: 'Health preview when holding food', type: 'toggle' },
      { key: 'tooltip', label: 'Food values in tooltips', type: 'toggle' },
    ],
  },
  {
    id: 'fps',
    name: 'FPS Display',
    basedOn: 'the FPS mod of PvP clients',
    description: 'Frames per second in a corner, with the frame time and — online — your ping to the host.',
    category: 'HUD',
    icon: 'draw:fps',
    defaults: { showMs: false, showPing: true, background: true, color: '#ffffff', scale: 1 },
    options: [
      { key: 'showMs', label: 'Frame time (ms)', type: 'toggle' },
      { key: 'showPing', label: 'Ping (online)', type: 'toggle' },
      { key: 'background', label: 'Background', type: 'toggle' },
      { key: 'color', label: 'Text colour', type: 'color' },
      scale(),
    ],
    widget: { x: 0.008, y: 0.3 },
  },
  {
    id: 'armorhud',
    name: "uku's Armor HUD",
    basedOn: "uku's Armor HUD",
    description: 'Your armor in hotbar-style slots next to the hotbar, with durability bars — see a piece about to break without opening your inventory.',
    category: 'HUD',
    icon: 'item:netherite_chestplate',
    defaults: { side: 'right', durability: 'bar', showEmpty: true },
    options: [
      {
        key: 'side',
        label: 'Side of the hotbar',
        type: 'select',
        options: [
          ['right', 'Right'],
          ['left', 'Left'],
        ],
      },
      {
        key: 'durability',
        label: 'Durability',
        type: 'select',
        options: [
          ['bar', 'Bar'],
          ['percent', 'Percent'],
          ['number', 'Points left'],
          ['none', 'Hidden'],
        ],
      },
      { key: 'showEmpty', label: 'Show empty slots', type: 'toggle' },
    ],
  },
  {
    id: 'hurtcam',
    name: 'BetterHurtCam',
    basedOn: 'the BetterHurtCam mod',
    description: 'Tunes the camera shake when you get hit: make it gentler, stronger or turn it off, and choose between the modern directional tilt and the classic one-way tilt.',
    category: 'Visual',
    icon: 'pack:gui/sprites/hud/heart/full',
    defaults: { strength: 0.5, mode: 'directional' },
    options: [
      { key: 'strength', label: 'Hurt cam strength', type: 'slider', min: 0, max: 2, step: 0.05, unit: '%' },
      {
        key: 'mode',
        label: 'Tilt',
        type: 'select',
        options: [
          ['directional', 'Directional (1.19.4+)'],
          ['classic', 'Classic (always the same way)'],
        ],
      },
    ],
  },
  {
    id: 'potcounter',
    name: 'Pot Counter',
    basedOn: 'the Pot Counter mod',
    description: 'How many healing potions you have left, always on screen — NethPot and Diamond Pot players live by it.',
    category: 'HUD',
    icon: 'item:splash_potion',
    defaults: { which: 'healing', hideWhenNone: true, scale: 1 },
    options: [
      {
        key: 'which',
        label: 'Count',
        type: 'select',
        options: [
          ['healing', 'Healing potions'],
          ['all', 'Every splash potion, by type'],
        ],
      },
      { key: 'hideWhenNone', label: 'Hide when you have none', type: 'toggle' },
      scale(),
    ],
    widget: { x: 0.008, y: 0.34, right: true },
  },
  {
    id: 'totemcounter',
    name: 'Totem Counter',
    basedOn: 'totem counter mods',
    description: 'Totems of Undying left (off hand included), and a flash when one pops.',
    category: 'HUD',
    icon: 'item:totem_of_undying',
    defaults: { hideWhenNone: true, scale: 1 },
    options: [{ key: 'hideWhenNone', label: 'Hide when you have none', type: 'toggle' }, scale()],
    widget: { x: 0.008, y: 0.28, right: true },
  },
  {
    id: 'itemcounter',
    name: 'Item Counter',
    basedOn: 'item counter HUD mods',
    description: 'Counts the items that decide fights: golden apples, pearls, arrows, crystals, obsidian, wind charges, XP bottles and cobwebs.',
    category: 'HUD',
    icon: 'item:ender_pearl',
    defaults: { golden_apple: true, ender_pearl: true, arrow: true, end_crystal: true, obsidian: true, wind_charge: true, experience_bottle: false, cobweb: false, scale: 1 },
    options: [
      { key: 'golden_apple', label: 'Golden apples', type: 'toggle' },
      { key: 'ender_pearl', label: 'Ender pearls', type: 'toggle' },
      { key: 'arrow', label: 'Arrows', type: 'toggle' },
      { key: 'end_crystal', label: 'End crystals', type: 'toggle' },
      { key: 'obsidian', label: 'Obsidian', type: 'toggle' },
      { key: 'wind_charge', label: 'Wind charges', type: 'toggle' },
      { key: 'experience_bottle', label: 'XP bottles', type: 'toggle' },
      { key: 'cobweb', label: 'Cobwebs', type: 'toggle' },
      scale(),
    ],
    widget: { x: 0.008, y: 0.4, right: true },
  },
  {
    id: 'damageindicator',
    name: 'Damage Indicator',
    basedOn: 'the Damage Indicators mod',
    description: 'Damage numbers pop out of whoever gets hit — in hearts or in points — gold for crits, so you can see exactly what every hit did.',
    category: 'Visual',
    icon: 'draw:damage',
    defaults: { style: 'hearts', crits: true, showOwn: false, scale: 1 },
    options: [
      {
        key: 'style',
        label: 'Show damage as',
        type: 'select',
        options: [
          ['hearts', 'Hearts (−1.5 ❤)'],
          ['numbers', 'Points (−3)'],
        ],
      },
      { key: 'crits', label: 'Gold for crits', type: 'toggle' },
      { key: 'showOwn', label: 'Also for damage you take (3rd person)', type: 'toggle' },
      scale(),
    ],
  },
  {
    id: 'keystrokes',
    name: 'Keystrokes',
    basedOn: 'the Keystrokes mod',
    description: 'W, A, S, D, your mouse buttons (with clicks per second) and the space bar light up as you press them — great for recording and for checking your W-taps.',
    category: 'HUD',
    icon: 'draw:keys',
    defaults: { mouse: true, cps: true, space: true, background: 'rgba', pressed: '#ffffff', scale: 1 },
    options: [
      { key: 'mouse', label: 'Mouse buttons', type: 'toggle' },
      { key: 'cps', label: 'CPS on the mouse buttons', type: 'toggle' },
      { key: 'space', label: 'Space bar', type: 'toggle' },
      { key: 'pressed', label: 'Pressed colour', type: 'color' },
      scale(),
    ],
    widget: { x: 0.008, y: 0.68, right: true },
  },
  {
    id: 'togglesprint',
    name: 'ToggleSprint Display',
    basedOn: 'the ToggleSprint mod',
    description: 'Tells you whether you are sprinting (toggled or held), sneaking or flying — handy with Toggle Sprint on.',
    category: 'HUD',
    icon: 'item:diamond_boots',
    defaults: { color: '#ffffff', scale: 1 },
    options: [{ key: 'color', label: 'Text colour', type: 'color' }, scale()],
    widget: { x: 0.008, y: 0.34 },
  },
  {
    id: 'coords',
    name: 'Coordinates',
    basedOn: 'coordinates / direction HUD mods',
    description: 'Your X Y Z and the direction you face, without F3.',
    category: 'HUD',
    icon: 'pack:item/compass_00',
    defaults: { facing: true, decimals: 1, scale: 1 },
    options: [{ key: 'facing', label: 'Facing', type: 'toggle' }, { key: 'decimals', label: 'Decimals', type: 'slider', min: 0, max: 3, step: 1, unit: '' }, scale()],
    widget: { x: 0.008, y: 0.38 },
  },
  {
    id: 'zoom',
    name: 'Zoom',
    basedOn: "OptiFine's zoom",
    description: 'Hold C (Options → Key Binds) to zoom in; scroll while zooming to zoom further. Mouse speed drops with it so aiming stays steady.',
    category: 'Utility',
    icon: 'pack:item/spyglass',
    defaults: { factor: 4, smooth: true, scroll: true, slowMouse: true },
    options: [
      { key: 'factor', label: 'Zoom', type: 'slider', min: 1.5, max: 10, step: 0.5, unit: 'x' },
      { key: 'smooth', label: 'Smooth zoom', type: 'toggle' },
      { key: 'scroll', label: 'Scroll to zoom further', type: 'toggle' },
      { key: 'slowMouse', label: 'Slower mouse while zoomed', type: 'toggle' },
    ],
    key: 'zoom',
  },
  {
    id: 'crosshair',
    name: 'Custom Crosshair',
    basedOn: 'custom crosshair mods',
    description: 'Pick your crosshair: shape, size, gap, thickness, colour, outline and a centre dot. The vanilla attack indicator still shows under it.',
    category: 'Visual',
    icon: 'pack:gui/sprites/hud/crosshair',
    defaults: { style: 'cross', color: '#ffffff', size: 5, gap: 2, thickness: 1, outline: true, dot: false },
    options: [
      {
        key: 'style',
        label: 'Style',
        type: 'select',
        options: [
          ['cross', 'Cross with gap'],
          ['plus', 'Plus'],
          ['dot', 'Dot'],
          ['circle', 'Circle'],
          ['t', 'T'],
        ],
      },
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'size', label: 'Length', type: 'slider', min: 1, max: 15, step: 1, unit: 'px' },
      { key: 'gap', label: 'Gap', type: 'slider', min: 0, max: 10, step: 1, unit: 'px' },
      { key: 'thickness', label: 'Thickness', type: 'slider', min: 1, max: 5, step: 1, unit: 'px' },
      { key: 'outline', label: 'Black outline', type: 'toggle' },
      { key: 'dot', label: 'Centre dot', type: 'toggle' },
    ],
  },
  {
    id: 'lowfire',
    name: 'Low Fire',
    basedOn: 'the Low Fire mod',
    description: 'Pushes the first-person flames down when you are burning, so fire doesn’t cover your screen in a fight.',
    category: 'Visual',
    icon: 'pack:block/fire_0',
    defaults: { lower: 0.4 },
    options: [{ key: 'lower', label: 'Lower by', type: 'slider', min: 0, max: 1, step: 0.05, unit: '%' }],
  },
  {
    id: 'lowshield',
    name: 'Low Shield',
    basedOn: 'the Low Shield mod',
    description: 'Draws your shield lower in first person, so a raised shield blocks less of your view.',
    category: 'Visual',
    icon: 'item:shield',
    defaults: { lower: 0.4 },
    options: [{ key: 'lower', label: 'Lower by', type: 'slider', min: 0, max: 1, step: 0.05, unit: '%' }],
  },
  {
    id: 'hitcolor',
    name: 'Hit Color',
    basedOn: 'hit colour mods',
    description: 'Changes the red flash on a player you hit to any colour and strength — easier to see on some skins.',
    category: 'Visual',
    icon: 'draw:hitcolor',
    defaults: { color: '#ff0000', strength: 0.45 },
    options: [
      { key: 'color', label: 'Colour', type: 'color' },
      { key: 'strength', label: 'Strength', type: 'slider', min: 0, max: 1, step: 0.05, unit: '%' },
    ],
  },
  {
    id: 'particles',
    name: 'Particles+',
    basedOn: 'particle multiplier mods',
    description: 'More crit and sharpness sparks on every hit (or on all hits), so a landed crit is unmistakable.',
    category: 'Visual',
    icon: 'draw:crit',
    defaults: { multiplier: 2, alwaysSharp: false },
    options: [
      { key: 'multiplier', label: 'Multiplier', type: 'slider', min: 1, max: 5, step: 0.5, unit: 'x' },
      { key: 'alwaysSharp', label: 'Sharpness sparks on every hit', type: 'toggle' },
    ],
  },
  {
    id: 'freelook',
    name: 'Freelook',
    basedOn: 'Freelook / perspective mods',
    description: 'Hold Left Alt to swing a third-person camera around yourself while you keep running and facing the same way.',
    category: 'Utility',
    icon: 'draw:eye',
    defaults: { mode: 'hold', invert: false },
    options: [
      {
        key: 'mode',
        label: 'Key',
        type: 'select',
        options: [
          ['hold', 'Hold'],
          ['toggle', 'Toggle'],
        ],
      },
      { key: 'invert', label: 'Invert vertical', type: 'toggle' },
    ],
    key: 'freelook',
  },
];

export const MOD_BY_ID = Object.fromEntries(MODS.map((m) => [m.id, m])) as Record<ModId, ModDef>;

export interface ModState {
  installed: boolean;
  enabled: boolean;
  config: Record<string, OptValue>;
  /** Widget position (fraction of the screen, top-left), if moved. */
  pos?: { x: number; y: number };
}

const STORE = 'pvp-trainer.mods.v1';

/** Installed mods, their settings and HUD positions (saved in the browser). */
export class ModManager {
  readonly states = {} as Record<ModId, ModState>;
  private readonly listeners: (() => void)[] = [];

  constructor() {
    let saved: Partial<Record<ModId, Partial<ModState>>> = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch {
      /* storage unavailable */
    }
    for (const m of MODS) {
      const s = saved[m.id];
      this.states[m.id] = {
        installed: !!s?.installed,
        enabled: s?.enabled ?? true,
        config: { ...m.defaults, ...(s?.config ?? {}) },
        pos: s?.pos,
      };
    }
  }

  onChange(fn: () => void) {
    this.listeners.push(fn);
  }

  private changed() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.states));
    } catch {
      /* ignore */
    }
    for (const fn of this.listeners) fn();
  }

  /** Installed and switched on. */
  on(id: ModId): boolean {
    const s = this.states[id];
    return s.installed && s.enabled;
  }

  cfg<T extends OptValue>(id: ModId, key: string): T {
    return this.states[id].config[key] as T;
  }

  install(id: ModId) {
    this.states[id].installed = true;
    this.states[id].enabled = true;
    this.changed();
  }

  uninstall(id: ModId) {
    this.states[id].installed = false;
    this.changed();
  }

  setEnabled(id: ModId, v: boolean) {
    this.states[id].enabled = v;
    this.changed();
  }

  set(id: ModId, key: string, v: OptValue) {
    this.states[id].config[key] = v;
    this.changed();
  }

  resetConfig(id: ModId) {
    this.states[id].config = { ...MOD_BY_ID[id].defaults };
    this.changed();
  }

  setPos(id: ModId, pos: { x: number; y: number } | undefined) {
    this.states[id].pos = pos;
    this.changed();
  }

  /** Where a widget goes: its dragged position, or its default (which may hang off the right edge). */
  pos(id: ModId): { x: number; y: number; right?: boolean } {
    return this.states[id].pos ?? MOD_BY_ID[id].widget ?? { x: 0, y: 0 };
  }

  get installedCount(): number {
    return MODS.filter((m) => this.states[m.id].installed).length;
  }
}
