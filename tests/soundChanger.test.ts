import { describe, expect, it } from 'vitest';
import { Sound } from '../src/audio/Sound';

describe('Sound Changer', () => {
  it('every sound method still works with its group set around it, and the group is cleared after', () => {
    const s = new Sound();
    const seen: (string | null)[] = [];
    // Peek at the group while out() runs (no audio device in tests: out() returns early).
    const out = (s as unknown as { out: (...a: unknown[]) => unknown }).out;
    (s as unknown as { out: (...a: unknown[]) => unknown }).out = function (this: Sound, ...a: unknown[]) {
      seen.push((this as unknown as { group: string | null }).group);
      return out.apply(this, a);
    };
    const at = { x: 0, y: 0, z: 0 };
    s.hit('crit', at);
    s.bowShoot(at, 1);
    s.explosion(at, 4);
    s.pearl(at, true);
    s.step(at, true);
    s.ui();
    expect(seen.slice(0, 5)).toEqual(['hits', 'arrows', 'explosions', 'teleports', 'steps']);
    expect(seen.at(-1)).toBeNull();
    expect((s as unknown as { group: string | null }).group).toBeNull();
  });
});
