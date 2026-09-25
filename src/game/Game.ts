import { BotBrain } from '../ai/BotBrain';
import { DIFFICULTIES, type DifficultyId } from '../ai/difficulty';
import { Sound, type HitKind } from '../audio/Sound';
import { deathMessage, registerBuiltins } from '../commands/builtin';
import { CommandError, Dispatcher } from '../commands/dispatcher';
import { COLOR, defaultSession, sessionModified, type ChatLine, type CmdCtx, type CommandHost, type SessionState } from '../commands/host';
import { TICK_MS } from '../core/constants';
import { clamp, lookDir, V3 } from '../core/math';
import { Rng } from '../core/rng';
import { Input } from '../input/Input';
import { DamageIndicators } from '../mods/damage';
import { ModManager } from '../mods/registry';
import { ModHud, type WidgetFrame } from '../mods/widgets';
import type { Assets } from '../render/assets';
import { SceneRenderer } from '../render/SceneRenderer';
import { Chat } from '../ui/Chat';
import { HUD } from '../ui/HUD';
import { Marketplace } from '../ui/Marketplace';
import { Menus } from '../ui/Menus';
import { loadPlayerName, loadRecords, saveRecords, saveSettings, type Records, type Settings } from '../ui/settings';
import { makeKitIcon, type Sprite } from '../ui/sprites';
import { itemIcon } from '../render/itemIcons';
import { InventoryScreen } from '../ui/Inventory';
import { NetClient, type NetStatus } from '../net/Client';
import { NetMatch } from '../net/NetMatch';
import { CHAT_MAX, type ChatKind, type ServerMsg } from '../net/protocol';
import type { AttributeId } from './attributes';
import { performAttack, rayDistanceToTarget } from './combat';
import type { Fighter, FighterEvent } from './Fighter';
import { EFFECT_COLORS, ITEMS, type ItemStack } from './items';
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

const PARTICLE_DENSITY = { all: 1, decreased: 0.5, minimal: 0.2 } as const;
/** Real time a frame may spend on ticks at high /tick rates or during /tick sprint. */
const TICK_BUDGET_MS = 25;

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
  // ---- commands & chat
  private readonly commands = new Dispatcher<CmdCtx>();
  private readonly chat: Chat;
  private readonly host: CommandHost;
  private readonly session: SessionState = defaultSession();
  /** Commands changed this duel: it is not recorded. */
  private cheated = false;
  /** /tick step: ticks left to run while frozen. */
  private stepTicks = 0;
  /** /tick sprint in progress. */
  private sprinting: { left: number; total: number; start: number } | null = null;
  /** Smoothed milliseconds of work per tick (/tick query). */
  private mspt = 0;
  private lobbyNames: string[] = [];
  // ---- mods
  private readonly mods = new ModManager();
  private readonly modHud: ModHud;
  private readonly market: Marketplace;
  private readonly damage: DamageIndicators;
  private readonly hudEditor: HTMLDivElement;
  private zoom = 1;
  private zoomScroll = 1;
  private freelookToggled = false;
  private freelookWasDown = false;
  private readonly widgetFrame: WidgetFrame;
  private readonly tag = { name: '', color: '', status: '' };
  // ---- frame pacing & stats
  private lastDrawn = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  private frameMs = 16;
  private menuDrawn = 0;
  // ---- weather (fades like vanilla's rain level)
  private rainLevel = 0;
  private thunderLevel = 0;
  private flash = 0;
  private nextBolt = 0;
  private thunderAt = 0;

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
    // MSAA on a 2× screen draws 4× the samples for edges you can barely see: Auto skips it there.
    const aa = settings.antialias === 'on' || (settings.antialias === 'auto' && (window.devicePixelRatio || 1) < 2);
    this.view = new SceneRenderer(canvas, this.match.world, assets, { antialias: aa });
    const packIcon = (id: 'diamond_sword' | 'diamond_axe' | 'golden_apple' | 'golden_head' | 'splash_potion' | 'netherite_sword' | 'end_crystal' | 'netherite_axe' | 'mace') =>
      itemIcon({ id, count: 1, potion: 'healing' });
    const kitIcons: Record<string, Sprite> = {};
    for (const kit of KITS) {
      const fromPack = kit.icon === 'sword' ? packIcon('diamond_sword') : kit.icon === 'axe' ? packIcon('diamond_axe') : kit.icon === 'uhc' ? packIcon('golden_head') : kit.icon === 'neth_potion' ? packIcon('netherite_sword') : kit.icon === 'potion' ? packIcon('splash_potion') : kit.icon === 'crystal' ? packIcon('end_crystal') : kit.icon === 'smp' ? packIcon('netherite_axe') : kit.icon === 'mace' ? packIcon('mace') : undefined;
      kitIcons[kit.icon] = fromPack ?? makeKitIcon(kit.icon);
    }
    this.hud = new HUD(uiRoot, this.mods);
    this.modHud = new ModHud(uiRoot, this.mods);
    this.damage = new DamageIndicators(uiRoot);
    this.host = this.makeHost();
    registerBuiltins(this.commands);
    this.chat = new Chat(uiRoot, {
      onSubmit: (text) => this.submitChat(text),
      suggest: (text) => this.suggest(text),
      onClose: () => this.closeChat(),
    });
    this.inventory = new InventoryScreen(uiRoot, {
      onChange: () => {
        this.sound.equip();
        this.netMatch?.syncInventory();
      },
      onClose: () => this.closeInventory(),
      extraLore: (st) => this.foodLore(st),
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
      onMarketplace: () => this.openMarket(),
      installedMods: () => this.mods.installedCount,
    });
    this.market = new Marketplace(uiRoot, this.mods, {
      onClose: () => this.closeMarket(),
      onEditHud: () => this.openHudEditor(),
      onUiSound: () => {
        this.sound.unlock();
        this.sound.ui();
      },
      binds: () => this.settings.keys,
    });
    this.hudEditor = this.buildHudEditor(uiRoot);
    this.mods.onChange(() => this.applyModVisuals());
    this.input = new Input(canvas, {
      onClick: () => {
        if (this.state !== 'playing') return;
        this.match.queueClick();
        this.hud.registerClick(performance.now());
      },
      onSlot: (i) => this.state === 'playing' && this.match.queueSlot(i),
      onScroll: (d) => {
        if (this.state !== 'playing') return;
        // Zoom mod: the wheel zooms further instead of scrolling the hotbar.
        if (this.zoomHeld() && this.mods.cfg('zoom', 'scroll')) {
          this.zoomScroll = clamp(this.zoomScroll * (d < 0 ? 1.25 : 0.8), 1, 4);
          return;
        }
        const dir = this.settings.invertScroll ? -d : d;
        this.match.queueSlot((this.match.player.selected + dir + 9) % 9);
      },
      onToggleCamera: () => {
        this.cameraMode = this.cameraMode === 'first' ? 'third' : 'first';
      },
      onUse: () => {
        if (this.state !== 'playing' || this.inventory.open) return;
        this.hud.registerUse(performance.now());
        this.match.queueUse();
      },
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
        if (!locked && this.state === 'playing' && !this.inventory.open && !this.chat.open) this.pause();
      },
      onChat: (command) => this.openChat(command),
    });
    canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked && !this.inventory.open && !this.chat.open) void this.input.lock();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (this.hudEditor.style.display !== 'none') this.closeHudEditor();
      else if (this.market.open) this.closeMarket();
    });
    this.widgetFrame = {
      fps: 0,
      frameMs: 0,
      ping: null,
      player: this.match.player,
      keys: { forward: false, left: false, back: false, right: false, jump: false, attack: false, use: false },
      cps: { left: 0, right: 0 },
      sprint: null,
      sneakToggled: false,
      gui: 2,
      inGame: false,
    };
    this.clickHint = document.createElement('div');
    this.clickHint.className = 'click-hint';
    this.clickHint.textContent = 'Click to play';
    uiRoot.appendChild(this.clickHint);
    window.addEventListener('resize', () => {
      this.view.resize();
      this.hud.layout(this.settings);
      this.inventory.root.style.setProperty('--gui', String(this.hud.guiScale));
      this.chat.root.style.setProperty('--gui', String(this.hud.guiScale));
    });
    // The macOS app routes its ⌘M menu item here, since the menu swallows the key event.
    window.pvpNative?.onToggleHitboxes(() => this.toggleHitboxes());
    this.applySettings();
    this.toMenu();
    this.view.prewarm();
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
    const inp = this.input;
    inp.sensitivity = s.sensitivity;
    inp.sensitivityY = s.sensitivityY < 0 ? null : s.sensitivityY;
    inp.invertY = s.invertY;
    inp.toggleSprint = s.toggleSprint;
    inp.toggleSneak = s.toggleSneak;
    if (!s.toggleSneak) inp.sneakToggled = false;
    inp.rawInput = s.rawInput;
    inp.fullscreenLock = s.fullscreenLock;
    inp.binds = s.keys;
    this.inventory.binds = s.keys;
    this.sound.volume = s.volume;
    const cat = this.sound.categories;
    cat.players = s.volumePlayers;
    cat.steps = s.volumeSteps;
    cat.blocks = s.volumeBlocks;
    cat.ui = s.volumeUi;
    this.hud.layout(s);
    const gui = String(this.hud.guiScale);
    this.inventory.root.style.setProperty('--gui', gui);
    this.chat.root.style.setProperty('--gui', gui);
    this.chat.applyOptions({ visibility: s.chatVisibility, textOpacity: s.chatOpacity, backgroundOpacity: s.chatBackground, scale: s.chatScale, width: s.chatWidth });
    this.view.particles.density = PARTICLE_DENSITY[s.particles];
    this.applyModVisuals();
  }

  /** Mods that change how things are drawn rather than adding a widget. */
  private applyModVisuals() {
    const m = this.mods;
    const v = this.view;
    v.particles.critBoost = m.on('particles') ? Number(m.cfg('particles', 'multiplier')) : 1;
    v.firstPerson.opts.lowShield = m.on('lowshield') ? Number(m.cfg('lowshield', 'lower')) : 0;
    const hit = m.on('hitcolor');
    for (const model of [v.playerModel, v.botModel]) {
      if (hit) model.hurtColor.set(String(m.cfg('hitcolor', 'color')));
      else model.hurtColor.setRGB(1, 0, 0);
      model.hurtStrength = hit ? Number(m.cfg('hitcolor', 'strength')) : 0.45;
    }
    v.extras.hurtcam = m.on('hurtcam') ? { strength: Number(m.cfg('hurtcam', 'strength')), classic: m.cfg('hurtcam', 'mode') === 'classic' } : null;
  }

  // ------------------------------------------------------------------ marketplace & HUD editor

  private openMarket() {
    this.menus.hideAll();
    this.market.show();
  }

  private closeMarket() {
    this.market.hide();
    this.menus.show(this.menus.settingsFrom);
  }

  private buildHudEditor(parent: HTMLElement): HTMLDivElement {
    const root = document.createElement('div');
    root.className = 'hud-editor';
    root.style.display = 'none';
    const bar = document.createElement('div');
    bar.className = 'hud-editor-bar';
    const text = document.createElement('span');
    text.textContent = 'HUD Editor — drag your mods’ widgets anywhere. They snap to the edges and the centre.';
    const reset = document.createElement('button');
    reset.className = 'mc-btn';
    reset.textContent = 'Reset Positions';
    reset.addEventListener('click', () => {
      this.sound.ui();
      for (const id of Object.keys(this.mods.states) as (keyof ModManager['states'])[]) if (this.mods.states[id].pos) this.mods.setPos(id, undefined);
    });
    const done = document.createElement('button');
    done.className = 'mc-btn';
    done.textContent = 'Done';
    done.addEventListener('click', () => {
      this.sound.ui();
      this.closeHudEditor();
    });
    bar.append(text, reset, done);
    root.append(bar);
    parent.appendChild(root);
    return root;
  }

  private openHudEditor() {
    this.market.hide();
    this.hudEditor.style.display = '';
    this.modHud.setEditing(true);
  }

  private closeHudEditor() {
    this.hudEditor.style.display = 'none';
    this.modHud.setEditing(false);
    this.market.show();
  }

  /** AppleSkin: hunger and saturation in food tooltips. */
  private foodLore(st: ItemStack): string[] {
    const food = ITEMS[st.id].food;
    if (!food || !this.mods.on('appleskin') || !this.mods.cfg('appleskin', 'tooltip')) return [];
    const sat = food.nutrition * food.saturationModifier * 2;
    return [`Hunger +${food.nutrition} · Saturation +${Number.isInteger(sat) ? sat : sat.toFixed(1)}`];
  }

  // ------------------------------------------------------------------ chat & commands

  /** The offline duel commands act on (none on the title screen or online). */
  private get cmdMatch(): Match | null {
    return this.netMatch || this.state === 'menu' ? null : (this.match as Match);
  }

  private makeHost(): CommandHost {
    const game = this;
    return {
      get online() {
        return game.online;
      },
      get match() {
        return game.cmdMatch;
      },
      get session() {
        return game.session;
      },
      print: (line: ChatLine) => this.chat.print(line),
      applySession: () => this.applySession(false),
      markCheated: () => this.markCheated(),
      restart: (opts) => this.restartWith(opts),
      step: (ticks: number) => {
        this.stepTicks = ticks;
      },
      sprint: (ticks: number) => {
        this.stepTicks = 0;
        this.sprinting = { left: ticks, total: ticks, start: performance.now() };
      },
      stopStep: () => {
        const had = this.stepTicks > 0;
        this.stepTicks = 0;
        return had;
      },
      stopSprint: () => {
        if (!this.sprinting) return false;
        this.finishSprint();
        return true;
      },
      msPerTick: () => this.mspt,
      title: (kind, text) => this.hud.showTitle(kind, text),
      get playerName() {
        return loadPlayerName();
      },
      broadcast: (kind: ChatKind, text: string) => this.broadcast(kind, text),
      players: () => {
        const me = loadPlayerName();
        if (this.netMatch) return this.lobbyNames.length ? this.lobbyNames : [me, this.netMatch.bot.name];
        const m = this.cmdMatch;
        return m ? [me, m.bot.name] : [me];
      },
    };
  }

  private openChat(command: boolean) {
    if (this.state !== 'playing' || this.inventory.open || this.chat.open) return;
    // Like any screen, chat lets go of every key — but the duel keeps running behind it.
    this.input.releaseAll();
    this.match.useHeld = false;
    this.match.attackHeld = false;
    this.input.enabled = false;
    this.chat.show(command ? '/' : '');
    this.input.unlock();
  }

  /** Chat closed (Enter or Esc): back into the duel. */
  private closeChat() {
    if (this.state !== 'playing' || this.inventory.open) return;
    this.input.enabled = true;
    void this.input.lock();
  }

  private submitChat(text: string) {
    if (text.startsWith('/')) this.runCommand(text.slice(1));
    else this.broadcast('chat', text);
  }

  private broadcast(kind: ChatKind, text: string) {
    const t = text.slice(0, CHAT_MAX);
    if (this.netMatch && this.net.connected) {
      this.net.send({ t: 'chat', kind, text: t });
      return;
    }
    this.chat.print(this.chatLine(kind, loadPlayerName(), t), false);
  }

  private chatLine(kind: ChatKind, from: string, text: string): ChatLine {
    if (!from) return [{ t: text, c: COLOR.gray, i: true }];
    if (kind === 'say') return [{ t: `[${from}] ${text}` }];
    if (kind === 'me') return [{ t: `* ${from} ${text}` }];
    return [{ t: `<${from}> ${text}` }];
  }

  private runCommand(line: string) {
    const ctx: CmdCtx = { host: this.host, self: this.cmdMatch?.player ?? null };
    try {
      this.commands.execute(line, ctx);
    } catch (e) {
      if (!(e instanceof CommandError)) {
        console.error(e);
        this.chat.print([{ t: 'An unexpected error occurred trying to execute that command', c: COLOR.red }]);
        return;
      }
      // A command that exists but changes the game: say why instead of "Unknown command".
      const root = this.commands.root(line.trim().split(/\s+/)[0].toLowerCase());
      if (root?.requires && !root.requires(ctx)) {
        this.chat.print([{ t: 'That command changes the duel, so it only works against the bot — online the host’s server runs the game.', c: COLOR.red }]);
        return;
      }
      this.chat.print([{ t: e.message, c: COLOR.red }]);
      // Vanilla's context line: the last 10 characters before the error, then <--[HERE].
      if (e.cursor >= 0) {
        const at = Math.min(e.cursor, line.length);
        const before = line.slice(Math.max(0, at - 10), at);
        this.chat.print([
          { t: `${at > 10 ? '...' : ''}${before}`, c: COLOR.gray },
          { t: line.slice(at), c: COLOR.red, u: true },
          { t: '<--[HERE]', c: COLOR.red, i: true },
        ]);
      }
    }
  }

  private suggest(text: string) {
    const ctx: CmdCtx = { host: this.host, self: this.cmdMatch?.player ?? null };
    const res = this.commands.suggest(text, ctx);
    const space = text.indexOf(' ');
    const usage = space > 0 ? this.commands.usage(text.slice(0, space).toLowerCase(), ctx) : [];
    return { start: res.start, list: res.list, usage };
  }

  private markCheated() {
    if (this.cheated || !this.cmdMatch) return;
    this.cheated = true;
    this.chat.print([{ t: 'Commands changed this duel — it won’t count toward your record.', c: COLOR.gray, i: true }]);
  }

  /** Copies session state (rules, time, weather; attributes and game modes on a new duel) into the match. */
  private applySession(fresh: boolean) {
    const m = this.cmdMatch;
    if (!m) return;
    const s = this.session;
    m.frozen = s.frozen;
    Object.assign(m.world.rules, s.rules);
    m.world.dayTime = s.dayTime;
    m.world.raining = s.weather !== 'clear';
    if (!fresh) return;
    for (const who of ['player', 'bot'] as const) {
      const f = who === 'player' ? m.player : m.bot;
      for (const [id, v] of Object.entries(s.attrs[who])) f.setAttribute(id as AttributeId, v as number);
      f.setGameMode(s.gameModes[who]);
      f.health = f.maxHealth;
    }
  }

  private restartWith(opts?: { kit?: KitId; tier?: DifficultyId }) {
    if (opts?.kit) this.settings.kit = opts.kit;
    if (opts?.tier) this.settings.difficulty = opts.tier;
    if (opts?.kit || opts?.tier) saveSettings(this.settings);
    this.startDuel();
  }

  /** /tick sprint finished (or was stopped): report like vanilla. */
  private finishSprint() {
    const sp = this.sprinting;
    if (!sp) return;
    this.sprinting = null;
    const done = sp.total - sp.left;
    const secs = Math.max(1e-3, (performance.now() - sp.start) / 1000);
    this.chat.print([{ t: `Sprint completed with ${Math.round(done / secs)} average ticks per second, or ${((secs * 1000) / Math.max(1, done)).toFixed(2)} ms per tick` }]);
    this.sound.muted = false;
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
    this.chat.hide();
    this.sprinting = null;
    this.stepTicks = 0;
    this.sound.muted = false;
    this.damage.clear();
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
    // A new duel keeps what commands set up (rules, reach, game modes, time…) but not the rest.
    this.state = 'playing';
    this.applySession(true);
    this.cheated = sessionModified(this.session);
    this.sprinting = null;
    this.stepTicks = 0;
    this.sound.muted = false;
    this.damage.clear();
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
    this.lobbyNames = [];
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
    if (msg.t === 'chat') {
      this.chat.print(this.chatLine(msg.kind, msg.from, msg.text), !msg.from);
      return;
    }
    if (msg.t === 'lobby') {
      // "<name> joined the game" / "left the game", like a server.
      const names = msg.players.map((p) => p.name);
      if (this.lobbyNames.length) {
        for (const n of names) if (!this.lobbyNames.includes(n)) this.chat.print([{ t: `${n} joined the game`, c: COLOR.yellow }]);
        for (const n of this.lobbyNames) if (!names.includes(n)) this.chat.print([{ t: `${n} left the game`, c: COLOR.yellow }]);
      }
      this.lobbyNames = names;
    }
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
    this.chat.hide();
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
    const newBest = !this.cheated && m.player.stats.maxCombo > rec.bestCombo;
    // Duels changed by commands (reach, tick rate, creative…) don't count.
    if (!this.cheated) {
      if (won) rec.wins++;
      else rec.losses++;
      rec.bestCombo = Math.max(rec.bestCombo, m.player.stats.maxCombo);
      this.records[key] = rec;
      saveRecords(this.records);
    }
    if (this.sprinting) this.finishSprint();
    if (this.session.rules.doImmediateRespawn) {
      // /gamerule doImmediateRespawn true: no results screen, straight into the next duel.
      const secs = Math.floor(m.fightTicks / 20);
      this.chat.print([
        {
          t: `${won ? 'Victory' : 'Defeat'} in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — ${m.player.stats.hits} hits, best combo ${m.player.stats.maxCombo}.`,
          c: won ? COLOR.green : COLOR.red,
        },
      ]);
      this.startDuel();
      return;
    }
    this.state = 'results';
    this.chat.hide();
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
        unrecorded: this.cheated,
      },
      () => this.startDuel(),
    );
  }

  // ------------------------------------------------------------------ loop

  private zoomHeld(): boolean {
    return this.state === 'playing' && this.mods.on('zoom') && this.input.held('zoom');
  }

  private frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    // Max Framerate: skip display refreshes that come too soon.
    const cap = this.settings.maxFps;
    if (cap > 0 && now - this.lastDrawn < 1000 / cap - 1) return;
    this.lastDrawn = now;
    // Menu Background off: the title screen shows a still frame instead of a live duel.
    if (this.state === 'menu' && !this.settings.menuBackground && !this.market.open && this.hudEditor.style.display === 'none') {
      if (now - this.menuDrawn < 500) {
        this.last = now;
        return;
      }
      this.menuDrawn = now;
    }

    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.fpsFrames++;
    this.fpsTime += dt;
    this.frameMs += (dt * 1000 - this.frameMs) * 0.1;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    const m = this.match;
    const p = m.player;
    const s = this.settings;
    const playing = this.state === 'playing';

    // Zoom (hold C) and Freelook (hold/toggle Alt) mods.
    const zoomOn = this.zoomHeld();
    const target = zoomOn ? Number(this.mods.cfg('zoom', 'factor')) * this.zoomScroll : 1;
    if (!zoomOn) this.zoomScroll = 1;
    this.zoom = this.mods.cfg('zoom', 'smooth') ? this.zoom + (target - this.zoom) * Math.min(1, dt * 14) : target;
    if (Math.abs(this.zoom - target) < 0.005) this.zoom = target;
    this.input.lookScale = zoomOn && this.mods.cfg('zoom', 'slowMouse') ? 1 / Math.max(1, this.zoom) : 1;
    this.view.extras.zoom = this.zoom;
    const flDown = playing && this.mods.on('freelook') && this.input.held('freelook');
    if (this.mods.cfg('freelook', 'mode') === 'toggle') {
      if (flDown && !this.freelookWasDown) this.freelookToggled = !this.freelookToggled;
    } else this.freelookToggled = flDown;
    this.freelookWasDown = flDown;
    const freelook = playing && this.mods.on('freelook') && this.freelookToggled;
    if (!freelook) this.view.extras.freelook = null;
    else if (!this.view.extras.freelook) this.view.extras.freelook = { yaw: p.yaw, pitch: p.pitch };

    if (playing) {
      const [dyaw, dpitch] = this.input.consumeLook();
      const fl = this.view.extras.freelook;
      if (fl) {
        // Freelook turns the camera, not you.
        fl.yaw += dyaw;
        fl.pitch = clamp(fl.pitch + dpitch * (this.mods.cfg('freelook', 'invert') ? -1 : 1), -Math.PI / 2, Math.PI / 2);
      } else if (!p.dead && m.phase !== 'ended') {
        p.yaw += dyaw;
        p.pitch = clamp(p.pitch + dpitch, -Math.PI / 2, Math.PI / 2);
      }
      p.input = this.input.moveInput();
      p.doubleTapSprint = s.doubleTapSprint;
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
    // With chat open the duel runs on, but you stand still.
    if (playing && this.chat.open) {
      p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
      m.useHeld = false;
      m.attackHeld = false;
    }

    // Online: the server keeps ticking whether or not we opened the pause menu, so we have to
    // keep simulating and reporting our position — we just stop taking input.
    const menuStill = this.state === 'menu' && !this.settings.menuBackground;
    const ticking =
      !menuStill && (this.state === 'playing' || this.state === 'menu' || this.state === 'results' || (this.online && this.state === 'paused'));
    // /tick rate only changes offline duels; online and the title screen always run at 20.
    const offlineDuel = !!this.cmdMatch;
    const tickMs = offlineDuel ? 1000 / this.session.tickRate : TICK_MS;
    if (ticking) {
      const budget = performance.now() + TICK_BUDGET_MS;
      if (this.sprinting && offlineDuel && playing) {
        // /tick sprint: as many ticks as fit in the frame budget, sound off.
        this.sound.muted = true;
        const sp = this.sprinting;
        while (sp.left > 0 && performance.now() < budget && this.sprinting) {
          this.timedTick();
          sp.left--;
        }
        this.acc = 0;
        if (this.sprinting && sp.left <= 0) this.finishSprint();
      } else {
        this.acc += dt * 1000;
        let n = 0;
        while (this.acc >= tickMs) {
          this.timedTick();
          this.acc -= tickMs;
          // Never let a high tick rate (or a slow machine) freeze the page: drop the backlog.
          if (++n >= 400 || performance.now() > budget) {
            this.acc = Math.min(this.acc, tickMs);
            break;
          }
        }
      }
    }
    const alpha = ticking ? Math.min(1, this.acc / tickMs) : 1;

    this.updateWeather(dt, offlineDuel);
    this.view.cameraMode = this.state === 'menu' ? 'orbit' : this.cameraMode;
    const tag = this.tag;
    tag.name = m.bot.name;
    tag.color = m.profile.color;
    tag.status = this.state === 'menu' ? '' : m.brain.label;
    this.view.render(p, m.bot, alpha, this.time, dt, s, tag);
    if (this.mods.on('damageindicator')) this.damage.update(this.view.camera, dt);

    const inDuel = this.state !== 'menu';
    if (inDuel) {
      this.hud.update(p, m.bot, s, {
        aimingAtBot: rayDistanceToTarget(p, m.bot) >= 0,
        botName: m.bot.name,
        botColor: m.profile.color,
        botStatus: m.brain.label,
        lastReach: this.lastReach,
        now: performance.now(),
        firstPerson: this.view.cameraMode === 'first' && !this.view.extras.freelook,
      });
    }
    this.chat.root.style.display = inDuel ? '' : 'none';
    if (inDuel) this.chat.update(performance.now());
    this.updateWidgets(p);
    if (this.inventory.open) {
      if (p.dead || m.phase === 'ended' || this.state !== 'playing') this.closeInventory();
      else {
        this.inventory.refresh();
        this.view.renderPreview(this.previewCanvas, p, this.inventory.mouseX, this.inventory.mouseY);
      }
    }
    this.clickHint.style.display = this.state === 'playing' && !this.input.locked && !this.inventory.open && !this.chat.open ? '' : 'none';
    const eye = p.eyePos();
    const l = this.sound.listener;
    l.x = eye.x;
    l.y = eye.y;
    l.z = eye.z;
    l.yaw = p.yaw;
  }

  /** Feeds the mods' HUD widgets (FPS, keystrokes, counters…) without allocating per frame. */
  private updateWidgets(p: Fighter) {
    const editing = this.hudEditor.style.display !== 'none';
    const inGame = this.state === 'playing' || this.state === 'paused';
    if (!inGame && !editing) {
      this.modHud.update(null);
      return;
    }
    const f = this.widgetFrame;
    const inp = this.input;
    const now = performance.now();
    f.fps = this.fps;
    f.frameMs = this.frameMs;
    f.ping = this.netMatch ? this.netMatch.myPing : null;
    f.player = p;
    const k = f.keys;
    k.forward = inp.held('forward');
    k.left = inp.held('left');
    k.back = inp.held('back');
    k.right = inp.held('right');
    k.jump = inp.held('jump');
    k.attack = inp.held('attack');
    k.use = inp.held('use');
    const cps = this.hud.cps(now);
    f.cps.left = cps.left;
    f.cps.right = cps.right;
    f.sprint = !p.sprinting ? null : inp.toggleSprint ? (inp.sprintToggled ? 'toggled' : 'vanilla') : inp.held('sprint') ? 'held' : 'vanilla';
    f.sneakToggled = inp.sneakToggled;
    f.gui = this.hud.guiScale;
    f.inGame = inGame;
    this.modHud.update(f);
  }

  /** Rain and thunder fade in and out (vanilla: rain level ±0.01 per tick); lightning flashes. */
  private updateWeather(dt: number, offlineDuel: boolean) {
    const w = offlineDuel ? this.session.weather : 'clear';
    const toward = (v: number, t: number) => (v < t ? Math.min(t, v + dt * 0.2) : Math.max(t, v - dt * 0.2));
    this.rainLevel = toward(this.rainLevel, w === 'clear' ? 0 : 1);
    this.thunderLevel = toward(this.thunderLevel, w === 'thunder' ? 1 : 0);
    this.flash = Math.max(0, this.flash - dt * 4);
    if (this.thunderLevel > 0.5 && this.state === 'playing') {
      if (this.nextBolt <= 0) this.nextBolt = 4 + Math.random() * 14;
      this.nextBolt -= dt;
      if (this.nextBolt <= 0) {
        this.flash = 1;
        this.thunderAt = 0.3 + Math.random() * 1.2;
      }
    }
    if (this.thunderAt > 0) {
      this.thunderAt -= dt;
      if (this.thunderAt <= 0) this.sound.thunder();
    }
    this.sound.setRain(this.state === 'menu' ? 0 : this.rainLevel);
    const sky = this.view.extras.sky;
    const m = this.cmdMatch;
    sky.dayTime = m ? m.world.dayTime : 6000;
    sky.rain = this.rainLevel;
    sky.thunder = this.thunderLevel;
    sky.flash = this.flash;
  }

  /** One game tick, with /tick step handling and the time it took (for /tick query). */
  private timedTick() {
    const m = this.cmdMatch;
    if (m) {
      if (this.stepTicks > 0) {
        m.frozen = false;
        this.stepTicks--;
      } else m.frozen = this.session.frozen;
    }
    const t0 = performance.now();
    this.tick();
    this.mspt += (performance.now() - t0 - this.mspt) * 0.05;
    // The daylight cycle moves the session's clock too, so the next duel starts at that time.
    const cm = this.cmdMatch;
    if (cm) this.session.dayTime = cm.world.dayTime;
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
        // Immediate respawn skips the results screen, so don't linger either.
        this.resultTimer = this.session.rules.doImmediateRespawn ? 22 : 30;
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

  /** Damage Indicator mod: a number over whoever got hurt. */
  private showDamage(f: Fighter, dmg: number, crit: boolean) {
    const mods = this.mods;
    if (!mods.on('damageindicator')) return;
    const self = f === this.match.player;
    if (self && (!mods.cfg('damageindicator', 'showOwn') || this.view.cameraMode === 'first')) return;
    const hearts = mods.cfg('damageindicator', 'style') === 'hearts';
    const text = hearts ? `-${(dmg / 2).toFixed(1)} ❤` : `-${Math.round(dmg * 10) / 10}`;
    this.damage.spawn(f.pos.x, f.pos.y + (f.sneaking ? 1.6 : 1.9), f.pos.z, text, crit && !!mods.cfg('damageindicator', 'crits'), Number(mods.cfg('damageindicator', 'scale')));
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
          // Particles+ can add sharpness sparks to every hit.
          if (e.enchanted || (this.mods.on('particles') && this.mods.cfg('particles', 'alwaysSharp'))) fx.crit(t.pos.x, t.pos.y, t.pos.z, true, 14);
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
          if (live && e.damage > 0) this.showDamage(f, e.damage, e.crit);
          break;
        case 'death':
          // Vanilla death messages in chat (/gamerule showDeathMessages).
          if (live && !this.netMatch && this.session.rules.showDeathMessages) {
            this.chat.print(deathMessage(f, (x) => (x === m.player ? loadPlayerName() : x.name)));
          }
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
