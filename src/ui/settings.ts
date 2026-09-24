import type { DifficultyId } from '../ai/difficulty';
import type { KitId } from '../game/kits';

export interface Settings {
  /** Minecraft sensitivity slider 0..1 (0.5 = 100%). */
  sensitivity: number;
  fov: number;
  fovEffects: number;
  viewBobbing: boolean;
  damageTilt: number;
  toggleSprint: boolean;
  doubleTapSprint: boolean;
  rawInput: boolean;
  showReach: boolean;
  showCombo: boolean;
  showCps: boolean;
  showNextHit: boolean;
  hitFeedback: boolean;
  showOpponentBar: boolean;
  showHitboxes: boolean;
  volume: number;
  guiScale: number; // 0 = auto
  kit: KitId;
  difficulty: DifficultyId;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 0.5,
  fov: 85,
  fovEffects: 0.5,
  viewBobbing: true,
  damageTilt: 1,
  toggleSprint: true,
  doubleTapSprint: true,
  rawInput: true,
  showReach: true,
  showCombo: true,
  showCps: true,
  showNextHit: true,
  hitFeedback: true,
  showOpponentBar: true,
  showHitboxes: false,
  volume: 0.8,
  guiScale: 0,
  kit: 'sword',
  difficulty: 'normal',
};

const KEY = 'pvp-trainer.settings.v1';
const RECORD_KEY = 'pvp-trainer.records.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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
    if (raw) return JSON.parse(raw) as Records;
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
