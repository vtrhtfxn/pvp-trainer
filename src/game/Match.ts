import { BotBrain } from '../ai/BotBrain';
import type { BotProfile } from '../ai/difficulty';
import { Rng } from '../core/rng';
import { performAttack, pushApart, type AttackOutcome } from './combat';
import { Fighter } from './Fighter';
import type { KitDef } from './kits';
import { World } from './World';

export type Phase = 'countdown' | 'fight' | 'ended';
export const COUNTDOWN_TICKS = 60;
export const SPAWN_DISTANCE = 12;

/**
 * One duel: owns the world, both fighters and the bot brain, and advances the simulation in
 * the same order as a Minecraft client/server tick (inputs & clicks first, then entity ticks).
 */
export class Match {
  readonly world = new World(24);
  readonly player: Fighter;
  readonly bot: Fighter;
  readonly brain: BotBrain;
  readonly rng: Rng;
  phase: Phase = 'countdown';
  phaseTicks = 0;
  tickCount = 0;
  fightTicks = 0;
  winner: Fighter | null = null;

  // Player controls fed by the input layer
  private queuedClicks = 0;
  private queuedSlot: number | null = null;
  private queuedUse = 0;
  private queuedSwap = 0;
  useHeld = false;
  /** Last outcome of a player click (for HUD feedback). */
  lastPlayerAttack: AttackOutcome | null = null;

  constructor(
    readonly kit: KitDef,
    readonly profile: BotProfile,
    seed?: number,
  ) {
    this.rng = new Rng(seed);
    this.player = new Fighter('player', 'You', this.world);
    this.bot = new Fighter('bot', `${profile.name} Bot`, this.world);
    this.world.fighters.push(this.player, this.bot);
    this.world.rng = new Rng(this.rng.int(0, 2 ** 30));
    this.brain = new BotBrain(this.bot, this.player, this.world, profile, this.rng, () =>
      performAttack(this.bot, this.player),
    );
    this.reset();
  }

  reset() {
    const half = SPAWN_DISTANCE / 2;
    this.player.reset(0, half, 0, this.kit);
    this.bot.reset(0, -half, Math.PI, this.kit);
    this.world.clearEntities();
    this.brain.resetRound();
    this.phase = 'countdown';
    this.phaseTicks = 0;
    this.fightTicks = 0;
    this.winner = null;
    this.queuedClicks = 0;
    this.queuedSlot = null;
    this.queuedUse = 0;
    this.queuedSwap = 0;
    this.useHeld = false;
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

  queueClick() {
    this.queuedClicks++;
  }

  queueSlot(i: number) {
    this.queuedSlot = i;
  }

  get countdownSeconds(): number {
    return Math.max(0, Math.ceil((COUNTDOWN_TICKS - this.phaseTicks) / 20));
  }

  tick() {
    this.tickCount++;
    const p = this.player;
    const b = this.bot;
    p.snapshot();
    b.snapshot();

    if (this.phase === 'fight') {
      this.fightTicks++;
      this.handlePlayerActions();
      this.brain.tick();
    } else {
      this.queuedClicks = 0;
      this.queuedUse = 0;
      p.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
      if (this.phase === 'countdown') {
        b.input = { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
        b.yaw = Math.atan2(-(p.pos.x - b.pos.x), -(p.pos.z - b.pos.z));
      }
    }

    p.tick();
    b.tick();
    pushApart(p, b);
    this.world.tickEntities();

    this.phaseTicks++;
    if (this.phase === 'countdown' && this.phaseTicks >= COUNTDOWN_TICKS) {
      this.phase = 'fight';
      this.phaseTicks = 0;
    } else if (this.phase === 'fight' && (p.dead || b.dead)) {
      this.phase = 'ended';
      this.phaseTicks = 0;
      this.winner = p.dead ? b : p;
    }
  }

  /**
   * Mirrors Minecraft.handleKeybinds for the local player: hotbar keys, then swap-hands, then
   * either the item in use or attacks and use clicks. The fixed order is what makes attribute
   * swapping work — a number key and a click inside the same tick always switch first.
   */
  private handlePlayerActions() {
    const p = this.player;
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
      this.queuedClicks = 0; // clicks are swallowed while an item is in use
      this.queuedUse = 0;
    } else {
      while (this.queuedClicks > 0) {
        this.queuedClicks--;
        this.lastPlayerAttack = performAttack(p, this.bot);
      }
      while (this.queuedUse > 0) {
        this.queuedUse--;
        p.startUsingItem(true);
      }
      if (this.useHeld) p.startUsingItem();
    }
  }
}
