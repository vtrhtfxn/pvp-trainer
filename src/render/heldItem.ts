import * as THREE from 'three';
import * as C from '../core/constants';
import type { Fighter, Hand } from '../game/Fighter';
import { ITEMS, isEnchanted, type ItemStack } from '../game/items';
import { isCubeItem, itemTextureName } from './itemIcons';
import { cubeModel, shieldModel, spriteModel, type ItemModel } from './itemMesh';
import type { ItemKind } from './itemTransforms';

export interface ItemVisual {
  /** Model key: a pack texture name, or 'shield'. */
  model: string;
  kind: ItemKind;
  glint: boolean;
}

/**
 * Which model and display transform a stack uses right now — the vanilla item-model predicates
 * (bow "pull", crossbow "pull"/"charged", shield "blocking") folded into one lookup.
 */
export function itemVisual(f: Fighter, stack: ItemStack, hand: Hand): ItemVisual {
  const using = f.usingItem && f.useHand === hand;
  const glint = isEnchanted(stack);
  switch (stack.id) {
    case 'shield':
      return { model: 'shield', kind: using && f.useKind() === 'shield' ? 'shield_blocking' : 'shield', glint };
    case 'bow': {
      if (!using) return { model: 'item/bow', kind: 'bow', glint };
      const pull = f.useTicks() / 20;
      const n = pull >= 0.9 ? 2 : pull >= 0.65 ? 1 : 0;
      return { model: `item/bow_pulling_${n}`, kind: 'bow', glint };
    }
    case 'crossbow': {
      if (stack.charged) return { model: 'item/crossbow_arrow', kind: 'crossbow', glint };
      if (!using) return { model: 'item/crossbow_standby', kind: 'crossbow', glint };
      const pull = f.useTicks() / C.CROSSBOW_CHARGE_TICKS;
      const n = pull >= 1 ? 2 : pull >= 0.58 ? 1 : 0;
      return { model: `item/crossbow_pulling_${n}`, kind: 'crossbow', glint };
    }
    default:
      if (isCubeItem(stack.id)) return { model: `cube:${itemTextureName(stack)}`, kind: 'block', glint };
      return { model: itemTextureName(stack), kind: ITEMS[stack.id].handheld ? 'handheld' : 'generated', glint };
  }
}

function modelFor(key: string): ItemModel | null {
  if (key === 'shield') return shieldModel();
  if (key.startsWith('cube:')) return cubeModel(key.slice(5));
  return spriteModel(key);
}

/**
 * One hand's worth of item meshes: builds each model the first time it is needed, then just
 * toggles visibility, so switching items never allocates after the first time.
 */
export class HeldItemSlot {
  readonly group = new THREE.Group();
  private readonly entries = new Map<string, { root: THREE.Group; glint: THREE.Mesh; mat: THREE.MeshLambertMaterial }>();
  private shown: string | null = null;

  constructor(private readonly glintMaterial: THREE.Material) {
    this.group.matrixAutoUpdate = false;
  }

  /** Shows `v` (or nothing) and returns its material, for tinting. */
  show(v: ItemVisual | null): THREE.MeshLambertMaterial | null {
    const key = v?.model ?? null;
    if (key !== this.shown) {
      if (this.shown) this.entries.get(this.shown)!.root.visible = false;
      this.shown = null;
      if (key) {
        let e = this.entries.get(key);
        if (!e) {
          const m = modelFor(key);
          if (!m) return null;
          const mat = new THREE.MeshLambertMaterial({ map: m.texture, alphaTest: 0.1, side: THREE.DoubleSide });
          const root = new THREE.Group();
          root.add(new THREE.Mesh(m.geometry, mat));
          const glint = new THREE.Mesh(m.geometry, this.glintMaterial);
          glint.renderOrder = 2;
          root.add(glint);
          this.group.add(root);
          e = { root, glint, mat };
          this.entries.set(key, e);
        }
        e.root.visible = true;
        this.shown = key;
      }
    }
    if (!key) return null;
    const e = this.entries.get(key)!;
    e.glint.visible = !!v?.glint;
    return e.mat;
  }
}
