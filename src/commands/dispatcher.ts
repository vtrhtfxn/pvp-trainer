/**
 * A small Brigadier: commands are trees of literals and typed arguments. The same tree parses
 * and runs input, suggests completions for the word being typed (Tab), and prints usage.
 * Errors carry the cursor position, so chat can show vanilla's "…text<--[HERE]" line.
 */

export class CommandError extends Error {
  constructor(
    message: string,
    /** Where in the input it went wrong (for the <--[HERE] marker); -1 = don't show. */
    readonly cursor = -1,
  ) {
    super(message);
  }
}

/** Reads the command line left to right. */
export class Reader {
  constructor(
    readonly s: string,
    public i = 0,
  ) {}
  canRead(n = 1): boolean {
    return this.i + n <= this.s.length;
  }
  peek(): string {
    return this.s[this.i] ?? '';
  }
  get rest(): string {
    return this.s.slice(this.i);
  }
  atEnd(): boolean {
    return this.i >= this.s.length;
  }
  skipSpaces() {
    while (this.peek() === ' ') this.i++;
  }
  /**
   * One argument: up to the next space outside brackets and quotes, so
   * `diamond_sword[enchantments={sharpness:5}]` and `"two words"` stay whole.
   */
  readToken(): string {
    const start = this.i;
    let depth = 0;
    let quote = '';
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (quote) {
        if (c === '\\') this.i++;
        else if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
      else if (c === ' ' && depth === 0) break;
      this.i++;
    }
    return this.s.slice(start, this.i);
  }
  error(message: string, at = this.i): CommandError {
    return new CommandError(message, at);
  }
}

export interface ArgType<T = unknown, C = unknown> {
  parse(r: Reader, ctx: C): T;
  /** Completions for the word being typed (already filtered by the caller). */
  suggest?(ctx: C): string[];
  /** Takes the rest of the line (messages). */
  greedy?: boolean;
}

export type Args = Record<string, unknown>;
export type Run<C> = (ctx: C, args: Args) => number | void;

export interface CommandNode<C> {
  kind: 'literal' | 'argument';
  name: string;
  type?: ArgType<unknown, C>;
  children: CommandNode<C>[];
  run?: Run<C>;
  /** Only offered/usable when this returns true (e.g. offline-only commands). */
  requires?: (ctx: C) => boolean;
}

/** Tiny builder: lit('tick', lit('freeze').runs(...), …). */
export class NodeBuilder<C> {
  readonly node: CommandNode<C>;
  constructor(kind: 'literal' | 'argument', name: string, type?: ArgType<unknown, C>) {
    this.node = { kind, name, type, children: [] };
  }
  then(...children: (NodeBuilder<C> | CommandNode<C>)[]): this {
    for (const c of children) this.node.children.push(c instanceof NodeBuilder ? c.node : c);
    return this;
  }
  runs(fn: Run<C>): this {
    this.node.run = fn;
    return this;
  }
  requires(fn: (ctx: C) => boolean): this {
    this.node.requires = fn;
    return this;
  }
}

export function lit<C>(name: string, ...children: (NodeBuilder<C> | CommandNode<C>)[]): NodeBuilder<C> {
  return new NodeBuilder<C>('literal', name).then(...children);
}
export function arg<C, T>(name: string, type: ArgType<T, C>, ...children: (NodeBuilder<C> | CommandNode<C>)[]): NodeBuilder<C> {
  return new NodeBuilder<C>('argument', name, type as ArgType<unknown, C>).then(...children);
}

export interface Suggestions {
  /** Where the replaced word starts. */
  start: number;
  list: string[];
}

interface ParseState<C> {
  node: CommandNode<C>;
  args: Args;
  /** Deepest failure seen, for the error message. */
  error: CommandError | null;
}

export class Dispatcher<C> {
  readonly roots = new Map<string, CommandNode<C>>();
  /** One-line help per command (shown by /help). */
  readonly help = new Map<string, string>();
  readonly aliases = new Map<string, string>();

  register(b: NodeBuilder<C>, help: string, aliases: string[] = []) {
    this.roots.set(b.node.name, b.node);
    this.help.set(b.node.name, help);
    for (const a of aliases) this.aliases.set(a, b.node.name);
  }

  root(name: string): CommandNode<C> | undefined {
    return this.roots.get(name) ?? this.roots.get(this.aliases.get(name) ?? '');
  }

  /**
   * Parses and runs `line` (without the leading slash). Returns the command's result; throws a
   * CommandError the chat turns into red text.
   */
  execute(line: string, ctx: C): number {
    const r = new Reader(line);
    const name = r.readToken();
    const root = this.root(name.toLowerCase());
    if (!root || (root.requires && !root.requires(ctx))) {
      throw new CommandError('Unknown or incomplete command, see below for error', line.length ? r.i : 0);
    }
    const st: ParseState<C> = { node: root, args: {}, error: null };
    const done = this.walk(r, root, ctx, st);
    if (!done) {
      if (st.error) throw st.error;
      throw new CommandError('Unknown or incomplete command, see below for error', r.i);
    }
    const res = done.node.run!(ctx, done.args);
    return typeof res === 'number' ? res : 1;
  }

  /** Depth-first over the tree: literals before arguments, backtracking on failure. */
  private walk(r: Reader, node: CommandNode<C>, ctx: C, st: ParseState<C>): { node: CommandNode<C>; args: Args } | null {
    const start = r.i;
    r.skipSpaces();
    if (r.atEnd()) {
      if (node.run) return { node, args: { ...st.args } };
      return null;
    }
    if (r.i === start && start > 0) {
      st.error = r.error('Expected whitespace to end one argument, but found trailing data');
      return null;
    }
    const kids = [...node.children].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'literal' ? -1 : 1));
    for (const child of kids) {
      if (child.requires && !child.requires(ctx)) continue;
      const at = r.i;
      if (child.kind === 'literal') {
        const word = new Reader(r.s, r.i).readToken();
        if (word.toLowerCase() !== child.name) continue;
        r.i += word.length;
        const res = this.walk(r, child, ctx, st);
        if (res) return res;
        r.i = at;
        continue;
      }
      try {
        const value = child.type!.parse(r, ctx);
        if (!r.atEnd() && r.peek() !== ' ' && !child.type!.greedy) {
          throw r.error('Expected whitespace to end one argument, but found trailing data');
        }
        const saved = st.args[child.name];
        st.args[child.name] = value;
        const res = this.walk(r, child, ctx, st);
        if (res) return res;
        st.args[child.name] = saved;
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
        if (!st.error || e.cursor >= st.error.cursor) st.error = e;
      }
      r.i = at;
    }
    if (!st.error) {
      st.error = node.children.length
        ? r.error(`Incorrect argument for command`)
        : r.error('Incorrect argument for command');
    }
    return null;
  }

  /** Completions for the last word of `line` (without the slash). */
  suggest(line: string, ctx: C): Suggestions {
    const r = new Reader(line);
    const firstEnd = line.indexOf(' ');
    if (firstEnd < 0) {
      const prefix = line.toLowerCase();
      const names = [...this.roots.values()].filter((n) => !n.requires || n.requires(ctx)).map((n) => n.name);
      return { start: 0, list: names.filter((n) => n.startsWith(prefix)).sort() };
    }
    const root = this.root(r.readToken().toLowerCase());
    if (!root) return { start: line.length, list: [] };
    const out = new Set<string>();
    let start = line.length;
    // Walk every path that fully parses up to the last word, and collect what may come next.
    const visit = (node: CommandNode<C>, pos: number, args: Args) => {
      const rr = new Reader(line, pos);
      if (rr.peek() !== ' ') return;
      rr.skipSpaces();
      const wordStart = rr.i;
      for (const child of node.children) {
        if (child.requires && !child.requires(ctx)) continue;
        const probe = new Reader(line, wordStart);
        if (child.kind === 'literal') {
          const word = probe.readToken();
          if (probe.atEnd()) {
            if (child.name.startsWith(word.toLowerCase())) {
              out.add(child.name);
              start = wordStart;
            }
          } else if (word.toLowerCase() === child.name) visit(child, probe.i, args);
          continue;
        }
        const type = child.type!;
        // Suggest for the word being typed.
        const partial = line.slice(wordStart);
        if (!partial.includes(' ') || type.greedy) {
          for (const s of type.suggest?.(ctx) ?? []) {
            if (matchesPrefix(s, partial)) {
              out.add(s);
              start = wordStart;
            }
          }
        }
        // Or step over a complete argument into its children.
        try {
          const v = type.parse(probe, ctx);
          if (!probe.atEnd() && probe.peek() === ' ') visit(child, probe.i, { ...args, [child.name]: v });
        } catch {
          /* incomplete */
        }
      }
    };
    visit(root, r.i, {});
    return { start, list: [...out].sort((a, b) => a.localeCompare(b)) };
  }

  /** Brigadier's smart usage: "(a|b|c)", "<arg>", "[<optional>]". */
  usage(name: string, ctx: C): string[] {
    const root = this.root(name);
    if (!root) return [];
    const lines: string[] = [];
    const one = (n: CommandNode<C>, depth: number): string => {
      const self = n.kind === 'literal' ? n.name : `<${n.name}>`;
      const kids = n.children.filter((c) => !c.requires || c.requires(ctx));
      if (!kids.length || depth > 3) return self;
      const inner = kids.length === 1 ? one(kids[0], depth + 1) : `(${kids.map((k) => (k.kind === 'literal' ? k.name : `<${k.name}>`)).join('|')})`;
      return n.run ? `${self} [${inner}]` : `${self} ${inner}`;
    };
    const kids = root.children.filter((c) => !c.requires || c.requires(ctx));
    if (!kids.length || root.run) lines.push(`/${root.name}${kids.length ? ` [${kids.map((k) => one(k, 1)).join('|')}]` : ''}`);
    else for (const k of kids) lines.push(`/${root.name} ${one(k, 1)}`);
    return lines;
  }
}

/** "minecraft:speed" and "speed" both match what the user typed, like vanilla resource suggestions. */
export function matchesPrefix(candidate: string, typed: string): boolean {
  const t = typed.toLowerCase();
  const c = candidate.toLowerCase();
  if (c.startsWith(t)) return true;
  const colon = c.indexOf(':');
  return colon >= 0 && c.slice(colon + 1).startsWith(t);
}
