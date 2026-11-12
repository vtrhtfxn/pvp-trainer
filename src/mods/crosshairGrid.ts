/**
 * The Custom Crosshair mod's own drawing: a 15×15 grid of pixels whose middle one is exactly
 * where you aim. Kept in the mod's settings as a string of 225 '0'/'1' characters, row by row.
 */

export const GRID = 15;
export const MID = (GRID - 1) / 2;

export function decodeGrid(s: unknown): boolean[] {
  const str = typeof s === 'string' ? s : '';
  return Array.from({ length: GRID * GRID }, (_, i) => str[i] === '1');
}

export function encodeGrid(cells: boolean[]): string {
  return cells.map((c) => (c ? '1' : '0')).join('');
}

function make(on: (x: number, y: number) => boolean): string {
  const cells: boolean[] = [];
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) cells.push(on(x - MID, y - MID));
  return encodeGrid(cells);
}

/** Starting points for a drawing (x, y measured from the middle pixel). */
export const PRESETS: [string, string][] = [
  ['Cross', make((x, y) => (x === 0 && Math.abs(y) >= 2 && Math.abs(y) <= 5) || (y === 0 && Math.abs(x) >= 2 && Math.abs(x) <= 5))],
  ['Dot', make((x, y) => Math.abs(x) <= 1 && Math.abs(y) <= 1)],
  ['Ring', make((x, y) => Math.abs(Math.hypot(x, y) - 4.5) < 0.6)],
  ['Ring + dot', make((x, y) => Math.abs(Math.hypot(x, y) - 5) < 0.6 || (x === 0 && y === 0))],
  ['Chevron', make((x, y) => y >= 0 && y <= 4 && Math.abs(x) === y + 1)],
  ['Corners', make((x, y) => (Math.abs(x) === 5 && Math.abs(y) >= 3 && Math.abs(y) <= 5) || (Math.abs(y) === 5 && Math.abs(x) >= 3 && Math.abs(x) <= 5) || (x === 0 && y === 0))],
  ['X', make((x, y) => Math.abs(x) === Math.abs(y) && Math.abs(x) >= 2 && Math.abs(x) <= 5)],
];

/** The drawing a new player starts with: a small cross with a gap. */
export const DEFAULT_GRID = PRESETS[0][1];
