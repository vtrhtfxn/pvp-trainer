import * as THREE from 'three';
import { packImage } from './pack';
import { glintTexture } from './textures';

/** Vanilla scrolls the glint with these speeds (RenderSystem.setupGlintTexturing). */
const ROTATION = 0.17453292; // 10°
const ITEM_SCALE = 8;
const ARMOR_SCALE = 0.16;

interface Shared {
  uGlint: { value: THREE.Texture };
  /** Row-major 2×2 of the texture transform (uv' = M·uv + t), then t. */
  uM: { value: THREE.Vector4 };
  uT: { value: THREE.Vector2 };
  scale: number;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D uMask;
uniform sampler2D uGlint;
uniform vec4 uM;
uniform vec2 uT;
uniform vec4 uTint;
varying vec2 vUv;
void main() {
  // The glint only lies where the thing itself is: transparent texels of the item or armor
  // texture get none (vanilla gets the same result by depth-testing EQUAL against the item).
  if (texture2D(uMask, vUv).a < 0.1) discard;
  vec2 g = vec2(uM.x * vUv.x + uM.y * vUv.y, uM.z * vUv.x + uM.w * vUv.y) + uT;
  vec3 c = texture2D(uGlint, g).rgb;
  // Glint Colorizer: the pattern's brightness in another colour (uTint.a = 1), else as it is.
  float lum = max(c.r, max(c.g, c.b));
  c = mix(c, uTint.rgb * lum, uTint.a);
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

function glintSource(name: string): THREE.Texture {
  const img = packImage(name);
  const t = img ? new THREE.Texture(img) : glintTexture();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // Vanilla draws it with linear filtering (blur = true).
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

function shared(name: string, scale: number): Shared {
  return { uGlint: { value: glintSource(name) }, uM: { value: new THREE.Vector4(scale, 0, 0, scale) }, uT: { value: new THREE.Vector2() }, scale };
}

/**
 * The enchantment glint: the pack's own glint textures, scrolled and turned like vanilla's, added
 * onto the item, armor or elytra it belongs to and clipped to that texture's opaque pixels. One
 * instance serves every model; each mesh gets a cheap material that just names its mask.
 */
/** Glint Colorizer settings (null: vanilla purple). */
export interface GlintColor {
  color: THREE.Color;
  rainbow: boolean;
  speed: number;
  strength: number;
}

export class Glint {
  /** One colour for every glint: rgb, and a = 1 when recoloured. */
  private readonly tint = { value: new THREE.Vector4(1, 1, 1, 0) };
  colorize: GlintColor | null = null;
  private readonly hsl = new THREE.Color();

  private readonly item = shared('misc/enchanted_glint_item', ITEM_SCALE);
  private readonly armor = shared('misc/enchanted_glint_armor', ARMOR_SCALE);

  private material(s: Shared, mask: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: { uMask: { value: mask }, uGlint: s.uGlint, uM: s.uM, uT: s.uT, uTint: this.tint },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
      // GLINT_TRANSPARENCY: src colour × src colour, added onto what is already there.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcColorFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      fog: false,
    });
  }

  /** Glint for a held item, clipped to its sprite. */
  itemMaterial(mask: THREE.Texture): THREE.ShaderMaterial {
    return this.material(this.item, mask);
  }

  /** Glint for armor and elytra, clipped to the armor layer texture. */
  armorMaterial(mask: THREE.Texture): THREE.ShaderMaterial {
    return this.material(this.armor, mask);
  }

  /**
   * Compiles the glint's shader now, so the first enchanted item you pick up does not hitch the
   * frame while the driver builds it.
   */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    const scene = new THREE.Scene();
    const mask = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    mask.needsUpdate = true;
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.itemMaterial(mask)));
    renderer.compile(scene, camera);
  }

  /** Moves the pattern; `timeSec` is the game clock. */
  update(timeSec: number) {
    // Util.getMillis() * 8: one slow drift across, one faster drift down, rotated 10°.
    const l = timeSec * 1000 * 8;
    const f = (l % 110000) / 110000;
    const g = (l % 30000) / 30000;
    const c = Math.cos(ROTATION);
    const s = Math.sin(ROTATION);
    const k = this.colorize;
    if (!k) this.tint.value.set(1, 1, 1, 0);
    else {
      const col = k.rainbow ? this.hsl.setHSL((timeSec * 0.25 * k.speed) % 1, 1, 0.55) : k.color;
      // (Twice as bright: the glint pattern's own brightness only reaches about half.)
      this.tint.value.set(col.r * 2 * k.strength, col.g * 2 * k.strength, col.b * 2 * k.strength, 1);
    }
    for (const sh of [this.item, this.armor]) {
      sh.uM.value.set(sh.scale * c, -sh.scale * s, sh.scale * s, sh.scale * c);
      sh.uT.value.set(-f, g);
    }
  }
}
