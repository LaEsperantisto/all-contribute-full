# All Contribute (prototype)

A Minecraft-like, browser-based MMO prototype with player-authored blocks and recipes.

## What this is

- Static frontend suitable for GitHub Pages.
- Cloudflare Worker API at `https://all-contrib.all-contrib.workers.dev`.
- Cloudflare D1 database for accounts, block definitions, and recipes.
- Passwords are hashed with PBKDF2 (never stored in plaintext; 100,000 iterations due to the Workers Web Crypto limit).
- Authentication uses Secure, HttpOnly, SameSite=None, Partitioned cookies rather than JavaScript-readable bearer tokens.
- Sessions expire after 7 days without an authenticated API request, or 30 days after sign-in, whichever comes first.
- Players can inspect active sessions and revoke other devices; logout revokes the current session server-side.
- Built-in blocks cannot be edited; custom blocks can only be edited by their creator.
- A block/recipe definition is validated as data, not executed as arbitrary JavaScript.
- The browser demo includes a small 2D voxel-like prototype. **DVE is not yet wired into this scaffold**: integrate Divine Voxel Engine after you have installed its packages and selected its rendering/worker setup. This avoids pretending an unverified DVE API is already working.

This is a starter project, not a production MMO. It lacks authoritative movement, chunk persistence, anti-cheat, rate limiting, moderation, and production-grade account recovery.

## Files

- `frontend/index.html` — page shell
- `frontend/styles.css` — styling
- `frontend/app.js` — frontend: login/register, API calls, block editor, recipe editor, demo world
- `backend/src/index.ts` — Cloudflare Worker API
- `backend/wrangler.jsonc` — Worker/D1 configuration
- `backend/package.json` — backend dependencies/scripts
- `backend/tsconfig.json` — TypeScript configuration
- `backend/schema.sql` — D1 tables and built-in block seed
- `backend/migrations/0002_session_lifetimes.sql` — one-time migration for an existing D1 database
- `.gitignore` — ignores local secrets/build output

## 1. Prepare the D1 database

Install Node.js (LTS), then:

```bash
cd backend
npm install
npx wrangler login
```

### If this is a brand-new database

Create it:

```bash
npx wrangler d1 create all-contribute-db
```

Wrangler prints a database ID. Put that ID in `wrangler.jsonc`, replacing `REPLACE_WITH_D1_DATABASE_ID`. Then initialise the database:

```bash
npx wrangler d1 execute all-contribute-db --remote --file=./schema.sql
```

### If you already have the earlier All Contribute database

Do **not** recreate it and do not run `schema.sql` again as a substitute for the migration. Run this one-time migration instead:

```bash
npx wrangler d1 execute all-contribute-db --remote --file=./migrations/0002_session_lifetimes.sql
```

The migration adds session IDs, last-activity timestamps and idle-expiry timestamps. It deliberately deletes old session rows, so every device must sign in once after this update. It preserves user accounts, blocks and recipes. **Do not run the migration a second time.**

## 2. Deploy the API

The Worker name is configured as `all-contrib`. When updating an existing installation, **keep your existing `wrangler.jsonc` and its real D1 `database_id`**; do not replace it with a copy containing the placeholder ID. Deploy:

```bash
npx wrangler deploy
```

Expected API origin:
`https://all-contrib.all-contrib.workers.dev`

If Cloudflare gives you a different URL, update `API_BASE` in `frontend/app.js`.

## 3. Publish the frontend on GitHub Pages

Put the contents of `frontend/` in the root of a GitHub repository (or configure Pages to publish that folder using a supported workflow). Simplest:

1. Create a repository named `all-contribute`.
2. Copy `frontend/index.html`, `frontend/styles.css`, and `frontend/app.js` into its root.
3. GitHub → Settings → Pages → Deploy from a branch → `main` → `/ (root)`.
4. Wait for the Pages URL to appear.

The frontend has no build step.

## 4. CORS

The Worker currently permits:
- `https://*.github.io`
- `http://localhost:...` for local development

If you use a custom domain for Pages, add its exact origin to `allowedOrigin()` in `src/index.ts`.

## 5. Local frontend test

From the `frontend` directory:

```bash
python3 -m http.server 8000
```

Visit `http://localhost:8000`.

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

## Security notes before public launch

- Add email verification, password reset, moderation/reporting, rate limits, audit logs and account deletion.
- Add strict request size limits and stronger abuse controls.
- Do not execute submitted source code on the Worker. This scaffold stores a constrained behaviour JSON description only.
- Never put Cloudflare API tokens in frontend files or Git.
- The frontend and Worker currently use different sites (`github.io` and `workers.dev`). The Worker therefore sets a partitioned cross-site cookie (`SameSite=None; Secure; HttpOnly; Partitioned`) and the frontend uses credentialed CORS. Modern Chromium browsers support this cookie model, but privacy settings or browsers without partitioned-cookie support may block it. A custom frontend domain and Worker API hostname under the same registrable domain is the more portable long-term arrangement.
- CORS currently permits HTTPS GitHub Pages origins and localhost development. Restrict this to your exact GitHub Pages origin once the account/repository URL is settled.
- The 7-day inactivity timer is refreshed by authenticated API requests (throttled to one D1 write per 15 minutes); the 30-day absolute expiry is never extended.
- A public game needs server-authoritative simulation and persistence; this scaffold is only the account/content API and visual demo.
