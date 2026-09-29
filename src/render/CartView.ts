import * as THREE from 'three';
import type { TntCart } from '../game/TntCart';
import { packTexture } from './itemMesh';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * TNT minecarts: a grey iron tub (MinecartModel's floor and four walls) with a TNT block sitting
 * in it, turned to the rail's axis. A lit cart flashes white like primed TNT.
 */
export class CartView {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Group[] = [];
  private readonly ironMat = new THREE.MeshLambertMaterial({ color: 0x8a8a8a });
  private readonly tntMats: THREE.MeshLambertMaterial[];
  private readonly flashMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });

  constructor() {
    const side = packTexture('block/tnt_side');
    const top = packTexture('block/tnt_top');
    const s = new THREE.MeshLambertMaterial({ map: side });
    const t = new THREE.MeshLambertMaterial({ map: top });
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z.
    this.tntMats = [s, s, t, t, s, s];
  }

  private make(): THREE.Group {
    const g = new THREE.Group();
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material | THREE.Material[]) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    // Tub: 20 × 16 px floor, 8 px walls (in blocks: 1.25 × 1 × 0.5, scaled like the vanilla model).
    box(1.0, 0.0625, 0.8, 0, 0.12, 0, this.ironMat);
    box(1.0, 0.45, 0.0625, 0, 0.35, 0.37, this.ironMat);
    box(1.0, 0.45, 0.0625, 0, 0.35, -0.37, this.ironMat);
    box(0.0625, 0.45, 0.8, 0.47, 0.35, 0, this.ironMat);
    box(0.0625, 0.45, 0.8, -0.47, 0.35, 0, this.ironMat);
    // Wheels.
    for (const [x, z] of [
      [0.35, 0.4],
      [-0.35, 0.4],
      [0.35, -0.4],
      [-0.35, -0.4],
    ])
      box(0.18, 0.18, 0.05, x, 0.09, z, this.ironMat);
    const tnt = box(0.75, 0.75, 0.75, 0, 0.52, 0, this.tntMats);
    const flash = new THREE.Mesh(new THREE.BoxGeometry(0.77, 0.77, 0.77), this.flashMat.clone());
    tnt.add(flash);
    return g;
  }

  update(carts: readonly TntCart[], a: number, timeSec: number) {
    while (this.pool.length < carts.length) {
      const g = this.make();
      this.pool.push(g);
      this.group.add(g);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const g = this.pool[i];
      const c = carts[i];
      g.visible = !!c && !c.removed;
      if (!c || c.removed) continue;
      g.position.set(lerp(c.prevPos.x, c.pos.x, a), lerp(c.prevPos.y, c.pos.y, a), lerp(c.prevPos.z, c.pos.z, a));
      g.rotation.y = c.axis === 0 ? Math.PI / 2 : 0;
      const tnt = g.children[g.children.length - 1];
      // Bed Wars TNT is a bare block: no tub, sitting on the ground.
      for (let k = 0; k < g.children.length - 1; k++) g.children[k].visible = !c.bare;
      tnt.position.y = c.bare ? 0.5 : 0.52;
      tnt.scale.setScalar(c.bare ? 1.33 : 1);
      const flash = tnt.children[0] as THREE.Mesh;
      const on = c.primed && Math.floor(timeSec * 4) % 2 === 0;
      (flash.material as THREE.MeshBasicMaterial).opacity = on ? 0.6 : 0;
      if (c.primed) tnt.scale.multiplyScalar(1 + 0.05 * Math.sin(timeSec * 20));
    }
  }
}
