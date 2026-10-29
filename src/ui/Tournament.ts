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
import type { TourView } from '../net/tourney';

/** What the online tournament screens can ask the host for. */
export interface OnlineTourActions {
  start(): void;
  draft(kit: KitId): void;
  leave(): void;
}

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
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  /** The whole bracket: upper rounds and the grand final on top, the lower rounds underneath. */
  private bracketBoard(t: Tournament, live: string | null = nextMatch(t)?.id ?? null): HTMLElement {
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
        for (const m of ms) list.append(this.card(t, m, live));
        col.append(list);
        grid.append(col);
      }
      if (side === 'upper') {
        const gf = t.matches.find((m) => m.side === 'final')!;
        const col = h('div', { class: 'tb-col final' }, h('div', { class: 'tb-round' }, 'Grand Final'));
        col.append(h('div', { class: 'tb-list' }, this.card(t, gf, live)));
        grid.append(col);
      }
      sec.append(grid);
      return sec;
    };
    wrap.append(h('div', { class: 'tb-scroll' }, cols('upper', k), cols('lower', 2 * (k - 1))));
    return wrap;
  }

  showBracket() {
    const t = this.t;
    if (!t) return this.showSetup();
    this.open();
    const wrap = this.bracketBoard(t);

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

  private card(t: Tournament, m: TMatch, liveId: string | null): HTMLElement {
    // Only the match that's up next glows (many can be ready at once).
    const live = m.id === liveId;
    const card = h('div', { class: `tb-card${isYours(t, m) ? ' yours' : ''}${live ? ' live' : ''}${m.winner !== null ? ' done' : ''}` });
    for (const slot of [0, 1] as const) {
      const id = m.players[slot];
      const e = id === null ? null : t.entrants[id];
      const row = h('div', { class: `tb-row${m.winner !== null ? (m.winner === id ? ' won' : ' lost') : ''}${id === t.you ? ' you' : ''}` });
      if (e) row.append(this.face(e), h('span', { class: 'tb-name', title: e.tier ? `${DIFFICULTIES[e.tier].name} bot · seed ${e.seed}` : `${e.id === t.you ? 'You' : 'Player'} · seed ${e.seed}` }, e.name));
      else row.append(h('span', { class: 'tb-face empty' }), h('span', { class: 'tb-name tbd' }, 'TBD'));
      row.append(h('span', { class: 'tb-score' }, m.games.length || m.winner !== null ? String(m.wins[slot]) : ''));
      card.append(row);
    }
    return card;
  }

  // ------------------------------------------------------------------ kit selection

  /** The Kit Selection board for a match: the five cards and the versus plate. */
  private draftBoard(t: Tournament, m: TMatch): { screen: HTMLElement; cards: HTMLElement } {
    const d = m.draft!;
    const A = t.entrants[m.players[teamSlot(d, 'A')]!];
    const B = t.entrants[m.players[teamSlot(d, 'B')]!];
    const step = draftStep(d);
    const gameNo = m.games.length;
    const current = step ? null : gameKit(d, gameNo);
    const screen = h('div', { class: 'tc-screen' });
    screen.append(h('div', { class: 'tc-title big' }, 'Kit Selection'));
    const cards = h('div', { class: 'tc-cards' });
    const slot = (label: string, kit: KitId | null, kind: 'pick' | 'ban' | 'decider', active: boolean, game: number) => {
      const played = game >= 0 ? m.games[game] : undefined;
      const c = h('div', { class: `tc-card ${kind}${kit ? ' set' : ''}${active ? ' active' : ''}${current && kit === current && game === gameNo && m.winner === null ? ' now' : ''}` });
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
    return { screen, cards };
  }

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

    const { screen, cards } = this.draftBoard(t, m);

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

  // ------------------------------------------------------------------ online

  /** The latest online view, so a re-render (e.g. Bracket ↔ Live) needs no message. */
  private online: { view: TourView; code: string; act: OnlineTourActions } | null = null;
  /** Watching the bracket instead of the live match. */
  private onlineBracket = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Online: what the host just sent — the room before it starts, then the live match or the bracket. */
  showOnline(view: TourView, code: string, act: OnlineTourActions) {
    this.online = { view, code, act };
    this.renderOnline();
  }

  /** Leaves online mode (the connection closed or you left). */
  clearOnline() {
    this.online = null;
    this.onlineBracket = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private renderOnline() {
    const o = this.online;
    if (!o) return;
    const { view, act } = o;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.open();
    const me = view.tour?.entrants.find((e) => e.pid === view.you);
    // Your own copy, seen from your seat (highlights, "You won").
    const t = view.tour ? { ...view.tour, you: me?.id ?? -1 } : null;
    if (!t) return this.onlineLobby(view, o.code, act);

    const live = view.live;
    const m = live ? t.matches.find((x) => x.id === live.match) ?? null : null;
    if (m && m.draft && !this.onlineBracket && t.champion === null) {
      const { screen } = this.draftBoard(t, m);
      const actions = h('div', { class: 'tc-actions' });
      const d = m.draft;
      const step = draftStep(d);
      const turn = step && step.kind !== 'decider' ? t.entrants[m.players[teamSlot(d, step.team)]!] : null;
      const timer = (text: string) => this.countdown(text, view.live!.deadlineMs);
      if (live!.stage === 'done') {
        const w = t.entrants[m.winner!];
        actions.append(h('div', { class: `tc-say${me ? (w.id === me.id ? ' win' : m.players.includes(me.id) ? ' lose' : '') : ''}` }, `${w.name} takes the series ${Math.max(...m.wins)}–${Math.min(...m.wins)}`));
      } else if (live!.stage === 'draft' && turn && me && turn.id === me.id) {
        actions.append(timer(step!.kind === 'ban' ? 'Your ban — take a kit away from them' : `Your pick — game ${step!.team === 'A' ? 1 : 2} is played on it`));
        const grid = h('div', { class: 'tc-pool' });
        for (const k of TOURNEY_KITS) {
          const open = draftOpen(d).includes(k);
          const b = h('button', { class: `tc-choice ${step!.kind}${open ? '' : ' gone'}` }, this.icon(k), h('span', {}, kitById(k).name));
          if (open)
            b.addEventListener('click', () => {
              this.cb.onUiSound();
              grid.querySelectorAll('button').forEach((x) => (x.disabled = true));
              act.draft(k);
            });
          else b.disabled = true;
          grid.append(b);
        }
        actions.append(grid);
      } else if (live!.stage === 'draft' && turn) {
        actions.append(timer(`${turn.name} is ${step!.kind === 'ban' ? 'banning' : 'picking'}…`));
      } else {
        const kit = gameKit(d, m.games.length);
        const name = kit ? kitById(kit).name : '';
        const playing = me && m.players.includes(me.id);
        if (live!.stage === 'break') actions.append(timer(`Game ${m.games.length + 1}${m.games.length === 2 ? ' (decider)' : ''}: ${name} — ${playing ? 'get ready' : 'starting'}`));
        else actions.append(h('div', { class: 'tc-say' }, `Game ${m.games.length + 1} live: ${name}${live!.pve ? '' : ' — player vs player'}`));
      }
      actions.append(h('div', { class: 'btn-row' }, this.button('Bracket', () => {
        this.onlineBracket = true;
        this.renderOnline();
      }), this.button('Leave', () => act.leave())));
      screen.append(actions);
      this.root.append(screen);
      return;
    }

    const wrap = this.bracketBoard(t, live?.match ?? null);
    const foot = h('div', { class: 'tb-foot' });
    if (t.champion !== null) {
      const champ = t.entrants[t.champion];
      foot.append(h('div', { class: 'tb-champ' }, `Champion: ${champ.name}`));
      if (me) foot.append(h('div', { class: 'tb-place' }, champ.id === me.id ? 'You won the tournament!' : `You finished ${placeLabel(placement(t, me.id)!)} of ${t.size}`));
    } else if (me && isOut(t, me.id)) {
      foot.append(h('div', { class: 'tb-place' }, `You're out (${placeLabel(placement(t, me.id)!)}) — watch the rest.`));
    } else if (live && m) {
      foot.append(h('div', { class: 'tb-hint' }, `Now: ${roundName(t, m)} — ${t.entrants[m.players[0]!].name} vs ${t.entrants[m.players[1]!].name}`));
    }
    const row = h('div', { class: 'btn-row' });
    if (live && t.champion === null)
      row.append(this.button('Live match', () => {
        this.onlineBracket = false;
        this.renderOnline();
      }, 'big start-btn'));
    row.append(this.button('Leave', () => act.leave()));
    foot.append(row);
    wrap.append(foot);
    this.root.append(wrap);
    requestAnimationFrame(() => this.root.querySelector('.tb-card.live')?.scrollIntoView({ block: 'center', inline: 'center' }));
  }

  private onlineLobby(view: TourView, code: string, act: OnlineTourActions) {
    const panel = h('div', { class: 'menu-panel tourney-setup' });
    panel.append(h('div', { class: 'tc-title' }, 'Online Tournament'));
    panel.append(h('div', { class: 'tourney-code' }, h('span', {}, 'Code'), h('b', {}, code)));
    panel.append(h('div', { class: 'tiers-sub' }, `${view.size} places · ${FIELDS[view.field].name} (${FIELDS[view.field].desc}) · bots fill the empty places. Friends join with the code from Multiplayer → Join.`));
    panel.append(h('div', { class: 'section-title' }, `Players (${view.members.length})`));
    const list = h('div', { class: 'tourney-members' });
    for (const m of view.members) {
      list.append(h('div', { class: `tm-row${m.pid === view.you ? ' you' : ''}` }, h('img', { class: 'tb-face', src: faceUrl('you'), alt: '' }), h('span', {}, m.name), m.pid === view.host ? h('span', { class: 'tm-host' }, 'HOST') : ''));
    }
    panel.append(list);
    const row = h('div', { class: 'btn-row' });
    if (view.host === view.you) row.append(this.button('Start Tournament', () => act.start(), 'big start-btn'));
    else row.append(h('div', { class: 'tb-hint' }, 'Waiting for the host to start…'));
    row.append(this.button('Leave', () => act.leave()));
    panel.append(row);
    this.root.append(panel);
  }

  /** A line with the seconds left on it, ticking down. */
  private countdown(text: string, ms: number | null): HTMLElement {
    const el = h('div', { class: 'tc-say' }, text);
    if (ms === null) return el;
    const end = performance.now() + ms;
    const tag = h('span', { class: 'tc-timer' });
    el.append(' ', tag);
    const paint = () => (tag.textContent = `${Math.max(0, Math.ceil((end - performance.now()) / 1000))}s`);
    paint();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(paint, 250);
    return el;
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
