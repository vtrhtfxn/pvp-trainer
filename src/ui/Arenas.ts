import type { GameMap } from '../maps/gameMap';
import { BUILTIN_ARENAS } from '../maps/builtinArenas';
import { addMapFile, listMaps, removeMap } from '../maps/mapStore';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

/**
 * Options → Arenas: duel on a map from the internet. Import a schematic (.schem, .schematic,
 * .litematic, structure .nbt) or a world save (.zip); pick it, and offline duels are fought on it
 * instead of the flat arena. (Looks like the resource pack list.)
 */
export function renderArenas(body: HTMLElement, sound: () => void, active: () => string, setActive: (id: string, map: GameMap | null) => void) {
  const box = h('div', 'rp');
  body.append(box);
  const status = h('div', 'rp-status', '');
  const list = h('div', 'rp-list', h('div', 'rp-empty', 'Looking for maps…'));
  const intro = h(
    'div',
    'rp-intro',
    'Duel on any map: import a schematic (.schem, .schematic, .litematic, structure .nbt) or a whole world save (.zip — the area around its spawn is used). Offline duels against bots are fought on the arena you pick (not 2v2, drills, the Gauntlet or tournaments). Blocks the game doesn’t have are drawn in their own colours. Only use maps you’re allowed to: they stay on this computer.',
  );
  const file = h('input', '');
  file.type = 'file';
  file.accept = '.schem,.schematic,.litematic,.nbt,.zip';
  file.style.display = 'none';
  const add = h('button', 'mc-btn', 'Import Map…');
  add.addEventListener('click', () => {
    sound();
    file.click();
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    file.value = '';
    if (!f) return;
    status.textContent = `Reading ${f.name}…`;
    try {
      const m = await addMapFile(f);
      status.textContent = `Added “${m.name}” (${m.w}×${m.h}×${m.l}). Pick it to fight on it.`;
      await refresh();
    } catch (e) {
      status.textContent = (e as Error).message || 'That file could not be read.';
    }
  });
  box.append(intro, h('div', 'rp-actions', add, file), status, list);

  const row = (m: GameMap | null) => {
    const on = (m?.id ?? '') === active();
    const el = h('div', `rp-row${on ? ' on' : ''}`);
    el.append(
      h('div', 'rp-icon', m ? '▦' : '◆'),
      h(
        'div',
        'rp-text',
        h('div', 'rp-name', m ? m.name : 'Classic Arena'),
        h('div', 'rp-desc', m ? `${m.credit}${m.license ? ` · ${m.license}` : ''}` : 'The flat walled arena (and each kit’s own).'),
      ),
    );
    if (on) el.append(h('div', 'rp-tag', 'IN USE'));
    else {
      const b = h('button', 'mc-btn small', 'Use');
      b.addEventListener('click', () => {
        sound();
        setActive(m?.id ?? '', m);
        status.textContent = m ? `Duels are now fought on “${m.name}”.` : 'Back to the classic arena.';
        void refresh();
      });
      el.append(b);
    }
    if (m && !m.id.startsWith('occ-')) {
      const rm = h('button', 'mc-btn small', 'Remove');
      rm.addEventListener('click', async () => {
        sound();
        await removeMap(m.id);
        if (active() === m.id) setActive('', null);
        void refresh();
      });
      el.append(rm);
    }
    return el;
  };

  const refresh = async () => {
    const maps = await listMaps();
    list.replaceChildren(row(null), ...BUILTIN_ARENAS.map(row), h('div', 'rp-empty', 'Imported'), ...maps.map(row));
    if (!maps.length) list.append(h('div', 'rp-empty', 'No maps imported yet.'));
  };
  void refresh();
}
