import { B } from '../Blocks';
import { DroppedItem } from '../DroppedItem';
import type { Fighter } from '../Fighter';
import type { ItemId } from '../items';
import { TEAM_COLORS, TEAM_NAMES, teamOf, type GameMode, type ModeHost as Match, type ScoreLine } from './GameMode';
import { buildBedwarsMap, type BedwarsLayout, type Spot } from './maps';
import { SHOP, applyTeamEnchants, buy, respawnLoadout, type Currency, type ShopItem, type TeamGear } from './shop';

/** Ticks between drops: the island forge (iron, gold) and the middle generators, tier I. */
export const GEN = {
  iron: 20,
  gold: 120,
  diamond: 600,
  emerald: 1200,
} as const;
/** Most of each resource that can lie on a generator before it stops (Hypixel's caps). */
const GEN_CAP: Record<Currency, number> = { iron_ingot: 48, gold_ingot: 12, diamond: 4, emerald: 2 };
/** Respawn delay with a bed (5 s). */
export const RESPAWN_TICKS = 100;
/** Beds are destroyed for everyone this long into the game (then it is sudden death). */
export const BED_GONE_TICKS = 20 * 60 * 12;

interface TeamState {
  gear: TeamGear;
  bedAlive: boolean;
  /** Tick (fight time) to come back at, or null if alive / out. */
  respawnAt: number | null;
  /** Died with no bed: out of the game. */
  eliminated: boolean;
  deathHandled: boolean;
  kills: number;
  finalKills: number;
  bedsBroken: number;
}

function newGear(team: 0 | 1): TeamGear {
  return { armor: 0, pickaxe: 0, axe: 0, shears: false, sharpness: false, protection: 0, wool: team === 0 ? 'red_wool' : 'blue_wool', leather: team === 0 ? 'red' : 'blue' };
}

/**
 * Bed Wars, 1v1 (Hypixel rules, one player per team). Collect iron and gold at your island's
 * forge, buy blocks and gear at the shop, bridge over, break the other bed and then finish them.
 * While your bed stands you respawn 5 s after dying (losing what you carried to your killer);
 * once it is gone, the next death is final. The map is protected — only placed blocks break.
 */
export class Bedwars implements GameMode {
  readonly id = 'bedwars' as const;
  layout!: BedwarsLayout;
  teams: [TeamState, TeamState] = [this.freshTeam(0), this.freshTeam(1)];
  private timers = { iron: 0, gold: 0, diamond: 0, emerald: 0 };
  private announcements: ScoreLine[] = [];
  private bedsGoneAnnounced = false;

  private freshTeam(team: 0 | 1): TeamState {
    return { gear: newGear(team), bedAlive: true, respawnAt: null, eliminated: false, deathHandled: false, kills: 0, finalKills: 0, bedsBroken: 0 };
  }

  gear(m: Match, f: Fighter): TeamGear {
    return this.teams[teamOf(m, f)].gear;
  }

  setup(m: Match) {
    const w = m.world;
    this.layout = buildBedwarsMap(w.blocks);
    this.teams = [this.freshTeam(0), this.freshTeam(1)];
    this.timers = { iron: 0, gold: 0, diamond: 0, emerald: 0 };
    this.announcements = [];
    this.bedsGoneAnnounced = false;
    w.protectMap = true;
    w.voidY = -24;
    // Your own bed can't be broken; the shop can't be touched.
    w.breakRule = (f, x, y, z, id) => {
      if (id !== B.BED) return true;
      const team = teamOf(m, f);
      return !this.layout.teams[team].bed.some((c) => c.x === x && c.y === y && c.z === z);
    };
    // No building on top of a generator or inside a spawn point.
    w.placeRule = (_f, x, y, z) => {
      const near = (s: Spot, r: number) => Math.abs(x + 0.5 - s.x) <= r && Math.abs(z + 0.5 - s.z) <= r && y >= Math.floor(s.y) && y <= Math.floor(s.y) + 2;
      for (const t of this.layout.teams) if (near(t.spawn, 0.6)) return false;
      return true;
    };
    for (const f of [m.player, m.bot]) this.spawn(m, f, false);
  }

  /** Puts `f` at its spawn with the respawn loadout. */
  private spawn(m: Match, f: Fighter, onDeath: boolean) {
    const team = teamOf(m, f);
    const s = this.layout.teams[team].spawn;
    const g = this.teams[team].gear;
    const kit = respawnLoadout(g, onDeath);
    f.respawn(s.x, s.y, s.z, s.yaw, kit);
    f.naturalRegen = true;
    f.food.locked = true;
    applyTeamEnchants(f, g);
  }

  /** Buys from the shop for `f` (the bots call this; the player's shop screen does too). */
  buy(m: Match, f: Fighter, item: ShopItem): string | null {
    if (f.dead) return 'You are dead';
    return buy(f, this.gear(m, f), item);
  }

  /** Whether `f` is close enough to their team's shop to use it. */
  nearShop(m: Match, f: Fighter): boolean {
    const s = this.layout.teams[teamOf(m, f)].shop;
    return Math.hypot(f.pos.x - (s.x + 0.5), f.pos.z - (s.z + 0.5)) < 5 && Math.abs(f.pos.y - s.y) < 3;
  }

  tick(m: Match) {
    if (m.phase !== 'fight') return;
    const w = m.world;
    const t = m.fightTicks;
    // ---- generators
    const drop = (at: Spot, id: Currency) => {
      let lying = 0;
      for (const it of w.items) if (!it.removed && it.stack.id === id && Math.abs(it.pos.x - at.x) < 1.5 && Math.abs(it.pos.z - at.z) < 1.5) lying += it.stack.count;
      if (lying >= GEN_CAP[id]) return;
      const d = new DroppedItem({ id: id as ItemId, count: 1 }, at.x, at.y + 0.3, at.z, w.rng);
      d.vel.set(0, 0, 0);
      d.pickupDelay = 0;
      w.items.push(d);
    };
    // Faster forge in the diamond/emerald tier II periods (like Hypixel's timed upgrades).
    const tier2 = t > 20 * 60 * 5;
    if (++this.timers.iron >= GEN.iron) {
      this.timers.iron = 0;
      for (const team of this.layout.teams) drop(team.gen, 'iron_ingot');
    }
    if (++this.timers.gold >= GEN.gold) {
      this.timers.gold = 0;
      for (const team of this.layout.teams) drop(team.gen, 'gold_ingot');
    }
    if (++this.timers.diamond >= (tier2 ? GEN.diamond * 0.75 : GEN.diamond)) {
      this.timers.diamond = 0;
      for (const d of this.layout.diamonds) drop(d, 'diamond');
    }
    if (++this.timers.emerald >= (tier2 ? GEN.emerald * 0.75 : GEN.emerald)) {
      this.timers.emerald = 0;
      for (const e of this.layout.emeralds) drop(e, 'emerald');
    }

    // ---- beds
    for (const team of [0, 1] as const) {
      const st = this.teams[team];
      if (!st.bedAlive) continue;
      const cells = this.layout.teams[team].bed;
      const broken = cells.some((c) => w.blocks.get(c.x, c.y, c.z) !== B.BED);
      if (!broken && t < BED_GONE_TICKS) continue;
      st.bedAlive = false;
      for (const c of cells) if (w.blocks.get(c.x, c.y, c.z) === B.BED) w.blocks.set(c.x, c.y, c.z, B.AIR);
      if (t >= BED_GONE_TICKS) continue;
      const other = team === 0 ? 1 : 0;
      this.teams[other].bedsBroken++;
      const breaker = other === 0 ? m.player : m.bot;
      breaker.events.push({ type: 'bedBroken', team });
      this.announcements.push({ text: `BED DESTRUCTION > ${TEAM_NAMES[team]} Bed was destroyed by ${breaker.name}!`, color: TEAM_COLORS[team] });
    }
    if (t >= BED_GONE_TICKS && !this.bedsGoneAnnounced) {
      this.bedsGoneAnnounced = true;
      this.announcements.push({ text: 'All beds have been destroyed! Sudden death.', color: '#ffaa00' });
    }

    // ---- deaths and respawns
    for (const f of [m.player, m.bot]) {
      const team = teamOf(m, f);
      const st = this.teams[team];
      const enemy = f === m.player ? m.bot : m.player;
      if (f.dead && !st.deathHandled) {
        st.deathHandled = true;
        const killer = f.lastDamage?.attacker && f.lastDamage.attacker !== f ? f.lastDamage.attacker : null;
        // What you carried goes to whoever killed you (Hypixel): the resources, nothing else.
        if (killer && !killer.dead) {
          for (const c of ['iron_ingot', 'gold_ingot', 'diamond', 'emerald'] as Currency[]) {
            const n = f.countItem(c);
            if (n > 0) killer.addItem({ id: c, count: n });
          }
        }
        const final = !st.bedAlive;
        if (killer) {
          this.teams[team === 0 ? 1 : 0].kills++;
          if (final) this.teams[team === 0 ? 1 : 0].finalKills++;
        }
        // (The chat's death message says how; only a final kill needs saying on top of it.)
        if (final) this.announcements.push({ text: `FINAL KILL! ${f.name} is out of the game.`, color: '#ff5555' });
        if (final) st.eliminated = true;
        else st.respawnAt = t + RESPAWN_TICKS;
        void enemy;
      }
      if (f.dead && st.respawnAt !== null && t >= st.respawnAt) {
        st.respawnAt = null;
        st.deathHandled = false;
        this.spawn(m, f, true);
        m.onRespawn?.(f);
      }
    }
  }

  winner(m: Match): Fighter | null {
    if (this.teams[0].eliminated) return m.bot;
    if (this.teams[1].eliminated) return m.player;
    return null;
  }

  scoreboard(m: Match, viewer: Fighter): ScoreLine[] {
    const t = m.fightTicks;
    const lines: ScoreLine[] = [{ text: 'BED WARS', color: '#ffff55' }];
    const next = t < 20 * 60 * 5 ? ['Diamond II', 20 * 60 * 5] : t < BED_GONE_TICKS ? ['Bed gone', BED_GONE_TICKS] : null;
    if (next) {
      const left = Math.max(0, Math.ceil(((next[1] as number) - t) / 20));
      lines.push({ text: `${next[0]} in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    } else lines.push({ text: 'Sudden death', color: '#ff5555' });
    for (const team of [0, 1] as const) {
      const st = this.teams[team];
      const mark = st.eliminated ? '✘' : st.bedAlive ? '✔' : '1';
      const you = teamOf(m, viewer) === team ? ' YOU' : '';
      lines.push({ text: `${TEAM_NAMES[team][0]} ${TEAM_NAMES[team]}: ${mark}${you}`, color: TEAM_COLORS[team] });
    }
    const mine = this.teams[teamOf(m, viewer)];
    lines.push({ text: `Kills: ${mine.kills}  Final kills: ${mine.finalKills}` });
    lines.push({ text: `Beds broken: ${mine.bedsBroken}` });
    return lines;
  }

  title(m: Match, viewer: Fighter): { title: string; sub: string } | null {
    const st = this.teams[teamOf(m, viewer)];
    if (viewer.dead && st.respawnAt !== null) {
      const left = Math.max(1, Math.ceil((st.respawnAt - m.fightTicks) / 20));
      return { title: 'YOU DIED!', sub: `Respawning in ${left}…` };
    }
    return null;
  }

  takeAnnouncements(): ScoreLine[] {
    const out = this.announcements;
    this.announcements = [];
    return out;
  }
}

export { SHOP };
