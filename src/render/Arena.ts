import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { World } from '../game/World';
import { meshVoxels, Voxels, type BlockId } from './blockMesher';

export const SKY_TOP = new THREE.Color('#79a6ff');
export const SKY_HORIZON = new THREE.Color('#c4dcff');

/** Time of day and weather, as /time and /weather set them. */
export interface SkyState {
  /** 0..24000; 6000 is noon, 18000 midnight. */
  dayTime: number;
  /** 0..1 rain and thunder strength (they fade in and out). */
  rain: number;
  thunder: number;
  /** 0..1 lightning flash. */
  flash: number;
}

/** DimensionType.timeOfDay: 0 at noon, 0.5 at midnight, eased around sunrise and sunset. */
export function celestialAngle(dayTime: number): number {
  const t = dayTime / 24000 - 0.25;
  const d = t - Math.floor(t);
  const e = 0.5 - Math.cos(d * Math.PI) / 2;
  return (d * 2 + e) / 3;
}

const tmpColor = new THREE.Color();
const GLOW = new THREE.Color('#ff8a3d');

/** Builds the arena: grass floor, stone-brick walls with glowstone pillars, trees, sky and clouds. */
export class Arena {
  readonly group = new THREE.Group();
  /** The grass inside the walls; hidden when the kit brings its own diggable ground. */
  readonly floor: THREE.Group;
  private sky: THREE.Mesh;
  private skyMat: THREE.ShaderMaterial;
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  readonly clouds: THREE.Mesh;
  private cloudSpan: number;
  private readonly sunDir = new THREE.Vector3(0.35, 0.72, -0.6).normalize();
  /** 0 (midnight) … 1 (day): how lit the world is, for lights and fog. */
  daylight = 1;
  /** The colour the fog and the far background should use (the horizon). */
  readonly horizon = SKY_HORIZON.clone();

  constructor(world: World) {
    const v = new Voxels();
    const rng = new Rng(20260919);
    const H = world.half; // interior spans [-H, H)
    const R = H + 22;

    const inner = new Voxels();
    for (let x = -R; x < R; x++)
      for (let z = -R; z < R; z++) {
        if (x >= -H && x < H && z >= -H && z < H) inner.set(x, -1, z, 'grass');
        else v.set(x, -1, z, 'grass');
      }

    const wallBlock = (): BlockId => {
      const r = rng.next();
      return r < 0.18 ? 'mossy_stone_bricks' : r < 0.3 ? 'cracked_stone_bricks' : 'stone_bricks';
    };
    for (let i = -H - 1; i <= H; i++) {
      for (let y = 0; y < 3; y++) {
        v.set(i, y, -H - 1, wallBlock());
        v.set(i, y, H, wallBlock());
        v.set(-H - 1, y, i, wallBlock());
        v.set(H, y, i, wallBlock());
      }
    }
    // Pillars topped with glowstone every 8 blocks
    for (let i = -H - 1; i <= H; i += 8) {
      for (const [px, pz] of [
        [i, -H - 1],
        [i, H],
        [-H - 1, i],
        [H, i],
      ]) {
        v.set(px, 3, pz, 'stone_bricks');
        v.set(px, 4, pz, 'glowstone');
      }
    }
    for (const [cx, cz] of [
      [-H - 1, -H - 1],
      [-H - 1, H],
      [H, -H - 1],
      [H, H],
    ]) {
      v.set(cx, 3, cz, 'stone_bricks');
      v.set(cx, 4, cz, 'glowstone');
    }

    // Oak trees around the outside of the arena
    const trees: [number, number][] = [];
    for (let tries = 0; tries < 600 && trees.length < 34; tries++) {
      const x = rng.int(-R + 3, R - 4);
      const z = rng.int(-R + 3, R - 4);
      if (Math.max(Math.abs(x), Math.abs(z)) < H + 4) continue;
      if (trees.some(([a, b]) => Math.hypot(a - x, b - z) < 6)) continue;
      trees.push([x, z]);
      const h = rng.int(4, 6);
      for (let y = 0; y < h; y++) v.set(x, y, z, 'oak_log');
      const top = h;
      for (let y = top - 2; y <= top + 1; y++) {
        const r = y >= top ? 1 : 2;
        for (let dx = -r; dx <= r; dx++)
          for (let dz = -r; dz <= r; dz++) {
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            if (corner && (y === top + 1 || rng.chance(0.5))) continue;
            if (dx === 0 && dz === 0 && y < top) continue;
            v.set(x + dx, y, z + dz, 'oak_leaves');
          }
      }
    }

    this.group.add(meshVoxels(v));
    this.floor = meshVoxels(inner);
    this.group.add(this.floor);

    // Sky dome
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        top: { value: SKY_TOP.clone() },
        horizon: { value: SKY_HORIZON.clone() },
        sunDir: { value: this.sunDir.clone() },
        glow: { value: GLOW.clone() },
        glowAmt: { value: 0 },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      // Sunrise/sunset: an orange glow on the horizon toward the sun (DimensionSpecialEffects.getSunriseColor).
      fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; uniform vec3 glow; uniform float glowAmt; varying vec3 vDir;
        void main(){ vec3 dir = normalize(vDir); float h = dir.y; vec3 c = mix(horizon, top, smoothstep(0.0, 0.5, h));
        if (h < 0.0) c = mix(horizon, horizon * 0.85, smoothstep(0.0, -0.4, h));
        float s = max(dot(dir, normalize(vec3(sunDir.x, 0.0, sunDir.z))), 0.0);
        c = mix(c, glow, glowAmt * pow(s, 5.0) * (1.0 - smoothstep(-0.1, 0.4, h)));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.skyMat = skyMat;
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(500, 24, 12), skyMat);
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    // Square Minecraft-style sun
    const sc = document.createElement('canvas');
    sc.width = sc.height = 32;
    const sctx = sc.getContext('2d')!;
    const grad = sctx.createRadialGradient(16, 16, 2, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,250,220,0.9)');
    grad.addColorStop(1, 'rgba(255,240,180,0)');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 32, 32);
    sctx.fillStyle = '#fffbe6';
    sctx.fillRect(10, 10, 12, 12);
    const sunTex = new THREE.CanvasTexture(sc);
    sunTex.magFilter = THREE.NearestFilter;
    this.sun = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 70),
      new THREE.MeshBasicMaterial({
        map: sunTex,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    this.sun.renderOrder = -9;
    this.sun.frustumCulled = false;
    this.group.add(this.sun);

    // Square moon with a few darker craters, opposite the sun.
    const mc = document.createElement('canvas');
    mc.width = mc.height = 16;
    const mctx = mc.getContext('2d')!;
    mctx.fillStyle = '#e8e8f0';
    mctx.fillRect(3, 3, 10, 10);
    mctx.fillStyle = '#b9bccb';
    for (const [x, y, w] of [
      [5, 5, 2],
      [9, 7, 3],
      [6, 10, 2],
      [10, 4, 1],
    ])
      mctx.fillRect(x, y, w, w);
    const moonTex = new THREE.CanvasTexture(mc);
    moonTex.magFilter = THREE.NearestFilter;
    this.moon = new THREE.Mesh(
      new THREE.PlaneGeometry(42, 42),
      new THREE.MeshBasicMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false }),
    );
    this.moon.renderOrder = -9;
    this.moon.frustumCulled = false;
    this.group.add(this.moon);

    // Stars (LevelRenderer.drawStars): fixed points on a big sphere, visible at night.
    const srng = new Rng(10842);
    const starPos: number[] = [];
    for (let i = 0; i < 900; i++) {
      const u = srng.next() * 2 - 1;
      const a = srng.next() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      if (u < -0.1) continue;
      starPos.push(Math.cos(a) * r * 400, u * 400, Math.sin(a) * r * 400);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      sg,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }),
    );
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;
    this.stars.visible = false;
    this.group.add(this.stars);

    // Blocky cloud layer
    const cells = 40;
    const size = 12;
    this.cloudSpan = cells * size;
    const crng = new Rng(77);
    const grid: boolean[] = [];
    const noise = (x: number, z: number) =>
      Math.sin(x * 0.55 + 1.3) * Math.cos(z * 0.47 - 0.7) + Math.sin((x + z) * 0.21) * 0.8 + crng.next() * 0.9;
    for (let z = 0; z < cells; z++) for (let x = 0; x < cells; x++) grid.push(noise(x, z) > 0.75);
    const pos: number[] = [];
    const col: number[] = [];
    const quad = (a: number[], b: number[], c: number[], d: number[], light: number, alpha: number) => {
      for (const p of [a, b, c, a, c, d]) {
        pos.push(p[0], p[1], p[2]);
        col.push(light, light, light, alpha);
      }
    };
    const y0 = 0;
    const y1 = 4;
    for (let z = 0; z < cells; z++)
      for (let x = 0; x < cells; x++) {
        if (!grid[z * cells + x]) continue;
        const X0 = x * size - this.cloudSpan / 2;
        const Z0 = z * size - this.cloudSpan / 2;
        const X1 = X0 + size;
        const Z1 = Z0 + size;
        const dist = Math.hypot(X0 + size / 2, Z0 + size / 2) / (this.cloudSpan / 2);
        const alpha = 0.82 * Math.max(0, Math.min(1, (1 - dist) * 2.2));
        if (alpha <= 0.02) continue;
        quad([X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [X0, y1, Z0], 1, alpha);
        quad([X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1], 0.72, alpha);
        const has = (xx: number, zz: number) => xx >= 0 && zz >= 0 && xx < cells && zz < cells && grid[zz * cells + xx];
        if (!has(x + 1, z)) quad([X1, y0, Z1], [X1, y0, Z0], [X1, y1, Z0], [X1, y1, Z1], 0.86, alpha);
        if (!has(x - 1, z)) quad([X0, y0, Z0], [X0, y0, Z1], [X0, y1, Z1], [X0, y1, Z0], 0.86, alpha);
        if (!has(x, z + 1)) quad([X0, y0, Z1], [X1, y0, Z1], [X1, y1, Z1], [X0, y1, Z1], 0.92, alpha);
        if (!has(x, z - 1)) quad([X1, y0, Z0], [X0, y0, Z0], [X0, y1, Z0], [X1, y1, Z0], 0.92, alpha);
      }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cg.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
    this.clouds = new THREE.Mesh(
      cg,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }),
    );
    this.clouds.position.y = 62;
    this.clouds.renderOrder = -5;
    this.clouds.frustumCulled = false;
    this.group.add(this.clouds);
  }

  /** Sky colours, sun, moon, stars and cloud tint for the time of day and the weather. */
  setSky(sky: SkyState) {
    const angle = celestialAngle(sky.dayTime);
    const c = Math.cos(angle * Math.PI * 2);
    // The sun's orbit runs east–west, tilted a little so it never sits straight overhead.
    const th = angle * Math.PI * 2;
    this.sunDir.set(-Math.sin(th), Math.cos(th) * 0.85, -Math.cos(th) * 0.5).normalize();
    // Level.getSkyDarken-style brightness, with rain and thunder dimming it.
    let day = Math.max(0, Math.min(1, c * 2 + 0.5));
    day *= 1 - sky.rain * 0.3;
    day *= 1 - sky.thunder * 0.3;
    day = Math.min(1, day + sky.flash * 0.8);
    this.daylight = day;
    const u = this.skyMat.uniforms;
    const top = u.top.value as THREE.Color;
    const hor = u.horizon.value as THREE.Color;
    const shade = (base: THREE.Color, out: THREE.Color, floor: number) => {
      out.copy(base).multiplyScalar(Math.max(floor, day));
      if (sky.rain > 0) {
        const g = (out.r * 0.3 + out.g * 0.59 + out.b * 0.11) * 0.6;
        out.lerp(tmpColor.setRGB(g, g, g), sky.rain * 0.75);
      }
    };
    shade(SKY_TOP, top, 0.03);
    shade(SKY_HORIZON, hor, 0.06);
    this.horizon.copy(hor);
    (u.sunDir.value as THREE.Vector3).copy(this.sunDir);
    // Sunrise/sunset glow while the sun is near the horizon.
    const glow = Math.abs(c) <= 0.4 ? Math.max(0, 1 - Math.abs(c) / 0.4) * (1 - sky.rain) : 0;
    u.glowAmt.value = glow * 0.85;
    const sunUp = this.sunDir.y > -0.12;
    const dim = 1 - sky.rain;
    (this.sun.material as THREE.MeshBasicMaterial).opacity = dim;
    this.sun.visible = sunUp && dim > 0.02;
    (this.moon.material as THREE.MeshBasicMaterial).opacity = dim;
    this.moon.visible = this.sunDir.y < 0.12 && dim > 0.02;
    const starA = Math.max(0, Math.min(1, 1 - (c * 2 + 0.25))) * 0.75 * dim;
    (this.stars.material as THREE.PointsMaterial).opacity = starA;
    this.stars.visible = starA > 0.01;
    const cloud = this.clouds.material as THREE.MeshBasicMaterial;
    const cl = Math.max(0.12, day) * (1 - sky.rain * 0.35);
    cloud.color.setRGB(cl, cl, cl * (1 - 0.04 * (1 - day)));
  }

  update(time: number, camera: THREE.Camera) {
    this.sky.position.copy(camera.position);
    this.sun.position.copy(camera.position).addScaledVector(this.sunDir, 420);
    this.sun.lookAt(camera.position);
    this.moon.position.copy(camera.position).addScaledVector(this.sunDir, -420);
    this.moon.lookAt(camera.position);
    this.stars.position.copy(camera.position);
    // The stars turn with the sky.
    this.stars.rotation.z = Math.atan2(this.sunDir.x, this.sunDir.y);
    // Slow ping-pong drift (the layer is finite, so it never wraps or pops).
    this.clouds.position.x = Math.sin(time * 0.004) * this.cloudSpan * 0.16;
  }
}
