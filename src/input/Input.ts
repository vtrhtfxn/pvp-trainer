import type { MoveInput } from '../game/Fighter';

export interface InputCallbacks {
  onClick(): void;
  onSlot(i: number): void;
  onScroll(dir: number): void;
  onToggleCamera(): void;
  /** Right mouse pressed (a fresh use click). */
  onUse(): void;
  /** F: swap main hand and off hand. */
  onSwapHands(): void;
  /** E: open or close the inventory. */
  onInventory(): void;
  onToggleHitboxes(): void;
  onRestart(): void;
  onPointerLockChange(locked: boolean): void;
}

/**
 * Keyboard + pointer-lock mouse. Look deltas use Minecraft's sensitivity curve:
 * degrees per pixel = (s * 0.6 + 0.2)^3 * 8 * 0.15.
 */
export class Input {
  private keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  useHeld = false;
  sprintToggled = false;
  toggleSprint = true;
  sensitivity = 0.5;
  rawInput = true;
  enabled = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly cb: InputCallbacks,
  ) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.useHeld = false;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Browsers occasionally report huge spikes right after locking; drop them.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      if (e.button === 0) this.cb.onClick();
      else if (e.button === 2) {
        this.useHeld = true;
        this.cb.onUse();
      }
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.useHeld = false;
    });
    document.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener(
      'wheel',
      (e) => {
        if (!this.locked || !this.enabled) return;
        this.cb.onScroll(Math.sign(e.deltaY));
      },
      { passive: true },
    );
    document.addEventListener('pointerlockchange', () => {
      if (!this.locked) {
        this.keys.clear();
        this.useHeld = false;
      }
      this.cb.onPointerLockChange(this.locked);
    });

    // Closing or navigating away while the pointer is locked can leave the OS cursor hidden
    // across the whole browser, so always hand it back before the page goes.
    const release = () => {
      this.enabled = false;
      this.keys.clear();
      this.useHeld = false;
      this.unlock();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('beforeunload', release);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.unlock();
    });
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  async lock() {
    if (this.locked) return;
    try {
      const req = this.target.requestPointerLock as unknown as (opts?: { unadjustedMovement?: boolean }) => Promise<void> | void;
      const r = this.rawInput ? req.call(this.target, { unadjustedMovement: true }) : req.call(this.target);
      if (r && typeof (r as Promise<void>).then === 'function') await r;
    } catch {
      try {
        await (this.target.requestPointerLock() as unknown as Promise<void>);
      } catch {
        /* user gesture required */
      }
    }
  }

  /**
   * Releases the pointer unconditionally. `locked` compares against our own canvas, but any
   * element holding the lock still hides the cursor, so never make the release conditional.
   */
  unlock() {
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* already released */
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const code = e.code;
    if (down) {
      if (!this.keys.has(code)) this.keyPressed(code, e);
      this.keys.add(code);
    } else this.keys.delete(code);
    if (code === 'F3' || (code === 'KeyM' && (e.metaKey || e.ctrlKey))) e.preventDefault();
    if (this.locked && ['Space', 'Tab', 'F5', 'ControlLeft', 'KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyF', 'KeyE'].includes(code)) e.preventDefault();
  }

  private keyPressed(code: string, e: KeyboardEvent) {
    // Cmd/Ctrl + M, or vanilla F3 + B, toggles the debug hitboxes.
    if (code === 'KeyM' && (e.metaKey || e.ctrlKey)) {
      this.cb.onToggleHitboxes();
      return;
    }
    if (code === 'KeyB' && this.keys.has('F3')) {
      this.cb.onToggleHitboxes();
      return;
    }
    if (code.startsWith('Digit')) {
      if (e.metaKey || e.ctrlKey) return;
      const n = Number(code.slice(5));
      if (n >= 1 && n <= 9 && this.enabled) this.cb.onSlot(n - 1);
    } else if (code === 'F5' || (code === 'KeyV' && !e.repeat)) {
      if (this.enabled) this.cb.onToggleCamera();
    } else if (code === 'KeyR') {
      this.cb.onRestart();
    } else if (code === 'KeyE' && !e.repeat) {
      this.cb.onInventory();
    } else if (code === 'KeyF' && !e.repeat) {
      if (this.enabled) this.cb.onSwapHands();
    } else if ((code === 'ControlLeft' || code === 'ControlRight') && this.toggleSprint) {
      this.sprintToggled = !this.sprintToggled;
    }
  }

  isDown(code: string) {
    return this.keys.has(code);
  }

  moveInput(): MoveInput {
    const k = this.keys;
    const f = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    const s = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const ctrl = k.has('ControlLeft') || k.has('ControlRight');
    return {
      forward: this.enabled ? f : 0,
      strafe: this.enabled ? s : 0,
      jump: this.enabled && k.has('Space'),
      sneak: this.enabled && (k.has('ShiftLeft') || k.has('ShiftRight')),
      sprint: this.enabled && (this.toggleSprint ? this.sprintToggled : ctrl),
    };
  }

  /** Returns accumulated look delta in radians (yaw, pitch) and clears it. */
  consumeLook(): [number, number] {
    const d = this.sensitivity * 0.6 + 0.2;
    const degPerPx = d * d * d * 8 * 0.15;
    const out: [number, number] = [
      (-this.lookX * degPerPx * Math.PI) / 180,
      (-this.lookY * degPerPx * Math.PI) / 180,
    ];
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }
}
