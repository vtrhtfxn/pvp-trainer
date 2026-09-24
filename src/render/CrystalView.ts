import * as THREE from 'three';
import type { EndCrystal } from '../game/EndCrystal';
import type { WorldEvent } from '../game/World';
import { mcBox, packTexture, toGeometry } from './itemMesh';

const DEG = Math.PI / 180;
/** EndCrystalModel spins its glass about an axis tilted 60° (sin 45° in X and Z). */
const TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.SQRT1_2, 0, Math.SQRT1_2), 60 * DEG);

function cube(u: number): THREE.BufferGeometry {
  const b = { pos: [] as number[], nrm: [] as number[], uv: [] as number[] };
  // 8-px box centred on the origin, in blocks (the renderer scales the model ×2: 8 px → 1 block).
  mcBox(b, [-4, -4, -4], [8, 8, 8], [u, 0], [64, 32], 0, false, (p) => [p[0] / 8, -p[1] / 8, -p[2] / 8]);
  return toGeometry(b);
}

/** EndCrystalRenderer.getY: the slow bob, 0..0.8. */
function bob(age: number): number {
  const f = Math.sin(age * 0.2) / 2 + 0.5;
  return (f * f + f) * 0.4;
}

/**
 * End crystals (EndCrystalRenderer without the bedrock base): an outer glass cube, an inner one at
 * 87.5 %, and the core at 76.6 %, each spinning 3°/tick about the tilted axis, bobbing about
 * a block above the obsidian.
 */
export class CrystalView {
  readonly group = new THREE.Group();
  private readonly pool: THREE.Group[] = [];
  private readonly glassGeo = cube(0);
  private readonly coreGeo = cube(32);
  private readonly glassMat: THREE.MeshBasicMaterial;
  private readonly coreMat: THREE.MeshBasicMaterial;

  constructor() {
    const tex = packTexture('entity/end_crystal/end_crystal');
    this.glassMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    this.coreMat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.1 });
  }

  private make(): THREE.Group {
    const root = new THREE.Group();
    const outer = new THREE.Mesh(this.glassGeo, this.glassMat);
    const inner = new THREE.Mesh(this.glassGeo, this.glassMat);
    inner.scale.setScalar(0.875);
    const core = new THREE.Mesh(this.coreGeo, this.coreMat);
    core.scale.setScalar(0.765625 / 0.875);
    outer.renderOrder = inner.renderOrder = 5;
    inner.add(core);
    outer.add(inner);
    root.add(outer);
    return root;
  }

  update(crystals: readonly EndCrystal[], a: number) {
    while (this.pool.length < crystals.length) {
      const g = this.make();
      this.pool.push(g);
      this.group.add(g);
    }
    const q = new THREE.Quaternion();
    for (let i = 0; i < this.pool.length; i++) {
      const g = this.pool[i];
      const c = crystals[i];
      g.visible = !!c && !c.removed;
      if (!c || c.removed) continue;
      const age = c.age + a;
      g.position.set(c.x, c.y + 0.75 + bob(age) * 0.5, c.z);
      const outer = g.children[0];
      const inner = outer.children[0];
      const core = inner.children[0];
      const spin = q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), age * 3 * DEG);
      outer.quaternion.copy(spin).multiply(TILT);
      inner.quaternion.copy(TILT).multiply(spin);
      core.quaternion.copy(TILT).multiply(spin);
    }
  }
}

interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  frames: THREE.Texture[];
}

/**
 * Explosions (HugeExplosionSeedParticle): for 8 ticks it throws 6 explosion puffs a tick at
 * random points up to 4 blocks away; each puff plays the 16-frame explosion sprite over 6–9 ticks.
 */
export class ExplosionView {
  readonly group = new THREE.Group();
  private readonly frames: THREE.Texture[] = [];
  private readonly puffs: Puff[] = [];
  private readonly free: THREE.Sprite[] = [];
  private emitters: { x: number; y: number; z: number; ticks: number }[] = [];
  private acc = 0;

  private readonly sweepFrames: THREE.Texture[] = [];
  private readonly gustFrames: THREE.Texture[] = [];

  constructor() {
    for (let i = 0; i < 16; i++) {
      const t = packTexture(`particle/explosion_${i}`);
      if (t) this.frames.push(t);
    }
    for (let i = 0; i < 8; i++) {
      const t = packTexture(`particle/sweep_${i}`);
      if (t) this.sweepFrames.push(t);
    }
    for (let i = 0; i < 12; i++) {
      const t = packTexture(`particle/gust_${i}`);
      if (t) this.gustFrames.push(t);
    }
  }

  /** GustParticle (wind charges, Wind Burst): white 12-frame gusts around the burst. */
  gust(x: number, y: number, z: number, power: number) {
    if (!this.gustFrames.length) return;
    const n = power > 2 ? 6 : 3;
    for (let i = 0; i < n; i++) {
      const s = this.free.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
      (s.material as THREE.SpriteMaterial).color.setRGB(1, 1, 1);
      const r = i === 0 ? 0 : power * 0.5;
      s.position.set(x + (Math.random() - 0.5) * r, y + 0.3 + (Math.random() - 0.5) * r, z + (Math.random() - 0.5) * r);
      s.scale.setScalar(1.5 + Math.random() * (power > 2 ? 2 : 1));
      s.renderOrder = 6;
      this.group.add(s);
      this.puffs.push({ sprite: s, age: 0, life: 12, frames: this.gustFrames });
    }
  }

  /** SweepAttackParticle: one grey 8-frame arc, 4 ticks, where the sweep landed. */
  sweep(x: number, y: number, z: number) {
    if (!this.sweepFrames.length) return;
    const s = this.free.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
    const shade = 0.4 + Math.random() * 0.6;
    (s.material as THREE.SpriteMaterial).color.setRGB(shade, shade, shade);
    s.position.set(x, y, z);
    s.scale.setScalar(2);
    s.renderOrder = 6;
    this.group.add(s);
    this.puffs.push({ sprite: s, age: 0, life: 4, frames: this.sweepFrames });
  }

  onEvent(e: WorldEvent) {
    if (e.type === 'explosion') this.emitters.push({ x: e.x, y: e.y, z: e.z, ticks: 8 });
  }

  private spawn(x: number, y: number, z: number) {
    if (!this.frames.length) return;
    const s = this.free.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: false }));
    const shade = 0.6 + Math.random() * 0.4;
    (s.material as THREE.SpriteMaterial).color.setRGB(shade, shade, shade);
    s.position.set(x, y, z);
    s.scale.setScalar(2 * (1 - Math.random() * 0.5) * 2);
    s.renderOrder = 6;
    this.group.add(s);
    this.puffs.push({ sprite: s, age: 0, life: 6 + Math.floor(Math.random() * 4), frames: this.frames });
  }

  update(dt: number) {
    this.acc += dt * 20;
    while (this.acc >= 1) {
      this.acc -= 1;
      for (const em of this.emitters) {
        for (let i = 0; i < 6; i++) {
          this.spawn(em.x + (Math.random() - Math.random()) * 4, em.y + (Math.random() - Math.random()) * 4, em.z + (Math.random() - Math.random()) * 4);
        }
        em.ticks--;
      }
      this.emitters = this.emitters.filter((e) => e.ticks > 0);
      for (const p of this.puffs) p.age++;
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      if (p.age >= p.life) {
        this.group.remove(p.sprite);
        this.free.push(p.sprite);
        this.puffs.splice(i, 1);
        continue;
      }
      const n = p.frames.length;
      const f = Math.min(n - 1, Math.floor(((p.age + this.acc) / p.life) * n));
      (p.sprite.material as THREE.SpriteMaterial).map = p.frames[f] ?? null;
      (p.sprite.material as THREE.SpriteMaterial).needsUpdate = true;
    }
  }
}
