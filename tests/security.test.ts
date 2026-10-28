import { describe, expect, it } from 'vitest';
import { Fighter } from '../src/game/Fighter';
import { kitById } from '../src/game/kits';
import { World } from '../src/game/World';
import { itemTotals, toSlot } from '../src/net/protocol';

function fighter() {
  const world = new World(60);
  const f = new Fighter('player', 'A', world);
  world.fighters.push(f);
  f.reset(0, 0, 0, kitById('mace'));
  return f;
}

describe('online movement packets', () => {
  it('ignores a claimed fall the packets never showed', () => {
    const f = fighter();
    const y = f.pos.y;
    // Standing still but claiming a 400-block fall: would be a one-shot mace smash.
    f.applyMove(0, y, 0, 0, 0, false, false, false, 0, false, 400);
    expect(f.fallDistance).toBeLessThan(0.05);
  });

  it('still takes the client count for a real fall', () => {
    const f = fighter();
    const y = f.pos.y;
    f.applyMove(0, y + 6, 0, 0, 0, false, false, false, 0, false, 0);
    f.applyMove(0, y + 3, 0, 0, 0, false, false, false, 0, false, 3);
    expect(f.fallDistance).toBeCloseTo(3, 1);
    // …and a lower one (water, slow falling) wins over the drop.
    f.applyMove(0, y + 2, 0, 0, 0, false, false, false, 0, false, 0.5);
    expect(f.fallDistance).toBeCloseTo(0.5, 5);
  });
});

describe('inventory layouts', () => {
  it('count what a shulker box holds, so a layout cannot refill one', () => {
    const empty = toSlot({ id: 'red_shulker_box', count: 1, stored: 3 });
    const full = toSlot({ id: 'red_shulker_box', count: 1, stored: 27 });
    const a = itemTotals([empty]);
    const b = itemTotals([full]);
    expect([...a.keys()]).not.toEqual([...b.keys()]);
  });
});
