import * as THREE from 'three';

/**
 * The crosshair, drawn in WebGL the way vanilla draws it (Gui.renderCrosshair): white, blended
 * ONE_MINUS_DST_COLOR / ONE_MINUS_SRC_COLOR, so it inverts whatever is behind it.
 *
 * It used to be a CSS element with mix-blend-mode: difference over the canvas. That made the
 * browser blend the whole page through an extra offscreen surface every frame, and on macOS it
 * kept the game canvas off the compositor's fast overlay path — more GPU work and more latency
 * for a 9-pixel plus sign.
 */
export class Crosshair {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly mesh: THREE.Mesh;
  private key = '';

  constructor() {
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

  render(renderer: THREE.WebGLRenderer, guiScale: number) {
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    const cssW = renderer.domElement.clientWidth || w;
    this.fit(w, h, guiScale * (w / cssW));
    renderer.render(this.scene, this.camera);
  }
}
