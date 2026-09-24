import * as THREE from 'three';
import { lerp, lerpAngle } from '../core/math';
import type { Arrow } from '../game/Arrow';
import { arrowGeometry, packTexture } from './itemMesh';

/** ArrowRenderer: a pooled mesh per arrow, interpolated between ticks. */
export class ArrowView {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Mesh[] = [];
  private readonly geometry = arrowGeometry();
  private readonly material: THREE.MeshLambertMaterial;

  constructor() {
    this.material = new THREE.MeshLambertMaterial({
      map: packTexture('entity/projectiles/arrow'),
      alphaTest: 0.1,
      side: THREE.DoubleSide,
    });
  }

  update(arrows: readonly Arrow[], a: number) {
    while (this.pool.length < arrows.length) {
      const m = new THREE.Mesh(this.geometry, this.material);
      m.rotation.order = 'YXZ';
      this.pool.push(m);
      this.group.add(m);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const m = this.pool[i];
      const ar = arrows[i];
      m.visible = !!ar;
      if (!ar) continue;
      m.position.set(lerp(ar.prevPos.x, ar.pos.x, a), lerp(ar.prevPos.y, ar.pos.y, a), lerp(ar.prevPos.z, ar.pos.z, a));
      m.rotation.set(lerp(ar.prevPitch, ar.pitch, a), lerpAngle(ar.prevYaw, ar.yaw, a), 0);
    }
  }
}
