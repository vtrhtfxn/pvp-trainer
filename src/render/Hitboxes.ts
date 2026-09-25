import * as THREE from 'three';
import { PLAYER_WIDTH } from '../core/constants';
import { lerp } from '../core/math';
import type { Fighter } from '../game/Fighter';

/**
 * Minecraft's F3 + B debug hitboxes:
 *   • white wireframe of the entity bounding box (0.6 × 1.8, 0.6 × 1.5 while sneaking),
 *   • a thin red slab at eye height,
 *   • a blue ray along the look direction — drawn 3 blocks long (the 1.9+ attack reach)
 *     instead of vanilla's 2, so it doubles as a reach guide.
 *
 * The box of a fighter you could currently hit turns yellow, which is the fastest way to
 * feel where 3 blocks actually ends.
 */

const BOX_EDGES = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const EYE_SLAB_HEIGHT = 0.02;

// Drawn through the models, like Minecraft's own hitbox overlay: no depth test, and
// transparent so they land in the pass after every opaque object.
function lineMaterial(color: number, opacity = 1): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    fog: false,
    toneMapped: false,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
  });
}

const WHITE = 0xffffff;
// Yellow rather than green: it is the only hue that stays readable against both the grass
// and the sky.
const IN_REACH = 0xffff55;

class FighterHitbox {
  readonly group = new THREE.Group();
  private readonly box: THREE.LineSegments;
  private readonly eye: THREE.LineSegments;
  private readonly ray: THREE.Line;

  constructor() {
    this.box = new THREE.LineSegments(BOX_EDGES, lineMaterial(WHITE));
    this.eye = new THREE.LineSegments(BOX_EDGES, lineMaterial(0xff3333));
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    this.ray = new THREE.Line(rayGeo, lineMaterial(0x4466ff, 0.85));
    this.group.add(this.box, this.eye, this.ray);
    this.group.renderOrder = 10;
    for (const o of this.group.children) o.renderOrder = 10;
    this.group.visible = false;
  }

  update(f: Fighter, alpha: number, inReach: boolean) {
    const x = lerp(f.prevPos.x, f.pos.x, alpha);
    const y = lerp(f.prevPos.y, f.pos.y, alpha);
    const z = lerp(f.prevPos.z, f.pos.z, alpha);
    const h = f.height();
    const eyeY = f.eyeHeight();

    this.box.position.set(x, y + h / 2, z);
    this.box.scale.set(PLAYER_WIDTH, h, PLAYER_WIDTH);
    (this.box.material as THREE.LineBasicMaterial).color.setHex(inReach ? IN_REACH : WHITE);

    this.eye.position.set(x, y + eyeY, z);
    this.eye.scale.set(PLAYER_WIDTH, EYE_SLAB_HEIGHT, PLAYER_WIDTH);

    this.ray.position.set(x, y + eyeY, z);
    this.ray.rotation.set(f.pitch, f.yaw, 0, 'YXZ');
    this.ray.scale.setScalar(f.entityReach());
  }

  setVisible(v: boolean) {
    this.group.visible = v;
  }
}

export class Hitboxes {
  readonly group = new THREE.Group();
  private readonly player = new FighterHitbox();
  private readonly bot = new FighterHitbox();

  constructor() {
    this.group.add(this.player.group, this.bot.group);
  }

  /**
   * @param showPlayer false in first person — your own box would wrap around the camera.
   * @param playerCanHitBot whether the player's crosshair ray currently reaches the bot.
   * @param botCanHitPlayer whether the bot's crosshair ray currently reaches the player.
   */
  update(
    player: Fighter,
    bot: Fighter,
    alpha: number,
    enabled: boolean,
    showPlayer: boolean,
    playerCanHitBot: boolean,
    botCanHitPlayer: boolean,
  ) {
    this.group.visible = enabled;
    if (!enabled) return;
    this.player.setVisible(showPlayer && !player.dead);
    this.bot.setVisible(!bot.dead);
    if (showPlayer && !player.dead) this.player.update(player, alpha, botCanHitPlayer);
    if (!bot.dead) this.bot.update(bot, alpha, playerCanHitBot);
  }
}

/**
 * The Glowing effect: a white outline around the fighter that shows through walls. (Vanilla
 * outlines the model's silhouette; a box reads the same at a glance and costs nothing.)
 */
export class GlowOutline {
  readonly box: THREE.LineSegments;

  constructor() {
    this.box = new THREE.LineSegments(BOX_EDGES, lineMaterial(WHITE, 0.95));
    this.box.renderOrder = 11;
    this.box.visible = false;
  }

  update(f: Fighter, alpha: number, show: boolean) {
    const on = show && !f.dead && f.effects.has('glowing');
    this.box.visible = on;
    if (!on) return;
    const h = f.height();
    this.box.position.set(lerp(f.prevPos.x, f.pos.x, alpha), lerp(f.prevPos.y, f.pos.y, alpha) + h / 2, lerp(f.prevPos.z, f.pos.z, alpha));
    this.box.scale.set(PLAYER_WIDTH + 0.08, h + 0.08, PLAYER_WIDTH + 0.08);
  }
}

