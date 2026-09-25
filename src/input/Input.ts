import type { MoveInput } from '../game/Fighter';
import { DEFAULT_KEYS, HOTBAR_ACTIONS, type Action, type KeyBinds } from './keybinds';

export interface InputCallbacks {
  onClick(): void;
  onSlot(i: number): void;
  onScroll(dir: number): void;
  onToggleCamera(): void;
  /** Use pressed (a fresh right click). */
  onUse(): void;
  /** Swap main hand and off hand. */
  onSwapHands(): void;
  /** Open or close the inventory. */
  onInventory(): void;
  onToggleHitboxes(): void;
  onRestart(): void;
  onPointerLockChange(locked: boolean): void;
  /** Chat key (T) or command key (/, opens chat with a slash). */
  onChat(command: boolean): void;
}

/**
 * Keyboard + pointer-lock mouse, through the rebindable key map. Look deltas use Minecraft's
 * sensitivity curve: degrees per pixel = (s * 0.6 + 0.2)^3 * 8 * 0.15.
 */
export class Input {
  /** Pressed keys and mouse buttons ("KeyW", "Mouse0", …). */
  private readonly down = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  binds: KeyBinds = { ...DEFAULT_KEYS };
  useHeld = false;
  /** Attack held (mining). */
  attackHeld = false;
  sprintToggled = false;
  toggleSprint = true;
  /** Toggle Sneak: the sneak key latches instead of being held. */
  toggleSneak = false;
  sneakToggled = false;
  sensitivity = 0.5;
  /** Separate vertical sensitivity (0..1 like the main one), or null to follow it. */
  sensitivityY: number | null = null;
  invertY = false;
  /** Look speed multiplier on top of the sensitivity curve (the Zoom mod slows it down). */
  lookScale = 1;
  rawInput = true;
  enabled = false;
  /**
   * A match is on: closing the tab (Ctrl+W, the sprint key next to W) asks "Leave site?"
   * instead of quitting on the spot.
   */
  closeGuard = false;
  /** Go fullscreen while playing, where the Keyboard Lock API keeps Ctrl+W & co. in the game. */
  fullscreenLock = true;
  private wentFullscreen = false;

  constructor(
    private readonly target: HTMLElement,
    private readonly cb: InputCallbacks,
  ) {
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Browsers occasionally report huge spikes right after locking; drop them.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      this.press(`Mouse${e.button}`, false);
      e.preventDefault();
    });
    document.addEventListener('mouseup', (e) => {
      this.release(`Mouse${e.button}`);
      // Side buttons (bindable in Key Binds) would otherwise also go Back/Forward in the browser.
      if (this.locked && (e.button === 3 || e.button === 4)) e.preventDefault();
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
      if (!this.locked) this.releaseAll();
      this.cb.onPointerLockChange(this.locked);
    });

    // Closing or navigating away while the pointer is locked can leave the OS cursor hidden
    // across the whole browser, so always hand it back before the page goes.
    const release = () => {
      this.enabled = false;
      this.releaseAll();
      this.unlock();
    };
    window.addEventListener('pagehide', release);
    window.addEventListener('beforeunload', (e) => {
      // The desktop app blocks Ctrl+W itself; there a cancelled unload would only stop the
      // window from closing.
      if (this.closeGuard && !window.pvpNative) {
        e.preventDefault();
        e.returnValue = '';
        this.unlock();
        return;
      }
      release();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.unlock();
    });
  }

  /** Lets go of everything (focus lost, pointer released, a screen opened). */
  releaseAll() {
    this.down.clear();
    this.useHeld = false;
    this.attackHeld = false;
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  async lock() {
    this.holdShortcuts();
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
   * Browsers never let a page cancel Ctrl+W, Ctrl+T, Ctrl+N or Ctrl+Q — except in fullscreen,
   * where the Keyboard Lock API (Chrome, Edge) routes those keys to the page. It needs a click
   * (lock() is always called from one) and a secure page: localhost, a file, or https. Elsewhere
   * the "Leave site?" guard is what stops an accidental Ctrl+W.
   */
  private holdShortcuts() {
    if (!this.fullscreenLock || window.pvpNative) return;
    const keyboard = (navigator as Navigator & { keyboard?: { lock?(codes?: string[]): Promise<void> } }).keyboard;
    const hold = () => {
      keyboard?.lock?.(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyT', 'KeyN', 'KeyF', 'Tab']).catch(() => {});
    };
    if (document.fullscreenElement) {
      hold();
      return;
    }
    try {
      const r = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
      if (!r) return;
      this.wentFullscreen = true;
      r.then(hold, () => {
        this.wentFullscreen = false;
      });
    } catch {
      /* no fullscreen here */
    }
  }

  /** Back to the menus: leave the fullscreen we entered and give the shortcuts back. */
  releaseShortcuts() {
    try {
      (navigator as Navigator & { keyboard?: { unlock?(): void } }).keyboard?.unlock?.();
    } catch {
      /* not supported */
    }
    if (this.wentFullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    this.wentFullscreen = false;
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

  /** Is the key bound to `action` down right now? */
  held(action: Action): boolean {
    const code = this.binds[action];
    return !!code && this.down.has(code);
  }

  private onKey(e: KeyboardEvent, isDown: boolean) {
    // Typing into a text box (chat, a menu field) is not game input.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const code = e.code;
    if (isDown) this.press(code, e.repeat, e);
    else this.release(code);
    if (code === 'F3' || (code === 'KeyM' && (e.metaKey || e.ctrlKey))) e.preventDefault();
    // Keys the game uses must not scroll, tab away, reload (F5) or open browser things.
    if (this.locked && (this.isBound(code) || code === 'Tab' || code === 'F5' || code === 'Space')) e.preventDefault();
  }

  private isBound(code: string): boolean {
    for (const k in this.binds) if (this.binds[k as Action] === code) return true;
    return false;
  }

  private press(code: string, repeat: boolean, e?: KeyboardEvent) {
    const fresh = !this.down.has(code);
    this.down.add(code);
    if (!fresh && repeat) return;
    const mod = !!e && (e.metaKey || e.ctrlKey);
    // Cmd/Ctrl + M, or vanilla F3 + B, toggles the debug hitboxes.
    if (code === 'KeyM' && mod) {
      this.cb.onToggleHitboxes();
      return;
    }
    if (code === 'KeyB' && this.down.has('F3')) {
      this.cb.onToggleHitboxes();
      return;
    }
    const b = this.binds;
    for (const action in b) {
      if (b[action as Action] !== code) continue;
      this.fire(action as Action, mod);
    }
    // V has always toggled the camera too (F5 sits behind fn on Macs), unless it is bound.
    if (code === 'KeyV' && !this.isBound('KeyV') && this.enabled) this.cb.onToggleCamera();
  }

  private fire(action: Action, mod: boolean) {
    const hot = HOTBAR_ACTIONS.indexOf(action);
    if (hot >= 0) {
      // Ctrl/Cmd + number is a browser shortcut, not a hotbar key.
      if (!mod && this.enabled) this.cb.onSlot(hot);
      return;
    }
    switch (action) {
      case 'attack':
        if (!this.enabled) return;
        this.attackHeld = true;
        this.cb.onClick();
        return;
      case 'use':
        if (!this.enabled) return;
        this.useHeld = true;
        this.cb.onUse();
        return;
      case 'perspective':
        if (this.enabled) this.cb.onToggleCamera();
        return;
      case 'rematch':
        this.cb.onRestart();
        return;
      case 'inventory':
        this.cb.onInventory();
        return;
      case 'swapHands':
        if (this.enabled) this.cb.onSwapHands();
        return;
      case 'sprint':
        if (this.toggleSprint) this.sprintToggled = !this.sprintToggled;
        return;
      case 'sneak':
        if (this.toggleSneak) this.sneakToggled = !this.sneakToggled;
        return;
      case 'chat':
      case 'command':
        if (this.enabled) this.cb.onChat(action === 'command');
        return;
      default:
        return;
    }
  }

  private release(code: string) {
    this.down.delete(code);
    if (code === this.binds.use) this.useHeld = false;
    if (code === this.binds.attack) this.attackHeld = false;
  }

  isDown(code: string) {
    return this.down.has(code);
  }

  moveInput(): MoveInput {
    const on = this.enabled;
    const f = (this.held('forward') ? 1 : 0) - (this.held('back') ? 1 : 0);
    const s = (this.held('right') ? 1 : 0) - (this.held('left') ? 1 : 0);
    return {
      forward: on ? f : 0,
      strafe: on ? s : 0,
      jump: on && this.held('jump'),
      sneak: on && (this.toggleSneak ? this.sneakToggled : this.held('sneak')),
      sprint: on && (this.toggleSprint ? this.sprintToggled : this.held('sprint')),
    };
  }

  /** Returns accumulated look delta in radians (yaw, pitch) and clears it. */
  consumeLook(): [number, number] {
    const curve = (s: number) => {
      const d = s * 0.6 + 0.2;
      return d * d * d * 8 * 0.15 * this.lookScale;
    };
    const kx = curve(this.sensitivity);
    const ky = curve(this.sensitivityY ?? this.sensitivity) * (this.invertY ? -1 : 1);
    const out: [number, number] = [(-this.lookX * kx * Math.PI) / 180, (-this.lookY * ky * Math.PI) / 180];
    this.lookX = 0;
    this.lookY = 0;
    return out;
  }
}
