
## Amendment — menu-first boot, presence, namespaces, day/night, cascade delete (2026-11-07)

**Boot is the main menu; the game view is lazy and stays live.** `Join global server` imports the DVE bundle, fetches registry + edits, and creates the view; the player's last pose is restored from `player_state` (persisted every 2 s while moving). `Main menu` from the pause dialog hides the game but keeps the engine and socket alive — rejoining skips re-init and just re-grabs the cursor. Cursor hand-off is explicit (HUD "Grab cursor" button; any closed dialog that leaves no dialog open re-grabs).

**Player blocks are `player:USERNAME:NAMESPACE:BLOCKNAME`** (four segments, exactly like `builtin:` ids); the display name is the separate `name` column. `POST /api/blocks` takes a `namespace` (optional, default `default` for old cached clients); migration 0007 rewrote existing 3-segment ids. **`DELETE /api/blocks/:id` cascades**: placed copies are removed from `world_edits` (terrain restored, broadcast as `air` over the WS), referencing recipes are dropped, inventory stacks are purged — deleting one's test block never requires manual world cleanup.

**Presence rides the existing `/api/world/live` WorldLive object:** clients post a `pose` frame (~4 Hz) with their username; the object keeps a socket→pose map and fans `pose`/`leave` out to the other sockets (a `who` frame pulls the roster). Avatars (blocky body + name card, lerped) are rendered client-side from these frames — presentation only, still no server physics, and a hidden tab's rAF halt freezes its render loop (avatars hold position until the tab is visible).

**Day/night is a deterministic epoch clock** — `Date.now() % 24 min` drives sky colour and an image-processing brightness scale; no sync traffic. **Glowing blocks** (registry `light > 0`) render through a Babylon GlowLayer emissive cube on the cell, not the vlox light pipeline (which stays off; faces would multiply by empty light data). **Generator workers keep every server edit including `air`** and receive live `note-edit` relays, so blocks mined before joining — or in cells that activate late — never render solid.

## Amendment — occlusion fix, saved appearance, recipe ownership, admin grant tool (2026-11-07)

**One rendering group for everything.** vlox renders its voxel sections in Babylon rendering group 1 and Babylon clears the depth buffer between groups, so any mesh left in group 0 (the avatars and glow cubes were) is painted over by voxels that sit *behind* it — the reported "players are only visible when nothing is behind them". Every mesh this app creates now joins `VOXEL_GROUP = 1` in `frontend/dve/src/main.js`. This is an invariant for future meshes, not a tuning knob.

**Character appearance is stored and rides presence.** `player_appearance` (migration 0008) keeps one `#rrggbb` triple per user (`body_colour`/`head_colour`/`accent_colour`), written by `POST /api/player/appearance` and returned by `GET /api/player/state`. Every `pose` frame carries it; the WorldLive object sanitizes it to exactly those three keys before storing/relaying, so presence stays presentation-only. The in-game **E** dialog shows the signed-in username and the three colours; **I** opens the inventory.

**Recipes are owner-managed like blocks.** `GET /api/recipes` returns `creator`; `PUT /api/recipes/:id` and `DELETE /api/recipes/:id` are creator-only and reuse the POST validator verbatim (`recipeFieldsFromInput`), so an edit cannot smuggle fields a create would reject.

**Test-item grants are admin-only in the UI.** The "Add test items" form in the inventory dialog is hidden unless the signed-in username is `admin` (the handler refuses too). Server-side the endpoint is still per-account; real economies come later.

**Escape opens the pause menu in one press.** While pointer-locked Chrome consumes Escape itself (it exits the lock and delivers no keydown), so `openPause()` is driven from the `pointerlockchange` handler — gated on "game visible and no dialog open" so closing a menu never re-opens the pause menu.
