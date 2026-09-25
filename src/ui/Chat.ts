import type { ChatLine } from '../commands/host';

/** Chat look, from Settings → Chat. */
export interface ChatOptions {
  /** 'shown', 'commands' (command feedback and system lines only) or 'hidden'. */
  visibility: 'shown' | 'commands' | 'hidden';
  textOpacity: number;
  backgroundOpacity: number;
  scale: number;
  /** Width in GUI pixels (vanilla: 40–320, default 320). */
  width: number;
}

export interface ChatCallbacks {
  /** Enter was pressed with this text (commands keep their leading slash). */
  onSubmit(text: string): void;
  /** Completions for the text up to the caret. */
  suggest(text: string): { start: number; list: string[]; usage?: string[] };
  onClose(): void;
}

interface Entry {
  line: ChatLine;
  /** performance.now() when added. */
  at: number;
  el: HTMLDivElement;
  /** A command feedback / system line (kept when chat is set to "commands only"). */
  system: boolean;
}

const MAX_LINES = 100;
const VISIBLE_MS = 10_000; // vanilla: 200 ticks
const FADE_MS = 1_000;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/**
 * Vanilla-style chat: messages fade 10 s after they arrive, T opens it (with the full history
 * and a text box), / opens it with a slash. Tab cycles command suggestions, ↑/↓ recall what you
 * sent, the wheel scrolls.
 */
export class Chat {
  readonly root: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private readonly inputRow: HTMLDivElement;
  private readonly input: HTMLInputElement;
  private readonly suggestBox: HTMLDivElement;
  private readonly usageEl: HTMLDivElement;
  private readonly entries: Entry[] = [];
  private readonly sent: string[] = [];
  private historyIndex = -1;
  private draft = '';
  private suggestions: string[] = [];
  private suggestStart = 0;
  private selected = -1;
  /** The text before Tab started cycling (so cycling doesn't feed on itself). */
  private cycleBase: string | null = null;
  open = false;
  options: ChatOptions = { visibility: 'shown', textOpacity: 1, backgroundOpacity: 0.5, scale: 1, width: 320 };

  constructor(
    parent: HTMLElement,
    private readonly cb: ChatCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'chat';
    this.log = document.createElement('div');
    this.log.className = 'chat-log';
    this.root.appendChild(this.log);
    this.suggestBox = document.createElement('div');
    this.suggestBox.className = 'chat-suggest';
    this.usageEl = document.createElement('div');
    this.usageEl.className = 'chat-usage';
    this.inputRow = document.createElement('div');
    this.inputRow.className = 'chat-input-row';
    this.input = document.createElement('input');
    this.input.className = 'chat-input';
    this.input.type = 'text';
    this.input.maxLength = 256;
    this.input.spellcheck = false;
    this.input.autocomplete = 'off';
    this.inputRow.append(this.input);
    this.root.append(this.suggestBox, this.usageEl, this.inputRow);
    parent.appendChild(this.root);

    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('input', () => {
      this.cycleBase = null;
      this.historyIndex = -1;
      this.refreshSuggestions();
    });
    this.log.addEventListener(
      'wheel',
      (e) => {
        if (!this.open) return;
        this.log.scrollTop += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    this.setOpen(false);
  }

  /** Adds a line. `system` lines are command feedback, errors and game messages. */
  print(line: ChatLine, system = true) {
    const el = document.createElement('div');
    el.className = 'chat-line';
    // Text sits in its own span so text and background opacity can differ (Options → Chat).
    el.innerHTML = '<span class="chat-text">' + line
      .map((p) => {
        const style = [p.c ? `color:${p.c}` : '', p.b ? 'font-weight:700' : '', p.i ? 'font-style:italic' : '', p.u ? 'text-decoration:underline' : ''].filter(Boolean).join(';');
        return style ? `<span style="${style}">${esc(p.t)}</span>` : esc(p.t);
      })
      .join('') + '</span>';
    this.log.appendChild(el);
    this.entries.push({ line, at: performance.now(), el, system });
    while (this.entries.length > MAX_LINES) this.entries.shift()!.el.remove();
    if (this.open) this.log.scrollTop = this.log.scrollHeight;
    this.update(performance.now());
  }

  clear() {
    for (const e of this.entries) e.el.remove();
    this.entries.length = 0;
  }

  /** Opens the chat box, optionally pre-filled (the command key starts it with "/"). */
  show(prefill = '') {
    this.setOpen(true);
    this.input.value = prefill;
    this.historyIndex = -1;
    this.cycleBase = null;
    this.refreshSuggestions();
    // Focus after the key that opened chat has been handled, or it would be typed into the box.
    setTimeout(() => {
      this.input.focus();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }, 0);
    this.log.scrollTop = this.log.scrollHeight;
  }

  hide() {
    if (!this.open) return;
    this.setOpen(false);
    this.input.blur();
    this.cb.onClose();
  }

  private setOpen(v: boolean) {
    this.open = v;
    this.root.classList.toggle('open', v);
    this.inputRow.style.display = v ? '' : 'none';
    if (!v) {
      this.suggestBox.style.display = 'none';
      this.usageEl.style.display = 'none';
    }
    this.update(performance.now());
  }

  applyOptions(o: ChatOptions) {
    this.options = o;
    this.root.style.setProperty('--chat-scale', String(o.scale));
    this.root.style.setProperty('--chat-width', `${o.width}px`);
    this.root.style.setProperty('--chat-bg', String(o.backgroundOpacity));
    this.root.style.setProperty('--chat-text', String(o.textOpacity));
    this.update(performance.now());
  }

  /** Fades lines out (called every frame; cheap when nothing changes). */
  update(now: number) {
    const vis = this.options.visibility;
    for (const e of this.entries) {
      const allowed = vis === 'shown' || (vis === 'commands' && e.system);
      let a: number;
      if (!allowed) a = 0;
      else if (this.open) a = 1;
      else {
        const age = now - e.at;
        a = age >= VISIBLE_MS ? 0 : age > VISIBLE_MS - FADE_MS ? (VISIBLE_MS - age) / FADE_MS : 1;
      }
      const s = a <= 0 ? 'none' : '';
      if (e.el.style.display !== s) e.el.style.display = s;
      const o = a.toFixed(2);
      if (a > 0 && e.el.style.opacity !== o) e.el.style.opacity = o;
    }
  }

  private onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.hide();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = this.input.value.trim();
      this.hide();
      if (text) {
        if (this.sent[this.sent.length - 1] !== text) this.sent.push(text);
        if (this.sent.length > 100) this.sent.shift();
        this.cb.onSubmit(text);
      }
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      this.cycle(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      // With suggestions showing, arrows pick one; otherwise they walk the history.
      if (this.suggestions.length > 1 && this.cycleBase !== null) {
        this.cycle(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      this.recall(e.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      this.log.scrollTop += (e.key === 'PageUp' ? -1 : 1) * this.log.clientHeight * 0.8;
    }
  }

  private recall(dir: number) {
    if (!this.sent.length) return;
    if (this.historyIndex === -1) {
      if (dir > 0) return;
      this.draft = this.input.value;
      this.historyIndex = this.sent.length;
    }
    this.historyIndex = Math.max(0, Math.min(this.sent.length, this.historyIndex + dir));
    this.input.value = this.historyIndex >= this.sent.length ? this.draft : this.sent[this.historyIndex];
    if (this.historyIndex >= this.sent.length) this.historyIndex = -1;
    this.cycleBase = null;
    this.refreshSuggestions();
  }

  /** Tab: completes the word under the caret with the next suggestion. */
  private cycle(dir: number) {
    if (this.cycleBase === null) {
      this.cycleBase = this.input.value;
      this.refreshSuggestions();
      if (!this.suggestions.length) {
        this.cycleBase = null;
        return;
      }
      this.selected = dir > 0 ? 0 : this.suggestions.length - 1;
    } else {
      if (!this.suggestions.length) return;
      this.selected = (this.selected + dir + this.suggestions.length) % this.suggestions.length;
    }
    const base = this.cycleBase;
    const pick = this.suggestions[this.selected];
    this.input.value = base.slice(0, this.suggestStart) + pick;
    this.renderSuggestions();
  }

  private refreshSuggestions() {
    const text = this.cycleBase ?? this.input.value;
    if (!text.startsWith('/')) {
      this.suggestions = [];
      this.suggestBox.style.display = 'none';
      this.usageEl.style.display = 'none';
      return;
    }
    const res = this.cb.suggest(text.slice(1));
    this.suggestStart = res.start + 1;
    const typed = text.slice(this.suggestStart);
    // Hide the lone suggestion that is exactly what is already typed.
    this.suggestions = res.list.filter((s) => s !== typed).slice(0, 60);
    if (this.cycleBase === null) this.selected = -1;
    this.renderSuggestions();
    const usage = !this.suggestions.length ? (res.usage ?? []) : [];
    this.usageEl.textContent = usage.join('\n');
    this.usageEl.style.display = usage.length ? '' : 'none';
  }

  private renderSuggestions() {
    if (!this.suggestions.length) {
      this.suggestBox.style.display = 'none';
      return;
    }
    // Show a window of 10 around the selection, like vanilla.
    const n = this.suggestions.length;
    const sel = Math.max(0, this.selected);
    const first = Math.max(0, Math.min(sel - 4, n - 10));
    const shown = this.suggestions.slice(first, first + 10);
    this.suggestBox.innerHTML = shown
      .map((s, k) => `<div class="${first + k === this.selected ? 'sel' : ''}">${esc(s)}</div>`)
      .join('') + (n > 10 ? `<div class="more">${n} matches — Tab to cycle</div>` : '');
    // Line the box up under the word being completed.
    this.suggestBox.style.left = `${this.textX(this.input.value.slice(0, this.suggestStart))}px`;
    this.suggestBox.style.display = '';
  }

  private measure: CanvasRenderingContext2D | null = null;

  /** Screen x where `text` (typed into the box) ends. */
  private textX(text: string): number {
    this.measure ??= document.createElement('canvas').getContext('2d');
    const cs = getComputedStyle(this.input);
    const r = this.input.getBoundingClientRect();
    let w = 0;
    if (this.measure) {
      this.measure.font = cs.font;
      w = this.measure.measureText(text).width;
    }
    return r.left + parseFloat(cs.paddingLeft || '0') + w - this.input.scrollLeft;
  }
}
