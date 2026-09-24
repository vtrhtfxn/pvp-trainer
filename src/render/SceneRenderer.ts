import * as THREE from 'three';
import { lerp } from '../core/math';
import { rayDistanceToTarget } from '../game/combat';
import { Fighter } from '../game/Fighter';
import type { World } from '../game/World';
import { Arena, SKY_HORIZON } from './Arena';
import { ArrowView } from './Arrows';
import { BlocksView } from './BlocksView';
import { FireView } from './FireView';
import { ThrownView } from './ThrownView';
import type { Assets } from './assets';
import { FirstPersonView } from './FirstPerson';
import { Hitboxes } from './Hitboxes';
import { Nametag } from './Nametag';
import { Particles } from './Particles';
import { PlayerModel } from './PlayerModel';
import { glintTexture } from './textures';

const DEG = Math.PI / 180;

// Scratch objects reused every frame. Allocating matrices per frame is the kind of garbage
// that turns into visible hitching once particles and two player models are also churning.
const tmpMat = new THREE.Matrix4();
const orientMat = new THREE.Matrix4();
const camMat = new THREE.Matrix4();
const shakeInv = new THREE.Matrix4();
const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const backVec = new THREE.Vector3();

export interface ViewSettings {
  fov: number;
  fovEffects: number;
  viewBobbing: boolean;
  damageTilt: number;
  showHitboxes: boolean;
}

export type CameraMode = 'first' | 'third' | 'orbit';

/** Owns the WebGL renderer, the world scene, both fighter models and the first-person view. */
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.05, 600);
  readonly arena: Arena;
  readonly particles = new Particles();
  readonly playerModel: PlayerModel;
  readonly botModel: PlayerModel;
  readonly nametag = new Nametag();
  readonly hitboxes = new Hitboxes();
  readonly firstPerson: FirstPersonView;
  readonly arrows = new ArrowView();
  readonly thrown = new ThrownView();
  readonly blocks = new BlocksView();
  private readonly playerFire = new FireView();
  private readonly botFire = new FireView();
  // Inventory-screen player preview: its own tiny scene, rendered off-screen.
  private readonly previewScene = new THREE.Scene();
  private readonly previewCamera = new THREE.OrthographicCamera(-0.8, 0.8, 1.15, -1.15, 0.1, 10);
  private readonly previewModel: PlayerModel;
  private readonly previewFighter: Fighter;
  private previewTarget: THREE.WebGLRenderTarget | null = null;
  private previewBuf: Uint8Array | null = null;
  private previewImg: ImageData | null = null;
  private readonly glint: THREE.CanvasTexture;
  private readonly viewShake = new THREE.Matrix4();
  cameraMode: CameraMode = 'orbit';
  /** Device pixel ratio actually in use; lowered automatically when frames get slow. */
  private pixelRatio = 1;
  private readonly maxPixelRatio: number;
  private smoothedFrameMs = 16;
  private adaptCooldown = 0;

  constructor(canvas: HTMLCanvasElement, world: World, assets: Assets) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.autoClear = false;
    this.scene.background = SKY_HORIZON.clone();
    this.scene.fog = new THREE.Fog(SKY_HORIZON.clone(), 55, 150);

    // Entity lighting close to Minecraft's two fixed light directions + ambient
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.5 * Math.PI));
    const l0 = new THREE.DirectionalLight(0xffffff, 0.45 * Math.PI);
    l0.position.set(0.2, 1, -0.7);
    const l1 = new THREE.DirectionalLight(0xffffff, 0.45 * Math.PI);
    l1.position.set(-0.2, 1, 0.7);
    this.scene.add(l0, l1);

    this.arena = new Arena(world);
    this.scene.add(this.arena.group);
    this.scene.add(this.particles.group);

    this.glint = glintTexture();
    this.glint.repeat.set(2, 2);
    const glintMat = new THREE.MeshBasicMaterial({
      map: this.glint,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      depthFunc: THREE.LessEqualDepth,
      opacity: 0.65,
      fog: false,
    });
    this.playerModel = new PlayerModel(assets, glintMat);
    this.botModel = new PlayerModel(assets, glintMat);
    this.scene.add(this.playerModel.root, this.playerModel.shadow, this.botModel.root, this.botModel.shadow);
    this.scene.add(this.nametag.sprite);
    this.scene.add(this.hitboxes.group);
    this.firstPerson = new FirstPersonView(assets, glintMat);
    this.scene.add(this.arrows.group, this.thrown.group, this.playerFire.group, this.botFire.group, this.blocks.group);

    this.previewModel = new PlayerModel(assets, glintMat);
    this.previewModel.shadow.visible = false;
    this.previewFighter = new Fighter('player', 'preview', world);
    this.previewScene.add(new THREE.AmbientLight(0xffffff, 0.55 * Math.PI));
    const pl = new THREE.DirectionalLight(0xffffff, 0.5 * Math.PI);
    pl.position.set(0.3, 0.8, -1);
    this.previewScene.add(pl, this.previewModel.root);
    this.previewCamera.position.set(0, 1.0, -4);
    this.previewCamera.lookAt(0, 1.0, 0);
    this.resize();
  }

  /**
   * Trades resolution for frame rate when a machine cannot keep up.
   *
   * A school PC on integrated graphics at a 2× device pixel ratio is drawing four times the
   * pixels it needs to; dropping the ratio is invisible next to the stutter it removes. Rises
   * back on its own once frames are comfortable again.
   */
  private adaptResolution(dt: number) {
    const ms = Math.min(dt * 1000, 100);
    this.smoothedFrameMs += (ms - this.smoothedFrameMs) * 0.1;
    if (this.adaptCooldown > 0) {
      this.adaptCooldown -= dt;
      return;
    }
    const min = 0.7;
    let next = this.pixelRatio;
    if (this.smoothedFrameMs > 22 && this.pixelRatio > min) next = Math.max(min, this.pixelRatio - 0.25);
    else if (this.smoothedFrameMs < 13 && this.pixelRatio < this.maxPixelRatio) next = Math.min(this.maxPixelRatio, this.pixelRatio + 0.25);
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.resize();
      // Settle before reacting again, so it cannot oscillate every frame.
      this.adaptCooldown = 1.5;
    }
  }

  /**
   * InventoryScreen.renderEntityInInventoryFollowsMouse: draws the player (with its real armor
   * and held items) into `canvas`, turning body and head toward the mouse.
   */
  renderPreview(canvas: HTMLCanvasElement, p: Fighter, mouseX: number, mouseY: number) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(8, Math.round(rect.width));
    const h = Math.max(8, Math.round(rect.height));
    if (canvas.width !== w || canvas.height !== h || !this.previewTarget) {
      canvas.width = w;
      canvas.height = h;
      this.previewTarget?.dispose();
      this.previewTarget = new THREE.WebGLRenderTarget(w, h);
      this.previewTarget.texture.colorSpace = THREE.SRGBColorSpace;
      this.previewBuf = new Uint8Array(w * h * 4);
      this.previewImg = new ImageData(w, h);
      // Keep the whole player (2.3 blocks with margin) in view at the window's aspect ratio.
      const half = 1.15 * (w / h);
      this.previewCamera.left = -half;
      this.previewCamera.right = half;
      this.previewCamera.updateProjectionMatrix();
    }
    const f = this.previewFighter;
    f.inventory = p.inventory;
    f.selected = p.selected;
    f.offhand = p.offhand;
    f.armorSlots = p.armorSlots;
    f.pos.set(0, 0, 0);
    f.prevPos.set(0, 0, 0);
    const dx = (rect.left + rect.width / 2 - mouseX) / (rect.width * 0.5);
    const dy = (rect.top + rect.height * 0.3 - mouseY) / (rect.height * 0.5);
    // The model faces -Z at yaw 0; the camera sits on -Z, so yaw 0 looks straight out of the window.
    const body = Math.atan(dx * 0.6) * 0.35;
    f.bodyYaw = f.prevBodyYaw = -body;
    f.yaw = f.prevYaw = -(body + Math.atan(dx * 0.6) * 0.6);
    f.pitch = f.prevPitch = Math.atan(dy * 0.6) * 0.5;
    this.previewModel.update(f, 1, 0);

    const r = this.renderer;
    const prev = r.getRenderTarget();
    const prevColor = new THREE.Color();
    r.getClearColor(prevColor);
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.previewTarget);
    r.setClearColor(0x000000, 1);
    r.clear();
    r.render(this.previewScene, this.previewCamera);
    r.readRenderTargetPixels(this.previewTarget!, 0, 0, w, h, this.previewBuf!);
    r.setRenderTarget(prev);
    r.setClearColor(prevColor, prevAlpha);
    const img = this.previewImg!;
    const buf = this.previewBuf!;
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    canvas.getContext('2d')!.putImageData(img, 0, 0);
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Camera for the local player: eye position, Minecraft view bobbing, damage tilt, FOV. */
  private placePlayerCamera(p: Fighter, a: number, view: ViewSettings) {
    const eyeY = p.eyeHeight();
    const ex = lerp(p.prevPos.x, p.pos.x, a);
    const ey = lerp(p.prevPos.y, p.pos.y, a) + eyeY;
    const ez = lerp(p.prevPos.z, p.pos.z, a);

    // viewShake = bobHurt · bobView (applied in view space)
    const m = this.viewShake.identity();
    const tmp = tmpMat;
    const hurtT = p.hurtTime - a;
    if (p.dead) {
      const f = Math.min(p.deathTime + a, 20);
      m.multiply(tmp.makeRotationZ((40 - 8000 / (f + 200)) * DEG));
    } else if (hurtT >= 0 && view.damageTilt > 0) {
      let f = hurtT / p.hurtDuration;
      f = Math.sin(f * f * f * f * Math.PI);
      m.multiply(tmp.makeRotationY(-p.hurtDir * DEG));
      m.multiply(tmp.makeRotationZ(-f * 14 * view.damageTilt * DEG));
      m.multiply(tmp.makeRotationY(p.hurtDir * DEG));
    }
    if (view.viewBobbing) {
      const walk = -lerp(p.walkDistO, p.walkDist, a);
      const bob = lerp(p.oBob, p.bob, a);
      m.multiply(tmp.makeTranslation(Math.sin(walk * Math.PI) * bob * 0.5, -Math.abs(Math.cos(walk * Math.PI) * bob), 0));
      m.multiply(tmp.makeRotationZ(Math.sin(walk * Math.PI) * bob * 3 * DEG));
      m.multiply(tmp.makeRotationX(Math.abs(Math.cos(walk * Math.PI - 0.2) * bob) * 5 * DEG));
    }

    tmpEuler.set(p.pitch, p.yaw, 0, 'YXZ');
    const orient = orientMat.makeRotationFromEuler(tmpEuler);
    const camWorld = camMat;
    if (this.cameraMode === 'third') {
      // Behind the player, pulled in if it would leave the arena
      const back = backVec.set(0, 0, 1).applyMatrix4(orient);
      let dist = 4;
      const limit = p.world.half - 0.3;
      for (let d = 0.5; d <= 4; d += 0.25) {
        const cx = ex + back.x * d;
        const cy = ey + back.y * d;
        const cz = ez + back.z * d;
        if (Math.abs(cx) > limit || Math.abs(cz) > limit || cy < 0.2) {
          dist = d - 0.25;
          break;
        }
      }
      camWorld.makeTranslation(ex + back.x * dist, ey + back.y * dist, ez + back.z * dist);
    } else {
      camWorld.makeTranslation(ex, ey, ez);
    }
    camWorld.multiply(orient).multiply(shakeInv.copy(m).invert());
    camWorld.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);

    const fovMod = lerp(p.oFovModifier, p.fovModifier, a);
    const eff = 1 + (fovMod - 1) * view.fovEffects;
    this.camera.fov = view.fov * eff;
    this.camera.updateProjectionMatrix();
  }

  private placeOrbitCamera(time: number, a: Fighter, b: Fighter, alpha: number) {
    const cx = (lerp(a.prevPos.x, a.pos.x, alpha) + lerp(b.prevPos.x, b.pos.x, alpha)) / 2;
    const cz = (lerp(a.prevPos.z, a.pos.z, alpha) + lerp(b.prevPos.z, b.pos.z, alpha)) / 2;
    const ang = time * 0.12;
    const r = 11;
    this.camera.position.set(cx * 0.5 + Math.cos(ang) * r, 5.5, cz * 0.5 + Math.sin(ang) * r);
    this.camera.lookAt(cx, 1.2, cz);
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
  }

  render(
    player: Fighter,
    bot: Fighter,
    alpha: number,
    time: number,
    dt: number,
    view: ViewSettings,
    tag: { name: string; color: string; status: string } | null,
  ) {
    this.adaptResolution(dt);
    if (this.cameraMode === 'orbit') this.placeOrbitCamera(time, player, bot, alpha);
    else this.placePlayerCamera(player, alpha, view);

    this.arena.update(time, this.camera);
    this.glint.offset.set((time * 0.12) % 1, (time * 0.05) % 1);

    const firstPerson = this.cameraMode === 'first';
    this.playerModel.setVisible(!firstPerson);
    this.playerModel.update(player, alpha, time);
    this.botModel.setVisible(true);
    this.botModel.update(bot, alpha, time);

    if (tag) {
      this.nametag.set(tag.name, tag.color, bot.health, bot.absorption, tag.status);
      this.nametag.sprite.position.set(
        lerp(bot.prevPos.x, bot.pos.x, alpha),
        lerp(bot.prevPos.y, bot.pos.y, alpha) + (bot.sneaking ? 1.95 : 2.28),
        lerp(bot.prevPos.z, bot.pos.z, alpha),
      );
    }
    // Hidden when dead or when the camera is practically inside it (it would fill the screen)
    this.nametag.sprite.visible = !!tag && !bot.dead && this.nametag.sprite.position.distanceTo(this.camera.position) > 1.6;

    this.hitboxes.update(
      player,
      bot,
      alpha,
      view.showHitboxes,
      !firstPerson,
      // Only pay for the reach tests when the boxes are actually drawn.
      view.showHitboxes && rayDistanceToTarget(player, bot) >= 0,
      view.showHitboxes && rayDistanceToTarget(bot, player) >= 0,
    );

    this.arrows.update(player.world.arrows, alpha);
    this.thrown.update(player.world.thrown, player.world.orbs, alpha, time, player.world.items);
    this.blocks.update(player.world.blocks, player.world.fighters, player, this.cameraMode !== 'orbit', time);
    this.playerFire.update(player, alpha, this.camera, time, !firstPerson);
    this.botFire.update(bot, alpha, this.camera, time, true);
    this.particles.setViewport(this.renderer.domElement.height, this.camera.fov);
    this.particles.update(dt);

    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    if (firstPerson && !player.dead) {
      this.firstPerson.update(player, alpha, this.viewShake, this.camera.aspect);
      this.renderer.clearDepth();
      this.renderer.render(this.firstPerson.scene, this.firstPerson.camera);
    }
  }
}
