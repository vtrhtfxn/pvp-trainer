import * as THREE from 'three';
import { litMaterial } from './light';
import { B, CHUNK, isFluid, isSolid, type Blocks } from '../game/Blocks';
import type { Fighter } from '../game/Fighter';
import { mcBox, packTexture, toGeometry, type Vec3 } from './itemMesh';
import { packImage } from './pack';
import { blockTexture } from './textures';

/** Minecraft's directional face shading: up 1, down 0.5, east/west 0.6, north/south 0.8. */
const FACES: { n: [number, number, number]; shade: number; kind: 'top' | 'bottom' | 'side'; c: [number, number, number][] }[] = [
  { n: [0, 1, 0], shade: 1.0, kind: 'top', c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], shade: 0.5, kind: 'bottom', c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], shade: 0.6, kind: 'side', c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], shade: 0.6, kind: 'side', c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 0, 1], shade: 0.8, kind: 'side', c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], shade: 0.8, kind: 'side', c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
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

/** Texture (textures.ts name) for one face of a solid block. */
function faceTexture(id: number, kind: 'top' | 'bottom' | 'side', blocks: Blocks, x: number, y: number, z: number): string {
  switch (id) {
    case B.PLANKS:
      return 'oak_planks';
    case B.COBBLESTONE:
      return 'cobblestone';
    case B.OBSIDIAN:
      return 'obsidian';
    case B.STONE:
      return 'stone';
    case B.GLOWSTONE:
      return 'glowstone_block';
    case B.GRASS:
      return kind === 'top' ? 'grass_top' : kind === 'side' ? 'grass_side' : 'dirt';
    case B.DIRT:
      return 'dirt';
    case B.RESPAWN_ANCHOR: {
      const charge = blocks.anchorCharge(x, y, z);
      if (kind === 'top') return charge > 0 ? 'respawn_anchor_top' : 'respawn_anchor_top_off';
      if (kind === 'bottom') return 'respawn_anchor_bottom';
      return `respawn_anchor_side${charge}`;
    }
    default:
      return 'bedrock';
  }
}

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

/** An animated vertical-strip texture (lava, fire): a clone we scroll frame by frame. */
function stripTexture(name: string, frames: number): THREE.Texture | null {
  const base = packTexture(name);
  if (!base) return null;
  const t = base.clone();
  t.repeat.set(1, 1 / frames);
  t.needsUpdate = true;
  return t;
}

/** block/lava_still.png.mcmeta: 20 frames, 2 ticks each, played forward then back. */
const LAVA_FRAMES = 20;
const FIRE_FRAMES = 32;

/** The ender chest model (ChestModel): a 14×10×14 body, a 14×5×14 lid and the latch. */
function enderChestGeometry(): THREE.BufferGeometry {
  const b = { pos: [] as number[], nrm: [] as number[], uv: [] as number[] };
  // Minecraft model space is Y-down with -Z in front; map to block space (Y up, 1 unit = 1 block).
  const map = (p: Vec3): Vec3 => [p[0] / 16, 1 - p[1] / 16, 1 - p[2] / 16];
  mcBox(b, [1, 6, 1], [14, 10, 14], [0, 19], [64, 64], 0, false, map);
  mcBox(b, [1, 1, 1], [14, 5, 14], [0, 0], [64, 64], 0, false, map);
  mcBox(b, [7, 3, 0], [2, 4, 1], [0, 0], [64, 64], 0, false, map);
  return toGeometry(b);
}

interface ChunkMeshes {
  group: THREE.Group;
  meshes: THREE.Mesh[];
}

/**
 * Everything in the block grid: placed blocks and, in Crystal, the diggable ground — solid blocks
 * (face-culled, shaded), cobwebs and fire (crossed sprites), ender chests (their chest model),
 * water and lava (surfaces at their level). Meshed per 16×16 chunk and only where something
 * changed, so an explosion remeshes a few chunks instead of the whole arena. Also draws each
 * fighter's mining cracks and the crosshair's block outline.
 */
export class BlocksView {
  readonly group = new THREE.Group();
  private blocks: Blocks | null = null;
  private readonly chunks = new Map<number, ChunkMeshes>();
  private readonly solidMats = new Map<string, THREE.MeshBasicMaterial>();
  private readonly webMat: THREE.MeshBasicMaterial;
  private readonly waterMat: THREE.MeshBasicMaterial;
  private readonly lavaMat: THREE.MeshBasicMaterial;
  private readonly lavaTex: THREE.Texture | null;
  private readonly fireMat: THREE.MeshBasicMaterial;
  private readonly fireTex: THREE.Texture | null;
  private readonly chestMat: THREE.MeshLambertMaterial;
  private readonly chestGeo = enderChestGeometry();
  private readonly cracks: THREE.Mesh[] = [];
  private readonly crackMats: THREE.MeshBasicMaterial[] = [];
  readonly outline: THREE.LineSegments;

  constructor() {
    this.webMat = litMaterial(new THREE.MeshBasicMaterial({ map: packTexture('block/cobweb'), alphaTest: 0.1, side: THREE.DoubleSide, vertexColors: true }));
    this.waterMat = litMaterial(new THREE.MeshBasicMaterial({ map: waterTexture(), transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, vertexColors: true }));
    this.lavaTex = stripTexture('block/lava_still', LAVA_FRAMES);
    this.lavaMat = new THREE.MeshBasicMaterial({ map: this.lavaTex, side: THREE.DoubleSide });
    this.fireTex = stripTexture('block/fire_0', FIRE_FRAMES);
    this.fireMat = new THREE.MeshBasicMaterial({ map: this.fireTex, alphaTest: 0.1, side: THREE.DoubleSide, fog: false });
    this.chestMat = new THREE.MeshLambertMaterial({ map: packTexture('entity/chest/ender'), alphaTest: 0.1 });
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
      if (name !== 'glowstone') litMaterial(m);
      this.solidMats.set(name, m);
    }
    return m;
  }

  private dropChunk(key: number) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const m of c.meshes) if (m.geometry !== this.chestGeo) m.geometry.dispose();
    this.group.remove(c.group);
    this.chunks.delete(key);
  }

  private buildChunk(blocks: Blocks, key: number) {
    this.dropChunk(key);
    const cx = Math.floor(key / 1024);
    const cz = key % 1024;
    const x0 = cx * CHUNK - blocks.half;
    const z0 = cz * CHUNK - blocks.half;
    const solids = new Map<string, Buf>();
    const web = buf();
    const water = buf();
    const lava = buf();
    const fire = buf();
    const chests: [number, number, number][] = [];
    const bottom = -blocks.depth;
    for (let y = bottom; y < blocks.height; y++)
      for (let z = z0; z < z0 + CHUNK; z++)
        for (let x = x0; x < x0 + CHUNK; x++) {
          const id = blocks.get(x, y, z);
          if (id === B.AIR) {
            // Dug all the way down in the ground: show the bedrock under it.
            if (y === bottom && blocks.depth > 0) {
              let b = solids.get('bedrock');
              if (!b) solids.set('bedrock', (b = buf()));
              this.quad(b, x, y - 1, z, FACES[0].c, 1, 1);
            }
            continue;
          }
          if (id === B.ENDER_CHEST) {
            chests.push([x, y, z]);
            continue;
          }
          if (isSolid(id)) {
            for (const f of FACES) {
              const n = blocks.get(x + f.n[0], y + f.n[1], z + f.n[2]);
              if (isSolid(n) && n !== B.ENDER_CHEST) continue;
              // The ground's underside and the outer walls' faces are never seen.
              if (y + f.n[1] < bottom) continue;
              const tex = faceTexture(id, f.kind, blocks, x, y, z);
              let b = solids.get(tex);
              if (!b) solids.set(tex, (b = buf()));
              this.quad(b, x, y, z, f.c, f.shade, 1);
            }
          } else if (id === B.COBWEB) this.cross(web, x, y, z, 0.15);
          else if (id === B.FIRE) this.cross(fire, x, y, z, 0);
          else if (isFluid(id)) this.fluid(id === B.WATER ? water : lava, blocks, x, y, z, id);
        }
    const group = new THREE.Group();
    const meshes: THREE.Mesh[] = [];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, order = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.renderOrder = order;
      m.matrixAutoUpdate = false;
      meshes.push(m);
      group.add(m);
      return m;
    };
    for (const [name, b] of solids) if (b.idx.length) add(toGeo(b), this.solidMat(name));
    if (web.idx.length) add(toGeo(web), this.webMat);
    if (fire.idx.length) add(toGeo(fire), this.fireMat, 4);
    if (lava.idx.length) add(toGeo(lava), this.lavaMat);
    if (water.idx.length) add(toGeo(water), this.waterMat, 2);
    for (const [x, y, z] of chests) {
      const m = add(this.chestGeo, this.chestMat);
      m.position.set(x, y, z);
      m.updateMatrix();
    }
    if (!meshes.length) return;
    this.group.add(group);
    this.chunks.set(key, { group, meshes });
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

  /** Two crossed quads (cobwebs inset a little; fire fills the cell). */
  private cross(b: Buf, x: number, y: number, z: number, inset: number) {
    const a = inset;
    const e = 1 - inset;
    const planes: [number, number, number][][] = [
      [
        [a, 0, a],
        [e, 0, e],
        [e, 1, e],
        [a, 1, a],
      ],
      [
        [e, 0, a],
        [a, 0, e],
        [a, 1, e],
        [e, 1, a],
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
        if (f.n[1] !== 0 || blocks.fluidHeight(x + f.n[0], y, z + f.n[2]) >= top) continue;
      } else if (isSolid(n)) continue;
      if (f.n[1] > 0 && top >= 1 && blocks.get(x, y + 1, z) === id) continue;
      this.quad(b, x, y, z, f.c, f.shade, top);
    }
  }

  update(blocks: Blocks, fighters: readonly Fighter[], player: Fighter, showOutline: boolean, time: number) {
    if (blocks !== this.blocks) {
      // A new match: throw every chunk away and mesh the new world from scratch.
      for (const key of [...this.chunks.keys()]) this.dropChunk(key);
      this.blocks = blocks;
      for (let cx = 0; cx < blocks.sx / CHUNK; cx++) for (let cz = 0; cz < blocks.sz / CHUNK; cz++) blocks.dirty.add(cx * 1024 + cz);
    }
    if (blocks.dirty.size) {
      for (const key of blocks.dirty) this.buildChunk(blocks, key);
      blocks.dirty.clear();
    }
    const tick = Math.floor(time * 20);
    if (this.lavaTex) {
      const t = Math.floor(tick / 2) % (LAVA_FRAMES * 2 - 2);
      const frame = t < LAVA_FRAMES ? t : LAVA_FRAMES * 2 - 2 - t;
      this.lavaTex.offset.y = 1 - (frame + 1) / LAVA_FRAMES;
    }
    if (this.fireTex) this.fireTex.offset.y = 1 - ((tick % FIRE_FRAMES) + 1) / FIRE_FRAMES;

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
