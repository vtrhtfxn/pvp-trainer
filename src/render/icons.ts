import * as THREE from 'three';
import type { ItemModel } from './assets';

/** Renders a flat item model face-on into a canvas (inventory icon). */
export function renderItemIcon(renderer: THREE.WebGLRenderer, item: ItemModel, size = 64): HTMLCanvasElement {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(
    item.geometry,
    new THREE.MeshBasicMaterial({ map: item.texture, alphaTest: 0.1, side: THREE.DoubleSide }),
  );
  scene.add(mesh);
  const cam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.01, 10);
  cam.position.z = 3;
  const rt = new THREE.WebGLRenderTarget(size, size);
  rt.texture.colorSpace = THREE.SRGBColorSpace;
  const prevColor = new THREE.Color();
  renderer.getClearColor(prevColor);
  const prevAlpha = renderer.getClearAlpha();
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(scene, cam);
  const buf = new Uint8Array(size * size * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, size, size, buf);
  renderer.setRenderTarget(null);
  renderer.setClearColor(prevColor, prevAlpha);
  rt.dispose();

  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    img.data.set(buf.subarray(src, src + size * 4), y * size * 4);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
