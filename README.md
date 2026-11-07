# All Contribute (prototype)

A Minecraft-like, browser-based MMO prototype with player-authored blocks and recipes.

## What this is

- Static frontend suitable for GitHub Pages.
- Cloudflare Worker API at `https://all-contrib.all-contrib.workers.dev`.
- Cloudflare D1 database for accounts, block definitions, recipes, inventories and world edits; one Durable Object (`WorldLive`) fans out live world changes over WebSocket.
- Passwords are hashed with PBKDF2 (never stored in plaintext; 100,000 iterations due to the Workers Web Crypto limit).
- Authentication uses Secure, HttpOnly, SameSite=None, Partitioned cookies rather than JavaScript-readable bearer tokens.
- Sessions expire after 7 days without an authenticated API request, or 30 days after sign-in, whichever comes first.
- Players can inspect active sessions and revoke other devices; logout revokes the current session server-side.
- Built-in blocks (`builtin:stone`, owner `SYSTEM`) cannot be edited; custom blocks can only be edited by their creator.
- A block/recipe definition is validated as data, not executed as arbitrary JavaScript. Placement behaviour is declarative (`rules_json`: `support` + `incompatibleWith`); conflicting blocks refuse placement or break, they never crash the game. See `GLOSSARY.md` and `docs/adr/0001-staged-behaviour-model.md`.
- **Server-authoritative shared world**: the world is a 3D voxel volume addressed by `(x, y, z)` (y up from bedrock). Base terrain — height-map over x/z, layered soil columns, caves, trees — is deterministic and byte-identical in Worker and browser (`backend/src/terrain.ts` mirrored in `frontend/dve/src/world.js`); only player edits are stored (sparse). Placing/breaking goes through the API with 3D occupancy and support validation; a WebSocket via the `WorldLive` Durable Object pushes edits to every connected client, with `world_log`-cursor polling as fallback. See `docs/adr/0002-server-world-before-dve.md`.
- **Fullscreen 3D game via Divine Voxel Engine (DVE)**: the page opens on a main menu; **Join** boots a first-person voxel game rendered with Babylon.js (`@divinevoxel/vlox` + `vlox-babylon`). WASD movement under gravity with **Space** to jump (voxel AABB collision), mouse look (pointer lock, drag-look fallback), a hotbar (1–9), crosshair targeting; **Esc** opens a pause menu hosting settings, inventory, character, studio, and account. Every 3D click goes through the identical `POST /api/world/place|break` round-trip in `(x, y, z)`, and voxels are painted **only** from server-echoed edits over the WebSocket. If WebGL is unavailable the loading overlay reports it. See `frontend/dve/` below.
- **Creator studio for authors**: in-game (press **B**) you create **blocks** (hardness, light, colour, behaviour, support/incompatibility) and **items** — the item is what the player holds, and a placeable item is *programmed* with the block it drops into the world (`place_block_id`). Both can be edited and deleted by their creator only; built-ins are immutable. See `docs/adr/0001-staged-behaviour-model.md`.
- **Items, tools and weapons**: the `items` registry holds kinds `block` (places a block), `tool` (mining speed), `weapon` (attack damage), `food` (heals), `material` (crafting only), each with declared stats — never code. Built-ins seed a pickaxe/axe/shovel, a sword, an apple, a stick, planks and one placeable item per built-in block.
- **Mobs, health and death**: the `WorldLive` object simulates up to 12 mobs on the terrain surface — hostiles (`zombie`) chase the closest living player inside a 40-block **sphere** and hit them within 1.8 blocks in 3D (the Y axis counts: a zombie standing under your feet cannot reach a player two blocks up), peaceful ones (`pig`) wander — and broadcast full snapshots every 250 ms. Chase/attack ranges are spherical, mob steering stays horizontal. Health (20 = 10 hearts) lives in `player_state.health`; hitting zero shows the death screen and releases the cursor, `POST /api/player/respawn` restores you and takes the cursor back. Weapons/tools attack mobs (6-block reach, also spherical), food heals (`F`).
- **Customisable avatars**: four saved colours per account — head, body, legs and **eyes**. The eyes are two boxes on the front of the head in the 3D avatar (and two dots in the character preview), so other players can read which way you are facing; they ride the presence frames and re-colour live. The site has its own `favicon.svg` (an ink-outlined grass block under an amber sun, matching the paper-and-ink design system).
- **Sky**: an emissive sun and moon orbit on a tilted axis driven by the shared epoch clock (same 24-minute day as the sky colour), rendered in group 0 so terrain occludes them.
- **Client settings** (localStorage): sensitivity, FOV, render distance, movement speed, and a server selector — the global production Worker or a local dev Worker (local option only over `http://`).
- **Server-side inventory**: stacks live in D1 per account; placing debits, breaking credits, crafting is validated and applied server-side. Old browser-local stacks are uploaded once per account automatically.

This is a starter project, not a production MMO. It lacks authoritative movement (physics is client-side presentation over the deterministic mirror), anti-cheat, rate limiting, moderation, and production-grade account recovery.

## Files

- `frontend/index.html` — game shell: fullscreen canvas + HUD, dialogs (pause, settings, inventory, block manager, account), no landing page
- `frontend/styles.css` — styling
- `frontend/app.js` — frontend: game boot (imports the DVE view, then creates it), pause menu + settings/server selector, HUD/hotbar, inventory + block-manager dialogs, login/register, API calls, shared-world edit state + live sync, 3D game wiring
- `frontend/dve/` — Divine Voxel Engine bundle: `src/` (Babylon + vlox integration: `main.js`, `world.js` — the client-side terrain mirror, worker scripts, flag driver in `world.worker.js`), `build.mjs` (esbuild bundle), committed pre-built `dist/` (no build step at deploy)
- `backend/src/index.ts` — Cloudflare Worker API
- `backend/src/terrain.ts` — deterministic 3D base terrain (mirrored byte-for-byte in `frontend/dve/src/world.js`; parity is testable by exhaustive diff over the world bounds)
- `backend/wrangler.jsonc` — Worker/D1/Durable Object configuration
- `backend/package.json` — backend dependencies/scripts
- `backend/tsconfig.json` — TypeScript configuration
- `backend/schema.sql` — D1 tables and built-in block seed (cumulative source of truth)
- `backend/migrations/0001_init.sql` — the same schema as a ledger-tracked migration (idempotent `IF NOT EXISTS`)
- `GLOSSARY.md` — domain vocabulary
- `docs/adr/` — architecture decision records (behaviour model, server-world-first)
- `.gitignore` — ignores local secrets/build output

## 1. Prepare the D1 database

Install Node.js (LTS), then:

```bash
cd backend
npm install
npx wrangler login
```

### New or current databases

Create the database (new only):

```bash
npx wrangler d1 create all-contribute-db
```

Wrangler prints a database ID. Put that ID in `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Then apply the migrations (this records them in D1's migration ledger, so future `wrangler dev`/`deploy` runs know the schema is current):

```bash
npx wrangler d1 migrations apply all-contribute-db --remote
```

`migrations/0001_init.sql` is a copy of `schema.sql` — the cumulative table definitions and built-in block seed. It is idempotent (`CREATE TABLE IF NOT EXISTS`), so it is safe even on a database already provisioned from `schema.sql`.

### Databases older than the rebased baseline

The migration chain was rebased: the earlier one-time migrations (session lifetimes, `minecraft:` → `builtin:` rename, world/inventory tables) are folded into `0001_init.sql`. A database already at that history needs no action — applying `0001_init.sql` matches nothing. A genuinely ancient database (before those changes) is not auto-upgraded by the baseline: recreate it (`wrangler d1 delete` + `create` + migrations) or add the missing pieces by hand (`sessions.session_id`/`idle_expires_at`/`last_seen_at`, `blocks.rules_json`, `inventories`/`world_edits`/`world_log`, `builtin:` rename).

The new Durable Object (`WorldLive`) needs no database work: `wrangler deploy` provisions it from `wrangler.jsonc`'s `migrations` entry. If you deploy onto a Worker that previously ran the Cloudflare template's `MyDurableObject`, the stale class blocks new deploys; the clean fix is `npx wrangler delete --name all-contrib` followed by a redeploy (D1 data is a separate resource and survives).

### World model v2 (`0005_world_3d.sql`)

The world moved from a 2D grid to true 3D `(x, y, z)` coordinates. `0005_world_3d.sql` drops and recreates `world_edits`/`world_log` with a `z` column and y-up semantics, and seeds the two new built-in blocks (`builtin:leaves`, `builtin:bedrock`). Old 2D-era edits do not translate to the new coordinate system: **applying 0005 to a deployed database resets the shared world** (accounts, blocks, recipes and inventories are untouched). Accounts that placed blocks before the upgrade keep their inventories but wake up in the new terrain.

## 2. Deploy the API

The Worker name is configured as `all-contrib`. When updating an existing installation, **keep your existing `wrangler.jsonc` and its real D1 `database_id`**; do not replace it with a copy containing the placeholder ID. Deploy:

```bash
npx wrangler deploy
```

Expected API origin:
`https://all-contrib.all-contrib.workers.dev`

If Cloudflare gives you a different URL, update `API_BASE` in `frontend/app.js`.

## 3. Publish the frontend on GitHub Pages

Put the contents of `frontend/` in the root of a GitHub repository (or configure Pages to publish that folder using a supported workflow). Include the pre-built `frontend/dve/dist/` directory — the 3D bundle is committed, so Pages needs no build step. Simplest:

1. Create a repository named `all-contribute`.
2. Copy `frontend/index.html`, `frontend/styles.css`, `frontend/app.js` and the whole `frontend/dve/` folder into its root.
3. GitHub → Settings → Pages → Deploy from a branch → `main` → `/ (root)`.
4. Wait for the Pages URL to appear.

The frontend has no build step.

### Rebuilding the 3D bundle

Only when you change `frontend/dve/src/`:

```bash
cd frontend/dve
npm install          # once; pulls @divinevoxel/vlox + vlox-babylon + babylonjs
npm run build        # esbuild → frontend/dve/dist/ (commit the output)
```

`npm run build` also writes `dve/dist/rev.js` (a committed build artifact) — content hashes of every bundle — and both `app.js` and the view import/bundle their scripts as `?h=<hash>`. Without that, GitHub Pages' caching pins whatever `dve-view.js` a browser first fetched, and a stale bundle throws at calls only newer app.js makes (e.g. `grabPointer is not a function`). Run the build **twice** after changing sources: the first pass seeds the manifest the second pass inlines. Bump `?v=` on `app.js`/`styles.css` in `index.html` when app.js changes.

Known limitations of the 3D game:

- Block textures are compiled once when the game view is first created; publishing a new block mid-session paints with a placeholder color until the page is reloaded.
- The client renders a 256×32×256 walkable field (`SLAB` in `frontend/dve/src/world.js`; camera clamped to its lip). The generator focus follows the player: `main.js` posts `move-generator` whenever the player crosses a 16-block cell and vlox re-rings its active sectors — chunks generate ahead and drop behind. The generator runs render 48 / generation 96 / max 96, so generation spans the entire active ring and no sector ever sits on a generation boundary. The API is looser — `worldCoords` accepts x/z in ±1,000,000 and y in 0..31 — so the region is a rendering/authority convention, not a storage limit.
- Terrain is byte-identical in `backend/src/terrain.ts` and its mirror `frontend/dve/src/world.js`. Changing it means changing both in lockstep — a desync renders one terrain in the head and edits validated against another (the generator fetches only sparse edits from the API).
- Walking physics is client-side presentation: gravity, Space-jump, and voxel AABB collision run in `main.js` against the client's authoritative cell mirror (synced `worldEdits` + the `terrain.ts` mirror). The server validates block edits, never the player's body. No step-up (a one-block ledge needs a jump), no fall damage; blocks pushed into the player by other players' edits only pop them up if the block rises into their feet.
- Stock vlox 0.0.72 deadlocks its generation/lighting queues at fixed-radius borders and wedges its Builder `paint-voxel` task (`LockSectors` awaits sectors checked out for mesher transfer forever; the world thread's voxel palette lands at an offset); `frontend/dve/src/world.worker.js` carries the compensations — the `driveSlabPipeline` link-and-flag maintenance driver, `shiftLUTToPalette` LUT re-alignment, and a `paint-direct` simulation-brush task used by `applyEdit`. Do not "simplify" any of them without re-testing distant sectors and click-breaking placed blocks.
- Under heavy CPU load (e.g. headless Chromium with swiftshader in CI) the mesher→main section deliveries can stall part-way through the initial build: the centre renders and pixel-proves fine, but far sectors may lag. This is vlox backpressure under starvation, not data loss.
- Presence avatars are presentation frames on the world WS (`pose` ~4 Hz carrying the saved appearance colours, `who` roster pull, 60 s staleness sweep). A hidden browser tab halts rAF, so a backgrounded player's avatar freezes in everyone else's view — cosmetic, and it self-heals when the tab is focused again. The DO sanitizes `appearance` down to the four `#rrggbb` colour keys; presence remains presentation-only and is never validated like a block edit.
- Presence carries `vx,vy,vz` so receivers dead-reckon between frames (`advanceRemotes` in `frontend/dve/src/main.js`): extrapolation is capped at 0.6 s of velocity, ground-clamped, and refused when it would drop a prediction inside the local camera. It is smoothing, never authority — the next real pose wins.
- Mobs are simulated inside the `WorldLive` object on a 250 ms storage alarm and broadcast as full 4 Hz snapshots; clients only interpolate (`setMob`/`advanceMobs`) and a 5 s silence prunes the mesh. Mob `y` is the terrain surface from the `terrain.ts` mirror raised above recorded player edits, so a mob can hover over a column someone excavated or walk through a decoration it was never told about, and nothing pathfinds. Attacks are client-claimed (`attack {mob_id, item_id}`) and bounded by the object — the item must be `weapon`/`tool`, its `damage` from the items row decides the hit, and the mob must be within 6 blocks — never by who actually aimed.
- Health lives in `player_state` with the object as runtime source of truth (REST `respawn`/`eat` write D1 and notify the object over internal `fetch`); the object ignores a dead player's own `pose` frames, so the body freezes in place — but parking the local body is client presentation (`setFrozen`), the authority is the object. Death also releases the pointer lock deliberately, and the cursor stays free until respawn: the view's canvas `pointerdown` refuses to re-lock while the body is frozen, the menu-close re-grab and the Esc-opens-pause path both check that the death screen is hidden, and the full-screen death overlay hit-tests in front of the canvas anyway.
- Items and blocks are two registries: `world_edits`, `world_log` and WS `edit` frames carry **block** ids, never item ids. An item's "programme" is declarative — `place_block_id` — not code. Placing debits the item and writes that block; breaking a cell credits back the first item that programmes that block (built-in first, then lowest id), so two different items that programme the same block credit deterministically but not as "the exact stack you placed".
- Every Babylon mesh this app adds (avatar parts, name cards, glow cubes) must set `renderingGroupId = 1`. vlox draws its voxel sections in group 1, and Babylon clears the depth buffer between rendering groups — a group-0 mesh is painted over by voxels that are *behind* it, which looks like players showing through walls. Keep new meshes in `VOXEL_GROUP` (`frontend/dve/src/main.js`).
- The day/night cycle is a shared epoch clock (`Date.now() % 24 min`): every client picks the same phase without sync, but the phase follows wall-clock UTC, not any server-side game calendar.
- Glowing blocks (registry `light > 0`) glow via a Babylon GlowLayer emissive cube per cell; the vlox light pipeline remains disabled, so glow is a render overlay, not propagated lighting.

## 4. CORS

The Worker currently permits:
- `https://*.github.io`
- `http://localhost:...` for local development

If you use a custom domain for Pages, add its exact origin to `allowedOrigin()` in `src/index.ts`.

## 5. Local frontend test

Backend (needs Node 22+ for wrangler 4):

```bash
cd backend
npx wrangler d1 migrations apply all-contribute-db --local   # fresh local DB only
npx wrangler dev                                             # http://127.0.0.1:8787
```

On a fresh checkout (or after deleting `.wrangler/state`) the local D1 is empty and every query fails with `no such table` — run the migrations command above once first (stop `wrangler dev` while it runs; two wrangler processes on the same local DB lock each other). `wrangler dev` persists to `.wrangler/state` by default; if you pass `--persist-to`, pass it to the `d1` commands too.

Frontend: serve `frontend/`; the page opens the main menu — **Join** starts the game. In-game keys: **WASD**/**Space** move and jump, mouse look (pointer lock, "Grab cursor" HUD button re-grabs it), left-click break (or attack, when a weapon/tool is selected and a mob is under the crosshair), right-click place, **1–9** hotbar, **F** eat the selected food, **C** character, **I** inventory, **B** studio, **Esc** pause (Esc while the pointer is locked exits the lock and opens the pause menu in the same press; while dead Esc does nothing — dying releases the cursor so the death screen's Respawn/Menu buttons are clickable, and respawning hands the cursor back to the game). The same control brief also floats over the world for ten seconds after joining — loaded or not — and is available any time as **Instructions** in the main menu and the pause menu. Pick the local Worker in **Menu → Settings → Server → Local dev** (the option only appears on `http://` pages — no code edit, it persists in localStorage):

```bash
cd frontend
python3 -m http.server 8000
```

Visit `http://localhost:8000`. The Worker allows the `http://localhost:8000` origin, and the live world socket connects to `ws://127.0.0.1:8787/api/world/live`.

## API endpoints

- `GET /api/health`
- `POST /api/register` `{ username, password }`
- `POST /api/login` `{ username, password }`
- `GET /api/me` (HttpOnly session cookie)
- `POST /api/logout` (revokes this device's session)
- `GET /api/sessions` (lists active devices)
- `DELETE /api/sessions/:session_id` (revokes another device)
- `GET /api/blocks`
- `POST /api/blocks` (HttpOnly session cookie; creates a custom block)
- `PUT /api/blocks/:id` (creator only)
- `DELETE /api/blocks/:id` (creator only; refuses built-ins and unknown IDs. Deleting cascades: every `world_edits` cell holding that block is cleared and broadcast as air, recipes that reference it are removed, and inventory stacks of it are dropped.)
- `GET /api/recipes` (includes `creator` so the owner can manage their own list)
- `GET /api/items` (held things: `kind` ∈ `block|tool|weapon|food|material`, `place_block_id` is a placeable item's programme, plus `damage`/`speed`/`heal`/`durability`)
- `POST /api/items` (session; a `block` item must name an existing `place_block_id`), `PUT /api/items/:id`, `DELETE /api/items/:id` (creator only; built-ins immutable; deleting clears inventory stacks and referencing recipes)
- `POST /api/recipes` (HttpOnly session cookie; creates recipe)
- `PUT /api/recipes/:id` / `DELETE /api/recipes/:id` (creator only; PUT re-validates with the same rules as POST and keeps the existing name if `name` is omitted)
- `POST /api/recipes/craft` (session; validates ingredients and result server-side, one batch)
- `GET /api/inventory` (session)
- `POST /api/inventory/add` / `POST /api/inventory/remove` / `POST /api/inventory/clear` (session; grant tools — the frontend only shows the "Add test items" form to the `admin` account)
- `GET /api/world?x0&y0&z0&x1&y1&z1&since` (public read: sparse edits in a voxel volume — max 20,000 rows — plus `world_log` entries after a cursor)
- `POST /api/world/place` `{x, y, z, item_id}` (session; the ITEM is validated: only a `kind='block'` item with a `place_block_id` can be placed — `code:"not_placeable"` otherwise — the placement rules run against that BLOCK row, the item stack is debited, and `world_edits` stores the block id. Refusals on `occupied`/`no_support`/`incompatible`/`no_item` debit nothing; the block's support rule is evaluated against the voxel beneath, and `incompatibleWith` scans the six neighbours)
- `POST /api/world/break` `{x, y, z}` (session; credits the ITEM that programmes the dropped block — `SELECT id FROM items WHERE place_block_id=? ORDER BY is_builtin DESC` — refusing empty voxels, unbreakable blocks such as bedrock (`code:"unbreakable"`), and a stack at 999)
- `GET /api/player/state` (session; saved spawn/look, saved `appearance` colours, and `health`) / `POST /api/player/state` (session; persists position, yaw and pitch)
- `POST /api/player/respawn` (session; health back to 20, position to the surface spawn; also tells the live object to clear the dead flag)
- `POST /api/player/eat` `{item_id}` (session; a `kind='food'` item with `heal > 0`, consumes one from the stack, health capped at 20)
- `POST /api/player/appearance` (session; `{body_colour, head_colour, accent_colour, eye_colour}` as `#rrggbb`, upserted into `player_appearance`)
- `WS /api/world/live` (Durable Object fan-out; sends `{"type":"edit","x","y","z","block_id"}` to every connected client, presence frames — a client posts `{"type":"pose",name,x,y,z,yaw,appearance,vx,vy,vz}` and the object relays it plus a `roster` on `who` and a `leave` on disconnect; appearance colours are whitelisted server-side — and mob frames: `{type:"mobs",mobs:[{id,kind,x,y,z,yaw,hostile,hp}]}` ~4 Hz, `{type:"hurt",amount,by,health}`, `{type:"health",health}`, `{type:"died",by}`, `{type:"respawn",health,state}`. Clients send `{type:"attack",mob_id,item_id}`; only weapon/tool items register, and the object re-checks the distance.)

## Security notes before public launch

- Add email verification, password reset, moderation/reporting, rate limits, audit logs and account deletion.
- Add strict request size limits and stronger abuse controls.
- Do not execute submitted source code on the Worker. This scaffold stores a constrained behaviour JSON description only.
- Never put Cloudflare API tokens in frontend files or Git.
- The frontend and Worker currently use different sites (`github.io` and `workers.dev`). The Worker therefore sets a partitioned cross-site cookie (`SameSite=None; Secure; HttpOnly; Partitioned`) and the frontend uses credentialed CORS. Modern Chromium browsers support this cookie model, but privacy settings or browsers without partitioned-cookie support may block it. A custom frontend domain and Worker API hostname under the same registrable domain is the more portable long-term arrangement.
- CORS currently permits HTTPS GitHub Pages origins and localhost development. Restrict this to your exact GitHub Pages origin once the account/repository URL is settled.
- The 7-day inactivity timer is refreshed by authenticated API requests (throttled to one D1 write per 15 minutes); the 30-day absolute expiry is never extended.
- A public game needs server-authoritative simulation and persistence; this scaffold provides the account/content API plus a small shared-world layer (deterministic terrain, edits-only storage, Durable Object fan-out). Mob simulation and health now live in the `WorldLive` object, but attacks are still *reported* by the client (the object validates the item kind and the distance, not the swing), there are no owned servers or anti-cheat, and client-side chunk streaming around the player is in place.
