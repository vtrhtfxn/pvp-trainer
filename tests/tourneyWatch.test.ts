import { describe, expect, it } from 'vitest';
import { createTournament, nextBotMatch, simulateMatch } from '../src/game/tournament';
import { TourneyWatch, playBotGame } from '../src/game/TourneyWatch';

describe('tournament bot matches are real games', () => {
  it('a bot match is decided by real duels between the two bots', () => {
    const t = createTournament(4, 'contender', 'You', 4, 12345);
    const m = nextBotMatch(t)!;
    simulateMatch(t, m, playBotGame);
    expect(m.winner).not.toBeNull();
    expect(Math.max(...m.wins)).toBe(2);
    expect(m.games.length).toBeGreaterThanOrEqual(2);
    // Every game was played on the drafted kits, in order.
    expect(m.games[0].kit).toBe(m.draft!.picks[0]);
  }, 120_000);

  it('watching one plays it game by game into the bracket', () => {
    const t = createTournament(4, 'rising', 'You', 4, 777);
    const m = nextBotMatch(t)!;
    const w = new TourneyWatch(t, m);
    const info = w.broadcast();
    expect(info.game).toBe(1);
    expect(info.pickedBy).toMatch(/Pick$/);
    let games = 0;
    for (let i = 0; i < 20 * 60 * 10 && !w.finished; i++) {
      if (w.tick()) games++;
      w.match.world.events.length = 0;
      w.match.player.events.length = 0;
      w.match.bot.events.length = 0;
    }
    expect(w.finished).toBe(true);
    expect(m.winner).not.toBeNull();
    expect(m.games.length).toBe(games + 1);
  }, 120_000);
});
