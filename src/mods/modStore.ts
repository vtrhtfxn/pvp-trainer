import { matchJar, readJarMod, type JarMatch, type JarMod } from './jarMods';
import type { ModId, ModManager } from './registry';

/**
 * Where downloaded Minecraft mods (.jar) come from:
 *
 * - The desktop app's **mods folder** (in the app's data folder, like Minecraft's): drop the .jar
 *   files from Modrinth or CurseForge in. Needs an app shell that has it (window.pvpNative.mods).
 * - **Added in the game**: a .jar chosen with "Add mod…", kept in the browser's storage
 *   (IndexedDB) on this computer, for the browser and older app shells.
 *
 * A jar's own Java code never runs (see jarMods.ts). When PvP Trainer has its own version of
 * that mod, it is installed the first time the jar shows up; after that the player is free to
 * switch it off or uninstall it, and it stays that way.
 */

export type JarSource = 'folder' | 'saved';

export interface JarInfo {
  source: JarSource;
  file: string;
  mod: JarMod | null;
  match: JarMatch;
  error?: string;
}

const DB = 'pvp-trainer-mods';
const STORE = 'jars';
const APPLIED_KEY = 'pvp.jarModsApplied';

export function hasModFolder(): boolean {
  return !!window.pvpNative?.mods;
}

export function openModFolder() {
  void window.pvpNative?.mods?.openFolder();
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'name' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Storage unavailable'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = run(d.transaction(STORE, mode).objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('Storage error'));
      }),
  );
}

async function savedNames(): Promise<string[]> {
  try {
    return ((await tx('readonly', (s) => s.getAllKeys())) as IDBValidKey[]).map(String).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Keeps a chosen .jar in the browser's storage (just its mod info, not the whole jar). */
export async function addSavedJar(file: File): Promise<JarMod> {
  const mod = await readJarMod(new Uint8Array(await file.arrayBuffer()));
  if (!mod.id) throw new Error('That jar has no mod id');
  await tx('readwrite', (s) => s.put({ name: file.name, mod, added: Date.now() }));
  return mod;
}

export async function removeSavedJar(name: string) {
  await tx('readwrite', (s) => s.delete(name));
}

/** Every jar there is, from the folder and the browser's storage, with what it means here. */
export async function listJars(): Promise<JarInfo[]> {
  const out: JarInfo[] = [];
  const native = window.pvpNative?.mods;
  if (native) {
    let names: string[] = [];
    try {
      names = await native.list();
    } catch {
      // The folder couldn't be read: only the saved jars are listed.
    }
    for (const file of names) {
      try {
        const bytes = await native.read(file);
        if (!bytes) throw new Error('Could not be read');
        const mod = await readJarMod(bytes);
        out.push({ source: 'folder', file, mod, match: matchJar(mod.id) });
      } catch (e) {
        out.push({ source: 'folder', file, mod: null, match: { kind: 'unsupported' }, error: (e as Error).message || 'Could not be read' });
      }
    }
  }
  for (const file of await savedNames()) {
    try {
      const row = (await tx('readonly', (s) => s.get(file))) as { mod: JarMod } | undefined;
      if (!row) continue;
      out.push({ source: 'saved', file, mod: row.mod, match: matchJar(row.mod.id) });
    } catch {
      // Skip a row that can't be read.
    }
  }
  return out;
}

function appliedIds(): Set<string> {
  try {
    return new Set((JSON.parse(localStorage.getItem(APPLIED_KEY) ?? '[]') as unknown[]).map(String));
  } catch {
    return new Set();
  }
}

/**
 * Installs PvP Trainer's version of each jar seen for the first time. Returns the mods it
 * switched on. A jar already seen is left alone, so uninstalling its mod sticks.
 */
export function applyJars(jars: JarInfo[], mods: ModManager): ModId[] {
  const seen = appliedIds();
  const turnedOn: ModId[] = [];
  for (const j of jars) {
    if (!j.mod || j.match.kind !== 'builtin') continue;
    const key = j.mod.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    for (const id of j.match.mods) {
      if (!mods.states[id].installed) {
        mods.install(id);
        turnedOn.push(id);
      }
    }
  }
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify([...seen]));
  } catch {
    // Storage blocked: they'd be switched on again next time, which is harmless.
  }
  return turnedOn;
}
