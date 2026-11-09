import { readZip } from '../render/zip';
import type { ModId } from './registry';

/**
 * Minecraft mods from Modrinth or CurseForge are Java (.jar) programs for Minecraft's own Java
 * code; PvP Trainer is a different game written in TypeScript, so their code can't run here.
 * What can: reading which mod a jar is (fabric.mod.json, quilt.mod.json, META-INF/mods.toml,
 * neoforge.mods.toml, or an old 1.8 Forge mcmod.info) and, for the popular PvP and HUD mods,
 * switching on PvP Trainer's own version of the same thing.
 */

export interface JarMod {
  id: string;
  name: string;
  version: string;
  description: string;
  loader: 'Fabric' | 'Quilt' | 'Forge' | 'NeoForge' | 'Forge (1.8)' | 'Unknown';
}

/** What a jar means here. */
export type JarMatch =
  | { kind: 'builtin'; mods: ModId[] }
  /** Makes Minecraft itself faster or is a library other mods need: nothing to do here. */
  | { kind: 'notNeeded'; why: string }
  | { kind: 'unsupported' };

/** Mod ids (as their jars name them) → PvP Trainer's own mods that do the same job. */
const EQUIVALENT: Record<string, ModId[]> = {
  appleskin: ['appleskin'],
  freelook: ['freelook'],
  perspectivemod: ['freelook'],
  perspective: ['freelook'],
  betterthirdperson: ['freelook'],
  zoomify: ['zoom'],
  ok_zoomer: ['zoom'],
  logical_zoom: ['zoom'],
  wi_zoom: ['zoom'],
  zoom: ['zoom'],
  keystrokes: ['keystrokes', 'cpscounter'],
  keystrokesmod: ['keystrokes', 'cpscounter'],
  togglesprint: ['togglesprint'],
  'toggle-sprint-display': ['togglesprint'],
  togglesprintdisplay: ['togglesprint'],
  armorhud: ['armorhud'],
  'armor-hud': ['armorhud'],
  armorstatushud: ['armorhud'],
  betterhud: ['armorhud', 'potcounter'],
  statuseffecttimer: ['potcounter'],
  potioncounter: ['potcounter'],
  pothud: ['potcounter'],
  totemcounter: ['totemcounter'],
  itemcounter: ['itemcounter'],
  fpsdisplay: ['fps'],
  fps: ['fps'],
  betterf3: ['fps', 'coords', 'directionhud'],
  coordinatesdisplay: ['coords'],
  coordinates: ['coords'],
  damageindicator: ['damageindicator'],
  damage_indicator: ['damageindicator'],
  torohealth: ['damageindicator', 'targethud'],
  neat: ['targethud'],
  healthindicators: ['targethud'],
  lowfire: ['lowfire'],
  lowerfire: ['lowfire'],
  'lower-fire': ['lowfire'],
  lowshield: ['lowshield'],
  lowered_shield: ['lowshield'],
  hitcolor: ['hitcolor'],
  hurtcam: ['hurtcam'],
  nohurtcam: ['hurtcam'],
  particlesmod: ['particles'],
  particlemultiplier: ['particles'],
  reachdisplay: ['reachdisplay'],
  combocounter: ['combocounter'],
  cpsmod: ['cpscounter'],
  cpsdisplay: ['cpscounter'],
  directionhud: ['directionhud'],
  speedometer: ['speedometer'],
  clock: ['clock'],
  blockoverlay: ['blockoverlay'],
  timechanger: ['timechanger'],
  autogg: ['autogg'],
  crosshair: ['crosshair'],
  customcrosshair: ['crosshair'],
  dynamiccrosshair: ['crosshair'],
};

/** Performance mods and libraries: they help Minecraft, and PvP Trainer doesn't need them. */
const NOT_NEEDED: Record<string, string> = {
  sodium: 'Speeds up Minecraft’s renderer; PvP Trainer has its own',
  lithium: 'Speeds up Minecraft’s game logic',
  iris: 'Shaders for Minecraft’s renderer',
  indium: 'Add-on for Sodium',
  ferritecore: 'Saves Minecraft’s memory',
  entityculling: 'Speeds up Minecraft’s renderer',
  immediatelyfast: 'Speeds up Minecraft’s renderer',
  modernfix: 'Speeds up Minecraft’s loading',
  krypton: 'Speeds up Minecraft’s networking',
  c2me: 'Speeds up Minecraft’s world loading',
  starlight: 'Speeds up Minecraft’s lighting',
  dynamic_fps: 'Saves power while Minecraft is in the background',
  dynamicfps: 'Saves power while Minecraft is in the background',
  lazydfu: 'Speeds up Minecraft’s loading',
  fabric: 'The Fabric API library',
  'fabric-api': 'The Fabric API library',
  fabricloader: 'The Fabric loader',
  cloth_config: 'A settings library for other mods',
  'cloth-config': 'A settings library for other mods',
  modmenu: 'Lists Minecraft’s mods (the Marketplace does that here)',
  architectury: 'A library for other mods',
  yet_another_config_lib_v3: 'A settings library for other mods',
  yacl: 'A settings library for other mods',
  optifine: 'Speeds up and adds shaders to Minecraft’s renderer',
};

export function matchJar(id: string): JarMatch {
  const k = id.toLowerCase();
  if (EQUIVALENT[k]) return { kind: 'builtin', mods: EQUIVALENT[k] };
  if (NOT_NEEDED[k]) return { kind: 'notNeeded', why: NOT_NEEDED[k] };
  return { kind: 'unsupported' };
}

/** A value from a TOML [[mods]] table (enough for mods.toml: key = "string"). */
function tomlValue(toml: string, key: string): string {
  const mods = toml.split(/\[\[mods\]\]/)[1] ?? toml;
  // Multi-line strings first, or ''' would read as an empty '' string.
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(?:'''([\\s\\S]*?)'''|"""([\\s\\S]*?)"""|"([^"]*)"|'([^']*)')`, 'm').exec(mods);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? '').trim();
}

/** Which mod a jar is, from its metadata (throws if it isn't a mod jar at all). */
export async function readJarMod(bytes: Uint8Array): Promise<JarMod> {
  const entries = readZip(bytes);
  const file = (name: string) => entries.find((e) => e.name === name);
  const text = async (name: string) => {
    const e = file(name);
    return e ? new TextDecoder().decode(await e.read()) : null;
  };
  const fabric = await text('fabric.mod.json');
  if (fabric) {
    const j = JSON.parse(fabric) as { id?: string; name?: string; version?: string; description?: string };
    return { id: String(j.id ?? ''), name: String(j.name ?? j.id ?? ''), version: String(j.version ?? ''), description: String(j.description ?? ''), loader: 'Fabric' };
  }
  const quilt = await text('quilt.mod.json');
  if (quilt) {
    const j = JSON.parse(quilt) as { quilt_loader?: { id?: string; version?: string; metadata?: { name?: string; description?: string } } };
    const q = j.quilt_loader ?? {};
    return { id: String(q.id ?? ''), name: String(q.metadata?.name ?? q.id ?? ''), version: String(q.version ?? ''), description: String(q.metadata?.description ?? ''), loader: 'Quilt' };
  }
  for (const [name, loader] of [
    ['META-INF/neoforge.mods.toml', 'NeoForge'],
    ['META-INF/mods.toml', 'Forge'],
  ] as const) {
    const toml = await text(name);
    if (toml) {
      const id = tomlValue(toml, 'modId');
      return { id, name: tomlValue(toml, 'displayName') || id, version: tomlValue(toml, 'version'), description: tomlValue(toml, 'description'), loader };
    }
  }
  const info = await text('mcmod.info');
  if (info) {
    const j = JSON.parse(info) as unknown;
    const list = (Array.isArray(j) ? j : ((j as { modList?: unknown[] }).modList ?? [])) as { modid?: string; name?: string; version?: string; description?: string }[];
    const mod = list[0] ?? {};
    return { id: String(mod.modid ?? ''), name: String(mod.name ?? mod.modid ?? ''), version: String(mod.version ?? ''), description: String(mod.description ?? ''), loader: 'Forge (1.8)' };
  }
  throw new Error('No mod information in that jar (is it a Minecraft mod?)');
}
