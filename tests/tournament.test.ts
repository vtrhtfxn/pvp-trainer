import { describe, expect, it } from 'vitest';
import {
  TOURNEY_KITS,
  TOURNEY_SIZES,
  botChoice,
  createTournament,
  draftChoose,
  draftOpen,
  draftStep,
  gameKit,
  isOut,
  matchById,
  nextMatch,
  placement,
  playUntilYours,
  recordGame,
  rollDecider,
  seedOrder,
  simulateMatch,
  startDraft,
  type Tournament,
} from '../src/game/tournament';

/** Plays every match, yours included (you as a mid-tier bot). */
function runAll(t: Tournament) {
  for (let m = nextMatch(t); m; m = nextMatch(t)) simulateMatch(t, m);
}

describe('tournament bracket', () => {
  it('seeds 1 and 2 on opposite halves', () => {
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  for (const size of TOURNEY_SIZES) {
    it(`${size} players: double elimination down to one champion`, () => {
      const t = createTournament(size, 'open', 'You', 5, 42);
      expect(t.entrants).toHaveLength(size);
      expect(new Set(t.entrants.map((e) => e.name.toLowerCase())).size).toBe(size);
      runAll(t);
      expect(t.champion).not.toBeNull();
      expect(t.matches.every((m) => m.winner !== null)).toBe(true);
      // Everyone but the champion is out, and nobody lost more than twice.
      for (const e of t.entrants) {
        const losses = t.matches.filter((m) => m.players.includes(e.id) && m.winner !== e.id).length;
        if (e.id === t.champion) expect(losses).toBeLessThanOrEqual(1);
        else expect(isOut(t, e.id)).toBe(true);
        expect(losses).toBeLessThanOrEqual(2);
      }
      // Double elimination with a single grand final (no bracket reset): 2n − 2 matches.
      expect(t.matches).toHaveLength(2 * size - 2);
      const p = placement(t, t.champion!)!;
      expect(p.place).toBe(1);
      const places = t.entrants.map((e) => placement(t, e.id)!);
      expect(places.filter((x) => x.place === 2)).toHaveLength(1);
    });
  }

  it('stops at your matches and lets you play them', () => {
    const t = createTournament(8, 'rising', 'You', 3, 7);
    const m = playUntilYours(t)!;
    expect(m.players).toContain(t.you);
    // Earlier bot matches were played out.
    for (const x of t.matches.slice(0, t.matches.indexOf(m))) expect(x.winner).not.toBeNull();
  });
});

describe('kit draft', () => {
  it('bans, then picks, then a random decider from what is left', () => {
    const t = createTournament(4, 'open', 'You', 5, 3);
    const m = nextMatch(t)!;
    const d = startDraft(t, m);
    expect(draftStep(d)).toEqual({ team: 'A', kind: 'ban' });
    expect(draftChoose(d, 'sword')).toBe(true);
    expect(draftChoose(d, 'sword')).toBe(false); // already banned
    expect(draftChoose(d, 'axe')).toBe(true);
    expect(draftStep(d)).toEqual({ team: 'A', kind: 'pick' });
    draftChoose(d, 'crystal');
    draftChoose(d, 'mace');
    expect(draftStep(d)?.kind).toBe('decider');
    const dec = rollDecider(t, d);
    expect(['sword', 'axe', 'crystal', 'mace']).not.toContain(dec);
    expect(TOURNEY_KITS).toContain(dec);
    expect(draftStep(d)).toBeNull();
    expect([gameKit(d, 0), gameKit(d, 1), gameKit(d, 2)]).toEqual(['crystal', 'mace', dec]);
    expect(draftOpen(d)).toHaveLength(TOURNEY_KITS.length - 5);
  });

  it('a bot bans your best kit when it plays you', () => {
    const t = createTournament(4, 'open', 'You', 5, 11);
    const m = playUntilYours(t)!;
    const d = startDraft(t, m);
    const botIsA = m.players[d.teamA] !== t.you;
    if (!botIsA) draftChoose(d, 'sword18');
    const best = TOURNEY_KITS.filter((k) => k !== 'sword18');
    const bot = t.entrants[m.players.find((p) => p !== t.you)!];
    const choice = botChoice(t, m, best);
    expect(choice).toBe(best.find((k) => !bot.favs.includes(k)));
  });

  it('a match ends at two wins and moves both players on', () => {
    const t = createTournament(4, 'open', 'You', 5, 5);
    const m = nextMatch(t)!;
    const d = startDraft(t, m);
    for (const k of ['sword', 'axe', 'uhc', 'smp'] as const) draftChoose(d, k);
    rollDecider(t, d);
    recordGame(t, m, 0);
    recordGame(t, m, 1);
    expect(m.winner).toBeNull();
    recordGame(t, m, 1);
    expect(m.winner).toBe(m.players[1]);
    expect(matchById(t, m.next!.match).players[m.next!.slot]).toBe(m.players[1]);
    expect(matchById(t, m.drop!.match).players[m.drop!.slot]).toBe(m.players[0]);
    expect(m.games.map((g) => g.kit)).toEqual(['uhc', 'smp', d.decider]);
  });
});
