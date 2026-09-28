import type { DrillRun } from '../trainer/drills';

/** The Trainer's live panel: the drill, progress, streak and feedback on every attempt. */
export class DrillHud {
  readonly root: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly progress: HTMLDivElement;
  private readonly tip: HTMLDivElement;
  private readonly feed: HTMLDivElement;
  private last = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'drill-hud';
    this.title = this.add('drill-title');
    this.progress = this.add('drill-progress');
    this.tip = this.add('drill-tip');
    this.feed = this.add('drill-feed');
    parent.appendChild(this.root);
    this.hide();
  }

  private add(cls: string): HTMLDivElement {
    const d = document.createElement('div');
    d.className = cls;
    this.root.appendChild(d);
    return d;
  }

  show(run: DrillRun) {
    this.root.style.display = '';
    this.title.textContent = run.def.name;
    this.tip.textContent = run.def.how[run.def.how.length > 1 ? 1 : 0];
    this.last = '';
  }

  hide() {
    this.root.style.display = 'none';
  }

  update(run: DrillRun) {
    const streak = run.streak > 1 ? ` · streak ${run.streak}` : '';
    const key = `${run.progress}|${streak}|${run.feed.length ? run.feed[run.feed.length - 1].at : -1}|${Math.floor(run.t / 10)}`;
    if (key === this.last) return;
    this.last = key;
    this.progress.textContent = `${run.progress}${streak}`;
    this.feed.replaceChildren(
      ...run.feed
        .slice(-5)
        .reverse()
        .map((f, i) => {
          const d = document.createElement('div');
          d.className = `drill-line ${f.kind}`;
          d.textContent = f.text;
          // Older lines fade; everything fades after a few seconds.
          const age = (run.t - f.at) / 20;
          d.style.opacity = String(Math.max(0.25, Math.min(1, 1 - i * 0.18) * (age > 6 ? 0.5 : 1)));
          return d;
        }),
    );
  }
}
