import * as THREE from 'three';

/** Server-style nametag: name on top, health underneath (like tier-test servers show it). */
export class Nametag {
  readonly sprite: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private last = '';

  constructor() {
    this.canvas.width = 512;
    this.canvas.height = 160;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true });
    this.sprite = new THREE.Sprite(mat);
    this.sprite.scale.set(1.6, 0.5, 1);
    this.sprite.renderOrder = 10;
  }

  set(name: string, color: string, health: number, absorption: number, status: string) {
    const hp = Math.max(0, health);
    const key = `${name}|${color}|${hp.toFixed(1)}|${absorption.toFixed(1)}|${status}`;
    if (key === this.last) return;
    this.last = key;
    const c = this.ctx;
    c.clearRect(0, 0, 512, 160);
    c.font = '600 44px "Pixelify Sans", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const drawPlate = (text: string, y: number, fill: string) => {
      const w = c.measureText(text).width + 28;
      c.fillStyle = 'rgba(0,0,0,0.38)';
      c.fillRect(256 - w / 2, y - 30, w, 58);
      c.fillStyle = '#3f3f3f';
      c.fillText(text, 259, y + 3);
      c.fillStyle = fill;
      c.fillText(text, 256, y);
    };
    drawPlate(name, 42, color);
    const hearts = `${(hp / 2).toFixed(1)} ❤${absorption > 0 ? `  +${(absorption / 2).toFixed(1)}` : ''}`;
    c.font = '600 40px "Pixelify Sans", monospace';
    drawPlate(status ? `${hearts} · ${status}` : hearts, 116, absorption > 0 ? '#ffd23f' : '#ff5555');
    this.texture.needsUpdate = true;
  }
}
