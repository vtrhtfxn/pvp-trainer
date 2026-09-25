import * as C from '../core/constants';
import type { Fighter } from '../game/Fighter';
import type { FoodProps } from '../game/items';

/**
 * AppleSkin's health estimate: runs FoodData's natural regeneration forward from the hunger,
 * saturation and exhaustion eating would leave, and counts the health it gives back.
 */
export function estimateRegen(p: Fighter, food: FoodProps | null): number {
  if (!p.naturalRegen || !p.world.rules.naturalRegeneration) return 0;
  let level = p.food.level;
  let sat = p.food.saturation;
  if (food) {
    level = Math.min(level + food.nutrition, C.MAX_FOOD);
    sat = Math.min(sat + food.nutrition * food.saturationModifier * 2, level);
  }
  let exh = p.food.exhaustion;
  let hp = p.health;
  const max = p.maxHealth;
  for (let i = 0; i < 400 && hp < max; i++) {
    // FoodData.tick drains 4 exhaustion per tick when over 4; regen events are ≥10 ticks apart,
    // so everything over 4 is drained before the next one.
    while (exh > 4) {
      exh -= 4;
      if (sat > 0) sat = Math.max(sat - 1, 0);
      else level = Math.max(level - 1, 0);
    }
    if (sat > 0 && level >= 20) {
      const a = Math.min(sat, 6);
      hp += a / 6;
      exh += a;
    } else if (level >= 18) {
      hp += 1;
      exh += C.EXHAUSTION_HEAL;
    } else break;
  }
  return Math.max(0, Math.min(max, hp) - p.health);
}
