import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchJar, readJarMod } from '../src/mods/jarMods';
import { applyJars, type JarInfo } from '../src/mods/modStore';
import { ModManager } from '../src/mods/registry';
import { zip } from './zipWriter';

const cls = new Uint8Array([0xca, 0xfe, 0xba, 0xbe]);

describe('downloaded mod jars', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

  it('reads Fabric, Quilt, Forge, NeoForge and 1.8 Forge jars', async () => {
    const fabric = await readJarMod(zip({ 'fabric.mod.json': JSON.stringify({ id: 'appleskin', name: 'AppleSkin', version: '3.0.5', description: 'Food values' }), 'squeek/A.class': cls }));
    expect(fabric).toMatchObject({ id: 'appleskin', name: 'AppleSkin', version: '3.0.5', loader: 'Fabric' });

    const quilt = await readJarMod(zip({ 'quilt.mod.json': JSON.stringify({ quilt_loader: { id: 'zoomify', version: '2.1', metadata: { name: 'Zoomify' } } }) }));
    expect(quilt).toMatchObject({ id: 'zoomify', name: 'Zoomify', loader: 'Quilt' });

    const toml = `modLoader="javafml"\nloaderVersion="[47,)"\n\n[[mods]]\nmodId="torohealth"\nversion="1.20-forge-2"\ndisplayName="ToroHealth Damage Indicators"\ndescription='''\nShows health\n'''\n\n[[dependencies.torohealth]]\nmodId="forge"\n`;
    const forge = await readJarMod(zip({ 'META-INF/mods.toml': toml }, false));
    expect(forge).toMatchObject({ id: 'torohealth', name: 'ToroHealth Damage Indicators', version: '1.20-forge-2', description: 'Shows health', loader: 'Forge' });

    const neo = await readJarMod(zip({ 'META-INF/neoforge.mods.toml': '[[mods]]\nmodId = "sodium"\ndisplayName = "Sodium"\n' }));
    expect(neo).toMatchObject({ id: 'sodium', loader: 'NeoForge' });

    const old = await readJarMod(zip({ 'mcmod.info': JSON.stringify([{ modid: 'ToggleSprint', name: 'Toggle Sprint', version: '1.8.9' }]) }));
    expect(old).toMatchObject({ id: 'ToggleSprint', loader: 'Forge (1.8)' });
  });

  it('rejects a jar that is not a mod', async () => {
    await expect(readJarMod(zip({ 'com/x/Main.class': cls }))).rejects.toThrow(/No mod information/);
  });

  it('maps popular mods to the built-in ones, performance mods to "not needed"', () => {
    expect(matchJar('appleskin')).toEqual({ kind: 'builtin', mods: ['appleskin'] });
    expect(matchJar('ToggleSprint')).toEqual({ kind: 'builtin', mods: ['togglesprint'] });
    expect(matchJar('ok_zoomer')).toEqual({ kind: 'builtin', mods: ['zoom'] });
    expect(matchJar('sodium').kind).toBe('notNeeded');
    expect(matchJar('create').kind).toBe('unsupported');
  });

  it('switches on the built-in mod once; uninstalling it afterwards sticks', () => {
    const mods = new ModManager();
    const jars: JarInfo[] = [
      { source: 'folder', file: 'appleskin.jar', mod: { id: 'appleskin', name: 'AppleSkin', version: '', description: '', loader: 'Fabric' }, match: matchJar('appleskin') },
      { source: 'folder', file: 'create.jar', mod: { id: 'create', name: 'Create', version: '', description: '', loader: 'Forge' }, match: matchJar('create') },
    ];
    expect(applyJars(jars, mods)).toEqual(['appleskin']);
    expect(mods.on('appleskin')).toBe(true);
    mods.uninstall('appleskin');
    expect(applyJars(jars, mods)).toEqual([]);
    expect(mods.states.appleskin.installed).toBe(false);
  });
});
