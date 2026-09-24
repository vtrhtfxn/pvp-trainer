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
| Left click | Attack (hold on a block to mine it) |
| Right click (hold) | Use — eat, raise the shield, draw the bow, load / fire the crossbow, throw a splash potion / XP bottle, place a block, pour or fill a bucket (main hand first, then off hand) |
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

**Every kit works online.** Whoever creates the room picks the kit (the one selected on the main
menu); whoever joins plays that kit. The server runs the whole world — blocks, water and lava,
fire, arrows, potions, pearls, wind charges, end crystals, anchors, explosions, dropped items and
XP — with the same code as single player, and each tick sends the clients the changed block
cells, every entity and every sound/particle event. Mining and item use (placing blocks,
buckets, crystals, anchors, pearls, wind charges, armor swaps) happen on the server; knockback,
explosions and wind launches reach you as a velocity packet and a pearl as a teleport (moves you
sent before applying it are ignored). Your client still predicts your own movement, elytra
gliding included, and reports its fall distance — crits, mace smashes and fall damage use it.

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
| **Diamond Pot** — Diamond Sword (Sharpness V), Diamond armor (Protection IV, Unbreaking III), 26× Splash Healing II, 3× Strength II, 3× Speed II, 3× Regeneration (all 1:30), 5 steak (off hand); all damage +33% | ✅ Playable (vs bot) |
| **UHC** (mcpvp.club tier-test kit) — Diamond Sword (Sharp III), Diamond Axe (Eff III), Shield, Diamond armor (Prot III/II/II/III), 8 golden apples, 2 golden heads, 4 water + 2 lava buckets, 8 cobwebs, 2 stacks of oak planks, Diamond Pickaxe (Eff III), Bow (Power I), Crossbow (Piercing I), 10 arrows · no natural regeneration, stuns on | ✅ Playable (vs bot) |
| **Crystal** — Netherite armor (Prot IV helmet and chestplate, Blast Protection IV leggings and boots, Feather Falling IV boots; all Unbreaking III + Mending), Netherite Sword (Sharpness V, Knockback I), Netherite Pickaxe (Efficiency V, Silk Touch), 128 end crystals, 128 obsidian, 128 respawn anchors, 128 glowstone, 8 totems (one in the off hand), 64 golden apples, 80 ender pearls, 32 ender chests, Crossbow (Multishot, Quick Charge III) with 64 Slow Falling arrows, 128 XP bottles, 4× Strength II, 4× Speed II · diggable ground | ✅ Playable (vs bot) |
| **SMP** — Netherite armor (Protection IV, Unbreaking III, Mending; Swift Sneak III leggings, Feather Falling IV boots), 2 Netherite Swords (Sharpness V, Fire Aspect II, Sweeping Edge III; one with Knockback I), Netherite Axe (Sharpness V), Shield (Unbreaking III, Mending; off hand), 12× Strength II, 12× Speed II, 3× Fire Resistance (8:00) splash, 1 totem, 128 golden apples, 32 ender pearls, 64 XP bottles | ✅ Playable (vs bot) |
| **Mace** — Netherite armor (Protection IV, Unbreaking III), Elytra, Mace (Density V, Wind Burst III), Mace (Breach IV), Netherite Sword and Axe (Sharpness V), Shield, 2 totems (one in the off hand), 128 wind charges, 64 ender pearls, 128 golden apples, 13× Strength II and 8× Speed II splash (as laid out in the reference inventory) | ✅ Playable (vs bot) |

The arena is 80 × 80 blocks (walls 16 high). Every kit also works online (see Multiplayer).

### Bot tiers

The bot follows the PvP tier lists, weakest to strongest: **LT5, HT5, LT4, HT4, LT3, HT3, LT2, HT2,
LT1, HT1** (Low / High Tier 5 … 1). Each tier up has more reach (2.4 → 3.0 blocks), faster reactions
(6 ticks → 1), steadier aim, better click timing and faster item play (re-totem 30 ticks → 1, crystal
click gap 8 ticks → 0, inventory 30 ticks → 2), and unlocks more of the kit:

| From | Also uses |
| --- | --- |
| LT5 | sword, golden apples, shield and axe, buffs at the start, crystals on obsidian, lava, re-totems through the inventory |
| HT5 | crossbow (Axe/UHC), pearls in (Crystal), XP mending, the odd cobweb |
| LT4 | respawn anchors, water bucket, mining blocks in its way (UHC pickaxe for stone and obsidian), re-buffing |
| LT3 | hotbar totem + F, lava pickup, Slow Falling crossbow (Crystal), sets off your crystals |
| HT3 | bow, pearls out when it is about to die |
| LT2 | everything: attribute swaps, ender-chest surrounds, digging for foot-level crystals, mining your surround, pillars, hurt-immunity timing |

Old saved difficulties map onto the ladder (Easy → LT5, Normal → LT3, Hard → LT2, Expert → LT1).
The numbers in between anchor tiers (LT5, LT4, LT3, LT2, LT1, HT1) are blended, and on/off skills
unlock at those anchors. `tests/tiers.test.ts` plays every kit three tiers apart and checks the
stronger one wins; in tuning runs each single tier step won most duels in every kit.

**Practice** moves, strafes, chases and eats golden apples like LT5, but never swings — you take no
damage, so you can drill combos, W-taps, crits and reach without the duel fighting back. Its
nametag reads *Passive*.

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
- **Diamond Pot damage boost**: the kit's server rule multiplies every hit's raw damage by 1.33 before
  armor (how a plugin changing the base damage behaves; the exact server implementation isn't public).
  A full-charge Strength II sword hit is (7 + 6 + 3) × 1.33 ≈ 21 before armor — about 3.2 HP through
  Diamond Prot IV — and a crit about 5.4 HP.
- **Regeneration I** (splash, 1:30): half a heart every 2.5 s. **Steak**: 8 hunger + 12.8 saturation in
  1.6 s, only edible below full hunger; in the off hand it is eaten behind the sword. Sprinting stops at
  6 hunger, so long pot fights need it.
- **UHC blocks** (build limit 12 above the floor; the map itself can't be broken): right click places
  a block against the face you are looking at (4.5-block reach) — never into a player, except cobwebs.
  Hold left click to mine: speed = the right tool's speed (diamond 8, + Efficiency level² + 1), ÷ 5 in
  the air or with your head under water, ÷ (hardness × 30), or × 100 if the tool can't harvest it.
  Efficiency III axe on planks: 4 ticks; sword on a cobweb: 8 ticks (webs drop nothing); bare hand on
  planks: 3 s. Broken blocks drop items you can pick up; arrows stuck in a broken block fall.
- **Buckets**: a bucket's ray ignores players, so you can pour lava straight at someone's feet. An empty
  bucket picks a source back up. **Water** flows 7 blocks (every 5 ticks), pushes you along its current,
  slows you (×0.8, ×0.9 sprinting) and puts out fire; two sources make a third. **Lava** flows 3 blocks
  (every 30 ticks); standing in it deals 4 damage (armor applies) and sets you alight for 15 s. Water
  hardens a lava source into **obsidian** and flowing lava into **cobblestone**; lava falling into water
  makes stone. Pouring onto a cobweb washes it away.
- **Cobwebs**: movement × 0.25 horizontally and × 0.05 vertically, velocity wiped every tick (so
  knockback does nothing) and no fall distance (so no crits).
- **Golden head** (server item): 1 s to eat, Regeneration III for 5 s (4 hearts), Absorption I for
  2 min, then a 10 s cooldown (the white sweep over its slot).
- **Stuns** (mcpvp.club): an axe disabling a shield also clears the defender's hurt immunity, so the
  follow-up hit lands at once.
- **Power I** bow: +1 arrow base damage. **Piercing I** crossbow: bolts go straight through a raised
  shield.
- **Fall damage**: ⌈fall − 3⌉, through armor (Protection still reduces it); water and webs cancel it.
- **No natural regeneration** in UHC: health only comes back from golden apples and heads.
- **End crystals**: right click places one on obsidian (any face; the floor is grass, not bedrock) if
  the block above is empty and no player or crystal is in the 1 × 2 space above it. Any hit (a click,
  an arrow, a pearl, another explosion) sets it off: a **power 6** explosion centred on the obsidian's
  top face. A left click aimed at a crystal in front of your opponent hits the crystal.
- **Explosions** (vanilla ServerExplosion): damage = (impact² + impact) / 2 × 7 × 2·power + 1, where
  impact = (1 − distance / (2·power)) × the share of points on your hitbox with a clear line to the
  centre. A crystal on obsidian at knee height is half hidden behind its own obsidian, so it deals far
  less than one at your feet. That is why crystal fights dig in: the Crystal arena has 4 layers of
  diggable ground (grass, dirt, then bedrock), and obsidian set into a crater puts the crystal at foot
  level. Knockback = impact, minus explosion knockback resistance (Blast Protection IV on two pieces
  cancels it). Blocks break along 16³ rays that lose strength with each block's blast resistance
  (obsidian and anchors 1200 survive; grass, dirt and glowstone don't). Dropped items in the blast are
  destroyed, and nearby crystals chain.
- **Protection by damage type**: Protection gives 1 EPF per level against everything, Blast Protection
  2 per level against explosions, Feather Falling 3 per level against falls (and pearl landings); the
  total is capped at 20 (80%). The Crystal kit hits the cap against explosions.
- **Hurt immunity** still applies: a blast within 10 ticks of the last one only deals what it exceeds
  it by, so timing your crystals matters.
- **Respawn anchors**: glowstone (in either hand) adds a charge, up to 4; right click a charged anchor
  with anything else and it explodes with **power 5** and sets fire around it. Sneak to place blocks
  against an anchor instead.
- **Ender pearls**: 1.5 blocks/tick, gravity 0.03. You land where it hit, take 5 fall damage (1 through
  Feather Falling IV + Prot IV), and it goes on a 1 s cooldown. Pearls set off crystals.
- **Quick Charge III** loads a crossbow in 0.25 s; **Multishot** fires three arrows (the side two
  can't be picked up). **Slow Falling** tipped arrows give 30 s of Slow Falling (1/8 of the potion).
- **Netherite Axe**: 10 damage, 1.0 attack speed, disables shields like any axe.
- **Shield durability** (336): blocking a hit of 3+ damage costs 1 + that damage (Unbreaking applies,
  Mending repairs it); at 0 it breaks.
- **Sweeping Edge**: a full-charge sword hit on the ground — no crit, no sprint knockback, barely moving
  — is a sweep (arc and sound). It would also hit anyone within a block of your target; in a duel there
  is no one else, so it changes nothing else.
- **Swift Sneak III**: sneaking at 75% of walking speed instead of 30%.
- **Mace**: 6 damage, 0.6 attack speed. A hit while falling more than 1.5 blocks (and not gliding)
  is a **smash**: +4 per block for the first 3 blocks, +2 per block up to 8, then +1 per block,
  added after the cooldown and crit multipliers; **Density** adds 0.5 per level per block. The hit
  stops your fall (no fall damage). **Breach** takes 0.15 per level straight off the target's
  armor reduction fraction. **Wind Burst** (after a smash) is a knockback-only gust at your feet:
  ×1.2 / ×1.75 / ×2.2 — Wind Burst III throws you ~24 blocks up — which also pushes the target.
  The HUD's next-hit line shows `SMASH +N` while a smash is on.
- **Wind charges**: thrown straight along the crosshair at 1.5 blocks/tick (no gravity), 0.5 s
  cooldown; they burst on impact (power 1.2, knockback ×1.22, 1 damage on a direct hit). One at
  your feet launches you ~7 blocks. A fall that ends above the height a gust launched you from
  deals no fall damage.
- **Elytra**: right click an armor piece in your hand to swap it with the one you wear (the elytra
  goes in the chest slot — no armor points). Jump in mid-air to glide: vanilla elytra physics
  (look down to gain speed, up to trade it for height), a 0.6-block hitbox, fall distance held at 1
  unless you dive faster than 0.5 blocks/tick, 1 durability per second, and (speed lost × 10) − 3
  damage for flying into a wall. Swap the chestplate back on to stop gliding — then smash.
- **Golden apple**: 1.5 s to eat (vanilla is 1.6 s; change `GOLDEN_APPLE_EAT_TICKS` in
  `src/core/constants.ts`). Eating slows you to 20% speed. It gives Regeneration II for 5 s,
  Absorption I for 2 min, 4 hunger and 9.6 saturation.

## The bot

The bot only presses keys, moves the mouse and clicks, with a reaction delay and aim error
that depend on its tier. It plays with the same physics and combat rules you do. It:

- times hits to the cooldown (half-swings on LT2+), W-taps and S-taps after sprint hits
- goes for jump crits, jump-resets, hit-selects and circle strafes
- keeps its spacing while its sword recharges, and backs out of combos
- **retreats when its health is low**: it lands a last knockback hit, runs (sprint-jumping on
  LT2+), eats golden apples once it's far enough away, and comes back once it has healed
- punishes you with crits when you eat

In the **Axe** kit it also plays the shield game:

- raises its shield when your weapon is about to be charged and its own is not (it tracks your swings
  and your held item's cooldown, and needs the 5-tick raise lead to be safe), and drops it for a tick to
  hit back
- disables your shield with the axe — **LT2 and up attribute-swap** (axe in hand and swing on the
  same tick, sword damage and cooldown), lower tiers pull the axe out and commit to it
- goes all in with sword crits for the 5 s your shield is down, and reads your axe: higher tiers lower their
  shield and hits you when you pull yours out
- loads the crossbow when you keep your distance and shoots it (and the bow on HT3+) with ballistic
  aim and lead, stops when you close in
- Practice keeps its shield up at you and never swings — a shield-disable drill

In **NethPot** it plays the pot game:

- throws Strength, Speed and Fire Resistance at the start and re-applies them when they run out
  (LT4+), fetching them from the inventory — the inventory takes real time to open, and it can't
  move or attack while it's open
- pots by looking straight down and backing off, at a health threshold that rises with tier
  (HT1 pots below 6 hearts, two pots back to back when it's low); lower tiers aim sloppily
  and waste some of each pot
- re-totems after a pop: slot key + F from a hotbar totem on LT3+, through the inventory below that,
  and restocks the hotbar totem and healing pots when it has room
- mends its armor with XP bottles in the gaps knockback opens, and eats a golden apple for absorption
  when you are far away
- goes for jump crits and **P-crits** (LT2 55%, LT1 80%, HT1 90% of the times you hit it)

In **UHC** it plays the Axe-kit shield game (with stuns) plus:

- pours **lava** at your feet when you're 2–4 blocks away and not fire-resistant, then picks it back
  up once you've burned (LT3+), and never walks into lava itself
- **webs** you as you come in, or itself when it's being comboed low (LT4+)
- puts itself out with a **water** bucket at its feet, washes webs off, and picks the water back up
- eats a **golden head** the moment it's low and the head is off cooldown
- **pillars** three blocks up to eat golden apples when you're 6–12 blocks off (LT2+; any closer and
  your axe would have it down in 4 ticks), and **mines** the pillar
  out from under you — or any planks between you — with its Efficiency III axe
- shoots you off a pillar with its crossbow

In **Diamond Pot** it plays for combos instead: with normal knockback, Speed II and Strength II the
damage comes from sprint-hit chains (W-/S-taps between hits), with crits only as a bonus. When it is
being comboed low on health it sprints out of range (LT4+), **run-pots** — sprinting away and
throwing at its feet so the potion lands under it — keeps Strength, Speed and Regeneration up, and eats
steak from the off hand before its hunger gets low enough to stop sprinting.

In **Crystal** it plays the crystal game. Every few ticks it scores each option near you by
the damage it would deal you after armor minus (per tier) what it would cost itself, per tick it takes, and never
picks one that would kill it without a totem:

- **hits a crystal** that is already standing (LT3+ also sets off yours when that hurts you more)
- **crystals obsidian** that is already there, or **places obsidian, then a crystal, then hits it** —
  crosshair on each face, with a click gap that shrinks from 8 ticks (LT5) to 0 (HT1)
- **anchors** you (LT4+): places an anchor next to you, charges it with glowstone, then switches to
  its totem slot and clicks it
- waits out your hurt immunity before it blows anything up (LT2+)
- **surrounds** itself when it is low and you are close (LT2+): steps to the middle of its block and puts
  an ender chest on each side (fetched from the inventory; crystals can't go on them), then eats
  inside and stays there until it has healed
- **digs** (LT2+): when you are eating or walled in, digs the grass beside you, sets obsidian into the
  hole and crystals it at your feet; and **mines your surround** open with the pickaxe
- shoots the **crossbow** (Quick Charge III, Multishot, Slow Falling arrows) when you are out of crystal
  range (LT3+)
- re-totems, restocks its hotbar, eats golden apples, buffs with Strength and Speed, mends with XP
- pearls in when you are far away (HT5+) and pearls out when it is about to die with no totems
  left (HT3+); falls back to the sword when nothing is worth blowing up, and jumps out of craters

Anchors do most of the damage on flat ground; once craters open up, foot-level crystals take over.
Utility items (potions, XP, the pickaxe, ender chests) take turns in one hotbar slot and the item
they displaced is restocked afterwards. In **UHC** it likewise fetches spare water and lava buckets,
planks and the bow from the inventory in quiet moments, and the pickaxe when stone or obsidian is in
its way.

In **SMP** it plays the Axe-kit shield game with the netherite axe (attribute-swapping it on LT2+) and:

- throws Strength and Speed, and Fire Resistance whenever your Fire Aspect has it burning; mends
  with XP in the gaps; refills its hotbar potions, apples and pearls from the inventory
- retreats to eat golden apples; LT2+ lands the parting hit with the **Knockback sword swapped in on
  the same tick** (the charged sword's cooldown, Knockback I's push)
- has one totem, which only works from a hand: at 7 HP or less with you close it swaps the totem into
  its off hand in place of the shield, and puts the shield back once it is safe (or the totem popped)
- pearls in when you run far (HT5+) and pearls out once per retreat when you are still on it (HT3+)

In **Mace** it sprints in and throws a wind charge at its feet (looking straight down) to get
above you, steers over you in the air and smashes on the way down with whichever mace does more
against your armor from that height (Density V from high up, Breach IV from low — LT4+). Wind
Burst throws it back up for the next one. From up there, if you have moved away (LT3+), it swaps
the elytra on at the top, glides over, dives steeply so the fall distance builds, swaps the
chestplate back and smashes. Against your smashes it sidesteps (LT4+) or raises its shield
(LT2+). On the ground it fights with the sword and axe, buffs, eats and re-totems. Higher tiers
launch more often, steer better and wait for a bigger fall before hitting.

## Project layout

```
src/core      constants (all vanilla values), math, rng
src/game      Fighter (movement/inventory/items/effects/durability/mining), combat, Arrow, Thrown (potions, XP bottles),
              XpOrb (mending), Blocks (placed blocks, collision, raycasts, water/lava flow), DroppedItem,
              Explosion, EndCrystal, crystals (placing, hitting, anchors),
              Match (tick order), Game (glue), kits, items
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
