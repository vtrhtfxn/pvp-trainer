import * as THREE from 'three';

/**
 * Motion Blur mod: each frame, the last frame is laid back over the new one, more strongly the
 * faster the camera turns. A quick flick leaves a smear along the way you turned; while you hold
 * still (or turn slowly) nothing is mixed in at all. Drawn before the hands and the crosshair, so
 * those stay sharp.
 */
export class MotionBlur {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private prev: THREE.FramebufferTexture | null = null;
  private readonly lastDir = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private hasLast = false;
  /** Smoothed turn speed, rad/s. */
  private speed = 0;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPrev: { value: null }, uAmount: { value: 0 } },
      // A plain copy: the bytes on screen go back on screen (no colour conversions).
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: 'uniform sampler2D uPrev; uniform float uAmount; varying vec2 vUv; void main() { gl_FragColor = vec4(texture2D(uPrev, vUv).rgb, uAmount); }',
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  apply(renderer: THREE.WebGLRenderer, camera: THREE.Camera, dt: number, opts: { strength: number; threshold: number } | null) {
    camera.getWorldDirection(this.dir);
    if (this.hasLast && dt > 0) {
      const turn = Math.acos(Math.min(1, Math.max(-1, this.dir.dot(this.lastDir)))) / dt;
      this.speed += (turn - this.speed) * Math.min(1, dt * 20);
    }
    this.lastDir.copy(this.dir);
    this.hasLast = true;
    if (!opts) {
      this.dispose();
      return;
    }
    const w = renderer.domElement.width;
    const h = renderer.domElement.height;
    if (!this.prev || this.prev.image.width !== w || this.prev.image.height !== h) {
      this.dispose();
      this.prev = new THREE.FramebufferTexture(w, h);
      this.material.uniforms.uPrev.value = this.prev;
      // (The first frame has nothing to blend with yet.)
      renderer.copyFramebufferToTexture(this.prev);
      return;
    }
    // From the threshold, the mix grows with the turn speed up to the strength (reached at
    // threshold + about 4 rad/s, a fast flick).
    const over = Math.max(0, this.speed - opts.threshold);
    const amount = opts.strength * Math.min(1, over / 4);
    if (amount > 0.01) {
      this.material.uniforms.uAmount.value = amount;
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(this.scene, this.camera);
      renderer.autoClear = auto;
    }
    renderer.copyFramebufferToTexture(this.prev);
  }

  private dispose() {
    this.prev?.dispose();
    this.prev = null;
  }
}
