# Next Features Plan 3 - account button, arrow-key look, per-world inventories, climbable blocks,
# growth, Studio editor+API reference, biomes/structures/villages, higher build limit, transparent
# light, mining bar, placement rules, mobs in D1, settings fixes, infinite world

Status: PLAN ONLY - nothing in this file has been executed.
Written 2026-11-10. Anchors were pulled from the working tree on that date by four sub-investigations
(menus/settings, engine physics-light-bounds, backend inventories-support-mobs-terrain,
Studio/Monaco/lua API) plus direct greps; re-verify every anchor by its quoted string - line numbers
drift. The prior plan (beams-live ... offline servers) is EXECUTED; its commits are the base tree this
plan anchors against (root `c4f9b53`, backend `9fdbaaa`, frontend `d7df3db`).

User-requested items (the full instruction list, each gets a numbered section below):
1. main menu: one Account button instead of Log in / Create account (like the pause menu's)
2. arrow keys rotate the camera (mouse-free looking)
3. inventories do NOT sync between worlds (server ID scoping)
4. remove the hardcoded water swim (slowdown + swim-up); blocks get a `climbable` option instead
5. a block counts as climb-contact if ANY part of the body intersects it, not just the feet
6. wheat keeps growing through all four stages (server-programmed ladder)
7. Studio script editor: colour + syntax highlighting like VS Code (not a plain text box)
8. an in-product list of every script function + description
9. structures, villages included
10. biomes: desert, mountains, etc.
11. higher block height limit
12. transparent blocks let light through
13. mining is not instantaneous: progress bar under the crosshair, hardness x item speed
14. placement whitelist/blacklist of blocks-below, replacing the current 'support' section
15. mobs tracked in D1 like players (server ID scoped), not only in the DO
16. settings default = "Textures, models & icons" (not flat colours)
17. remove the server section from settings
18. FOV range 60-120
19. mouse sensitivity up to 30 (was 10)
20. infinite world - no walls
21. LLM-vision instructions for the visual proofs (this plan's "Vision pass" section)

Order rationale: 1/16/17/18/19 are surgical frontend-only and de-risk the settings surface first.
2 is engine input plumbing. 3 (mining bar) and 4/5 (climbable + swim removal) share the physics tick
and the click pipeline - they land adjacent and must be proven together. 14 reuses the block-registry
rules machinery touched by 4. 12 is reproduce-first (the light tables ALREADY mark `transparent` as
see-through; the plan proves or breaks that claim before changing code). 7/8 are frontend/Studio,
independent. 13... numbered below. 3-per-world-inventories (0030) and 15-mobs (0031) are backend-only
slices with migrations - isolated, low engine coupling. 11 (height) -> 20 (infinite window) -> 9/10
(biomes+structures) rework world geometry in strict order: constants first, then the streaming window,
then the generators that must stay byte-identical across both mirrors.

---

## Ground rules for the executor

- Two git repos: root (`all-contribute-full`) holds backend + a gitlink to `frontend/`; `frontend/`
  is its own repo (`all-contrib`) pushed to GitHub main (Pages serves the repo root; jsDelivr serves
  `@main/app.js`). Commit per slice in whichever repo(s) changed, then bump the gitlink + commit root.
- Bump the CDN cache-buster when app.js or index.html change: `frontend/index.html:350`
  `: "https://cdn.jsdelivr.net/gh/LaEsperantisto/all-contrib@main/app.js?v=31") + '"><\/script>');`
  -> `?v=32` this batch. Bump `styles.css?v=14` (index.html:9) if styles change.
- Engine bundle: rebuild `frontend/dve/dist` with
  `cd frontend/dve && PATH=/home/aster/.config/nvm/versions/node/v22.23.4/bin:$PATH node build.mjs`
  (committed dist, no build step at deploy). DVE_REV content-hash invalidates module URLs automatically.
- Migrations: `cd backend && PATH=/home/aster/.config/nvm/versions/node/v22.23.4/bin:$PATH
  npx wrangler d1 migrations apply all-contribute-db --local` (repeat `--remote` at publish). New
  migrations must follow the additive style; the table-rebuild precedent for PK changes is
  `backend/migrations/0024_servers.sql` (create `*_widened` with live DDL, INSERT..SELECT, DROP,
  RENAME).
- Proofs live in `/tmp/acv2` and follow the s26/s27 stage convention (see `circuit.sh` /
  `circuit27.sh`): node script, CDP-driven shared Chrome, `enter(tab,user,pass)` prelude from
  `lib.mjs`, `ck(name, cond, detail)` claims, final `DONE`, exit 0, zero `^FAIL` lines.
  Run via `circuit28.sh` (new). Budget table per stage inside.
- Runtime for proofs: API `wrangler dev --port 8787 --ip 127.0.0.1` (cwd backend, node22 PATH),
  static page server `node static.mjs` (port 8000) if not already running (`ss -ltnp | grep -E
  '8787|8000'`). Restart the API after each migration-touching slice.
- Never leave the repo half-cut: remove superseded code (arrow-key movement lines, swim physics,
  the support select, `set-server` UI) - no shims.
- Ledger: README "Ledger of changes" + "Disclosures" gain an entry per landed slice, matching the
  existing voice (what changed, what it breaks, what users see).

Harness quickstart (fresh context, from zero):
```
export PATH=/home/aster/.config/nvm/versions/node/v22.23.4/bin:$PATH
cd backend && npx wrangler dev --port 8787 --ip 127.0.0.1        # named service ac-api, ready port 8787
cd /tmp/acv2 && node static.mjs &                                # page on :8000 (PAGE = http://127.0.0.1:8000)
bash circuit28.sh                                                # or: bash circuit28.sh s28climb s28mine
node s28climb.mjs > logs/s28climb.log 2>&1                       # single stage
```
Shared D1 state accumulates across stages; stages use fresh usernames (INFO.new) and unique world
names (`INFO.server()`), and reset anything they mutate. `d1(sql)` queries local D1 directly.

---

## 1. Main menu: single Account button

Current: `frontend/index.html:64-65` - two buttons `mm-login` / `mm-register`;
`app.js:501-502` wire them to `openAuth("login"|"register")`; `updateAccountChip` hides them when
signed in (`app.js:285-286` `$("mm-login").hidden = authenticated;`) and the pause menu already has
the pattern: `app.js:498` `$("pause-account").addEventListener("click",openAccountDialog);` where
`openAccountDialog` (`app.js:470`) does `if(!authenticated){openAuth("login");return;}` then
`$("account-dialog").showModal();`.

Implementation:
1. index.html: replace the two `<button>`s (63-65 `<span class="button-row">`) with one
   `<button id="mm-account" class="button button-outline full" type="button">Account</button>`
   (mirror `pause-account`, index.html:105).
2. app.js: delete the `mm-login`/`mm-register` listeners; add
   `$("mm-account").addEventListener("click",openAccountDialog);`; in `updateAccountChip` delete the
   two `.hidden` lines and the `pause-account` relabel (keep the label always "Account" for both
   menus - drop the "Log in / Register" relabel so menus match).
3. Keep `openAuth` (still used by `openAccountDialog` and the auth dialog tabs). `#mm-account-chip`
   line (index.html:70) stays.
Proof (s28menu, shared with 16-19): signed-out: main menu shows `#mm-account`, no
`mm-login`/`mm-register` in DOM; click -> `#auth-dialog.open` with login tab. Signed-in: click ->
`#account-dialog.open` and `#sessions-list` populated.
Ledger: none (pure UI).

---

## 2. Arrow keys rotate the camera

Current: arrow keys MOVE (`frontend/dve/src/main.js:252-255`
`if (keys.has("KeyW") || keys.has("ArrowUp")) mz += 1;` ...). Look is mouse-only: `main.js:161-164`
`look(dx,dy)` closure, rotation applied at `main.js:240` `camera.rotation.y = yaw; camera.rotation.x
= pitch;`. Keys land in `keys` via `main.js:189-191` (already records Arrow codes).

Design (decision): arrows become look, WASD becomes the only locomotion. Hold-rate rotation,
independent of sensitivity (mouse-off players want steady turning, not slider-coupled): yaw 100 deg/s,
pitch 60 deg/s, pitch clamp stays `-1.52..1.52` (main.js:163).
Implementation (main.js, one edit region each):
1. 252-255: drop the four `|| keys.has("Arrow*")` terms.
2. In `tick()` after the yaw/pitch application point, before `camera.rotation.y = yaw`:
```js
if (keys.has("ArrowLeft"))  yaw -= 1.745 * dt;   // 100 deg/s
if (keys.has("ArrowRight")) yaw += 1.745 * dt;
if (keys.has("ArrowUp"))    pitch -= 1.047 * dt; // 60 deg/s, up looks up
if (keys.has("ArrowDown"))  pitch += 1.047 * dt;
pitch = clamp(pitch, -1.52, 1.52);
```
3. No app.js change; dialogs already gate keys via `gameKey(e)` (main.js:189) - verify Arrow* passes
   `gameKey` (it does today, they move).
Proof (s28keys): in-page: read yaw baseline from engine internals; hold ArrowLeft 0.4 s (CDP
`Input.dispatchKeyEvent` keydown, sleep, keyup) -> yaw dropped ~40 deg +/- 15; ArrowUp raises pitch;
ArrowRight while held does NOT change x position (movement separated); KeyW still moves.

---

## 3. Mining bar (hold to break; hardness x item speed) + server honesty

Current: breaking is one quick click: `app.js:1777-1786` - pointerdown records, pointerup computes
`const quick=Date.now()-downAt.t<600;` and `await gameAction(e.button===0?2:0);` -> single POST
`/api/world/break` (app.js:1652). Server: hardness NEVER read in the break path (only registry CRUD);
no minimum time, no rate limit. Items ALREADY have `speed REAL NOT NULL DEFAULT 1`
(`backend/schema.sql` items table) with an item editor (`item-speed` input, app.js:1023) and tooltip
`mining ×N` (app.js:605); builtin tools exist (`builtin:pickaxe|axe|shovel|sword`). Selected item is
`selectedItem` (app.js:186, hotbar app.js:675-685). So: NO items migration; this is client UX + one
server gate.

Design:
- `mineTime = 0.25 + hardness / speed` seconds, hardness from the registry row (`blocks.hardness`),
  speed from `itemMeta(selectedItem).speed` (fallback 1 - bare hand; block-mirror items are
  synthesised with speed 1, app.js:599). Check the seeded hardness values at runtime
  (`SELECT id,hardness FROM blocks WHERE is_builtin=1`) and pick the stage pair accordingly
  (expect glass/wood ~0.3-2, stone ~1.5-3).
- Bedrock: check its seeded hardness; enforce SERVER-side break refusal when `hardness >= 500`
  (`err(... "unbreakable" ..., code:"unbreakable", 400)`) and client-side infinite bar (never
  completes). Disclose.
- Server anti-autofarm: per-player break-rate gate in the DO (the WorldLive already rate-gates
  attacks: `index.ts:784-785` "Swing rate is server-side: a client cannot attack faster than this." -
  copy the pattern): reject `/api/world/break` when the same player's last break was < 200 ms ago.
  Client minimum is 250 ms anyway (hardness-0 blocks), so honest clients never trip it.
Client implementation (app.js + index.html):
1. index.html: `<div id="mine-bar" hidden><i></i></div>` under the crosshair element (locate the
   crosshair markup at runtime; position `position:absolute; left:50%; transform:translateX(-50%)`
   ~10 px below it, styles.css: track 120x6 px, fill `--accent`).
2. gameCanvas pointerdown (app.js:1777): on `e.button===0` and a valid `pickCenter` hit, store
   `mining={x,y,z,t0,target}`; pointerup/pointermove>8px/yaw-pitch delta > 2 deg cancels (hide bar).
   Remove the `quick` break branch entirely (tap alone no longer breaks; right-click place logic
   stays as-is).
3. rAF loop while `mining`: `p=(now-t0)/mineTimeSec`; fill `#mine-bar i` width `p*100%`; at `p>=1`
   POST the existing break call (`srvBody` unchanged) and clear. On WS echo the client mirror updates
   as today (noteEdit/applyEdit path unchanged).
Server implementation (backend/src/index.ts handleBreak, anchor `:2833` route):
1. after the existing cell resolution + `getGateBlock`, fetch `hardness` (already queried? the drop
   query at `:1569` selects drop spec - extend: `SELECT drop_item_id, drop_qty, hardness FROM blocks
   WHERE id=?`): reject `>= 500`.
2. DO gate: break POST already reaches the DO? No - break is Worker-side; put the rate map on the
   DO via a lightweight call? Simpler: keep the rate map in the Worker isolate (`new Map<string,
   number>()` at module scope in index.ts, key `auth.user.id`; DO attack gate lives in the DO because
   DOs are per-server - the Worker map is cross-server, which is STRICTER; disclose). 200 ms.
Proof (s28mine): REST-seed a known stone column; select pickaxe in hotbar (UI click on slot);
CDP pointerdown (no up): at 40% of expected mineTime `#mine-bar` visible with width ~40%, block
STILL PRESENT (mirror + d1); at 100%+break POST: block air, drop credited; switch to bare hand:
mineTime ratio matches hardness ratio (measure hold durations). Cancel test: pointerdown 300 ms then
up: block intact, bar hidden. Rate gate: scripted 10 rapid REST breaks -> >=8 rejected 429/400.
Ledger: mining now takes real time (hardness / selected tool speed), bedrock unbreakable, break rate
capped 5/s. Disclose: tap-to-break gone - hold to mine.

---

## 4+5. Climbable blocks (any-body-part contact); swim physics removed

Current: swim is hardcoded in THREE places in main.js: `:264-266` `const inWater = bodyCell ===
"builtin:water"; if (inWater) { dx *= 0.6; dz *= 0.6; }`; `:293-294` `if (keys.has("Space") &&
(grounded || inWater)) { vy = inWater ? 3.2 : JUMP_V; grounded=false; }` and the sink cap/gravity
quarter `vy = Math.max(inWater ? -2 : -MAX_FALL, vy - (inWater ? GRAVITY * 0.25 : GRAVITY) * dt);`;
plus the `id !== "builtin:water"` clause of `solidVoxel` (`main.js:217-222`). The passThru precedent
for a registry-driven physics set: `main.js:334` `const passThru = new Set();`, fed at `:397`
`if (b.pass_through) passThru.add(b.id);` (raw block-ID space), consumed by ONE predicate.

Design decisions:
- New registry column `climbable` (migration 0029). Studio checkbox beside Walk-through.
- A climbable block is NON-solid (`pass_through=1` on the row) so the body can sit inside it; that
  combination is what makes "intersects ANY part of the body" natural: contact = any integer cell
  overlapping the body AABB (HALF 0.3, HEIGHT 1.8, main.js:204-205) whose id is in `climbSet`.
  Feet, waist, OR head all count; head-only overlap still climbs.
- Climbing kinematics: while `climbContact()` is true: gravity is skipped; W -> `vy = +2.2`;
  no W -> `vy = -2.4` (slide); jump (Space) works off the wall like normal jump; horizontal
  unaffected. Out: contact false -> normal gravity.
- Seed `builtin:ladder`: model `dve_simple_thin_panel` (allowed list main.js:40-49), behaviour
  `transparent`, `pass_through=1`, `climbable=1`, hardness 1, colour brownish; matching item row
  kind `block` place_block_id ladder (mirror 0026/0027's INSERT pattern in the migration). 0029 also
  seeds builtin tool speeds if the seeded values are all 1: `UPDATE items SET speed=... WHERE id IN
  (builtin:pickaxe 2, builtin:axe 2, builtin:shovel 1.5, builtin:sword 1.2)` (verify seeds first -
  3. needs these to be visibly real).
- Remove water swim ENTIRELY (user: "not specially programmed"): delete the three inWater terms.
  Water stays non-solid (`id !== "builtin:water"` in solidVoxel stays - that is geometry, not swim
  programming). Consequence: full gravity in water, no stroke; deep sea = you sink and die/respawn.
  Disclose loudly; s26water must be adapted (see Circuit section) not deleted.
Implementation:
1. Migration `backend/migrations/0029_climbable.sql`: `ALTER TABLE blocks ADD COLUMN climbable
   INTEGER NOT NULL DEFAULT 0;` + ladder block/item INSERTs + tool-speed UPDATEs (if needed).
2. listBlocks SELECT (`index.ts:1382` anchor list) gains `climbable`; POST/PUT `/api/blocks` accept
   `climbable: !!body.climbable` (clamp 0/1) like `pass_through` (`:1389` pattern).
3. Studio: `index.html:242` region - add `<label class="check"><input id="block-climb"
   type="checkbox"> Climbable</label>` next to the `block-pass` checkbox (`index.html:238`);
   app.js `common` literal (`:893`, has `pass_through:$("block-pass").checked`) gains
   `climbable:$("block-climb").checked`; edit read-back (`:919` area) sets it.
4. Engine (main.js): `const climbSet = new Set();` beside `passThru` (`:334`); fed at the same
   registry loop line (`if (b.climbable) climbSet.add(b.id);`); helper
```js
const climbContact = () => {
  const x = camera.position.x, z = camera.position.z, feet = camera.position.y - 0.9; // mirror bodyBlocked's box
  for (let bx = Math.floor(x - HALF); bx <= Math.floor(x + HALF); bx++)
    for (let bz = Math.floor(z - HALF); bz <= Math.floor(z + HALF); bz++)
      for (let by = Math.floor(feet); by <= Math.floor(feet + HEIGHT); by++) {
        const id = cellAt(bx, by, bz);
        if (id !== undefined && climbSet.has(id)) return true;
      }
  return false;
};
```
   (match bodyBlocked's exact box math at `:224` - copy its loops). In the tick: compute
   `const climb = climbContact();` then the vertical block becomes
   `if (climb) { vy = keys.has("KeyW") ? 2.2 : Math.max(-2.4, vy - 4 * dt); grounded = false; }
   else { <existing jump+gravity lines, water terms deleted> }`.
   NOTE the exact camera-y -> feet mapping MUST reuse bodyBlocked's convention - do not invent a
   second one; bodyBlocked already knows the box, refactor `climbContact` to share it.
5. columnTop (server mobs): a climbable-but-pass_through ladder must NOT count as mob perch - the
   existing `pass_through=1` exclusion (`index.ts:581`) already covers it IF the ladder row has
   pass_through=1 (it does). No change.
6. Wheat/crops (item 6 of the request): the growth ladder (`stepCrops`, `index.ts:535-565`, cadence
   `CROP_STEP_MS = 5000`, per-cell 20 s age gate, `const next = "builtin:wheat_" + ...` at `:550`)
   is already programmed; keep it byte-stable through this batch - s28climb asserts the ladder still
   walks wheat to stage 4 end-to-end (REST-place wheat_1 near spawn, d1-poll until `builtin:wheat_4`
   or timeout 150 s). Do NOT mark wheat `climbable` (crops stay pass-through decor; ladders climb).
Proof (s28climb): REST-place ladder pillar at a reachable spot; walk into it (physics nudges);
hold W 1.2 s -> y rose >= 2 blocks; let go -> y falls slowly (~2.4 m/s slide, NOT free fall: y-rise
check over 0.5 s < 1.2 blocks). Any-part test: place a block at feet level (air gap) and ladder at
head cell only: climbing engages (y rises). Water: jump into the deep pool: with Space HELD y keeps
falling past -2 (sink cap gone) and reaches pool floor; no horizontal x0.6 damping (travel a
measured distance above water vs same keys in air - equal within tolerance). Wheat: ladder to
wheat_4. Screenshots: ladder-climb mid-pose, sunk player at pool floor (vision, see Vision section).
Ledger: 0029 entry (climbable flag + ladder + tool speeds); swim removed (water is deadly deep now);
ladders: can't stand ON a ladder head (non-solid), disclosed.

---

## 14. Placement rules: whitelist/blacklist of what a block may sit on (replaces 'support')

Current anchors: rules live in the free-form `blocks.rules_json` column (schema.sql:32,
`DEFAULT '{}'` - NO schema migration needed). Backend: `SupportRule = "any"|"solid"|"none"` and
`BlockRules = { support, incompatibleWith }` (`index.ts:1173-1174`), `supports = ["any","solid","none"]`
(`:1175`), `parseRules` (`:1177-1191`), `validateRules` (`:1195-1198`), placement checks
(`:1505-1508`: `support==="solid"` rejects air-below, `support==="none"` rejects non-air-below,
error code `no_support`), neighbour `incompatibleWith` loop (`:1509-1515` - untouched). listBlocks
normalizes through parseRules (`:1386`). Builtin rules today: only farm (0027:39 sets
`{"support":"solid",...}` for crops - the sole known legacy user). Studio: select `block-support`
(`index.html:242`), form reads it at `app.js:892` (`rules={support:$("block-support").value,...}`)
and writes it back at `app.js:919`.

Design (decision): replace the three-mode select with mode `any | whitelist | blacklist` over an
explicit list of below-block ids. The cell-below id space already includes `"air"`, so the legacy
"needs empty below" is exactly `whitelist:["air"]`. To keep "crops stand on ANY solid" expressible,
the list may contain the token `"solid"`: membership then means `belowId !== "air" &&
!passThruSet.has(belowId)` (passThruSet = one `SELECT id FROM blocks WHERE pass_through=1` per place
request, same query pattern columnTop already uses).
1. Backend (index.ts): types become
   `type BelowRule = "any" | "whitelist" | "blacklist";`
   `type BlockRules = { below: BelowRule; belowIds: string[]; incompatibleWith: string[] };`
   `parseRules` maps LEGACY keys (no row rewrite anywhere): if `value.support` present and `below`
   absent -> `solid -> {below:"whitelist",belowIds:["solid"]}`, `none -> {below:"whitelist",
   belowIds:["air"]}`, `any -> below:"any"`; else `below` validated against the three modes;
   `belowIds` filtered to valid item ids plus the two tokens, cap 64. `validateRules` error text:
   `rules.below must be one of: any, whitelist, blacklist.`
2. Placement check replaces `:1505-1508` exactly:
```ts
const belowId = cells.get(cellKey(x, y - 1, z))!;
const listed = (id: string) => rules.belowIds.includes(id) ||
  (id === "solid" && belowId !== "air" && !passThru.has(belowId));
if (rules.below === "whitelist" && !listed(belowId))
  return json({ error: `${def.id} can only be placed on: ${rules.belowIds.join(", ")}.`, code: "no_support" }, 400, origin);
if (rules.below === "blacklist" && listed(belowId))
  return json({ error: `${def.id} refuses to sit on ${belowId}.`, code: "no_support" }, 400, origin);
```
   Keep error code `no_support` (client toast path unchanged). Rules stay SERVER-side (client
   mirrors revert on the existing rejection echo path; no engine change).
3. Studio: `index.html:242` select -> `<select id="block-below">` options
   `any: "Any (no rule)" / whitelist: "Only listed blocks" / blacklist: "All except listed"`;
   new input `block-below-ids` beside it (placeholder `builtin:dirt, builtin:farmland, air, …`;
   hint "air and solid are tokens"). `app.js:892` rules literal gains
   `below:$("block-below").value, belowIds:splitIds($("block-below-ids").value)`; read-back
   (`:919`) fills both from `rules.below`/`rules.belowIds` (legacy rows arrive already mapped by
   parseRules). Delete the `block-support` select and its read-back line - clean cutover, no shim
   in the form; the legacy mapping lives ONLY in parseRules (documented, protects cached old pages
   mid-deploy - disclose).
Proof (s28place): publish a REST block with `rules:{below:"whitelist",belowIds:["builtin:grass"]}`
-> place on grass 200, on sand 400 `no_support`; blacklist `["builtin:water"]` -> 400 on water;
legacy alias: builtin wheat (0027 solid row) still refuses sand-below and lands on farmland (proves
parseRules alias, no data migration); token `"solid"`: whitelist `["solid"]` accepts dirt-below,
rejects air-below AND water-below (pass_through) - one place-request passThru fetch verified via
d1-free behaviour; Studio DOM: `#block-support` absent, `#block-below` + `#block-below-ids` present,
editing a rules-bearing row round-trips into the new controls.
Ledger: placement rules section replaces Support; old any/solid/none rows keep working (mapped on
read); wheat/crop behaviour unchanged.

---

## 6. Light: transparent blocks let light through (reproduce FIRST)

Anchor truth: the pipeline already treats behaviour `transparent` (and any non-cube model) as
see-through: `main.js:394` `if (b.behaviour === "transparent" || !OPAQUE_MODELS.has(model))
seeThru.add(vid);` -> `main.js:492` `runTask("light-tables", [...seen].map(vid => [vid,
emits.get(vid) || 0, seeThru.has(vid) ? 1 : 0]))` -> `world.worker.js:111/126/136` (`lightThru`,
`thruId`), and every spread step gates on `thru` (`:220/255/260/284`). The likely REAL bug: the
payload is built from `[...seen]` (voxels seen during a section build). A voxel id present in a
section but absent from that payload defaults to NON-through in the worker (`lightThru.has(tid)` is
false for unknown non-zero tids), so late-registered glass (or any vid that skipped one payload
generation) blocks light. That matches "transparent blocks should let light through" verbatim.
Implementation (after reproduction):
1. Flip the worker default: unknown tid passes light (`const thruId = tid => !opaqueKnown.has(tid);`
   - invert the table: the light-tables payload marks KNOWN-OPAQUE only). Air stays thru. This makes
   "unknown = light passes" structural rather than accidental.
2. Send the FULL registry light table (every registered id's vid) on every registry sync + every
   section rebuild that changes the palette seen - drop the `[...seen]` sampling.
3. Add a proof/debug accessor: view method `lightAt(x, y, z)` -> `runTaskAsync("light-probe")` in the
   world worker returning the cell's cached skyLight/blockLight (cheap read of the light arrays).
   Also expose `viewCell(x, y, z)` -> raw block id from the cell mirror (used by s28height/s28infinite
   too). Both are 2-line engine additions, no app.js.
Proof (s28light): build two identical 5x5x3 sealed huts far apart (REST batch: dirt vs glass walls,
dirt floor/roof both, door sealed) at a known flat spot; after light settles assert
`lightAt(inside_center)`: glass hut >= 2x dirt hut value (dirt ~0, glass near sky value); vision
shot: greenhouse interior readable vs dark dirt interior. Then the late-registration case: join,
publish a new transparent block via REST (scriptless), place a glass-style wall, re-probe light.

---

## 7. Studio: real editor feel + function reference (items 7+8)

Current: Monaco IS vendored and mounted lazily (`app.js:863`
`$("block-form").addEventListener("focusin",mountBlockEditor,{once:true});`) - textarea at
`index.html:274`, host at `:278`, `mountBlockEditor` at `app.js:837-849` (AMD loader, `language:"lua"`,
`theme:"vs-dark"`), fallback `}catch{blockEditor=null;...}` on failure. The user still experiences
"a simple text box": reproduce which leg fails (lazy mount = user sees the plain textarea until the
focus swap; a silent vendor failure on the deployed page keeps the textarea with NO message; Monaco
lua is highlighting-only, no completions - and no hover/docs).
Implementation:
1. Mount EAGER: replace the `focusin` trigger with Studio-dialog-open (find the block-editor dialog
   open/close functions in app.js at runtime - the workshop panel is `index.html:228-281`); keep the
   `{once:true}` guard. On failure show a visible one-line notice under the field
   ("syntax editor unavailable - plain text mode") instead of silence.
2. Register a completion + hover provider for lua at mount:
   `monaco.languages.registerCompletionItemProvider("lua",{...})` fed from a NEW frozen table
   `SCRIPT_API` in app.js: one entry per backend host function with `name(signature) - description`.
   Source of truth (verified today): globals `player, key, x, y, z`;
   `state_get(key)`, `state_set(key,value)`, `menu(title,options)` (<=12 options), `beam(colour)`,
   `toast(msg)`, `log(msg)`, `get_player_position()`, `set_player_position(x,y,z)`,
   `set_player_respawn_position(x,y,z)`, `give_item(id,qty)`, `take_item(id,qty)`, `item_count(id)`,
   `inv_add(id,qty)`, `inv_take(id,qty)`, `inv_count(id)`, `inv_list()`; stdlib `math.*`
   (floor/ceil/abs/sqrt/min/max/random/randomseed), `string.*` (len/upper/lower/sub/rep/find/format
   - NOT match/gsub/gmatch), `table.*` (insert/remove/concat - NOT sort); entry hooks
   `on_interact(player)`, `on_choice(key,player)`, `on_break(player)`. (All anchors in
   `backend/src/lua.ts:1702-1951`; rewrite descriptions from the code comments.)
   Hover: show the same description on identifier hover.
3. Visible reference: `<details id="script-api"><summary>Script functions</summary><table>...`
   rendered from `SCRIPT_API` under the editor (`index.html:279` region). The placeholder comment
   text (index.html:274-276, which today lists only 9 of the functions - verified incomplete) can
   shrink to two lines since the table exists.
4. Contract test (s28studio): stage reads `backend/src/lua.ts` source, extracts every
   `setHost("name"` occurrence, and asserts `window.SCRIPT_API` (expose it on `self` next to
   `SCRIPT_API`'s definition) covers every one; plus s26monaco's assertions carried (mounted, lua
   language, marker on line 2, submit carries script). Completion check: in-page
   `monaco.languages.suggestController`... simpler: assert the provider is registered
   (`CompletionProviderRegistry.count("lua") >= 1` via `monaco.languages` internals, or fire
   `provideCompletionItems` directly on the registered provider handle kept in a global for tests -
   decide smallest in-page; provider handle stored as `self.scriptApiProvider` is acceptable).
Ledger: Studio script editor gets completions + hover docs and a full function table; note the
placeholder's function list was incomplete.

---

## 8. Inventories scoped per world (item 3)

Current: `inventories` has NO server_id (schema.sql:49-55, PK `(user_id,item_id)`; 0024 deliberately
skipped it). Every consumer is global: GET (`index.ts:2848-2856`), break-credit `stackStatements`
(`:1799/:1803` via `:1640-1644`), place-debit (`:1518-1519`), eat (`:2126-2130`), craft (`:2042/:2045`),
mob-kill credit in the DO (`:836-838`, DO knows `this.serverId`), admin add/remove (`:2898-2904`),
clear (`:2926`), order (`:2863`), Lua `give_item/take_item/item_count` via `gives/takes` flush
(`:1905`). `ord` column exists (0014) - the rebuild must keep it.
Design: follow the 0024 re-key precedent EXACTLY.
1. Migration `0030_inventories_world.sql`: `CREATE TABLE inventories_widened` with the live DDL
   (quantity CHECK 0..999, `ord` column if present on the live table - read `PRAGMA table_info`
   behaviour: schema.sql + 0014 means ord EXISTS; copy both), PK `(user_id, server_id, item_id)`,
   `server_id TEXT NOT NULL DEFAULT 'global'`; `INSERT ... SELECT 'global',...`; DROP; RENAME.
2. Every SQL above gains the `server_id=?` predicate / column, threaded from the request's
   `serverOf(request)` (the helper world routes already use; `srvQS()` on the client already sends
   `server=` on every relevant call - verify each affected client call site passes it, app.js
   `srvBody`/`srvQS`). The Lua gives/takes flush needs the acting server passed into
   `stackStatements(env, userId, serverId, ...)`.
3. Recipes/blocks/items stay global (they are definitions, not stock). Crafting consumes/produces in
   the CURRENT world's inventory.
4. Admin add/remove/clear/order take the server from the request too.
Disclose (loud): existing stacks all land in the `global` world; every private/other world starts
empty. World switch now switches the bag (that IS the feature). Wire shape unchanged; payloads the
same; the server derives scope from the existing `server=` param.
Proof (s28inv): world A = global, world B = new INFO.server() private; REST-break in A (d1-assert a
row with server_id 'global'), switch client (picker change handler, app.js:115-118), GET
/api/inventory?server=B -> empty; place from... B is empty so placement must fail debit (assert
400 insufficient stock); back to A -> stock present; cross: break in B credits B row only (d1).

---

## 9. Mobs tracked in D1, server-scoped (item 15)

Current: DO-memory only: `index.ts:189` `mobs: Map<string, Mob> = new Map();` (Mob type `:108-111`:
id, kind, x,y,z,yaw, hp, hostile); `MAX_MOBS = 12`, `MOB_TICK_MS = 250`, alarm self-rearm
`:376-396`; no mobs table, no saveMobs (verified absent); README says deploys EVICT the DO and drop
the mob population (`index... :49-53` hibernation comment; README "Deploying also resets the live
world object... drops its in-memory mob population").
Design (mirror the player_state pattern: memory truth + batched D1 flush + hydrate on wake):
1. Migration `0031_mobs.sql`:
   `CREATE TABLE mobs (server_id TEXT NOT NULL, mob_id TEXT NOT NULL, kind TEXT NOT NULL,
   x REAL NOT NULL, y REAL NOT NULL, z REAL NOT NULL, yaw REAL NOT NULL, hp REAL NOT NULL,
   PRIMARY KEY (server_id, mob_id));` (additive create, no re-key).
2. DO: keep the Map for sim. Add `mobDirty = new Set<string>()` marked by stepMobs/spawn/despawn/hit;
   `mobsSaveMs = 5000` gate (module const) on the alarm tick: one `env.DB.batch` of
   `INSERT ... ON CONFLICT(server_id,mob_id) DO UPDATE` for dirty rows + DELETEs for removed ids.
   Write cadence: <= 1 batch/5 s/world -> ~17k batches/day worst case; disclose D1 write volume.
3. Hydrate: `ensureServerBound`/first alarm after wake: `SELECT ... FROM mobs WHERE server_id=?`
   into the Map (cap MAX_MOBS); `spawnOne` then tops the population to 12 instead of starting fresh.
4. Kill/despawn mark delete rows (batched as above).
5. README line about deploys dropping mobs (quoted above) must be UPDATED - deploys no longer lose
   the mob field (state survives DO eviction; disclose the new behaviour + the 5 s staleness window
   after a crash).
Proof (s28mobsdb): join a fresh world; within 8 s `d1("SELECT ... WHERE server_id='<B>'")` -> >=1
row with server_id B, sane x/y/z; sample twice 6 s apart -> positions changed; kill one via the
attack path (existing WS attack frame; see `:780-813`) -> row gone <= 6 s. Hydration leg is
exercised by an API restart sub-step: `write proc://ac-api/kill`? - stages must NOT kill the shared
service; instead run a sub-step that spawns its OWN wrangler dev on port 8788 + a tab against it
(static.mjs PAGE is fixed to 8000; a second static server on 8001 with ac_api_port... offline.mjs
already implements exactly this pairing - reuse its pattern or accept (a)-(c) and verify hydration
manually during the final acceptance (documented escape hatch)).

---

## 10. Higher build height (item 11)

Current: `backend/src/terrain.ts:10` `export const WORLD_Y = 32; // legal solid band is y ∈ [0, 31]`
consumed by `worldCoords` (`index.ts:1330-1332` `y < 0 || y >= WORLD_Y`), the /api/world window
param clamp, and the error strings (`:1481/:1553` templated). Frontend mirror:
`frontend/dve/src/world.js:13-20` SLAB `Y0: 0, Y1: 32, // exclusive`; `solidVoxel` bails outside it
(`main.js:217`); baseBlock mirrors `y >= WORLD_Y -> air` (both mirrors, identical). Spawn default:
`defaultRespawn` returns y=16 (verify anchor at runtime). No schema CHECK on y (verified).
Decision: WORLD_Y/SLAB.Y1 -> 64 (doubles the section stack: vlox sectors are 16 tall, so 2 -> 3...
64/16 = 4 layers vs 2 - mesh/light cost roughly doubles for full columns; measure in s28height via
the existing `mesh-stats` task (`lib.mjs` probes `threads.meshers.getThreads()[0].runTaskAsync("mesh-stats")`).
If mesh time regresses past tolerance, fall back to 48 - decide by measurement, do not pre-pick.)
Implementation:
1. terrain.ts `WORLD_Y = 64`; world.js SLAB `Y1: 64`; check BOTH mirrors' layering: baseBlock's
   dirt band `y >= h - 3` and stone below stay valid; y between old 32 and new 63 is simply air for
   terrain (`y > h -> air/water/tree paths` unchanged); bedrock only at y=0 (digging under? see 3 -
   bedrock unbreakable now blocks floor holes).
2. columnTop's floor `Math.max(heightAt, SEA_LEVEL)` unaffected (heights stay <= ~40 with
   mountains; still < 64 - keep the margin).
3. Caves: `caveAt` is y-sampled trilinear - unchanged. Trees crown `h+7` - unchanged.
4. beams: cascade/prune queries use `y>?` open-ended - automatically taller. Verify the top-of-world
   constants inside beam SQL (search `WHERE y` in beam cascade at runtime) don't hardcode 32.
5. `defaultRespawn` y: set to 30 (above any terrain + structures; verify at runtime that y=30 is air
   everywhere: mountains max ~40 could put spawn INSIDE a mountain at exact spawn column... pick
   y = heightAt(0,0)+2 in the mirror? defaultRespawn is server code - call heightAt there (it already
   imports terrain) -> `y: heightAt(0,0) + 2`. Same for the client-side spawn fallback if any.
6. Perf guard: the s28height stage must record mesh-stats before/after and the frame-time probe the
   s26 stages already use; if generation cost explodes, land 48 and disclose.
Proof (s28height): REST-place at (10, 55, 10) -> 200 + appears in mirror (`viewCell` accessor from
6); (10,64,10) -> 400 coordinate error; engine collides standing on the y=55 block (walk onto it:
y lands on 56); beam under a new glowstone at y=50 reaches further than old top? (assert beam rows
exist up to y=63 via d1); screenshot the tower (vision).

---

## 11. Infinite world - no walls (item 20)

Current: the world is a fixed 256x256 slab: `world.js:13-20` SLAB `X0:-128, X1:128, Z0:-128,
Z1:128`; generation clips to it (`generator.worker.js:89-93`
`const xLo = Math.max(sx, SLAB.X0) ... if (xHi <= xLo || ...) return;`); the body is clamped with a
lip (`main.js:312-313` `camera.position.x = clamp(camera.position.x, SLAB.X0 + 0.4, SLAB.X1 - 0.4);`
- those ARE the walls). The edit mirror fetches ONE snapshot for the whole slab
(`generator.worker.js:67`, and app.js's `:1366` cursor poll uses `S.X0..` from the SLAB import).
Backend already accepts x/z to ±1,000,000 (`index.ts:1319` `const WORLD_COORD_LIMIT = 1_000_000;` -
note: the error TEXT says ±1000000; there is no ±100000 anywhere). Base terrain is pure functions of
(x,z) on both mirrors - terrain already works outside the slab. The generator focus already follows
the player (`main.js:996-999` move-generator; worker re-derives sector rings live).
Design: SLAB becomes a MOVING WINDOW at 16-cell granularity.
1. world.js: SLAB stays the single source; add
   `export const window = { ox: -128, oz: -128 };` and make SLAB.X0/X1/Z0/Z1 computed
   (`Object.defineProperty` or a `shiftWindow(ox,oz)` that mutates the four fields) - all importers
   (generator clip, main.js clamp, app.js fetch ranges) read the SAME object and need no change
   beyond calling the shift.
2. The generator worker owns the shift: on `move-generator` (already fired every 16-cell change from
   main.js), snap `ox = 16*floor(px/16) - 96` (96 = generationRadius, world.worker.js:603-604) - only
   when the player's window actually crosses a boundary; shift SLAB; refetch the edit snapshot for
   the NEW window (`/api/world?x0..&since=lastSeq` - reuse the `reload-edits` task,
   generator.worker.js:170) and drop mirror edits outside the new bounds (Map sweep on shift; edits
   are sparse - bounded cost).
3. main.js: the position clamp (`:312-313`) now bounds against the moving SLAB (a 96-deep margin -
   the player can never outrun the window because the shift fires at every 16-cell step and the
   radius is 96); keep the clamp as the safety net, remove nothing else.
4. app.js cursor poll (`:1366`) reads live SLAB fields at fetch time (it already destructures `S` -
   verify it reads the live object, not a copy; if it snapshots, switch to live read).
5. Server: /api/world window query is parameterized already (`:2785-2798`); LIMIT 20000 per window
   stays (sparse edits; disclose if a window exceeds 20k edits - the snapshot degrades to newest-
   wins... assert count in s28infinite instead).
6. DO mobs: spawn ring uses live player positions - fine anywhere. columnTop works per (x,z) - fine.
7. Keep ±1,000,000 as the hard REST bound (memory/integer safety; disclose as "infinite for any
   practical walk").
Proof (s28infinite): pick x=400: `viewCell(400,?,0)` matches the world.js mirror's expected base
block (import world.js in the stage, run in node); REST-place a torch at (400, h+1, 0) -> renders
(WS echo path works far from origin); walk/`setPos` from spawn toward x=200 straight at the OLD
wall: no clamp stop (x crosses 127 freely), window shifted (SLAB.X1 > 127 readable via exported
object through engine internals), terrain streams (mesh-stats nonzero sectors near 200), screenshot
far-from-spawn landscape (vision).

---

## 12. Biomes + structures (items 9+10) - last, after geometry

Determinism is the hard invariant: `backend/src/terrain.ts` and `frontend/dve/src/world.js` must
stay integer-identical ("the authoritative twin - keep them integer-identical", world.js header).
Everything below lands as the SAME code in both files. Existing vocabulary: `hashU32`
(avalanche, returns uint32), `mod`, `noise2(x,z,s)` (bilinear value noise, lattice 0..15, integer
weights, returns 0..~15), `heightAt` (sum of 4 octaves, `6 + floor(sum/12)` -> 6..21), `hasTree`
(`hashU32(x*0x9e3779b1 ^ z*0x85ebca77 ^ 0x2545f491) % 40 === 0`), `caveAt`, `baseBlock`
(grass top / 3 dirt / stone; sand below SEA_LEVEL; static sea; tree trunk `h+1..h+5`, crown
`h+6..h+7` + radius-2 canopy `h2+4..h2+6`).
Spec (additive, integer-only, mirrors identical):
1. `biomeAt(x,z)`: `const b = noise2(x, z, 96) + noise2(x, z, 32) / 2;` (0..~22.5) ->
   `b < 6 ? "desert" : b < 12 ? "plains" : b < 16 ? "forest" : "mountain"`. (Tune thresholds once,
   then never touch; the parity test locks them.)
2. `heightAt` upgrade (biome-aware, still bounded < WORLD_Y-24):
```
const h0 = 6 + Math.floor(sum / 12);              // existing
if (mountain)  return h0 + 4 + Math.floor(noise2(x, z, 9) / 3);   // up to ~30
if (desert)    return Math.max(SEA_LEVEL - 1, Math.min(SEA_LEVEL + 4, h0)); // flat dunes
return h0;
```
3. Surface material in baseBlock: desert -> `builtin:sand` at `y === h` (not just below sea);
   mountain -> `builtin:stone` at `y === h`, dirt band `y >= h - 1` only (rocky); plains/forest keep
   grass. `h < SEA_LEVEL` sea flood unchanged (desert threshold keeps deserts mostly dry).
4. Tree density: `hasTree` gate becomes biome-aware: forest `mod % 12 === 0`, plains `% 40`,
   mountain `% 80`, desert none. Keep the exact hash inputs (only the modulus changes).
5. Structures, chunk = 16 (sector-aligned): `structureAt(x,y,z)` consulted in baseBlock BEFORE trees
   (structure wins), and cheap-gated first: `const ch = structureHash(cx, cz)` - zero cost when the
   chunk has nothing:
   - Village: plains && `hashU32((cx*0x9e3779b1)^(cz*0x85ebca6b)^0x1f2e3d4c) % 64 === 0` &&
     `heightAt` of the chunk centre > SEA_LEVEL. Deterministic interior via a PRNG stream
     `vsalt = hashU32(cx ^ (cz*0x9e3779b1) ^ 0x77)`; `vrand(i)` = `hashU32(vsalt + i*0x27d4eb2d)`.
     3-5 houses; each: footprint 5x5..7x7 (from stream), walls `builtin:planks`, corners
     `builtin:wood`, windows `builtin:glass` at wall-base+2 on long sides, one door cell (air) in
     stream-picked side, floor at the chunk-centre ground `hg = heightAt(cx*16+8, cz*16+8)`:
     wall/floor cells occupy `hg-1 .. hg+2` and fill `builtin:dirt` where ground falls below hg
     (terrain-conforming: disclosed quirk: partial embedding on slopes); roof flat at `hg+3`
     `builtin:wood`. Well: ring of 8 `builtin:stone` + centre water column at `hg`. No beacon.
   - Pyramid: desert && `% 48 === 0`: square base side 9..13 (stream), height half-side: cells where
     `|dx|<=r && |dz|<=r` and `y` from ground up to `ground + (half - max(|dx|,|dz|))` ->
     `builtin:sand`; interior `builtin:stone` shell 1 thick... (simple: all sand, hollow core air,
     one entrance carved at a stream side, `builtin:glowstone` at the apex cell - light works via the
     registry's glowing behaviour).
   - Mountain arch (cheap third one): mountain && `% 32 === 0`: a `builtin:stone` 5-wide 3-tall arch
     on the local surface (frame + lintel, interior air) - visible proof mountains get built things.
   StructureAt must be pure per-cell: (chunk, cell) -> id; house membership recomputed from the
   stream each call (bounded: at most 5 footprints per chunk, cheap integer compares).
6. columnTop (server, mobs): tops come from `heightAt`, which now includes biomes; structure blocks
   above h are not in columnTop - mobs perch at ground under a house, same as under trees today
   (disclosed known behaviour, not a regression).
7. Village coords for proofs: stages import `frontend/dve/src/world.js` in node (it is import-free
   standalone - verified) and scan for `biomeAt==desert` / village-chunk hashes to pick teleport
   coords. The backend twin is diffed against it by the parity test (next bullet) via `npx tsx`
   (backend has tsx? if not, `npx tsx` on demand or compile terrain.ts with esbuild - one-liner in
   the stage).
Proof (s28terrain, the heavy one, budget 2400):
(a) PARITY: node-import world.js (browser twin) and terrain.ts (via tsx/esbuild), compare
`heightAt/baseBlock/biomeAt/structureAt` on ~300k random points across [-5000,5000]^2, all y 0..63
sampled where relevant - zero mismatches. THIS IS the regression lock for the whole geometry batch.
(b) In-world: biome census - from spawn walk/setPos to node-found coords (desert, village, mountain)
via the same REST/`setPos` + sector-stream machinery s26water uses; per site: sample
`viewCell` grid through the engine mirror -> desert: >=80% sand at surface; village: >=30 planks +
>=4 glass + >=6 wood within +-16 cells of the node-computed house centre; mountain: stone surface
majority above sea. (c) Vision shots per site: `desert.png`, `village.png`, `mountain.png` (see
Vision section for criteria). (d) villages deterministic across reloads: same coords -> same planks.
Ledger: biomes + structures entries (terrain changes - NEW worlds generate differently; EXISTING
saved edits unaffected but untouched terrain visibly changes... disclose loudly: adding biomes
rewrites base terrain for every world; saved player edits stay, unedited regions morph. If the user
wants old terrain preserved they need new worlds - state that in the ledger).

---

## 13. Settings (items 16, 17, 18, 19) - small, but with care

Current anchors: DEFAULT_SETTINGS `app.js:17` `... render: "flat" }` + sanitizer `app.js:33`
`if (!["flat", "detailed"].includes(settings.render)) settings.render = "flat";`; FOV slider
`index.html:166` `min="60" max="360" step="1" value="80"`, conversion `app.js:165`
`fov: settings.fov * Math.PI / 180 * 0.72,`, engine clamp `main.js:147`
`camera.fov = clamp(settings.fov, 0.4, 1.5);`; sensitivity `index.html:165` `min="1" max="10" ...
value="5"`, `app.js:164` `sensitivity: settings.sens * 0.00046,`; server section
`index.html:164` `set-server` label + options at app.js:1185-1187 + handler `:1267`
(sets ac_server_choice, reloads) + reset button clears it (`:1268`).
Implementation:
1. render default: DEFAULT_SETTINGS `render: "detailed"`; sanitizer fallback -> `"detailed"`.
   (Users who chose flat keep it - their stored value wins. Disclose default change.)
2. remove server section: delete the `set-server` label (index.html:164), the options builder +
   change handler + the `ac_server_choice` lines (app.js:29, 1185-1187, 1267-1268 fragment);
   keep `settings.server` computed as today (`isLocalPage ? "local" : "global"`) so offline mode is
   untouched; remove it from syncSettingsInputs + the reset handler. Grep the stage suite for
   `set-server` usage and update any stage that pokes it.
3. FOV: slider `min="60" max="120" step="1" value="80"`; engine clamp `:147` ->
   `clamp(settings.fov, 0.35, 1.6)` (120 deg * 0.72 = 1.508 rad fits; the old 1.5 ceiling would
   clip the top two stops). Keep the 0.72 factor (preserves today's 80 deg = 0.96 rad default).
4. sensitivity: slider `min="1" max="30" step="1"`; factor stays `* 0.00046` (30 -> 0.0138 rad/px;
   pointer-lock deltas are small - verify no app-side clamp exists, none found).
Proof (s28menu, same stage as item 1): fresh localStorage -> `set-render` value `detailed`,
screenshot on first join shows textured world (vision: `look-default.png` - recognisable grass
texture, not flat green); sliders: `#set-fov` attrs 60/120, value 80; engine
`camera.fov` at slider 120 = ~1.508 +/- 0.01; `#set-sensitivity` max 30; no `#set-server` element;
reset button leaves `detailed`.

---

## Circuit & publish

- New `/tmp/acv2/circuit28.sh` (copy circuit27.sh conventions, same fail-counts-green logic):
  stages = `s28menu s28keys s28climb s28place s28mine s28light s28studio s28inv s28mobsdb
  s28height s28infinite s28terrain` + carry-overs `s26drop s26crop s26monaco s27beam s27presence s27look
  s27passthru s27growth s27offline` and an ADAPTED `s26water` (swim is gone: keep the pool-crossing
  walk loop + eat/death/revive machinery; drop/adjust any claim that asserted swim buoyancy or the
  -2 sink cap; deep-pool entry now = sink fast). s26baseline first. Budgets: s28terrain=2400,
  s28climb=900 (walk+wheat ladder), s28infinite=1200, s28mine=600, others 300-600, carry-overs
  inherit circuit27 values.
- Commit cadence per slice: backend repo commits (migrations first if any), frontend repo commits
  (engine dist rebuilt IN the same frontend commit), root gitlink bump + README ledger entry
  together. ?v= bump + gitlink when index.html/app.js change. Restart ac-api after migration
  commits (dev picks up new schema only after `migrations apply --local`).
- Publish order (same as last batch): remote migrations 0029/0030/0031 first (0029 additive column +
  seeds; 0030 REBUILDS inventories - additive data but run during low traffic; disclose),
  `wrangler deploy`, frontend push (then purge jsDelivr if smoke-pub hashes mismatch:
  `curl "https://purge.jsdelivr.net/gh/LaEsperantisto/all-contrib@main/app.js"`), extended
  `smoke-pub.mjs` (registry now must carry `climbable` + ladder rows; add `ladder` to the
  "registry has" claims), root push.
- Ledger entries to make as things land: ladder/climbable (0029) + tool speeds; inventories world
  scoping (0030 - biggest user-visible disclosure); mobs table (0031 - deploys NO LONGER drop the
  mob field; 5 s staleness); swim removed / deep sea deadly; tap-break -> hold-mining + bedrock
  unbreakable + 5/s break cap; support select replaced by placement lists (crop/builtin legacy
  rules survive silently); biomes/villages rewrite unedited terrain for every world; height limit
  32 -> 64 (perf note + spawn anchor change); world window infinite to ±1,000,000; FOV/sens/look
  defaults. Wire-shape changes: none beyond server scoping rides already-sent params.

## Vision pass (how to use LLM Vision for the visual proofs)

The proof harness already captures pixels: `tab.shot(name)` (lib.mjs:222-225) writes
`/tmp/acv2/shots/<name>.png`. The `read` tool decodes a PNG path inline - no selector needed
(`read {"path":"/tmp/acv2/shots/village.png"}` returns the image). Procedure after EVERY stage with
a shot: (1) run the stage normally; (2) `read` each shot the stage produced; (3) against the stage's
header comment `EXPECTED (vision): ...` bullet list, answer PASS/FAIL per criterion in your message
(and append one `¶vision: <shot> <pass|fail> <note>` line to the stage log with a bash echo - it is
an artifact, not a claim); (4) a vision FAIL counts as the stage failing: fix and re-run the stage.
Close-ups: stages move the CAMERA, not the image - `dveView.setPos` + short waits, and for UI shots
the dialog is already DOM, set the viewport by opening the dialog. Per-shot criteria:
- `look-default.png`: first join on a fresh profile - terrain shows TEXTURES (grass blades, dirt
  speckle), not flat single-colour faces; mining bar not visible (no mining active).
- `minebar.png`: mid-hold: a thin bar directly under the crosshair, partially filled, target block
  still in place.
- `ladder-climb.png`: player mid-climb inside a ladder column (ladder panel visible through/around
  the view), ground well below.
- `greenhouse.png` / `dirt-hut.png`: glass hut interior visibly brighter than the dirt hut; the two
  shots taken from the same relative inside position.
- `desert.png`: wide sand expanse to the horizon, palm-less, flat dunes.
- `village.png`: >=2 plank houses with glass windows in frame.
- `mountain.png`: elevated stone peak above the sea plain; arch visible if standing near it.
- `far-walk.png`: a landscape at |x| ~ 300+ with no visible void edge or wall seam.
- `tower64.png`: a player-placed column up past the old ceiling with a beacon glow at the top.

## Open interpretation calls (decide at execution, cheapest defensible option)

- "Wheat should grow into the higher stages (again, programmed to do so)": the ladder exists and
  was fixed last batch; this plan treats it as KEEP-IT-WORKING under all geometry changes (s28climb
  asserts wheat_1 -> wheat_4 end-to-end) rather than adding stages.
- Mobs hydration proof leg (d): if the shared-service-restart dance proves flaky in-circuit,
  (a)-(c) gate the circuit and (d) gets a documented manual run before publish.
- Height 64 vs 48: measurement decides (mesh-stats), disclose either way.
