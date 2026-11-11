import { describe, expect, it } from 'vitest';
import { DEFAULT_GRID, GRID, MID, PRESETS, decodeGrid, encodeGrid } from '../src/mods/crosshairGrid';
import { MOD_BY_ID } from '../src/mods/registry';

describe('crosshair drawing', () => {
  it('round-trips a drawing and survives a damaged saved value', () => {
    const cells = decodeGrid(DEFAULT_GRID);
    expect(cells).toHaveLength(GRID * GRID);
    expect(encodeGrid(cells)).toBe(DEFAULT_GRID);
    expect(decodeGrid(undefined).every((c) => !c)).toBe(true);
    expect(decodeGrid('1x1').slice(0, 3)).toEqual([true, false, true]);
  });

  it('every ready-made drawing is symmetric around the aim pixel and not empty', () => {
    for (const [name, s] of PRESETS) {
      const c = decodeGrid(s);
      expect(c.some(Boolean), name).toBe(true);
      for (let y = 0; y < GRID; y++)
        for (let x = 0; x < GRID; x++) expect(c[y * GRID + x], `${name} ${x},${y}`).toBe(c[y * GRID + (GRID - 1 - x)]);
    }
    expect(MID).toBe(7);
  });

  it('the mod starts with a drawing and an on-target colour', () => {
    const d = MOD_BY_ID.crosshair.defaults;
    expect(d.pixels).toBe(DEFAULT_GRID);
    expect(d.onTarget).toBe(true);
    expect(typeof d.targetColor).toBe('string');
  });
});
