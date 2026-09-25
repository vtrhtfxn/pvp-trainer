import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { defaultSession, sessionModified } from '../src/commands/host';
import { B } from '../src/game/Blocks';
import { ITEMS, formatTicks, INFINITE_DURATION } from '../src/game/items';
import { kitById } from '../src/game/kits';
import { Match } from '../src/game/Match';
import { DEFAULT_KEYS, conflicts, keyName, normalizeBinds } from '../src/input/keybinds';
import { estimateRegen } from '../src/mods/appleskin';
import { MODS, ModManager } from '../src/mods/registry';
import { celestialAngle } from '../src/render/Arena';

function duel(kit = 'sword') {
  const m = new Match(kitById(kit as never), DIFFICULTIES.lt3, 5);
  while (m.phase !== 'fight') m.tick();
  return m;
}

describe('key binds', () => {
  it('fills in missing actions, drops unknown ones and names keys', () => {
    const b = normalizeBinds({ sprint: 'KeyQ', nonsense: 'KeyZ' } as never);
    expect(b.sprint).toBe('KeyQ');
    expect(b.forward).toBe(DEFAULT_KEYS.forward);
    expect('nonsense' in b).toBe(false);
    expect(keyName('Mouse0')).toBe('Left Button');
    expect(keyName('KeyW')).toBe('W');
    expect(keyName('Digit3')).toBe('3');
    expect(keyName('')).toBe('Not bound');
  });

  it('flags keys used twice (and not unbound ones)', () => {
    expect(conflicts(DEFAULT_KEYS).size).toBe(0);
    const b = { ...DEFAULT_KEYS, jump: 'KeyW', chat: '', command: '' };
    expect([...conflicts(b)].sort()).toEqual(['forward', 'jump']);
  });
});

describe('mod manager', () => {
  it('starts with everything uninstalled; install, toggle, configure, reset, move', () => {
    const mods = new ModManager();
    expect(MODS.length).toBeGreaterThanOrEqual(15);
    expect(mods.installedCount).toBe(0);
    expect(mods.on('appleskin')).toBe(false);
    let changes = 0;
    mods.onChange(() => changes++);
    mods.install('appleskin');
    expect(mods.on('appleskin')).toBe(true);
    mods.setEnabled('appleskin', false);
    expect(mods.on('appleskin')).toBe(false);
    expect(mods.installedCount).toBe(1);
    mods.set('zoom', 'factor', 8);
    expect(mods.cfg('zoom', 'factor')).toBe(8);
    mods.resetConfig('zoom');
    expect(mods.cfg('zoom', 'factor')).toBe(4);
    expect(mods.pos('fps')).toEqual(MODS.find((m) => m.id === 'fps')!.widget);
    mods.setPos('fps', { x: 0.5, y: 0.25 });
    expect(mods.pos('fps')).toEqual({ x: 0.5, y: 0.25 });
    mods.uninstall('appleskin');
    expect(mods.installedCount).toBe(0);
    expect(changes).toBe(6);
  });

  it('every mod has defaults for all its options', () => {
    for (const m of MODS) for (const o of m.options) expect(m.defaults[o.key], `${m.id}.${o.key}`).toBeDefined();
  });
});

describe('AppleSkin', () => {
  // The estimate must match what FoodData's regeneration really gives back after eating.
  const real = (level: number, sat: number, hp: number, id: 'golden_apple' | 'cooked_beef') => {
    const m = duel();
    const p = m.player;
    Object.assign(p.food, { level, saturation: sat, exhaustion: 0, tickTimer: 0 });
    p.health = hp;
    const food = ITEMS[id].food!;
    const est = estimateRegen(p, food);
    p.food.eat(food.nutrition, food.saturationModifier);
    for (let i = 0; i < 40000; i++) p.food.tick(p, true);
    return { est, got: p.health - hp };
  };

  it('predicts the health eating gives back', () => {
    for (const [level, sat, hp, id] of [
      [20, 3, 8, 'golden_apple'],
      [14, 0, 10, 'golden_apple'],
      [10, 0, 6, 'cooked_beef'],
      [18, 2, 15, 'cooked_beef'],
    ] as const) {
      const r = real(level, sat, hp, id);
      expect(Math.abs(r.est - r.got), `${level}/${sat}/${hp} ${id}: ${r.est} vs ${r.got}`).toBeLessThan(0.6);
    }
  });

  it('predicts nothing when natural regeneration is off', () => {
    const m = duel();
    m.player.health = 10;
    m.world.rules.naturalRegeneration = false;
    expect(estimateRegen(m.player, ITEMS.golden_apple.food!)).toBe(0);
    const uhc = duel('uhc');
    uhc.player.health = 10;
    expect(estimateRegen(uhc.player, ITEMS.golden_apple.food!)).toBe(0);
  });
});

describe('weather and time', () => {
  it('rain puts out a burning fighter under the open sky, not under a roof', () => {
    const m = duel('uhc');
    const p = m.player;
    m.world.raining = true;
    p.ignite(200);
    m.tick();
    expect(p.fireTicks).toBe(0);
    // A roof over their head keeps the rain off.
    const x = Math.floor(p.pos.x);
    const z = Math.floor(p.pos.z);
    m.world.blocks.set(x, Math.floor(p.pos.y) + 4, z, B.COBBLESTONE);
    p.ignite(200);
    m.tick();
    expect(p.fireTicks).toBeGreaterThan(150);
  });

  it('celestial angle: noon overhead, midnight opposite', () => {
    expect(celestialAngle(6000)).toBeCloseTo(0, 5);
    expect(celestialAngle(18000)).toBeCloseTo(0.5, 5);
    const sunrise = celestialAngle(0);
    expect(sunrise).toBeGreaterThan(0.7);
    expect(sunrise).toBeLessThan(0.8);
  });

  it('infinite effects show ∞', () => {
    expect(formatTicks(INFINITE_DURATION - 100)).toBe('∞');
    expect(formatTicks(1200)).toBe('1:00');
  });
});

describe('session', () => {
  it('only game-changing settings mark duels as modified', () => {
    const s = defaultSession();
    expect(sessionModified(s)).toBe(false);
    s.rules.showDeathMessages = false;
    s.dayTime = 18000;
    s.weather = 'rain';
    expect(sessionModified(s)).toBe(false);
    s.attrs.player.entity_interaction_range = 4;
    expect(sessionModified(s)).toBe(true);
    const t = defaultSession();
    t.tickRate = 30;
    expect(sessionModified(t)).toBe(true);
  });
});
