import { describe, expect, it } from 'vitest';
import { botUsernames, paintSkin, skinRecipe } from '../src/ai/disguise';
import { Rng } from '../src/core/rng';

describe('bots disguised as players', () => {
  it('get valid, different usernames, the same ones again from the same seed', () => {
    for (let seed = 1; seed < 200; seed++) {
      const names = botUsernames(seed, 15);
      expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(15);
      for (const n of names) expect(n).toMatch(/^[A-Za-z0-9_]{3,16}$/);
      expect(botUsernames(seed, 15)).toEqual(names);
    }
    expect(botUsernames(1, 3)).not.toEqual(botUsernames(2, 3));
  });

  it('get a full skin: every base-layer face painted, the hat layer clear unless it is a cap', () => {
    for (let seed = 1; seed < 40; seed++) {
      const px = new Uint8ClampedArray(64 * 64 * 4);
      const rng = new Rng(seed);
      const r = skinRecipe(rng);
      paintSkin(px, r, rng);
      const alpha = (x: number, y: number) => px[(y * 64 + x) * 4 + 3];
      // Head faces, body, both arms and both legs (front faces).
      for (const [x, y] of [[12, 12], [4, 4 + 8], [28, 20], [44, 24], [36, 56], [4, 24], [20, 56]]) expect(alpha(x, y), `${seed} ${x},${y}`).toBe(255);
      // Hat layer front: only a cap draws there.
      expect(alpha(44, 14)).toBe(0);
      if (r.hairStyle !== 2) expect(alpha(44, 4)).toBe(0);
    }
  });
});
