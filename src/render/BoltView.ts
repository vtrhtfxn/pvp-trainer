import * as THREE from 'three';

/**
 * A lightning bolt (the Lightning kill effect): a jagged column of thin glowing segments from
 * high up down to the target, with a fork or two, flickering out over about half a second —
 * after vanilla's LightningBoltRenderer, which draws it as stacked translucent boxes.
 */
export class BoltView {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({
    color: 0xc8d8ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  private readonly segment = new THREE.BoxGeometry(1, 1, 1);
  private life = 0;

  constructor() {
    this.group.visible = false;
  }

  strike(x: number, y: number, z: number) {
    this.group.clear();
    const branch = (sx: number, sy: number, sz: number, ey: number, width: number, wander: number, forks: number) => {
      let px = sx;
      let py = sy;
      let pz = sz;
      while (py > ey) {
        const step = Math.min(py - ey, 1.2 + Math.random() * 1.6);
        const nx = sy === py ? px : px + (Math.random() - 0.5) * wander;
        const nz = sy === py ? pz : pz + (Math.random() - 0.5) * wander;
        const ny = py - step;
        // The last segment lands exactly on the target.
        const tx = ny <= ey && forks >= 0 && width > 0.2 ? x : nx;
        const tz = ny <= ey && forks >= 0 && width > 0.2 ? z : nz;
        this.addSegment(px, py, pz, tx, Math.max(ny, ey), tz, width);
        if (forks > 0 && Math.random() < 0.18) {
          forks--;
          branch(tx, ny, tz, ny - 3 - Math.random() * 4, width * 0.55, wander * 1.4, 0);
        }
        px = tx;
        py = ny;
        pz = tz;
      }
    };
    branch(x + (Math.random() - 0.5) * 4, y + 30, z + (Math.random() - 0.5) * 4, y, 0.28, 1.6, 2);
    this.group.visible = true;
    this.life = 0.6;
  }

  private addSegment(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    const m = new THREE.Mesh(this.segment, this.material);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.scale.set(width, len, width);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx / len, dy / len, dz / len));
    this.group.add(m);
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.life -= dt;
    if (this.life <= 0) {
      this.group.visible = false;
      this.group.clear();
      return;
    }
    // Flickers twice, then fades.
    const t = this.life;
    this.material.opacity = t > 0.45 ? 0.9 : t > 0.38 ? 0.15 : t > 0.3 ? 0.85 : Math.max(0, t / 0.3) * 0.8;
  }
}
