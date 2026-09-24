import * as THREE from 'three';

const DEG = Math.PI / 180;

export type ItemKind = 'handheld' | 'generated';

interface Display {
  rotation: [number, number, number];
  translation: [number, number, number];
  scale: [number, number, number];
}

// Display transforms from Minecraft's item/handheld.json and item/generated.json.
const DISPLAY: Record<ItemKind, { third: Display; first: Display }> = {
  handheld: {
    third: { rotation: [0, -90, 55], translation: [0, 4, 0.5], scale: [0.85, 0.85, 0.85] },
    first: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
  },
  generated: {
    third: { rotation: [0, 0, 0], translation: [0, 3, 1], scale: [0.55, 0.55, 0.55] },
    first: { rotation: [0, -90, 25], translation: [1.13, 3.2, 1.13], scale: [0.68, 0.68, 0.68] },
  },
};

const tmp = new THREE.Matrix4();
const euler = new THREE.Euler();

function applyDisplay(m: THREE.Matrix4, d: Display) {
  m.multiply(tmp.makeTranslation(d.translation[0] / 16, d.translation[1] / 16, d.translation[2] / 16));
  m.multiply(tmp.makeRotationFromEuler(euler.set(d.rotation[0] * DEG, d.rotation[1] * DEG, d.rotation[2] * DEG, 'XYZ')));
  m.multiply(tmp.makeScale(d.scale[0], d.scale[1], d.scale[2]));
}

/**
 * ItemInHandLayer transform from the right arm's pivot (model pixels, our Y-up/+Z-forward frame)
 * to item-model space. Minecraft's model space is Y-down/-Z-forward, hence the (1,-1,-1) flip.
 */
export function thirdPersonItemMatrix(kind: ItemKind): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeScale(16, 16, 16);
  m.multiply(tmp.makeScale(1, -1, -1));
  m.multiply(tmp.makeRotationX(-90 * DEG));
  m.multiply(tmp.makeRotationY(180 * DEG));
  m.multiply(tmp.makeTranslation(1 / 16, 0.125, -0.625));
  applyDisplay(m, DISPLAY[kind].third);
  return m;
}

export interface FirstPersonPose {
  kind: ItemKind;
  /** 0 = fully raised, 1 = fully lowered */
  equipProgress: number;
  swingProgress: number;
  /** Remaining use ticks minus partial tick when eating, else null. */
  eatRemaining: number | null;
  eatDuration: number;
}

/** ItemInHandRenderer.renderArmWithItem for the right hand, in view space. */
export function firstPersonItemMatrix(out: THREE.Matrix4, pose: FirstPersonPose): THREE.Matrix4 {
  const i = 1; // right hand
  if (pose.eatRemaining !== null) {
    const f = pose.eatRemaining + 1;
    const f1 = f / pose.eatDuration;
    if (f1 < 0.8) out.multiply(tmp.makeTranslation(0, Math.abs(Math.cos((f / 4) * Math.PI) * 0.1), 0));
    const f3 = 1 - Math.pow(f1, 27);
    out.multiply(tmp.makeTranslation(f3 * 0.6 * i, f3 * -0.5, 0));
    out.multiply(tmp.makeRotationY(i * f3 * 90 * DEG));
    out.multiply(tmp.makeRotationX(f3 * 10 * DEG));
    out.multiply(tmp.makeRotationZ(i * f3 * 30 * DEG));
    out.multiply(tmp.makeTranslation(i * 0.56, -0.52 + pose.equipProgress * -0.6, -0.72));
  } else {
    const s = pose.swingProgress;
    const f5 = -0.4 * Math.sin(Math.sqrt(s) * Math.PI);
    const f6 = 0.2 * Math.sin(Math.sqrt(s) * Math.PI * 2);
    const f10 = -0.2 * Math.sin(s * Math.PI);
    out.multiply(tmp.makeTranslation(i * f5, f6, f10));
    out.multiply(tmp.makeTranslation(i * 0.56, -0.52 + pose.equipProgress * -0.6, -0.72));
    const a = Math.sin(s * s * Math.PI);
    out.multiply(tmp.makeRotationY(i * (45 + a * -20) * DEG));
    const b = Math.sin(Math.sqrt(s) * Math.PI);
    out.multiply(tmp.makeRotationZ(i * b * -20 * DEG));
    out.multiply(tmp.makeRotationX(b * -80 * DEG));
    out.multiply(tmp.makeRotationY(i * -45 * DEG));
  }
  applyDisplay(out, DISPLAY[pose.kind].first);
  return out;
}
