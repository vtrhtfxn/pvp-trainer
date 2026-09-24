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
import { renderItemIcon } from '../render/icons';
import { NetClient, type NetStatus } from '../net/Client';
import { NetMatch } from '../net/NetMatch';
import type { NetHit, ServerMsg } from '../net/protocol';
import { performAttack, rayDistanceToTarget } from './combat';
import type { Fighter, FighterEvent } from './Fighter';
import { KITS, kitById } from './kits';
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
    const swordIcon = renderItemIcon(this.view.renderer, assets.sword, 32);
    const appleIcon = renderItemIcon(this.view.renderer, assets.apple, 32);
    const kitIcons: Record<string, Sprite> = {};
    for (const kit of KITS) kitIcons[kit.icon] = makeKitIcon(kit.icon, swordIcon, appleIcon);
    this.hud = new HUD(uiRoot);
    this.hud.setIcons({ diamond_sword: swordIcon, golden_apple: appleIcon });
    this.menus = new Menus(uiRoot, settings, this.records, kitIcons, {
      onStart: () => this.startDuel(),
      onResume: () => this.resume(),
      onRestart: () => this.startDuel(),
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
      onToggleHitboxes: () => this.toggleHitboxes(),
      onRestart: () => {
        if (this.state !== 'results') return;
        if (this.netMatch) this.netMatch.requestRematch();
        else this.startDuel();
      },
      onPointerLockChange: (locked) => {
        if (!locked && this.state === 'playing') this.pause();
      },
    });
    canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked) void this.input.lock();
    });
    this.clickHint = document.createElement('div');
    this.clickHint.className = 'click-hint';
    this.clickHint.textContent = 'Click to play';
    uiRoot.appendChild(this.clickHint);
    window.addEventListener('resize', () => {
      this.view.resize();
      this.hud.layout(this.settings);
    });
    // The macOS app routes its ⌘M menu item here, since the menu swallows the key event.
    window.pvpNative?.onToggleHitboxes(() => this.toggleHitboxes());
    this.applySettings();
    this.toMenu();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------------ state changes

  private newDemo(): Match {
    const m = new Match(kitById('sword'), DIFFICULTIES.hard, 7);
    m.phase = 'fight';
    return m;
  }

  private makeDemoBrain(m: Match): BotBrain {
    return new BotBrain(m.player, m.bot, m.world, DIFFICULTIES.hard, new Rng(11), () => performAttack(m.player, m.bot));
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
    this.sound.volume = s.volume;
    this.hud.layout(s);
  }

  private toMenu() {
    this.state = 'menu';
    this.input.enabled = false;
    this.input.unlock();
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
    this.net.connect(url, room, name);
  }

  leaveOnline(toMenu = true) {
    this.net.close();
    this.netMatch = null;
    if (toMenu) this.toMenu();
  }

  private onNetStatus(status: NetStatus, detail: string) {
    this.menus.setNetStatus(status, detail, this.net.room);
    if (status === 'error' || status === 'closed') {
      const wasPlaying = this.netMatch !== null;
      this.netMatch = null;
      if (wasPlaying) {
        this.state = 'menu';
        this.input.enabled = false;
        this.input.unlock();
        this.match = this.newDemo();
        this.demoBrain = this.makeDemoBrain(this.match as Match);
        this.view.cameraMode = 'orbit';
        this.hud.setVisible(false);
      }
      this.menus.show('multiplayer');
    }
  }

  private onNetMessage(msg: ServerMsg) {
    if (msg.t === 'start') {
      if (!this.netMatch) {
        this.netMatch = new NetMatch(this.net, this.net.you);
        this.match = this.netMatch;
      }
      this.netMatch.handle(msg);
      this.beginOnlineRound();
      return;
    }
    if (!this.netMatch) return;
    this.netMatch.handle(msg);
    switch (msg.t) {
      case 'hit':
        this.onNetHit(msg.hit, msg.on);
        break;
      case 'miss': {
        const who = msg.by === this.net.you ? this.netMatch.player : this.netMatch.bot;
        this.sound.swing(who.pos);
        if (msg.by === this.net.you && this.settings.hitFeedback) this.hud.showFeedback('MISS', 'miss');
        break;
      }
      case 'eat':
        // Our own eating already produced local particles and sound.
        if (msg.by !== this.net.you) {
          const f = this.netMatch.bot;
          if (msg.kind === 'done') this.sound.burp(f.pos);
          else {
            this.sound.eat(f.pos);
            const eye = f.eyePos();
            const d = lookDir(f.yaw, f.pitch, new V3());
            this.view.particles.crumbs(eye.x + d.x * 0.6, eye.y + d.y * 0.6 - 0.3, eye.z + d.z * 0.6, d.x, d.z);
          }
        }
        break;
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

  private onNetHit(hit: NetHit, on: number) {
    const m = this.netMatch;
    if (!m) return;
    const attacker = hit.by === this.net.you ? m.player : m.bot;
    const victim = on === this.net.you ? m.player : m.bot;
    const fx = this.view.particles;
    if (hit.blocked) {
      this.sound.hit('weak', victim.pos);
      if (hit.by === this.net.you && this.settings.hitFeedback) this.hud.showFeedback('NO DAMAGE', 'weak');
      return;
    }
    const kind: HitKind = hit.crit ? 'crit' : hit.sprint ? 'knockback' : hit.strong ? 'strong' : 'weak';
    this.sound.hit(kind, victim.pos);
    if (hit.crit) fx.crit(victim.pos.x, victim.pos.y, victim.pos.z, false);
    fx.crit(victim.pos.x, victim.pos.y, victim.pos.z, true, 14);
    this.sound.hurt(victim.pos, on === this.net.you);
    if (hit.by === this.net.you) {
      this.lastReach = hit.reach;
      if (this.settings.hitFeedback) {
        if (hit.crit) this.hud.showFeedback('CRIT!', 'crit');
        else if (hit.sprint) this.hud.showFeedback('SPRINT KB', 'sprint');
        else if (!hit.strong) this.hud.showFeedback(`WEAK ${Math.round(hit.scale * 100)}%`, 'weak');
        else this.hud.showFeedback('HIT', 'hit');
      }
    }
    void attacker;
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
      m.useHeld = this.input.useHeld;
    } else {
      this.input.consumeLook();
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
      });
    }
    this.clickHint.style.display = this.state === 'playing' && !this.input.locked ? '' : 'none';
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
      m.useHeld = this.demoBrain.state === 'eat';
      m.tick();
      if (m.phase === 'ended' && m.phaseTicks > 60) {
        this.match = this.newDemo();
        this.demoBrain = this.makeDemoBrain(this.match as Match);
      }
      this.handleEvents(m.player, false);
      this.handleEvents(m.bot, false);
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

    // Only movement/eating events are produced locally; hits arrive from the server.
    this.handleEvents(m.player, true);
    m.bot.events.length = 0;
    for (const f of [m.player, m.bot]) {
      if (f.dead && f.deathTime === 20) this.view.particles.poof(f.pos.x, f.pos.y, f.pos.z);
    }
    if (this.resultTimer > 0 && --this.resultTimer === 0) this.finishOnlineDuel();
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
              if (e.crit) this.hud.showFeedback('CRIT!', 'crit');
              else if (e.sprint) this.hud.showFeedback('SPRINT KB', 'sprint');
              else if (!e.strong) this.hud.showFeedback(`WEAK ${Math.round(e.scale * 100)}%`, 'weak');
              else this.hud.showFeedback('HIT', 'hit');
            }
          }
          break;
        }
        case 'noDamage':
          this.sound.hit('weak', e.target.pos);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback('NO DAMAGE', 'weak');
          break;
        case 'hurt':
          this.sound.hurt(f.pos, isPlayer && live);
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
