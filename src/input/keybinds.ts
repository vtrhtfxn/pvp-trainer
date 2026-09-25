/**
 * Rebindable controls (Options → Controls → Key Binds). A binding is a KeyboardEvent.code
 * ("KeyW", "Space", "ShiftLeft") or a mouse button ("Mouse0" left, "Mouse1" middle, "Mouse2"
 * right, "Mouse3"/"Mouse4" side buttons); "" is not bound.
 */
export type Action =
  | 'attack'
  | 'use'
  | 'forward'
  | 'left'
  | 'back'
  | 'right'
  | 'jump'
  | 'sneak'
  | 'sprint'
  | 'inventory'
  | 'swapHands'
  | 'hotbar1'
  | 'hotbar2'
  | 'hotbar3'
  | 'hotbar4'
  | 'hotbar5'
  | 'hotbar6'
  | 'hotbar7'
  | 'hotbar8'
  | 'hotbar9'
  | 'chat'
  | 'command'
  | 'perspective'
  | 'rematch'
  | 'zoom'
  | 'freelook';

export type KeyBinds = Record<Action, string>;

export const DEFAULT_KEYS: KeyBinds = {
  attack: 'Mouse0',
  use: 'Mouse2',
  forward: 'KeyW',
  left: 'KeyA',
  back: 'KeyS',
  right: 'KeyD',
  jump: 'Space',
  sneak: 'ShiftLeft',
  sprint: 'ControlLeft',
  inventory: 'KeyE',
  swapHands: 'KeyF',
  hotbar1: 'Digit1',
  hotbar2: 'Digit2',
  hotbar3: 'Digit3',
  hotbar4: 'Digit4',
  hotbar5: 'Digit5',
  hotbar6: 'Digit6',
  hotbar7: 'Digit7',
  hotbar8: 'Digit8',
  hotbar9: 'Digit9',
  chat: 'KeyT',
  command: 'Slash',
  perspective: 'F5',
  rematch: 'KeyR',
  zoom: 'KeyC',
  freelook: 'AltLeft',
};

export const ACTION_LABELS: Record<Action, string> = {
  attack: 'Attack/Destroy',
  use: 'Use Item/Place Block',
  forward: 'Walk Forwards',
  left: 'Strafe Left',
  back: 'Walk Backwards',
  right: 'Strafe Right',
  jump: 'Jump',
  sneak: 'Sneak',
  sprint: 'Sprint',
  inventory: 'Open/Close Inventory',
  swapHands: 'Swap Item With Offhand',
  hotbar1: 'Hotbar Slot 1',
  hotbar2: 'Hotbar Slot 2',
  hotbar3: 'Hotbar Slot 3',
  hotbar4: 'Hotbar Slot 4',
  hotbar5: 'Hotbar Slot 5',
  hotbar6: 'Hotbar Slot 6',
  hotbar7: 'Hotbar Slot 7',
  hotbar8: 'Hotbar Slot 8',
  hotbar9: 'Hotbar Slot 9',
  chat: 'Open Chat',
  command: 'Open Command',
  perspective: 'Toggle Perspective',
  rematch: 'Rematch (after a duel)',
  zoom: 'Zoom (Zoom mod)',
  freelook: 'Free Look (Freelook mod)',
};

export const ACTION_GROUPS: { title: string; actions: Action[] }[] = [
  { title: 'Movement', actions: ['forward', 'left', 'back', 'right', 'jump', 'sneak', 'sprint'] },
  { title: 'Gameplay', actions: ['attack', 'use', 'swapHands', 'rematch'] },
  { title: 'Inventory', actions: ['inventory', 'hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9'] },
  { title: 'Multiplayer & Misc', actions: ['chat', 'command', 'perspective'] },
  { title: 'Mods', actions: ['zoom', 'freelook'] },
];

export const HOTBAR_ACTIONS: Action[] = ['hotbar1', 'hotbar2', 'hotbar3', 'hotbar4', 'hotbar5', 'hotbar6', 'hotbar7', 'hotbar8', 'hotbar9'];

const NAMES: Record<string, string> = {
  Mouse0: 'Left Button',
  Mouse1: 'Middle Button',
  Mouse2: 'Right Button',
  Mouse3: 'Button 4',
  Mouse4: 'Button 5',
  Space: 'Space',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Control',
  ControlRight: 'Right Control',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  MetaLeft: 'Left Cmd',
  MetaRight: 'Right Cmd',
  Tab: 'Tab',
  CapsLock: 'Caps Lock',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Slash: '/',
  Backslash: '\\',
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
};

export function keyName(code: string): string {
  if (!code) return 'Not bound';
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Keypad ${code.slice(6)}`;
  return code;
}

/** Fills in actions added since the binds were saved; drops unknown ones. */
export function normalizeBinds(saved: Partial<Record<string, string>> | undefined): KeyBinds {
  const out = { ...DEFAULT_KEYS };
  if (saved) for (const k of Object.keys(out) as Action[]) if (typeof saved[k] === 'string') out[k] = saved[k]!;
  return out;
}

/** Actions sharing a key with another (shown red, like vanilla). Zoom/freelook may share. */
export function conflicts(binds: KeyBinds): Set<Action> {
  const seen = new Map<string, Action[]>();
  for (const [a, code] of Object.entries(binds) as [Action, string][]) {
    if (!code) continue;
    seen.set(code, [...(seen.get(code) ?? []), a]);
  }
  const out = new Set<Action>();
  for (const list of seen.values()) if (list.length > 1) for (const a of list) out.add(a);
  return out;
}
