import { describe, expect, it } from 'vitest';
import { mapPath, parseZipPack } from '../src/render/resourcePack';
import { readZip } from '../src/render/zip';
import { zip } from './zipWriter';


const KNOWN = new Set(['item/golden_apple', 'item/diamond_sword', 'block/cobweb', 'block/oak_planks', 'models/armor/golden_layer_1', 'models/armor/diamond_layer_2', 'item/totem_of_undying', 'misc/enchanted_glint_item', 'misc/enchanted_glint_armor', 'gui/sprites/hud/heart/full']);

describe('resource packs', () => {
  it('reads stored and deflated zip entries', async () => {
    for (const deflate of [false, true]) {
      const entries = readZip(zip({ 'a.txt': 'hello hello hello', 'dir/b.bin': new Uint8Array([1, 2, 3]) }, deflate));
      expect(entries.map((e) => e.name)).toEqual(['a.txt', 'dir/b.bin']);
      expect(new TextDecoder().decode(await entries[0].read())).toBe('hello hello hello');
      expect([...(await entries[1].read())]).toEqual([1, 2, 3]);
    }
    expect(() => readZip(new TextEncoder().encode('not a zip at all, sorry'))).toThrow();
  });

  it('maps 1.8 – 1.12 and 1.21.2+ names onto the game textures', () => {
    expect(mapPath('items/apple_golden.png')).toBe('item/golden_apple');
    expect(mapPath('items/diamond_sword.png')).toBe('item/diamond_sword');
    expect(mapPath('blocks/web.png')).toBe('block/cobweb');
    expect(mapPath('blocks/planks_oak.png')).toBe('block/oak_planks');
    expect(mapPath('items/totem.png')).toBe('item/totem_of_undying');
    expect(mapPath('models/armor/gold_layer_1.png')).toBe('models/armor/golden_layer_1');
    expect(mapPath('entity/equipment/humanoid/diamond.png')).toBe('models/armor/diamond_layer_1');
    expect(mapPath('entity/equipment/humanoid_leggings/gold.png')).toBe('models/armor/golden_layer_2');
    expect(mapPath('entity/equipment/humanoid/leather_overlay.png')).toBe('models/armor/leather_layer_1_overlay');
    expect(mapPath('item/diamond_sword.png')).toBe('item/diamond_sword');
  });

  it('sorts a 1.8 pack zipped inside its own folder', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const bytes = zip({
      'Swight Pack/pack.mcmeta': JSON.stringify({ pack: { pack_format: 1, description: '§6Swight §7PvP' } }),
      'Swight Pack/pack.png': png,
      'Swight Pack/assets/minecraft/textures/items/apple_golden.png': png,
      'Swight Pack/assets/minecraft/textures/items/diamond_sword.png': png,
      'Swight Pack/assets/minecraft/textures/blocks/web.png': png,
      'Swight Pack/assets/minecraft/textures/gui/icons.png': png,
      'Swight Pack/assets/minecraft/textures/gui/widgets.png': png,
      'Swight Pack/assets/minecraft/textures/items/leather_helmet.png': png,
      'Swight Pack/assets/minecraft/textures/misc/enchanted_item_glint.png': png,
      'Swight Pack/assets/minecraft/textures/items/something_else.png': png,
      'Swight Pack/assets/minecraft/sounds/random/bow.ogg': png,
    });
    const p = await parseZipPack(bytes, KNOWN);
    expect(p.description).toBe('Swight PvP');
    expect(p.icon).not.toBeNull();
    expect([...p.textures.keys()].sort()).toEqual(['block/cobweb', 'item/diamond_sword', 'item/golden_apple', 'misc/enchanted_glint_armor', 'misc/enchanted_glint_item']);
    expect(p.atlases.icons).toBeDefined();
    expect(p.atlases.widgets).toBeDefined();
    expect([...p.leather.keys()]).toEqual(['item/leather_helmet']);
    expect([...(await p.textures.get('item/golden_apple')!.read())]).toEqual([...png]);
  });

  it('reads a modern pack (text-component description, HUD sprites as files)', async () => {
    const png = new Uint8Array([1]);
    const p = await parseZipPack(
      zip({
        'pack.mcmeta': JSON.stringify({ pack: { pack_format: 46, description: { text: 'Hi', extra: [{ text: ' there' }] } } }),
        'assets/minecraft/textures/gui/sprites/hud/heart/full.png': png,
        'assets/minecraft/textures/entity/equipment/humanoid_leggings/diamond.png': png,
      }),
      KNOWN,
    );
    expect(p.description).toBe('Hi there');
    expect([...p.textures.keys()].sort()).toEqual(['gui/sprites/hud/heart/full', 'models/armor/diamond_layer_2']);
  });
});
