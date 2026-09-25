import * as THREE from 'three';
import * as C from '../core/constants';
import { lerp, lerpAngle } from '../core/math';
import type { Fighter, Hand } from '../game/Fighter';
import { isEnchanted } from '../game/items';
import { PART_NAMES, type Assets, type PartName } from './assets';
import { HeldItemSlot, itemVisual } from './heldItem';
import { mcBox, packTexture, toGeometry, type Vec3 } from './itemMesh';
import { thirdPersonItemMatrix, type HandSide, type ItemKind } from './itemTransforms';
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

type PieceBox = { part: PartName; origin: Vec3; size: Vec3; tex: [number, number]; inflate: number; mirror?: boolean };

/**
 * Armor pieces as HumanoidArmorLayer draws them: the humanoid mesh inflated by 1.0 (outer
 * layer_1: helmet, chestplate, boots) or 0.5 (inner layer_2: leggings), in part-local pixels.
 */
const PIECES: { layer: 1 | 2; boxes: PieceBox[] }[] = [
  {
    layer: 1, // helmet
    boxes: [
      { part: 'head', origin: [-4, -8, -4], size: [8, 8, 8], tex: [0, 0], inflate: 1 },
      { part: 'head', origin: [-4, -8, -4], size: [8, 8, 8], tex: [32, 0], inflate: 1.5 },
    ],
  },
  {
    layer: 1, // chestplate
    boxes: [
      { part: 'body', origin: [-4, 0, -2], size: [8, 12, 4], tex: [16, 16], inflate: 1 },
      { part: 'rightArm', origin: [-3, -2, -2], size: [4, 12, 4], tex: [40, 16], inflate: 1 },
      { part: 'leftArm', origin: [-1, -2, -2], size: [4, 12, 4], tex: [40, 16], inflate: 1, mirror: true },
    ],
  },
  {
    layer: 2, // leggings
    boxes: [
      { part: 'body', origin: [-4, 0, -2], size: [8, 12, 4], tex: [16, 16], inflate: 0.5 },
      { part: 'rightLeg', origin: [-2, 0, -2], size: [4, 12, 4], tex: [0, 16], inflate: 0.5 },
      { part: 'leftLeg', origin: [-2, 0, -2], size: [4, 12, 4], tex: [0, 16], inflate: 0.5, mirror: true },
    ],
  },
  {
    layer: 1, // boots
    boxes: [
      { part: 'rightLeg', origin: [-2, 0, -2], size: [4, 12, 4], tex: [0, 16], inflate: 1 },
      { part: 'leftLeg', origin: [-2, 0, -2], size: [4, 12, 4], tex: [0, 16], inflate: 1, mirror: true },
    ],
  },
];

/** Minecraft part-local pixels (Y down, -Z front) → our part frame (Y up, +Z front). */
const toOurs = (p: Vec3): Vec3 => [p[0], -p[1], -p[2]];

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

const socketCache = new Map<string, THREE.Matrix4>();
function socketMatrix(kind: ItemKind, hand: HandSide): THREE.Matrix4 {
  const key = `${kind}:${hand}`;
  let m = socketCache.get(key);
  if (!m) {
    m = thirdPersonItemMatrix(kind, hand);
    socketCache.set(key, m);
  }
  return m;
}

type ArmPose = 'empty' | 'item' | 'block' | 'bow' | 'crossbow_charge' | 'crossbow_hold';

/**
 * Third-person player model animated with vanilla HumanoidModel.setupAnim maths: limb swing,
 * the 1.9 attack swing (body twist + arm arc), crouching, idle arm bob, shield blocking, bow and
 * crossbow poses, the hurt tint and the sideways death fall. Wears whatever armor the fighter has
 * on (resource-pack textures) and holds both hands' items.
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  readonly shadow: THREE.Mesh;
  private readonly tilt = new THREE.Group();
  private readonly pivots = {} as Record<PartName, THREE.Group>;
  private readonly skin: THREE.MeshLambertMaterial;
  /** Armor materials keyed by "<material>/<layer>", e.g. "netherite/1". */
  private readonly armorMats = new Map<string, THREE.MeshLambertMaterial>();
  /** Per armor slot: the meshes (armor + glint) to toggle, and which layer texture they use. */
  private readonly pieces: { armor: THREE.Mesh[]; glint: THREE.Mesh[]; layer: 1 | 2; material: string }[] = [];
  private readonly mainHand: HeldItemSlot;
  private readonly offHand: HeldItemSlot;
  /** ElytraModel: two wings on the back, shown while an elytra is worn. */
  private readonly wings: THREE.Group[] = [];
  private readonly wingGlint: THREE.Mesh[] = [];
  /** The red flash when hurt (the Hit Color mod changes it): colour and strength 0..1. */
  readonly hurtColor = new THREE.Color(1, 0, 0);
  hurtStrength = 0.45;
  /** Blob shadow under the feet (Options → Entity Shadows). */
  shadowsOn = true;

  constructor(assets: Assets, glint: THREE.Material) {
    this.skin = new THREE.MeshLambertMaterial({ map: assets.rig.texture, alphaTest: 0.1, side: THREE.DoubleSide });

    const scaler = new THREE.Group();
    scaler.scale.setScalar(PX_TO_BLOCKS);
    this.root.add(this.tilt);
    this.tilt.add(scaler);
    for (const name of PART_NAMES) {
      const pivot = new THREE.Group();
      pivot.rotation.order = 'ZYX';
      pivot.add(new THREE.Mesh(assets.rig.parts[name], this.skin));
      scaler.add(pivot);
      this.pivots[name] = pivot;
    }

    // Armor: one merged geometry per (piece, part), textured from the pack's armor layers.
    for (const piece of PIECES) {
      const entry = { armor: [] as THREE.Mesh[], glint: [] as THREE.Mesh[], layer: piece.layer, material: 'diamond' };
      const byPart = new Map<PartName, { pos: number[]; nrm: number[]; uv: number[] }>();
      for (const box of piece.boxes) {
        let b = byPart.get(box.part);
        if (!b) byPart.set(box.part, (b = { pos: [], nrm: [], uv: [] }));
        mcBox(b, box.origin, box.size, box.tex, [64, 32], box.inflate, !!box.mirror, toOurs);
      }
      for (const [part, b] of byPart) {
        const geo = toGeometry(b);
        const mesh = new THREE.Mesh(geo, this.armorMat('diamond', piece.layer));
        const g = new THREE.Mesh(geo, glint);
        g.renderOrder = 2;
        this.pivots[part].add(mesh, g);
        entry.armor.push(mesh);
        entry.glint.push(g);
      }
      this.pieces.push(entry);
    }

    // Elytra (ElytraLayer: 2 px behind the body; each wing a 10×20×2 box inflated by 1).
    const wingTex = packTexture('entity/elytra');
    if (wingTex) {
      const wingMat = new THREE.MeshLambertMaterial({ map: wingTex, alphaTest: 0.1, side: THREE.DoubleSide });
      for (const side of [1, -1]) {
        const b = { pos: [] as number[], nrm: [] as number[], uv: [] as number[] };
        mcBox(b, side > 0 ? [-10, 0, 0] : [0, 0, 0], [10, 20, 2], [22, 0], [64, 32], 1, side < 0, toOurs);
        const geo = toGeometry(b);
        const wing = new THREE.Group();
        wing.rotation.order = 'ZYX';
        wing.position.set(5 * side, 0, -2);
        const g = new THREE.Mesh(geo, glint);
        g.renderOrder = 2;
        wing.add(new THREE.Mesh(geo, wingMat), g);
        this.pivots.body.add(wing);
        this.wings.push(wing);
        this.wingGlint.push(g);
      }
    }

    this.mainHand = new HeldItemSlot(glint);
    this.offHand = new HeldItemSlot(glint);
    this.pivots.rightArm.add(this.mainHand.group);
    this.pivots.leftArm.add(this.offHand.group);

    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: getShadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = 1;
  }

  /** HumanoidArmorLayer texture for a material ("diamond", "netherite") and layer. */
  private armorMat(material: string, layer: 1 | 2): THREE.MeshLambertMaterial {
    const key = `${material}/${layer}`;
    let m = this.armorMats.get(key);
    if (!m) {
      const map = packTexture(`models/armor/${material}_layer_${layer}`) ?? blockTexture('diamond_armor');
      m = new THREE.MeshLambertMaterial({ map, alphaTest: 0.1, side: THREE.DoubleSide });
      this.armorMats.set(key, m);
    }
    return m;
  }

  setVisible(v: boolean) {
    this.root.visible = v;
    this.shadow.visible = v && this.shadowsOn;
  }

  /** PlayerRenderer.getArmPose for one hand. */
  private armPose(f: Fighter, hand: Hand): ArmPose {
    const s = f.stackIn(hand);
    if (!s) return 'empty';
    if (f.usingItem && f.useHand === hand) {
      const k = f.useKind();
      if (k === 'shield') return 'block';
      if (k === 'bow') return 'bow';
      if (k === 'crossbow') return 'crossbow_charge';
    } else if (s.id === 'crossbow' && s.charged && !f.swinging) return 'crossbow_hold';
    return 'item';
  }

  private showHands(f: Fighter, tint: THREE.Color) {
    for (const hand of ['main', 'off'] as const) {
      const slot = hand === 'main' ? this.mainHand : this.offHand;
      const s = f.stackIn(hand);
      const v = s && !f.dead ? itemVisual(f, s, hand) : null;
      const mat = slot.show(v);
      if (v) slot.group.matrix.copy(socketMatrix(v.kind, hand === 'main' ? 'right' : 'left'));
      if (mat) mat.color.copy(tint);
    }
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
    // PlayerRenderer.setupRotations while gliding: lie along the look direction, easing in over
    // the first 10 ticks.
    if (f.fallFlying && !f.dead) {
      const t = f.fallFlyTicks + a;
      const k = Math.min(1, (t * t) / 100);
      this.tilt.rotation.x = -k * (Math.PI / 2 - pitch);
    } else this.tilt.rotation.x = 0;

    const hurt = f.hurtTime > 0 || f.dead;
    // Vanilla's overlay: white lerped toward red by 0.45, plus a little red glow.
    const tint = hurt ? this.hurtStrength : 0;
    const hc = this.hurtColor;
    this.skin.color.setRGB(1 + (hc.r - 1) * tint, 1 + (hc.g - 1) * tint, 1 + (hc.b - 1) * tint);
    this.skin.emissive.setRGB(hc.r * tint * 0.67, hc.g * tint * 0.67, hc.b * tint * 0.67);
    // Invisibility hides the body; armor and held items still show, like vanilla.
    const invisible = f.effects.has('invisibility') && !f.dead;
    this.skin.visible = !invisible;
    if (this.root.visible) this.shadow.visible = this.shadowsOn && !invisible;
    for (const m of this.armorMats.values()) {
      m.color.copy(this.skin.color);
      m.emissive.copy(this.skin.emissive);
    }
    const chest = f.armorSlots[1];
    const elytra = !!chest && chest.id === 'elytra';
    for (let i = 0; i < 4; i++) {
      const st = i === 1 && elytra ? null : f.armorSlots[i];
      const e = this.pieces[i];
      const material = st ? st.id.slice(0, st.id.indexOf('_')) : e.material;
      if (material !== e.material) {
        e.material = material;
        const mat = this.armorMat(material, e.layer);
        for (const m of e.armor) m.material = mat;
      }
      for (const m of e.armor) m.visible = !!st;
      for (const m of e.glint) m.visible = !!st && isEnchanted(st);
    }
    this.showHands(f, WHITE);

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

    // Arm poses (poseRightArm / poseLeftArm). A two-handed main-hand pose owns both arms.
    const right = this.armPose(f, 'main');
    const left = this.armPose(f, 'off');
    const H = P.head;
    const R = P.rightArm;
    const L = P.leftArm;
    const twoHanded = right === 'bow' || right === 'crossbow_charge' || right === 'crossbow_hold';
    if (!twoHanded) {
      if (left === 'item') L.xRot = L.xRot * 0.5 - Math.PI / 10;
      else if (left === 'block') {
        L.xRot = L.xRot * 0.5 - 0.9424779;
        L.yRot = 0.5235988;
      }
    }
    switch (right) {
      case 'item':
        R.xRot = R.xRot * 0.5 - Math.PI / 10;
        break;
      case 'block':
        R.xRot = R.xRot * 0.5 - 0.9424779;
        R.yRot = -0.5235988;
        break;
      case 'bow':
        R.yRot = -0.1 + H.yRot;
        L.yRot = 0.1 + H.yRot + 0.4;
        R.xRot = -Math.PI / 2 + H.xRot;
        L.xRot = -Math.PI / 2 + H.xRot;
        break;
      case 'crossbow_charge': {
        R.yRot = -0.8;
        R.xRot = -0.97079635;
        const t = Math.min(1, f.useTicks() / C.CROSSBOW_CHARGE_TICKS);
        L.yRot = lerp(0.4, 0.85, t);
        L.xRot = lerp(R.xRot, -Math.PI / 2, t);
        break;
      }
      case 'crossbow_hold':
        R.yRot = -0.3 + H.yRot;
        L.yRot = 0.6 + H.yRot;
        R.xRot = -Math.PI / 2 + H.xRot + 0.1;
        L.xRot = -1.5 + H.xRot;
        break;
      default:
        break;
    }

    if (attack > 0) {
      const body = P.body;
      body.yRot = Math.sin(Math.sqrt(attack) * Math.PI * 2) * 0.2;
      R.z = Math.sin(body.yRot) * 5;
      R.x = -Math.cos(body.yRot) * 5;
      L.z = -Math.sin(body.yRot) * 5;
      L.x = Math.cos(body.yRot) * 5;
      R.yRot += body.yRot;
      L.yRot += body.yRot;
      L.xRot += body.yRot;
      let f1 = 1 - attack;
      f1 *= f1;
      f1 *= f1;
      f1 = 1 - f1;
      const f2 = Math.sin(f1 * Math.PI);
      const f3 = Math.sin(attack * Math.PI) * -(H.xRot - 0.7) * 0.75;
      R.xRot -= f2 * 1.2 + f3;
      R.yRot += body.yRot * 2;
      R.zRot += Math.sin(attack * Math.PI) * -0.4;
    }
    if (f.usingItem && f.useKind() === 'food') {
      // Bring the food up to the mouth (whichever hand holds it)
      const arm = f.useHand === 'main' ? R : L;
      arm.xRot = -1.35 + Math.sin(age * 0.9) * 0.08;
      arm.yRot = f.useHand === 'main' ? -0.45 : 0.45;
      H.xRot += Math.abs(Math.sin(age * 0.9)) * 0.08;
    }
    if (f.sneaking && !f.dead) {
      P.body.xRot = 0.5;
      R.xRot += 0.4;
      L.xRot += 0.4;
      P.rightLeg.z = 4;
      P.leftLeg.z = 4;
      P.rightLeg.y = 12.2;
      P.leftLeg.y = 12.2;
      H.y = 4.2;
      P.body.y = 3.2;
      L.y = 5.2;
      R.y = 5.2;
    }
    // ElytraModel.setupAnim: folded on the back; spread and swept back while gliding.
    if (this.wings.length) {
      let xr = 0.2617994;
      let zr = -0.2617994;
      let wy = 0;
      let yr = 0;
      if (f.fallFlying) {
        let f4 = 1;
        const vl = Math.hypot(f.vel.x, f.vel.y, f.vel.z);
        if (f.vel.y < 0 && vl > 0) f4 = 1 - Math.pow(-f.vel.y / vl, 1.5);
        xr = f4 * 0.34906584 + (1 - f4) * xr;
        zr = f4 * (-Math.PI / 2) + (1 - f4) * zr;
      } else if (f.sneaking) {
        xr = 0.6981317;
        zr = -0.7853982;
        wy = 3;
        yr = 0.08726646;
      }
      const [lw, rw] = this.wings;
      lw.visible = rw.visible = elytra && !f.dead;
      for (const g of this.wingGlint) g.visible = elytra && isEnchanted(chest!);
      // Minecraft -> ours: rotations (x, -y, -z).
      lw.position.y = -wy;
      rw.position.y = -wy;
      lw.rotation.set(xr, -yr, -zr, 'ZYX');
      rw.rotation.set(xr, yr, zr, 'ZYX');
      if (f.fallFlying && f.fallFlyTicks > 4) H.xRot = -Math.PI / 4;
    }

    // AnimationUtils.bobModelPart
    R.zRot += Math.cos(age * 0.09) * 0.05 + 0.05;
    L.zRot -= Math.cos(age * 0.09) * 0.05 + 0.05;
    R.xRot += Math.sin(age * 0.067) * 0.05;
    L.xRot -= Math.sin(age * 0.067) * 0.05;

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

const WHITE = new THREE.Color(1, 1, 1);
