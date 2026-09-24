import * as THREE from 'three';
import { lerp } from '../core/math';
import type { DroppedItem } from '../game/DroppedItem';
import type { ItemStack } from '../game/items';
import type { Thrown } from '../game/Thrown';
import type { XpOrb } from '../game/XpOrb';
import { itemIcon } from './itemIcons';
import { packTexture } from './itemMesh';

/** ExperienceOrb.getIcon: which of the 16 orb sprites a value uses. */
function orbIcon(v: number): number {
  const steps = [2477, 1237, 617, 307, 149, 73, 37, 17, 7, 3];
  for (let i = 0; i < steps.length; i++) if (v >= steps[i]) return 10 - i;
  return 0;
}

/**
 * Thrown potions and XP bottles (ThrownItemRenderer: the item icon as a camera-facing
 * billboard) and experience orbs (ExperienceOrbRenderer: a pulsing green-yellow sprite).
 * Pooled; textures are shared per item.
 */
export class ThrownView {
  readonly group = new THREE.Group();
  private readonly items: THREE.Sprite[] = [];
  private readonly orbs: THREE.Sprite[] = [];
  private readonly itemMats = new Map<string, THREE.SpriteMaterial>();
  private readonly orbMats: THREE.SpriteMaterial[] = [];
  private readonly drops: THREE.Sprite[] = [];
  private readonly stackMats = new Map<string, THREE.SpriteMaterial>();

  /** A billboard of the item's GUI icon (dropped items render flat-ish at this size anyway). */
  private stackMat(s: ItemStack): THREE.SpriteMaterial {
    const key = `${s.id}:${s.potion ?? ''}`;
    let m = this.stackMats.get(key);
    if (!m) {
      const icon = itemIcon(s);
      const tex = icon ? new THREE.CanvasTexture(icon) : null;
      if (tex) {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
      }
      m = new THREE.SpriteMaterial({ map: tex, alphaTest: 0.1 });
      this.stackMats.set(key, m);
    }
    return m;
  }

  private itemMat(t: Thrown): THREE.SpriteMaterial {
    const key = t.kind === 'xp' ? 'xp' : (t.potion ?? 'healing');
    let m = this.itemMats.get(key);
    if (!m) {
      const icon = itemIcon(t.kind === 'xp' ? { id: 'experience_bottle', count: 1 } : { id: 'splash_potion', count: 1, potion: t.potion ?? 'healing' });
      const tex = icon ? new THREE.CanvasTexture(icon) : null;
      if (tex) {
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
      }
      m = new THREE.SpriteMaterial({ map: tex, alphaTest: 0.1 });
      this.itemMats.set(key, m);
    }
    return m;
  }

  private orbMat(icon: number): THREE.SpriteMaterial {
    let m = this.orbMats[icon];
    if (!m) {
      const base = packTexture('entity/experience_orb');
      const tex = base ? base.clone() : null;
      if (tex) {
        tex.repeat.set(0.25, 0.25);
        tex.offset.set((icon % 4) * 0.25, 1 - (Math.floor(icon / 4) + 1) * 0.25);
        tex.needsUpdate = true;
      }
      m = new THREE.SpriteMaterial({ map: tex, alphaTest: 0.1, color: 0xffff00 });
      this.orbMats[icon] = m;
    }
    return m;
  }

  update(thrown: readonly Thrown[], orbs: readonly XpOrb[], a: number, time: number, items: readonly DroppedItem[] = []) {
    while (this.drops.length < items.length) {
      const s = new THREE.Sprite();
      s.scale.setScalar(0.35);
      this.drops.push(s);
      this.group.add(s);
    }
    for (let i = 0; i < this.drops.length; i++) {
      const s = this.drops[i];
      const it = items[i];
      s.visible = !!it;
      if (!it) continue;
      s.material = this.stackMat(it.stack);
      // ItemEntityRenderer bobs the item up and down.
      const bob = Math.sin((it.age + a) / 10) * 0.1 + 0.1;
      s.position.set(lerp(it.prevPos.x, it.pos.x, a), lerp(it.prevPos.y, it.pos.y, a) + 0.18 + bob, lerp(it.prevPos.z, it.pos.z, a));
    }
    while (this.items.length < thrown.length) {
      const s = new THREE.Sprite();
      s.scale.setScalar(0.5);
      this.items.push(s);
      this.group.add(s);
    }
    for (let i = 0; i < this.items.length; i++) {
      const s = this.items[i];
      const t = thrown[i];
      s.visible = !!t;
      if (!t) continue;
      s.material = this.itemMat(t);
      s.position.set(lerp(t.prevPos.x, t.pos.x, a), lerp(t.prevPos.y, t.pos.y, a), lerp(t.prevPos.z, t.pos.z, a));
    }

    while (this.orbs.length < orbs.length) {
      const s = new THREE.Sprite();
      this.orbs.push(s);
      this.group.add(s);
    }
    // One colour pulse for all orbs is enough at this size; vanilla offsets it by orb age.
    const h = time * 10;
    const r = (Math.sin(h) + 1) * 0.5;
    const b = (Math.sin(h + 4.1887903) + 1) * 0.1;
    for (let i = 0; i < this.orbs.length; i++) {
      const s = this.orbs[i];
      const o = orbs[i];
      s.visible = !!o;
      if (!o) continue;
      const m = this.orbMat(orbIcon(o.value));
      m.color.setRGB(r, 1, b);
      s.material = m;
      s.scale.setScalar(0.3);
      s.position.set(lerp(o.prevPos.x, o.pos.x, a), lerp(o.prevPos.y, o.pos.y, a) + 0.1, lerp(o.prevPos.z, o.pos.z, a));
    }
  }
}
