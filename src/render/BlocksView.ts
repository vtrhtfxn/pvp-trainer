import * as THREE from 'three';
import { B, BLOCK_NAMES, isFluid, isSolid, type Blocks } from '../game/Blocks';
import type { Fighter } from '../game/Fighter';
import { packTexture } from './itemMesh';
import { blockTexture } from './textures';
import { packImage } from './pack';

/** Minecraft's directional face shading: up 1, down 0.5, east/west 0.6, north/south 0.8. */
const FACES: { n: [number, number, number]; shade: number; c: [number, number, number][] }[] = [
  { n: [0, 1, 0], shade: 1.0, c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], shade: 0.5, c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], shade: 0.6, c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], shade: 0.6, c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 0, 1], shade: 0.8, c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], shade: 0.8, c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

interface Buf {
  pos: number[];
  uv: number[];
  col: number[];
  idx: number[];
}
const buf = (): Buf => ({ pos: [], uv: [], col: [], idx: [] });

function toGeo(b: Buf): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

/** Linear-space light for a face shade (Minecraft shades in sRGB). */
const lin = (s: number) => Math.pow(s, 2.2);

/** Water is a grey texture tinted with the biome's water colour (plains: #3F76E4). */
function waterTexture(): THREE.Texture {
  const img = packImage('block/water_still');
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const ctx = c.getContext('2d')!;
  if (img) ctx.drawImage(img, 0, 0, 16, 16);
  else ctx.fillRect(0, 0, 16, 16);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = '#3f76e4';
  ctx.fillRect(0, 0, 16, 16);
  ctx.globalCompositeOperation = 'destination-in';
  if (img) ctx.drawImage(img, 0, 0, 16, 16);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** block/lava_still.png.mcmeta: 20 frames, 2 ticks each, played forward then back. */
const LAVA_FRAMES = 20;

/**
 * Everything players have placed: solid blocks (face-culled, shaded), cobwebs (crossed
 * sprites), water and lava (surfaces at their level's height). Rebuilt only when the block
 * grid changes. Also draws each fighter's mining cracks and the crosshair's block outline.
 */
export class BlocksView {
  readonly group = new THREE.Group();
  private version = -1;
  private readonly meshes: THREE.Mesh[] = [];
  private readonly solidMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly webMat: THREE.MeshBasicMaterial;
  private readonly waterMat: THREE.MeshBasicMaterial;
  private readonly lavaMat: THREE.MeshBasicMaterial;
  private readonly lavaTex: THREE.Texture | null;
  private readonly cracks: THREE.Mesh[] = [];
  private readonly crackMats: THREE.MeshBasicMaterial[] = [];
  readonly outline: THREE.LineSegments;

  constructor() {
    this.webMat = new THREE.MeshBasicMaterial({ map: packTexture('block/cobweb'), alphaTest: 0.1, side: THREE.DoubleSide, vertexColors: true });
    this.waterMat = new THREE.MeshBasicMaterial({ map: waterTexture(), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, vertexColors: true });
    const base = packTexture('block/lava_still');
    this.lavaTex = base ? base.clone() : null;
    if (this.lavaTex) {
      this.lavaTex.repeat.set(1, 1 / LAVA_FRAMES);
      this.lavaTex.needsUpdate = true;
    }
    this.lavaMat = new THREE.MeshBasicMaterial({ map: this.lavaTex, side: THREE.DoubleSide });
    for (let i = 0; i < 10; i++) {
      this.crackMats.push(
        new THREE.MeshBasicMaterial({ map: packTexture(`block/destroy_stage_${i}`), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }),
      );
    }
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004));
    this.outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45 }));
    this.outline.visible = false;
    this.group.add(this.outline);
  }

  private solidMat(name: string): THREE.MeshBasicMaterial {
    let m = this.solidMats.get(name);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: blockTexture(name), vertexColors: true });
      this.solidMats.set(name, m);
    }
    return m;
  }

  private rebuild(blocks: Blocks) {
    for (const m of this.meshes) {
      m.geometry.dispose();
      this.group.remove(m);
    }
    this.meshes.length = 0;
    if (!blocks.count) return;
    const solids = new Map<string, Buf>();
    const web = buf();
    const water = buf();
    const lava = buf();
    const h = blocks.half;
    for (let y = 0; y < blocks.height; y++)
      for (let z = -h; z < h; z++)
        for (let x = -h; x < h; x++) {
          const id = blocks.get(x, y, z);
          if (id === B.AIR) continue;
          if (isSolid(id)) {
            const name = BLOCK_NAMES[id]!;
            let b = solids.get(name);
            if (!b) solids.set(name, (b = buf()));
            for (const f of FACES) {
              if (isSolid(blocks.get(x + f.n[0], y + f.n[1], z + f.n[2]))) continue;
              this.quad(b, x, y, z, f.c, f.shade, 1);
            }
          } else if (id === B.COBWEB) {
            this.cross(web, x, y, z);
          } else if (isFluid(id)) {
            this.fluid(id === B.WATER ? water : lava, blocks, x, y, z, id);
          }
        }
    const add = (b: Buf, mat: THREE.Material, order = 0) => {
      if (!b.idx.length) return;
      const m = new THREE.Mesh(toGeo(b), mat);
      m.renderOrder = order;
      m.matrixAutoUpdate = false;
      this.meshes.push(m);
      this.group.add(m);
    };
    for (const [name, b] of solids) add(b, this.solidMat(name));
    add(web, this.webMat);
    add(lava, this.lavaMat);
    add(water, this.waterMat, 2);
  }

  private quad(b: Buf, x: number, y: number, z: number, c: [number, number, number][], shade: number, top: number) {
    const base = b.pos.length / 3;
    const l = lin(shade);
    for (let i = 0; i < 4; i++) {
      const [cx, cy, cz] = c[i];
      b.pos.push(x + cx, y + cy * top, z + cz);
      b.uv.push(UV[i][0], cy === 1 && top < 1 && c[0][1] !== c[2][1] ? top : UV[i][1]);
      b.col.push(l, l, l);
    }
    b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  private cross(b: Buf, x: number, y: number, z: number) {
    const planes: [number, number, number][][] = [
      [
        [0.15, 0, 0.15],
        [0.85, 0, 0.85],
        [0.85, 1, 0.85],
        [0.15, 1, 0.15],
      ],
      [
        [0.85, 0, 0.15],
        [0.15, 0, 0.85],
        [0.15, 1, 0.85],
        [0.85, 1, 0.15],
      ],
    ];
    for (const p of planes) this.quad(b, x, y, z, p, 1, 1);
  }

  /** A fluid cell: its surface at the level's height, sides wherever the neighbour is open. */
  private fluid(b: Buf, blocks: Blocks, x: number, y: number, z: number, id: number) {
    const top = blocks.fluidHeight(x, y, z);
    for (const f of FACES) {
      const n = blocks.get(x + f.n[0], y + f.n[1], z + f.n[2]);
      if (n === id) {
        // Neighbouring fluid: only show the side where our surface stands above theirs.
        if (f.n[1] !== 0 || blocks.fluidHeight(x + f.n[0], y, z + f.n[2]) >= top) continue;
      } else if (isSolid(n)) continue;
      if (f.n[1] > 0 && top >= 1 && blocks.get(x, y + 1, z) === id) continue;
      this.quad(b, x, y, z, f.c, f.shade, top);
    }
  }

  update(blocks: Blocks, fighters: readonly Fighter[], player: Fighter, showOutline: boolean, time: number) {
    if (blocks.version !== this.version) {
      this.version = blocks.version;
      this.rebuild(blocks);
    }
    if (this.lavaTex) {
      const t = Math.floor(time * 10) % (LAVA_FRAMES * 2 - 2);
      const frame = t < LAVA_FRAMES ? t : LAVA_FRAMES * 2 - 2 - t;
      this.lavaTex.offset.y = 1 - (frame + 1) / LAVA_FRAMES;
    }
    // Mining cracks (one per fighter).
    while (this.cracks.length < fighters.length) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.002, 1.002, 1.002), this.crackMats[0]);
      m.renderOrder = 3;
      this.cracks.push(m);
      this.group.add(m);
    }
    fighters.forEach((f, i) => {
      const c = this.cracks[i];
      const m = f.mining;
      c.visible = !!m && f.mineProgress > 0 && !f.dead;
      if (!c.visible || !m) return;
      c.material = this.crackMats[Math.min(9, Math.floor(f.mineProgress * 10))];
      c.position.set(m.x + 0.5, m.y + 0.5, m.z + 0.5);
    });
    // The block the crosshair is on (vanilla draws its outline in black).
    const hit = showOutline && !player.dead ? player.crosshairBlock() : null;
    this.outline.visible = !!hit && hit.id !== B.BEDROCK;
    if (hit && this.outline.visible) this.outline.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
  }
}
