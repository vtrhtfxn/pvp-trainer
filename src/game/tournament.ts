import { DIFFICULTIES, type TierId } from '../ai/difficulty';
import type { KitId } from './kits';

/**
 * Tournaments, PvP Champs style: 4 to 32 fighters (you and bots) in a double-elimination
 * bracket. Everyone starts in the upper bracket; a loss there drops you to the lower bracket,
 * where a second loss knocks you out. The upper-bracket winner meets the lower-bracket winner
 * in the grand final.
 *
 * Every match is a best of three, drafted first: each side bans a kit, then each picks one,
 * and the decider is drawn at random from what is left. Game 1 is played on the higher seed's
 * pick, game 2 on the other's, game 3 (if it comes to that) on the decider. Bot-vs-bot matches
 * are simulated from their tiers; yours are real duels.
 */

export type TourneySize = 4 | 8 | 16 | 32;
export const TOURNEY_SIZES: TourneySize[] = [4, 8, 16, 32];

/** The kits a tournament drafts from: the main modes and the subtiers (no Bed Wars or SkyWars). */
export const TOURNEY_KITS: KitId[] = ['sword', 'sword18', 'axe', 'uhc', 'diamond_pot', 'neth_pot', 'crystal', 'smp', 'mace', 'spear_mace', 'cart', 'dia_smp'];

export type FieldId = 'rising' | 'contender' | 'elite' | 'open';

/** How strong the bots are: their tiers are spread evenly over the range. */
export const FIELDS: Record<FieldId, { name: string; desc: string; tiers: TierId[] }> = {
  rising: { name: 'Rising', desc: 'LT5 – HT4 bots', tiers: ['lt5', 'ht5', 'lt4', 'ht4'] },
  contender: { name: 'Contender', desc: 'HT4 – HT2 bots', tiers: ['ht4', 'lt3', 'ht3', 'lt2', 'ht2'] },
  elite: { name: 'Elite', desc: 'LT2 – HT1 bots', tiers: ['lt2', 'ht2', 'lt1', 'ht1'] },
  open: { name: 'Open', desc: 'LT5 – HT1, every tier', tiers: ['lt5', 'ht5', 'lt4', 'ht4', 'lt3', 'ht3', 'lt2', 'ht2', 'lt1', 'ht1'] },
};

const TIER_ORDER: TierId[] = ['lt5', 'ht5', 'lt4', 'ht4', 'lt3', 'ht3', 'lt2', 'ht2', 'lt1', 'ht1'];

export interface Entrant {
  id: number;
  name: string;
  /** null: you. */
  tier: TierId | null;
  seed: number;
  /** A bot's favourite kits: what it picks first, and never bans. */
  favs: KitId[];
  /** Online: the player (room member id) behind a human entrant. */
  pid?: number;
}

export type Side = 'upper' | 'lower' | 'final';

/** Where a match's winner (or loser) goes next. */
export interface Feed {
  match: string;
  slot: 0 | 1;
}

export type DraftKind = 'ban' | 'pick';

export interface Draft {
  /** Index into the match's players of Team A (the higher seed). */
  teamA: 0 | 1;
  bans: [KitId | null, KitId | null];
  picks: [KitId | null, KitId | null];
  decider: KitId | null;
}

export interface TMatch {
  id: string;
  side: Side;
  /** 1-based round within its side. */
  round: number;
  index: number;
  /** Entrant ids (null until the feeding match is decided). */
  players: [number | null, number | null];
  wins: [number, number];
  /** Slot (0/1) of each game's winner, with the kit it was played on. */
  games: { kit: KitId; winner: 0 | 1 }[];
  winner: number | null;
  draft: Draft | null;
  next?: Feed;
  drop?: Feed;
}

export interface Tournament {
  v: 1;
  size: TourneySize;
  field: FieldId;
  /** Random state (so a saved tournament carries on the same way). */
  rng: number;
  entrants: Entrant[];
  /** In playing order: each round of the upper bracket, then the lower rounds it feeds. */
  matches: TMatch[];
  /** Your entrant id. */
  you: number;
  /** Set once the grand final is decided. */
  champion: number | null;
}

// ------------------------------------------------------------------ random

/** mulberry32 on a number we can save. */
function rand(t: Tournament): number {
  let x = (t.rng = (t.rng + 0x6d2b79f5) >>> 0);
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
}

function pick<T>(t: Tournament, list: readonly T[]): T {
  return list[Math.floor(rand(t) * list.length)];
}

function shuffle<T>(t: Tournament, list: T[]): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand(t) * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ------------------------------------------------------------------ names

const NAME_A = ['Frost', 'Ember', 'Nova', 'Pixel', 'Vortex', 'Shade', 'Blaze', 'Echo', 'Onyx', 'Raven', 'Storm', 'Jade', 'Cobalt', 'Zephyr', 'Talon', 'Lunar', 'Quartz', 'Viper', 'Drift', 'Rogue', 'Sable', 'Atlas', 'Kairo', 'Nyx', 'Hex', 'Volt', 'Rune', 'Glint', 'Brisk', 'Comet'];
const NAME_B = ['', 'x', 'z', 'ify', 'ed', 'MC', '_pvp', 'Hero', 'King', 'Edge', 'Fang', 'Byte', 'Wolf', 'Tap', 'Crit', 'Strafe', '07', '_', 'ix', 'ly'];

function botNames(t: Tournament, n: number, avoid: string[]): string[] {
  const out = new Set<string>(avoid.map((a) => a.toLowerCase()));
  const names: string[] = [];
  while (names.length < n) {
    const name = pick(t, NAME_A) + pick(t, NAME_B);
    if (out.has(name.toLowerCase())) continue;
    out.add(name.toLowerCase());
    names.push(name);
  }
  return names;
}

// ------------------------------------------------------------------ building the bracket

/** Seed order down the bracket, so seeds 1 and 2 can only meet in the final: 1,8,4,5,2,7,3,6… */
export function seedOrder(n: number): number[] {
  let order = [1];
  while (order.length < n) {
    const m = order.length * 2;
    order = order.flatMap((s) => [s, m + 1 - s]);
  }
  return order;
}

const match = (id: string, side: Side, round: number, index: number): TMatch => ({
  id,
  side,
  round,
  index,
  players: [null, null],
  wins: [0, 0],
  games: [],
  winner: null,
  draft: null,
});

/**
 * Upper rounds 1…k (k = log2 size), lower rounds 1…2(k−1), then the grand final.
 * Lower round 1 pairs up the upper-round-1 losers; every even lower round takes the next upper
 * round's losers (in reverse order, so you don't meet the same player straight away); every odd
 * one after that halves the field.
 */
function buildMatches(size: TourneySize): TMatch[] {
  const k = Math.log2(size);
  const L = 2 * (k - 1);
  const up: TMatch[][] = [];
  const low: TMatch[][] = [];
  for (let r = 1; r <= k; r++) up.push(Array.from({ length: size >> r }, (_, i) => match(`u${r}-${i}`, 'upper', r, i)));
  for (let r = 1; r <= L; r++) {
    const n = size >> (Math.floor((r + 1) / 2) + 1);
    low.push(Array.from({ length: n }, (_, i) => match(`l${r}-${i}`, 'lower', r, i)));
  }
  const final = match('gf', 'final', 1, 0);
  for (let r = 1; r <= k; r++) {
    up[r - 1].forEach((m, i) => {
      m.next = r < k ? { match: up[r][i >> 1].id, slot: (i & 1) as 0 | 1 } : { match: final.id, slot: 0 };
      if (r === 1) m.drop = { match: low[0][i >> 1].id, slot: (i & 1) as 0 | 1 };
      else {
        const row = low[2 * (r - 1) - 1];
        m.drop = { match: row[row.length - 1 - i].id, slot: 1 };
      }
    });
  }
  for (let r = 1; r <= L; r++) {
    low[r - 1].forEach((m, i) => {
      if (r === L) m.next = { match: final.id, slot: 1 };
      else if (r % 2 === 1) m.next = { match: low[r][i].id, slot: 0 };
      else m.next = { match: low[r][i >> 1].id, slot: (i & 1) as 0 | 1 };
    });
  }
  // Playing order: U1, L1, U2, L2, L3, U3, L4, L5, U4…, GF.
  const order: TMatch[] = [...up[0], ...(low[0] ?? [])];
  for (let r = 2; r <= k; r++) {
    order.push(...up[r - 1]);
    const even = 2 * (r - 1);
    if (low[even - 1]) order.push(...low[even - 1]);
    if (r < k && low[even]) order.push(...low[even]);
  }
  order.push(final);
  return order;
}

/** A person in the bracket: their name, rating (0 = LT5 … 9 = HT1, for seeding) and, online, member id. */
export interface Human {
  name: string;
  rating: number;
  pid?: number;
}

/**
 * A new tournament for one or more people; bots fill the other places. Ratings only decide
 * seeds. `you` is the first human (offline: the only one).
 */
export function createBracket(size: TourneySize, field: FieldId, humans: Human[], seed = (Math.random() * 2 ** 32) >>> 0): Tournament {
  const t: Tournament = { v: 1, size, field, rng: seed >>> 0, entrants: [], matches: buildMatches(size), you: 0, champion: null };
  const tiers = FIELDS[field].tiers;
  const people = humans.slice(0, size);
  const bots = size - people.length;
  const names = botNames(t, bots, people.map((p) => p.name));
  const all: { name: string; tier: TierId | null; rating: number; pid?: number }[] = people.map((p) => ({ name: p.name, tier: null, rating: p.rating + rand(t) * 0.5, pid: p.pid }));
  for (let i = 0; i < bots; i++) {
    // Spread the bots over the field's tiers, strongest first.
    const tier = tiers[Math.min(tiers.length - 1, Math.floor(((bots - 1 - i) / Math.max(1, bots)) * tiers.length))];
    all.push({ name: names[i], tier, rating: TIER_ORDER.indexOf(tier) + rand(t) * 0.5 });
  }
  all.sort((a, b) => b.rating - a.rating);
  t.entrants = all.map((p, i) => ({
    id: i,
    name: p.name,
    tier: p.tier,
    seed: i + 1,
    favs: p.tier ? shuffle(t, [...TOURNEY_KITS]).slice(0, 3) : [],
    ...(p.pid !== undefined ? { pid: p.pid } : {}),
  }));
  const firstHuman = t.entrants.find((e) => e.tier === null && (humans[0]?.pid === undefined || e.pid === humans[0].pid));
  t.you = firstHuman?.id ?? -1;
  const order = seedOrder(size);
  const first = t.matches.filter((m) => m.side === 'upper' && m.round === 1);
  first.forEach((m, i) => {
    m.players = [order[2 * i] - 1, order[2 * i + 1] - 1];
  });
  return t;
}

/**
 * A new tournament for you against bots. `youRating` (0 = LT5 … 9 = HT1, from your My Tiers)
 * only decides your seed.
 */
export function createTournament(size: TourneySize, field: FieldId, yourName: string, youRating: number, seed = (Math.random() * 2 ** 32) >>> 0): Tournament {
  return createBracket(size, field, [{ name: yourName, rating: youRating }], seed);
}

/** A person left an online tournament: a bot plays their remaining matches under their name. */
export function botTakesOver(t: Tournament, id: number, tier: TierId = 'lt3') {
  const e = t.entrants[id];
  if (!e || e.tier) return;
  e.tier = tier;
  e.favs = shuffle(t, [...TOURNEY_KITS]).slice(0, 3);
  delete e.pid;
}

export function isHuman(e: Entrant): boolean {
  return e.tier === null;
}

// ------------------------------------------------------------------ queries

export function matchById(t: Tournament, id: string): TMatch {
  return t.matches.find((m) => m.id === id)!;
}

/** The next match to be played (both players known, not decided), or null when it's over. */
export function nextMatch(t: Tournament): TMatch | null {
  return t.matches.find((m) => m.winner === null && m.players[0] !== null && m.players[1] !== null) ?? null;
}

export function isYours(t: Tournament, m: TMatch): boolean {
  return m.players.includes(t.you);
}

/** Out of the tournament: lost in the lower bracket or the grand final. */
export function isOut(t: Tournament, id: number): boolean {
  return t.matches.some((m) => m.winner !== null && m.players.includes(id) && m.winner !== id && m.side !== 'upper');
}

export function roundName(t: Tournament, m: TMatch): string {
  if (m.side === 'final') return 'Grand Final';
  const k = Math.log2(t.size);
  if (m.side === 'upper') return m.round === k ? 'Upper Final' : m.round === k - 1 && k > 2 ? 'Upper Semifinal' : `Upper Round ${m.round}`;
  const L = 2 * (k - 1);
  return m.round === L ? 'Lower Final' : `Lower Round ${m.round}`;
}

/**
 * Final standing: the champion 1st, the grand-finalist 2nd, then everyone else by how late they
 * went out (people out in the same lower round share a place, e.g. "5th–6th").
 */
export function placement(t: Tournament, id: number): { place: number; to: number } | null {
  const stage = (e: number): number => {
    if (t.champion === e) return 1e6;
    const lost = t.matches.find((m) => m.winner !== null && m.winner !== e && m.players.includes(e) && m.side !== 'upper');
    // Still in: ahead of everyone who is out.
    if (!lost) return Infinity;
    return lost.side === 'final' ? 1e5 : lost.round;
  };
  const mine = stage(id);
  if (mine === Infinity) return null;
  const all = t.entrants.map((e) => stage(e.id));
  const better = all.filter((s) => s > mine).length;
  const same = all.filter((s) => s === mine).length;
  return { place: better + 1, to: better + same };
}

export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s}`;
}

export function placeLabel(p: { place: number; to: number }): string {
  return p.place === p.to ? ordinal(p.place) : `${ordinal(p.place)}–${ordinal(p.to)}`;
}

// ------------------------------------------------------------------ the kit draft

/** Draft order: Team A bans, Team B bans, Team A picks, Team B picks, then the decider. */
export type DraftStep = { team: 'A' | 'B'; kind: DraftKind } | { team: null; kind: 'decider' };

const STEPS: DraftStep[] = [
  { team: 'A', kind: 'ban' },
  { team: 'B', kind: 'ban' },
  { team: 'A', kind: 'pick' },
  { team: 'B', kind: 'pick' },
  { team: null, kind: 'decider' },
];

export function startDraft(t: Tournament, m: TMatch): Draft {
  if (m.draft) return m.draft;
  const [a, b] = m.players as [number, number];
  // The higher seed is Team A.
  const teamA: 0 | 1 = t.entrants[a].seed <= t.entrants[b].seed ? 0 : 1;
  m.draft = { teamA, bans: [null, null], picks: [null, null], decider: null };
  return m.draft;
}

/** Slot (0/1) in the match of a team. */
export function teamSlot(d: Draft, team: 'A' | 'B'): 0 | 1 {
  return team === 'A' ? d.teamA : ((1 - d.teamA) as 0 | 1);
}

/** The draft step waiting to be made, or null once it's complete. */
export function draftStep(d: Draft): DraftStep | null {
  if (!d.bans[0]) return STEPS[0];
  if (!d.bans[1]) return STEPS[1];
  if (!d.picks[0]) return STEPS[2];
  if (!d.picks[1]) return STEPS[3];
  if (!d.decider) return STEPS[4];
  return null;
}

/** Kits still free to ban or pick. */
export function draftOpen(d: Draft): KitId[] {
  const used = new Set([...d.bans, ...d.picks, d.decider].filter(Boolean) as KitId[]);
  return TOURNEY_KITS.filter((k) => !used.has(k));
}

/** Makes the current ban or pick. Returns false if it isn't a legal choice. */
export function draftChoose(d: Draft, kit: KitId): boolean {
  const step = draftStep(d);
  if (!step || step.kind === 'decider' || !draftOpen(d).includes(kit)) return false;
  const i = step.team === 'A' ? 0 : 1;
  if (step.kind === 'ban') d.bans[i] = kit;
  else d.picks[i] = kit;
  return true;
}

/** The decider: drawn at random from whatever was neither banned nor picked. */
export function rollDecider(t: Tournament, d: Draft): KitId {
  d.decider ??= pick(t, draftOpen(d));
  return d.decider;
}

/**
 * A bot's ban or pick. It picks its favourites first. It bans your best kit (from My Tiers)
 * when it plays you, and otherwise a kit it doesn't like.
 */
export function botChoice(t: Tournament, m: TMatch, yourBest: readonly KitId[] = []): KitId {
  const d = m.draft!;
  const step = draftStep(d) as { team: 'A' | 'B'; kind: DraftKind };
  const me = t.entrants[m.players[teamSlot(d, step.team)]!];
  const open = draftOpen(d);
  if (step.kind === 'pick') return me.favs.find((k) => open.includes(k)) ?? pick(t, open);
  if (isYours(t, m)) {
    const target = yourBest.find((k) => open.includes(k) && !me.favs.includes(k));
    if (target) return target;
  }
  const disliked = open.filter((k) => !me.favs.includes(k));
  return pick(t, disliked.length ? disliked : open);
}

/** The kit game `n` (0-based) of a drafted match is played on. */
export function gameKit(d: Draft, n: number): KitId | null {
  if (n === 0) return d.picks[0];
  if (n === 1) return d.picks[1];
  return d.decider;
}

// ------------------------------------------------------------------ results

/** Records a game; once someone has two wins the match is decided and both move on. */
export function recordGame(t: Tournament, m: TMatch, winnerSlot: 0 | 1): void {
  if (m.winner !== null) return;
  const kit = gameKit(m.draft!, m.games.length) ?? TOURNEY_KITS[0];
  m.games.push({ kit, winner: winnerSlot });
  m.wins[winnerSlot]++;
  if (m.wins[winnerSlot] < 2) return;
  const w = m.players[winnerSlot]!;
  const l = m.players[1 - winnerSlot]!;
  m.winner = w;
  if (m.side === 'final') {
    t.champion = w;
    return;
  }
  if (m.next) matchById(t, m.next.match).players[m.next.slot] = w;
  if (m.drop) matchById(t, m.drop.match).players[m.drop.slot] = l;
}

/** Bot strength in a game: its tier, plus a little for a favourite kit. */
function strength(t: Tournament, id: number, kit: KitId): number {
  const e = t.entrants[id];
  const base = e.tier ? TIER_ORDER.indexOf(e.tier) : 4;
  return base + (e.favs.includes(kit) ? 0.4 : 0);
}

/** Plays a bot-vs-bot match out: the draft, then each game from their strengths. */
export function simulateMatch(t: Tournament, m: TMatch): void {
  const d = startDraft(t, m);
  for (let step = draftStep(d); step && step.kind !== 'decider'; step = draftStep(d)) draftChoose(d, botChoice(t, m));
  rollDecider(t, d);
  while (m.winner === null) {
    const kit = gameKit(d, m.games.length)!;
    const diff = strength(t, m.players[0]!, kit) - strength(t, m.players[1]!, kit);
    const pA = 1 / (1 + Math.exp(-diff * 0.6));
    recordGame(t, m, rand(t) < pA ? 0 : 1);
  }
}

/** Simulates bot matches until it's your turn to play (or the tournament is over). */
export function playUntilYours(t: Tournament): TMatch | null {
  for (let m = nextMatch(t); m; m = nextMatch(t)) {
    if (isYours(t, m)) return m;
    simulateMatch(t, m);
  }
  return null;
}

/** The opponent you face in `m`. */
export function opponentOf(t: Tournament, m: TMatch): Entrant {
  const slot = m.players[0] === t.you ? 1 : 0;
  return t.entrants[m.players[slot]!];
}

/** A bot's colour (its tier's) for faces and name plates. */
export function entrantColor(e: Entrant): string {
  return e.tier ? DIFFICULTIES[e.tier].color : '#ffffff';
}

// ------------------------------------------------------------------ saving

const KEY = 'pvp-trainer.tournament.v1';

export function saveTournament(t: Tournament | null) {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: it lasts this session */
  }
}

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Tournament;
    if (t?.v !== 1 || !Array.isArray(t.matches) || !Array.isArray(t.entrants) || !TOURNEY_SIZES.includes(t.size)) return null;
    return t;
  } catch {
    return null;
  }
}
