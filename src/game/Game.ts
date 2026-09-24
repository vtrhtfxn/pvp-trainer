import { BotBrain } from '../ai/BotBrain';
import { DIFFICULTIES } from '../ai/difficulty';
import { Sound, type HitKind } from '../audio/Sound';
import { TICK_MS } from '../core/constants';
import { clamp, lookDir, V3 } from '../core/math';
import { Rng } from '../core/rng';
import { Input } from '../input/Input';
import type { Assets } from '../render/assets';
import { SceneRenderer } from '../render/SceneRenderer';
import { HUD } from '../ui/HUD';
import { Menus } from '../ui/Menus';
import { loadRecords, saveRecords, saveSettings, type Records, type Settings } from '../ui/settings';
import { makeKitIcon, type Sprite } from '../ui/sprites';
import { itemIcon } from '../render/itemIcons';
import { InventoryScreen } from '../ui/Inventory';
import { NetClient, type NetStatus } from '../net/Client';
import { NetMatch } from '../net/NetMatch';
import type { ServerMsg } from '../net/protocol';
import { performAttack, rayDistanceToTarget } from './combat';
import type { Fighter, FighterEvent } from './Fighter';
import { EFFECT_COLORS, ITEMS } from './items';
import { KITS, kitById, type KitId } from './kits';
import { B } from './Blocks';
import type { World } from './World';

/** Average colour of each block's texture, for break particles. */
const BLOCK_COLORS: Record<number, number> = {
  [B.PLANKS]: 0xa2824e,
  [B.COBWEB]: 0xe8e8e8,
  [B.COBBLESTONE]: 0x7f7f7f,
  [B.STONE]: 0x7d7d7d,
  [B.OBSIDIAN]: 0x1b1429,
};

function blockSound(block: number): 'wood' | 'stone' | 'web' {
  return block === B.PLANKS ? 'wood' : block === B.COBWEB ? 'web' : 'stone';
}
import { Match } from './Match';

type State = 'menu' | 'playing' | 'paused' | 'results';
/** Game drives either the offline Match or its online stand-in; they share a surface. */
type AnyMatch = Match | NetMatch;

/** Glues simulation, rendering, audio, HUD, menus and input together. */
export class Game {
  private state: State = 'menu';
  private match: AnyMatch;
  private demoBrain: BotBrain;
  private readonly view: SceneRenderer;
  private readonly hud: HUD;
  private readonly menus: Menus;
  private readonly input: Input;
  private readonly sound = new Sound();
  private records: Records;
  private acc = 0;
  private last = performance.now();
  private time = 0;
  private lastReach: number | null = null;
  private lastCountdown = -1;
  private resultTimer = -1;
  private cameraMode: 'first' | 'third' = 'first';
  private lastHitboxToggle = 0;
  private readonly clickHint: HTMLDivElement;
  private readonly net: NetClient;
  private netMatch: NetMatch | null = null;
  private readonly inventory: InventoryScreen;
  private readonly previewCanvas: HTMLCanvasElement;

  constructor(
    canvas: HTMLCanvasElement,
    uiRoot: HTMLElement,
    assets: Assets,
    private readonly settings: Settings,
  ) {
    this.records = loadRecords();
    this.net = new NetClient({
      onStatus: (status, detail) => this.onNetStatus(status, detail),
      onMessage: (msg) => this.onNetMessage(msg),
    });
    this.match = this.newDemo();
    this.demoBrain = this.makeDemoBrain(this.match as Match);
    this.view = new SceneRenderer(canvas, this.match.world, assets);
    const packIcon = (id: 'diamond_sword' | 'diamond_axe' | 'golden_apple' | 'golden_head' | 'splash_potion' | 'netherite_sword' | 'end_crystal' | 'netherite_axe' | 'mace') =>
      itemIcon({ id, count: 1, potion: 'healing' });
    const kitIcons: Record<string, Sprite> = {};
    for (const kit of KITS) {
      const fromPack = kit.icon === 'sword' ? packIcon('diamond_sword') : kit.icon === 'axe' ? packIcon('diamond_axe') : kit.icon === 'uhc' ? packIcon('golden_head') : kit.icon === 'neth_potion' ? packIcon('netherite_sword') : kit.icon === 'potion' ? packIcon('splash_potion') : kit.icon === 'crystal' ? packIcon('end_crystal') : kit.icon === 'smp' ? packIcon('netherite_axe') : kit.icon === 'mace' ? packIcon('mace') : undefined;
      kitIcons[kit.icon] = fromPack ?? makeKitIcon(kit.icon);
    }
    this.hud = new HUD(uiRoot);
    this.inventory = new InventoryScreen(uiRoot, {
      onChange: () => {
        this.sound.equip();
        this.netMatch?.syncInventory();
      },
      onClose: () => this.closeInventory(),
    });
    this.previewCanvas = document.createElement('canvas');
    this.inventory.preview.appendChild(this.previewCanvas);
    this.menus = new Menus(uiRoot, settings, this.records, kitIcons, {
      onStart: () => this.startDuel(),
      onResume: () => this.resume(),
      onRestart: () => {
        if (!this.online) this.startDuel();
      },
      onQuit: () => this.toMenu(),
      onSettingsChanged: () => this.applySettings(),
      onUiSound: () => {
        this.sound.unlock();
        this.sound.ui();
      },
      onConnect: (url, room, name) => this.startOnline(url, room, name),
      onLeaveOnline: () => this.leaveOnline(),
    });
    this.input = new Input(canvas, {
      onClick: () => {
        if (this.state !== 'playing') return;
        this.match.queueClick();
        this.hud.registerClick(performance.now());
      },
      onSlot: (i) => this.state === 'playing' && this.match.queueSlot(i),
      onScroll: (d) => {
        if (this.state !== 'playing') return;
        this.match.queueSlot((this.match.player.selected + d + 9) % 9);
      },
      onToggleCamera: () => {
        this.cameraMode = this.cameraMode === 'first' ? 'third' : 'first';
      },
      onUse: () => this.state === 'playing' && !this.inventory.open && this.match.queueUse(),
      onSwapHands: () => this.state === 'playing' && !this.inventory.open && this.match.queueSwapHands(),
      onInventory: () => this.toggleInventory(),
      onToggleHitboxes: () => this.toggleHitboxes(),
      onRestart: () => {
        if (this.state !== 'results') return;
        if (this.netMatch) {
          this.netMatch.requestRematch();
          this.hud.showCenter('Waiting for rematch…', 'toast', 60);
        } else this.startDuel();
      },
      onPointerLockChange: (locked) => {
        if (!locked && this.state === 'playing' && !this.inventory.open) this.pause();
      },
    });
    canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked && !this.inventory.open) void this.input.lock();
    });
    this.clickHint = document.createElement('div');
    this.clickHint.className = 'click-hint';
    this.clickHint.textContent = 'Click to play';
    uiRoot.appendChild(this.clickHint);
    window.addEventListener('resize', () => {
      this.view.resize();
      this.hud.layout(this.settings);
      this.inventory.root.style.setProperty('--gui', String(this.hud.guiScale));
    });
    // The macOS app routes its ⌘M menu item here, since the menu swallows the key event.
    window.pvpNative?.onToggleHitboxes(() => this.toggleHitboxes());
    this.applySettings();
    this.toMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ state changes

  private newDemo(): Match {
    const m = new Match(kitById('sword'), DIFFICULTIES.ht3, 7);
    m.phase = 'fight';
    return m;
  }

  private makeDemoBrain(m: Match): BotBrain {
    const brain = new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.ht3, new Rng(11), () => performAttack(m.player, m.bot));
    brain.resetRound();
    return brain;
  }

  /** Debounced so the macOS ⌘M menu item and the in-page key handler can't double-fire. */
  private toggleHitboxes() {
    const now = performance.now();
    if (now - this.lastHitboxToggle < 150) return;
    this.lastHitboxToggle = now;
    this.settings.showHitboxes = !this.settings.showHitboxes;
    saveSettings(this.settings);
    this.menus.refreshSettings();
    this.sound.unlock();
    this.sound.ui();
    if (this.state !== 'menu') {
      this.hud.showCenter(`Hitboxes: ${this.settings.showHitboxes ? 'ON' : 'OFF'}`, 'toast', 30);
    }
  }

  private applySettings() {
    const s = this.settings;
    this.input.sensitivity = s.sensitivity;
    this.input.toggleSprint = s.toggleSprint;
    this.input.rawInput = s.rawInput;
    this.input.fullscreenLock = s.fullscreenLock;
    this.sound.volume = s.volume;
    this.hud.layout(s);
    this.inventory.root.style.setProperty('--gui', String(this.hud.guiScale));
  }

  // ------------------------------------------------------------------ inventory

  private toggleInventory() {
    if (this.inventory.open) this.closeInventory();
    else this.openInventory();
  }

  private openInventory() {
    const p = this.match.player;
    if (this.state !== 'playing' || p.dead || this.match.phase === 'ended') return;
    // Opening a screen lets go of every key; an item in use is put away rather than fired.
    if (p.usingItem) p.stopUsingItem();
    this.match.useHeld = false;
    this.input.useHeld = false;
    this.input.enabled = false;
    if (this.netMatch) this.netMatch.holdInventory = true;
    this.inventory.show(p);
    this.input.unlock();
  }

  private closeInventory() {
    if (!this.inventory.open) return;
    this.inventory.hide();
    if (this.netMatch) {
      this.netMatch.holdInventory = false;
      this.netMatch.syncInventory();
    }
    if (this.state === 'playing') {
      this.input.enabled = true;
      void this.input.lock();
    }
  }

  private toMenu() {
    this.inventory.hide();
    this.state = 'menu';
    this.input.enabled = false;
    this.input.closeGuard = false;
    this.input.unlock();
    this.input.releaseShortcuts();
    this.netMatch = null;
    this.net.close();
    this.match = this.newDemo();
    this.demoBrain = this.makeDemoBrain(this.match as Match);
    this.view.cameraMode = 'orbit';
    this.view.particles.clear();
    this.hud.setVisible(false);
    this.menus.refreshMain(this.records);
    this.menus.show('main');
  }

  private startDuel() {
    this.sound.unlock();
    this.inventory.hide();
    this.netMatch = null;
    this.net.close();
    const kit = kitById(this.settings.kit);
    const profile = DIFFICULTIES[this.settings.difficulty];
    this.match = new Match(kit, profile);
    this.view.firstPerson.reset();
    this.view.particles.clear();
    this.hud.resetRound(this.match.player);
    this.lastReach = null;
    this.lastCountdown = -1;
    this.resultTimer = -1;
    this.acc = 0;
    this.input.sprintToggled = this.settings.toggleSprint;
    this.menus.hideAll();
    this.hud.setVisible(true);
    this.state = 'playing';
    this.input.enabled = true;
    this.input.closeGuard = true;
    void this.input.lock();
  }

  // ------------------------------------------------------------------ online

  get online(): boolean {
    return this.netMatch !== null;
  }

  /** Called by the multiplayer menu. An empty room asks the server to make one up. */
  startOnline(url: string, room: string, name: string) {
    this.sound.unlock();
    this.leaveOnline(false);
    // Hosting a room uses the kit selected in the main menu; joining uses the room's.
    this.net.connect(url, room, name, this.settings.kit);
  }

  leaveOnline(toMenu = true) {
    this.net.close();
    this.netMatch = null;
    if (toMenu) this.toMenu();
  }

  private onNetStatus(status: NetStatus, detail: string) {
    this.menus.setNetStatus(status, detail, this.net.room);
    if (status === 'error' || status === 'closed') this.leaveOnlineMatch();
  }

  /** Back to the multiplayer screen from an online match (the connection may stay open). */
  private leaveOnlineMatch() {
    const wasPlaying = this.netMatch !== null;
    this.netMatch = null;
    if (wasPlaying) {
      this.inventory.hide();
      this.state = 'menu';
      this.input.enabled = false;
      this.input.closeGuard = false;
      this.input.unlock();
      this.input.releaseShortcuts();
      this.match = this.newDemo();
      this.demoBrain = this.makeDemoBrain(this.match as Match);
      this.view.cameraMode = 'orbit';
      this.hud.setVisible(false);
    }
    this.menus.show('multiplayer');
  }

  private onNetMessage(msg: ServerMsg) {
    if (msg.t === 'start') {
      if (!this.netMatch || this.netMatch.kit.id !== msg.kit) {
        this.netMatch = new NetMatch(this.net, this.net.you, msg.kit as KitId);
        this.match = this.netMatch;
      }
      this.netMatch.handle(msg);
      this.beginOnlineRound();
      return;
    }
    if (!this.netMatch) return;
    // The server drops back to the lobby when the opponent leaves mid-duel.
    if (msg.t === 'lobby' && msg.players.length < 2) {
      this.leaveOnlineMatch();
      this.menus.setNetStatus('lobby', 'Your opponent left. Waiting for someone to join this room…', this.net.room);
      return;
    }
    this.netMatch.handle(msg);
    switch (msg.t) {
      case 'end':
        if (this.state === 'playing' || this.state === 'paused') {
          const won = msg.winner === this.net.you;
          this.hud.showCenter(msg.winner === null ? 'DRAW' : won ? 'VICTORY' : 'YOU DIED', won ? 'win' : 'lose', 40);
          this.resultTimer = 30;
        }
        break;
      default:
        break;
    }
  }

  private beginOnlineRound() {
    this.view.firstPerson.reset();
    this.view.particles.clear();
    this.hud.resetRound(this.match.player);
    this.lastReach = null;
    this.lastCountdown = -1;
    this.resultTimer = -1;
    this.acc = 0;
    this.input.sprintToggled = this.settings.toggleSprint;
    this.menus.hideAll();
    this.hud.setVisible(true);
    this.state = 'playing';
    this.input.enabled = true;
    this.input.closeGuard = true;
    void this.input.lock();
  }

  private finishOnlineDuel() {
    const m = this.netMatch;
    if (!m) return;
    const won = m.winner === m.player;
    this.state = 'results';
    this.input.enabled = false;
    this.input.unlock();
    this.sound.jingle(won);
    this.menus.showResults(
      {
        won,
        seconds: m.fightTicks / 20,
        player: m.player.stats,
        bot: m.bot.stats,
        botName: m.bot.name,
        newBestCombo: false,
        online: true,
      },
      () => {
        m.requestRematch();
        this.hud.showCenter('Waiting for rematch…', 'toast', 60);
        this.menus.hideAll();
        this.hud.setVisible(true);
        this.state = 'playing';
      },
    );
  }

  private pause() {
    if (this.state !== 'playing') return;
    this.inventory.hide();
    this.menus.setOnline(this.online);
    this.state = 'paused';
    this.input.enabled = false;
    this.menus.show('pause');
  }

  private resume() {
    this.menus.hideAll();
    this.state = 'playing';
    this.input.enabled = true;
    this.last = performance.now();
    void this.input.lock();
  }

  private finishDuel() {
    const m = this.match;
    const won = m.winner === m.player;
    const key = `${m.kit.id}:${m.profile.id}`;
    const rec = this.records[key] ?? { wins: 0, losses: 0, bestCombo: 0 };
    const newBest = m.player.stats.maxCombo > rec.bestCombo;
    if (won) rec.wins++;
    else rec.losses++;
    rec.bestCombo = Math.max(rec.bestCombo, m.player.stats.maxCombo);
    this.records[key] = rec;
    saveRecords(this.records);
    this.state = 'results';
    this.input.enabled = false;
    this.input.unlock();
    this.sound.jingle(won);
    this.menus.showResults(
      {
        won,
        seconds: m.fightTicks / 20,
        player: m.player.stats,
        bot: m.bot.stats,
        botName: m.bot.name,
        newBestCombo: newBest && m.player.stats.maxCombo > 0,
      },
      () => this.startDuel(),
    );
  }

  // ------------------------------------------------------------------ loop

  private frame(now: number) {
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    const m = this.match;
    const p = m.player;

    if (this.state === 'playing') {
      const [dyaw, dpitch] = this.input.consumeLook();
      if (!p.dead && m.phase !== 'ended') {
        p.yaw += dyaw;
        p.pitch = clamp(p.pitch + dpitch, -Math.PI / 2, Math.PI / 2);
      }
      p.input = this.input.moveInput();
      p.doubleTapSprint = this.settings.doubleTapSprint;
      m.useHeld = this.input.useHeld && !this.inventory.open;
      m.attackHeld = this.input.attackHeld && !this.inventory.open;
    } else {
      this.input.consumeLook();
      // Paused online the world goes on: let go of every key, or we would keep walking,
      // blocking, eating or mining through the pause.
      if (this.online) {
        p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
        m.useHeld = false;
        m.attackHeld = false;
      }
    }

    // Online: the server keeps ticking whether or not we opened the pause menu, so we have to
    // keep simulating and reporting our position — we just stop taking input.
    const ticking =
      this.state === 'playing' || this.state === 'menu' || this.state === 'results' || (this.online && this.state === 'paused');
    if (ticking) {
      this.acc += dt * 1000;
      let n = 0;
      while (this.acc >= TICK_MS && n < 5) {
        this.tick();
        this.acc -= TICK_MS;
        n++;
      }
      if (n === 5) this.acc = 0;
    }
    const alpha = ticking ? this.acc / TICK_MS : 1;

    this.view.cameraMode = this.state === 'menu' ? 'orbit' : this.cameraMode;
    const s = this.settings;
    const tag = { name: m.bot.name, color: m.profile.color, status: this.state === 'menu' ? '' : m.brain.label };
    this.view.render(p, m.bot, alpha, this.time, dt, s, tag);

    if (this.state !== 'menu') {
      this.hud.update(p, m.bot, s, {
        aimingAtBot: rayDistanceToTarget(p, m.bot) >= 0,
        botName: m.bot.name,
        botColor: m.profile.color,
        botStatus: m.brain.label,
        lastReach: this.lastReach,
        now: performance.now(),
        firstPerson: this.view.cameraMode === 'first',
      });
    }
    if (this.inventory.open) {
      if (p.dead || m.phase === 'ended' || this.state !== 'playing') this.closeInventory();
      else {
        this.inventory.refresh();
        this.view.renderPreview(this.previewCanvas, p, this.inventory.mouseX, this.inventory.mouseY);
      }
    }
    this.clickHint.style.display = this.state === 'playing' && !this.input.locked && !this.inventory.open ? '' : 'none';
    const eye = p.eyePos();
    this.sound.listener = { x: eye.x, y: eye.y, z: eye.z, yaw: p.yaw };
    requestAnimationFrame((t) => this.frame(t));
  }

  private tick() {
    const m = this.match;
    if (this.netMatch) {
      this.tickOnline(this.netMatch);
      return;
    }
    if (this.state === 'menu') {
      if (m.phase === 'fight') this.demoBrain.tick();
      m.useHeld = this.demoBrain.useHeld;
      m.tick();
      if (m.phase === 'ended' && m.phaseTicks > 60) {
        this.match = this.newDemo();
        this.demoBrain = this.makeDemoBrain(this.match as Match);
      }
      this.handleEvents(m.player, false);
      this.handleEvents(m.bot, false);
      this.handleWorldEvents(m.world);
      return;
    }

    const prevPhase = m.phase;
    m.tick();
    this.view.firstPerson.tick(m.player);
    this.hud.tick(m.player);

    if (m.phase === 'countdown') {
      const n = m.countdownSeconds;
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.hud.showCenter(String(n), 'count', 22);
        this.sound.countdown(false);
      }
    } else if (prevPhase === 'countdown' && m.phase === 'fight') {
      this.hud.showCenter('FIGHT!', 'fight', 26);
      this.sound.countdown(true);
    }

    this.handleEvents(m.player, true);
    this.handleEvents(m.bot, true);
    this.handleWorldEvents(m.world);

    for (const f of [m.player, m.bot]) {
      if (f.dead && f.deathTime === 20) this.view.particles.poof(f.pos.x, f.pos.y, f.pos.z);
    }
    if (m.phase === 'ended' && this.state === 'playing') {
      if (this.resultTimer < 0) {
        this.resultTimer = 30;
        this.hud.showCenter(m.winner === m.player ? 'VICTORY' : 'YOU DIED', m.winner === m.player ? 'win' : 'lose', 40);
      } else if (--this.resultTimer === 0) this.finishDuel();
    }
  }

  /** Online rounds: the server owns combat, so only local movement + feedback happen here. */
  private tickOnline(m: NetMatch) {
    const prevPhase = m.phase;
    m.tick();
    this.view.firstPerson.tick(m.player);
    this.hud.tick(m.player);

    if (m.phase === 'countdown') {
      const n = m.countdownSeconds;
      if (n !== this.lastCountdown && n > 0) {
        this.lastCountdown = n;
        this.hud.showCenter(String(n), 'count', 22);
        this.sound.countdown(false);
      }
    } else if (prevPhase === 'countdown' && m.phase === 'fight') {
      this.lastCountdown = -1;
      this.hud.showCenter('FIGHT!', 'fight', 26);
      this.sound.countdown(true);
    }

    // Our own movement events are made here; everything else (hits, items, explosions, …)
    // arrives from the server into the same event queues the offline game uses.
    this.handleEvents(m.player, true);
    this.handleEvents(m.bot, true);
    this.handleWorldEvents(m.world);
    for (const f of [m.player, m.bot]) {
      if (f.dead && f.deathTime === 20) this.view.particles.poof(f.pos.x, f.pos.y, f.pos.z);
    }
    if (this.resultTimer > 0 && --this.resultTimer === 0) this.finishOnlineDuel();
  }

  /** Splashes and other events that belong to the world rather than a fighter. */
  private handleWorldEvents(w: World) {
    const fx = this.view.particles;
    for (const e of w.events) {
      if (e.type === 'splash') {
        fx.splash(e.x, e.y, e.z, e.color, e.xp);
        this.sound.glassBreak(e);
      } else if (e.type === 'blockPlace' || e.type === 'blockBreak') {
        const at = { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 };
        this.sound.block(at, blockSound(e.block), e.type === 'blockBreak');
        if (e.type === 'blockBreak') fx.blockBreak(e.x, e.y, e.z, BLOCK_COLORS[e.block] ?? 0x888888);
      } else if (e.type === 'explosion') {
        this.view.explosions.onEvent(e);
        this.sound.explosion(e, e.power);
      } else if (e.type === 'wind') {
        this.view.explosions.gust(e.x, e.y, e.z, e.power);
        this.sound.windBurst(e, e.power);
      } else if (e.type === 'crystalPlace') {
        this.sound.crystalPlace(e);
      } else if (e.type === 'anchorCharge') {
        this.sound.anchorCharge({ x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 }, e.charge);
      } else if (e.type === 'pearl') {
        fx.portal(e.x, e.y, e.z);
      } else if (e.type === 'blockConvert') {
        const at = { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 };
        if (e.from === B.COBWEB) fx.blockBreak(e.x, e.y, e.z, BLOCK_COLORS[B.COBWEB]);
        else {
          this.sound.fizz(at);
          fx.poof(at.x, e.y, at.z);
        }
      }
    }
    w.events.length = 0;
    // Ambient potion swirls around anyone with an effect (not our own first-person camera).
    for (const f of w.fighters) {
      if (f.dead || !f.effects.size || Math.random() > 0.35) continue;
      if (f === this.match.player && this.view.cameraMode === 'first') continue;
      let color = 0;
      let n = 0;
      for (const id of f.effects.keys()) if (Math.random() * ++n < 1) color = EFFECT_COLORS[id];
      fx.swirl(f.pos.x, f.pos.y, f.pos.z, color);
    }
  }

  private handleEvents(f: Fighter, live: boolean) {
    const m = this.match;
    const isPlayer = f === m.player;
    const fx = this.view.particles;
    for (const e of f.events as FighterEvent[]) {
      switch (e.type) {
        case 'attack': {
          const t = e.target;
          const kind: HitKind = e.crit ? 'crit' : e.sprint ? 'knockback' : e.strong ? 'strong' : 'weak';
          this.sound.hit(kind, t.pos);
          if (e.crit) fx.crit(t.pos.x, t.pos.y, t.pos.z, false);
          if (e.enchanted) fx.crit(t.pos.x, t.pos.y, t.pos.z, true, 14);
          if (isPlayer && live) {
            this.lastReach = e.reach;
            if (this.settings.hitFeedback) {
              const swap = e.swap ? ' · SWAP' : '';
              if (e.crit) this.hud.showFeedback(`CRIT!${swap}`, 'crit');
              else if (e.sprint) this.hud.showFeedback(`SPRINT KB${swap}`, 'sprint');
              else if (!e.strong) this.hud.showFeedback(`WEAK ${Math.round(e.scale * 100)}%${swap}`, 'weak');
              else this.hud.showFeedback(`HIT${swap}`, 'hit');
            }
          }
          break;
        }
        case 'sweep':
          this.sound.sweep(e);
          this.view.explosions.sweep(e.x, e.y, e.z);
          break;
        case 'hitShield':
          if (isPlayer && live && this.settings.hitFeedback) {
            if (e.disabled) this.hud.showFeedback(e.swap ? 'SHIELD DISABLED · SWAP' : 'SHIELD DISABLED', 'sprint');
            else this.hud.showFeedback('BLOCKED', 'miss');
          }
          break;
        case 'shieldBlock':
          this.sound.shieldBlock(f.pos);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback('BLOCKED', 'hit');
          break;
        case 'shieldDisabled':
          this.sound.shieldBreak(f.pos);
          if (isPlayer && live) this.hud.showFeedback('YOUR SHIELD IS DOWN', 'weak');
          break;
        case 'shieldRaise':
          if (live) this.sound.shieldRaise(f.pos);
          break;
        case 'shoot':
          this.sound.bowShoot(f.pos, e.power);
          break;
        case 'crossbowLoading':
          this.sound.crossbowLoad(f.pos, false);
          break;
        case 'crossbowLoaded':
          this.sound.crossbowLoad(f.pos, true);
          break;
        case 'arrowHit': {
          const t = e.target;
          this.sound.arrowHit(t.pos);
          if (e.crit) fx.crit(t.pos.x, t.pos.y, t.pos.z, false);
          if (isPlayer && live) {
            this.sound.arrowDing();
            if (this.settings.hitFeedback) this.hud.showFeedback(e.crit ? 'ARROW · CRIT' : 'ARROW HIT', 'crit');
          }
          break;
        }
        case 'pickup':
          this.sound.pickup(f.pos);
          break;
        case 'swapHands':
          if (isPlayer && live) this.sound.equip();
          break;
        case 'noDamage':
          this.sound.hit('weak', e.target.pos);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback('NO DAMAGE', 'weak');
          break;
        case 'hurt':
          if (e.fire) this.sound.sizzle(f.pos);
          this.sound.hurt(f.pos, isPlayer && live);
          break;
        case 'throw':
          if (e.kind === 'pearl') this.sound.pearl(f.pos, false);
          else this.sound.throwItem(f.pos);
          break;
        case 'equip':
          this.sound.equipArmor(f.pos, e.id === 'elytra');
          break;
        case 'smash':
          this.sound.smash(f.pos, e.fall > 5);
          fx.crit(f.pos.x, f.pos.y - 1, f.pos.z, false, 40);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback(`SMASH ${(e.damage / 2).toFixed(1)} ❤ · ${e.fall.toFixed(0)} blocks`, 'crit');
          break;
        case 'pearlLand':
          this.sound.pearl(f.pos, true);
          fx.portal(f.pos.x, f.pos.y, f.pos.z);
          break;
        case 'explosionHit':
          if (!isPlayer && live && this.settings.hitFeedback && e.damage > 0) this.hud.showFeedback(`BLAST ${(e.damage / 2).toFixed(1)} ❤`, 'crit');
          break;
        case 'splashed':
          if (isPlayer && live && this.settings.hitFeedback && !e.own) this.hud.showFeedback(`SPLASHED · ${Math.round(e.scale * 100)}%`, 'weak');
          else if (isPlayer && live && this.settings.hitFeedback && e.potion === 'healing') this.hud.showFeedback(`POT ${Math.round(e.scale * 100)}%`, e.scale > 0.85 ? 'crit' : 'hit');
          break;
        case 'totem':
          this.sound.totem(f.pos);
          fx.totem(f.pos.x, f.pos.y, f.pos.z);
          if (isPlayer && live) this.hud.showTotem();
          else if (live && this.settings.hitFeedback) this.hud.showFeedback('TOTEM POPPED!', 'crit');
          break;
        case 'itemBreak':
          this.sound.itemBreak(f.pos);
          if (isPlayer && live) this.hud.showFeedback(`${ITEMS[e.id].name.toUpperCase()} BROKE`, 'weak');
          break;
        case 'xpPickup':
          this.sound.xp(f.pos);
          break;
        case 'bucket':
          this.sound.bucket(f.pos, e.fluid === B.LAVA, e.fill);
          break;
        case 'mineHit':
          if (live && (f.swingTime <= 0 || f.swingTime === 3)) this.sound.dig(f.pos, blockSound(e.block));
          break;
        case 'miss':
          this.sound.swing(f.pos);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback('MISS', 'miss');
          break;
        case 'eatTick': {
          this.sound.eat(f.pos);
          // LivingEntity.spawnItemParticles: 0.6 in front of the eyes, 0.3–0.9 below them
          const eye = f.eyePos();
          const d = lookDir(f.yaw, f.pitch, new V3());
          fx.crumbs(eye.x + d.x * 0.6, eye.y + d.y * 0.6 - 0.3, eye.z + d.z * 0.6, d.x, d.z);
          break;
        }
        case 'eatDone':
          this.sound.burp(f.pos);
          break;
        case 'step':
          if (live) this.sound.step(f.pos, isPlayer);
          break;
        case 'land':
          if (live) this.sound.land(f.pos, isPlayer);
          break;
        default:
          break;
      }
    }
    f.events.length = 0;
  }
}
