import type { DifficultyId } from '../ai/difficulty';
import { hurt, rayDistanceToTarget } from '../game/combat';
import type { Fighter, FighterEvent } from '../game/Fighter';
import type { KitId } from '../game/kits';
import type { Match } from '../game/Match';
import { attacker, shielder, still, strafer, type DrillBot } from './bots';

/**
 * The Trainer: drills for the real 1.9+ techniques, each against a scripted bot, with instant
 * feedback on every attempt. A drill watches the fighters' events each tick and calls
 * success() / fail() with what went right or wrong.
 */

export type DrillGroup = 'Sword basics' | 'Defense' | 'Axe & shield' | 'Pot' | 'Crystal' | 'Mace' | 'UHC';
export const DRILL_GROUPS: DrillGroup[] = ['Sword basics', 'Defense', 'Axe & shield', 'Pot', 'Crystal', 'Mace', 'UHC'];

export interface Feedback {
  text: string;
  kind: 'good' | 'bad' | 'info';
}

export interface DrillDef {
  id: string;
  name: string;
  group: DrillGroup;
  kit: KitId;
  /** 1 easy … 3 hard. */
  level: 1 | 2 | 3;
  /** Successes needed; for timed drills, the pass mark in percent. */
  goal: number;
  /** Timed drill: ends after this many ticks and passes on `score() >= goal`. */
  timeTicks?: number;
  /** What to press, step by step. */
  how: string[];
  /** The mechanic that makes it work. */
  why: string;
  /** Bot profile for the match (the bot's own brain runs when `bot` is not given). */
  profile?: DifficultyId;
  bot?: (run: DrillRun) => DrillBot;
  /** The drill looks after the player's health itself (no top-ups). */
  ownsHealth?: boolean;
  /** The bot runs at full pace from the start (timed drills, where a warm-up would skew the score). */
  fullPace?: boolean;
  /** Missed swings are not about the bot (crystals, anchors), so don't explain them. */
  quietMisses?: boolean;
  setup?(run: DrillRun): void;
  check(run: DrillRun, pe: FighterEvent[], be: FighterEvent[]): void;
  /** Timed drills: the score in percent. */
  score?(run: DrillRun): number;
  /** Timed drills: the live readout. */
  status?(run: DrillRun): string;
}

export interface DrillResult {
  passed: boolean;
  successes: number;
  fails: number;
  /** successes / attempts, 0..1. */
  accuracy: number;
  seconds: number;
  bestStreak: number;
  /** Timed drills: the score in percent. */
  score?: number;
  /** Practice speed it was played at (1 = full speed; slower runs don't tick a drill off). */
  speed: number;
  /** The mistake made most often, with the full advice and how many times. */
  topMistake?: { text: string; count: number };
}

/** Practice speeds for the Trainer: the whole game, bot and you, in slow motion. */
export const DRILL_SPEEDS = [0.5, 0.75, 1] as const;
const SPEED_KEY = 'pvp-trainer.drills.speed';

export function loadDrillSpeed(): number {
  try {
    const v = Number(localStorage.getItem(SPEED_KEY));
    return (DRILL_SPEEDS as readonly number[]).includes(v) ? v : 1;
  } catch {
    return 1;
  }
}

export function saveDrillSpeed(v: number) {
  try {
    localStorage.setItem(SPEED_KEY, String(v));
  } catch {
    /* ignore */
  }
}

/** The warm-up: where the bot's pace starts, and how it moves with each attempt. */
export const PACE_START = 0.6;
const PACE_STEP = 0.1;
const PACE_MIN = 0.5;

const pct = (x: number) => `${Math.round(x * 100)}%`;
const hearts = (hp: number) => `${(hp / 2).toFixed(1)} ❤`;
const hits = (pe: FighterEvent[], target: Fighter) =>
  pe.filter((e): e is Extract<FighterEvent, { type: 'attack' }> => e.type === 'attack' && e.target === target);
const hurtBy = (events: FighterEvent[], attacker: Fighter) =>
  events.find((e): e is Extract<FighterEvent, { type: 'hurt' }> => e.type === 'hurt' && e.attacker === attacker);

export class DrillRun {
  t = 0;
  successes = 0;
  fails = 0;
  streak = 0;
  bestStreak = 0;
  readonly feed: (Feedback & { at: number })[] = [];
  result: DrillResult | null = null;
  /** Per-drill scratch state. */
  s: Record<string, number | boolean | null> = {};
  /**
   * How fast the bot moves and swings, 0.5–1: it starts slow, speeds up with every success and
   * eases off after two misses in a row, so the drill meets you where you are.
   */
  pace: number;
  private lastOnGround = true;
  private lastMissNote = -999;
  /** Failed attempts by kind ("Too early", "Not a crit"…), for the results screen. */
  private readonly mistakes = new Map<string, { text: string; count: number }>();

  constructor(
    readonly def: DrillDef,
    public m: Match,
    /** Practice speed (slow motion); the game loop reads it. */
    readonly speed = 1,
  ) {
    this.pace = def.fullPace || !def.bot ? 1 : PACE_START;
    this.attach(m);
  }

  get p(): Fighter {
    return this.m.player;
  }
  get b(): Fighter {
    return this.m.bot;
  }
  /** The player was on the ground at the end of the previous tick. */
  get wasOnGround(): boolean {
    return this.lastOnGround;
  }

  /** Hooks a (new) match up: the drill's bot script, the fight started at once, setup. */
  attach(m: Match) {
    this.m = m;
    m.bot.name = 'Training Bot';
    m.phase = 'fight';
    m.phaseTicks = 0;
    const bot = this.def.bot?.(this);
    m.botDriver = bot ? () => bot(m, this.t, this.pace) : null;
    this.def.setup?.(this);
  }

  say(text: string, kind: Feedback['kind'] = 'info') {
    this.feed.push({ text, kind, at: this.t });
    if (this.feed.length > 6) this.feed.shift();
  }

  success(text: string) {
    this.successes++;
    this.streak++;
    this.s.missRun = 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.say(`✔ ${text}`, 'good');
    if (!this.def.fullPace) this.pace = Math.min(1, this.pace + PACE_STEP);
    if (!this.def.timeTicks && this.successes >= this.def.goal) this.finish();
  }

  fail(text: string) {
    this.fails++;
    this.streak = 0;
    this.s.missRun = Number(this.s.missRun ?? 0) + 1;
    const kind = text.split(' — ')[0].replace(/[\d.]+/g, '#');
    const m = this.mistakes.get(kind) ?? { text, count: 0 };
    m.count++;
    this.mistakes.set(kind, m);
    this.say(`✘ ${text}`, 'bad');
    if (!this.def.fullPace && Number(this.s.missRun) >= 2) {
      this.pace = Math.max(PACE_MIN, this.pace - PACE_STEP);
      this.s.missRun = 0;
    }
  }

  /** One tick, after the match ticked and before its events are cleared. */
  update() {
    if (this.result) return;
    this.t++;
    const p = this.p;
    const b = this.b;
    this.def.check(this, p.events, b.events);
    this.explainMiss();
    // Keep the sparring partner (and you) standing, so a drill never ends in a death screen.
    if (!b.dead && b.health < b.maxHealth * 0.4) b.health = b.maxHealth;
    if (!this.def.ownsHealth && !p.dead && p.health < p.maxHealth * 0.3) p.health = p.maxHealth;
    this.lastOnGround = p.onGround;
    if (this.def.timeTicks && this.t >= this.def.timeTicks) this.finish();
  }

  /**
   * A swing that hit nothing: say why, so a miss teaches something — out of reach (and by how
   * much) or the crosshair was off the bot. Not counted as a failed attempt.
   */
  private explainMiss() {
    const p = this.p;
    if (this.def.quietMisses || !p.events.some((e) => e.type === 'miss') || this.t - this.lastMissNote < 10) return;
    this.lastMissNote = this.t;
    const reach = p.entityReach();
    const along = rayDistanceToTarget(p, this.b, 8);
    if (along > reach) this.say(`Missed — out of reach: ${along.toFixed(2)} blocks (yours is ${reach.toFixed(1)}). Step in first.`);
    else if (along < 0) this.say('Missed — your crosshair was off the bot. Aim at its body.');
  }

  get progress(): string {
    const extra = [this.pace < 1 ? `bot pace ${Math.round(this.pace * 100)}%` : '', this.speed < 1 ? `${Math.round(this.speed * 100)}% speed` : '']
      .filter(Boolean)
      .map((x) => ` · ${x}`)
      .join('');
    if (this.def.timeTicks) {
      const left = Math.max(0, Math.ceil((this.def.timeTicks - this.t) / 20));
      return `${this.def.status?.(this) ?? ''} · ${left}s left${extra}`;
    }
    return `${this.successes} / ${this.def.goal}${extra}`;
  }

  finish() {
    if (this.result) return;
    const tries = this.successes + this.fails;
    const score = this.def.score?.(this);
    this.result = {
      passed: score !== undefined ? score >= this.def.goal : this.successes >= this.def.goal,
      successes: this.successes,
      fails: this.fails,
      accuracy: tries ? this.successes / tries : 0,
      seconds: this.t / 20,
      bestStreak: this.bestStreak,
      score,
      speed: this.speed,
      topMistake: [...this.mistakes.values()].sort((a, b) => b.count - a.count)[0],
    };
  }
}

/** The tier the combo drill's bot plays at. */
const COMBO_BOT: DifficultyId = 'ht5';

export const DRILLS: DrillDef[] = [
  // ------------------------------------------------------------------ sword basics
  {
    id: 'cooldown',
    name: 'Full-charge hits',
    group: 'Sword basics',
    kit: 'sword',
    level: 1,
    goal: 10,
    how: ['Watch the attack bar under your crosshair.', 'Click only when it is full (a sword takes 0.6 s).', 'Land 10 full-charge hits on the moving target.'],
    why: 'In 1.9+ every swing restarts the cooldown and early hits do 20% + 80% × charge² of the damage. Only hits above 90% charge can crit or sprint-knock back — spam clicking loses fights.',
    bot: () => strafer({ range: 2.6, period: 40, strafe: 0.7 }),
    check(run, pe) {
      for (const e of hits(pe, run.b)) {
        if (e.strong) run.success(`Full charge (${pct(e.scale)})`);
        else run.fail(`Too early — only ${pct(e.scale)} charged. Wait for the bar.`);
      }
    },
  },
  {
    id: 'wtap',
    name: 'Sprint hits (W-tap)',
    group: 'Sword basics',
    kit: 'sword',
    level: 1,
    goal: 8,
    how: [
      'Sprint at the target and hit it with a full bar: it flies back (sprint knockback).',
      'The hit stops your sprint. Start sprinting again before the next hit: release W for a split second and press it again (W-tap), or tap your sprint key.',
      'Holding the sprint key (or Toggle Sprint) re-sprints for you — double-tap-W sprinters must W-tap.',
      'Land 8 sprint-knockback hits.',
    ],
    why: 'A full-charge hit while the server sees you sprinting adds a level of knockback, then cancels your sprint (and slows you to 60%). Only a fresh sprint gives the next hit that knockback again — that is what a W-tap or sprint reset is for.',
    bot: () => strafer({ range: 3.2, period: 50 }),
    check(run, pe) {
      for (const e of hits(pe, run.b)) {
        if (e.sprint) run.success('Sprint knockback');
        else if (e.strong) run.fail('No sprint knockback — you were not sprinting. Re-sprint (W-tap) before the hit.');
        else run.fail(`Too early — ${pct(e.scale)} charged.`);
      }
    },
  },
  {
    id: 'crit',
    name: 'Jump crits',
    group: 'Sword basics',
    kit: 'sword',
    level: 1,
    goal: 8,
    how: ['Stop sprinting (sprint hits can never crit).', 'Jump, and click on the way down — after the top of the jump — with a full bar.', 'Stars around the target mean a crit. Land 8.'],
    why: 'A critical hit needs: falling (not on the ground), not sprinting, not in water or on a ladder, and over 90% charge. It does 1.5× damage. A jump lasts about 12 ticks, the same as a sword charge — so jump and swing on one rhythm.',
    bot: () => strafer({ range: 2.4, period: 60, strafe: 0.5 }),
    check(run, pe) {
      for (const e of hits(pe, run.b)) {
        if (e.crit) run.success('Critical hit');
        else if (e.sprint) run.fail('Sprint hit, not a crit — sprinting cancels crits. Let go of sprint first.');
        else if (e.strong) run.fail('Not a crit — hit while falling, not on the ground or on the way up.');
        else run.fail(`Too early — ${pct(e.scale)} charged.`);
      }
    },
  },
  {
    id: 'spacing',
    name: 'Spacing (S-tap)',
    group: 'Sword basics',
    kit: 'sword',
    level: 2,
    goal: 8,
    how: [
      'The bot walks in and swings at you now and then.',
      'Hit it from 2.5 blocks or further (the reach readout shows your distance).',
      'After each hit tap S (S-tap) or let go of W so it can not close the gap and trade back.',
    ],
    why: 'Reach is 3 blocks from your eyes to their hitbox. Hitting from the edge of it while they are still out of theirs means you land first and they eat the knockback; an S-tap stops you running into them after your hit.',
    bot: () => attacker({ interval: [30, 50], range: 2.6 }),
    check(run, pe) {
      for (const e of hits(pe, run.b)) {
        if (!e.strong) run.fail(`Too early — ${pct(e.scale)} charged.`);
        else if (e.reach >= 2.5) run.success(`Hit from ${e.reach.toFixed(2)} blocks`);
        else run.fail(`Too close — ${e.reach.toFixed(2)} blocks. Back off (S-tap) and hit at the edge of your reach.`);
      }
    },
  },
  {
    id: 'critchain',
    name: 'Crit chain',
    group: 'Sword basics',
    kit: 'sword',
    level: 2,
    goal: 3,
    how: [
      'The bot fights back now and then.',
      'Land 4 crits in a row — jump, crit on the way down, land, jump again — without a non-crit hit and without it hitting you.',
      'Do it 3 times.',
    ],
    why: 'A jump (about 12 ticks) and a sword charge (12.5 ticks) line up, so you can crit on every swing. Crits only carry normal knockback, which keeps the opponent close enough to crit again.',
    bot: () => attacker({ interval: [60, 90], range: 2.6 }),
    check(run, pe) {
      if (hurtBy(pe, run.b) && Number(run.s.chain ?? 0) > 0) {
        run.fail(`Chain broken at ${run.s.chain} — it hit you.`);
        run.s.chain = 0;
      }
      for (const e of hits(pe, run.b)) {
        if (e.crit) {
          run.s.chain = Number(run.s.chain ?? 0) + 1;
          run.say(`Crit ${run.s.chain} / 4`);
          if (Number(run.s.chain) >= 4) {
            run.success('4 crits in a row');
            run.s.chain = 0;
          }
        } else {
          if (Number(run.s.chain ?? 0) > 0) run.fail(`Chain broken at ${run.s.chain} — that hit was not a crit.`);
          run.s.chain = 0;
        }
      }
    },
  },
  {
    id: 'combo',
    name: 'Combo',
    group: 'Sword basics',
    kit: 'sword',
    level: 2,
    goal: 3,
    profile: COMBO_BOT,
    how: ['This bot fights back (HT5 — the second tier).', 'Land 5 hits in a row without it hitting you — sprint hits, W-taps and good spacing keep it knocked back.', 'Do it 3 times.'],
    why: 'Each sprint hit knocks the opponent out of range for a moment; re-sprinting and walking back in at the right time lets you hit again before they can. A combo ends the moment they land a hit.',
    check(run, pe) {
      const combo = run.p.stats.combo;
      if (combo >= 5 && !run.s.counted) {
        run.s.counted = true;
        run.success('5-hit combo');
      }
      if (hurtBy(pe, run.b)) {
        const had = Number(run.s.lastCombo ?? 0);
        if (had >= 2 && !run.s.counted) run.fail(`Combo broken at ${had} hits`);
        run.s.counted = false;
      }
      run.s.lastCombo = combo;
    },
  },
  {
    id: 'aim',
    name: 'Aim tracking',
    group: 'Sword basics',
    kit: 'sword',
    level: 1,
    goal: 70,
    timeTicks: 20 * 20,
    fullPace: true,
    how: ['The bot sprint-strafes left and right in front of you.', 'Keep your crosshair on it for 20 seconds — no need to click.', 'Pass with 70% of the time on target.'],
    why: 'Your hit lands where your crosshair is when you click. A strafing opponent at 3 blocks crosses your screen fast; keeping the crosshair on them (and leading a little) is what makes your full-charge hits connect.',
    bot: () => strafer({ range: 3, period: 18, speed: 2 }),
    check(run) {
      run.s.total = Number(run.s.total ?? 0) + 1;
      if (rayDistanceToTarget(run.p, run.b, 6) >= 0) run.s.on = Number(run.s.on ?? 0) + 1;
    },
    score: (run) => (100 * Number(run.s.on ?? 0)) / Math.max(1, Number(run.s.total ?? 0)),
    status: (run) => `On target ${Math.round((100 * Number(run.s.on ?? 0)) / Math.max(1, Number(run.s.total ?? 0)))}%`,
  },

  // ------------------------------------------------------------------ defense
  {
    id: 'jumpreset',
    name: 'Jump reset',
    group: 'Defense',
    kit: 'sword',
    level: 3,
    goal: 6,
    how: [
      'The bot sprints in and hits you every 2–3 seconds.',
      'Hold W toward it and press jump on the exact tick its hit lands — watch it close in and time it.',
      'Too early and you are already in the air; too late and the knockback has lifted you. The readout shows how far you flew.',
    ],
    why: 'Knockback halves your speed and pushes you away (and up). If you jump on that same tick, while still on the ground, your jump — and the sprint-jump boost toward them — cancels most of the push: you stay in range to hit back. Jumping even a tick early only makes you fly further.',
    bot: (run) => attacker({ interval: [40, 60], sprint: true, range: 2.6, onPlan: (next) => (run.s.nextSwing = next) }),
    check(run, pe) {
      const p = run.p;
      const jumped = pe.some((e) => e.type === 'jump');
      if (jumped) run.s.jumpAt = run.t;
      if (hurtBy(pe, run.b)) {
        run.s.x = p.pos.x;
        run.s.z = p.pos.z;
        run.s.kbAt = run.t;
        run.s.pending = null;
        const early = run.t - Number(run.s.jumpAt ?? -999);
        if (jumped) run.success('Jump reset — same tick');
        else if (!run.wasOnGround && early <= 8) run.fail(`Too early by ${early} tick${early > 1 ? 's' : ''} — you were already in the air.`);
        else run.s.pending = run.t;
      } else if (run.s.pending !== null && run.s.pending !== undefined) {
        const late = run.t - Number(run.s.pending);
        if (p.input.jump) {
          run.fail(`Too late by ${late} tick${late > 1 ? 's' : ''} — the knockback had already lifted you.`);
          run.s.pending = null;
        } else if (late >= 6) {
          run.fail('No jump — press jump the moment the hit lands.');
          run.s.pending = null;
        }
      }
      if (run.s.kbAt !== null && run.s.kbAt !== undefined && run.t - Number(run.s.kbAt) === 12) {
        const d = Math.hypot(p.pos.x - Number(run.s.x), p.pos.z - Number(run.s.z));
        run.say(`Knockback taken: ${d.toFixed(2)} blocks`);
        run.s.kbAt = null;
      }
    },
  },
  {
    id: 'pcrit',
    name: 'P-crit (punish crit)',
    group: 'Defense',
    // A NethPot technique: netherite's knockback resistance keeps you close enough to answer.
    kit: 'neth_pot',
    level: 3,
    goal: 5,
    how: [
      'NethPot kit (netherite armor). Let the bot hit you — its hit throws you up into the air.',
      'Do not jump yourself. While you come down from its knockback, crit it back with a full bar (and no sprint).',
      'Land 5 punish crits.',
    ],
    why: 'A crit only needs you to be falling. Knockback lifts you, so you are "falling" a few ticks after being hit — a free crit window. Netherite armor’s knockback resistance (10% a piece) keeps you close enough to reach them, which is why it is a NethPot staple: answer every hit with a harder one.',
    bot: () => attacker({ interval: [50, 70], sprint: true, range: 2.6 }),
    check(run, pe) {
      if (hurtBy(pe, run.b)) {
        run.s.hurtAt = run.t;
        run.s.jumped = false;
      }
      if (pe.some((e) => e.type === 'jump')) run.s.jumped = true;
      for (const e of hits(pe, run.b)) {
        const since = run.t - Number(run.s.hurtAt ?? -999);
        if (since > 25) {
          run.say('Wait for the bot to hit you first, then punish it.');
          continue;
        }
        if (e.crit && !run.s.jumped) run.success('P-crit');
        else if (e.crit) run.fail("That was a jump crit — don't jump: crit on the way down from its knockback.");
        else if (e.strong) run.fail(e.sprint ? 'Sprint hit — let go of sprint so the hit can crit.' : 'Not a crit — wait until you start falling.');
        else run.fail(`Too early — ${pct(e.scale)} charged.`);
      }
    },
  },
  {
    id: 'hitselect',
    name: 'Hit select',
    group: 'Defense',
    kit: 'sword',
    level: 3,
    goal: 6,
    how: [
      'The bot swings at you every couple of seconds.',
      "Don't swing first. Let it swing (hit or miss), then hit it straight back while its sword is still recharging.",
      'Land 6 hits within half a second of its swing.',
    ],
    why: 'After a swing, a sword needs 0.6 s to recharge. Hitting in that window means it cannot answer your hit — you win the trade instead of swapping hits. Swinging first into a charged opponent just lets them punish you.',
    bot: (run) =>
      attacker({
        interval: [30, 50],
        range: 2.9,
        onSwing: (t) => {
          run.s.swingAt = t;
        },
      }),
    check(run, pe) {
      for (const e of hits(pe, run.b)) {
        if (!e.strong) {
          run.fail(`Too early — ${pct(e.scale)} charged.`);
          continue;
        }
        const since = run.t - Number(run.s.swingAt ?? -999);
        const botCharge = run.b.attackStrengthScale(0);
        if (since <= 10 && botCharge < 0.8) run.success(`Hit select (${since} ticks after its swing)`);
        else if (botCharge >= 0.9) run.fail('You swung first while its sword was charged — wait for its swing, then punish.');
        else run.fail('Too slow — hit back within half a second of its swing.');
      }
    },
  },

  // ------------------------------------------------------------------ axe & shield
  {
    id: 'block',
    name: 'Shield timing',
    group: 'Axe & shield',
    kit: 'axe',
    level: 2,
    goal: 6,
    how: [
      'The bot walks in and swings every 2–3 seconds.',
      'Raise your shield (hold right click) just before its swing — at least 5 ticks (0.25 s) before, but no more than about a second.',
      'Lower it again to hit back. Block 6 hits.',
    ],
    why: 'A shield blocks everything from the front, but only 5 ticks after you raise it — and while it is up you can not attack. Raising it on time and dropping it to punish is the core of Axe PvP.',
    bot: () => attacker({ interval: [45, 70], range: 2.8 }),
    check(run, pe) {
      if (pe.some((e) => e.type === 'shieldRaise')) run.s.raisedAt = run.t;
      const up = run.t - Number(run.s.raisedAt ?? -999);
      if (pe.some((e) => e.type === 'shieldBlock' && e.attacker === run.b)) {
        if (up <= 25) run.success(`Blocked (raised ${up} ticks before)`);
        else run.fail(`Blocked, but you held it up for ${(up / 20).toFixed(1)} s — raise it just before the swing.`);
      } else if (hurtBy(pe, run.b)) {
        if (run.p.raisingShield()) run.fail(`Raised too late — ${up} ticks. A shield needs 5 ticks before it blocks.`);
        else run.fail('Not blocked — hold right click as it swings.');
      }
    },
  },
  {
    id: 'disable',
    name: 'Shield disable',
    group: 'Axe & shield',
    kit: 'axe',
    level: 1,
    goal: 5,
    how: ['The bot holds its shield up at you.', 'Switch to the axe (slot 1) and hit the shield.', 'Disable it 5 times (it comes back up quickly in this drill).'],
    why: 'An axe hit on a raised shield puts it on a 5-second cooldown. A sword just bounces off. Breaking the shield is how you get damage through a blocking player.',
    bot: () => shielder({ cooldown: 30 }),
    check(run, pe) {
      for (const e of pe) {
        if (e.type !== 'hitShield' || e.target !== run.b) continue;
        if (e.disabled) run.success('Shield disabled');
        else run.fail('Blocked — switch to the axe to break a shield.');
      }
    },
  },
  {
    id: 'attrswap',
    name: 'Attribute swap',
    group: 'Axe & shield',
    kit: 'axe',
    level: 3,
    goal: 5,
    how: [
      'Hold the sword (slot 2) with a full bar.',
      'Press the axe key (1) and click in the same moment — the hotbar key first, the click in the same tick.',
      'The axe breaks the shield, but the hit uses the sword’s cooldown. Do it 5 times.',
    ],
    why: 'Attack damage and cooldown come from the item you held on the last tick, but the item in your hand right now decides everything else (axe = shield disable, Breach, Knockback…). Swapping on the click tick mixes the two. It works in 1.21.x; Mojang has said it is unintended.',
    bot: () => shielder({ cooldown: 30 }),
    check(run, pe) {
      for (const e of pe) {
        if (e.type !== 'hitShield' || e.target !== run.b) continue;
        if (e.disabled && e.swap) run.success('Attribute swap — disabled with the sword’s cooldown');
        else if (e.disabled) run.fail('Disabled, but not a swap — hold the sword, then press 1 and click together.');
        else run.fail('Blocked — the axe must be what you switch to as you click.');
      }
    },
  },
  {
    id: 'punish',
    name: 'Disable → punish',
    group: 'Axe & shield',
    kit: 'axe',
    level: 2,
    goal: 3,
    how: ['Break the bot’s shield with the axe.', 'Switch to the sword (2) and land 3 hits in the 5 seconds the shield is down.', 'Do it 3 times.'],
    why: 'A disabled shield is a 5-second window where they can not block. Switching straight to the sword (faster cooldown) and going in with crits and sprint hits is where Axe fights are won.',
    bot: () => shielder(),
    check(run, pe) {
      for (const e of pe) {
        if (e.type === 'hitShield' && e.target === run.b && e.disabled) {
          run.s.until = run.t + 100;
          run.s.hits = 0;
          run.say('Shield down — punish it!');
        }
      }
      if (run.s.until !== null && run.s.until !== undefined) {
        run.s.hits = Number(run.s.hits) + hits(pe, run.b).length;
        if (run.t >= Number(run.s.until)) {
          const n = Number(run.s.hits);
          if (n >= 3) run.success(`${n} hits in the opening`);
          else run.fail(`Only ${n} hit${n === 1 ? '' : 's'} while the shield was down — switch to the sword and go in.`);
          run.s.until = null;
        }
      }
    },
  },

  // ------------------------------------------------------------------ pot
  {
    id: 'pot',
    name: 'Potting',
    group: 'Pot',
    kit: 'diamond_pot',
    level: 2,
    goal: 6,
    ownsHealth: true,
    how: [
      'You are hurt. Pick a Splash Healing (slots 2–9).',
      'Look straight down and throw it at your feet (right click) — moving is fine, that is how run-potting works.',
      'Get 6 pots that heal you at 80% strength or more.',
    ],
    why: 'A splash potion heals less the further you are from where it lands. Thrown straight down it lands on you at full strength (Instant Health II heals 4 hearts); aimed at the horizon it lands blocks away and is wasted.',
    bot: () => still,
    setup(run) {
      run.p.health = 8;
    },
    check(run, pe) {
      for (const e of pe) {
        if (e.type !== 'splashed' || !e.own || e.potion !== 'healing') continue;
        if (e.scale >= 0.8) run.success(`Full pot (${pct(e.scale)})`);
        else run.fail(`Only ${pct(e.scale)} of the pot — look straight down as you throw.`);
        run.s.refill = run.t + 30;
      }
      if (run.s.refill && run.t >= Number(run.s.refill)) {
        run.p.health = Math.min(run.p.health, 8);
        run.s.refill = null;
      }
    },
  },
  {
    id: 'retotem',
    name: 'Re-totem',
    group: 'Pot',
    kit: 'neth_pot',
    level: 2,
    goal: 5,
    ownsHealth: true,
    how: [
      'Every few seconds your totem pops.',
      'Put a new totem in your off hand as fast as you can: select the hotbar totem and press F (swap hands), or open the inventory and move one in.',
      'Then switch back to your sword and restock the hotbar totem from your inventory before the next pop.',
      'Under 1 second counts. Do it 5 times.',
    ],
    why: 'A totem only saves you from the off hand (or main hand). After a pop, the next lethal hit kills you unless you re-totem first — in Crystal and NethPot that race is often a few ticks.',
    bot: () => still,
    check(run) {
      const p = run.p;
      const popped = run.s.poppedAt;
      if (popped !== null && popped !== undefined) {
        const d = run.t - Number(popped);
        if (p.offhand?.id === 'totem_of_undying' && d > 0) {
          if (d <= 20) run.success(`Re-totem in ${d} ticks (${(d / 20).toFixed(2)} s)`);
          else run.fail(`Re-totem took ${(d / 20).toFixed(2)} s — keep a totem on your hotbar and press F.`);
          run.s.poppedAt = null;
          run.s.nextPop = run.t + 50;
        } else if (d > 120) {
          run.fail('Too slow — keep a totem on your hotbar and press F.');
          p.offhand = { id: 'totem_of_undying', count: 1 };
          run.s.poppedAt = null;
          run.s.nextPop = run.t + 50;
        }
        return;
      }
      // Keep spares coming, then pop the next one.
      if (p.countItem('totem_of_undying') < 3) p.setSlot(9, { id: 'totem_of_undying', count: 1 });
      if (run.t < Number(run.s.nextPop ?? 40) || p.offhand?.id !== 'totem_of_undying') return;
      // A totem in the main hand would pop first: fights are fought with a weapon out.
      if (p.heldStack()?.id === 'totem_of_undying') {
        if (!run.s.warned) run.say('Switch back to your sword — the next pop is coming.');
        run.s.warned = true;
        return;
      }
      run.s.warned = false;
      {
        p.health = p.maxHealth;
        p.invulnerableTime = 0;
        hurt(p, p.health + p.absorption + 200, null, false, false, true);
        if (p.offhand?.id !== 'totem_of_undying' && !p.dead) {
          run.s.poppedAt = run.t;
          run.say('Totem popped — re-totem!');
        }
      }
    },
  },

  // ------------------------------------------------------------------ crystal
  {
    id: 'crystal',
    name: 'Crystal combo',
    group: 'Crystal',
    kit: 'crystal',
    quietMisses: true,
    level: 2,
    goal: 8,
    how: [
      'Place obsidian next to the bot (slot 2), a crystal on it (slot 3), then hit the crystal.',
      'Stand back a little — the blast hurts you too.',
      'Land 8 crystal hits on the bot. The readout shows how many ticks your combo took.',
    ],
    why: 'An end crystal explodes (power 6) when hit, hurting everyone near it — most when they stand at or above it. Fast players place and break in 2–4 ticks, before the opponent can react.',
    bot: () => still,
    check(run, _pe, be) {
      const placed = run.p.stats.crystalsPlaced;
      if (placed > Number(run.s.placed ?? 0)) run.s.placedAt = run.t;
      run.s.placed = placed;
      for (const e of be) {
        if (e.type !== 'explosionHit' || e.damage <= 0) continue;
        const d = run.t - Number(run.s.placedAt ?? run.t);
        run.success(`Crystal hit for ${hearts(e.damage)} (${d} ticks after placing)`);
      }
    },
  },
  {
    id: 'hitcrystal',
    name: 'Hit-crystal',
    group: 'Crystal',
    kit: 'crystal',
    quietMisses: true,
    level: 3,
    goal: 5,
    how: [
      'Hit the bot with your sword first (a full-charge hit).',
      'Then within a second place obsidian and a crystal next to it and blow it up.',
      'Land 5 hit-crystals.',
    ],
    why: 'The sword hit knocks the opponent up and puts them in hurt immunity for half a second; a crystal that lands as that runs out, while they are still in the air, hits hard and they can not jump-reset it. Chaining hit → crystal is the core of Crystal PvP.',
    bot: () => still,
    check(run, pe, be) {
      for (const e of hits(pe, run.b)) if (e.strong) run.s.hitAt = run.t;
      for (const e of be) {
        if (e.type !== 'explosionHit' || e.damage <= 0) continue;
        const since = run.t - Number(run.s.hitAt ?? -999);
        if (since <= 20) run.success(`Hit-crystal — blast ${since} ticks after the hit (${hearts(e.damage)})`);
        else run.fail('Crystal landed, but no sword hit in the second before — hit first, then crystal.');
        run.s.hitAt = -999;
      }
    },
  },
  {
    id: 'anchor',
    name: 'Respawn anchor',
    group: 'Crystal',
    kit: 'crystal',
    quietMisses: true,
    level: 2,
    goal: 5,
    how: [
      'Place a respawn anchor next to the bot (slot 4) and charge it with glowstone (slot 5).',
      'Switch to anything else (the totem slot is the safe habit) and right click it: it explodes.',
      'Hurt the bot with 5 anchors.',
    ],
    why: 'Outside the Nether a charged respawn anchor explodes (power 5) when used. Anchors do big damage on flat ground where crystals can not reach your feet.',
    bot: () => still,
    check(run, _pe, be) {
      const blown = run.p.stats.anchorsBlown;
      const fresh = blown > Number(run.s.blown ?? 0);
      run.s.blown = blown;
      if (!fresh) return;
      const e = be.find((x) => x.type === 'explosionHit');
      if (e && e.type === 'explosionHit' && e.damage > 0) run.success(`Anchor hit for ${hearts(e.damage)}`);
      else run.fail('The anchor went off out of range — place it right next to the bot.');
    },
  },

  // ------------------------------------------------------------------ mace
  {
    id: 'smash',
    name: 'Wind charge smash',
    group: 'Mace',
    kit: 'mace',
    level: 2,
    goal: 5,
    how: [
      'Look straight down and throw a wind charge (slot 5) as you jump — it launches you up.',
      'Switch to the mace (slot 3) and hit the bot on the way down.',
      'A smash needs at least 1.5 blocks of fall. Land 5.',
    ],
    why: 'A mace hit after falling 1.5+ blocks is a smash: +4 damage per block for the first 3, +2 for the next 5, +1 after — and it resets your fall so you take none. Wind charges are the fastest way up.',
    bot: () => still,
    check(run, pe) {
      for (const e of pe) {
        if (e.type === 'smash') run.success(`Smash — fell ${e.fall.toFixed(1)} blocks, ${hearts(e.damage)}`);
      }
      if (hits(pe, run.b).length && run.p.heldStack()?.id === 'mace' && !pe.some((x) => x.type === 'smash')) {
        run.fail('No smash — you need to be falling at least 1.5 blocks.');
      }
    },
  },

  // ------------------------------------------------------------------ uhc
  {
    id: 'mlg',
    name: 'Water bucket clutch',
    group: 'UHC',
    kit: 'uhc',
    level: 2,
    goal: 3,
    ownsHealth: true,
    how: [
      'You get lifted 20 blocks up.',
      'Hold the water bucket (slot 5), look down and right click the ground just before you land.',
      'Land in the water with no fall damage — 3 times. Pick the water back up if you like.',
    ],
    why: 'Water cancels all fall damage. Placed a moment before impact it catches you; too early and you fall past the flowing water, too late and you hit the ground.',
    bot: () => still,
    check(run, pe) {
      const p = run.p;
      if (!run.s.air && run.t >= Number(run.s.next ?? 20)) {
        // A full bucket in slot 5 for every drop, and a fresh spot each time (last drop's water
        // would otherwise catch you for free).
        p.setSlot(4, { id: 'water_bucket', count: 1 });
        p.health = p.maxHealth;
        run.s.ground = run.s.ground ?? p.pos.y;
        run.s.drop = Number(run.s.drop ?? 0) + 1;
        const x = ((Number(run.s.drop) % 6) - 3) * 4;
        p.pos.set(x, Number(run.s.ground) + 20, p.pos.z);
        p.vel.set(0, 0, 0);
        p.fallDistance = 0;
        run.s.air = true;
        run.s.liftedAt = run.t;
        run.say('Falling — get the water out!');
        return;
      }
      if (!run.s.air || run.t - Number(run.s.liftedAt) < 4) return;
      const fall = pe.find((e) => e.type === 'hurt' && e.attacker === null && !e.fire);
      if (fall && fall.type === 'hurt') {
        run.fail(`Took ${hearts(fall.damage)} of fall damage — place the water just before you land.`);
        run.s.air = false;
        run.s.next = run.t + 40;
        p.health = p.maxHealth;
      } else if (p.inWater && !fall) {
        run.success('Clutch — no fall damage');
        run.s.air = false;
        run.s.next = run.t + 60;
      } else if (p.onGround) {
        run.success('Landed without damage');
        run.s.air = false;
        run.s.next = run.t + 60;
      }
    },
  },
];

export function drillById(id: string): DrillDef | undefined {
  return DRILLS.find((d) => d.id === id);
}

// ------------------------------------------------------------------ progress

export interface DrillBest {
  passed: boolean;
  /** Best accuracy (or score, for timed drills), 0..100. */
  best: number;
  /** Fastest pass, seconds. */
  fastest?: number;
}

const KEY = 'pvp-trainer.drills.v1';

export function loadDrillProgress(): Record<string, DrillBest> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, DrillBest> = {};
    for (const [k, v] of Object.entries(raw as Record<string, Partial<DrillBest>>)) {
      if (!v || typeof v !== 'object' || !drillById(k)) continue;
      out[k] = { passed: !!v.passed, best: Number.isFinite(v.best) ? Number(v.best) : 0, fastest: Number.isFinite(v.fastest) ? Number(v.fastest) : undefined };
    }
    return out;
  } catch {
    return {};
  }
}

/** Records a finished run; returns true if it was a new best. */
export function recordDrill(progress: Record<string, DrillBest>, id: string, r: DrillResult): boolean {
  const cur = progress[id] ?? { passed: false, best: 0 };
  const value = r.score ?? r.accuracy * 100;
  const better = value > cur.best || (r.passed && !cur.passed) || (r.passed && (cur.fastest === undefined || r.seconds < cur.fastest));
  progress[id] = {
    passed: cur.passed || r.passed,
    best: Math.max(cur.best, value),
    fastest: r.passed ? Math.min(cur.fastest ?? Infinity, r.seconds) : cur.fastest,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    /* ignore */
  }
  return better;
}
