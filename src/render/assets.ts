import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import playerUrl from '../assets/models/player.glb?url';
import { loadPack } from './pack';

export type PartName = 'head' | 'body' | 'rightArm' | 'leftArm' | 'rightLeg' | 'leftLeg';
export const PART_NAMES: PartName[] = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];

/** Minecraft HumanoidModel pivots converted to a Y-up, +Z-facing frame, in model pixels. */
export const CANONICAL_PIVOTS: Record<PartName, [number, number, number]> = {
  head: [0, 24, 0],
  body: [0, 24, 0],
  rightArm: [-5, 22, 0],
  leftArm: [5, 22, 0],
  rightLeg: [-1.9, 12, 0],
  leftLeg: [1.9, 12, 0],
};

export interface PlayerRig {
  parts: Record<PartName, THREE.BufferGeometry>;
  texture: THREE.Texture;
}

export interface Assets {
  rig: PlayerRig;
}

function load(url: string): Promise<GLTF> {
  return new Promise((resolve, reject) => new GLTFLoader().load(url, resolve, undefined, reject));
}

function firstTexture(root: THREE.Object3D): THREE.Texture {
  let tex: THREE.Texture | null = null;
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (!tex && m && m.map) tex = m.map;
  });
  if (!tex) throw new Error('model has no texture');
  return tex;
}

const BONE_TO_PART: Record<string, PartName> = {
  head: 'head',
  body: 'body',
  armR: 'rightArm',
  armL: 'leftArm',
  legR: 'rightLeg',
  legL: 'leftLeg',
};

function partForBone(name: string): PartName {
  const key = Object.keys(BONE_TO_PART).find((k) => name.startsWith(k));
  return key ? BONE_TO_PART[key] : 'body';
}

/**
 * The supplied rig's bone pivots don't line up with its mesh, so the skinned mesh is split into
 * rigid body parts and re-pivoted at Minecraft's exact joint positions. Parts come out in model
 * pixels relative to their pivot; the model root is scaled by 0.9375/16 like vanilla players.
 */
function buildRig(gltf: GLTF): PlayerRig {
  let skinned: THREE.SkinnedMesh | null = null;
  gltf.scene.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && !skinned) skinned = o as THREE.SkinnedMesh;
  });
  if (!skinned) throw new Error('player model has no skinned mesh');
  const mesh = skinned as THREE.SkinnedMesh;
  const src = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
  const pos = src.attributes.position;
  const nrm = src.attributes.normal;
  const uv = src.attributes.uv;
  const si = src.attributes.skinIndex;
  const sw = src.attributes.skinWeight;
  const bones = mesh.skeleton.bones;

  const partOf = (i: number): PartName => {
    let best = 0;
    let bw = -1;
    for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, k);
      }
    }
    return partForBone(bones[best].name);
  };

  const bounds = new Map<PartName, THREE.Box3>();
  const vertexPart: PartName[] = [];
  for (let i = 0; i < pos.count; i++) {
    const p = partOf(i);
    vertexPart.push(p);
    if (!bounds.has(p)) bounds.set(p, new THREE.Box3());
    bounds.get(p)!.expandByPoint(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)));
  }
  const body = bounds.get('body')!;
  const px = (body.max.y - body.min.y) / 12;
  const feetY = Math.min(bounds.get('rightLeg')!.min.y, bounds.get('leftLeg')!.min.y);
  const origin = new THREE.Vector3((body.min.x + body.max.x) / 2, feetY, (body.min.z + body.max.z) / 2);

  const acc: Record<PartName, { p: number[]; n: number[]; t: number[] }> = {
    head: { p: [], n: [], t: [] },
    body: { p: [], n: [], t: [] },
    rightArm: { p: [], n: [], t: [] },
    leftArm: { p: [], n: [], t: [] },
    rightLeg: { p: [], n: [], t: [] },
    leftLeg: { p: [], n: [], t: [] },
  };
  for (let tri = 0; tri < pos.count; tri += 3) {
    const part = vertexPart[tri];
    const pivot = CANONICAL_PIVOTS[part];
    const a = acc[part];
    for (let k = 0; k < 3; k++) {
      const i = tri + k;
      a.p.push(
        (pos.getX(i) - origin.x) / px - pivot[0],
        (pos.getY(i) - origin.y) / px - pivot[1],
        (pos.getZ(i) - origin.z) / px - pivot[2],
      );
      a.n.push(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
      a.t.push(uv.getX(i), uv.getY(i));
    }
  }
  const parts = {} as Record<PartName, THREE.BufferGeometry>;
  for (const name of PART_NAMES) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(acc[name].p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(acc[name].n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(acc[name].t, 2));
    parts[name] = g;
  }
  const texture = firstTexture(gltf.scene);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  return { parts, texture };
}

export async function loadAssets(): Promise<Assets> {
  // Items, armor, the shield, arrows, blocks and HUD sprites all come from the resource pack;
  // only the rigged player body is still a model file.
  const [player] = await Promise.all([load(playerUrl), loadPack()]);
  return { rig: buildRig(player) };
}
