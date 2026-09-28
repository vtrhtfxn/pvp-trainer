import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from '../src/ai/difficulty';
import { Match } from '../src/game/Match';
import { blankCustomKit, cleanCustomKit, customFromLoadout, customKitDef, enchantsFor } from '../src/game/customKits';
import { kitById, registerCustomKits } from '../src/game/kits';
import { awardTier } from '../src/game/series';

describe('custom kits', () => {
  it('only keeps what the game can run', () => {
    const k = cleanCustomKit({
      id: 'custom:abc',
      name: 'My​ Kit\u0007',
      hotbar: [
        { id: '__proto__', count: 5 },
        { id: 'diamond_sword', count: 99, ench: { sharpness: 99, protection: 4, fireAspect: 2 } },
        { id: 'golden_apple', count: 1e9 },
        { id: 'splash_potion', count: 1, potion: 'constructor' },
        { id: 'tipped_arrow', count: 64, potion: 'strength' },
      ],
      armor: [{ id: 'diamond_boots', count: 1 }, { id: 'diamond_chestplate', count: 1, ench: { protection: 4, featherFalling: 4 } }],
      naturalRegen: false,
    })!;
    expect(k.name).toBe('My Kit');
    expect(k.hotbar[0]).toBeNull();
    // A sword stacks to 1, keeps its sword enchantments (capped at the vanilla max) only.
    expect(k.hotbar[1]).toEqual({ id: 'diamond_sword', count: 1, ench: { sharpness: 5, fireAspect: 2 } });
    expect(k.hotbar[2]).toEqual({ id: 'golden_apple', count: 64 });
    expect(k.hotbar[3]?.potion).toBe('healing');
    expect(k.hotbar[4]?.potion).toBe('strength');
    // Boots can't be worn on the head; Feather Falling only goes on boots.
    expect(k.armor[0]).toBeNull();
    expect(k.armor[1]).toEqual({ id: 'diamond_chestplate', count: 1, ench: { protection: 4 } });
    expect(k.hotbar).toHaveLength(9);
    expect(k.main).toHaveLength(27);
    expect(k.naturalRegen).toBe(false);
    expect(cleanCustomKit({ id: 'sword', name: 'x' })).toBeNull();
    expect(cleanCustomKit({ id: 'custom:../../x' })).toBeNull();
  });

  it('offers the enchantments each item can use', () => {
    expect(enchantsFor('diamond_boots')).toContain('featherFalling');
    expect(enchantsFor('diamond_helmet')).not.toContain('featherFalling');
    expect(enchantsFor('mace')).toContain('density');
    expect(enchantsFor('golden_apple')).toEqual([]);
  });

  it('plays against a bot, which uses whatever weapon the kit has', () => {
    const data = blankCustomKit('Axe only');
    data.hotbar[0] = { id: 'netherite_axe', count: 1, ench: { sharpness: 5 } };
    data.hotbar[1] = { id: 'golden_apple', count: 16 };
    registerCustomKits([customKitDef(data)]);
    const kit = kitById(data.id);
    expect(kit.name).toBe('Axe only');
    const m = new Match(kit, DIFFICULTIES.ht3, 5);
    let botHits = 0;
    while (m.phase !== 'ended' && m.tickCount < 20 * 60) {
      m.tick();
      m.world.events.length = 0;
      m.player.events.length = 0;
      m.bot.events.length = 0;
      botHits = m.bot.stats.hits;
    }
    expect(m.bot.heldStack()?.id === 'netherite_axe' || m.player.dead).toBe(true);
    expect(botHits).toBeGreaterThan(0);
  });

  it('copies a built-in kit, and never earns a tier', () => {
    const c = customFromLoadout('Crystal (custom)', kitById('crystal'));
    expect(c.hotbar.filter(Boolean)).toHaveLength(9);
    expect(customKitDef(c).floorDepth).toBe(4);
    expect(awardTier({}, c.id, 'ht1')).toBe(false);
    expect(awardTier({}, 'sword18', 'lt5')).toBe(true);
  });
});
