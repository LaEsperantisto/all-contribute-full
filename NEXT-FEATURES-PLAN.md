# Next Features Plan 2 — beams-live, presence, third-person colour, real growth, pass-through blocks, offline private servers

Status: EXECUTED 2026-11-10 — all six landed, each proven by its s27 stage and
the circuit27 run (s26 carry-overs green). Backend: d6f893d (beams), 722002a
(pass-through + 0028), 16f2f81 (growth gate), 9fdbaaa (offline). Frontend:
eb78f98 (beams client), d01b361 (presence socket rebinding), 9f36d4f (third-
person emissive), d2b5159 (passThru + Studio toggle), 7041f0e (offline
bootstrap), d7df3db (paint-direct skips cells whose sector the streaming ring
has unloaded, instead of burning 40 retries against vlox's "voxel does not
exist" throw). Disclosures live in README (0028 section + Disclosures list).
Post-landing proof hardening: the s26/s27 drivers spawn in the spawn mob
field, and a killed driver is frozen physics while setPose fallbacks happily
walk corpses - water now revives through its walk, crop parks the mob sim for
its REST-only eat arithmetic, and presence heals both drivers before each
scripted move. Final circuit27 on pristine state: all 11 stages green, exit 0.
Deviations from this plan: the engine's passThru set is fed in block-ID space
(builtin:wheat_1), not the plan's vid space — the vid version never matched
what the physics mirror speaks; the growth gate is a last-run timestamp, not a
tick counter; and the offline proof runs the whole harness (stack, browsers,
client) inside `unshare -rn` (loopback-only netns) because Chrome's
--host-resolver-rules MAPs blocked fetch/WS but not <link> preloads, while
MAP * also killed IP-literal navigation.
Written 2026-11-10. Anchors were pulled from the working tree on that date by four
sub-investigations (beam lifecycle, presence/appearance, growth+solidity, network
surface); re-verify every anchor by its quoted string — line numbers drift.
User-reported symptoms for this batch (all confirmed by the user as real):
beacon beams do not despawn without a page reload; the "private" server option
is not actually local; other players never appear on screen; third person shows
a black humanoid; crops do not visibly grow; blocks have no walk-through option.

Order rationale: 1 (beams) and 3 (third-person colour) are surgical and de-risk
the render side; 2 (presence) shares the avatar machinery with 3, so they land
adjacent; 4 (pass-through) changes physics + one migration and must precede 5
(growth proof stages walk wheat fields); 5 (growth) is a backend-only fix with
the strongest acceptance test; 6 (offline) is the architectural slice and goes
last because it touches serving + auth + a new npm entry point, and its proof
reuses the s27 stages built for 1-5.

---

## 0. Ground rules (apply to every feature)

- Node 22 for EVERY node/wrangler call:
  `export PATH=/home/aster/.config/nvm/versions/node/v22.23.4/bin:$PATH` (system node is v20).
- Never edit `backend/` or `frontend/` files WHILE a stage/circuit runs
  (wrangler dev hot-reload drops the live WS; ac-static serves `frontend/` live).
- Engine changes (any file under `frontend/dve/src/`) require `node frontend/dve/build.mjs`
  before the stage that exercises them (src→dist bundling + rev.js hash manifest);
  app.js cache-busts `?v=N` in index.html — bump once per slice, same commit.
- Commit cadence (standing order): `git add . && git commit` in `frontend/` per
  slice; root repo: gitlink bump + `backend/` + `migrations/` per slice.
- Every feature gets an s27* proof stage in `/tmp/acv2` following the s26
  conventions (`lib.mjs` Tab/cookieOf/d1 helpers, `ck()` asserts, screenshot when
  the claim is visual). Circuit = all s27 stages + s26 carry-overs, fail=0.
- Disclosures into the running ledger as things happen (schema changes, LAN
  cookie tradeoffs, mob-behaviour changes, offline caveats).

---

## 1. Beacon beams despawn live (no reload)

### Current machinery (verified)
- Beams are only created by block scripts: Lua `setHost("beam", (a) => {` …
  `beams.push({ colour });` (`backend/src/lua.ts`), built-in beacon calls
  `beam(HEX[key])` / `beam(nil)` (migrations 0013/0015). Rows persist in
  `block_beams(server_id,x,y,z,colour,updated_at)`, PK `(server_id,x,y,z)`
  (0012 create; 0024 widened with `server_id TEXT NOT NULL DEFAULT 'global'`).
- Script toggle: `handleBlockInteract` deletes/inserts the row inside the flush
  batch — `"DELETE FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?"` —
  then publishes: `if (beams.length) await publishFrame(env, server, { type: "beam", x, y, z, colour: beams[beams.length - 1] });`
  and `else if (before) await publishFrame(env, server, { type: "beam", x, y, z, colour: null });`.
- Break: `handleBreak` pre-reads `SELECT colour FROM block_beams …`, deletes,
  and publishes `{ type: "beam", x, y, z, colour: null }` after the air frame.
- Join: `GET /api/world` returns `beams` (400 max, `"SELECT x,y,z,colour FROM block_beams WHERE server_id=? ORDER BY x,y,z LIMIT 400"`);
  `loadWorldAll()` paints `worldBeams` via `dveView.setBeam(b.x,b.y,b.z,b.colour)`.
- Client handler: `else if(m.type==="beam"&&dveView)dveView.setBeam(m.x,m.y,m.z,m.colour||null);`
  — `setBeam` has a real remove branch (`if (!hex) { … old.dispose(false, true); beams.delete(key); }` in `frontend/dve/src/main.js`).
- Reconnect repair exists: `rebuildWorldFromSnapshot` diffs `dveView.beamCells()`
  against `worldBeams` and nulls the leftovers.

So both headline paths (script toggle, break) already broadcast removal, and the
engine can remove — the reload-repro must come from one of the known holes
below; the diagnosis stage pins which one before any fix lands.

### Known holes (fix all three; each is small)
1. **Registry-delete cascade publishes no beam frames.** `DELETE /api/blocks/:id`
   prunes orphan rows via `pruneOrphanWorldRows(env, server)` (which runs
   `ORPHAN_PRUNE("block_beams")` — `DELETE FROM ${table} WHERE server_id=? AND NOT EXISTS (SELECT 1 FROM world_edits …)`),
   but the publish loop emits only `await publishEdit(env, cell.server_id, cell.x, cell.y, cell.z, "air");`.
   Fix: capture the pruned beam cells BEFORE pruning
   (`SELECT x,y,z FROM block_beams WHERE server_id=? AND NOT EXISTS (SELECT 1 FROM world_edits e WHERE …)`
   — same predicate), prune, then per cell `await publishFrame(env, server_id, { type: "beam", x, y, z, colour: null });`.
2. **Cell rewrite without beam touch (stale-row resurrection).** Anything that
   replaces a beacon cell's block_id while a `world_edits` row survives (observed
   pattern: `stepCrops`-style growth rewrites) leaves the `block_beams` row alive;
   orphan pruning can never remove it (the cell is still edited), so the ghost
   beam re-paints on every join. Fix at the same chokepoint as 5's growth step:
   when a cell's block_id is replaced by a NON-beacon block, delete any
   `block_beams` row for that cell and publish `colour:null`. Concretely: in
   `stepCrops`' batch push
   `env.DB.prepare("DELETE FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?")`
   (wheat can never hold a beam; cheap, symmetric with break), and add the same
   delete to `handlePlace`'s batch when `blockId !== previous` replaces a cell
   that had a beam row — pre-read like break's `const beam = await env.DB.prepare("SELECT colour FROM block_beams …")`.
3. **Fire-and-forget frames while the socket stays open.** `publishFrame`'s catch
   only logs `"World broadcast failed:"`; a dropped beam frame while connected is
   never retried (snapshot catch-up replays `edits`/`log` but NOT beams —
   `GET /api/world` only returns beams, never a `since`-filtered delta). Fix:
   include the beam delta in the 4 s poll catch-up — the snapshot already carries
   the full beam list, so make the poll's `since` branch also diff when the head
   moved AND `beams` changed: compare a cheap `SELECT COUNT(*), MAX(updated_at) FROM block_beams WHERE server_id=?`
   stamp returned as `beamStamp` in the poll payload; when it differs, re-diff
   against `dveView.beamCells()` (same code as rebuild). Keep it simple: the
   beams list is ≤400 rows; resending it on stamp change is fine.

### Diagnosis first (before fixes)
`s27beam-diag` (throwaway, then promote to `s27beam`): script-toggle a beacon
through the API while the page holds a WS, and count `type:"beam"` frames with a
frame sniffer (`ws.onmessage` wrapper via page eval). Sequence: colour on →
assert frame + `beamCells()` has the key; `beam(nil)` → assert frame + key gone;
break beacon → assert; DELETE the block from the registry → assert (expected
FAIL today = hole 1); place any block over a beamed cell (seed a beam row via
SQL) → assert (expected FAIL = hole 2). Whatever the user's exact repro is, the
stage reproduces the class and each fix flips one assertion.

### Acceptance
- With the page open and never reloaded: script colour on/off, beacon break,
  registry delete of a custom beamed block, and cell-overwrite all remove the
  beam mesh within one frame; `dveView.beamCells()` matches `block_beams` at
  every step (stage asserts the diff both ways).
- Screenshot: beacon lit (beam visible) → toggled dark (same camera, no beam).

### Commits / migration
None needed in the DB; backend `index.ts` only (+ frontend untouched).
Root commit: `api: beam removal frames on cascade + cell-rewrite; beamStamp catch-up`.

---

## 2. Presence: other players visible on screen

### Current machinery (verified — PresenceModel scout + direct reads)
The wire protocol is fully consistent end-to-end; nothing is missing on the
wire or in the engine:
- Backend (`backend/src/index.ts`, class `WorldLive extends DurableObject<Env>`):
  `presence: Map<WebSocket, Presence>`; on connect (~:356) and on `"who"`
  (~:722) it sends `{type:"roster", players:[...this.presence.values()].map(wirePose)}`;
  every pose message does `this.presence.set(socket, pose); this.sendOthers(socket, {type:"pose", ...wirePose(pose)});`
  (~:754); close and the stale sweep send `{type:"leave", name}`.
  `wirePose` = `name,x,y,z,yaw,pitch,vx,vy,vz` + conditional `held`, `heldItem`,
  `appearance` (`...(entry.appearance ? { appearance: entry.appearance } : {})`).
  Identity is stamped by the router upgrade branch via `WS_IDENTITY = "x-ac-user"`.
- Frontend (`frontend/app.js` :1421-1423, verbatim):
  ```js
  else if(m.type==="roster"){for(const p of m.players||[])if(dveView&&p.name!==username){p.heldIcon=iconUrl(p.heldItem);dveView.setRemote(p);}}
  else if(m.type==="pose"&&dveView&&m.name!==username){m.heldIcon=iconUrl(m.heldItem);dveView.setRemote(m);}
  else if(m.type==="leave"&&dveView)dveView.removeRemote(m.name);
  ```
- Engine (`frontend/dve/src/main.js` + the committed bundle `dve/dist/dve-view.js`
  is current): `setRemote` (:1076), `removeRemote`, `flashPlayer`, `setDown` all
  exist; `ensureRemote`/`buildAvatar` build body+head+eyes+held cube+name card;
  `advanceRemotes` dead-reckons and prunes only after 150 s.

### The gap (verified): the socket never follows a world change
The live socket's `?server=` is baked when `connectLive()` runs:
```js
function connectLive(){
  ws=new WebSocket(API_BASE.replace(/^http/,"ws")+"/api/world/live?server="+encodeURIComponent(settings.serverId));
```
(`app.js` :1409-1410). `connectLive()` is called only at boot (:1813) and from
`ws.onclose` retry (:1452). `liveReconnect()` (:391-399, closes the socket so
onclose re-dials) is called only at login (:418) and logout (:434). But
`settings.serverId =` is rewritten at :111 (world-picker change), :134 (create),
:147 (delete), :1849 (private-world bounce) — none of these touch the socket.
So after any world switch inside one page session, snapshots/REST point at the
new world while pose/roster traffic still rides the OLD world's DO: nobody in
the joined world ever sees the player, and their `"who"` roster comes back from
the old (usually empty) world. This matches the reported symptom exactly —
and it is the only verifiable gap; everything downstream works.

### Fix
Call `liveReconnect()` immediately after `saveSettings()` at each of the four
sites (:111, :134, :147, :1849). The join flow needs nothing extra: joining
after the final picker change re-dials via the picker handler, and onopen
already re-sends `"who"` (:1705) plus the connect roster arrives unprompted.
(No backend change; no wire change.)

### Test surface (engine, one line)
`remotes` is closure-private; add to the `dveView` object
(next to `setRemote`): `remoteNames: () => [...remotes.keys()]` — used by
`s27presence` asserts, same pattern as the existing pose accessors.

### Proof stage `s27presence`
Two Chrome tabs = two users (`admin` + a second account, created the proven s26
way: token-hash INSERT via d1 or the session-row INSERT in schema.sql). Both
join the same created world (API create + picker set). Assert in tab A:
`dveView.remoteNames()` contains B's username within 1 s of B joining; a
scripted move (DO `/move`, which broadcasts roster — :311) shows B's avatar
root position converge toward the new pose (sample via a second accessor or
screenshot pair); after B's tab closes, `remoteNames()` empties within ~2 s
(`leave` frame, not the 150 s prune). One screenshot from A showing B's avatar
+ name card (vision-judged).

### Acceptance
Two concurrent sessions in the same world: each client renders the other's
avatar at the broadcast pose within 1 s; the avatar disappears on `leave`
(asserted via `remoteNames()`, not wall-clock staleness); no page reload used
anywhere in the stage; screenshot proves the rendered body.

---

## 3. Third-person shows the player's colours

### Current machinery (verified)
The appearance pipeline is complete from dialog to pose frame to both bodies:
`DEFAULT_APPEARANCE` (`app.js` :163); POST `/api/player/appearance` +
`sendPresence(true)` + `dveView.setSelfAppearance(appearance)` on save (:1287-1291);
`setSelfAppearance` at view creation (:1688) and after joining
(`/api/player/state` :408-410); the pose frame carries `appearance` (:1474) and
`wirePose` forwards it. Engine: `lookOf` clamps to four `#rrggbb`
(:582-586, same defaults as the client), `applyLook` (:664-674),
`setSelfAppearance` (:1228-1230), `selfRecord()` re-applies `selfLook` (:811-812).

### The gap (verified): no lights — and the self body never gets the emissive pass
The scene creates **zero Babylon lights** (no `HemisphericLight`/`DirectionalLight`
anywhere in `dve/src/main.js`); everything visible is emissive-driven:
beam mats (`mat.emissiveColor = ...; mat.disableLighting = true;` :421-424),
sky discs (:535-538), mob parts (`mm.emissiveColor = col.scale(0.22);` :883).
`applyLook` sets ONLY `mat.diffuseColor` and stashes the glow:
```js
for (const { mat, key } of r.parts) {
  if (!key) continue;                 // the held cube is coloured per pose
  const col = Color3.FromHexString(parsed[key]);
  mat.diffuseColor = col;
  r.lit.push({ mat, glow: col.scale(key === "eye_colour" ? 0.6 : 0.3) });
}
```
That `glow` is applied to `mat.emissiveColor` only by `flashRemote`
(`for (const { mat, glow } of r.lit) mat.emissiveColor = Color3.Lerp(glow, WHITE, f);`
:730), and `advanceRemotes()` calls `flashRemote` every frame — but
`advanceSelf()` (:835-860) never does. In a lightless scene: remote avatars
render (0.3 emissive), the third-person SELF body renders pure black despite
correct hexes sitting in `mat.diffuseColor`. Exactly the reported symptom.

### Fix (engine, one line + rebuild)
In `applyLook`'s loop, set the emissive immediately:
```js
const glow = col.scale(key === "eye_colour" ? 0.6 : 0.3);
mat.emissiveColor = glow;
r.lit.push({ mat, glow });
```
Remotes are unaffected: `applyLook` already resets `r.flashWas = -1` (:673) so
`flashRemote` re-lerps from the new baseline; the white hit flash still wins.
Then `node frontend/dve/build.mjs`, bump `?v=N` in index.html, gitlink per
standing order.

### Proof stage `s27look` (folds into `s27presence`'s two-tab rig)
Tab A: set four custom colours (Character dialog → save). Assert: (a) A's own
third-person screenshot shows all four colours (Backspace toggle, no reload) —
vision-judged plus a strict probe (small `selfLookHexes()` accessor next to
`setSelfAppearance` returning the parsed four hexes; `INFERENCE: accessor may
be skippable if scene-material read is easier from the harness`); (b) tab B's
remote look matches (B's screenshot shows A's colours — proves the
appearance-on-pose-frames path).

### Acceptance
Custom body/head/legs/eyes colours from the Character dialog appear live on
the third-person self body (no reload) and on the avatar other players see,
within one pose frame (~250 ms); screenshot-proved both sides.

---

## 4. Pass-through blocks (crops walk-through)

### Current machinery (verified)
- The blocks table (`backend/schema.sql`) has NO solidity column:
  `behaviour TEXT NOT NULL CHECK(behaviour IN ('solid','transparent','glowing','decorative','useful'))`
  is an enum label; `rules_json` support rule is placement-only
  (`type SupportRule = "any" | "solid" | "none";` and
  `if (rules.support === "solid" && cells.get(cellKey(x, y - 1, z)) === "air")` —
  "solid support" == cell below is non-air).
- Player physics is entirely client-side in the view:
  ```js
  const solidVoxel = (bx, by, bz) => {
    if (by < SLAB.Y0 || by >= SLAB.Y1) return false;
    const id = cellAt(bx, by, bz);
    // Water fills cells but is not solid: you walk through it and sink.
    return id !== undefined && id !== null && id !== "air" && id !== "builtin:water";
  };
  ```
  (`frontend/dve/src/main.js`) — consumed by `bodyBlocked`, `footSupport`, the
  axis-wise AABB resolution in `tick`, stuck recovery, and the third-person
  camera pull-in ray. This one predicate is the whole solidity model.
- vlox collision tags (`dve_check_collisions`, `dve_collider_id`) exist in the
  engine schema but are never set — movement never consults them. Break/place
  picking is geometry-based (`pickAt` → Babylon pick on `VoxelBuildSpace`), so
  pass-through blocks stay targetable for free.
- Wheat rows (0027): `behaviour 'transparent'`, model
  `dve_simple_crossed_panels` — visually crossed quads but solid to physics today.

### Implementation
1. **Migration 0028** (precedent: 0012/0019/0025 `ALTER TABLE blocks ADD COLUMN`):
   `ALTER TABLE blocks ADD COLUMN pass_through INTEGER NOT NULL DEFAULT 0;`
   then `UPDATE blocks SET pass_through=1 WHERE id LIKE 'builtin:wheat_%';`
   (farmland stays walkable-solid: disclosed simplification vs Minecraft, where
   farmland is also solid; crops are the walk-through case the user asked for).
2. **API pipe** — `listBlocks` is the single property channel: add
   `pass_through` to the SELECT
   (`"SELECT id,name,creator_name AS creator,hardness,light,colour,behaviour,rules_json,is_builtin,texture,texture_top,texture_bottom,model,script,drop_item_id,drop_qty FROM blocks ORDER BY is_builtin DESC,name LIMIT 500"`)
   and to the row→client map (`drop_item_id: row.drop_item_id, …` neighbours).
3. **Engine** — beside the light-transparency set in `main.js`
   (`const seeThru = new Set(["dve_air"]);` … `if (b.behaviour === "transparent" || !OPAQUE_MODELS.has(model)) seeThru.add(vid);`)
   build `const passThru = new Set();` fed from the registry rows
   (`if (b.pass_through) passThru.add(id-of-b);`), and extend the one predicate:
   ```js
   return id !== undefined && id !== null && id !== "air" && id !== "builtin:water" && !passThru.has(id);
   ```
   Covers walking, jumping, landing, stuck-ejection, foot support, and the
   third-person camera ray in one edit. Rebuild dve dist + bump `?v`.
4. **Studio toggle** — block editor gets a "Walk through" checkbox next to the
   existing hardness/light fields; `POST/PUT /api/blocks` accept
   `pass_through: !!body.pass_through` (clamp 0/1) and the form reads it back.
5. **Server-side counterpart (mob grounding)** — `columnTop` treats any non-air
   as ground: `if (edit.block_id !== "air" && edit.y > top) top = edit.y;`
   → mobs perch invisibly on crossed quads. Fix: exclude pass-through ids. The
   DO has no block cache; do it in SQL at the source of `columnTop`'s rows:
   the SELECT over `world_edits` becomes
   `… AND block_id NOT IN (SELECT id FROM blocks WHERE pass_through=1)`
   (one subquery, no new machinery). Disclose: mobs no longer stand on wheat,
   and mobs can now walk THROUGH wheat fields (consistent with the player).
6. **Not touched** (verified no-ops): raycast/targeting, `bodyCellOverlap`
   placement guard (body-AABB only), support rule (air test), growth ladder,
   drop pipeline.

### Acceptance — `s27passthru`
- Registry: `pass_through` present on wheat rows through `GET /api/blocks`.
- Place wheat, walk into the cell: player pose ends inside the wheat cell
  (assert `cellBlock(floor(pose.x),floor(pose.y),floor(pose.z))` starts with
  `builtin:wheat`), no push-out/stuck-eject (compare pre/post pose delta bounds).
- Break while standing in the crop: 200 + drop credited.
- Place a block ON the wheat column: still permitted (support = non-air below).
- Solidity contrast assert: a `builtin:dirt` in the same path still blocks
  (walk-into assert shows the player stops outside the cell).
- Custom block: create via API with `pass_through:1`, verify the client registry
  row carries it (engine behaviour is stage-2's domain; here assert the payload).
- Screenshot: player standing inside a wheat field.

### Commits
frontend: physics + studio form + `?v` bump + dve dist rebuild.
root: migration 0028 + `listBlocks`/create/update fields + columnTop SQL.

---

## 5. Crops actually grow

### Diagnosis (established from the machinery)
The write→push→apply path for a grown cell is byte-for-byte the proven
user-place path (`publishEdit` → WS `edit` frame → `noteEdit` → `applyEdit` →
`paint-direct` + `note-edit`; 4 s `world_log` catch-up as backstop). If the DO
advances a row, every connected client repaints within one frame. So the
failure is upstream, inside `WorldLive.alarm()`/`stepCrops`:

```ts
private async stepCrops(now: number): Promise<void> {
  if (!now || now % 20000 >= MOB_TICK_MS) return; // DO memory clock; hibernation-safe enough
  …
```
(`MOB_TICK_MS = 250`.) Mobs DO move live (proven by s26 stages: mob asserts
pass without reload) — which means the alarm loop is alive, which means
**every** 250 ms tick is losing the modulo lottery**: the tick period settles at
`250 ms + handler work`; if that period's phase never lands inside the
`[0, MOB_TICK_MS)` window mod 20000, `stepCrops` returns early forever. On a
steady D1 (local dev especially) this phase-lock is stable and permanent. This
is the primary suspect; ranked alongside:
- `stepCrops`' own D1 calls have NO catch (unlike `ensureHealth`/`flushHealth`):
  one hiccup throws out of `alarm()`; CF retries the alarm with backoff
  (up to 6 times), then STOPS until the next `setAlarm` — crops AND mobs freeze
  together until someone reconnects.
- Local dev `wrangler dev` reload/DO-storage-reset can strand the alarm loop
  (workerd issue around alarms after code reload) — secondary, dev-only.
- UX: the first advance is ≥20 s after planting (created_at restamps every
  step); a player watching for 10 s concludes "not growing".

### Fix
1. Replace the modulo lottery with an explicit last-run timestamp:
   ```ts
   private lastCropStepAt = 0; // DO memory; post-eviction the next tick runs once early - harmless:
   // the per-cell 20 s age gate is the real throttle, the outer gate is only a batch cadence.
   private async stepCrops(now: number): Promise<void> {
     if (!now || now - this.lastCropStepAt < CROP_STEP_MS) return;
     this.lastCropStepAt = now;
     …
   ```
   with `const CROP_STEP_MS = 5000;` (batch cadence; the per-cell
   `created_at > datetime('now','-20 seconds')` gate still enforces the 20 s
   per-stage pace, so growth is at worst unchanged and never phase-locked).
2. Wrap the per-cell work in try/catch (`console.error("crop step failed:", error)`)
   so a D1 hiccup cannot kill the alarm chain; mobs are protected too.
3. Beam hygiene inside the growth batch (pairs with feature 1, hole 2):
   add `DELETE FROM block_beams WHERE server_id=? AND x=? AND y=? AND z=?` to
   the batch (wheat replaces whatever was there; can't keep a beam).
4. Cadence visibility (cheap, keeps the "it IS growing" UX honest):
   keep 20 s per stage — the plan's stage proves the ladder; no tuning.

### Acceptance — `s27growth`
- Plant `wheat_seed` on farmland via the API (201), backdate its `created_at`
  by 30 s via local D1 (`UPDATE world_edits SET created_at = datetime('now','-30 seconds') …`).
- WITH a live WS and NO reload, assert within 15 s: a `{type:"edit", block_id:"builtin:wheat_2"}`
  frame arrives (frame sniffer) AND `cellBlock()` in the page reads wheat_2
  AND the D1 row reads wheat_2 (server truth). Chain one more backdate → wheat_3
  → assert; assert wheat_4 never rewrites (ladder terminal).
- Assert the alarm chain survived: mob frames still streaming before/after
  (mobs + growth share the loop — both live in the same stage).
- Assert no growth for a cell planted <20 s ago (age gate holds against the
  faster 5 s cadence).

### Commits
backend only (`index.ts`): cadence + try/catch + beam-delete + `CROP_STEP_MS`.

---

## 6. Offline private servers (100% local, no internet)

### Reality check (verified)
Today's "private" server is NOT local: it is a row in the central D1
(`visibility TEXT NOT NULL CHECK(visibility IN ('private','lan','public'))`)
gated by a browser-held device token (`X-AC-Device`, SHA-256 at rest) —
`if (row.visibility === "public") return null; … if (owner || (… sha256Hex(device) === row.device_hash)) return null;`.
The page itself loads `app.js` from jsDelivr (`<script src="https://cdn.jsdelivr.net/…/app.js?v=30">`);
fonts are a Google `@import` in styles.css:1. Everything else (Monaco vendor,
dve dist, Babylon bundled) is already same-origin and offline-safe as used.
`API_BASE` already has a local switch: `settings.server === "local" && isLocalPage`
→ `http://${location.hostname}:8787`, and backend CORS already allows
`http://localhost`/`127.0.0.1`. Terrain needs no transport (deterministic
mirror); `generator.worker.js` fetches slabs from the same API base.

### Decision: Shape A — "offline mode" = the real stack on the player's machine
Ship a one-command local deployment (Shape A), NOT an in-browser fake backend
(Shape B would require reimplementing ~30 routes + 16 WS frame types + the Lua
host + IndexedDB equivalents — see appendix; reject for this batch, disclose the
"needs Node + pre-installed deps" caveat). Shape A keeps one codebase: mobs,
Lua, sessions, growth all identical to prod.

1. **`npm run offline`** (root `package.json`): starts
   `wrangler dev` in `backend/` (port 8787, `--persist` so D1+DO survive
   restarts) AND a static file server for `frontend/` on `http://127.0.0.1:8080`
   (plain node http, ~40 lines, no deps), then prints
   `open http://127.0.0.1:8080`. After `npm ci` once, zero internet at run time
   [INFERENCE flag: wrangler/workerd do not phone home for local dev; verify by
   running the stage with the network disabled if the user can].
2. **Local script tag**: replace the single CDN `<script>` in index.html with a
   3-line inline bootstrap: if `location.hostname` matches the existing
   `isLocalPage` pattern → `src="./app.js"`, else the CDN URL. (index.html has
   no CSP; inline bootstrap is safe. Pages behaviour unchanged.)
3. **Auto-switch the API**: in local mode with no explicit `settings.server`,
   default `settings.server="local"` (current code offers it only via the
   settings dropdown); the server chip then reads `server: local dev` exactly
   like the s26 stages see today.
4. **Server creation UX**: on a local run, "Create server" defaults
   visibility to `private` and the dialog gains a one-line note: this world now
   lives in the local database; no account on the internet is involved beyond a
   locally registered account. The servers UI + device-token machinery stay as
   they are (a local D1 row can't be joined from the internet by construction).
5. **LAN caveat (disclosed, deliberately out of scope)**: serving the page to
   another machine on the LAN is broken by design today — backend
   `allowedOrigin` accepts only localhost http + github.io https, and the
   `__Host-ac_session` Secure cookie can't work over plain http on a LAN origin.
   Offline mode = browser on the same machine. Ship a README note; do not touch
   cookie/CORS in this batch.
6. **Fonts**: Google `@import` degrades silently offline; leave as-is (or
   vendor later) — disclose.

### Acceptance — `s27offline` (runs against the offline stack, network disabled if possible)
- `npm run offline` from a clean shell: page loads at 127.0.0.1:8080 with NO
  network (stage asserts via the static server's request log: zero outbound
  connect attempts beyond loopback — assert at minimum that the page fully
  boots with DNS unreachable via `--host-resolver-rules=MAP * ~NOTFOUND` in
  headless Chrome, which forces every external fetch to fail).
- Register a local account, create a `private` server, place/break blocks,
  script a beacon, kill and restart `npm run offline`: the world + inventory +
  player_state are still there (`--persist`).
- Smoke script `smoke-offline.mjs` (curl-level): `/api/health`, registry, world
  snapshot on the local port.

### Commits
root: `scripts/offline.mjs` + package.json script + README offline section.
frontend: index.html bootstrap + local API default + server dialog note (+`?v`).

### Appendix — Shape B (rejected, recorded for the record)
In-browser mode = fake backend: implement the endpoint/WS inventory (the scout
report lists ~30 routes + inbound `who/pose/attack` + 16 outbound frame types,
plus DO-internal `/publish` `/replay` shapes), IndexedDB stores for
`world_edits/world_log(+seq)/inventories/player_state/player_appearance/servers/registry`,
a JS Lua rehost for scripted blocks, and interception that also covers
`generator.worker.js`'s per-slab fetches (Service-Worker scope does not cover
classic-worker fetch → needs an in-worker shim). Estimated an order of magnitude
above Shape A for the same user-visible outcome; revisit only if a
zero-install browser-only offline mode becomes the goal.

---

## Circuit & publish

- `circuit27.sh`: s27beam, s27presence, s27look (runs on the presence rig),
  s27passthru, s27growth, s27offline — all fail=0, plus the s26 five carry over
  unchanged (regression net for physics/collision + growth-path edits).
- Publish order: migrations first (0028 is additive), worker deploy, frontend
  push + Pages revs, `smoke-pub.mjs` extended with `pass_through` in the
  registry payload, root push. Offline-mode bits are repo-side (no deploy risk).
- Ledger entries to make as things land: pass_through migration; mob grounding
  change (mobs walk through crops); growth cadence 20 s unchanged but batch
  cadence 5 s; offline mode requires Node 22 + pre-installed deps; LAN out of
  scope; presence fix (if it changes the WS payload, disclose the wire change).
