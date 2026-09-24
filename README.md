# PvP Trainer

A 3D Minecraft **Java Edition 1.9+** PvP practice arena. Duel a bot that plays by the
same combat rules you do — attack cooldown, 3-block reach, sprint knockback, W-taps,
crits, jump-resets, hunger/saturation healing and golden apples.

Built for the web (Three.js + TypeScript). It runs in any Mac browser, builds to a
**single self-contained HTML file**, ships as a **native macOS app**, and has
**1v1 online duels** over your own network.

## Play

**macOS app:** build it once, then it lives in `dist-app/`:

```bash
npm install
npm run app:build
```

That produces `dist-app/PvP Trainer-darwin-arm64/PvP Trainer.app` — double-click it, or
drag it to /Applications. `npm run app` runs the same shell without packaging.

The app serves the game over a private `pvp://` scheme rather than `file://`, so settings
and duel records persist and pointer lock behaves exactly as it does in Chrome. It is
ad-hoc signed (unsigned by a developer ID), so if you ever move it between machines run
`xattr -dr com.apple.quarantine "PvP Trainer.app"` first. Pass `--universal` or
`--arch=x64` to `node electron/build-app.mjs` for other Macs.

**In a browser:** double-click `dist/index.html` (Chrome recommended; Safari works too).

**Dev server:**

```bash
npm run dev
```

Then open http://localhost:5173.

| Key | Action |
| --- | --- |
| W A S D | Move |
| Space | Jump (hold to bunny-hop) |
| Ctrl | Sprint (toggle by default, or double-tap W) |
| Shift | Sneak |
| Left click | Attack |
| Right click (hold) | Use — eat, raise the shield, draw the bow, load / fire the crossbow, throw a splash potion / XP bottle (main hand first, then off hand) |
| 1–9 / scroll | Hotbar |
| F | Swap main hand and off hand |
| E | Inventory |
| F5 or V | Third person |
| ⌘M (or F3 + B) | Toggle combat hitboxes |
| Esc | Pause |
| R | Rematch |

In a browser ⌘M may be swallowed by the browser's own Window menu — F3 + B (the vanilla
binding) always works, and there is a **Hitboxes** switch in Settings. The macOS app rebinds
Minimize to ⌥⌘M so ⌘M belongs to the game.

### Combat hitboxes

Same overlay Minecraft draws for F3 + B, drawn over the models rather than behind them:

- white wireframe of the 0.6 × 1.8 entity box (0.6 × 1.5 while sneaking),
- a red slab at eye height — the exact point every attack ray starts from,
- a blue ray along the look direction, drawn **3 blocks** long, which is 1.9+ attack reach.

A box turns **yellow** while that fighter is inside the other one's reach, so you can see the
moment a swing would actually connect. Your own box is hidden in first person.

## Multiplayer

Double-click **`Start Server.command`** in this folder, or:

```bash
npm run server        # run it from this checkout
npm run server:pack   # or build a standalone folder anyone can run
```

The launcher does the same thing as `npm run server` — it also runs `npm install` on a first
run and keeps the window open when something fails, so it is the one to double-click.

`server:pack` writes **`~/Desktop/PvP Trainer Server/`** — `server.mjs`, `game.html` and
double-click launchers for Windows (`.bat`), macOS (`.command`) and Linux. It has **no
dependencies at all**: the WebSocket server is implemented in
[`src/server/ws.ts`](src/server/ws.ts) and the whole thing bundles to one ~50 kB file, so the
host only needs Node installed. Zip that folder and send it to whoever is hosting.

The server prints every address a friend could actually reach — deliberately skipping carrier-NAT (`100.64.0.0/10`,
what a phone hotspot hands out) and link-local addresses, which nobody can route to. Friends
open the printed URL in a browser, then **Multiplayer → Host a new room** / **Join room code**
with a 4-letter code. Two per room, unlimited rooms.

**Hits are lag-compensated.** Your client draws the opponent `INTERP_TICKS` (100 ms) behind the
newest snapshot and interpolates between the two snapshots either side of that moment, so remote
movement is smooth and — more importantly — delayed by a known amount. When you swing, the server
rewinds the target by exactly that delay plus half your round-trip time before testing the ray, so
a swing that connected on your screen connects here. Rewinds are clamped to `MAX_REWIND_TICKS`.

The split is Minecraft's own: **movement is client-authoritative** (each client runs its own
`Fighter` so the controls never wait on the network) and **combat is server-authoritative** —
the server owns health, hunger, effects, the attack cooldown and knockback, and runs the exact
same `Fighter`/`combat` code the single-player sim does, bundled for Node by
`npm run build:server`. A landed hit sends the victim a velocity packet, which is
`ClientboundSetEntityMotionPacket` by another name.

The host plays too — hosting just means running the process; open `http://localhost:4180`
and join like anyone else.

Everyone must be on the same network as the host. Different SSIDs, a phone hotspot or
anything behind carrier NAT will not reach it; for that, put every machine on
[Tailscale](https://tailscale.com) and use the host's Tailscale IP.

Because movement is trusted, a modified client could move in ways it shouldn't — it's a
play-with-friends server, not a hardened one.

| Piece | File |
| --- | --- |
| Wire format | [`src/net/protocol.ts`](src/net/protocol.ts) |
| Authoritative duel | [`src/net/Duel.ts`](src/net/Duel.ts) |
| Client-side match | [`src/net/NetMatch.ts`](src/net/NetMatch.ts) |
| Server | [`src/server/main.ts`](src/server/main.ts) |
| WebSocket (no deps) | [`src/server/ws.ts`](src/server/ws.ts) |

Rendering adapts: the device pixel ratio drops automatically when frames run long and climbs back
when they do not, which is what keeps it playable on integrated graphics.

## Game modes

| Mode | Status |
| --- | --- |
| **Sword** — Diamond Sword (Sharpness V), Diamond armor (Protection IV), 5 golden apples | ✅ Playable |
| **Axe** — Diamond Axe, Diamond Sword, Crossbow, Bow, 6 Arrows, Shield (off hand), Diamond armor (unenchanted) | ✅ Playable (vs bot) |
| **NethPot** — Netherite Sword (Sharpness V, Fire Aspect II, Unbreaking III, Mending), Netherite armor (Protection IV, Unbreaking III, Mending), 3 totems (one in the off hand), 64 golden apples, 3× Strength II, 3× Speed II, 3× Fire Resistance (8:00), 21× Splash Healing II, 2 stacks of Bottles o' Enchanting | ✅ Playable (vs bot) |
| UHC, Diamond Pot, Crystal, SMP, Mace | Coming soon (cards shown in the menu) |

Online duels use the Sword kit; the inventory screen and F work online too.

Bot difficulties: **Practice, Easy, Normal, Hard, Expert**.

**Practice** moves, strafes, chases and eats golden apples exactly like Easy, but never
swings — you take no damage, so you can drill combos, W-taps, crits and reach without the
duel fighting back. Its nametag reads *Passive*.

## Mechanics (all simulated at 20 ticks/second)

- **Attack cooldown**: damage × (0.2 + 0.8·charge²); a sword fully charges in 12 ticks
  (0.6 s). Every click, including a miss, resets the cooldown. Switching items resets it too.
- **Reach**: 3.0 blocks from the eyes to the 0.6 × 1.8 hitbox, ray-tested against your crosshair.
- **Damage**: Diamond Sword 7 + Sharpness V 3. Against Diamond Prot IV a full hit deals
  1.08 HP and a crit 1.63 HP (vanilla armor-toughness and Protection formulas).
- **Critical hits**: falling, not on the ground, charge > 90%, and not *server-side* sprinting →
  1.5× base damage, applied before the Sharpness bonus. A sprint hit always takes priority over a
  crit, so you have to release sprint before you click. The trick is that after one sprint hit your
  sprint is cancelled and the client's re-sprint never reaches the server, so **every following hit
  can crit until you genuinely stop sprinting** — which is also what gets Sprint KB back.
  The HUD's **Next hit** line names which of the three you are about to land, and why.
- **Knockback**: 0.4 base, +0.5 per sprint/Knockback level, 0.4 max upward. An **airborne target
  takes horizontal knockback only** (15w49a) — their vertical motion is left completely alone, so
  being hit mid-jump keeps the full arc and jump-resets work. Online, the client reports its
  vertical velocity in every move packet precisely so the server can leave it untouched.
  Horizontal knockback is computed from a server-side velocity copy that keeps the previous
  impulse (decaying with friction), which is what makes knockback build through a combo instead
  of resetting to the same push on every hit.
- **Sprint knockback and W-tap**: a sprint hit cancels your sprint and slows you to 60%. If you
  keep holding sprint, the client sprints again but the server never learns about it. You get no
  more sprint knockback until you W-tap or S-tap, and you can crit while still sprinting.
- **Hurt immunity**: 10 ticks; a stronger hit during immunity deals only the extra damage and no knockback.
- **Jump-reset / hit-select**: jumping on the tick you get hit adds the sprint-jump boost
  toward your opponent. Sprint-hitting right after getting hit cuts your own velocity by 40%.
- **Movement**: walk 4.317 m/s, sprint 5.612 m/s, sprint-jump boost 0.2, jump 0.42, gravity
  0.08, drag 0.98, ground friction 0.546, air friction 0.91.
- **Hunger**: exhaustion from sprinting (0.1/m), jumping (0.05 / 0.2 sprint-jump), attacking
  and taking damage (0.1). Full hunger with saturation heals 1 HP every 0.5 s. At 18+ hunger
  you heal 1 HP every 4 s. You can't sprint at 6 hunger or below.
- **Off hand**: right click tries the main hand first and falls through to the off hand when the
  main-hand item has no use — a sword with a shield behind it blocks, with a golden apple behind it
  eats. **F** swaps the two hands.
- **Shield**: blocks every melee hit and arrow from the front half once it has been raised for 5 ticks
  (0.25 s). You move at 20% speed and cannot attack while it is up — clicks are swallowed, so you have to
  lower it for a tick first. A blocked hit still gives the defender fresh i-frames with `lastHurt = 0`.
- **Axe**: 9 damage, 1.0 attack speed (20-tick charge). Any axe hit on a raised shield disables every
  shield for 5 s (100 ticks), whatever the charge.
- **Attribute swapping**: attack damage and attack speed come from the item held at the *last* entity
  tick; enchantments and item effects come from the item in your hand *now*. Press a hotbar key and click
  on the same tick (within 50 ms — hotbar keys are always processed before clicks) and you hit with the
  old item's damage and charged cooldown plus the new item's effect: e.g. a full-charge sword hit that
  still disables a shield because the axe is already in your hand. The HUD marks these hits **· SWAP**
  and the coach line shows which item's attributes are live.
- **Bow**: full draw in 20 ticks, arrow speed 3 × power, crit (random bonus damage) at full draw.
  **Crossbow**: loads in 25 ticks (hold, then release), fires at 3.15 on the next click, always crit.
  Arrows fly with vanilla drag (×0.99) and gravity (0.05), deal ⌈speed × 2⌉, stick in the floor and
  walls, and can be walked over to pick them back up.
- **Inventory (E)**: the full survival inventory — armor, off hand, 27 slots and the hotbar. Left click
  picks up / places / swaps, right click splits, shift-click quick-moves, 1–9 or F over a slot swaps it
  with that hotbar slot or the off hand, and you can drag a stack straight onto another slot. The game
  keeps running while it is open, just like vanilla.
- **Splash potions** (NethPot): thrown instantly on right click, 20° above the crosshair at 0.5
  blocks/tick plus your own motion, gravity 0.05. Everyone within 4 blocks of the splash is affected,
  scaled by 1 − distance / 4 (a direct hit is always full strength), so look straight down to pot
  yourself. **Healing II** heals round(scale × 8) — 4 hearts at best. **Strength II** +6 attack damage
  (1:30), **Speed II** +40% speed (1:30), **Fire Resistance** 8:00. Potions don't stack, so every pot
  has its own slot.
- **Totem of Undying**: a lethal hit with a totem in either hand (main hand first) uses it instead —
  1 HP, every effect cleared, then Regeneration II 45 s, Absorption II 5 s, Fire Resistance 40 s.
  Re-totem with **F** (a hotbar totem) or from the inventory (hover a totem, press F).
- **Fire Aspect II**: sets the target alight for 8 s. Burning deals 1 damage per second through
  armor points (Protection still reduces it); Fire Resistance cancels it.
- **Durability**: armor loses max(1, damage ÷ 4) per piece per hit, swords 1 per hit, axes 2.
  Unbreaking III skips 75% of weapon wear and 30% of armor wear. Durability bars show in the hotbar
  and inventory; a piece that reaches zero breaks.
- **Bottle o' Enchanting + Mending**: a bottle drops 3–11 XP in orbs that fly to the nearest player
  within 8 blocks (one orb every 2 ticks). Mending spends each orb on a random damaged Mending item you
  are wearing or holding, at 2 durability per XP.
- **Netherite**: armor 3/8/6/3, toughness 3 per piece and **0.1 knockback resistance per piece** —
  a full set takes 40% less knockback, which is why NethPot fights stay close. Netherite Sword: 8 damage.
- **Crit maths with Strength II**: (8 + 6) × 1.5 + 3 Sharpness = 24 before armor. Against Netherite
  Prot IV that is 3.4 HP; a full non-crit hit is 2.1 HP.
- **P-crits** (punish crits): a hit on you while you stand on the ground knocks you up. Let go of
  sprint and you are falling a few ticks later with your sword charged — a crit with no jump.
- **Golden apple**: 1.5 s to eat (vanilla is 1.6 s; change `GOLDEN_APPLE_EAT_TICKS` in
  `src/core/constants.ts`). Eating slows you to 20% speed. It gives Regeneration II for 5 s,
  Absorption I for 2 min, 4 hunger and 9.6 saturation.

## The bot

The bot only presses keys, moves the mouse and clicks, with a reaction delay and aim error
that depend on difficulty. It plays with the same physics and combat rules you do. It:

- times hits to the cooldown (half-swings on Hard+), W-taps and S-taps after sprint hits
- goes for jump crits, jump-resets, hit-selects and circle strafes
- keeps its spacing while its sword recharges, and backs out of combos
- **retreats when its health is low**: it lands a last knockback hit, runs (sprint-jumping on
  Hard+), eats golden apples once it's far enough away, and comes back once it has healed
- punishes you with crits when you eat

In the **Axe** kit it also plays the shield game:

- raises its shield when your weapon is about to be charged and its own is not (it tracks your swings
  and your held item's cooldown, and needs the 5-tick raise lead to be safe), and drops it for a tick to
  hit back
- disables your shield with the axe — **Hard and Expert attribute-swap** (axe in hand and swing on the
  same tick, sword damage and cooldown), lower difficulties pull the axe out and commit to it
- goes all in with sword crits for the 5 s your shield is down, and reads your axe: Hard+ lowers its
  shield and hits you when you pull yours out
- loads the crossbow when you keep your distance and shoots it (and the bow on Hard+) with ballistic
  aim and lead, stops when you close in
- Practice keeps its shield up at you and never swings — a shield-disable drill

In **NethPot** it plays the pot game:

- throws Strength, Speed and Fire Resistance at the start and re-applies them when they run out
  (Normal+), fetching them from the inventory — the inventory takes real time to open, and it can't
  move or attack while it's open
- pots by looking straight down and backing off, at a health threshold that rises with difficulty
  (Expert pots at 5.5 hearts, two pots back to back when it's low); lower difficulties aim sloppily
  and waste some of each pot
- re-totems after a pop: slot key + F from a hotbar totem on Normal+, through the inventory on Easy,
  and restocks the hotbar totem and healing pots when it has room
- mends its armor with XP bottles in the gaps knockback opens, and eats a golden apple for absorption
  when you are far away
- goes for jump crits and **P-crits** (Hard 55%, Expert 80% of the times you hit it)

## Project layout

```
src/core      constants (all vanilla values), math, rng
src/game      Fighter (movement/inventory/items/effects/durability), combat, Arrow, Thrown (potions, XP bottles),
              XpOrb (mending), Match (tick order), Game (glue), kits, items
src/ai        BotBrain + difficulty profiles
src/render    arena/voxel mesher, player model (vanilla HumanoidModel animation + armor layers),
              first-person hands, item meshes from the resource pack, arrows, particles
src/ui        HUD, inventory screen, menus, settings, pixel-art sprites
src/assets/pack  the resource-pack textures the game uses (items, armor, shield, arrows, blocks, HUD)
src/render/Hitboxes.ts   F3+B-style debug boxes
src/net       protocol, authoritative Duel, client NetMatch/NetClient
src/server    Node multiplayer server + dependency-free WebSocket implementation
scripts/      pack-server.mjs builds the standalone server folder
electron/     macOS app shell (main + preload), icon generator, packager script
tests/        mechanics + bot-vs-bot duel tests (npm test)
```

To add a mode, fill in its `KitDef` in `src/game/kits.ts` (hotbar, armor, off hand) and add any new
items to `src/game/items.ts`. Item models are generated from the 16×16 textures in
`src/assets/pack/item/` the way vanilla's ItemModelGenerator does it, so a new item only needs its PNG.

## Credits

Textures: the **Bare Bones** resource pack (items, armor, shield, arrows, blocks and HUD sprites in
`src/assets/pack/`) — used here for private practice; check the pack's terms before redistributing.
Player rig (CC-BY 4.0, Sketchfab) by lewisglasgow2005. Not affiliated with Mojang or Microsoft.
