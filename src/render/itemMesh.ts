import * as THREE from 'three';
import { packImage, packPixels } from './pack';

export interface ItemModel {
  geometry: THREE.BufferGeometry;
  texture: THREE.Texture;
}

function nearest(t: THREE.Texture): THREE.Texture {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

const textures = new Map<string, THREE.Texture>();

/** A three.js texture for a pack image (nearest-filtered, shared). */
export function packTexture(name: string): THREE.Texture | null {
  let t = textures.get(name);
  if (t) return t;
  const img = packImage(name);
  if (!img) return null;
  t = nearest(new THREE.Texture(img));
  textures.set(name, t);
  return t;
}

const sprites = new Map<string, ItemModel>();

/**
 * ItemModelGenerator: a 16×16 sprite becomes a 1-pixel-thick slab — a front and back face with
 * the whole texture, plus a side face for every opaque pixel edge that borders transparency.
 * Output is in item-model space (centred on the origin, 1 unit = 16 px, facing +Z).
 */
export function spriteModel(name: string): ItemModel | null {
  const cached = sprites.get(name);
  if (cached) return cached;
  const px = packPixels(name);
  const texture = packTexture(name);
  if (!px || !texture) return null;
  const W = px.width;
  const H = px.height;
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && px.data[(y * W + x) * 4 + 3] > 16;

  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const z0 = -0.5 / 16;
  const z1 = 0.5 / 16;
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], ua: number[], ub: number[], uc: number[], ud: number[]) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let i = 0; i < 6; i++) nrm.push(...n);
    uv.push(...ua, ...ub, ...uc, ...ua, ...uc, ...ud);
  };
  // Pixel (x, y) spans X [x/W - .5, (x+1)/W - .5] and Y [.5 - (y+1)/H, .5 - y/H].
  const X = (x: number) => x / W - 0.5;
  const Y = (y: number) => 0.5 - y / H;
  quad([-0.5, -0.5, z1], [0.5, -0.5, z1], [0.5, 0.5, z1], [-0.5, 0.5, z1], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
  quad([0.5, -0.5, z0], [-0.5, -0.5, z0], [-0.5, 0.5, z0], [0.5, 0.5, z0], [0, 0, -1], [1, 0], [0, 0], [0, 1], [1, 1]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!opaque(x, y)) continue;
      // Sample the middle of this pixel for its edge faces.
      const u = (x + 0.5) / W;
      const v = 1 - (y + 0.5) / H;
      const t = [u, v];
      const x0 = X(x);
      const x1 = X(x + 1);
      const yT = Y(y);
      const yB = Y(y + 1);
      if (!opaque(x, y - 1)) quad([x0, yT, z1], [x1, yT, z1], [x1, yT, z0], [x0, yT, z0], [0, 1, 0], t, t, t, t);
      if (!opaque(x, y + 1)) quad([x0, yB, z0], [x1, yB, z0], [x1, yB, z1], [x0, yB, z1], [0, -1, 0], t, t, t, t);
      if (!opaque(x - 1, y)) quad([x0, yB, z0], [x0, yB, z1], [x0, yT, z1], [x0, yT, z0], [-1, 0, 0], t, t, t, t);
      if (!opaque(x + 1, y)) quad([x1, yB, z1], [x1, yB, z0], [x1, yT, z0], [x1, yT, z1], [1, 0, 0], t, t, t, t);
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingSphere();
  const model = { geometry, texture };
  sprites.set(name, model);
  return model;
}

// ------------------------------------------------------------------ Minecraft model boxes

export type Vec3 = [number, number, number];

/**
 * Appends a Minecraft ModelPart cube (addBox with texOffs and CubeDeformation) in Minecraft model
 * coordinates — pixels, Y down, -Z = the model's front — using the standard box UV layout:
 * top/bottom along the first row, then right, front, left, back.
 */
export function mcBox(
  out: { pos: number[]; nrm: number[]; uv: number[] },
  origin: Vec3,
  size: Vec3,
  texOffs: [number, number],
  texSize: [number, number],
  inflate = 0,
  mirror = false,
  map: (p: Vec3) => Vec3 = (p) => p,
) {
  const [w, h, d] = size;
  const x0 = origin[0] - inflate;
  const y0 = origin[1] - inflate;
  const z0 = origin[2] - inflate;
  const x1 = origin[0] + w + inflate;
  const y1 = origin[1] + h + inflate;
  const z1 = origin[2] + d + inflate;
  const [u, v] = texOffs;
  const [tw, th] = texSize;
  const U = (px: number) => px / tw;
  const V = (py: number) => 1 - py / th;

  // Each face: corners as seen from outside, top-left → top-right → bottom-right → bottom-left,
  // and the texture rectangle (u0, v0, u1, v1) drawn onto it in the same orientation.
  type Face = { c: Vec3[]; r: [number, number, number, number]; n: Vec3 };
  const faces: Face[] = [
    // up (-Y): texture row v..v+d, back edge at the top
    { c: [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], r: [u + d, v, u + d + w, v + d], n: [0, -1, 0] },
    // down (+Y)
    { c: [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], r: [u + d + w, v, u + d + w + w, v + d], n: [0, 1, 0] },
    // right side of the model (-X), front edge on the right
    { c: [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], r: [u, v + d, u + d, v + d + h], n: [-1, 0, 0] },
    // front (-Z)
    { c: [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], r: [u + d, v + d, u + d + w, v + d + h], n: [0, 0, -1] },
    // left side (+X)
    { c: [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], r: [u + d + w, v + d, u + d + w + d, v + d + h], n: [1, 0, 0] },
    // back (+Z)
    { c: [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], r: [u + d + w + d, v + d, u + d + w + d + w, v + d + h], n: [0, 0, 1] },
  ];
  if (mirror) {
    // ModelPart mirror swaps the box's X extents: the side textures trade places and every face
    // is flipped horizontally.
    const r = faces[2].r;
    faces[2].r = faces[4].r;
    faces[4].r = r;
  }
  for (const f of faces) {
    let [u0, v0, u1, v1] = f.r;
    if (mirror) [u0, u1] = [u1, u0];
    const t: [number, number][] = [
      [U(u0), V(v0)],
      [U(u1), V(v0)],
      [U(u1), V(v1)],
      [U(u0), V(v1)],
    ];
    const c = f.c.map(map);
    // Winding: keep the triangle facing the mapped outward normal.
    const n = map([f.n[0], f.n[1], f.n[2]]);
    const o = map([0, 0, 0]);
    const nx = n[0] - o[0];
    const ny = n[1] - o[1];
    const nz = n[2] - o[2];
    const e1 = [c[1][0] - c[0][0], c[1][1] - c[0][1], c[1][2] - c[0][2]];
    const e2 = [c[2][0] - c[0][0], c[2][1] - c[0][1], c[2][2] - c[0][2]];
    const cx = e1[1] * e2[2] - e1[2] * e2[1];
    const cy = e1[2] * e2[0] - e1[0] * e2[2];
    const cz = e1[0] * e2[1] - e1[1] * e2[0];
    const flip = cx * nx + cy * ny + cz * nz < 0;
    const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const i of order) {
      out.pos.push(...c[i]);
      out.nrm.push(nx / len, ny / len, nz / len);
      out.uv.push(...t[i]);
    }
  }
}

export function toGeometry(b: { pos: number[]; nrm: number[]; uv: number[] }): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.computeBoundingSphere();
  return g;
}

/**
 * The shield (ShieldModel: plate 12×22×1 at texOffs 0,0 and handle 2×6×6 at 26,0), placed the
 * way BlockEntityWithoutLevelRenderer draws it inside an item model: translate(-.5,-.5,-.5),
 * scale(1,-1,-1), then the parts in pixels.
 */
export function shieldModel(): ItemModel | null {
  const texture = packTexture('entity/shield_base_nopattern');
  if (!texture) return null;
  const b = { pos: [] as number[], nrm: [] as number[], uv: [] as number[] };
  const map = (p: Vec3): Vec3 => [p[0] / 16 - 0.5, -p[1] / 16 - 0.5, -p[2] / 16 - 0.5];
  mcBox(b, [-6, -11, -2], [12, 22, 1], [0, 0], [64, 64], 0, false, map);
  mcBox(b, [-1, -3, -1], [2, 6, 6], [26, 0], [64, 64], 0, false, map);
  return { geometry: toGeometry(b), texture };
}

/** ArrowRenderer's model: two crossed 16×5 planes plus the fletching cross, in pixels. */
export function arrowGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const s = 0.05625; // vanilla scales the arrow by 0.05625 = 0.9 / 16
  const q = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, ta: number[], tb: number[], tc: number[], td: number[], n: Vec3) => {
    for (const [p, t] of [
      [a, ta],
      [b, tb],
      [c, tc],
      [a, ta],
      [c, tc],
      [d, td],
    ] as [Vec3, number[]][]) {
      pos.push(p[0] * s, p[1] * s, p[2] * s);
      uv.push(t[0], t[1]);
      nrm.push(...n);
    }
  };
  const V = (py: number) => 1 - py / 32;
  // Shaft planes along -Z (forward), texture u 0..16 px, v 0..5 px.
  for (const rot of [0, Math.PI / 2]) {
    const c = Math.cos(rot);
    const si = Math.sin(rot);
    const P = (z: number, off: number): Vec3 => [off * c, off * si, z];
    q(P(8, -2), P(-8, -2), P(-8, 2), P(8, 2), [0, V(5)], [0.5, V(5)], [0.5, V(0)], [0, V(0)], [si, -c, 0]);
  }
  // Fletching cross at the back (+Z end), texture u 0..5, v 5..10.
  q([-2, -2, 7], [2, -2, 7], [2, 2, 7], [-2, 2, 7], [0, V(10)], [5 / 32, V(10)], [5 / 32, V(5)], [0, V(5)], [0, 0, 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}
