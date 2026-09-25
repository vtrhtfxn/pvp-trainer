import * as THREE from 'three';

interface Popup {
  el: HTMLDivElement;
  x: number;
  y: number;
  z: number;
  age: number;
}

const LIFE = 1.1; // seconds
const RISE = 0.9; // blocks over its life
const v = new THREE.Vector3();

/**
 * The Damage Indicator mod: numbers that pop out of whoever got hit and drift up. DOM elements
 * placed by projecting the hit point every frame; a small pool is reused.
 */
export class DamageIndicators {
  private readonly root: HTMLDivElement;
  private readonly live: Popup[] = [];
  private readonly pool: HTMLDivElement[] = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'dmg-layer';
    parent.appendChild(this.root);
  }

  spawn(x: number, y: number, z: number, text: string, crit: boolean, scale: number) {
    const el = this.pool.pop() ?? document.createElement('div');
    el.className = `dmg-ind${crit ? ' crit' : ''}`;
    el.textContent = text;
    el.style.setProperty('--s', String(scale));
    el.style.opacity = '1';
    this.root.appendChild(el);
    // A little sideways scatter so quick hits don't stack on one spot.
    this.live.push({ el, x: x + (Math.random() - 0.5) * 0.6, y: y + Math.random() * 0.25, z: z + (Math.random() - 0.5) * 0.6, age: 0 });
    while (this.live.length > 24) this.release(0);
  }

  private release(i: number) {
    const p = this.live[i];
    p.el.remove();
    this.pool.push(p.el);
    this.live.splice(i, 1);
  }

  clear() {
    while (this.live.length) this.release(0);
  }

  update(camera: THREE.Camera, dt: number) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= LIFE) {
        this.release(i);
        continue;
      }
      const t = p.age / LIFE;
      // Ease out: quick pop, slow drift.
      v.set(p.x, p.y + RISE * (1 - (1 - t) * (1 - t)), p.z).project(camera);
      if (v.z > 1) {
        p.el.style.opacity = '0';
        continue;
      }
      const sx = (v.x * 0.5 + 0.5) * w;
      const sy = (-v.y * 0.5 + 0.5) * h;
      p.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -50%)`;
      p.el.style.opacity = t > 0.65 ? ((1 - t) / 0.35).toFixed(2) : '1';
    }
  }
}
