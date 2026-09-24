export class V3 {
  constructor(public x = 0, public y = 0, public z = 0) {}
  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  copy(v: V3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  clone(): V3 {
    return new V3(this.x, this.y, this.z);
  }
  horizontalLength(): number {
    return Math.hypot(this.x, this.z);
  }
}

export const DEG = Math.PI / 180;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

// Yaw convention (matches a three.js camera with rotation order YXZ):
// yaw 0 looks toward -Z, forward = (-sin yaw, 0, -cos yaw), right = (cos yaw, 0, -sin yaw).
export function forwardX(yaw: number) {
  return -Math.sin(yaw);
}
export function forwardZ(yaw: number) {
  return -Math.cos(yaw);
}

/** Yaw that looks along the horizontal direction (dx, dz). */
export function yawTowards(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

export function lookDir(yaw: number, pitch: number, out: V3): V3 {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

export interface AABB {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Slab-method ray/box test. Returns the entry distance along the (normalised) ray,
 * 0 if the origin is inside the box, or -1 on a miss.
 */
export function rayAABB(o: V3, d: V3, b: AABB): number {
  let tmin = 0;
  let tmax = Infinity;
  const axes: [number, number, number, number][] = [
    [o.x, d.x, b.minX, b.maxX],
    [o.y, d.y, b.minY, b.maxY],
    [o.z, d.z, b.minZ, b.maxZ],
  ];
  for (const [oo, dd, lo, hi] of axes) {
    if (Math.abs(dd) < 1e-9) {
      if (oo < lo || oo > hi) return -1;
      continue;
    }
    let t1 = (lo - oo) / dd;
    let t2 = (hi - oo) / dd;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}

/** Shortest distance from a point to a box (0 when inside). */
export function pointAABBDistance(p: V3, b: AABB): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.hypot(dx, dy, dz);
}
