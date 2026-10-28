import type { Advancement, KillEffect } from '../game/fun';

/** Minecraft's toast header for each advancement frame. */
const HEADER: Record<Advancement['frame'], string> = {
  task: 'Advancement Made!',
  goal: 'Goal Reached!',
  challenge: 'Challenge Complete!',
};

/**
 * Advancement toasts, top right like Minecraft's: they slide in, stay a few seconds and slide
 * out; several queue up one under the other.
 */
export class Toasts {
  private readonly root: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'toasts';
    parent.appendChild(this.root);
  }

  advancement(a: Advancement, rewards: KillEffect[]) {
    const t = document.createElement('div');
    t.className = `toast toast-${a.frame}`;
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = a.frame === 'challenge' ? '★' : a.frame === 'goal' ? '◆' : '✔';
    const text = document.createElement('div');
    text.className = 'toast-text';
    const head = document.createElement('div');
    head.className = 'toast-head';
    head.textContent = HEADER[a.frame];
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.textContent = a.title;
    text.append(head, title);
    if (rewards.length) {
      const r = document.createElement('div');
      r.className = 'toast-reward';
      r.textContent = `Unlocked kill effect: ${rewards.map((x) => x.name).join(', ')}`;
      text.append(r);
    }
    t.append(icon, text);
    this.root.appendChild(t);
    // Leave after 5 s (the slide-out is CSS), then go.
    setTimeout(() => t.classList.add('leaving'), 5000);
    setTimeout(() => t.remove(), 5600);
  }
}
