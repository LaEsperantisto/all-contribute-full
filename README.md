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
- **Server-authoritative shared world**: base terrain is deterministic (identical in Worker and browser, `backend/src/terrain.ts` mirrored in `frontend/app.js`), only player edits are stored. The browser canvas places/breaks against the API; a WebSocket via the `WorldLive` Durable Object pushes edits to every connected client, with `world_log`-cursor polling as fallback. See `docs/adr/0002-server-world-before-dve.md`.
- **3D view via Divine Voxel Engine (DVE)**: the "Open 3D" button renders the same server world as a voxel column in a Babylon.js canvas (`@divinevoxel/vlox` + `vlox-babylon`). Voxels are painted **only** from server-echoed edits (the same WebSocket the 2D canvas uses); clicks in the 3D view go through the identical `POST /api/world/place|break` round-trip. If WebGL is unavailable the view shows a plain "3D view unavailable" message and the 2D canvas keeps working. See `frontend/dve/` below.
- **Server-side inventory**: stacks live in D1 per account; placing debits, breaking credits, crafting is validated and applied server-side. Old browser-local stacks are uploaded once per account automatically.

This is a starter project, not a production MMO. It lacks authoritative movement, chunk streaming, anti-cheat, rate limiting, moderation, and production-grade account recovery.

## Files

- `frontend/index.html` — page shell
- `frontend/styles.css` — styling
- `frontend/app.js` — frontend: login/register, API calls, block/recipe editors, shared-world canvas + live sync, 3D view wiring
- `frontend/dve/` — Divine Voxel Engine bundle: `src/` (Babylon + vlox integration: `main.js`, worker scripts, flag driver in `world.worker.js`), `build.mjs` (esbuild bundle), committed pre-built `dist/` (no build step at deploy)
- `backend/src/index.ts` — Cloudflare Worker API
- `backend/src/terrain.ts` — deterministic base terrain (mirrored in the frontend)
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

Known 3D-view limitations:

- Block textures are compiled once at view init; publishing a new block while the 3D view is open won't show its texture until the view is re-opened.
- The world is rendered as a slab: 3D `(x, z)` maps to 2D `(x, 31 - y)` with `z ∈ [0,16)`; only that window is synced from the server (`dveMod.SLAB`).
- Stock vlox 0.0.72 deadlocks its generation/lighting queues at fixed-radius borders; `frontend/dve/src/world.worker.js` contains a persistent link-and-flag driver (`driveSlabPipeline`) that keeps the deterministic slab pipeline dispatching. Do not "simplify" it without re-testing distant sectors.
- Under heavy CPU load (e.g. headless Chromium with swiftshader in CI) the mesher→main section deliveries can stall part-way through the initial 720-section build: the centre renders and pixel-proves fine, but far sectors may lag. This is vlox backpressure under starvation, not data loss.

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

Frontend: serve `frontend/` and point `API_BASE` in `frontend/app.js` at `http://127.0.0.1:8787` for the session (keep the change out of any commit):

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
- `GET /api/recipes`
- `POST /api/recipes` (HttpOnly session cookie; creates recipe)
- `POST /api/recipes/craft` (session; validates ingredients and result server-side, one batch)
- `GET /api/inventory` (session)
- `POST /api/inventory/add` / `POST /api/inventory/remove` / `POST /api/inventory/clear` (session; testing/grant tools)
- `GET /api/world?x0&y0&x1&y1&since` (public read: edits in a ≤4096-cell window + log entries after a cursor)
- `POST /api/world/place` (session; debits inventory, refuses on `occupied`/`no_support`/`incompatible`/`no_item` — a refusal debits nothing)
- `POST /api/world/break` (session; credits the dropped block, refuses when the cell is empty or the stack is at 999)
- `WS /api/world/live` (Durable Object fan-out; sends `{"type":"edit","x","y","block_id"}` to every connected client)

## Security notes before public launch

- Add email verification, password reset, moderation/reporting, rate limits, audit logs and account deletion.
- Add strict request size limits and stronger abuse controls.
- Do not execute submitted source code on the Worker. This scaffold stores a constrained behaviour JSON description only.
- Never put Cloudflare API tokens in frontend files or Git.
- The frontend and Worker currently use different sites (`github.io` and `workers.dev`). The Worker therefore sets a partitioned cross-site cookie (`SameSite=None; Secure; HttpOnly; Partitioned`) and the frontend uses credentialed CORS. Modern Chromium browsers support this cookie model, but privacy settings or browsers without partitioned-cookie support may block it. A custom frontend domain and Worker API hostname under the same registrable domain is the more portable long-term arrangement.
- CORS currently permits HTTPS GitHub Pages origins and localhost development. Restrict this to your exact GitHub Pages origin once the account/repository URL is settled.
- The 7-day inactivity timer is refreshed by authenticated API requests (throttled to one D1 write per 15 minutes); the 30-day absolute expiry is never extended.
- A public game needs server-authoritative simulation and persistence; this scaffold provides the account/content API plus a small shared-world layer (deterministic terrain, edits-only storage, Durable Object fan-out). Owned servers, mobs, and chunk streaming remain future work.
