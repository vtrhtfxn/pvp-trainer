import type * as THREE from 'three';

/**
 * World brightness for the unlit (baked-shading) block materials: their colour multiplies the
 * texture, so scaling it darkens the arena at night or in a storm. Glowing blocks never register.
 */
const lit = new Set<THREE.MeshBasicMaterial>();
let level = 1;

export function litMaterial<T extends THREE.MeshBasicMaterial>(m: T): T {
  lit.add(m);
  m.color.setScalar(level);
  return m;
}

export function setWorldLight(v: number) {
  if (Math.abs(v - level) < 0.004) return;
  level = v;
  for (const m of lit) m.color.setScalar(v);
}
