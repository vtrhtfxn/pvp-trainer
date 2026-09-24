import * as THREE from 'three';
import { particleTexture } from './textures';

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  g: number;
  b: number;
  size: number;
  life: number;
  maxLife: number;
  gravity: number;
  drag: number;
  grow: number;
}

/** Camera-facing pixel particles (crit stars, sharpness sparks, food crumbs, death poof). */
class ParticleLayer {
  readonly points: THREE.Points;
  private readonly list: P[] = [];
  private readonly pos: Float32Array;
  private readonly col: Float32Array;
  private readonly size: Float32Array;
  private readonly material: THREE.ShaderMaterial;

  constructor(
    private readonly capacity: number,
    kind: 'star' | 'square' | 'smoke',
  ) {
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcolor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('psize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: particleTexture(kind) }, scale: { value: 800 } },
      vertexShader: `attribute vec4 pcolor; attribute float psize; varying vec4 vColor; uniform float scale;
        void main(){ vColor = pcolor; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = psize * scale / max(0.1, -mv.z); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec4 vColor;
        void main(){ vec4 t = texture2D(map, gl_PointCoord); float a = t.a * vColor.a; if (a < 0.1) discard;
        gl_FragColor = vec4(t.rgb * vColor.rgb, a);
        #include <colorspace_fragment>
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 3;
  }

  setScale(s: number) {
    this.material.uniforms.scale.value = s;
  }

  spawn(p: P) {
    // Full: recycle a random old particle instead of shifting the whole array.
    if (this.list.length >= this.capacity) this.list[(Math.random() * this.list.length) | 0] = p;
    else this.list.push(p);
  }

  update(dt: number) {
    const steps = dt * 20;
    let n = 0;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      p.life -= dt;
      if (p.life <= 0) {
        // Swap-remove: O(1), and draw order does not matter for additive-looking sprites.
        const last = this.list.pop()!;
        if (i < this.list.length) this.list[i] = last;
        continue;
      }
      const d = Math.pow(p.drag, steps);
      p.vy -= p.gravity * steps;
      p.vx *= d;
      p.vy *= d;
      p.vz *= d;
      p.x += p.vx * steps;
      p.y += p.vy * steps;
      p.z += p.vz * steps;
      if (p.y < 0.02) {
        p.y = 0.02;
        p.vy = 0;
        p.vx *= 0.7;
        p.vz *= 0.7;
      }
    }
    for (const p of this.list) {
      const t = p.life / p.maxLife;
      this.pos[n * 3] = p.x;
      this.pos[n * 3 + 1] = p.y;
      this.pos[n * 3 + 2] = p.z;
      this.col[n * 4] = p.r;
      this.col[n * 4 + 1] = p.g;
      this.col[n * 4 + 2] = p.b;
      this.col[n * 4 + 3] = Math.min(1, t * 3);
      this.size[n] = p.size * (p.grow ? 1 + (1 - t) * p.grow : Math.max(0.35, t));
      n++;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.pcolor.needsUpdate = true;
    g.attributes.psize.needsUpdate = true;
  }
}

export class Particles {
  readonly group = new THREE.Group();
  private stars = new ParticleLayer(600, 'star');
  private squares = new ParticleLayer(400, 'square');
  private smoke = new ParticleLayer(200, 'smoke');

  constructor() {
    this.group.add(this.stars.points, this.squares.points, this.smoke.points);
  }

  setViewport(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.stars.setScale(s);
    this.squares.setScale(s);
    this.smoke.setScale(s);
  }

  /** Minecraft's tracking emitter: particles burst out of the target's hitbox. */
  crit(x: number, y: number, z: number, magic: boolean, count = 26) {
    for (let i = 0; i < count; i++) {
      let dx = 0;
      let dy = 0;
      let dz = 0;
      do {
        dx = Math.random() * 2 - 1;
        dy = Math.random() * 2 - 1;
        dz = Math.random() * 2 - 1;
      } while (dx * dx + dy * dy + dz * dz > 1);
      const shade = 0.7 + Math.random() * 0.3;
      const life = 0.3 + Math.random() * 0.35;
      this.stars.spawn({
        x: x + dx * 0.15,
        y: y + 0.9 + dy * 0.45,
        z: z + dz * 0.15,
        vx: dx * 0.22,
        vy: dy * 0.22 + 0.08,
        vz: dz * 0.22,
        r: magic ? 0.35 * shade : shade,
        g: magic ? 0.75 * shade : shade * 0.96,
        b: magic ? 1 : shade * 0.9,
        size: magic ? 0.09 : 0.12,
        life,
        maxLife: life,
        gravity: 0.012,
        drag: 0.72,
        grow: 0,
      });
    }
  }

  crumbs(x: number, y: number, z: number, dirX: number, dirZ: number) {
    const colors = [
      [1, 0.85, 0.25],
      [0.95, 0.7, 0.15],
      [1, 0.95, 0.55],
      [0.8, 0.55, 0.1],
    ];
    for (let i = 0; i < 5; i++) {
      const c = colors[(Math.random() * colors.length) | 0];
      const life = 0.45 + Math.random() * 0.4;
      const side = (Math.random() - 0.5) * 0.3;
      this.squares.spawn({
        x: x - dirZ * side,
        y: y - Math.random() * 0.6,
        z: z + dirX * side,
        vx: dirX * 0.03 + (Math.random() - 0.5) * 0.05,
        vy: 0.1 + Math.random() * 0.1,
        vz: dirZ * 0.03 + (Math.random() - 0.5) * 0.05,
        r: c[0],
        g: c[1],
        b: c[2],
        size: 0.045,
        life,
        maxLife: life,
        gravity: 0.03,
        drag: 0.96,
        grow: 0,
      });
    }
  }

  poof(x: number, y: number, z: number) {
    for (let i = 0; i < 22; i++) {
      const life = 0.6 + Math.random() * 0.5;
      const s = 0.6 + Math.random() * 0.35;
      this.smoke.spawn({
        x: x + (Math.random() - 0.5) * 0.7,
        y: y + Math.random() * 1.6,
        z: z + (Math.random() - 0.5) * 0.7,
        vx: (Math.random() - 0.5) * 0.06,
        vy: 0.02 + Math.random() * 0.04,
        vz: (Math.random() - 0.5) * 0.06,
        r: s,
        g: s,
        b: s,
        size: 0.2,
        life,
        maxLife: life,
        gravity: -0.001,
        drag: 0.93,
        grow: 1.2,
      });
    }
  }

  /** Splash potion impact (level events 2002/2007): a ring of the potion's colour. */
  splash(x: number, y: number, z: number, color: number, xp: boolean) {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let i = 0; i < 70; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.05 + Math.random() * 0.15;
      const shade = 0.75 + Math.random() * 0.25;
      const life = 0.5 + Math.random() * 0.6;
      this.stars.spawn({
        x,
        y: y + 0.1,
        z,
        vx: Math.cos(ang) * sp,
        vy: 0.02 + Math.random() * 0.12,
        vz: Math.sin(ang) * sp,
        r: r * shade,
        g: g * shade,
        b: b * shade,
        size: xp ? 0.07 : 0.1,
        life,
        maxLife: life,
        gravity: 0.004,
        drag: 0.9,
        grow: 0,
      });
    }
  }

  /** Totem of Undying: a fountain of green and yellow sparks around the player. */
  totem(x: number, y: number, z: number) {
    for (let i = 0; i < 90; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = 0.08 + Math.random() * 0.2;
      const yellow = Math.random() < 0.4;
      const life = 0.8 + Math.random() * 1.2;
      this.squares.spawn({
        x: x + Math.cos(ang) * 0.3,
        y: y + 0.4 + Math.random() * 1.2,
        z: z + Math.sin(ang) * 0.3,
        vx: Math.cos(ang) * sp,
        vy: 0.15 + Math.random() * 0.3,
        vz: Math.sin(ang) * sp,
        r: yellow ? 1 : 0.35 + Math.random() * 0.2,
        g: yellow ? 0.9 : 0.85 + Math.random() * 0.15,
        b: yellow ? 0.2 : 0.2,
        size: 0.06,
        life,
        maxLife: life,
        gravity: 0.01,
        drag: 0.9,
        grow: 0,
      });
    }
  }

  /** Ambient potion swirl (LivingEntity.tickEffects): one faint particle in the effect's colour. */
  swirl(x: number, y: number, z: number, color: number) {
    const life = 0.8 + Math.random() * 0.4;
    this.squares.spawn({
      x: x + (Math.random() - 0.5) * 0.6,
      y: y + Math.random() * 1.8,
      z: z + (Math.random() - 0.5) * 0.6,
      vx: 0,
      vy: 0.02,
      vz: 0,
      r: ((color >> 16) & 255) / 255,
      g: ((color >> 8) & 255) / 255,
      b: (color & 255) / 255,
      size: 0.05,
      life,
      maxLife: life,
      gravity: -0.0005,
      drag: 0.95,
      grow: 0,
    });
  }

  clear() {
    for (const l of [this.stars, this.squares, this.smoke]) l.update(1000);
  }

  update(dt: number) {
    this.stars.update(dt);
    this.squares.update(dt);
    this.smoke.update(dt);
  }
}
