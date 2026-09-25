import * as THREE from 'three';

const DROPS = 1400;
const RADIUS = 22;
const HEIGHT = 26;
const SPEED = 19; // blocks per second

/**
 * Rain (LevelRenderer.renderSnowAndRain, simplified): streaks falling in a cylinder around the
 * camera. Positions are updated in place each frame; nothing is allocated while it rains.
 */
export class RainView {
  readonly lines: THREE.LineSegments;
  private readonly pos: Float32Array;
  private readonly seeds: Float32Array;
  private readonly material: THREE.LineBasicMaterial;

  constructor() {
    this.pos = new Float32Array(DROPS * 6);
    this.seeds = new Float32Array(DROPS * 3);
    for (let i = 0; i < DROPS; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * RADIUS;
      this.seeds[i * 3] = Math.cos(a) * r;
      this.seeds[i * 3 + 1] = Math.random() * HEIGHT;
      this.seeds[i * 3 + 2] = Math.sin(a) * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.material = new THREE.LineBasicMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  update(camera: THREE.Camera, strength: number, dt: number) {
    const on = strength > 0.01;
    this.lines.visible = on;
    if (!on) return;
    this.material.opacity = 0.55 * strength;
    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;
    const n = Math.floor(DROPS * Math.min(1, 0.25 + strength));
    const fall = SPEED * dt;
    const p = this.pos;
    const s = this.seeds;
    for (let i = 0; i < DROPS; i++) {
      const o = i * 6;
      if (i >= n) {
        p[o] = p[o + 3] = cx;
        p[o + 1] = p[o + 4] = -1000;
        p[o + 2] = p[o + 5] = cz;
        continue;
      }
      let y = s[i * 3 + 1] - fall;
      if (y < 0) y += HEIGHT;
      s[i * 3 + 1] = y;
      // Drops live in camera-relative columns, so walking never outruns the rain.
      const x = cx + s[i * 3];
      const z = cz + s[i * 3 + 2];
      const top = cy - HEIGHT / 2 + y;
      p[o] = x;
      p[o + 1] = top;
      p[o + 2] = z;
      p[o + 3] = x;
      p[o + 4] = top - 0.7;
      p[o + 5] = z;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }
}
