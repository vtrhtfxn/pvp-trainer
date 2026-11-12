import * as THREE from 'three';
import type { Fighter } from '../game/Fighter';
import { packTexture } from './itemMesh';

/**
 * The crosshair, drawn in WebGL the way vanilla draws it (Gui.renderCrosshair): white, blended
 * ONE_MINUS_DST_COLOR / ONE_MINUS_SRC_COLOR, so it inverts whatever is behind it.
 *
 * It used to be a CSS element with mix-blend-mode: difference over the canvas. That made the
 * browser blend the whole page through an extra offscreen surface every frame, and on macOS it
 * kept the game canvas off the compositor's fast overlay path — more GPU work and more latency
 * for a 9-pixel plus sign.
 */
/** What the attack indicator shows: the full-strength sign, or how many of its 16 pixels are charged. */
export type AttackIndicator = { full: true } | { full: false; filled: number } | null;

/**
 * Gui.renderCrosshair's attack indicator for `player`: the full-strength sign when a fully charged
 * hit is on someone in reach (`aiming`), else the bar while the attack is charging. 1.8 combat has
 * no cooldown, so no indicator.
 */
export function attackIndicatorFor(player: Fighter, aiming: boolean): AttackIndicator {
  if (player.dead || player.world.legacyCombat) return null;
  const charge = player.attackStrengthScale(0);
  if (aiming && charge >= 1 && player.attackDelay() > 5) return { full: true };
  return charge < 1 ? { full: false, filled: Math.floor(charge * 17) } : null;
}

/** The inverting blend vanilla draws the crosshair and its attack indicator with. */
function invertMaterial(map: THREE.Texture | null = null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // The sprites' transparent pixels draw nothing (inverting by zero would still darken a little).
    alphaTest: map ? 0.1 : 0,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneMinusDstColorFactor,
    blendDst: THREE.OneMinusSrcColorFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    toneMapped: false,
    fog: false,
  });
}

/** One sprite quad: placed in buffer pixels, `u1` of its width shown (the progress bar's charge). */
class Sprite {
  readonly mesh: THREE.Mesh;
  private key = '';
  constructor(
    readonly name: string,
    scene: THREE.Scene,
  ) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), invertMaterial(packTexture(name)));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  place(x0: number, y0: number, w: number, h: number, u1 = 1) {
    const key = `${x0},${y0},${w},${h},${u1}`;
    if (key === this.key) return;
    this.key = key;
    const x1 = x0 + w * u1;
    const y1 = y0 - h;
    const g = new THREE.BufferGeometry();
    // (y0 is the top edge; the camera's y runs up.)
    g.setAttribute('position', new THREE.Float32BufferAttribute([x0, y1, 0, x1, y1, 0, x1, y0, 0, x0, y1, 0, x1, y0, 0, x0, y0, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, u1, 0, u1, 1, 0, 0, u1, 1, 0, 1], 2));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }
}

export class Crosshair {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly mesh: THREE.Mesh;
  private key = '';
  /** Vanilla's attack indicator sprites (a resource pack's own, when it has them). */
  private readonly background: Sprite;
  private readonly progress: Sprite;
  private readonly full: Sprite;
  private px = 2;

  constructor() {
    this.background = new Sprite('gui/sprites/hud/crosshair_attack_indicator_background', this.scene);
    this.progress = new Sprite('gui/sprites/hud/crosshair_attack_indicator_progress', this.scene);
    this.full = new Sprite('gui/sprites/hud/crosshair_attack_indicator_full', this.scene);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneMinusDstColorFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
      fog: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  /**
   * Fits the plus sign to a `width`×`height` drawing buffer: 9×9 GUI pixels, each `px` buffer
   * pixels, centred and snapped to whole pixels so the lines stay crisp.
   */
  private fit(width: number, height: number, px: number) {
    const key = `${width}x${height}@${px}`;
    if (key === this.key) return;
    this.key = key;
    this.camera.left = 0;
    this.camera.right = width;
    this.camera.top = height;
    this.camera.bottom = 0;
    this.camera.updateProjectionMatrix();
    const s = Math.max(1, Math.round(px));
    this.px = s;
    const x0 = Math.round(width / 2 - 4.5 * s);
    const y0 = Math.round(height / 2 - 4.5 * s);
    // Vertical bar (x 4..5, y 0..9), then the two horizontal halves (y 4..5) so the centre pixel
    // is covered once — covered twice, the inversion would cancel out there.
    const rects = [
      [4, 0, 5, 9],
      [0, 4, 4, 5],
      [5, 4, 9, 5],
    ];
    const pos: number[] = [];
    for (const [a, b, c, d] of rects) {
      const X0 = x0 + a * s;
      const X1 = x0 + c * s;
      const Y0 = y0 + b * s;
      const Y1 = y0 + d * s;
      pos.push(X0, Y0, 0, X1, Y0, 0, X1, Y1, 0, X0, Y0, 0, X1, Y1, 0, X0, Y1, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /**
   * Gui.renderCrosshair: the plus sign (if `plus`), and under it the attack indicator — 16 GUI
   * pixels wide, its top 9 below the centre: the background bar with the charged part over it
   * (in 16 steps), or the full-strength sign when a fully charged hit is on someone in reach.
   */
  render(renderer: THREE.WebGLRenderer, guiScale: number, plus = true, indicator: AttackIndicator = null) {
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    // The canvas fills the window. Reading its clientWidth here forced a full layout every frame,
    // right after the HUD had written to the DOM.
    const cssW = window.innerWidth || w;
    this.fit(w, h, guiScale * (w / cssW));
    this.mesh.visible = plus;
    const s = this.px;
    const x0 = Math.round(w / 2 - 8 * s);
    const top = Math.round(h / 2 - 9 * s);
    this.full.mesh.visible = !!indicator && indicator.full;
    const bar = !!indicator && !indicator.full;
    this.background.mesh.visible = bar;
    this.progress.mesh.visible = bar && indicator.filled > 0;
    if (indicator?.full) this.full.place(x0, top, 16 * s, 16 * s);
    else if (indicator) {
      this.background.place(x0, top, 16 * s, 4 * s);
      this.progress.place(x0, top, 16 * s, 4 * s, Math.min(16, indicator.filled) / 16);
    }
    if (!plus && !indicator) return;
    renderer.render(this.scene, this.camera);
  }
}
