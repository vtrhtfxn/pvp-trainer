import * as THREE from 'three';

const DEG = Math.PI / 180;

/** Which display block of the item model applies (item/handheld.json, bow.json, …). */
export type ItemKind = 'handheld' | 'generated' | 'bow' | 'crossbow' | 'shield' | 'shield_blocking';
export type HandSide = 'right' | 'left';

interface Display {
  rotation: [number, number, number];
  translation: [number, number, number];
  scale: [number, number, number];
}

type Displays = { thirdR: Display; thirdL?: Display; firstR: Display; firstL?: Display };

const d = (rotation: [number, number, number], translation: [number, number, number], s: number): Display => ({
  rotation,
  translation,
  scale: [s, s, s],
});

// Display transforms from the vanilla item model JSONs. A missing left-hand entry falls back to the
// right-hand one, exactly like ItemTransforms' deserializer.
const DISPLAY: Record<ItemKind, Displays> = {
  handheld: {
    thirdR: d([0, -90, 55], [0, 4, 0.5], 0.85),
    thirdL: d([0, 90, -55], [0, 4, 0.5], 0.85),
    firstR: d([0, -90, 25], [1.13, 3.2, 1.13], 0.68),
    firstL: d([0, 90, -25], [1.13, 3.2, 1.13], 0.68),
  },
  generated: {
    thirdR: d([0, 0, 0], [0, 3, 1], 0.55),
    firstR: d([0, -90, 25], [1.13, 3.2, 1.13], 0.68),
  },
  bow: {
    thirdR: d([-80, 260, -40], [-1, -2, 2.5], 0.9),
    thirdL: d([-80, -280, 40], [-1, -2, 2.5], 0.9),
    firstR: d([0, -90, 25], [1.13, 3.2, 1.13], 0.68),
    firstL: d([0, 90, -25], [1.13, 3.2, 1.13], 0.68),
  },
  crossbow: {
    thirdR: d([-90, 0, -60], [2, 0.1, -3], 0.9),
    thirdL: d([-90, 0, 30], [2, 0.1, -3], 0.9),
    firstR: d([-90, 0, -55], [1.13, 3.2, 1.13], 0.68),
    firstL: d([-90, 0, 35], [1.13, 3.2, 1.13], 0.68),
  },
  shield: {
    thirdR: d([0, 90, 0], [10, 6, -4], 1),
    thirdL: d([0, 90, 0], [10, 6, 12], 1),
    firstR: d([0, 180, 5], [-10, 2, -10], 1.25),
    firstL: d([0, 180, 5], [10, 0, -10], 1.25),
  },
  shield_blocking: {
    thirdR: d([45, 135, 0], [3.51, 11, -2], 1),
    thirdL: d([45, 135, 0], [13.51, 3, 5], 1),
    firstR: d([0, 180, -5], [-15, 5, -11], 1.25),
    firstL: d([0, 180, -5], [5, 5, -11], 1.25),
  },
};

const tmp = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();

/** ItemTransform.apply: the left hand mirrors X translation and the Y/Z rotations. */
function applyDisplay(m: THREE.Matrix4, dsp: Display, left: boolean) {
  const i = left ? -1 : 1;
  m.multiply(tmp.makeTranslation((i * dsp.translation[0]) / 16, dsp.translation[1] / 16, dsp.translation[2] / 16));
  // Quaternionf.rotationXYZ = rotate X, then Y, then Z (intrinsic).
  euler.set(dsp.rotation[0] * DEG, i * dsp.rotation[1] * DEG, i * dsp.rotation[2] * DEG, 'XYZ');
  m.multiply(tmp.makeRotationFromQuaternion(quat.setFromEuler(euler)));
  m.multiply(tmp.makeScale(dsp.scale[0], dsp.scale[1], dsp.scale[2]));
}

/**
 * ItemInHandLayer transform from an arm's pivot (model pixels, our Y-up/+Z-forward frame) to
 * item-model space. Minecraft's model space is Y-down/-Z-forward, hence the (1,-1,-1) flip.
 */
export function thirdPersonItemMatrix(kind: ItemKind, hand: HandSide = 'right'): THREE.Matrix4 {
  const left = hand === 'left';
  const m = new THREE.Matrix4().makeScale(16, 16, 16);
  m.multiply(tmp.makeScale(1, -1, -1));
  m.multiply(tmp.makeRotationX(-90 * DEG));
  m.multiply(tmp.makeRotationY(180 * DEG));
  m.multiply(tmp.makeTranslation((left ? -1 : 1) / 16, 0.125, -0.625));
  const disp = DISPLAY[kind];
  applyDisplay(m, left ? (disp.thirdL ?? disp.thirdR) : disp.thirdR, left);
  return m;
}

export interface FirstPersonPose {
  kind: ItemKind;
  hand: HandSide;
  /** 0 = fully raised, 1 = fully lowered */
  equipProgress: number;
  /** Swing progress of THIS hand (0 when the other hand swings). */
  swingProgress: number;
  /** Food: remaining use ticks minus the partial tick, else null. */
  eatRemaining: number | null;
  eatDuration: number;
  /** Bow / crossbow: ticks the item has been drawn, with partial tick, else null. */
  drawTicks: number | null;
  /** Crossbow charge time (ticks). */
  chargeTicks: number;
  /** A loaded crossbow held in the main hand is aimed down the sights. */
  crossbowCharged: boolean;
}

/** ItemInHandRenderer.applyItemArmTransform */
function armTransform(m: THREE.Matrix4, i: number, equip: number) {
  m.multiply(tmp.makeTranslation(i * 0.56, -0.52 + equip * -0.6, -0.72));
}

/** ItemInHandRenderer.renderArmWithItem, in view space. */
export function firstPersonItemMatrix(out: THREE.Matrix4, pose: FirstPersonPose): THREE.Matrix4 {
  const i = pose.hand === 'right' ? 1 : -1;
  if (pose.eatRemaining !== null) {
    const f = pose.eatRemaining + 1;
    const f1 = f / pose.eatDuration;
    if (f1 < 0.8) out.multiply(tmp.makeTranslation(0, Math.abs(Math.cos((f / 4) * Math.PI) * 0.1), 0));
    const f3 = 1 - Math.pow(f1, 27);
    out.multiply(tmp.makeTranslation(f3 * 0.6 * i, f3 * -0.5, 0));
    out.multiply(tmp.makeRotationY(i * f3 * 90 * DEG));
    out.multiply(tmp.makeRotationX(f3 * 10 * DEG));
    out.multiply(tmp.makeRotationZ(i * f3 * 30 * DEG));
    armTransform(out, i, pose.equipProgress);
  } else if (pose.drawTicks !== null && pose.kind === 'bow') {
    armTransform(out, i, pose.equipProgress);
    out.multiply(tmp.makeTranslation(i * -0.2785682, 0.18344387, 0.15731531));
    out.multiply(tmp.makeRotationX(-13.935 * DEG));
    out.multiply(tmp.makeRotationY(i * 35.3 * DEG));
    out.multiply(tmp.makeRotationZ(i * -9.785 * DEG));
    const t = pose.drawTicks;
    let f = t / 20;
    f = Math.min(1, (f * f + f * 2) / 3);
    if (f > 0.1) {
      const shake = Math.sin((t - 0.1) * 1.3) * (f - 0.1);
      out.multiply(tmp.makeTranslation(0, shake * 0.004, 0));
    }
    out.multiply(tmp.makeTranslation(0, 0, f * 0.04));
    out.multiply(tmp.makeScale(1, 1, 1 + f * 0.2));
    out.multiply(tmp.makeRotationY(-i * 45 * DEG));
  } else if (pose.drawTicks !== null && pose.kind === 'crossbow') {
    armTransform(out, i, pose.equipProgress);
    out.multiply(tmp.makeTranslation(i * -0.4785682, -0.094387, 0.05731531));
    out.multiply(tmp.makeRotationX(-11.935 * DEG));
    out.multiply(tmp.makeRotationY(i * 65.3 * DEG));
    out.multiply(tmp.makeRotationZ(i * -9.785 * DEG));
    const t = pose.drawTicks;
    const f = Math.min(1, t / pose.chargeTicks);
    if (f > 0.1) {
      const shake = Math.sin((t - 0.1) * 1.3) * (f - 0.1);
      out.multiply(tmp.makeTranslation(0, shake * 0.004, 0));
    }
    out.multiply(tmp.makeTranslation(0, 0, f * 0.04));
    out.multiply(tmp.makeScale(1, 1, 1 + f * 0.2));
    out.multiply(tmp.makeRotationY(-i * 45 * DEG));
  } else if (pose.kind === 'crossbow' && pose.crossbowCharged && pose.swingProgress <= 0) {
    armTransform(out, i, pose.equipProgress);
    out.multiply(tmp.makeTranslation(i * -0.641864, 0, 0));
    out.multiply(tmp.makeRotationY(i * 10 * DEG));
  } else if (pose.kind === 'shield_blocking') {
    armTransform(out, i, pose.equipProgress);
  } else {
    const s = pose.swingProgress;
    const f5 = -0.4 * Math.sin(Math.sqrt(s) * Math.PI);
    const f6 = 0.2 * Math.sin(Math.sqrt(s) * Math.PI * 2);
    const f10 = -0.2 * Math.sin(s * Math.PI);
    out.multiply(tmp.makeTranslation(i * f5, f6, f10));
    armTransform(out, i, pose.equipProgress);
    const a = Math.sin(s * s * Math.PI);
    out.multiply(tmp.makeRotationY(i * (45 + a * -20) * DEG));
    const b = Math.sin(Math.sqrt(s) * Math.PI);
    out.multiply(tmp.makeRotationZ(i * b * -20 * DEG));
    out.multiply(tmp.makeRotationX(b * -80 * DEG));
    out.multiply(tmp.makeRotationY(i * -45 * DEG));
  }
  const disp = DISPLAY[pose.kind];
  const left = pose.hand === 'left';
  applyDisplay(out, left ? (disp.firstL ?? disp.firstR) : disp.firstR, left);
  return out;
}
