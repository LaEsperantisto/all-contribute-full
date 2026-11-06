# 2. Build the authoritative shared world before integrating DVE

Date: 2026-11-06
Status: accepted

## Context

The game is an MMO and the plan is to use Divine Voxel Engine as the rendering/game base. DVE integration needs a bundler build step (conflicting with the current no-build GitHub Pages setup) and chunk streaming/persistence designs. The MMO-critical part — one shared world every player edits — is a server problem independent of renderer choice.

## Decision

Build the server-authoritative world first: deterministic base terrain (same function client and server), player edits stored as the only world state, placement/break validated by the engine, live diffs to clients over WebSockets with sequence-numbered polling fallback. DVE becomes a renderer swap-in on top of the same world model later.

## Consequences

- The 2D canvas demo consumes the real shared world immediately; swapping renderers later does not change APIs.
- Free-tier constraints bound scale: writes per placement hit D1; owned per-player servers (namespace whitelists/blacklists, owner-controlled) are a designed but unimplemented next layer, likely mapping one Durable Object per server.
- Base terrain generation must stay byte-identical between client and server; changing it is a world-breaking change needing a version marker.

## Amendment (same day) — DVE integrated, on the maintained package line

The npm package `divine-voxel-engine` (last release 1.2.62, October 2023) is the dormant legacy monolith. The engine's current line is the monorepo split: `@divinevoxel/vlox` (renderer-independent core) + `@divinevoxel/vlox-babylon` (Babylon renderer). The 3D view (`frontend/dve/`) uses those, not the legacy package.

Build-step conflict resolved without giving up static Pages: `frontend/dve/` is a small npm project that bundles the DVE view to pre-built ESM artifacts in `frontend/dve/dist/` (committed). The main `frontend/app.js` still has no build step; it dynamically imports `./dve/dist/dve-view.js`.

Mapping (decided, not incidental): the server world stays the 2D grid. The 3D view renders it as a slab cross-section — `x3d = x2d`, `y3d = 31 - y2d`, `z3d ∈ [0,16)` — over the same 4096-cell API window. All edits in 3D go through `/api/world/place|break` and paint back via the live socket; the renderer never owns world state.

## Amendment (same day) — 3D-first client shell

The 3D view was promoted from an overlay demo to the game itself: "Play" opens a fullscreen first-person client (Babylon FPS camera, WASD, mouse look with pointer lock and a drag-look fallback, walk/fly modes, hotbar, crosshair picking, overlay dialogs for inventory and block authoring). The 2D canvas card survives as a menu preview and the WebGL-less fallback.

This supersedes the "2D canvas demo is the primary client" framing above; nothing about the server contract changes. The same invariants hold in the game: the camera is presentation-only, crosshair clicks resolve to `(x2d, y2d)` through the slab mapping and go through `POST /api/world/place|break`, and the only paint source is the WS echo (`noteEdit → applyEdit`).

Consequences accepted for the prototype:

- The world is a finite 128×32×16 slab, not an infinite stream; the camera is clamped to its lip. Chunk streaming/sector streaming is still out of scope (the free-tier D1/DO limits from the original decision still bound scale).
- Walk mode snaps the eye to the deterministic surface (via the shared `terrainHeight` mirror); there is no collision/physics — blocks placed at head height are clipped through, creative-style. Fly mode is free flight.
- Block textures are registered from the block registry at view creation; blocks created while the game runs paint with a placeholder until the page reloads (registry-at-init caveat, unchanged).
- Block authoring is now part of the game loop (B → block manager: create/edit/delete own blocks), backed by `DELETE /api/blocks/:id` with in-use guards (placed cells, recipe references).

## Amendment (same day) — procedural 3D world; the game is the site

Two changes landed together, both superseding parts of the framing above:

**The 2D slab mapping is gone; the world model is true 3D end to end.** Coordinates are `(x, y, z)` with y up from a bedrock floor, everywhere: the world tables (`0005_world_3d.sql` recreates `world_edits`/`world_log` with a `z` column — stored 2D edits did not translate, so the upgrade resets world data), the API (`place`/`break` bodies, `GET /api/world` volume windows, the `WorldLive` payload), the deterministic terrain generator (`terrain.ts`: integer value-noise height map over x/z, layered columns, trilinear-noise caves, deterministic trees, exported `WORLD_Y`), and the DVE view (finite 96×32×96 region via `SLAB`, single-voxel `applyEdit`). The old `x3d = x2d, y3d = 31 - y2d` mapping and the 2D canvas card are deleted; `frontend/dve/src/world.js` is now the client's terrain mirror, and client/server parity is checked by exhaustive diff of the two implementations over the whole region.

**The landing page is gone: opening the site boots straight into the fullscreen game.** Menus live in dialogs; **Esc** opens a pause menu that hosts settings, inventory, the block manager, and the account panel. The boot order is the invariant: static shell → DVE module import → block registry (textures) → sparse edit sync → view creation; a failure surfaces in the loading overlay, never as a half-built menu.

The decision's core is untouched and still binds: one authoritative shared world, base terrain deterministic in both processes, edits as the only stored state, every mutation through `POST /api/world/place|break`, clients painting **only** from the server echo (WS with `world_log`-cursor polling fallback). The renderer still owns no world state.

Consequences added:

- World-model v2 is a world-breaking change: applying 0005 to a deployed database resets shared-world storage (accounts/content/inventories survive). It needs both terrain implementations changed in lockstep; there is still no version marker.
- Sync is sparse: the initial load fetches player edits inside the rendered region (bounded query), not dense windows — storage cost tracks player changes, not world size.
- The 128×32×16-slab consequence above is superseded by a 96×32×96 region chosen to fit vlox's fixed generator radius budget (corner distance ≈ 68 < max 80), so the entire rendered region generates around spawn; walk-out beyond the sim radius is impossible by camera clamp.
