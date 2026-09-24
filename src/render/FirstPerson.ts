import * as THREE from 'three';
import { clamp, lerp } from '../core/math';
import type { Fighter } from '../game/Fighter';
import type { ItemId } from '../game/items';
import type { Assets } from './assets';
import { firstPersonItemMatrix } from './itemTransforms';

const DEG = Math.PI / 180;
const tmp = new THREE.Matrix4();

/**
 * First-person held item, rendered in its own scene with a fixed 70° FOV like vanilla.
 * Implements the 1.9 "sword dips while recharging" equip height, re-equip on item change,
 * swing arc, eating bob, hand sway and the empty-hand arm.
 */
export class FirstPersonView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 10);
  private readonly root = new THREE.Group();
  private readonly sword = new THREE.Group();
  private readonly apple = new THREE.Group();
  private readonly arm = new THREE.Group();
  private mainHandHeight = 0;
  private oMainHandHeight = 0;
  private shownKey: string | null = null;
  private shownId: ItemId | null = null;
  private xBob = 0;
  private yBob = 0;
  private xBobO = 0;
  private yBobO = 0;
  private armMaterial: THREE.MeshLambertMaterial;

  constructor(assets: Assets, glint: THREE.Material) {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.62 * Math.PI));
    const key = new THREE.DirectionalLight(0xffffff, 0.55 * Math.PI);
    key.position.set(-0.4, 1, 0.6);
    this.scene.add(key);
    this.root.matrixAutoUpdate = false;
    this.scene.add(this.root);

    const swordMat = new THREE.MeshLambertMaterial({ map: assets.sword.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    this.sword.add(new THREE.Mesh(assets.sword.geometry, swordMat));
    const g = new THREE.Mesh(assets.sword.geometry, glint);
    g.renderOrder = 2;
    this.sword.add(g);
    const appleMat = new THREE.MeshLambertMaterial({ map: assets.apple.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    this.apple.add(new THREE.Mesh(assets.apple.geometry, appleMat));
    this.armMaterial = new THREE.MeshLambertMaterial({ map: assets.rig.texture, alphaTest: 0.1, side: THREE.DoubleSide });
    this.arm.add(new THREE.Mesh(assets.rig.parts.rightArm, this.armMaterial));
    for (const o of [this.sword, this.apple, this.arm]) {
      o.matrixAutoUpdate = false;
      this.root.add(o);
    }
  }

  reset() {
    this.mainHandHeight = this.oMainHandHeight = 0;
    this.shownKey = null;
    this.shownId = null;
  }

  /** Per game tick (ItemInHandRenderer.tick + LocalPlayer bob). */
  tick(p: Fighter) {
    this.oMainHandHeight = this.mainHandHeight;
    const stack = p.heldStack();
    const key = stack ? `${stack.id}:${stack.count}` : null;
    const f = p.attackStrengthScale(1);
    const target = key === this.shownKey ? f * f * f : 0;
    this.mainHandHeight += clamp(target - this.mainHandHeight, -0.4, 0.4);
    if (this.mainHandHeight < 0.1) {
      this.shownKey = key;
      this.shownId = stack?.id ?? null;
    }
    this.xBobO = this.xBob;
    this.yBobO = this.yBob;
    this.xBob += (p.pitch / DEG - this.xBob) * 0.5;
    this.yBob += (p.yaw / DEG - this.yBob) * 0.5;
  }

  update(p: Fighter, a: number, viewShake: THREE.Matrix4, aspect: number) {
    // Vanilla uses a fixed 70° vertical FOV; on narrow (portrait) windows widen it so the
    // hand keeps at least the horizontal view of a 3:2 screen instead of sliding off-screen.
    const halfTan = Math.max(Math.tan(35 * DEG), (Math.tan(35 * DEG) * 1.5) / aspect);
    this.camera.fov = (2 * Math.atan(halfTan)) / DEG;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const m = this.root.matrix.copy(viewShake);
    // Hand lags slightly behind camera rotation
    const pitchLag = p.pitch / DEG - lerp(this.xBobO, this.xBob, a);
    const yawLag = p.yaw / DEG - lerp(this.yBobO, this.yBob, a);
    m.multiply(tmp.makeRotationX(-pitchLag * 0.1 * DEG));
    m.multiply(tmp.makeRotationY(-yawLag * 0.1 * DEG));
    this.root.matrixWorldNeedsUpdate = true;

    const equip = 1 - lerp(this.oMainHandHeight, this.mainHandHeight, a);
    const swing = p.getAttackAnim(a);
    const id = this.shownId;
    this.sword.visible = id === 'diamond_sword';
    this.apple.visible = id === 'golden_apple';
    this.arm.visible = id === null && !p.dead;
    const eating = p.usingItem && id === 'golden_apple';

    if (id) {
      const target = id === 'diamond_sword' ? this.sword : this.apple;
      target.matrix.identity();
      firstPersonItemMatrix(target.matrix, {
        kind: id === 'diamond_sword' ? 'handheld' : 'generated',
        equipProgress: equip,
        swingProgress: swing,
        eatRemaining: eating ? p.useItemRemaining - a : null,
        eatDuration: p.useItemDuration || 1,
      });
    } else {
      this.armMatrix(this.arm.matrix.identity(), equip, swing);
    }
    const hurt = p.hurtTime > 0;
    this.armMaterial.color.setRGB(1, hurt ? 0.6 : 1, hurt ? 0.6 : 1);
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
