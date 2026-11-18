import { isSolid } from '../game/Blocks';
import type { Fighter } from '../game/Fighter';

/** Solid ground within `depth` blocks under (x, z), from `f`'s feet down. */
function groundAt(f: Fighter, x: number, z: number, depth: number): boolean {
  const b = f.world.blocks;
  const fy = Math.floor(f.pos.y + 0.01);
  for (let y = fy - 1; y >= fy - depth; y--) if (isSolid(b.get(Math.floor(x), y, Math.floor(z)))) return true;
  return false;
}

/**
 * A duel bot on a map over the void (an imported arena): whatever its input asks for, it doesn't
 * walk off an edge by accident — where there's no ground ahead it sneaks so the edge holds it,
 * as players do. (Knockback can still send it off.)
 */
export function guardEdge(f: Fighter) {
  const input = f.input;
  if (!f.onGround || input.sneak || f.dead) return;
  const s = Math.sin(f.yaw);
  const c = Math.cos(f.yaw);
  const wx = -s * input.forward + c * input.strafe;
  const wz = -c * input.forward - s * input.strafe;
  const len = Math.hypot(wx, wz);
  if (len < 1e-3) {
    const v = Math.hypot(f.vel.x, f.vel.z);
    if (!groundAt(f, f.pos.x, f.pos.z, 1) || (v > 0.003 && !groundAt(f, f.pos.x + (f.vel.x / v) * 0.5, f.pos.z + (f.vel.z / v) * 0.5, 6))) input.sneak = true;
    return;
  }
  if (!groundAt(f, f.pos.x + (wx / len) * 0.8, f.pos.z + (wz / len) * 0.8, 6)) {
    input.sneak = true;
    input.sprint = false;
    input.jump = false;
  }
}
