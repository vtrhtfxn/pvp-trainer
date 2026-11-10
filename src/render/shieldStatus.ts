import * as THREE from 'three';
import * as C from '../core/constants';
import type { Fighter } from '../game/Fighter';

/** Shield Statuses mod settings, as the renderer uses them. */
export interface ShieldStatusOpts {
  ready: THREE.Color;
  disabled: THREE.Color;
  /** Fade from the disabled colour back to the ready one as the shield recovers. */
  interpolate: boolean;
  /** 0..1: how strongly the colour shows over the shield's own texture. */
  strength: number;
  /** Colour other players' shields too (not only yours). */
  others: boolean;
  /** Your picture for the front of every shield, or null. */
  picture: THREE.Texture | null;
}

const WHITE = new THREE.Color(1, 1, 1);
const tmp = new THREE.Color();

/** How far into an axe's disable a fighter's shield is: 1 just disabled, 0 ready. */
export function shieldDisabled(f: Fighter): number {
  const cd = f.cooldowns.get('shield');
  const v = cd ? cd.ticks / cd.total : f.shieldCooldown / C.SHIELD_DISABLE_TICKS;
  return Math.max(0, Math.min(1, v));
}

/** The colour to multiply a fighter's shield by (written into `out`). */
export function shieldStatusColor(f: Fighter, o: ShieldStatusOpts, out: THREE.Color): THREE.Color {
  const d = shieldDisabled(f);
  if (d <= 0) tmp.copy(o.ready);
  else if (o.interpolate) tmp.copy(o.ready).lerp(o.disabled, d);
  else tmp.copy(o.disabled);
  return out.copy(WHITE).lerp(tmp, o.strength);
}

const pictures = new Map<string, THREE.Texture>();

/** The uploaded picture as a texture (made once; '' → null). */
export function pictureTexture(url: string): THREE.Texture | null {
  if (!url) return null;
  let t = pictures.get(url);
  if (!t) {
    for (const old of pictures.values()) old.dispose();
    pictures.clear();
    const img = new Image();
    t = new THREE.Texture(img);
    const tex = t;
    img.onload = () => (tex.needsUpdate = true);
    img.src = url;
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    // The board's front samples pixels 1–13 × 1–23 of the 64×64 shield texture: stretch the
    // picture over exactly that part.
    t.repeat.set(64 / 12, 64 / 22);
    t.offset.set(-1 / 12, -41 / 22);
    pictures.set(url, t);
  }
  return t;
}
