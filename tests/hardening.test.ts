import { afterEach, describe, expect, it } from 'vitest';
import { cleanChat, cleanName, fromSlot, itemTotals } from '../src/net/protocol';
import { DEFAULT_SETTINGS, loadRecords, loadSettings } from '../src/ui/settings';
import { ModManager } from '../src/mods/registry';

describe('names and chat from other players', () => {
  it('drops control, zero-width and bidi-override characters', () => {
    expect(cleanName('‮evil\u0007name​')).toBe('evilname');
    expect(cleanName('   ')).toBe('Player');
    expect(cleanName({ toString: () => 'x' })).toBe('x');
    expect(cleanName('a'.repeat(40))).toHaveLength(16);
    expect(cleanChat('hi⁦ there\n', 256)).toBe('hi there');
  });
});

describe('inventory slots from a client', () => {
  it('only accepts real potion names, not inherited object properties', () => {
    expect(fromSlot(['splash_potion', 1, 0, 0, 'toString'])?.potion).toBeUndefined();
    expect(fromSlot(['splash_potion', 1, 0, 0, '__proto__'])?.potion).toBeUndefined();
    expect(fromSlot(['splash_potion', 1, 0, 0, 'healing'])?.potion).toBe('healing');
    expect(fromSlot(['__proto__', 1] as never)).toBeNull();
    // Totals can't be inflated with a junk count.
    expect(itemTotals([['golden_apple', 1e9] as never]).get('golden_apple::0::0:')).toBe(64);
  });
});

describe('corrupted saves', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  afterEach(() => store.clear());

  it('records that are not an object load as empty instead of crashing the end of a duel', () => {
    for (const bad of ['null', '[]', '5', '"x"']) {
      store.set('pvp-trainer.records.v1', bad);
      expect(loadRecords()).toEqual({});
    }
    store.set('pvp-trainer.records.v1', JSON.stringify({ 'sword:lt5': { wins: '3', losses: -2, bestCombo: null }, junk: 7 }));
    expect(loadRecords()).toEqual({ 'sword:lt5': { wins: 3, losses: 0, bestCombo: 0 } });
  });

  it('settings of the wrong type fall back to the defaults', () => {
    store.set('pvp-trainer.settings.v1', 'null');
    expect(loadSettings().fov).toBe(DEFAULT_SETTINGS.fov);
    store.set('pvp-trainer.settings.v1', JSON.stringify({ fov: 'wide', firstTo: 500, kit: 'nope', volume: 0.3 }));
    const s = loadSettings();
    expect(s.fov).toBe(DEFAULT_SETTINGS.fov);
    expect(s.firstTo).toBe(20);
    expect(s.kit).toBe('sword');
    expect(s.volume).toBe(0.3);
  });

  it('mod settings saved as null do not stop the game from starting', () => {
    store.set('pvp-trainer.mods.v1', 'null');
    for (const k of [...store.keys()]) if (k.includes('mod')) store.set(k, 'null');
    expect(() => new ModManager()).not.toThrow();
  });
});
