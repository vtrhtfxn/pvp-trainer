# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

PvP Trainer: a 3D Minecraft **Java 1.9+ PvP practice game** (duel tier bots, online play, minigames,
tournaments). It is written in **TypeScript** with **Three.js**, built by **Vite**, and tested with **Vitest**.
It ships as one self-contained `dist/index.html` (everything is inlined by `vite-plugin-singlefile`) and
as an **Electron** desktop app for macOS and Windows.

There is **no database and no backend you host**. Everything the player owns (settings, replays,
history, custom kits, tournaments, mods, drills) lives in the browser's `localStorage`. Online play is
peer-to-peer:
- The host's own game runs the authoritative server code.
- Players connect over WebRTC via PeerJS (`src/net/p2p.ts`), with a TURN relay fallback (`src/net/relay.ts`).
- A standalone Node LAN server also exists (`src/server/`).

`README.md` (~1100 lines) is the detailed spec of every mechanic, kit, mode and the bot. Read the
relevant section before changing behaviour, and update it when behaviour changes.

## Commands

```bash
npm install
npm run dev                      # Vite dev server (port 5173)
npm run build                    # tsc --noEmit + vite build → dist/index.html
npx tsc --noEmit -p .            # typecheck only (strict, noUnusedLocals/Parameters; there is no linter)
npx vitest run                   # all tests (~50 files; tier/heal duel tests take minutes)
npx vitest run tests/heal.test.ts            # one file
npx vitest run tests/tiers.test.ts -t "smp"  # one test by name
npm run app                      # build + run the Electron app locally
node electron/build-app.mjs --win [--arch=arm64]   # package Windows app (after npm run build)
npm run build:server && node dist-server/server.mjs # LAN/online lobby server (serves the game + /ws)
```

CI (`.github/workflows/app.yml`) runs tsc + vitest, then builds and smoke-tests the Mac app and the
Windows app and installer. On `main` it publishes a GitHub Release (`build-N`) with `game.html` and
`build.json`. Installed apps download that `game.html` by themselves (`electron/updater.cjs`).
`electron/shell-version.json` must be bumped when a game build needs new `main.cjs`/`preload.cjs`
behaviour. Otherwise old app shells keep running new game builds, so the game must tolerate a
missing `window.pvpNative` feature (see `src/native.d.ts`).

## Architecture (big picture)

- **Simulation is a fixed 20 TPS, renderer-independent, deterministic given a seed.**
  - `src/game/Match.ts` owns the tick order for an offline game: player, bot (`BotBrain`), world entities, modes, phases (countdown → fight → ended), replay recording.
  - `Fighter.ts` (~2400 lines) is a player: movement physics, inventory, item use, effects, durability.
  - `combat.ts` resolves hits.
  - All vanilla constants live in `src/core/constants.ts`.
  - Tests drive `Match` directly with no DOM.
- **`src/game/Game.ts` (~3000 lines) is the glue.** It holds the state machine (`menu | playing | paused | results | spectating`), input, HUD, sound, menus and online message handling, and calls `SceneRenderer.render(...)` every frame. `this.match` is `Match | NetMatch` (`AnyMatch`).
- **Watching** uses one `Watch` interface (`src/game/Spectate.ts`), implemented by:
  - `Spectate` (Bot vs Bot)
  - `ReplayWatch`
  - `TourneyWatch` (offline tournament bot games, with the `BroadcastHud` overlay in `src/ui/Broadcast.ts`)
  - `NetWatch` (watching people's online tournament duels live)

  All of them render through the same spectator cameras.
- **Bot AI:** `src/ai/BotBrain.ts` (~3800 lines) is a state machine (engage/retreat/eat…) with per-kit routines.
  - `src/ai/difficulty.ts` defines the tier ladder (Practice, LT5…HT1) by blending anchor profiles.
  - Tier strength is guarded by `tests/tiers.test.ts`: higher tiers must win clearly.
  - Kits are `KitDef`s in `src/game/kits.ts`; items are in `src/game/items.ts`.
  - Bed Wars and SkyWars are `GameMode`s in `src/game/modes/` with `src/ai/SkyPlanner.ts`.
- **Online:** client-predicted with an authoritative server.
  - `src/net/Duel.ts` is the server-side duel (N seats, server bots for 2v2).
  - `src/net/NetMatch.ts` is the client: it predicts its own fighter and plays remote fighters back from relayed moves (`Playback`). With `you = -1` it is a watch-only spectator.
  - The wire format is `src/net/protocol.ts`; bump `PROTOCOL_VERSION` on incompatible changes.
  - `src/server/lobby.ts` (rooms, 2v2 squads, online tournaments via `src/net/tourney.ts`) is the *same code* whether it runs in the host's browser (P2P) or in the Node server.
  - Tests simulate the network in-process (`tests/netsim.ts`, `FakeNet`).
- **Tournaments:**
  - `src/game/tournament.ts` holds the bracket, kit draft and real bot-vs-bot games (`TourneyWatch.botGame`).
  - `src/ui/Tournament.ts` holds the screens.
  - The online version runs on the host via `OnlineTourney`.
- **Rendering:** `src/render/SceneRenderer.ts` draws the voxel arena mesher, the vanilla-style player model, first-person hands and items generated from 16×16 textures in `src/assets/pack/`.
  - Resolution adapts on its own to frame time.
  - Software WebGL is detected and degrades on purpose.
- **Debug hook:** the running game is `window.__pvp` (the `Game` instance). Playwright scripts use it to start duels, drive fighters and read state.
- **Browser checks:** Chromium and Playwright are available at `/opt/node22/lib/node_modules/playwright`. Use SwiftShader args (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`); FPS there is not representative of real GPUs.

## Working conventions in this repo

- Comments explain *why* in plain, player-facing language. Keep that style and keep README in sync.
- Bot behaviour changes must keep `tests/tiers.test.ts` (ladder) and the kit/bot tests green. Prefer
  multi-seed assertions over single lucky seeds.
- Commits are authored as `vtrhtfxn` with no Claude attribution trailers (the owner's instruction).
  Work happens on `claude/*` branches. "pr and merge" means: open a PR to `main`, wait for CI (test, app,
  windows) to pass, merge, then reset the working branch to the new `main`.

## Status / open work

Done recently:
- online tournaments with live spectating
- 2v2
- Spear Mace kit
- tournaments with real bot games and the broadcast overlay
- bots heal and mend at every tier
- Windows ARM64 build (one installer picks x64 or ARM64)
- online hosting retry fix
- resource packs (Options → Resource Packs; desktop `resourcepacks` folder or a .zip kept in IndexedDB; old 1.8 layouts mapped)
- bigger Bed Wars / SkyWars maps; Bed Wars ender chest (personal storage, `modes/containers.ts`)
- party minigames (free-for-all; `KitDef.party` = usual/min/max players, Whodunit up to 15): Sumo, Crumble, Hot Potato, Whodunit — each mode drives its own bots via `GameMode.botTick`, maps scale with `fighters.length` and must be built without randomness (clients build the same map). Online they are party rooms: the lobby's `squad` with `party` = size, `Duel`/`NetMatch` seat everyone, `end.ws` lists the winning seats
- downloaded mods: Marketplace → Downloaded Mods reads Modrinth/CurseForge .jar metadata (`src/mods/jarMods.ts`, `modStore.ts`; desktop `mods` folder via `pvpNative.mods`). Java code never runs; known PvP/HUD mods switch on the built-in equivalent
- mods: Responsive Shields (default installed; host's raise time online via `Lobby.shieldRaiseTicks`), Shield Statuses (shield front is its own material, `HeldItemSlot.paintShield`), FastXP (`Fighter.fastXp`, sent to the host via `join.opts`/`opts`), BactroMod (`extras.clarity`, `opts.itemScale`), Voice Chat (`src/net/voice.ts`: PeerJS audio calls, lobby relays `voice` addresses)
- custom skins: Options → Skin (upload PNG or username via mc-heads.net, classic/slim). With a skin, `PlayerModel`/`FirstPerson` use vanilla boxes + outer layer (`skinGeometry`); without, the GLB rig. Shared online by name (`join.skin` → lobby `skins` messages)

Open:
- **Mac stutter:** the owner reports freezes every few seconds in Sword vs HT4 on a MacBook Air M4 in build 85, and that the bot "teleports". Profiling on Linux and SwiftShader found no JS long tasks: game logic runs at about 0.015 ms per tick and Sword bot behaviour is unchanged since build 79. Suspect something Mac or GPU-specific. It needs profiling on a real Mac (`npm run app`, the FPS mod, Render Scale).
- The ARM64 Windows app is packaged in CI but has not been run on real ARM hardware.
- Online fixes (hosting retries, spectating) are tested in-process and with local browsers, not across real networks.
