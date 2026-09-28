import { DIFFICULTIES, LEGACY_DIFFICULTY, type DifficultyId } from '../ai/difficulty';
import { KITS, type KitId } from '../game/kits';
import { clampFirstTo } from '../game/series';
import { DEFAULT_KEYS, normalizeBinds, type KeyBinds } from '../input/keybinds';

export type ParticleLevel = 'all' | 'decreased' | 'minimal';

export interface Settings {
  // ---- controls
  /** Minecraft sensitivity slider 0..1 (0.5 = 100%). */
  sensitivity: number;
  /** Vertical sensitivity; -1 follows the main slider. */
  sensitivityY: number;
  invertY: boolean;
  toggleSprint: boolean;
  toggleSneak: boolean;
  doubleTapSprint: boolean;
  rawInput: boolean;
  /** Scroll the hotbar the other way. */
  invertScroll: boolean;
  keys: KeyBinds;
  /** Fullscreen while playing, so Ctrl+W (sprint + forward) cannot close the tab. */
  fullscreenLock: boolean;
  // ---- video
  fov: number;
  fovEffects: number;
  /** FOV of the first-person hand and held item (vanilla draws them at 70). */
  handFov: number;
  /** Third-person camera distance in blocks (vanilla: 4). */
  thirdPersonDistance: number;
  viewBobbing: boolean;
  damageTilt: number;
  guiScale: number; // 0 = auto
  /** 0 = automatic (drops when frames are slow); otherwise a fixed percentage of full resolution. */
  renderScale: number;
  /** Frame cap; 0 = as fast as the display refreshes. */
  maxFps: number;
  /** 0 (Moody) … 1 (Bright). */
  brightness: number;
  particles: ParticleLevel;
  entityShadows: boolean;
  clouds: boolean;
  fog: boolean;
  /** Smoothing on the edges (MSAA). 'auto' turns it off on high-density screens. Applies after a restart. */
  antialias: 'auto' | 'on' | 'off';
  /** First-person hand: offsets (blocks) and size. */
  handX: number;
  handY: number;
  handZ: number;
  handScale: number;
  showHand: boolean;
  /** The spinning duel behind the title screen (off saves power). */
  menuBackground: boolean;
  // ---- sound
  volume: number;
  /** Hits, hurt, bows, explosions… */
  volumePlayers: number;
  /** Footsteps and landing. */
  volumeSteps: number;
  /** Blocks, buckets, eating, potions, pickups. */
  volumeBlocks: number;
  /** Menu clicks, countdown, results jingle. */
  volumeUi: number;
  // ---- HUD & practice
  showReach: boolean;
  showCombo: boolean;
  showCps: boolean;
  showNextHit: boolean;
  hitFeedback: boolean;
  showOpponentBar: boolean;
  showHitboxes: boolean;
  showNametag: boolean;
  showEffects: boolean;
  showPracticePanel: boolean;
  // ---- chat
  chatVisibility: 'shown' | 'commands' | 'hidden';
  chatOpacity: number;
  chatBackground: number;
  chatScale: number;
  chatWidth: number;
  // ---- game
  kit: KitId;
  difficulty: DifficultyId;
  /** Rounds to win against the bot ("first to"); 1 = a single duel. */
  firstTo: number;
  /** Bot vs Bot: the two tiers last picked. */
  versusA: DifficultyId;
  versusB: DifficultyId;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.5,
  sensitivityY: -1,
  invertY: false,
  toggleSprint: true,
  toggleSneak: false,
  doubleTapSprint: true,
  rawInput: true,
  invertScroll: false,
  keys: { ...DEFAULT_KEYS },
  fullscreenLock: true,
  fov: 85,
  fovEffects: 0.5,
  handFov: 70,
  thirdPersonDistance: 4,
  viewBobbing: true,
  damageTilt: 1,
  guiScale: 0,
  renderScale: 0,
  maxFps: 0,
  brightness: 0.5,
  particles: 'all',
  entityShadows: true,
  clouds: true,
  fog: true,
  antialias: 'auto',
  handX: 0,
  handY: 0,
  handZ: 0,
  handScale: 1,
  showHand: true,
  menuBackground: true,
  volume: 0.8,
  volumePlayers: 1,
  volumeSteps: 1,
  volumeBlocks: 1,
  volumeUi: 1,
  showReach: true,
  showCombo: true,
  showCps: true,
  showNextHit: true,
  hitFeedback: true,
  showOpponentBar: true,
  showHitboxes: false,
  showNametag: true,
  showEffects: true,
  showPracticePanel: true,
  chatVisibility: 'shown',
  chatOpacity: 1,
  chatBackground: 0.5,
  chatScale: 1,
  chatWidth: 320,
  kit: 'sword',
  difficulty: 'ht4',
  firstTo: 1,
  versusA: 'lt1',
  versusB: 'ht1',
};

const KEY = 'pvp-trainer.settings.v1';
const RECORD_KEY = 'pvp-trainer.records.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const saved = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Partial<Settings>;
      const s: Settings = { ...DEFAULT_SETTINGS, ...saved, keys: normalizeBinds(saved.keys) };
      // Values of the wrong type (an old or hand-edited save) fall back to the default.
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
        if (typeof s[k] !== typeof DEFAULT_SETTINGS[k]) (s as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
      }
      s.firstTo = clampFirstTo(s.firstTo);
      if (!KITS.some((kit) => kit.id === s.kit)) s.kit = DEFAULT_SETTINGS.kit;
      for (const k of ['versusA', 'versusB'] as const) if (!(s[k] in DIFFICULTIES) || s[k] === 'practice') s[k] = DEFAULT_SETTINGS[k];
      // Easy / Normal / Hard / Expert became tiers; anything unknown falls back to the default.
      if (!(s.difficulty in DIFFICULTIES)) s.difficulty = LEGACY_DIFFICULTY[s.difficulty] ?? DEFAULT_SETTINGS.difficulty;
      return s;
    }
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface DuelRecord {
  wins: number;
  losses: number;
  bestCombo: number;
}

export type Records = Record<string, DuelRecord>;

export function loadRecords(): Records {
  try {
    const raw = localStorage.getItem(RECORD_KEY);
    const r: unknown = raw ? JSON.parse(raw) : null;
    // Anything but a plain object (a corrupted or hand-edited value) would crash the end of
    // every duel, so it is dropped; each record is checked too.
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const out: Records = {};
      for (const [k, v] of Object.entries(r as Record<string, Partial<DuelRecord>>)) {
        if (!v || typeof v !== 'object') continue;
        const n = (x: unknown) => (Number.isFinite(Number(x)) ? Math.max(0, Math.floor(Number(x))) : 0);
        out[k] = { wins: n(v.wins), losses: n(v.losses), bestCombo: n(v.bestCombo) };
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function saveRecords(r: Records) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(r));
  } catch {
    /* ignore */
  }
}

const NAME_KEY = 'pvp-trainer.net.name';

/** Your name in chat and online (the one typed on the Multiplayer screen). */
export function loadPlayerName(): string {
  try {
    return (localStorage.getItem(NAME_KEY) || '').trim() || 'Player';
  } catch {
    return 'Player';
  }
}
