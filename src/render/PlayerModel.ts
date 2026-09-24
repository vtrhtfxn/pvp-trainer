import * as THREE from 'three';
import { lerp, lerpAngle } from '../core/math';
import type { Fighter } from '../game/Fighter';
import { PART_NAMES, type Assets, type PartName } from './assets';
import { thirdPersonItemMatrix } from './itemTransforms';
import { blockTexture } from './textures';

const PX_TO_BLOCKS = 0.9375 / 16;

interface PartPose {
  x: number;
  y: number;
  z: number;
  xRot: number;
  yRot: number;
  zRot: number;
}

type Box = [number, number, number, number, number, number];

// Diamond armor pieces around each part (model pixels relative to the part pivot).
const ARMOR: Record<PartName, Box[]> = {
  head: [[-5, -1, -5, 5, 9, 5]],
  body: [[-5, -13, -3, 5, 1, 3]],
  rightArm: [[-4, -5, -3, 2, 3, 3]],
  leftArm: [[-2, -5, -3, 4, 3, 3]],
  rightLeg: [
    [-2.5, -8, -2.5, 2.5, 0.5, 2.5],
    [-3, -13, -3, 3, -8, 3],
  ],
  leftLeg: [
    [-2.5, -8, -2.5, 2.5, 0.5, 2.5],
    [-3, -13, -3, 3, -8, 3],
  ],
};

function boxGeometry(boxes: Box[]): THREE.BufferGeometry {
  const geos = boxes.map(([x0, y0, z0, x1, y1, z1]) => {
    const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    return g;
  });
  if (geos.length === 1) return geos[0];
  const merged = new THREE.BufferGeometry();
  const pos: number[] = [];
  const nrm: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  let base = 0;
  for (const g of geos) {
    pos.push(...(g.attributes.position.array as Float32Array));
    nrm.push(...(g.attributes.normal.array as Float32Array));
    uv.push(...(g.attributes.uv.array as Float32Array));
    for (const i of g.index!.array as Uint16Array) idx.push(i + base);
    base += g.attributes.position.count;
  }
  merged.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  merged.setIndex(idx);
  return merged;
}

let shadowTexture: THREE.CanvasTexture | null = null;
function getShadowTexture() {
  if (!shadowTexture) {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
    shadowTexture = new THREE.CanvasTexture(c);
  }
  return shadowTexture;
}

/**
 * Third-person player model animated with vanilla HumanoidModel.setupAnim maths: limb swing,
 * the 1.9 attack swing (body twist + arm arc), crouching, idle arm bob, hurt tint and the
 * sideways death fall. Wears enchanted diamond armor and holds its current item.
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  readonly shadow: THREE.Mesh;
  private readonly tilt = new THREE.Group();
  private readonly pivots = {} as Record<PartName, THREE.Group>;
  private readonly skin: THREE.MeshLambertMaterial;
  private readonly armor: THREE.MeshLambertMaterial;
  private readonly visor: THREE.MeshLambertMaterial;
  private readonly sword: THREE.Group;
  private readonly apple: THREE.Group;

  constructor(assets: Assets, glint: THREE.Material) {
    this.skin = new THREE.MeshLambertMaterial({ map: assets.rig.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    const armorTex = blockTexture('diamond_armor');
    this.armor = new THREE.MeshLambertMaterial({ map: armorTex });

    const scaler = new THREE.Group();
    scaler.scale.setScalar(PX_TO_BLOCKS);
    this.root.add(this.tilt);
    this.tilt.add(scaler);
    // Helmet front face (+Z, BoxGeometry group 4) gets a visor opening
    const visorTex = blockTexture('diamond_helmet_front');
    this.visor = new THREE.MeshLambertMaterial({ map: visorTex, alphaTest: 0.5 });
    const glintVisor = (glint as THREE.MeshBasicMaterial).clone();
    glintVisor.alphaMap = visorTex;
    for (const name of PART_NAMES) {
      const pivot = new THREE.Group();
      pivot.rotation.order = 'ZYX';
      pivot.add(new THREE.Mesh(assets.rig.parts[name], this.skin));
      const armorGeo = boxGeometry(ARMOR[name]);
      const head = name === 'head';
      const armorMats = head ? [this.armor, this.armor, this.armor, this.armor, this.visor, this.armor] : this.armor;
      pivot.add(new THREE.Mesh(armorGeo, armorMats));
      const glintMats = head ? [glint, glint, glint, glint, glintVisor, glint] : glint;
      const glintMesh = new THREE.Mesh(armorGeo, glintMats);
      glintMesh.renderOrder = 2;
      pivot.add(glintMesh);
      scaler.add(pivot);
      this.pivots[name] = pivot;
    }

    const makeHeld = (geo: THREE.BufferGeometry, tex: THREE.Texture, kind: 'handheld' | 'generated', glinted: boolean) => {
      const socket = new THREE.Group();
      socket.matrixAutoUpdate = false;
      socket.matrix.copy(thirdPersonItemMatrix(kind));
      const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.1, side: THREE.DoubleSide });
      socket.add(new THREE.Mesh(geo, mat));
      if (glinted) {
        const g = new THREE.Mesh(geo, glint);
        g.renderOrder = 2;
        socket.add(g);
      }
      this.pivots.rightArm.add(socket);
      return socket;
    };
    this.sword = makeHeld(assets.sword.geometry, assets.sword.texture, 'handheld', true);
    this.apple = makeHeld(assets.apple.geometry, assets.apple.texture, 'generated', false);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: getShadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
  }

  setVisible(v: boolean) {
    this.root.visible = v;
    this.shadow.visible = v;
  }

  update(f: Fighter, a: number, timeSec: number) {
    const x = lerp(f.prevPos.x, f.pos.x, a);
    const y = lerp(f.prevPos.y, f.pos.y, a);
    const z = lerp(f.prevPos.z, f.pos.z, a);
    this.root.position.set(x, y, z);
    const bodyYaw = lerpAngle(f.prevBodyYaw, f.bodyYaw, a);
    const headYaw = lerpAngle(f.prevYaw, f.yaw, a);
    const pitch = lerp(f.prevPitch, f.pitch, a);
    this.root.rotation.y = bodyYaw + Math.PI;

    // Death: tip over sideways like LivingEntityRenderer.setupRotations
    let fall = 0;
    if (f.dead) fall = Math.min(1, Math.sqrt(Math.max(0, ((f.deathTime + a - 1) / 20) * 1.6)));
    this.tilt.rotation.z = (fall * Math.PI) / 2;

    const hurt = f.hurtTime > 0 || f.dead;
    this.skin.color.setRGB(1, hurt ? 0.55 : 1, hurt ? 0.55 : 1);
    this.skin.emissive.setRGB(hurt ? 0.3 : 0, 0, 0);
    this.armor.color.copy(this.skin.color);
    this.armor.emissive.copy(this.skin.emissive);
    this.visor.color.copy(this.skin.color);
    this.visor.emissive.copy(this.skin.emissive);

    const held = f.heldStack()?.id ?? null;
    this.sword.visible = held === 'diamond_sword';
    this.apple.visible = held === 'golden_apple';

    // ---- HumanoidModel.setupAnim (Minecraft model space: Y down, radians)
    const limbAmount = Math.min(1, lerp(f.limbSpeedO, f.limbSpeed, a));
    const limb = f.limbPos - f.limbSpeed * (1 - a);
    const age = timeSec * 20;
    const attack = f.getAttackAnim(a);
    const P: Record<PartName, PartPose> = {
      head: { x: 0, y: 0, z: 0, xRot: -pitch, yRot: bodyYaw - headYaw, zRot: 0 },
      body: { x: 0, y: 0, z: 0, xRot: 0, yRot: 0, zRot: 0 },
      rightArm: { x: -5, y: 2, z: 0, xRot: 0, yRot: 0, zRot: 0 },
      leftArm: { x: 5, y: 2, z: 0, xRot: 0, yRot: 0, zRot: 0 },
      rightLeg: { x: -1.9, y: 12, z: 0.1, xRot: 0, yRot: 0.005, zRot: 0.005 },
      leftLeg: { x: 1.9, y: 12, z: 0.1, xRot: 0, yRot: -0.005, zRot: -0.005 },
    };
    const k = limb * 0.6662;
    P.rightArm.xRot = Math.cos(k + Math.PI) * 2 * limbAmount * 0.5;
    P.leftArm.xRot = Math.cos(k) * 2 * limbAmount * 0.5;
    P.rightLeg.xRot = Math.cos(k) * 1.4 * limbAmount;
    P.leftLeg.xRot = Math.cos(k + Math.PI) * 1.4 * limbAmount;
    // Holding an item raises the right arm a little (ArmPose.ITEM)
    if (held) P.rightArm.xRot = P.rightArm.xRot * 0.5 - Math.PI / 10;

    if (attack > 0) {
      const body = P.body;
      body.yRot = Math.sin(Math.sqrt(attack) * Math.PI * 2) * 0.2;
      P.rightArm.z = Math.sin(body.yRot) * 5;
      P.rightArm.x = -Math.cos(body.yRot) * 5;
      P.leftArm.z = -Math.sin(body.yRot) * 5;
      P.leftArm.x = Math.cos(body.yRot) * 5;
      P.rightArm.yRot += body.yRot;
      P.leftArm.yRot += body.yRot;
      P.leftArm.xRot += body.yRot;
      let f1 = 1 - attack;
      f1 *= f1;
      f1 *= f1;
      f1 = 1 - f1;
      const f2 = Math.sin(f1 * Math.PI);
      const f3 = Math.sin(attack * Math.PI) * -(P.head.xRot - 0.7) * 0.75;
      P.rightArm.xRot -= f2 * 1.2 + f3;
      P.rightArm.yRot += body.yRot * 2;
      P.rightArm.zRot += Math.sin(attack * Math.PI) * -0.4;
    }
    if (f.usingItem) {
      // Bring the food up to the mouth
      P.rightArm.xRot = -1.35 + Math.sin(age * 0.9) * 0.08;
      P.rightArm.yRot = -0.45;
      P.head.xRot += Math.abs(Math.sin(age * 0.9)) * 0.08;
    }
    if (f.sneaking && !f.dead) {
      P.body.xRot = 0.5;
      P.rightArm.xRot += 0.4;
      P.leftArm.xRot += 0.4;
      P.rightLeg.z = 4;
      P.leftLeg.z = 4;
      P.rightLeg.y = 12.2;
      P.leftLeg.y = 12.2;
      P.head.y = 4.2;
      P.body.y = 3.2;
      P.leftArm.y = 5.2;
      P.rightArm.y = 5.2;
    }
    // AnimationUtils.bobModelPart
    P.rightArm.zRot += Math.cos(age * 0.09) * 0.05 + 0.05;
    P.leftArm.zRot -= Math.cos(age * 0.09) * 0.05 + 0.05;
    P.rightArm.xRot += Math.sin(age * 0.067) * 0.05;
    P.leftArm.xRot -= Math.sin(age * 0.067) * 0.05;

    for (const name of PART_NAMES) {
      const p = P[name];
      const piv = this.pivots[name];
      // Minecraft (x, y-down, z) -> ours (x, 24 - y, -z); rotations (x, -y, -z) in ZYX order
      piv.position.set(p.x, 24 - p.y, -p.z);
      piv.rotation.set(p.xRot, -p.yRot, -p.zRot, 'ZYX');
    }

    // Blob shadow on the floor, fading with height
    const h = Math.max(0, y - f.world.floorY);
    this.shadow.position.set(x, f.world.floorY + 0.015, z);
    const s = Math.max(0, 1 - h / 3);
    this.shadow.scale.setScalar(0.9 * (0.6 + 0.4 * s));
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = f.dead ? s * (1 - Math.min(1, f.deathTime / 20)) : s;
  }
}
