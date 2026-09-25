import * as THREE from 'three';
import { litMaterial } from './light';
import { Rng } from '../core/rng';
import { blockTexture } from './textures';

export type BlockId =
  | 'grass'
  | 'dirt'
  | 'stone_bricks'
  | 'mossy_stone_bricks'
  | 'cracked_stone_bricks'
  | 'oak_log'
  | 'oak_leaves'
  | 'oak_planks'
  | 'glowstone';

interface BlockDef {
  top: string;
  bottom: string;
  side: string;
  opaque: boolean;
  emissive?: boolean;
  randomTop?: boolean;
}

const BLOCKS: Record<BlockId, BlockDef> = {
  grass: { top: 'grass_top', bottom: 'dirt', side: 'grass_side', opaque: true, randomTop: true },
  dirt: { top: 'dirt', bottom: 'dirt', side: 'dirt', opaque: true, randomTop: true },
  stone_bricks: { top: 'stone_bricks', bottom: 'stone_bricks', side: 'stone_bricks', opaque: true },
  mossy_stone_bricks: {
    top: 'mossy_stone_bricks',
    bottom: 'mossy_stone_bricks',
    side: 'mossy_stone_bricks',
    opaque: true,
  },
  cracked_stone_bricks: {
    top: 'cracked_stone_bricks',
    bottom: 'cracked_stone_bricks',
    side: 'cracked_stone_bricks',
    opaque: true,
  },
  oak_log: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log', opaque: true },
  oak_leaves: { top: 'oak_leaves', bottom: 'oak_leaves', side: 'oak_leaves', opaque: true },
  oak_planks: { top: 'oak_planks', bottom: 'oak_planks', side: 'oak_planks', opaque: true },
  glowstone: { top: 'glowstone', bottom: 'glowstone', side: 'glowstone', opaque: true, emissive: true },
};

export class Voxels {
  private map = new Map<number, BlockId>();
  private static key(x: number, y: number, z: number) {
    return ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
  }
  set(x: number, y: number, z: number, id: BlockId) {
    this.map.set(Voxels.key(x, y, z), id);
  }
  get(x: number, y: number, z: number): BlockId | undefined {
    return this.map.get(Voxels.key(x, y, z));
  }
  *entries(): Generator<[number, number, number, BlockId]> {
    for (const [k, id] of this.map) {
      const z = (k % 1024) - 512;
      const y = (Math.floor(k / 1024) % 1024) - 512;
      const x = Math.floor(k / (1024 * 1024)) - 512;
      yield [x, y, z, id];
    }
  }
}

interface Face {
  n: [number, number, number];
  shade: number;
  tex: 'top' | 'bottom' | 'side';
  corners: [number, number, number][];
}

// Corners are counter-clockwise seen from outside: bottom-left, bottom-right, top-right, top-left.
const FACES: Face[] = [
  { n: [0, 1, 0], shade: 1.0, tex: 'top', corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { n: [0, -1, 0], shade: 0.5, tex: 'bottom', corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { n: [1, 0, 0], shade: 0.6, tex: 'side', corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]] },
  { n: [-1, 0, 0], shade: 0.6, tex: 'side', corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]] },
  { n: [0, 0, 1], shade: 0.8, tex: 'side', corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]] },
  { n: [0, 0, -1], shade: 0.8, tex: 'side', corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]] },
];
const BASE_UV = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];
const AO_LEVELS = [0.52, 0.68, 0.84, 1];

interface Bucket {
  pos: number[];
  uv: number[];
  col: number[];
  idx: number[];
}

/**
 * Greedy-free voxel mesher: culls hidden faces, bakes Minecraft's directional face shading and
 * smooth-lighting style ambient occlusion into vertex colours, one mesh per texture.
 */
export function meshVoxels(voxels: Voxels, seed = 3): THREE.Group {
  const rng = new Rng(seed);
  const buckets = new Map<string, Bucket>();
  const opaqueAt = (x: number, y: number, z: number) => {
    const b = voxels.get(x, y, z);
    return b !== undefined && BLOCKS[b].opaque;
  };

  for (const [x, y, z, id] of voxels.entries()) {
    const def = BLOCKS[id];
    for (const face of FACES) {
      const [nx, ny, nz] = face.n;
      if (ny < 0 && y <= -1) continue; // underside of the ground is never visible
      const nb = voxels.get(x + nx, y + ny, z + nz);
      if (nb !== undefined) {
        if (BLOCKS[nb].opaque || nb === id) continue;
      }
      const tex = def[face.tex];
      let b = buckets.get(tex);
      if (!b) buckets.set(tex, (b = { pos: [], uv: [], col: [], idx: [] }));
      const base = b.pos.length / 3;

      // Tangent axes for ambient occlusion
      const axis = nx !== 0 ? 0 : ny !== 0 ? 1 : 2;
      const t1 = axis === 0 ? 1 : 0;
      const t2 = axis === 2 ? 1 : 2;
      const ao: number[] = [];
      for (const c of face.corners) {
        let a = 3;
        if (!def.emissive) {
          const o = [x + nx, y + ny, z + nz];
          const d1 = [0, 0, 0];
          const d2 = [0, 0, 0];
          d1[t1] = c[t1] === 1 ? 1 : -1;
          d2[t2] = c[t2] === 1 ? 1 : -1;
          const s1 = opaqueAt(o[0] + d1[0], o[1] + d1[1], o[2] + d1[2]) ? 1 : 0;
          const s2 = opaqueAt(o[0] + d2[0], o[1] + d2[1], o[2] + d2[2]) ? 1 : 0;
          const cc = opaqueAt(o[0] + d1[0] + d2[0], o[1] + d1[1] + d2[1], o[2] + d1[2] + d2[2]) ? 1 : 0;
          a = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
        }
        ao.push(a);
        b.pos.push(x + c[0], y + c[1], z + c[2]);
        // Minecraft multiplies light in sRGB space; convert to linear for three.js.
        const light = def.emissive ? 1 : Math.pow(face.shade * AO_LEVELS[a], 2.2);
        b.col.push(light, light, light);
      }
      const rot = def.randomTop && face.tex === 'top' ? rng.int(0, 3) : 0;
      for (let i = 0; i < 4; i++) {
        const [u, v] = BASE_UV[(i + rot) % 4];
        b.uv.push(u, v);
      }
      if (ao[0] + ao[2] < ao[1] + ao[3]) b.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
      else b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }

  const group = new THREE.Group();
  for (const [tex, b] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
    g.setIndex(b.idx);
    g.computeBoundingSphere();
    const leaves = tex === 'oak_leaves';
    const mat = new THREE.MeshBasicMaterial({
      map: blockTexture(tex),
      vertexColors: true,
      alphaTest: leaves ? 0.5 : 0,
      side: leaves ? THREE.DoubleSide : THREE.FrontSide,
    });
    // Glowstone keeps glowing at night.
    if (tex !== 'glowstone') litMaterial(mat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = tex;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  return group;
}
