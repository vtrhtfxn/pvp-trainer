import * as THREE from 'three';
import * as C from '../core/constants';
import { clamp, lerp } from '../core/math';
import type { Fighter, Hand } from '../game/Fighter';
import type { ItemStack } from '../game/items';
import type { Assets } from './assets';
import { HeldItemSlot, itemVisual } from './heldItem';
import { firstPersonItemMatrix } from './itemTransforms';

const DEG = Math.PI / 180;
const tmp = new THREE.Matrix4();

const stackKey = (s: ItemStack | null) => (s ? `${s.id}:${s.count}:${s.charged ? 1 : 0}` : null);

/** Options → Video → Hand, plus the Low Shield mod. */
export interface HandOptions {
  /** Vertical FOV of the hand pass (vanilla: 70). */
  fov: number;
  /** Offsets in blocks: x moves the hands apart, y up, z toward the screen. */
  x: number;
  y: number;
  z: number;
  scale: number;
  /** How far down (0..1) the Low Shield mod draws a shield. */
  lowShield: number;
}

/**
 * First-person hands, rendered in their own scene with a fixed 70° FOV like vanilla.
 * Implements ItemInHandRenderer: the 1.9 "weapon dips while recharging" main-hand height, re-equip
 * on item change for both hands, the swing arc, eating bob, shield raise, bow and crossbow draw,
 * hand sway and the empty-hand arm.
 */
export class FirstPersonView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 10);
  private readonly root = new THREE.Group();
  private readonly main: HeldItemSlot;
  private readonly off: HeldItemSlot;
  private readonly arm = new THREE.Group();
  private mainHandHeight = 0;
  private oMainHandHeight = 0;
  private offHandHeight = 0;
  private oOffHandHeight = 0;
  private shownMain: string | null = null;
  private shownOff: string | null = null;
  private xBob = 0;
  private yBob = 0;
  private xBobO = 0;
  private yBobO = 0;
  private armMaterial: THREE.MeshLambertMaterial;
  readonly opts: HandOptions = { fov: 70, x: 0, y: 0, z: 0, scale: 1, lowShield: 0 };

  private readonly ambient: THREE.AmbientLight;
  private readonly key: THREE.DirectionalLight;

  constructor(assets: Assets, glint: THREE.Material) {
    this.ambient = new THREE.AmbientLight(0xffffff, 0.62 * Math.PI);
    this.scene.add(this.ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.55 * Math.PI);
    key.position.set(-0.4, 1, 0.6);
    this.scene.add(key);
    this.key = key;
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);

    this.main = new HeldItemSlot(glint);
    this.off = new HeldItemSlot(glint);
    this.armMaterial = new THREE.MeshLambertMaterial({ map: assets.rig.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    this.arm.add(new THREE.Mesh(assets.rig.parts.rightArm, this.armMaterial));
    this.arm.matrixAutoUpdate = false;
    this.root.add(this.main.group, this.off.group, this.arm);
  }

  /** Dims the hands with the world at night. */
  setLight(v: number) {
    this.ambient.intensity = 0.62 * Math.PI * v;
    this.key.intensity = 0.55 * Math.PI * v;
  }

  reset() {
    this.mainHandHeight = this.oMainHandHeight = 0;
    this.offHandHeight = this.oOffHandHeight = 0;
    this.shownMain = null;
    this.shownOff = null;
  }

  /** Per game tick (ItemInHandRenderer.tick + LocalPlayer bob). */
  tick(p: Fighter) {
    this.oMainHandHeight = this.mainHandHeight;
    this.oOffHandHeight = this.offHandHeight;
    const main = stackKey(p.heldStack());
    const off = stackKey(p.offhand);
    const f = p.attackStrengthScale(1);
    this.mainHandHeight += clamp((main === this.shownMain ? f * f * f : 0) - this.mainHandHeight, -0.4, 0.4);
    this.offHandHeight += clamp((off === this.shownOff ? 1 : 0) - this.offHandHeight, -0.4, 0.4);
    if (this.mainHandHeight < 0.1) this.shownMain = main;
    if (this.offHandHeight < 0.1) this.shownOff = off;
    this.xBobO = this.xBob;
    this.yBobO = this.yBob;
    this.xBob += (p.pitch / DEG - this.xBob) * 0.5;
    this.yBob += (p.yaw / DEG - this.yBob) * 0.5;
  }

  update(p: Fighter, a: number, viewShake: THREE.Matrix4, aspect: number) {
    // Vanilla uses a fixed 70° vertical FOV; on narrow (portrait) windows widen it so the
    // hand keeps at least the horizontal view of a 3:2 screen instead of sliding off-screen.
    const half = (this.opts.fov / 2) * DEG;
    const halfTan = Math.max(Math.tan(half), (Math.tan(half) * 1.5) / aspect);
    const fov = (2 * Math.atan(halfTan)) / DEG;
    if (this.camera.fov !== fov || this.camera.aspect !== aspect) {
      this.camera.fov = fov;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const m = this.root.matrix.copy(viewShake);
    // Hand lags slightly behind camera rotation
    const pitchLag = p.pitch / DEG - lerp(this.xBobO, this.xBob, a);
    const yawLag = p.yaw / DEG - lerp(this.yBobO, this.yBob, a);
    m.multiply(tmp.makeRotationX(-pitchLag * 0.1 * DEG));
    m.multiply(tmp.makeRotationY(-yawLag * 0.1 * DEG));
    this.root.matrixWorldNeedsUpdate = true;

    const hurt = p.hurtTime > 0;
    this.armMaterial.color.setRGB(1, hurt ? 0.6 : 1, hurt ? 0.6 : 1);

    // evaluateWhichHandsToRender: a drawn bow/crossbow, or a loaded crossbow in the main hand,
    // hides the other hand.
    const kind = p.useKind();
    const aiming = kind === 'bow' || kind === 'crossbow';
    const mainCharged = p.heldStack()?.id === 'crossbow' && !!p.heldStack()?.charged;
    const showMain = !aiming || p.useHand === 'main';
    const showOff = (!aiming || p.useHand === 'off') && !(mainCharged && !aiming);

    const mainStack = this.shownMain !== null ? p.heldStack() : null;
    this.renderHand('main', showMain ? mainStack : null, p, a, 1 - lerp(this.oMainHandHeight, this.mainHandHeight, a));
    const offStack = this.shownOff !== null ? p.offhand : null;
    this.renderHand('off', showOff ? offStack : null, p, a, 1 - lerp(this.oOffHandHeight, this.offHandHeight, a));
    this.arm.visible = showMain && !mainStack && !p.dead;
    if (this.arm.visible) {
      const am = this.arm.matrix.identity();
      this.offset(am, 1);
      this.armMatrix(am, 1 - lerp(this.oMainHandHeight, this.mainHandHeight, a), p.getAttackAnim(a));
    }
  }

  private renderHand(hand: Hand, stack: ItemStack | null, p: Fighter, a: number, equip: number) {
    const slot = hand === 'main' ? this.main : this.off;
    const v = stack && !p.dead ? itemVisual(p, stack, hand) : null;
    slot.show(v);
    if (!v || !stack) return;
    const using = p.usingItem && p.useHand === hand;
    const kind = using ? p.useKind() : 'none';
    const m = slot.group.matrix.identity();
    this.offset(m, hand === 'main' ? 1 : -1);
    if (this.opts.lowShield > 0 && (v.kind === 'shield' || v.kind === 'shield_blocking')) m.multiply(tmp.makeTranslation(0, -this.opts.lowShield * 0.4, 0));
    firstPersonItemMatrix(m, {
      kind: v.kind,
      hand: hand === 'main' ? 'right' : 'left',
      equipProgress: using ? 0 : equip,
      swingProgress: hand === 'main' ? p.getAttackAnim(a) : 0,
      eatRemaining: kind === 'food' ? p.useItemRemaining - a : null,
      eatDuration: p.useItemDuration || 1,
      drawTicks: kind === 'bow' || kind === 'crossbow' ? p.useTicks() + a : null,
      chargeTicks: C.CROSSBOW_CHARGE_TICKS,
      crossbowCharged: stack.id === 'crossbow' && !!stack.charged,
    });
    if (this.opts.scale !== 1) m.multiply(tmp.makeScale(this.opts.scale, this.opts.scale, this.opts.scale));
  }

  /** The hand offset options, in view space (x mirrored for the left hand). */
  private offset(m: THREE.Matrix4, side: number) {
    const o = this.opts;
    if (o.x || o.y || o.z) m.multiply(tmp.makeTranslation(o.x * side, o.y, o.z));
  }

  /** ItemInHandRenderer.renderPlayerArm for the right arm. */
  private armMatrix(m: THREE.Matrix4, equip: number, swing: number) {
    const f = 1;
    const f1 = Math.sqrt(swing);
    const f2 = -0.3 * Math.sin(f1 * Math.PI);
    const f3 = 0.4 * Math.sin(f1 * Math.PI * 2);
    const f4 = -0.4 * Math.sin(swing * Math.PI);
    m.multiply(tmp.makeTranslation(f * (f2 + 0.64), f3 - 0.6 + equip * -0.6, f4 - 0.72));
    m.multiply(tmp.makeRotationY(f * 45 * DEG));
    const f5 = Math.sin(swing * swing * Math.PI);
    const f6 = Math.sin(f1 * Math.PI);
    m.multiply(tmp.makeRotationY(f * f6 * 70 * DEG));
    m.multiply(tmp.makeRotationZ(f * f5 * -20 * DEG));
    m.multiply(tmp.makeTranslation(f * -1, 3.6, 3.5));
    m.multiply(tmp.makeRotationZ(f * 120 * DEG));
    m.multiply(tmp.makeRotationX(200 * DEG));
    m.multiply(tmp.makeRotationY(f * -135 * DEG));
    m.multiply(tmp.makeTranslation(f * 5.6, 0, 0));
    // ModelPart.translateAndRotate for the arm (pivot -5, 2, 0 px), then our Y-up geometry
    m.multiply(tmp.makeTranslation(-5 / 16, 2 / 16, 0));
    m.multiply(tmp.makeScale(1 / 16, -1 / 16, -1 / 16));
  }
}
