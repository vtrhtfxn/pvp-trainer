import * as THREE from 'three';
import { lerp } from '../core/math';
import type { Fighter } from '../game/Fighter';
import { packTexture } from './itemMesh';
import { stripFrames } from './pack';

/** block/fire_0.png.mcmeta: 32 frames (a resource pack's may differ), played from the middle, one per tick. */
const FRAMES_DEFAULT = 32;

/**
 * EntityRenderDispatcher.renderFlame: burning entities are wrapped in camera-facing sheets of
 * the animated fire texture, 1.4× their width, rising to the top of the hitbox.
 */
export class FireView {
  readonly group = new THREE.Group();
  private readonly tex: THREE.Texture | null;
  private readonly sheets: THREE.Mesh[] = [];
  private readonly frames = stripFrames('block/fire_0', FRAMES_DEFAULT);

  constructor() {
    const base = packTexture('block/fire_0');
    this.tex = base ? base.clone() : null;
    if (this.tex) {
      this.tex.repeat.set(1, 1 / this.frames);
      this.tex.needsUpdate = true;
    }
    const mat = new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, alphaTest: 0.05, side: THREE.DoubleSide, depthWrite: false, fog: false });
    const geo = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    // Three layers, each a bit lower, narrower and further back, like the vanilla loop.
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = 4;
      this.sheets.push(m);
      this.group.add(m);
    }
    this.group.visible = false;
  }

  update(f: Fighter, a: number, camera: THREE.Camera, time: number, visible: boolean) {
    this.group.visible = visible && f.onFire && !f.dead;
    if (!this.group.visible) return;
    if (this.tex) {
      const n = this.frames;
      const frame = (Math.floor(time * 20) + Math.floor(n / 2)) % n;
      this.tex.offset.y = 1 - (frame + 1) / n;
    }
    this.group.position.set(lerp(f.prevPos.x, f.pos.x, a), lerp(f.prevPos.y, f.pos.y, a), lerp(f.prevPos.z, f.pos.z, a));
    const dx = camera.position.x - this.group.position.x;
    const dz = camera.position.z - this.group.position.z;
    this.group.rotation.y = Math.atan2(dx, dz);
    const w = 0.6 * 1.4;
    const h = f.height() + 0.3;
    for (let i = 0; i < 3; i++) {
      const s = this.sheets[i];
      s.scale.set(w * (1 - i * 0.12), h * (1 - i * 0.15), 1);
      s.position.set(0, i * 0.12, -0.1 * i - 0.15);
    }
  }
}
