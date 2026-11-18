import { importMap } from './arena';
import { BUILTIN_ARENAS } from './builtinArenas';
import type { GameMap } from './gameMap';

/**
 * Arenas you imported, kept in the browser's storage (IndexedDB) on this computer. Small: a map
 * is stored in this game's own compact form, not as the original file.
 */

const DB = 'pvp-maps';
const STORE = 'maps';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
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

/** A stored map looks like one (from this game, not tampered into something else). */
function valid(m: unknown): m is GameMap {
  const g = m as GameMap;
  return (
    !!g &&
    g.v === 1 &&
    typeof g.id === 'string' &&
    typeof g.name === 'string' &&
    typeof g.cells === 'string' &&
    Array.isArray(g.palette) &&
    Array.isArray(g.spawns) &&
    g.spawns.length >= 2 &&
    [g.w, g.h, g.l, g.ox, g.oy, g.oz, g.voidY].every((n) => Number.isFinite(n)) &&
    g.w * g.h * g.l <= 8 * 1024 * 1024
  );
}

export async function listMaps(): Promise<GameMap[]> {
  try {
    const all = (await tx('readonly', (s) => s.getAll())) as unknown[];
    return all.filter(valid).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function getMap(id: string): Promise<GameMap | null> {
  const builtin = BUILTIN_ARENAS.find((m) => m.id === id);
  if (builtin) return builtin;
  try {
    const m = await tx('readonly', (s) => s.get(id));
    return valid(m) ? m : null;
  } catch {
    return null;
  }
}

/** Reads a map file and keeps it. Throws with a message a player can read. */
export async function addMapFile(file: File): Promise<GameMap> {
  if (file.size > 64 * 1024 * 1024) throw new Error('That file is too big (over 64 MB)');
  const map = await importMap(file.name, new Uint8Array(await file.arrayBuffer()));
  await tx('readwrite', (s) => s.put(map));
  return map;
}

export async function removeMap(id: string) {
  await tx('readwrite', (s) => s.delete(id));
}
