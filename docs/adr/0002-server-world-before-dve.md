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
