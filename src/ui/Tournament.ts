import { DIFFICULTIES } from '../ai/difficulty';
import { kitById, type KitId } from '../game/kits';
import {
  FIELDS,
  TOURNEY_KITS,
  TOURNEY_SIZES,
  botChoice,
  createTournament,
  draftChoose,
  draftOpen,
  draftStep,
  entrantColor,
  gameKit,
  isOut,
  isYours,
  loadTournament,
  nextMatch,
  placeLabel,
  placement,
  playUntilYours,
  rollDecider,
  roundName,
  saveTournament,
  simulateMatch,
  startDraft,
  teamSlot,
  type Entrant,
  type FieldId,
  type TMatch,
  type Tournament,
  type TourneySize,
} from '../game/tournament';
import { faceUrl } from './faces';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export interface TourneyCallbacks {
  onUiSound(): void;
  /** Plays game `n` of your current match: a duel in `kit` against `opponent`. */
  onPlayGame(kit: KitId, opponent: Entrant): void;
  /** Back to the title screen (the tournament is saved and can be resumed). */
  onLeave(): void;
  /** You won the whole thing (or not): for advancements. */
  onFinished(won: boolean, size: TourneySize): void;
  kitIcon(kit: KitId): CanvasImageSource | undefined;
  /** Your kits from best to worst (My Tiers): bots ban the first one. */
  yourBest(): KitId[];
  /** 0 = LT5 … 9 = HT1: your seed. */
  youRating(): number;
  playerName(): string;
}

/**
 * The tournament screens: setup, the bracket (upper, lower and the grand final, PvP Champs
 * style), and the kit selection — bans, picks and the decider — before and between games.
 */
export class TournamentUI {
  readonly root = h('div', { class: 'screen tourney' });
  t: Tournament | null = loadTournament();
  private size: TourneySize = 8;
  private field: FieldId = 'contender';
  /** Bumped on every render, so a pending bot move from an old screen does nothing. */
  private token = 0;

  constructor(parent: HTMLElement, private readonly cb: TourneyCallbacks) {
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  hide() {
    this.token++;
    this.root.style.display = 'none';
  }

  private open() {
    this.token++;
    this.root.style.display = '';
    this.root.replaceChildren();
  }

  private button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', { class: `mc-btn ${cls}` }, label);
    b.addEventListener('click', () => {
      this.cb.onUiSound();
      onClick();
    });
    return b;
  }

  private icon(kit: KitId | null, cls = ''): HTMLCanvasElement {
    const c = h('canvas', { width: '16', height: '16', class: `tc-icon ${cls}` });
    const src = kit ? this.cb.kitIcon(kit) : undefined;
    if (src) {
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(src, 0, 0, 16, 16);
    }
    return c;
  }

  private face(e: Entrant): HTMLImageElement {
    return h('img', { class: 'tb-face', src: e.tier ? faceUrl('bot', entrantColor(e)) : faceUrl('you'), alt: '' });
  }

  /** Where the tournament button leads: carry on with a saved one, or set up a new one. */
  showEntry() {
    if (this.t && this.t.champion === null) this.showBracket();
    else this.showSetup();
  }

  // ------------------------------------------------------------------ setup

  showSetup() {
    this.open();
    const panel = h('div', { class: 'menu-panel tourney-setup' });
    panel.append(h('div', { class: 'tc-title' }, 'Tournament'));
    panel.append(
      h(
        'div',
        { class: 'tiers-sub' },
        'Double elimination, PvP Champs style: lose once and you drop to the lower bracket, lose twice and you are out. Every match is a best of three — ban a kit, pick a kit, and the decider is drawn at random.',
      ),
    );
    panel.append(h('div', { class: 'section-title' }, 'Players'));
    const sizes = h('div', { class: 'btn-row' });
    for (const n of TOURNEY_SIZES) {
      sizes.append(this.button(String(n), () => {
        this.size = n;
        this.showSetup();
      }, this.size === n ? 'selected' : ''));
    }
    panel.append(sizes);
    panel.append(h('div', { class: 'section-title' }, 'Field'));
    const fields = h('div', { class: 'btn-row tourney-fields' });
    for (const [id, f] of Object.entries(FIELDS) as [FieldId, (typeof FIELDS)[FieldId]][]) {
      const b = this.button(f.name, () => {
        this.field = id;
        this.showSetup();
      }, this.field === id ? 'selected' : '');
      b.append(h('span', { class: 'tf-desc' }, f.desc));
      fields.append(b);
    }
    panel.append(fields);
    const kits = h('div', { class: 'tourney-pool' });
    for (const k of TOURNEY_KITS) {
      const chip = h('span', { class: 'tp-kit', title: kitById(k).name }, this.icon(k));
      kits.append(chip);
    }
    panel.append(h('div', { class: 'section-title' }, 'Kit pool'), kits);
    panel.append(
      this.button('Start Tournament', () => {
        this.t = createTournament(this.size, this.field, this.cb.playerName(), this.cb.youRating());
        saveTournament(this.t);
        this.showBracket();
      }, 'big start-btn'),
    );
    const row = h('div', { class: 'btn-row' });
    if (this.t && this.t.champion === null) row.append(this.button('Resume saved', () => this.showBracket()));
    row.append(this.button('Back', () => this.cb.onLeave()));
    panel.append(row);
    this.root.append(panel);
  }

  // ------------------------------------------------------------------ bracket

  showBracket() {
    const t = this.t;
    if (!t) return this.showSetup();
    this.open();
    const wrap = h('div', { class: 'tb-screen' });
    const head = h('div', { class: 'tb-head' }, h('div', { class: 'tc-title' }, 'Main Event'), h('div', { class: 'tb-meta' }, `${t.size} players · ${FIELDS[t.field].name} · best of 3`));
    wrap.append(head);

    const k = Math.log2(t.size);
    const cols = (side: 'upper' | 'lower', rounds: number) => {
      const sec = h('div', { class: `tb-section ${side}` }, h('div', { class: 'tb-side' }, side === 'upper' ? 'Upper Bracket' : 'Lower Bracket'));
      const grid = h('div', { class: 'tb-cols' });
      for (let r = 1; r <= rounds; r++) {
        const col = h('div', { class: 'tb-col' });
        const ms = t.matches.filter((m) => m.side === side && m.round === r);
        col.append(h('div', { class: 'tb-round' }, roundName(t, ms[0])));
        const list = h('div', { class: 'tb-list' });
        for (const m of ms) list.append(this.card(m));
        col.append(list);
        grid.append(col);
      }
      if (side === 'upper') {
        const gf = t.matches.find((m) => m.side === 'final')!;
        const col = h('div', { class: 'tb-col final' }, h('div', { class: 'tb-round' }, 'Grand Final'));
        col.append(h('div', { class: 'tb-list' }, this.card(gf)));
        grid.append(col);
      }
      sec.append(grid);
      return sec;
    };
    const scroller = h('div', { class: 'tb-scroll' }, cols('upper', k), cols('lower', 2 * (k - 1)));
    wrap.append(scroller);

    const foot = h('div', { class: 'tb-foot' });
    const next = nextMatch(t);
    if (t.champion !== null) {
      const champ = t.entrants[t.champion];
      const me = placement(t, t.you)!;
      foot.append(h('div', { class: 'tb-champ' }, `Champion: ${champ.name}`), h('div', { class: 'tb-place' }, champ.id === t.you ? 'You won the tournament!' : `You finished ${placeLabel(me)} of ${t.size}`));
      foot.append(
        h(
          'div',
          { class: 'btn-row' },
          this.button('New Tournament', () => {
            this.t = null;
            saveTournament(null);
            this.showSetup();
          }, 'big'),
          this.button('Title Screen', () => this.cb.onLeave()),
        ),
      );
    } else if (isOut(t, t.you)) {
      foot.append(h('div', { class: 'tb-place' }, `You're out — ${placeLabel(placement(t, t.you)!)}.`));
      foot.append(
        h(
          'div',
          { class: 'btn-row' },
          this.button('Finish the bracket', () => {
            for (let m = nextMatch(t); m; m = nextMatch(t)) simulateMatch(t, m);
            saveTournament(t);
            this.cb.onFinished(false, t.size);
            this.showBracket();
          }, 'big'),
          this.button('Title Screen', () => this.cb.onLeave()),
        ),
      );
    } else if (next) {
      const yours = isYours(t, next);
      const label = yours ? `Your match: ${roundName(t, next)}` : 'Play the bot matches up to yours';
      foot.append(
        h(
          'div',
          { class: 'btn-row' },
          this.button(yours ? 'To Kit Selection' : 'Continue', () => {
            const mine = playUntilYours(t);
            saveTournament(t);
            if (mine && yours) this.showDraft(mine);
            else this.showBracket();
          }, 'big start-btn'),
          this.button('Save & Quit', () => this.cb.onLeave()),
          this.button('Forfeit', () => {
            if (!confirm('Forfeit this tournament? It will be deleted.')) return;
            this.t = null;
            saveTournament(null);
            this.showSetup();
          }),
        ),
        h('div', { class: 'tb-hint' }, label),
      );
    }
    wrap.append(foot);
    this.root.append(wrap);
    // Bring your next match into view.
    requestAnimationFrame(() => this.root.querySelector('.tb-card.yours.live')?.scrollIntoView({ block: 'center', inline: 'center' }));
  }

  private card(m: TMatch): HTMLElement {
    const t = this.t!;
    // Only the match that's up next glows (many can be ready at once).
    const live = m === nextMatch(t);
    const card = h('div', { class: `tb-card${isYours(t, m) ? ' yours' : ''}${live ? ' live' : ''}${m.winner !== null ? ' done' : ''}` });
    for (const slot of [0, 1] as const) {
      const id = m.players[slot];
      const e = id === null ? null : t.entrants[id];
      const row = h('div', { class: `tb-row${m.winner !== null ? (m.winner === id ? ' won' : ' lost') : ''}${id === t.you ? ' you' : ''}` });
      if (e) row.append(this.face(e), h('span', { class: 'tb-name', title: e.tier ? `${DIFFICULTIES[e.tier].name} bot · seed ${e.seed}` : `You · seed ${e.seed}` }, e.name));
      else row.append(h('span', { class: 'tb-face empty' }), h('span', { class: 'tb-name tbd' }, 'TBD'));
      row.append(h('span', { class: 'tb-score' }, m.games.length || m.winner !== null ? String(m.wins[slot]) : ''));
      card.append(row);
    }
    return card;
  }

  // ------------------------------------------------------------------ kit selection

  /** The draft, then each game of the match from the same screen. */
  showDraft(m: TMatch) {
    const t = this.t!;
    const d = startDraft(t, m);
    this.open();
    const token = this.token;
    const A = t.entrants[m.players[teamSlot(d, 'A')]!];
    const B = t.entrants[m.players[teamSlot(d, 'B')]!];
    const youAre: 'A' | 'B' = A.id === t.you ? 'A' : 'B';
    const step = draftStep(d);
    const gameNo = m.games.length;
    const current = step ? null : gameKit(d, gameNo);

    const screen = h('div', { class: 'tc-screen' });
    screen.append(h('div', { class: 'tc-title big' }, 'Kit Selection'));
    const cards = h('div', { class: 'tc-cards' });
    const slot = (label: string, kit: KitId | null, kind: 'pick' | 'ban' | 'decider', active: boolean, game: number) => {
      const played = game >= 0 ? m.games[game] : undefined;
      const c = h('div', { class: `tc-card ${kind}${kit ? ' set' : ''}${active ? ' active' : ''}${current && kit === current && game === gameNo ? ' now' : ''}` });
      c.append(h('div', { class: 'tc-label' }, label));
      c.append(h('div', { class: 'tc-art' }, kit ? this.icon(kit) : kind === 'decider' ? h('span', { class: 'tc-q' }, '?') : h('span', { class: 'tc-q' }, '')));
      c.append(h('div', { class: 'tc-kit' }, kit ? kitById(kit).name : active ? (kind === 'ban' ? 'Banning…' : kind === 'pick' ? 'Picking…' : 'Drawing…') : ''));
      if (played) {
        const w = t.entrants[m.players[played.winner]!];
        c.append(h('div', { class: `tc-result${w.id === t.you ? ' you' : ''}` }, `${w.name} won`));
      }
      return c;
    };
    const is = (team: 'A' | 'B' | null, kind: string) => !!step && step.team === team && step.kind === kind;
    cards.append(
      slot('Team A Pick', d.picks[0], 'pick', is('A', 'pick'), 0),
      slot('Team B Pick', d.picks[1], 'pick', is('B', 'pick'), 1),
      slot('Team A Ban', d.bans[0], 'ban', is('A', 'ban'), -1),
      slot('Team B Ban', d.bans[1], 'ban', is('B', 'ban'), -1),
      slot('Decider Pick', d.decider, 'decider', !!step && step.kind === 'decider', 2),
    );
    screen.append(cards);

    // The versus plate: Team A on the left, Team B on the right, the round underneath.
    const side = (e: Entrant, cls: string) =>
      h('div', { class: `tc-side ${cls}` }, this.face(e), h('div', {}, h('div', { class: 'tc-name' }, e.name), h('div', { class: 'tc-seed' }, `Seed ${e.seed}${e.tier ? ` · ${DIFFICULTIES[e.tier].name}` : ''}`)));
    const score = m.games.length ? `${m.wins[teamSlot(d, 'A')]} – ${m.wins[teamSlot(d, 'B')]}` : 'VS';
    screen.append(
      h(
        'div',
        { class: 'tc-plate' },
        h('div', { class: 'tc-vs' }, side(A, 'a'), h('div', { class: 'tc-mid' }, score), side(B, 'b')),
        h('div', { class: 'tc-strip' }, h('span', {}, 'Team A'), h('span', {}, `Main Event – ${roundName(t, m)}`), h('span', {}, 'Team B')),
      ),
    );

    const actions = h('div', { class: 'tc-actions' });
    if (m.winner !== null) {
      const won = m.winner === t.you;
      actions.append(h('div', { class: `tc-say ${won ? 'win' : 'lose'}` }, won ? `You win the series ${m.wins[m.players.indexOf(t.you)]}–${m.wins[1 - m.players.indexOf(t.you)]}!` : `${t.entrants[m.winner].name} takes the series.`));
      actions.append(this.button('Back to the Bracket', () => {
        if (t.champion !== null) this.cb.onFinished(t.champion === t.you, t.size);
        this.showBracket();
      }, 'big start-btn'));
    } else if (step && step.kind === 'decider') {
      actions.append(h('div', { class: 'tc-say' }, 'Drawing the decider…'));
      this.spinDecider(cards.lastElementChild as HTMLElement, draftOpen(d), () => {
        if (token !== this.token) return;
        rollDecider(t, d);
        saveTournament(t);
        this.showDraft(m);
      });
    } else if (step && step.team === youAre) {
      actions.append(h('div', { class: 'tc-say' }, step.kind === 'ban' ? 'Your ban — take a kit away from them' : 'Your pick — game ' + (youAre === 'A' ? 1 : 2) + ' is played on it'));
      const grid = h('div', { class: 'tc-pool' });
      for (const k of TOURNEY_KITS) {
        const open = draftOpen(d).includes(k);
        const b = h('button', { class: `tc-choice ${step.kind}${open ? '' : ' gone'}` }, this.icon(k), h('span', {}, kitById(k).name));
        if (open)
          b.addEventListener('click', () => {
            this.cb.onUiSound();
            if (draftChoose(d, k)) {
              saveTournament(t);
              this.showDraft(m);
            }
          });
        else b.disabled = true;
        grid.append(b);
      }
      actions.append(grid);
    } else if (step) {
      const bot = step.team === 'A' ? A : B;
      actions.append(h('div', { class: 'tc-say' }, `${bot.name} is ${step.kind === 'ban' ? 'banning' : 'picking'}…`));
      setTimeout(() => {
        if (token !== this.token) return;
        draftChoose(d, botChoice(t, m, this.cb.yourBest()));
        saveTournament(t);
        this.showDraft(m);
      }, 1100);
    } else {
      const kit = current!;
      actions.append(h('div', { class: 'tc-say' }, `Game ${gameNo + 1}${gameNo === 2 ? ' (decider)' : ''}: ${kitById(kit).name}`));
      const opp = t.entrants[m.players[m.players[0] === t.you ? 1 : 0]!];
      actions.append(
        h(
          'div',
          { class: 'btn-row' },
          this.button(`Play Game ${gameNo + 1}`, () => this.cb.onPlayGame(kit, opp), 'big start-btn'),
          this.button('Bracket', () => this.showBracket()),
        ),
      );
    }
    screen.append(actions);
    this.root.append(screen);
  }

  /** The decider card flicks through the kits that are left, then lands. */
  private spinDecider(card: HTMLElement, pool: KitId[], done: () => void) {
    const art = card.querySelector('.tc-art')!;
    let i = 0;
    const token = this.token;
    const step = () => {
      if (token !== this.token) return;
      art.replaceChildren(this.icon(pool[i++ % pool.length]));
      if (i < 14) setTimeout(step, 60 + i * 12);
      else setTimeout(done, 250);
    };
    step();
  }

  /** After a game: your match screen again (the result is already recorded). */
  showMatch() {
    const t = this.t;
    if (!t) return this.showSetup();
    const mine = t.matches.filter((m) => isYours(t, m) && m.draft);
    const m = mine[mine.length - 1];
    if (m) this.showDraft(m);
    else this.showBracket();
  }
}
