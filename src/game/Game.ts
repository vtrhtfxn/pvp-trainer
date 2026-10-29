import * as THREE from 'three';
import { BotBrain } from '../ai/BotBrain';
import { DIFFICULTIES, DIFFICULTY_ORDER, type DifficultyId, type TierId } from '../ai/difficulty';
import { Sound, type HitKind } from '../audio/Sound';
import { deathMessage, registerBuiltins } from '../commands/builtin';
import { CommandError, Dispatcher } from '../commands/dispatcher';
import { COLOR, defaultSession, sessionModified, type ChatLine, type CmdCtx, type CommandHost, type SessionState } from '../commands/host';
import { TICK_MS } from '../core/constants';
import { clamp, lookDir, V3 } from '../core/math';
import { Rng } from '../core/rng';
import { Input } from '../input/Input';
import { keyName } from '../input/keybinds';
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
import { awardTier, loadMyTiers, newSeries, saveMyTiers, scoreRound, TIER_POINTS, type MyTiers, type Series } from './series';
import { makeKitIcon, type Sprite } from '../ui/sprites';
import { itemIcon } from '../render/itemIcons';
import { InventoryScreen } from '../ui/Inventory';
import { NetClient, type NetStatus } from '../net/Client';
import { NetMatch } from '../net/NetMatch';
import { CHAT_MAX, type ChatKind, type ServerMsg } from '../net/protocol';
import type { AttributeId } from './attributes';
import { performAttack, rayDistanceToTarget, renderedPick } from './combat';
import type { Fighter, FighterEvent } from './Fighter';
import {
  GAUNTLET_TIERS,
  earnAdvancements,
  gauntletRound,
  gauntletTier,
  loadAdvancements,
  loadGauntletBest,
  loadKillEffect,
  newGauntlet,
  rewardsOf,
  saveGauntletBest,
  saveKillEffect,
  type AdvEvent,
  type Gauntlet,
  type KillEffectId,
} from './fun';
import { Toasts } from '../ui/Toasts';
import { EFFECT_COLORS, ITEMS, type ItemId, type ItemStack } from './items';
import { KITS, isCustomKit, kitById, type KitId } from './kits';
import { isYours, recordGame, roundName, saveTournament } from './tournament';
import { TournamentUI } from '../ui/Tournament';
import { netheriteSpearLogo, uhcLogo } from '../ui/kitLogos';
import type { TourView } from '../net/tourney';
import { loadCustomKits } from './customKits';
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
import { Match, PREP_TICKS } from './Match';
import { Spectate, type SpecCam, type Watch } from './Spectate';
import { ReplayRecorder, loadReplays, saveReplays, REPLAY_VERSION, type ReplayAction, type ReplayData } from './replay';
import { ReplayWatch } from './ReplayWatch';
import { analyze } from './coach';
import { JOIN_TIMEOUT_MS, JOIN_TIMEOUT_TEXT, OnlineHost, joinOnline, normalizeOnlineCode } from '../net/p2p';
import { ChestScreen, ScoreboardHud, ShopScreen } from '../ui/ModeScreens';
import type { ScoreLine } from './modes/GameMode';
import { Bedwars } from './modes/Bedwars';
import { Skywars } from './modes/Skywars';
import { SpectatorHud } from '../ui/SpectatorHud';
import { DrillHud } from '../ui/DrillHud';
import { DRILLS, DrillRun, drillById, loadDrillProgress, loadDrillSpeed, recordDrill } from '../trainer/drills';

type State = 'menu' | 'playing' | 'paused' | 'results' | 'spectating';
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
  /** Bot vs Bot: the fight being watched. */
  private spec: Watch | null = null;
  /** Saved replays, newest first. */
  private replays: ReplayData[] = loadReplays();
  /** Where Esc goes from a replay (the Replays list or the Coach), or null for the title screen. */
  private replayBack: (() => void) | null = null;
  private readonly specHud: SpectatorHud;
  /** Trainer: the drill being played (and the last one, for Try again). */
  private drill: DrillRun | null = null;
  private lastDrill: string | null = null;
  private readonly drillHud: DrillHud;
  private readonly drillProgress = loadDrillProgress();
  private readonly view: SceneRenderer;
  private readonly hud: HUD;
  private readonly menus: Menus;
  private readonly input: Input;
  private readonly sound = new Sound();
  private records: Records;
  private readonly myTiers: MyTiers = loadMyTiers();
  /** The "first to" series the current duel belongs to. */
  private series: Series | null = null;
  /** A Gauntlet run in progress (every tier in a row on three lives), or null. */
  private gauntlet: Gauntlet | null = null;
  /** Tournament screens, and the game of your tournament match being played (null otherwise). */
  private readonly tourney: TournamentUI;
  private tourneyGame: { kit: KitId; tier: TierId; name: string } | null = null;
  /** Online tournament: the latest view from the host (null outside a tournament room). */
  private tourView: TourView | null = null;
  /** Your game against a bot in an online tournament is running locally right now. */
  private onlineTourGame = false;
  /** The online tournament's result was already counted for advancements. */
  private tourAwarded = false;
  /** Advancements earned (kept across sessions). */
  private readonly advancements = loadAdvancements();
  private killEffect: KillEffectId = loadKillEffect(this.advancements);
  private readonly toasts: Toasts;
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
  /** Where the chest screen was opened (online: to match the server's updates to it). */
  private openChestAt: { x: number; y: number; z: number } | null = null;
  private readonly inventory: InventoryScreen;
  private readonly previewCanvas: HTMLCanvasElement;
  // ---- commands & chat
  private readonly commands = new Dispatcher<CmdCtx>();
  private readonly chat: Chat;
  private readonly host: CommandHost;
  private readonly session: SessionState = defaultSession();
  /** Commands changed this duel: it is not recorded. */
  private cheated = false;
  /** How far between the last tick and the next the last frame was drawn. */
  private renderAlpha = 1;
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
  private readonly scoreboard: ScoreboardHud;
  private readonly shopUi: ShopScreen;
  private readonly chestUi: ChestScreen;
  private readonly tag = { name: '', color: '', status: '' };
  // ---- frame pacing & stats
  private lastDrawn = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private fps = 0;
  private frameMs = 16;
  private menuDrawn = 0;
  /** What the inventory's player preview last showed: it is only redrawn when that changes. */
  private previewKey = '';
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
    // Kits made in the kit editor; a saved selection whose kit is gone goes back to Sword.
    const customKits = loadCustomKits();
    if (isCustomKit(settings.kit) && !customKits.some((k) => k.id === settings.kit)) settings.kit = 'sword';
    this.net = new NetClient({
      onStatus: (status, detail) => this.onNetStatus(status, detail),
      onMessage: (msg) => this.onNetMessage(msg),
    });
    this.match = this.newDemo();
    this.demoBrain = this.makeDemoBrain(this.match as Match);
    // MSAA on a 2× screen draws 4× the samples for edges you can barely see: Auto skips it there,
    // and on low-end machines (under 8 GB or 4 cores), where its framebuffers (~90 MB) hurt more.
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lowEnd = (nav.deviceMemory ?? 8) < 8 || (navigator.hardwareConcurrency || 4) < 4;
    const aa = settings.antialias === 'on' || (settings.antialias === 'auto' && (window.devicePixelRatio || 1) < 2 && !lowEnd);
    this.view = new SceneRenderer(canvas, this.match.world, assets, { antialias: aa });
    const packIcon = (id: ItemId) =>
      itemIcon({ id, count: 1, potion: 'healing' });
    const kitIcons: Record<string, Sprite> = {};
    for (const kit of KITS) {
      const fromPack = kit.icon === 'sword' ? packIcon('diamond_sword') : kit.icon === 'axe' ? packIcon('diamond_axe') : kit.icon === 'uhc' ? packIcon('golden_head') : kit.icon === 'neth_potion' ? packIcon('netherite_sword') : kit.icon === 'potion' ? packIcon('splash_potion') : kit.icon === 'crystal' ? packIcon('end_crystal') : kit.icon === 'smp' ? packIcon('netherite_axe') : kit.icon === 'mace' ? packIcon('mace') : undefined;
      kitIcons[kit.icon] = fromPack ?? makeKitIcon(kit.icon);
    }
    // 1.8 Sword: the diamond sword with an enchantment glint; custom kits: a chest.
    kitIcons.sword18 = itemIcon({ id: 'diamond_sword', count: 1, ench: { sharpness: 5 } }) ?? makeKitIcon('sword');
    kitIcons.custom = makeKitIcon('custom');
    kitIcons.cart = itemIcon({ id: 'tnt_minecart', count: 1 }) ?? makeKitIcon('custom');
    kitIcons.spear_mace = netheriteSpearLogo(itemIcon({ id: 'netherite_spear', count: 1 })) ?? makeKitIcon('mace');
    kitIcons.uhc = uhcLogo();
    kitIcons.bedwars = itemIcon({ id: 'red_wool', count: 1 }) ?? makeKitIcon('custom');
    kitIcons.skywars = itemIcon({ id: 'ender_pearl', count: 1 }) ?? makeKitIcon('custom');
    kitIcons.dia_smp = itemIcon({ id: 'diamond_chestplate', count: 1 }) ?? makeKitIcon('axe');
    this.hud = new HUD(uiRoot, this.mods);
    this.specHud = new SpectatorHud(
      uiRoot,
      (cam) => {
        const spec = this.spec;
        if (!spec || spec.cam === cam) return;
        const was = spec.cam;
        spec.cam = cam;
        this.enterSpectateCam(was);
        this.sound.ui();
      },
    );
    this.scoreboard = new ScoreboardHud(uiRoot);
    const overlayCb = {
      onClose: () => this.closeModeScreens(),
      onUiSound: () => {
        this.sound.unlock();
        this.sound.ui();
      },
    };
    this.shopUi = new ShopScreen(uiRoot, overlayCb);
    this.chestUi = new ChestScreen(uiRoot, overlayCb);
    this.drillHud = new DrillHud(uiRoot);
    this.toasts = new Toasts(uiRoot);
    this.modHud = new ModHud(uiRoot, this.mods);
    this.modHud.avoid = this.hud.practice;
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
      onSpectate: (kit, a, b) => this.startSpectate(kit, a, b),
      onWatchReplay: (r) => this.watchReplay(r, () => this.menus.show('replays')),
      onCoachReplay: (r) => this.openCoach(r, () => this.menus.show('replays')),
      onStarReplay: (id) => this.starReplay(id),
      onDeleteReplay: (id) => this.deleteReplay(id),
      onDrill: (id) => this.startDrill(id),
      drillProgress: () => this.drillProgress,
      onGauntlet: () => this.startGauntlet(),
      onTournament: () => {
        this.menus.hideAll();
        this.tourney.showEntry();
      },
      gauntletBest: () => loadGauntletBest(),
      locker: () => ({ unlocked: this.advancements, selected: this.killEffect }),
      onKillEffect: (id) => {
        this.killEffect = id;
        saveKillEffect(id);
        // Preview it on the bot fighting in the title-screen background.
        const b = this.match.bot;
        if (id !== 'none') this.playKillEffect(id, b.pos);
      },
      myTiers: () => this.myTiers,
      onResume: () => this.resume(),
      onRestart: () => {
        if (!this.online) this.restartCurrent();
      },
      onQuit: () => this.toMenu(),
      onSettingsChanged: () => this.applySettings(),
      onUiSound: () => {
        this.sound.unlock();
        this.sound.ui();
      },
      onConnect: (url, room, name) => this.startOnline(url, room, name),
      onHostOnline: (name) => this.hostOnline(name),
      onHostTournament: (name, size, field) => this.hostOnline(name, { size, field }),
      onJoinOnline: (code, name) => this.joinOnline(code, name),
      onLeaveOnline: () => this.leaveOnline(),
      onMarketplace: () => this.openMarket(),
      installedMods: () => this.mods.installedCount,
    }, customKits);
    this.menus.setReplays(this.replays);
    this.tourney = new TournamentUI(uiRoot, {
      onUiSound: () => {
        this.sound.unlock();
        this.sound.ui();
      },
      onPlayGame: (kit, opp) => {
        this.tourney.hide();
        this.tourneyGame = { kit, tier: opp.tier ?? 'lt3', name: opp.name };
        this.startDuel(true);
      },
      onLeave: () => {
        this.tourney.hide();
        this.toMenu();
      },
      onFinished: (won, size) => {
        this.earn({ kind: 'tournament', won, size });
        if (won) this.sound.jingle(true);
      },
      kitIcon: (kit) => kitIcons[kitById(kit).icon],
      yourBest: () =>
        (Object.entries(this.myTiers) as [KitId, TierId][])
          .sort((a, b) => TIER_POINTS[b[1]] - TIER_POINTS[a[1]])
          .map(([k]) => k),
      // Your best tier (0 = LT5 … 9 = HT1); with none yet you're seeded like an LT4.
      youRating: () => this.myRating(),
      playerName: () => loadPlayerName(),
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
        // Judge the click on what is on screen right now (see renderedPick).
        const m = this.match;
        const picked = renderedPick(m.player, m.bot, this.renderAlpha);
        if (m instanceof Match) m.queueClick(picked);
        else m.queueClick(picked, this.renderAlpha);
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
        if (this.state !== 'playing' || this.screenOpen) return;
        this.hud.registerUse(performance.now());
        this.match.queueUse();
      },
      onSwapHands: () => this.state === 'playing' && !this.screenOpen && this.match.queueSwapHands(),
      onInventory: () => this.toggleInventory(),
      onToggleHitboxes: () => this.toggleHitboxes(),
      onRestart: () => {
        if (this.state !== 'results') return;
        if (this.netMatch) {
          this.netMatch.requestRematch();
          this.hud.showCenter('Waiting for rematch…', 'toast', 60);
        } else this.restartCurrent();
      },
      onPointerLockChange: (locked) => {
        if (locked || this.state !== 'playing' || this.screenOpen || this.chat.open) return;
        // The Esc that just closed a screen, seen by the browser as "leave pointer lock": back in
        // once the key is up instead of pausing.
        if (performance.now() < this.escGraceUntil) {
          this.relockOnEscUp = true;
          return;
        }
        this.pause();
      },
      onChat: (command) => this.openChat(command),
    });
    canvas.addEventListener('click', () => {
      if (this.state === 'playing' && !this.input.locked && !this.screenOpen && !this.chat.open) void this.input.lock();
      else if (this.state === 'spectating' && this.spec?.cam === 'free' && !this.input.locked) void this.input.lock(false);
    });
    // Whether Esc is held (capture phase: seen before any screen handles it).
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Escape') this.escDown = true;
      },
      true,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.code !== 'Escape') return;
        this.escDown = false;
        if (this.escGraceUntil === Infinity) this.escGraceUntil = performance.now() + 250;
        if (!this.relockOnEscUp) return;
        this.relockOnEscUp = false;
        setTimeout(() => {
          if (this.state === 'playing' && !this.screenOpen && !this.chat.open && !this.input.locked) void this.input.lock();
        }, 30);
      },
      true,
    );
    window.addEventListener('keydown', (e) => {
      if (this.state === 'spectating') {
        this.spectateKey(e);
        return;
      }
      if (e.key !== 'Escape') return;
      if (this.shopUi.open || this.chestUi.open) this.closeModeScreens();
      else if (this.hudEditor.style.display !== 'none') this.closeHudEditor();
      else if (this.market.open) this.closeMarket();
    });
    this.widgetFrame = {
      fps: 0,
      frameMs: 0,
      displayHz: 0,
      ping: null,
      opponent: null,
      opponentColor: '#ffffff',
      lastReach: null,
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
    this.watchApp();
    this.applySettings();
    this.toMenu();
    this.view.prewarm();
    requestAnimationFrame(this.onFrame);
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
    v.blocks.setOverlay(
      m.on('blockoverlay')
        ? {
            color: String(m.cfg('blockoverlay', 'color')),
            opacity: Number(m.cfg('blockoverlay', 'opacity')),
            fill: !!m.cfg('blockoverlay', 'fill'),
            fillColor: String(m.cfg('blockoverlay', 'fillColor')),
            fillOpacity: Number(m.cfg('blockoverlay', 'fillOpacity')),
          }
        : null,
    );
    this.scoreboard.setStyle(
      m.on('scoreboard') ? { hide: !!m.cfg('scoreboard', 'hide'), background: Number(m.cfg('scoreboard', 'background')), scale: Number(m.cfg('scoreboard', 'scale')) } : null,
    );
  }

  /** Time Changer: the time of day you see (Minecraft ticks), or null for the world's own. */
  private viewTime(): number | null {
    if (!this.mods.on('timechanger')) return null;
    const t = String(this.mods.cfg('timechanger', 'time'));
    return t === 'morning' ? 1000 : t === 'sunset' ? 12300 : t === 'night' ? 18000 : 6000;
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
    if (this.state !== 'playing' || this.screenOpen || this.chat.open) return;
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
    if (this.state !== 'playing' || this.screenOpen) return;
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

  /** Auto GG mod: says gg a moment after a duel ends (to your opponent, online). */
  private autoGG(won: boolean) {
    if (!this.mods.on('autogg') || (this.mods.cfg('autogg', 'onlyWin') && !won)) return;
    const text = String(this.mods.cfg('autogg', 'message') || 'gg');
    setTimeout(() => this.broadcast('chat', text), 600);
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
      // A replay re-runs the world too: note what the command left it like.
      const rec = this.cmdMatch?.recorder;
      if (rec && !rec.broken) {
        const w = this.cmdMatch!.world;
        rec.act({ k: 'env', raining: w.raining, dayTime: w.dayTime, rules: { ...w.rules } });
      }
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
    // A replay can't re-run what a command did.
    if (this.cmdMatch?.recorder) this.cmdMatch.recorder.broken = true;
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

  /** The inventory, the Bed Wars shop or a SkyWars chest is open (the mouse is free). */
  private get screenOpen(): boolean {
    return this.inventory.open || this.shopUi.open || this.chestUi.open;
  }

  /** Opens the shop or a chest the player right-clicked (Bed Wars / SkyWars). */
  private openModeScreen(x: number, y: number, z: number, block: number) {
    const m = this.match;
    const p = m.player;
    if (this.state !== 'playing' || p.dead || m.phase !== 'fight' || this.screenOpen) return;
    if (m instanceof NetMatch) {
      // Online the server owns the shop; chests open when the server sends their contents.
      const mode = m.mode;
      if (block !== B.SHOP || !(mode instanceof Bedwars)) return;
      if (!mode.nearShop(m.host, p)) {
        this.hud.showCenter('That is the other team’s shop', 'toast', 40);
        return;
      }
      const gear = m.modeUi.gear;
      if (!gear) return;
      this.freeMouse();
      this.shopUi.show(p, gear, (item) => {
        m.buy(item.key);
        return undefined;
      });
      return;
    }
    if (!(m instanceof Match)) return;
    const mode = m.mode;
    if (block === B.SHOP && mode instanceof Bedwars) {
      if (!mode.nearShop(m, p)) {
        this.hud.showCenter('That is the other team’s shop', 'toast', 40);
        return;
      }
      this.freeMouse();
      this.shopUi.show(p, mode.gear(m, p), (item) => m.act({ k: 'buy', key: item.key }) ?? null);
    } else if (block === B.CHEST && mode instanceof Skywars) {
      const items = mode.chestAt(x, y, z);
      if (!items) return;
      m.act({ k: 'open', x, y, z });
      this.freeMouse();
      this.sound.equip();
      this.chestUi.show(
        p,
        items,
        {
          take: (i) => void m.act({ k: 'take', x, y, z, i }),
          takeAll: () => void m.act({ k: 'takeAll', x, y, z }),
          put: (i) => void m.act({ k: 'put', x, y, z, i }),
        },
        () => this.sound.equip(),
      );
    }
  }

  /** Lets go of the keys and the mouse for a screen. */
  private freeMouse() {
    if (this.match.player.usingItem) this.screenAction({ k: 'stopUse' });
    this.match.useHeld = false;
    this.input.useHeld = false;
    this.input.enabled = false;
    this.input.unlock();
  }

  private closeModeScreens() {
    if (!this.shopUi.open && !this.chestUi.open) return;
    this.shopUi.hide();
    this.chestUi.hide();
    this.backIntoGame();
  }

  private escDown = false;
  /** After Esc closes a screen: until the key is up (and a moment after), a lost lock isn't a pause. */
  private escGraceUntil = 0;
  private relockOnEscUp = false;

  /**
   * Back into the game after closing a screen (inventory, shop, chest). Closed with Esc, the
   * mouse is locked again only once the key is up: browsers take an Esc that is still down as
   * "leave pointer lock", which used to drop you out of the game into the pause menu.
   */
  private backIntoGame() {
    if (this.state !== 'playing') return;
    this.input.enabled = true;
    if (this.escDown) {
      this.escGraceUntil = Infinity;
      this.relockOnEscUp = true;
      return;
    }
    void this.input.lock();
  }

  /** Scoreboard, titles and chat announcements of a Bed Wars / SkyWars game. */
  private tickModeUi(m: Match, viewer: Fighter, spectating: boolean) {
    const mode = m.mode;
    if (!mode) {
      this.scoreboard.hide();
      return;
    }
    this.showModePanels(mode.scoreboard(m, viewer), mode.takeAnnouncements(), spectating ? null : mode.title(m, viewer), spectating);
    // Right-clicked a chest or the shop this tick.
    if (!spectating) for (const e of viewer.events) if (e.type === 'openBlock') this.openModeScreen(e.x, e.y, e.z, e.block);
  }

  private showModePanels(sb: ScoreLine[] | null, announcements: ScoreLine[], title: { title: string; sub: string } | null, spectating: boolean) {
    this.scoreboard.update(sb);
    for (const a of announcements) {
      if (spectating) this.specHud.announce(a.text, a.color ?? '#ffffff');
      else this.chat.print([{ t: a.text, c: a.color }]);
      if (a.text.startsWith('BED DESTRUCTION')) this.sound.jingle(false);
    }
    if (title) {
      this.hud.showTitle('title', title.title);
      this.hud.showTitle('subtitle', title.sub);
    }
  }

  /** The online side of tickModeUi: everything comes from the server's messages. */
  private tickOnlineModeUi(m: NetMatch) {
    if (!m.mode) {
      this.scoreboard.hide();
      return;
    }
    const p = m.player;
    this.showModePanels(m.modeUi.sb.length ? m.modeUi.sb : null, m.announcements.splice(0), m.modeUi.title, false);
    for (const e of p.events) if (e.type === 'openBlock') this.openModeScreen(e.x, e.y, e.z, e.block);
    const c = m.chestMsg;
    m.chestMsg = null;
    if (c) {
      const same = this.chestUi.open && this.openChestAt?.x === c.x && this.openChestAt.y === c.y && this.openChestAt.z === c.z;
      if (same && !c.items) this.closeModeScreens();
      else if (same && c.items) this.chestUi.setItems(c.items);
      else if (c.open && c.items && this.state === 'playing' && !p.dead && m.phase === 'fight' && !this.screenOpen) {
        const { x, y, z } = c;
        this.openChestAt = { x, y, z };
        this.freeMouse();
        this.sound.equip();
        this.chestUi.show(
          p,
          c.items,
          { take: (i) => m.chestAction(x, y, z, 'take', i), takeAll: () => m.chestAction(x, y, z, 'all'), put: (i) => m.chestAction(x, y, z, 'put', i) },
          () => this.sound.equip(),
        );
      }
    }
    if (m.boughtMsg !== null) {
      this.shopUi.setMessage(m.boughtMsg);
      m.boughtMsg = null;
    }
    if (this.shopUi.open && m.modeUi.gear) this.shopUi.setGear(m.modeUi.gear);
    if ((this.shopUi.open || this.chestUi.open) && (p.dead || m.phase !== 'fight')) this.closeModeScreens();
    else if (this.shopUi.open) this.shopUi.refreshIfChanged();
    else if (this.chestUi.open) this.chestUi.refreshIfChanged();
  }

  private toggleInventory() {
    if (this.shopUi.open || this.chestUi.open) {
      this.closeModeScreens();
      return;
    }
    if (this.inventory.open) this.closeInventory();
    else this.openInventory();
  }

  private openInventory() {
    const p = this.match.player;
    if (this.state !== 'playing' || p.dead || this.match.phase === 'ended') return;
    this.previewKey = '';
    // Opening a screen lets go of every key; an item in use is put away rather than fired.
    if (p.usingItem) this.screenAction({ k: 'stopUse' });
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
    this.backIntoGame();
  }

  private toMenu() {
    this.spec = null;
    this.gauntlet = null;
    // Leaving a tournament game half-way doesn't count; the match waits in the saved bracket.
    this.tourneyGame = null;
    this.tourney.hide();
    this.scoreboard.hide();
    this.shopUi.hide();
    this.chestUi.hide();
    this.drill = null;
    this.lastDrill = null;
    this.drillHud.hide();
    this.specHud.hide();
    this.series = null;
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
    this.leaveOnline(false);
    this.match = this.newDemo();
    this.demoBrain = this.makeDemoBrain(this.match as Match);
    this.view.cameraMode = 'orbit';
    this.view.particles.clear();
    this.hud.setVisible(false);
    this.menus.refreshMain(this.records);
    this.menus.show('main');
  }

  /** `nextRound`: the next round of the running "first to" series (otherwise a new series). */
  private startDuel(nextRound = false, drillId: string | null = null, keepOnline = false) {
    this.sound.unlock();
    this.inventory.hide();
    // An online tournament's game against a bot runs here while the room stays connected.
    if (!keepOnline) this.leaveOnline(false);
    const drillDef = drillId ? drillById(drillId) ?? null : null;
    this.lastDrill = drillDef ? drillDef.id : null;
    // A new duel from anywhere but the Gauntlet's own rounds ends the run.
    if (drillDef || !nextRound) {
      this.gauntlet = null;
      this.tourneyGame = null;
    }
    const g = this.gauntlet;
    const tg = this.tourneyGame;
    const kit = kitById(drillDef ? drillDef.kit : tg ? tg.kit : g ? g.kit : this.settings.kit);
    const profile = DIFFICULTIES[drillDef ? drillDef.profile ?? 'practice' : tg ? tg.tier : g ? gauntletTier(g) : this.settings.difficulty];
    const s = this.series;
    if (!nextRound || !s || s.kit !== kit.id || s.tier !== profile.id) {
      this.series = newSeries(kit.id, profile.id, this.settings.firstTo);
    }
    // A tournament game is one round; the match score is the tournament's own.
    if (tg) this.series = newSeries(kit.id, profile.id, 1);
    this.hud.setSeries(tg ? this.tourneyLine() : g ? this.gauntletLine() : !drillDef && this.series!.target > 1 ? this.seriesScore() : null);
    const sr = this.series!;
    this.hud.setPips(!tg && !g && !drillDef && sr.target > 1 ? { you: sr.you, them: sr.bot, target: sr.target } : null);
    const seed = Math.floor(Math.random() * 2 ** 30);
    this.hudName = loadPlayerName();
    this.match = new Match(kit, profile, seed);
    if (tg) this.match.bot.name = tg.name;
    // A real duel opens with 10 s to sort your inventory (drills get straight to the point).
    if (!drillDef) this.match.countdownTicks = PREP_TICKS;
    // A new duel keeps what commands set up (rules, reach, game modes, time…) but not the rest.
    this.state = 'playing';
    this.applySession(true);
    this.cheated = sessionModified(this.session);
    if (!drillDef && !this.cheated) this.startRecording(this.match as Match, seed);
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
    this.drill = drillDef ? new DrillRun(drillDef, this.match as Match, loadDrillSpeed()) : null;
    if (this.drill) this.drillHud.show(this.drill);
    else this.drillHud.hide();
    void this.input.lock();
  }

  /** R, Restart and Try again: the same drill again, or a new duel. */
  private restartCurrent() {
    // A game of an online tournament can't be restarted (the bracket is waiting on it).
    if (this.onlineTourGame) return;
    if (this.lastDrill) this.startDrill(this.lastDrill);
    else this.startDuel();
  }

  // ------------------------------------------------------------------ trainer

  private startDrill(id: string) {
    this.startDuel(false, id);
  }

  /** Called every tick of a drill, after the match ticked and before its events are handled. */
  private tickDrill(run: DrillRun) {
    const m = this.match as Match;
    run.update();
    // Someone died anyway (a /kill, a huge blast): a fresh match, the drill carries on.
    if (m.phase === 'ended' && !run.result) {
      const next = new Match(m.kit, m.profile);
      this.match = next;
      this.applySession(true);
      this.hud.resetRound(next.player);
      run.attach(next);
      run.say('Round reset');
      return;
    }
    if (run.result) this.finishDrill(run);
  }

  private finishDrill(run: DrillRun) {
    const r = run.result!;
    // Slow-motion practice is for learning the timing; only full-speed runs tick a drill off.
    const newBest = r.speed >= 1 ? recordDrill(this.drillProgress, run.def.id, r) : false;
    this.earn({ kind: 'drills', passed: Object.values(this.drillProgress).filter((d) => d.passed).length, total: DRILLS.length });
    this.drill = null;
    this.drillHud.hide();
    this.state = 'results';
    this.chat.hide();
    this.input.enabled = false;
    this.input.unlock();
    this.sound.jingle(r.passed);
    this.menus.showDrillResult(run.def, r, newBest, () => this.startDrill(run.def.id));
  }

  // ------------------------------------------------------------------ bot vs bot

  /** Watch two tier bots fight, round after round (Bot vs Bot on the title screen). */
  private startSpectate(kitId: KitId, a: DifficultyId, b: DifficultyId) {
    this.sound.unlock();
    this.inventory.hide();
    this.leaveOnline(false);
    this.series = null;
    this.spec = new Spectate(kitById(kitId), DIFFICULTIES[a], DIFFICULTIES[b]);
    this.match = this.spec.match;
    this.state = 'spectating';
    this.chat.hide();
    this.menus.hideAll();
    this.hud.setVisible(false);
    this.specHud.show();
    this.view.particles.clear();
    this.damage.clear();
    this.sound.muted = false;
    this.acc = 0;
    this.enterSpectateCam(null);
  }

  private tickSpectate(spec: Watch) {
    const replaced = spec.tick();
    if (replaced) {
      this.match = spec.match;
      this.view.particles.clear();
      this.damage.clear();
      this.snapPov(spec);
      return;
    }
    const m = spec.match;
    // Through a fighter's eyes: their hand and held item move like they would for them.
    const pov = spec.cam === 'povA' ? m.player : spec.cam === 'povB' ? m.bot : null;
    if (pov) {
      this.view.firstPerson.tick(pov);
      this.hud.tick(pov);
    }
    this.tickModeUi(m, m.player, true);
    this.handleEvents(m.player, false);
    this.handleEvents(m.bot, false);
    this.handleWorldEvents(m.world);
    for (const f of [m.player, m.bot]) {
      if (f.dead && f.deathTime === 20) this.view.particles.poof(f.pos.x, f.pos.y, f.pos.z);
    }
    const r = spec.lastResult;
    if (r) {
      spec.lastResult = null;
      const color = r.winner === 'a' ? spec.colorA : spec.colorB;
      this.specHud.announce(spec.resultText(r), color);
      this.sound.jingle(true);
    }
  }

  private spectateKey(e: KeyboardEvent) {
    const spec = this.spec;
    if (!spec || e.repeat) return;
    const cams = { Digit1: 'orbit', Digit2: 'followA', Digit3: 'followB', Digit4: 'povA', Digit5: 'povB', Digit6: 'free' } as const;
    const was = spec.cam;
    if (e.code in cams) spec.cam = cams[e.code as keyof typeof cams];
    else if (e.code === 'KeyV' || e.code === 'F5') spec.cycleCam(e.shiftKey ? -1 : 1);
    else if (e.code === 'BracketLeft' || e.code === 'Minus') spec.changeSpeed(-1);
    else if (e.code === 'BracketRight' || e.code === 'Equal') spec.changeSpeed(1);
    else if (e.code === 'KeyP' || (e.code === 'Space' && spec.cam !== 'free')) spec.togglePause();
    else if (e.code === 'KeyR' || ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && spec.seekBy)) {
      const replaced = e.code === 'KeyR' ? spec.restart() : spec.seekBy!(e.code === 'ArrowLeft' ? -5 : 5);
      if (replaced) {
        this.match = spec.match;
        this.view.particles.clear();
        this.damage.clear();
        this.acc = 0;
      }
      // After a jump in time the hand shows what they hold now, not what they held before.
      this.snapPov(spec);
    } else if (e.code === 'Escape') {
      const back = this.spec instanceof ReplayWatch ? this.replayBack : null;
      this.toMenu();
      back?.();
    } else if (e.code === 'Space' || e.code.startsWith('Arrow')) {
      // Space flies up in the free camera; the arrow keys belong to the page otherwise.
      e.preventDefault();
      return;
    } else return;
    if (spec.cam !== was) this.enterSpectateCam(was);
    e.preventDefault();
    this.sound.ui();
  }

  // ------------------------------------------------------------------ free camera

  private readonly free = { x: 0, y: 4, z: 12, yaw: 0, pitch: -0.2, vx: 0, vy: 0, vz: 0 };

  /** A new camera was picked: the free one starts where the last view was, so nothing jumps. */
  private enterSpectateCam(was: SpecCam | null) {
    const spec = this.spec;
    if (!spec) return;
    // A new pair of eyes: their hand and HUD come up fresh (not the last fighter's).
    if (spec.cam !== was) this.snapPov(spec);
    if (spec.cam === 'free' && was !== 'free') {
      const f = this.free;
      const cam = this.view.camera;
      if (was === null) {
        // A fresh watch: stand back from the fight, looking at it.
        const m = spec.match;
        const cx = (m.player.pos.x + m.bot.pos.x) / 2;
        const cz = (m.player.pos.z + m.bot.pos.z) / 2;
        f.x = cx;
        f.y = Math.max(m.player.pos.y, m.bot.pos.y) + 4;
        f.z = cz + 11;
        f.yaw = 0;
        f.pitch = -0.28;
      } else {
        f.x = cam.position.x;
        f.y = cam.position.y;
        f.z = cam.position.z;
        const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ');
        f.yaw = e.y;
        f.pitch = e.x;
      }
      f.vx = f.vy = f.vz = 0;
    }
    // Only the free camera needs the mouse and keys (they never reach the fight).
    const wantInput = spec.cam === 'free';
    this.input.enabled = wantInput;
    this.input.closeGuard = false;
    if (wantInput) void this.input.lock(false);
    else this.input.unlock();
  }

  /** Watching through someone's eyes from a standing start: their hand and HUD as they are now. */
  private snapPov(spec: Watch) {
    const f = spec.cam === 'povB' ? spec.match.bot : spec.match.player;
    this.view.firstPerson.snap(f);
    this.hud.resetRound(f);
    // Not the "VICTORY" of the duel you just played.
    this.hud.clearCenter();
  }

  /** WASD + mouse fly the spectator camera: Space up, Shift down, sprint (Ctrl) faster. */
  private updateFreeCam(dt: number) {
    const f = this.free;
    const [dyaw, dpitch] = this.input.consumeLook();
    f.yaw += dyaw;
    f.pitch = clamp(f.pitch + dpitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    const inp = this.input.moveInput();
    // Sprint only while the key is held: with Toggle Sprint on, the toggle stayed on from the
    // last duel and the camera always flew at full speed.
    const fast = this.input.held('sprint');
    const speed = fast ? 14 : 6;
    // Forward follows where you look (up and down included); strafe stays level.
    const cp = Math.cos(f.pitch);
    const fx = -Math.sin(f.yaw) * cp;
    const fy = Math.sin(f.pitch);
    const fz = -Math.cos(f.yaw) * cp;
    const rx = Math.cos(f.yaw);
    const rz = -Math.sin(f.yaw);
    const tx = (fx * inp.forward + rx * inp.strafe) * speed;
    // Up and down from the keys themselves too (a Toggle Sneak left on would sink it forever).
    const up = this.input.held('jump') ? 1 : 0;
    const down = this.input.held('sneak') ? 1 : 0;
    const ty = (fy * inp.forward + up - down) * speed;
    const tz = (fz * inp.forward + rz * inp.strafe) * speed;
    // A short ease in and out (a smooth start, and it stops where you let go, not a slide later).
    const k = 1 - Math.exp(-dt * (inp.forward || inp.strafe || up || down ? 14 : 22));
    f.vx += (tx - f.vx) * k;
    f.vy += (ty - f.vy) * k;
    f.vz += (tz - f.vz) * k;
    f.x = clamp(f.x + f.vx * dt, -160, 160);
    f.z = clamp(f.z + f.vz * dt, -160, 160);
    // Not under the grass (unless the map has no floor), not out of the sky.
    const voidMap = this.match.world.blocks.voidWorld;
    f.y = clamp(f.y + f.vy * dt, voidMap ? -30 : 0.4, 140);
    this.view.extras.freeCam = { x: f.x, y: f.y, z: f.z, yaw: f.yaw, pitch: f.pitch };
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
    // Custom kits only live in this browser: an online room uses Sword instead.
    const offline = isCustomKit(this.settings.kit);
    this.net.joinExtra = {};
    this.net.connect(url, room, name, offline ? 'sword' : this.settings.kit);
  }

  /** Your best tier as 0 (LT5) … 9 (HT1); with none yet you're seeded like an LT4. */
  private myRating(): number {
    return Math.max(2, ...Object.values(this.myTiers).map((t) => DIFFICULTY_ORDER.indexOf(t as TierId) - 1));
  }

  /** Online over the internet: this game hosts, a friend joins with the code it shows. A
   * `tour` makes it a tournament room instead of a duel. */
  private hostOnline(name: string, tour?: { size: number; field: string }) {
    this.sound.unlock();
    this.leaveOnline(false);
    const attempt = ++this.onlineAttempt;
    this.menus.setNetStatus('connecting', 'Setting up your game…', '');
    const kit = isCustomKit(this.settings.kit) ? 'sword' : this.settings.kit;
    OnlineHost.start().then(
      (host) => {
        // Cancelled (Disconnect, Back, another attempt) while it was being set up.
        if (attempt !== this.onlineAttempt) {
          host.destroy();
          return;
        }
        this.onlineHost = host;
        this.net.joinExtra = { tour, rating: this.myRating() };
        this.net.connectVia(host.localSocket(), host.code, name, kit, 'Starting…', 8000, 'Could not start the game you are hosting.');
      },
      (err: Error) => {
        if (attempt === this.onlineAttempt) this.menus.setNetStatus('error', err.message, '');
      },
    );
  }

  private joinOnline(code: string, name: string) {
    this.sound.unlock();
    this.leaveOnline(false);
    const c = normalizeOnlineCode(code);
    if (!c) {
      this.menus.setNetStatus('error', 'Type the code your friend sees on their screen.', '');
      return;
    }
    this.net.joinExtra = { rating: this.myRating() };
    this.net.connectVia(joinOnline(c), c, name, 'sword', `Connecting to game ${c}…`, JOIN_TIMEOUT_MS, JOIN_TIMEOUT_TEXT);
  }

  /** Whether the chat already said how this online game is connected. */
  private routeAnnounced = -1;

  /**
   * Says once per connection whether the game goes straight to the friend or through the relay
   * (WebRTC knows a moment after connecting). LAN games never report a route, so stay quiet.
   */
  private announceRoute(attempt: number, tries = 0) {
    if (attempt !== this.onlineAttempt || this.routeAnnounced === attempt) return;
    const route = this.net.route;
    if (!route) {
      if (tries < 20) setTimeout(() => this.announceRoute(attempt, tries + 1), 500);
      return;
    }
    this.routeAnnounced = attempt;
    this.chat.print(
      route === 'relay'
        ? [{ t: 'Connected through the relay server — your networks block a direct connection, so expect a little more ping.', c: COLOR.yellow }]
        : [{ t: 'Connected directly to your opponent.', c: COLOR.green }],
    );
  }

  /** The online game this player hosts, or null. */
  private onlineHost: OnlineHost | null = null;
  /** Bumped on every connect/leave, so a slow host setup that was cancelled is thrown away. */
  private onlineAttempt = 0;

  leaveOnline(toMenu = true) {
    this.onlineAttempt++;
    this.onlineHost?.destroy();
    this.onlineHost = null;
    this.net.close();
    this.netMatch = null;
    this.lobbyNames = [];
    this.endTour();
    if (toMenu) this.toMenu();
  }

  private onNetStatus(status: NetStatus, detail: string) {
    this.menus.setNetStatus(status, detail, this.net.room);
    if (status === 'error' || status === 'closed') this.leaveOnlineMatch();
  }

  /** Back to the multiplayer screen from an online match (the connection may stay open). */
  private leaveOnlineMatch() {
    const wasPlaying = this.netMatch !== null || this.onlineTourGame;
    this.netMatch = null;
    this.endTour();
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
    if (msg.t === 'tour') {
      this.tourView = msg.view;
      this.onTourView();
      return;
    }
    if (msg.t === 'tplay') {
      this.playTourLocal(msg.kit as KitId, msg.bot);
      return;
    }
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
      if (!this.netMatch || this.netMatch.kit.id !== msg.kit || this.tourView) {
        this.netMatch = new NetMatch(this.net, this.net.you, msg.kit as KitId);
        this.series = null;
        this.hud.setSeries(this.tourView ? this.tourLine() : null);
        this.hud.setPips(null);
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
          const nm = this.netMatch;
          if (nm) {
            this.earn({ kind: 'duel', won, kit: nm.kit.id, tier: 'online', stats: nm.player.stats, seconds: nm.fightTicks / 20, health: nm.player.health, online: true, tierEarned: false, kitsWon: this.kitsWon() });
          }
          this.autoGG(won);
          this.resultTimer = 30;
        }
        break;
      default:
        break;
    }
  }

  private beginOnlineRound() {
    this.announceRoute(this.onlineAttempt);
    this.tourney.hide();
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
    if (this.tourView) {
      // A tournament game: no rematch, back to the bracket's live screen.
      this.sound.jingle(m.winner === m.player);
      this.netMatch = null;
      this.showTourScreen();
      return;
    }
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

  private seriesScore(): string {
    const s = this.series!;
    return `FT${s.target} · You ${s.you} – ${s.bot} Bot`;
  }

  // ------------------------------------------------------------------ gauntlet, advancements

  /** The Gauntlet: every tier from LT5 to HT1 in a row, in the kit picked on the title screen. */
  private startGauntlet() {
    this.gauntlet = newGauntlet(this.settings.kit);
    this.startDuel(true);
    this.hud.showCenter(`Gauntlet — Round 1: ${DIFFICULTIES[gauntletTier(this.gauntlet!)].name}`, 'toast', 60);
  }

  /** Your name on the versus bar (read once per duel, not every frame). */
  private hudName = loadPlayerName();

  private gauntletLine(): string {
    const g = this.gauntlet!;
    return `Gauntlet · ${Math.min(g.round + 1, GAUNTLET_TIERS.length)}/${GAUNTLET_TIERS.length} · ${DIFFICULTIES[gauntletTier(g)].name} · ${'❤'.repeat(g.lives)}`;
  }

  /** The HUD line in a tournament game: round, game number and the match score. */
  private tourneyLine(): string {
    if (this.tourView) return this.tourLine();
    const t = this.tourney.t;
    const m = t && t.matches.filter((x) => isYours(t, x) && x.draft && x.winner === null).pop();
    if (!t || !m) return 'Tournament';
    const me = m.players.indexOf(t.you);
    return `${roundName(t, m)} · Game ${m.games.length + 1} · ${m.wins[me]}–${m.wins[1 - me]}`;
  }

  /** A tournament game is over: into the match, then back to the kit-selection screen. */
  private finishTourneyGame(won: boolean) {
    this.tourneyGame = null;
    if (this.onlineTourGame) {
      // Online: the host records it and moves the bracket on.
      this.onlineTourGame = false;
      this.net.send({ t: 'tresult', won });
      this.sound.jingle(won);
      this.showTourScreen();
      return;
    }
    const t = this.tourney.t;
    const m = t && t.matches.filter((x) => isYours(t, x) && x.draft && x.winner === null).pop();
    if (t && m) {
      const me = m.players.indexOf(t.you) as 0 | 1;
      recordGame(t, m, won ? me : ((1 - me) as 0 | 1));
      saveTournament(t);
    }
    this.state = 'results';
    this.chat.hide();
    this.hud.setVisible(false);
    this.input.enabled = false;
    this.input.unlock();
    this.sound.jingle(won);
    this.menus.hideAll();
    this.tourney.showMatch();
  }

  // ------------------------------------------------------------------ online tournament

  /** The HUD line in an online tournament game. */
  private tourLine(): string {
    const v = this.tourView;
    const t = v?.tour;
    const m = t && v.live ? t.matches.find((x) => x.id === v.live!.match) : null;
    if (!t || !m) return 'Tournament';
    const me = m.players.findIndex((id) => id !== null && t.entrants[id].pid === v.you);
    return `${roundName(t, m)} · Game ${m.games.length + 1} · ${m.wins[Math.max(0, me)]}–${m.wins[me === 1 ? 0 : 1]}`;
  }

  /** A new view from the host: redraw the tournament screen unless you're in one of its games. */
  private onTourView() {
    const v = this.tourView!;
    const t = v.tour;
    if (t && t.champion !== null && !this.tourAwarded) {
      this.tourAwarded = true;
      const me = t.entrants.find((e) => e.pid === v.you);
      if (me) this.earn({ kind: 'tournament', won: t.champion === me.id, size: t.size });
    }
    if (this.onlineTourGame) return;
    const nm = this.netMatch;
    if (nm) {
      const live = v.live;
      const mine = !!t && !!live && !live.pve && live.stage === 'game' && t.matches.find((x) => x.id === live.match)?.players.some((id) => id !== null && t.entrants[id].pid === v.you);
      // The duel finishes on its own (VICTORY, then back here); one that was called off — the
      // opponent left — ends now.
      if (mine || nm.phase === 'ended') return;
      this.netMatch = null;
    }
    this.showTourScreen();
  }

  /** The online tournament's screen, over the world. */
  private showTourScreen() {
    const v = this.tourView;
    if (!v) return;
    if (this.state === 'playing' || this.state === 'paused') {
      this.inventory.hide();
      this.chat.hide();
      this.hud.setVisible(false);
      this.input.enabled = false;
      this.input.unlock();
      this.state = 'results';
    }
    this.menus.hideAll();
    this.tourney.showOnline(v, this.net.room, {
      start: () => this.net.send({ t: 'tstart' }),
      draft: (kit) => this.net.send({ t: 'tdraft', kit }),
      leave: () => {
        this.leaveOnline(true);
        this.menus.show('multiplayer');
      },
    });
  }

  /** Your game against a bot: played here, the result goes back to the host. */
  private playTourLocal(kit: KitId, bot: { name: string; tier: string }) {
    const tier = (DIFFICULTY_ORDER as string[]).includes(bot.tier) && bot.tier !== 'practice' ? (bot.tier as TierId) : 'lt3';
    this.tourneyGame = { kit, tier, name: bot.name };
    this.onlineTourGame = true;
    this.tourney.hide();
    this.startDuel(true, null, true);
  }

  /** Out of the tournament room (left, or the connection closed). */
  private endTour() {
    if (!this.tourView && !this.onlineTourGame) return;
    this.tourView = null;
    this.onlineTourGame = false;
    this.tourAwarded = false;
    if (this.tourneyGame) this.tourneyGame = null;
    this.tourney.clearOnline();
    this.tourney.hide();
  }

  private finishGauntletRound(won: boolean) {
    const g = this.gauntlet!;
    const beaten = DIFFICULTIES[gauntletTier(g)].name;
    const step = gauntletRound(g, won);
    if (step === 'next' || step === 'retry') {
      this.chat.print([
        step === 'next'
          ? { t: `${beaten} down! Next: ${DIFFICULTIES[gauntletTier(g)].name}`, c: COLOR.green }
          : { t: `Lost a life — ${g.lives} left. ${beaten} again.`, c: COLOR.red },
      ]);
      this.startDuel(true);
      this.hud.showCenter(step === 'next' ? `Round ${g.round + 1}: ${DIFFICULTIES[gauntletTier(g)].name}` : `${'❤'.repeat(g.lives)} left`, 'toast', 60);
      return;
    }
    this.gauntlet = null;
    const best = saveGauntletBest(g.kit, g.cleared);
    this.earn({ kind: 'gauntlet', cleared: g.cleared, total: GAUNTLET_TIERS.length });
    this.state = 'results';
    this.chat.hide();
    this.input.enabled = false;
    this.input.unlock();
    this.sound.jingle(step === 'cleared');
    this.menus.showGauntletResult(
      { kit: kitById(g.kit).name, cleared: g.cleared, total: GAUNTLET_TIERS.length, champion: step === 'cleared', newBest: best, best: loadGauntletBest()[g.kit] ?? 0 },
      () => this.startGauntlet(),
    );
  }

  /** Kits with at least one recorded win (for Jack of All Trades). */
  private kitsWon(): number {
    const kits = new Set<string>();
    for (const [key, r] of Object.entries(this.records)) if (r.wins > 0) kits.add(key.split(':')[0]);
    return kits.size;
  }

  private duelAdvancements(m: AnyMatch, won: boolean, tierEarned: boolean) {
    if (this.cheated) return;
    this.earn({
      kind: 'duel',
      won,
      kit: m.kit.id,
      tier: m.profile.id,
      stats: m.player.stats,
      seconds: m.fightTicks / 20,
      health: m.player.health,
      online: false,
      tierEarned,
      kitsWon: this.kitsWon(),
    });
  }

  /** Checks for new advancements: a toast, the fanfare and a chat line for each. */
  private earn(e: AdvEvent) {
    for (const a of earnAdvancements(e, this.advancements)) {
      this.toasts.advancement(a, rewardsOf(a.id));
      this.sound.advancement(a.frame === 'challenge');
      const verb = a.frame === 'challenge' ? 'completed the challenge' : a.frame === 'goal' ? 'reached the goal' : 'made the advancement';
      this.chat.print([
        { t: `${loadPlayerName()} has ${verb} `, c: COLOR.white },
        { t: `[${a.title}]`, c: a.frame === 'challenge' ? '#ff55ff' : COLOR.green },
      ]);
    }
  }

  /** A kill effect at (pos): what the opponent gets when they go down (also the Locker preview). */
  private playKillEffect(id: KillEffectId, pos: { x: number; y: number; z: number }) {
    const fx = this.view.particles;
    const { x, y, z } = pos;
    const at = { x, y: y + 1, z };
    const rainbow = [0xff5555, 0xffaa00, 0xffff55, 0x55ff55, 0x55ffff, 0x5555ff, 0xff55ff];
    switch (id) {
      case 'lightning':
        this.view.bolts.strike(x, y, z);
        this.flash = 1;
        this.sound.lightning(at);
        fx.poof(x, y, z);
        break;
      case 'hearts':
        fx.hearts(x, y + 2.2, z, this.sound.listener.yaw);
        this.sound.xp(at);
        break;
      case 'totem':
        fx.totem(x, y, z);
        this.sound.totem(at);
        break;
      case 'firework': {
        const pick = rainbow[Math.floor(Math.random() * rainbow.length)];
        fx.firework(x, y + 3, z, [pick, 0xffffff]);
        this.sound.firework(at);
        break;
      }
      case 'ender':
        fx.ender(x, y, z);
        this.sound.pearl(at, true);
        break;
      case 'rainbow':
        [0, 280, 560].forEach((ms, i) =>
          setTimeout(() => {
            fx.firework(x + (i - 1) * 1.5, y + 3 + i * 0.6, z, rainbow.slice(i * 2, i * 2 + 3).concat(0xffffff), i === 2);
            this.sound.firework(at, i === 2);
          }, ms),
        );
        break;
      case 'dragon':
        fx.firework(x, y + 2.5, z, [0xaa00aa, 0xff55ff, 0xffaa00], true);
        fx.ender(x, y, z);
        this.sound.roar(at);
        break;
    }
  }

  private finishDuel() {
    const m = this.match;
    const won = m.winner === m.player;
    this.keepReplay(m as Match);
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
    if (this.tourneyGame) {
      this.duelAdvancements(m, won, false);
      this.finishTourneyGame(won);
      return;
    }
    if (this.gauntlet) {
      this.duelAdvancements(m, won, false);
      this.finishGauntletRound(won);
      return;
    }
    const series = this.series ?? newSeries(m.kit.id, this.settings.difficulty, 1);
    const outcome = scoreRound(series, won, this.cheated);
    // Winning a series against a tier bot earns that tier in this kit (My Tiers).
    let earned = false;
    if (outcome === 'you' && !series.modified && awardTier(this.myTiers, series.kit, series.tier)) {
      earned = true;
      saveMyTiers(this.myTiers);
    }
    this.duelAdvancements(m, won, earned);
    if (outcome === null) {
      // The series goes on: straight into the next round against the same bot.
      this.chat.print([{ t: `${won ? 'Round won' : 'Round lost'} — ${this.seriesScore()}`, c: won ? COLOR.green : COLOR.red }]);
      this.startDuel(true);
      this.hud.showCenter(`You ${series.you} – ${series.bot} Bot`, 'toast', 50);
      return;
    }
    if (this.session.rules.doImmediateRespawn) {
      // /gamerule doImmediateRespawn true: no results screen, straight into the next duel.
      const secs = Math.floor(m.fightTicks / 20);
      this.chat.print([
        {
          t: `${won ? 'Victory' : 'Defeat'} in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — ${m.player.stats.hits} hits, best combo ${m.player.stats.maxCombo}.`,
          c: won ? COLOR.green : COLOR.red,
        },
      ]);
      if (series.target > 1) this.chat.print([{ t: `${outcome === 'you' ? 'Series won' : 'Series lost'} — ${this.seriesScore()}`, c: won ? COLOR.green : COLOR.red }]);
      if (earned) this.chat.print([{ t: `New tier: ${m.profile.name} in ${m.kit.name} (+${TIER_POINTS[series.tier as keyof typeof TIER_POINTS]} pts)`, c: COLOR.gold }]);
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
        botColor: m.profile.color,
        newBestCombo: newBest && m.player.stats.maxCombo > 0,
        unrecorded: this.cheated,
        series: series.target > 1 ? { target: series.target, you: series.you, bot: series.bot } : undefined,
        tierEarned: earned ? { name: m.profile.name, color: m.profile.color, kit: m.kit.name, points: TIER_POINTS[series.tier as keyof typeof TIER_POINTS] } : undefined,
        tierBlocked: outcome === 'you' && series.modified && m.profile.id !== 'practice',
      },
      () => this.startDuel(),
      this.lastReplay ? () => this.watchReplay(this.lastReplay!, null) : undefined,
      this.lastReplay ? () => this.openCoach(this.lastReplay!, () => this.menus.show('results')) : undefined,
    );
  }

  // ------------------------------------------------------------------ replays

  /** The replay of the duel that just finished (for the results screen). */
  private lastReplay: ReplayData | null = null;

  private startRecording(m: Match, seed: number) {
    const s = this.session;
    const kit = m.kit;
    const rec = new ReplayRecorder({
      v: REPLAY_VERSION,
      kitId: kit.id,
      customKit: kit.custom ? JSON.parse(JSON.stringify(kit)) : undefined,
      profileId: m.profile.id,
      seed,
      playerName: m.player.name,
      botName: m.bot.name,
      rules: { ...m.world.rules },
      attrs: { player: { ...s.attrs.player } as Record<string, number>, bot: { ...s.attrs.bot } as Record<string, number> },
      gameModes: { ...s.gameModes },
      dayTime: m.world.dayTime,
      raining: m.world.raining,
      prep: m.countdownTicks,
      date: Date.now(),
    });
    rec.start(m.player);
    m.recorder = rec;
  }

  /** A shop, chest or item action from a screen: through the match, so the replay has it too. */
  private screenAction(a: ReplayAction) {
    const m = this.match;
    if (m instanceof Match) m.act(a);
    else if (a.k === 'stopUse' && m.player.usingItem) m.player.stopUsingItem();
  }

  /** Stops recording a finished duel and saves it with the others. */
  private keepReplay(m: Match) {
    this.lastReplay = null;
    const rec = m.recorder;
    m.recorder = null;
    if (!rec || this.cheated) return;
    const data = rec.finish(m.winner ? (m.winner === m.player ? 'player' : 'bot') : null, m.fightTicks);
    if (!data) return;
    this.lastReplay = data;
    this.replays = saveReplays([data, ...this.replays]);
    this.menus.setReplays(this.replays);
  }

  /** Match Coach: analyses a replay; each tip's moments open the replay just before them. */
  private openCoach(data: ReplayData, back: () => void) {
    this.sound.unlock();
    const report = analyze(data);
    this.menus.showCoach(report, (tick) => this.watchReplay(data, () => this.openCoach(data, back), tick), back);
  }

  /** `at`: start a few seconds before this tick (a Coach moment) instead of the countdown. */
  private watchReplay(data: ReplayData, back: (() => void) | null, at?: number) {
    this.sound.unlock();
    this.inventory.hide();
    this.leaveOnline(false);
    this.series = null;
    this.drill = null;
    this.lastDrill = null;
    this.drillHud.hide();
    this.scoreboard.hide();
    this.closeModeScreens();
    this.hud.setVisible(false);
    this.replayBack = back;
    const w = new ReplayWatch(data);
    if (at !== undefined) {
      w.seek(Math.max(w.start, at - 60));
      w.cam = 'povA';
    }
    this.spec = w;
    this.match = w.match;
    this.state = 'spectating';
    this.chat.hide();
    this.menus.hideAll();
    this.specHud.show();
    this.view.particles.clear();
    this.damage.clear();
    this.sound.muted = false;
    this.acc = 0;
    this.enterSpectateCam(null);
  }

  private starReplay(id: string) {
    const r = this.replays.find((x) => x.id === id);
    if (!r) return;
    r.starred = !r.starred;
    this.replays = saveReplays(this.replays);
    this.menus.setReplays(this.replays);
  }

  private deleteReplay(id: string) {
    this.replays = saveReplays(this.replays.filter((x) => x.id !== id));
    if (this.lastReplay?.id === id) this.lastReplay = null;
    this.menus.setReplays(this.replays);
  }

  // ------------------------------------------------------------------ loop

  private zoomHeld(): boolean {
    return this.state === 'playing' && this.mods.on('zoom') && this.input.held('zoom');
  }

  /** One bound callback for every frame, so the loop allocates nothing of its own. */
  private readonly onFrame = (t: number) => this.frame(t);

  private frame(now: number) {
    requestAnimationFrame(this.onFrame);
    // Max Framerate: skip display refreshes that come too soon.
    let cap = this.settings.maxFps;
    // Behind a screen the world barely moves: paused offline it is frozen outright, and the
    // title-screen duel and results backdrop are scenery. Drawing them at full rate kept the
    // GPU (and on most laptops the fan) as busy as a real fight.
    const frozen = this.state === 'paused' && !this.online;
    // A minimized desktop window keeps getting frames (backgrounding is off so the simulation
    // never stalls): keep ticking, but nobody sees the drawing.
    const idleCap = frozen || document.hidden ? 10 : this.state === 'menu' || this.state === 'results' ? 30 : 0;
    if (idleCap > 0 && (cap <= 0 || cap > idleCap)) cap = idleCap;
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
      m.useHeld = this.input.useHeld && !this.screenOpen;
      m.attackHeld = this.input.attackHeld && !this.screenOpen;
    } else {
      // The spectator camera uses the mouse; everywhere else it is thrown away.
      if (!(this.state === 'spectating' && this.spec?.cam === 'free')) this.input.consumeLook();
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
    const spec = this.state === 'spectating' ? this.spec : null;
    const ticking =
      !menuStill &&
      (this.state === 'playing' || this.state === 'menu' || this.state === 'results' || (this.online && this.state === 'paused') || (!!spec && !spec.paused));
    // /tick rate only changes offline duels; online and the title screen always run at 20.
    const offlineDuel = !!this.cmdMatch && !spec;
    // Trainer practice speed slows the whole drill down (you and the bot) to learn the timing.
    const drillSpeed = this.drill && this.state === 'playing' ? this.drill.speed : 1;
    const tickMs = spec ? TICK_MS / spec.speed : offlineDuel ? 1000 / this.session.tickRate / drillSpeed : TICK_MS;
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
    this.renderAlpha = alpha;

    this.updateWeather(dt, offlineDuel);
    const tag = this.tag;
    if (spec) {
      // Watching: the camera belongs to whichever fighter it follows (A is the match's player).
      const onB = spec.cam === 'followB' || spec.cam === 'povB';
      this.view.cameraMode = spec.cam === 'orbit' ? 'orbit' : spec.cam === 'free' ? 'free' : spec.cam.startsWith('pov') ? 'first' : 'third';
      if (spec.cam === 'free') this.updateFreeCam(dt);
      else this.view.extras.freeCam = null;
      // Through someone's eyes it's 1:1 with what they saw: their look exactly as it was each tick
      // (interpolated between ticks), their hand, their HUD and crosshair. Following from behind,
      // the camera is smoothed instead, so a bot's 20 turns a second don't judder.
      const pov = spec.cam === 'povA' || spec.cam === 'povB';
      this.view.extras.lerpLook = pov;
      this.view.extras.smoothLook = !pov;
      const [cp, cb] = onB ? [m.bot, m.player] : [m.player, m.bot];
      tag.name = cb.name;
      tag.color = onB ? spec.colorA : spec.colorB;
      tag.status = spec.label(onB ? 'a' : 'b');
      this.view.crosshairOn = pov && this.hud.crosshairShown;
      this.view.crosshairGui = this.hud.guiScale;
      this.view.render(cp, cb, alpha, this.time, dt, s, tag);
      this.specHud.update(spec, dt);
      this.specHud.setPov(pov);
      this.hud.setVisible(pov);
      if (pov) {
        this.hud.update(cp, cb, s, {
          aimingAtBot: rayDistanceToTarget(cp, cb) >= 0,
          botName: cb.name,
          botColor: onB ? spec.colorA : spec.colorB,
          botStatus: spec.label(onB ? 'a' : 'b'),
          botTag: onB ? 'A' : 'B',
          playerName: onB ? spec.nameB : spec.nameA,
          fightTicks: m.fightTicks,
          lastReach: null,
          now: performance.now(),
          firstPerson: true,
        });
      }
      const cam = this.view.camera.position;
      Object.assign(this.sound.listener, { x: cam.x, y: cam.y, z: cam.z, yaw: spec.cam === 'free' ? this.free.yaw : onB ? m.bot.yaw : p.yaw });
    } else {
      this.view.extras.smoothLook = false;
      this.view.extras.lerpLook = false;
      this.view.extras.freeCam = null;
      this.view.cameraMode = this.state === 'menu' ? 'orbit' : this.cameraMode;
      tag.name = m.bot.name;
      tag.color = m.profile.color;
      tag.status = this.state === 'menu' ? '' : m.brain.label;
      this.view.crosshairOn = (this.state === 'playing' || this.state === 'paused') && this.hud.crosshairShown;
      this.view.crosshairGui = this.hud.guiScale;
      this.view.render(p, m.bot, alpha, this.time, dt, s, tag);
    }
    if (this.mods.on('damageindicator')) this.damage.update(this.view.camera, dt);

    const inDuel = this.state !== 'menu' && this.state !== 'spectating';
    if (inDuel) {
      this.hud.update(p, m.bot, s, {
        aimingAtBot: rayDistanceToTarget(p, m.bot) >= 0,
        botName: m.bot.name,
        botColor: m.profile.color,
        botStatus: m.brain.label,
        botTag: this.netMatch ? 'P2' : m.profile.name,
        playerName: this.hudName,
        fightTicks: m.fightTicks,
        lastReach: this.lastReach,
        now: performance.now(),
        firstPerson: this.view.cameraMode === 'first' && !this.view.extras.freelook,
      });
    }
    if (this.drill && inDuel) this.drillHud.update(this.drill);
    this.chat.root.style.display = inDuel ? '' : 'none';
    if (inDuel) this.chat.update(performance.now());
    this.updateWidgets(p);
    if (this.inventory.open) {
      if (p.dead || m.phase === 'ended' || this.state !== 'playing') this.closeInventory();
      else {
        this.inventory.refresh();
        // Drawing the preview reads pixels back from the GPU (a full pipeline stall), so only
        // redraw when the mouse, the held items or the armor changed.
        const gear = (st: ItemStack | null | undefined) => (st ? `${st.id}${st.ench ? '*' : ''}` : '-');
        const key = `${this.inventory.mouseX | 0},${this.inventory.mouseY | 0},${p.selected},${gear(p.heldStack())},${gear(p.offhand)},${p.armorSlots.map(gear).join(',')},${this.previewCanvas.getBoundingClientRect().width | 0}`;
        if (key !== this.previewKey) {
          this.previewKey = key;
          this.view.renderPreview(this.previewCanvas, p, this.inventory.mouseX, this.inventory.mouseY);
        }
      }
    }
    this.clickHint.style.display = this.state === 'playing' && !this.input.locked && !this.screenOpen && !this.chat.open ? '' : 'none';
    if (spec) return;
    const eye = p.eyePos();
    const l = this.sound.listener;
    l.x = eye.x;
    l.y = eye.y;
    l.z = eye.z;
    l.yaw = p.yaw;
  }

  /** The screen's refresh rate (desktop app only; 0 = unknown). */
  private displayHz = 0;

  /** Desktop app: build number, the screen's refresh rate, and the self-updater's news. */
  private watchApp() {
    const native = window.pvpNative;
    if (!native) return;
    void native.build?.().then((n) => this.menus.setBuild(n));
    const hz = () => void native.displayHz?.().then((v) => (this.displayHz = v));
    hz();
    window.addEventListener('resize', hz);
    native.onUpdate?.((info) => {
      const bar = document.createElement('div');
      bar.className = 'update-banner';
      const text = document.createElement('span');
      const go = document.createElement('button');
      const later = document.createElement('button');
      go.className = later.className = 'mc-btn';
      later.textContent = 'Later';
      if (info.kind === 'game') {
        text.textContent = `Update downloaded (build ${info.build}). Restart to play it — or it starts next time.`;
        go.textContent = 'Restart now';
        go.addEventListener('click', () => void native.restart?.());
      } else {
        text.textContent = `A new version of the app is out (build ${info.build}). Download it to keep getting updates.`;
        go.textContent = 'Download';
        go.addEventListener('click', () => void native.openDownload?.());
      }
      later.addEventListener('click', () => bar.remove());
      bar.append(text, go, later);
      document.body.append(bar);
    });
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
    f.displayHz = this.displayHz;
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
    f.opponent = inGame ? this.match.bot : null;
    f.opponentColor = this.match.profile.color;
    f.lastReach = this.lastReach;
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
    sky.dayTime = this.viewTime() ?? (m ? m.world.dayTime : 6000);
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
    if (this.state === 'spectating' && this.spec) {
      this.tickSpectate(this.spec);
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
    if (m instanceof Match) this.tickModeUi(m, m.player, false);
    if ((this.shopUi.open || this.chestUi.open) && (m.player.dead || m.phase !== 'fight')) this.closeModeScreens();
    else if (this.shopUi.open) this.shopUi.refreshIfChanged();
    else if (this.chestUi.open) this.chestUi.refreshIfChanged();
    if (this.drill && this.state === 'playing') {
      this.tickDrill(this.drill);
      if (this.state !== 'playing' || this.match !== m) {
        this.handleEvents(m.player, true);
        this.handleEvents(m.bot, true);
        this.handleWorldEvents(m.world);
        return;
      }
    }

    if (m.phase === 'countdown') {
      // Jump (Space) when you're done arranging: on to the 3-2-1.
      const preparing = m instanceof Match && m.preparing;
      if (preparing && !this.inventory.open && !this.chat.open && this.input.held('jump')) this.screenAction({ k: 'ready' });
      this.showCountdown(m.countdownSeconds, preparing);
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
    if (m.phase === 'ended' && this.state === 'playing' && !this.drill) {
      if (this.resultTimer < 0) {
        // Immediate respawn skips the results screen, so don't linger either.
        this.resultTimer = this.session.rules.doImmediateRespawn ? 22 : 30;
        this.hud.showCenter(m.winner === m.player ? 'VICTORY' : 'YOU DIED', m.winner === m.player ? 'win' : 'lose', 40);
        this.autoGG(m.winner === m.player);
      } else if (--this.resultTimer === 0) this.finishDuel();
    }
  }

  /**
   * The countdown: while you're still arranging (10 s in a real duel) a quiet number and a hint,
   * then the usual 3-2-1 with its beeps.
   */
  private showCountdown(n: number, preparing: boolean) {
    if (n === this.lastCountdown || n <= 0) return;
    this.lastCountdown = n;
    this.hud.showCenter(String(n), preparing ? 'count prep' : 'count', 22);
    if (preparing) this.hud.showTitle('actionbar', `Sort your inventory (${keyName(this.input.binds.inventory)})${this.online ? '' : ` · ${keyName(this.input.binds.jump)} when ready`}`);
    else this.sound.countdown(false);
  }

  /** Online rounds: the server owns combat, so only local movement + feedback happen here. */
  private tickOnline(m: NetMatch) {
    const prevPhase = m.phase;
    m.tick();
    this.view.firstPerson.tick(m.player);
    this.hud.tick(m.player);
    this.tickOnlineModeUi(m);

    if (m.phase === 'countdown') {
      this.showCountdown(m.countdownSeconds, m.countdownSeconds > 3);
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
          if (e.crossbow) this.sound.crossbowShoot(f.pos);
          else this.sound.bowShoot(f.pos, e.power);
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
          // Your kill effect, where the opponent went down (not in drills or Bot vs Bot).
          if (live && f === m.bot && !this.drill && this.state === 'playing' && this.killEffect !== 'none') this.playKillEffect(this.killEffect, f.pos);
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
        case 'lunge':
          this.sound.lunge(f.pos);
          break;
        case 'spearCharge':
          this.sound.hit('knockback', e.target.pos);
          fx.crit(e.target.pos.x, e.target.pos.y + 1, e.target.pos.z, false, 20);
          if (isPlayer && live && this.settings.hitFeedback) this.hud.showFeedback(`CHARGE ${e.speed.toFixed(1)} b/s · ${(e.damage / 2).toFixed(1)} ❤`, 'kb');
          break;
        case 'smash':
          this.sound.smash(f.pos, e.fall > 5, e.ground !== false);
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
