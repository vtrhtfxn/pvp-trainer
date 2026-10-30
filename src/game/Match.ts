import { BotBrain } from '../ai/BotBrain';
import type { BotProfile } from '../ai/difficulty';
import { Rng } from '../core/rng';
import { performAttack, pushApart, rayDistanceToTarget, type AttackOutcome } from './combat';
import { hitNearerEntity } from './crystals';
import { Fighter } from './Fighter';
import type { KitDef } from './kits';
import { World } from './World';
import type { GameMode } from './modes/GameMode';
import { createMode } from './modes';
import { runAction, type ReplayAction, type ReplayRecorder } from './replay';

export type Phase = 'countdown' | 'fight' | 'ended';
export const COUNTDOWN_TICKS = 60;
/** A real duel's countdown: 10 s to sort your inventory, the last 3 the usual 3-2-1. */
export const PREP_TICKS = 200;
export const SPAWN_DISTANCE = 12;
/** 2v2: how far apart teammates start (blocks, side by side). */
export const TEAM_SPREAD = 3;

/** Kits that can be played 2v2. */
export const TEAM_KITS = ['sword', 'diamond_pot', 'neth_pot', 'uhc', 'spear_mace', 'bedwars', 'skywars', 'axe', 'mace', 'crystal'] as const;

export function teamKit(id: string): boolean {
  return (TEAM_KITS as readonly string[]).includes(id);
}

/** A bot in the match besides the main opponent (2v2: your ally and the second opponent). */
interface ExtraBot {
  fighter: Fighter;
  brain: BotBrain;
}

/**
 * One duel: owns the world, both fighters and the bot brain, and advances the simulation in
 * the same order as a Minecraft client/server tick (inputs & clicks first, then entity ticks).
 */
export class Match {
  readonly world: World;
  readonly player: Fighter;
  readonly bot: Fighter;
  readonly brain: BotBrain;
  /** Trainer drills: a scripted bot that runs instead of the bot brain (null = the brain). */
  botDriver: (() => void) | null = null;
  readonly rng: Rng;
  phase: Phase = 'countdown';
  phaseTicks = 0;
  /** Ticks from the start of a round to FIGHT!: 3 s, or PREP_TICKS for a real duel. */
  countdownTicks = COUNTDOWN_TICKS;
  tickCount = 0;
  fightTicks = 0;
  winner: Fighter | null = null;
  /** Bed Wars / SkyWars rules on top of the duel, or null for a plain duel. */
  readonly mode: GameMode | null;
  /** Everyone in the game: you, the bot, and in a 2v2 your ally and the second opponent. */
  readonly fighters: Fighter[];
  /** 2v2: your teammate (a bot), or null in a 1v1. */
  readonly ally: Fighter | null = null;
  /** 2v2: the second opponent, or null in a 1v1. */
  readonly bot2: Fighter | null = null;
  private readonly extras: ExtraBot[] = [];

  // Player controls fed by the input layer
  /** Clicks this tick, each with what it hit on screen (renderedPick; NaN = test it at the tick). */
  private queuedClicks: number[] = [];
  /** 2v2: whom each queued click was aimed at. */
  private clickTargets: Fighter[] = [];
  private queuedSlot: number | null = null;
  private queuedUse = 0;
  private queuedSwap = 0;
  useHeld = false;
  /** Left button held: keeps mining the block under the crosshair. */
  attackHeld = false;
  /** The player's mining is driven elsewhere (a bot plays them in bot vs bot): don't reset it here. */
  externalMining = false;
  /** Last outcome of a player click (for HUD feedback). */
  lastPlayerAttack: AttackOutcome | null = null;
  /**
   * /tick freeze: everything but you stands still (vanilla keeps players moving while the game
   * is frozen). Your hits still land and their knockback waits until the world runs again.
   */
  frozen = false;
  /** Records this match for a replay (offline duels only). */
  recorder: ReplayRecorder | null = null;

  constructor(
    readonly kit: KitDef,
    readonly profile: BotProfile,
    seed?: number,
    /** 2v2: you and a bot ally against two bots (the ally plays at `allyProfile`). */
    teams?: { allyProfile?: BotProfile },
  ) {
    this.rng = new Rng(seed);
    this.mode = createMode(kit);
    this.world = new World(undefined, this.mode ? 12 : (kit.floorDepth ?? 0));
    if (this.mode) {
      // A floating map over the void: no floor, no walls.
      this.world.blocks.voidWorld = true;
      this.world.blocks.clear();
    }
    this.player = new Fighter('player', 'You', this.world);
    this.bot = new Fighter('bot', teams ? `${profile.name} Bot 1` : `${profile.name} Bot`, this.world);
    this.fighters = [this.player, this.bot];
    if (teams) {
      const ally = new Fighter('bot', `${(teams.allyProfile ?? profile).name} Ally`, this.world);
      ally.team = 0;
      const bot2 = new Fighter('bot', `${profile.name} Bot 2`, this.world);
      this.ally = ally;
      this.bot2 = bot2;
      this.fighters.push(ally, bot2);
    }
    this.world.fighters.push(...this.fighters);
    this.world.damageMultiplier = kit.damageMultiplier ?? 1;
    this.world.shieldStuns = !!kit.shieldStuns;
    this.world.legacyCombat = !!kit.legacyCombat;
    this.world.rng = new Rng(this.rng.int(0, 2 ** 30));
    // Like the player's clicks: an end crystal nearer than the opponent takes the hit.
    this.brain = new BotBrain(this.bot, this.player, this.world, profile, this.rng, () => this.botAttack(this.bot, this.brain.opponent));
    if (this.mode) this.brain.attachSky(this);
    for (const [f, prof] of [
      [this.ally, teams?.allyProfile ?? profile],
      [this.bot2, profile],
    ] as const) {
      if (!f) continue;
      const brain: BotBrain = new BotBrain(f, this.enemiesOf(f)[0], this.world, prof, this.rng, () => this.botAttack(f, brain.opponent));
      if (this.mode) brain.attachSky(this);
      this.extras.push({ fighter: f, brain });
    }
    this.reset();
  }

  /** A 2v2 game. */
  get teams(): boolean {
    return this.fighters.length > 2;
  }

  /** Everyone on the other team from `f`. */
  enemiesOf(f: Fighter): Fighter[] {
    return this.fighters.filter((g) => g.team !== f.team);
  }

  /** A bot's swing at `target` (an end crystal nearer than them takes it instead). */
  private botAttack(f: Fighter, target: Fighter): AttackOutcome {
    if (hitNearerEntity(f, rayDistanceToTarget(f, target))) {
      return { hit: false, reach: -1, crit: false, sprint: false, scale: 1, damage: 0, blocked: false, disabled: false, swap: false };
    }
    return performAttack(f, target);
  }

  /**
   * Whom `f`'s crosshair is on: the nearest enemy along it (2v2), else the main opponent — a
   * click is judged against them.
   */
  crosshairTarget(f: Fighter): Fighter {
    const enemies = this.enemiesOf(f);
    let best: Fighter | null = null;
    let bestD = Infinity;
    for (const e of enemies) {
      const d = rayDistanceToTarget(f, e);
      if (d >= 0 && d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ?? enemies.find((e) => !e.dead) ?? enemies[0];
  }

  onRespawn(f: Fighter) {
    if (f === this.bot) this.brain.resetRound();
    for (const x of this.extras) if (x.fighter === f) x.brain.resetRound();
  }

  reset() {
    const half = SPAWN_DISTANCE / 2;
    const side = this.teams ? TEAM_SPREAD / 2 : 0;
    this.player.reset(-side, half, 0, this.kit);
    this.bot.reset(-side, -half, Math.PI, this.kit);
    this.ally?.reset(side, half, 0, this.kit);
    this.bot2?.reset(side, -half, Math.PI, this.kit);
    this.world.clearEntities();
    for (const f of this.fighters) {
      f.naturalRegen = this.kit.naturalRegen ?? true;
      f.food.locked = !!this.kit.noHunger;
    }
    if (this.mode) this.mode.setup(this);
    this.brain.resetRound();
    for (const x of this.extras) {
      x.brain.resetRound();
      x.brain.chooseTarget(this.enemiesOf(x.fighter));
    }
    if (this.teams) this.brain.chooseTarget(this.enemiesOf(this.bot));
    this.phase = 'countdown';
    this.phaseTicks = 0;
    this.fightTicks = 0;
    this.winner = null;
    this.queuedClicks.length = 0;
    this.queuedSlot = null;
    this.queuedUse = 0;
    this.queuedSwap = 0;
    this.useHeld = false;
    this.attackHeld = false;
    this.lastPlayerAttack = null;
  }

  /** A fresh right-click press (so a tap shorter than a tick still fires a crossbow). */
  queueUse() {
    this.queuedUse++;
  }

  /** F: swap main hand and off hand. */
  queueSwapHands() {
    this.queuedSwap++;
  }

  /** `target`: 2v2, the enemy the click was aimed at on screen. */
  queueClick(picked = Number.NaN, target?: Fighter) {
    this.queuedClicks.push(picked);
    if (this.teams) this.clickTargets.push(target ?? this.crosshairTarget(this.player));
  }

  queueSlot(i: number) {
    this.queuedSlot = i;
  }

  /** A shop / chest / item action from a screen: runs it, and puts it in the replay. */
  act(a: ReplayAction): string | null | undefined {
    this.recorder?.act(a);
    return runAction(this, a);
  }

  get countdownSeconds(): number {
    return Math.max(0, Math.ceil((this.countdownTicks - this.phaseTicks) / 20));
  }

  /** Still in the inventory part of the countdown (before the 3-2-1). */
  get preparing(): boolean {
    return this.phase === 'countdown' && this.phaseTicks < this.countdownTicks - COUNTDOWN_TICKS;
  }

  /** Ready before the 10 s are up: straight to the 3-2-1. */
  skipPrep() {
    if (this.preparing) this.phaseTicks = this.countdownTicks - COUNTDOWN_TICKS;
  }

  tick() {
    // (2v2 games aren't recorded: replays hold two fighters.)
    const rec = this.teams ? null : this.recorder;
    if (rec) {
      rec.capture(this.player, {
        clicks: this.queuedClicks,
        slot: this.queuedSlot,
        use: this.queuedUse,
        swap: this.queuedSwap,
        useHeld: this.useHeld,
        attackHeld: this.attackHeld,
      });
    }
    this.step();
    rec?.after(this.player, this.bot);
  }

  private step() {
    this.tickCount++;
    const p = this.player;
    const b = this.bot;
    for (const f of this.fighters) f.snapshot();
    if (this.frozen) {
      b.prevPos.copy(b.pos);
      if (this.phase === 'fight') this.handlePlayerActions();
      else this.clearQueues();
      p.tick();
      return;
    }

    if (this.phase === 'fight') {
      this.fightTicks++;
      this.handlePlayerActions();
      if (this.botDriver) this.botDriver();
      else {
        if (this.teams) this.brain.chooseTarget(this.enemiesOf(b));
        this.brain.tick();
      }
      for (const x of this.extras) {
        x.brain.chooseTarget(this.enemiesOf(x.fighter));
        x.brain.tick();
      }
    } else {
      // Before the fight you can still pick your starting slot and off hand, just not use them.
      if (this.phase === 'countdown') {
        if (this.queuedSlot !== null) p.selectSlot(this.queuedSlot);
        for (; this.queuedSwap > 0; this.queuedSwap--) p.swapHands();
      }
      this.queuedSlot = null;
      this.clearQueues();
      p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
      if (this.phase === 'countdown') {
        b.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
        b.yaw = Math.atan2(-(p.pos.x - b.pos.x), -(p.pos.z - b.pos.z));
        for (const x of this.extras) {
          const f = x.fighter;
          const t = x.brain.opponent;
          f.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
          f.yaw = Math.atan2(-(t.pos.x - f.pos.x), -(t.pos.z - f.pos.z));
        }
      }
    }

    for (const f of this.fighters) f.tick();
    const all = this.fighters;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) pushApart(all[i], all[j]);
    this.world.tickEntities();

    this.phaseTicks++;
    if (this.phase === 'countdown' && this.phaseTicks >= this.countdownTicks) {
      this.phase = 'fight';
      this.phaseTicks = 0;
    } else if (this.phase === 'fight' && this.mode) {
      this.mode.tick(this);
      const w = this.mode.winner(this);
      if (w) {
        this.phase = 'ended';
        this.phaseTicks = 0;
        this.winner = w;
      }
    } else if (this.phase === 'fight' && this.teams) {
      // 2v2: over when a whole team is down.
      const redDown = this.fighters.every((f) => f.team !== 0 || f.dead);
      const blueDown = this.fighters.every((f) => f.team !== 1 || f.dead);
      if (redDown || blueDown) {
        this.phase = 'ended';
        this.phaseTicks = 0;
        this.winner = redDown ? b : p;
      }
    } else if (this.phase === 'fight' && (p.dead || b.dead)) {
      this.phase = 'ended';
      this.phaseTicks = 0;
      this.winner = p.dead ? b : p;
    }
  }

  private clearQueues() {
    this.queuedClicks.length = 0;
    this.clickTargets.length = 0;
    this.queuedUse = 0;
    this.queuedSwap = 0;
  }

  /**
   * Mirrors Minecraft.handleKeybinds for the local player: hotbar keys, then swap-hands, then
   * either the item in use or attacks and use clicks. The fixed order is what makes attribute
   * swapping work — a number key and a click inside the same tick always switch first.
   */
  private handlePlayerActions() {
    const p = this.player;
    if (p.gameMode === 'spectator') {
      // Spectators can look and fly but not touch anything (hotbar keys still switch).
      if (this.queuedSlot !== null) p.selectSlot(this.queuedSlot);
      this.queuedSlot = null;
      this.clearQueues();
      return;
    }
    if (this.queuedSlot !== null) {
      p.selectSlot(this.queuedSlot);
      this.queuedSlot = null;
    }
    while (this.queuedSwap > 0) {
      this.queuedSwap--;
      p.swapHands();
    }
    if (p.usingItem) {
      if (!this.useHeld) p.releaseUsingItem();
      this.queuedClicks.length = 0; // clicks are swallowed while an item is in use
      this.queuedUse = 0;
    } else {
      // A click on a block starts mining it (and is not an attack: no cooldown reset); holding
      // the button keeps mining. Anything else is a swing at the opponent.
      let mined = false;
      for (const picked of this.queuedClicks) {
        const onScreen = Number.isNaN(picked) ? undefined : picked;
        // 2v2: the click goes to whichever enemy the crosshair is on (Game picked it on screen).
        const target = this.teams ? (this.clickTargets.shift() ?? this.crosshairTarget(p)) : this.bot;
        // The crosshair picks whatever is nearest: an end crystal in front of the opponent
        // gets hit (and blows up) instead of them.
        if (hitNearerEntity(p, onScreen ?? rayDistanceToTarget(p, target))) continue;
        // The opponent on screen in front of a block is an attack, not a dig.
        // A spear never digs: it jabs even at a block (and reaches past the usual 3 blocks).
        const spear = !!p.heldDef().spear;
        if (!mined && !spear && !(onScreen !== undefined && onScreen >= 0) && p.tickMining(true, true)) mined = true;
        else if (!mined) this.lastPlayerAttack = performAttack(p, target, onScreen);
      }
      this.queuedClicks.length = 0;
      this.clickTargets.length = 0;
      if (!mined && !this.externalMining) p.tickMining(this.attackHeld && !p.heldDef().spear, false);
      while (this.queuedUse > 0) {
        this.queuedUse--;
        p.startUsingItem(true);
      }
      if (this.useHeld) p.startUsingItem();
    }
  }
}
