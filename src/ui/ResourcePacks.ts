import { packKeys } from '../render/pack';
import { activePack, addSavedPack, hasPackFolder, listPacks, openPackFolder, removeSavedPack, setActivePack, type PackInfo, type PackRef } from '../render/packStore';
import { resourcePackApplied } from '../render/assets';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  for (const c of children) e.append(c);
  return e;
}

const same = (a: PackRef | null, b: PackRef | null) => (!a && !b) || (!!a && !!b && a.source === b.source && a.name === b.name);

/**
 * Options → Resource Packs: the packs in the resourcepacks folder (desktop app) and the ones added
 * here, with Default at the top. Picking one reloads the game with it, like Minecraft's Done.
 */
export function renderResourcePacks(body: HTMLElement, sound: () => void) {
  const box = h('div', 'rp');
  body.append(box);
  const known = packKeys();
  const status = h('div', 'rp-status', '');
  const list = h('div', 'rp-list', h('div', 'rp-empty', 'Looking for packs…'));

  const intro = h(
    'div',
    'rp-intro',
    hasPackFolder()
      ? 'Put a Minecraft resource pack (.zip, or its unzipped folder) in the resourcepacks folder, then pick it here. Items, blocks, armor, the HUD and particles change; packs for 1.8 to the newest versions work.'
      : 'Add a Minecraft resource pack (.zip) and pick it. Items, blocks, armor, the HUD and particles change; packs for 1.8 to the newest versions work.',
  );
  const actions = h('div', 'rp-actions');
  if (hasPackFolder()) {
    const open = h('button', 'mc-btn', 'Open Pack Folder');
    open.addEventListener('click', () => {
      sound();
      openPackFolder();
    });
    actions.append(open);
  }
  const file = h('input', '');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  file.style.display = 'none';
  const add = h('button', 'mc-btn', hasPackFolder() ? 'Add .zip…' : 'Add Pack (.zip)…');
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
      const name = await addSavedPack(f, known);
      status.textContent = `Added “${name}”. Pick it to use it.`;
      await refresh();
    } catch (e) {
      status.textContent = (e as Error).message || 'That file could not be read.';
    }
  });
  const reload = h('button', 'mc-btn', 'Refresh');
  reload.addEventListener('click', () => {
    sound();
    void refresh();
  });
  actions.append(add, reload, file);
  box.append(intro, actions, status, list);
  if (resourcePackApplied) status.textContent = `In use: “${resourcePackApplied.name}” (${resourcePackApplied.textures} textures replaced).`;
  else if (activePack()) status.textContent = 'The chosen pack could not be loaded, so the default textures are in use.';

  const use = (ref: PackRef | null) => {
    if (same(ref, activePack())) return;
    sound();
    setActivePack(ref);
    status.textContent = 'Reloading with the new textures…';
    // Every texture, model and icon is rebuilt from scratch, as Minecraft reloads its resources.
    setTimeout(() => location.reload(), 150);
  };

  const row = (info: PackInfo | null) => {
    const ref = info ? { source: info.source, name: info.name } : null;
    const on = same(ref, activePack());
    const el = h('div', `rp-row${on ? ' on' : ''}${info?.error ? ' bad' : ''}`);
    const icon = h('div', 'rp-icon');
    if (info?.icon) {
      const img = h('img', '');
      img.src = info.icon;
      img.alt = '';
      icon.append(img);
    } else icon.textContent = info ? '?' : '◆';
    const text = h(
      'div',
      'rp-text',
      h('div', 'rp-name', info ? info.name.replace(/\.zip$/i, '') : 'Default'),
      h(
        'div',
        'rp-desc',
        !info
          ? 'The game’s own textures (Minecraft’s default look).'
          : info.error
            ? info.error
            : `${info.description || 'Resource pack'} · ${info.source === 'folder' ? 'pack folder' : 'added here'} · ${info.textures ? `${info.textures} textures` : 'nothing this game uses'}`,
      ),
    );
    el.append(icon, text);
    if (on) el.append(h('div', 'rp-tag', 'IN USE'));
    else if (!info?.error && (!info || info.textures > 0)) {
      const b = h('button', 'mc-btn small', 'Use');
      b.addEventListener('click', () => use(ref));
      el.append(b);
    }
    if (info?.source === 'saved') {
      const rm = h('button', 'mc-btn small', 'Remove');
      rm.addEventListener('click', async () => {
        sound();
        const reloadNeeded = same(ref, activePack());
        await removeSavedPack(info.name);
        if (reloadNeeded) location.reload();
        else void refresh();
      });
      el.append(rm);
    }
    return el;
  };

  const refresh = async () => {
    const packs = await listPacks(known);
    list.replaceChildren(row(null), ...packs.map(row));
    if (!packs.length) list.append(h('div', 'rp-empty', hasPackFolder() ? 'No packs yet: open the pack folder and drop one in, then press Refresh.' : 'No packs added yet.'));
  };
  void refresh();
}
