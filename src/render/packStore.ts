import { parsePack, parseZipPack, type PackFile, type ParsedPack } from './resourcePack';

/**
 * Where resource packs come from, and which one is on.
 *
 * - The desktop app's **resourcepacks folder** (in the app's data folder, like Minecraft's):
 *   drop a pack's .zip (or its unzipped folder) in and it is listed. Needs an app shell that has
 *   the folder (window.pvpNative.packs); older ones and the browser use the next option.
 * - **Added in the game**: a .zip chosen with "Add pack…", kept in the browser's storage
 *   (IndexedDB) on this computer.
 *
 * The pack in use is remembered in localStorage and loaded at startup, before any texture is
 * built; changing it reloads the game, as Minecraft reloads its resources.
 */

export type PackSource = 'folder' | 'saved';

export interface PackRef {
  source: PackSource;
  name: string;
}

export interface PackInfo extends PackRef {
  description: string;
  /** pack.png as a data URL ('' if none). */
  icon: string;
  /** Textures it would replace (0: nothing the game uses). */
  textures: number;
  /** Why it can't be read (then it can't be picked). */
  error?: string;
}

const ACTIVE_KEY = 'pvp.resourcePack';
const DB = 'pvp-trainer-packs';
const STORE = 'packs';

export function activePack(): PackRef | null {
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? 'null') as PackRef | null;
    return v && (v.source === 'folder' || v.source === 'saved') && typeof v.name === 'string' ? v : null;
  } catch {
    return null;
  }
}

export function setActivePack(ref: PackRef | null) {
  try {
    if (ref) localStorage.setItem(ACTIVE_KEY, JSON.stringify({ source: ref.source, name: ref.name }));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads, which it does right away.
  }
}

/** The app shell's resourcepacks folder, if this shell has one. */
export function hasPackFolder(): boolean {
  return !!window.pvpNative?.packs;
}

export function openPackFolder() {
  void window.pvpNative?.packs?.openFolder();
}

// ------------------------------------------------------------------ browser storage

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

async function savedBytes(name: string): Promise<Uint8Array | null> {
  try {
    const row = (await tx('readonly', (s) => s.get(name))) as { bytes: ArrayBuffer } | undefined;
    return row ? new Uint8Array(row.bytes) : null;
  } catch {
    return null;
  }
}

/** Keeps a chosen .zip in the browser's storage. Returns its name. Throws if it isn't a pack. */
export async function addSavedPack(file: File, known: ReadonlySet<string>): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pack = await parseZipPack(bytes, known);
  if (!pack.textures.size && !pack.atlases.icons && !pack.atlases.widgets && !pack.leather.size) {
    throw new Error('That .zip has no textures this game uses (is it a Minecraft resource pack?)');
  }
  const name = file.name.replace(/\.zip$/i, '');
  await tx('readwrite', (s) => s.put({ name, bytes: bytes.buffer, added: Date.now() }));
  return name;
}

export async function removeSavedPack(name: string) {
  await tx('readwrite', (s) => s.delete(name));
  const a = activePack();
  if (a && a.source === 'saved' && a.name === name) setActivePack(null);
}

// ------------------------------------------------------------------ reading

async function read(ref: PackRef, known: ReadonlySet<string>): Promise<ParsedPack | null> {
  if (ref.source === 'saved') {
    const bytes = await savedBytes(ref.name);
    return bytes ? parseZipPack(bytes, known) : null;
  }
  const native = window.pvpNative?.packs;
  if (!native) return null;
  const got = await native.read(ref.name);
  if (!got) return null;
  if (got.zip) return parseZipPack(got.zip, known);
  const files: PackFile[] = (got.files ?? []).map((f) => ({ name: f.name, read: async () => f.data }));
  return parsePack(files, known);
}

function dataUrl(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => resolve('');
    r.readAsDataURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
  });
}

/** Every pack there is, from the folder and the browser's storage, described. */
export async function listPacks(known: ReadonlySet<string>): Promise<PackInfo[]> {
  const refs: PackRef[] = [];
  const native = window.pvpNative?.packs;
  if (native) {
    try {
      for (const name of await native.list()) refs.push({ source: 'folder', name });
    } catch {
      // The folder couldn't be read: only the saved packs are listed.
    }
  }
  for (const name of await savedNames()) refs.push({ source: 'saved', name });
  return Promise.all(
    refs.map(async (ref): Promise<PackInfo> => {
      try {
        const p = await read(ref, known);
        if (!p) return { ...ref, description: '', icon: '', textures: 0, error: 'Could not be read' };
        const icon = p.icon ? await dataUrl(await p.icon.read()) : '';
        const textures = p.textures.size + (p.atlases.icons ? 1 : 0) + (p.atlases.widgets ? 1 : 0) + (p.leather.size ? 1 : 0);
        return { ...ref, description: p.description, icon, textures };
      } catch (e) {
        return { ...ref, description: '', icon: '', textures: 0, error: (e as Error).message || 'Could not be read' };
      }
    }),
  );
}

/** The pack that is on, read and sorted (null: the default textures). */
export async function loadActivePack(known: ReadonlySet<string>): Promise<{ ref: PackRef; pack: ParsedPack } | null> {
  const ref = activePack();
  if (!ref) return null;
  try {
    const pack = await read(ref, known);
    return pack ? { ref, pack } : null;
  } catch {
    return null;
  }
}
