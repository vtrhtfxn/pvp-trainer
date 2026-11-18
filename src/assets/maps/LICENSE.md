# Maps in this folder

These maps come from **Overcast Community's CommunityMaps**
(<https://github.com/OvercastCommunity/CommunityMaps>), released under the
**Creative Commons Attribution-ShareAlike 4.0 International** licence
(<https://creativecommons.org/licenses/by-sa/4.0/>).

## Item Sumo maps (folder `arcade/item_sumo`)

| File | Map | Author |
|---|---|---|
| `atomic.json` | Atomic | zzuf |
| `atomic_ii.json` | Atomic II | zzuf |
| `calima.json` | Calima | zzuf |
| `gjoll.json` | Gjöll | zzuf |
| `weald.json` | Weald | zzuf |

## Duel arenas, `arenas/` (folder `ffa`)

| File | Map | Authors |
|---|---|---|
| `arenas/la_piazza.json` | La Piazza | Technodono, Tundren |
| `arenas/deadwood.json` | Deadwood | zzuf, Metacognitive |
| `arenas/frostbite_rage.json` | Frostbite RAGE | Tundren, Mewzzy, zzuf |
| `arenas/jurassic_attack_ffa.json` | Jurassic Attack FFA | Tundren, Mewzzy, Ruediger_LP, Strangey |
| `arenas/paladin_banners.json` | Paladin Banners | Tywnis |

**Changes (arenas):** converted by `scripts/convert-occ-arenas.ts`: the 112 × 112 area around each
world's spawn, its main floor set to this game's ground level, two duel spawns chosen automatically;
blocks drawn as below.

**Changes (Item Sumo):** converted by `scripts/convert-occ-maps.ts` from the original 1.8 worlds into this game's
map format. Only the playable area is kept; each Minecraft block is drawn as one of this game's blocks
(decoration like torches and floor slabs is left out; stairs, fences and walls become full blocks);
spawns, the centre and the void height come from each map's `map.xml`.

These map files (and any changes to them) stay under CC BY-SA 4.0. The licence covers these files,
not the rest of the game.
