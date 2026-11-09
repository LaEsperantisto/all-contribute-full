# Next Features Plan — drops → water → farmland/crops → Monaco

Status: PLAN ONLY — nothing in this file has been executed.
Written 2026-11-09. All line anchors verified against the working tree on that date;
re-verify anchors by their quoted strings (line numbers drift).

Order is fixed by dependency: crops-harvest reuses the drop spec (feature 1);
the water terrain shift should land before crop proof stages so the world shape
is final; Monaco is last because it is independent UI weight.

Before this plan starts, the CURRENT batch must still ship:
s11 green (run20 in flight at writing time) → circuit3 all five stages fail=0 →
frontend `git push origin main` → verify Pages revs + `p50.mjs` vs published →
cleanup → final report. Only then open this plan.

---

## 0. Ground rules (apply to every feature)

- Node 22 for EVERY node/wrangler call:
  `export PATH=/home/aster/.config/nvm/versions/node/v22.23.4/bin:$PATH` (system node is v20).
- Never edit `backend/` or `frontend/` files WHILE a stage/circuit runs (wrangler dev
  hot-reload drops live WS; ac-static serves `frontend/` live).
- Commit cadence (user standing order): `git add . && git commit` in `frontend/` as each
  slice lands; then bump the root repo gitlink with a root commit. Frontend push ONLY as
  the publish step. NEVER push the root repo.
- app.js cache-bust: any change to `frontend/app.js` (or `index.html`) → bump
  `app.js?v=N` in `frontend/index.html` (currently v=27; this batch will make v=28..v=31,
  one per feature touching the UI).
- dve bundle changes (`frontend/dve/src/**`) → `cd frontend/dve && npm run build`
  (esbuild; dist is committed). New revs auto-record in `frontend/dve/dist/rev.js`;
  app.js fetches rev.js `?n=Date.now()` and bundles by `?h=` hash — no extra bump needed.
- Local D1 migrations: `cd backend && npx wrangler d1 migrations apply all-contribute-db --local`.
  If sqlite is locked: `write proc://ac-api/kill`, apply, relaunch ac-api
  (`cd backend && npx wrangler dev --port 8787` as service `ac-api`).
- Prod backend deploy chain (only at publish): `cd backend && npx wrangler deploy`,
  then `npx wrangler d1 migrations apply all-contribute-db --remote` for each NEW
  migration. This mutates production D1 — record it in the disclosure ledger.
- Proof harness: `/tmp/acv2` CDP pattern (lib.mjs `Tab/enter/d1/INFO/API/cookieOf`).
  Stage files for this batch are named `s26drop.mjs`, `s26water.mjs`, `s26crop.mjs`,
  `s26monaco.mjs` — probe usernames MUST be underscore-safe, 3–24 chars
  (`s26_a`, NOT `s26-a`). One Chrome with the three flags recipe; never two probes
  on one Chrome; never leave tabs open.
- Harness traps (already paid for — do not re-pay): `Tab.fn(decl, args)` args is the
  ARGUMENTS LIST (wrap one array param in `[...]`); negative numbers in interpolated
  page code MUST be paren-wrapped (`(${x + 0.5})`) or render `--` postfix SyntaxErrors;
  page code CANNOT fetch relative `/api/...` (hits :8000 static → 404) — always
  `${JSON.stringify(API)}` absolute; `enter()` includes the prelude — never `tab.go()`
  before it; call `dveView.releaseInput()` before any pick/aim act (stuck keyUp drifts
  the physics camera); `lastHealth`-style page locals must be DECLARED (ReferenceError
  inside an eval'd async fn surfaces as a silent null).
- After ANY s26 page-template edit, run a `new Function` dry render (schk.cjs pattern).

---

## 1. Feature 1 — per-block drop spec

Goal: a block can declare which item it yields when broken, and how many.
Migration already committed (root `ec1d026`), NOT yet applied.

### 1.1 Migration
`backend/migrations/0025_drop_spec.sql` (exists):
```sql
ALTER TABLE blocks ADD COLUMN drop_item_id TEXT;
ALTER TABLE blocks ADD COLUMN drop_qty INTEGER NOT NULL DEFAULT 1;
```
Apply locally first (stop ac-api if locked). Builtins stay NULL → implicit credit.

### 1.2 Backend — `handleBreak` (backend/src/index.ts, ~:1476-1563)
Anchor (verified):
```ts
const dropper = await env.DB.prepare(
  "SELECT id FROM items WHERE place_block_id=? ORDER BY is_builtin DESC, id ASC LIMIT 1"
).bind(current).first<{ id: string }>();
const dropId = dropper?.id ?? current;
```
Replace with a two-tier credit:
```ts
const blockRow = await env.DB.prepare(
  "SELECT drop_item_id, drop_qty FROM blocks WHERE id=?"
).bind(current).first<{ drop_item_id: string | null; drop_qty: number }>();
let dropId: string;
let dropQty: number;
if (blockRow?.drop_item_id) {
  // the declared drop may outlive its item row; fall back like the default tier
  const known = await env.DB.prepare("SELECT id FROM items WHERE id=?")
    .bind(blockRow.drop_item_id).first<{ id: string }>();
  dropId = known?.id ?? current;
  dropQty = Math.min(99, Math.max(1, blockRow.drop_qty ?? 1));
} else {
  const dropper = await env.DB.prepare(
    "SELECT id FROM items WHERE place_block_id=? ORDER BY is_builtin DESC, id ASC LIMIT 1"
  ).bind(current).first<{ id: string }>();
  dropId = dropper?.id ?? current;
  dropQty = 1;
}
```
Grants (anchor `[{ item: dropId, qty: 1 }, ...contents, ...(run?.gives ?? [])]` in the
`env.DB.batch` — ~:1540): change first element to `{ item: dropId, qty: dropQty }`.
Response (anchor `return json({ ok: true, x, y, z, dropped: dropId, ...`): keep
`dropped: dropId`, ADD `drop_qty: dropQty`.
The `MAX_STACK` full-stack 400 check already runs against `dropId` — no change.

### 1.3 Backend — `listBlocks` (~:1309)
Add `drop_item_id,drop_qty` to the SELECT string (anchor: the long
`"SELECT id,name,creator_name AS creator,...,model,script FROM blocks ORDER BY..."`)
and to the mapped object (`drop_item_id: row.drop_item_id ?? null, drop_qty: row.drop_qty ?? 1`).

### 1.4 Backend — POST /api/blocks (~:2240) and PUT /api/blocks/:id (~:2283)
Insert after the `const script = sanitizeScript(...)` pair in BOTH handlers:
```ts
let dropItemId: string | null = null;
if (data.drop_item_id !== undefined && data.drop_item_id !== null &&
    String(data.drop_item_id).trim() !== "") {
  dropItemId = String(data.drop_item_id).trim();
  const known = await env.DB.prepare("SELECT id FROM items WHERE id=?")
    .bind(dropItemId).first<{ id: string }>();
  if (!known) return err("Drop item must be a known item id.", 400, origin);
}
const dropQtyRaw = data.drop_qty === undefined || data.drop_qty === null || data.drop_qty === ""
  ? 1 : Number(data.drop_qty);
if (!Number.isInteger(dropQtyRaw) || dropQtyRaw < 1 || dropQtyRaw > 99)
  return err("Drop quantity must be an integer from 1 to 99.", 400, origin);
```
POST INSERT (anchor `"INSERT INTO blocks(id,name,...,model,script) VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)"`):
append `drop_item_id,drop_qty` columns and the two `?`, bind `dropItemId, dropQtyRaw`.
PUT UPDATE (anchor `"UPDATE blocks SET name=?,...,script=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"`):
append `drop_item_id=?,drop_qty=?` before `updated_at`.

### 1.5 Backend — items DELETE cascade guard
Block DELETE already cascades world_edits; a deleted ITEM can dangle `drop_item_id`.
Find the items DELETE handler (`grep -n '/api/items' backend/src/index.ts` — DELETE branch),
and in it add:
```ts
await env.DB.prepare("UPDATE blocks SET drop_item_id=NULL WHERE drop_item_id=?").bind(id).run();
```
(Defence-in-depth: handleBreak already null-checks the item at break time.)

### 1.6 Frontend — form + payload
`frontend/index.html` after the Support/Incompatible form-row (anchors:
`<select id="block-support">` row, `id="block-incompatible"` at :241-242), insert:
```html
<div class="form-row">
  <label>Drops <span class="optional">what breaking it yields</span>
    <select id="block-drop-item"><option value="">Default (the programming item)</option></select>
  </label>
  <label>Drop quantity<input id="block-drop-qty" type="number" min="1" max="99" value="1"></label>
</div>
```
`frontend/app.js`:
- Populate `#block-drop-item` in `refreshRegistry()` after `currentItems=...` (anchor
  :536). Preserve the selected value across refreshes; options from
  `currentItems.map(i => [i.id, i.name])`, `escapeAttr` the ids.
- Submit payload: anchor the `const common={...}` line at :836 — append
  `drop_item_id:$("block-drop-item").value||null,drop_qty:Number($("block-drop-qty").value)||1`.
- Edit-fill: `enterEditMode` (anchors :861-862) — append
  `$("block-drop-item").value=block.drop_item_id||"";$("block-drop-qty").value=block.drop_qty??1;`.
- POST success reset (anchor the `e.target.reset()` line): restore
  `$("block-drop-item").value="";$("block-drop-qty").value=1;`.
Bump `app.js?v=27` → `?v=28` in index.html.

### 1.7 Proof stage `s26drop.mjs`
Names: users `s26_a` (create via D1 insert like s25 pattern), custom block
`s26:dropone` (REST POST as s26_a with `drop_item_id:"builtin:stone", drop_qty:3`),
item for it auto? NO — the custom block needs a programming item to be placeable:
create item `s26_ore_item` (place_block_id the block) too.
Claims:
1. POST with unknown `drop_item_id` → 400; `drop_qty:0` → 400; `drop_qty:100` → 400.
2. Place block (REST with the item), read inventory baseline `d1()`, REST break,
   inventory delta: +3 `builtin:stone`, −1 `s26_ore_item` is NOT refunded by design
   (break gives the drop, the held item was consumed at place — check current
   behaviour and assert what it actually is, do not assert from assumption).
3. Block with NULL drop (another s26 block) → break yields the programming item qty 1
   (regression of old behaviour).
4. Live game break (tab) → toast text includes the drop; gerrs/werrs empty tail.
Cleanup: delete created blocks/items via REST DELETE (cascade verified).

### 1.8 Commits
- root: migration already in; commit index.ts changes: "feat: per-block drop spec (backend)".
- frontend: form+payload commit; root gitlink commit.
- Apply 0025 `--remote` at publish time (disclose prod D1 mutation).

---

## 2. Feature 2 — water + sea level (+ beaches)

Goal: terrain fills with `builtin:water` up to `SEA_LEVEL = 10` where ground is
lower; shore cells become `builtin:sand`. No drowning (disclosed simplification).

### 2.1 Migration `0026_water.sql` (NEW)
- blocks: `builtin:water` — behaviour `transparent`, model NULL (transparent cube
  renders via the transparent behaviour; verify with one test cell before baking the
  model choice), colour `#2b6fdb`, light 0, hardness -1? (hardness min is 0; use 0.1;
  water is not player-placeable anyway — NO item row for water, so it can never be
  placed; breaking it (it's in base terrain, not world_edits → REST break of a base
  cell writes an air tombstone, allowed) yields the `dropper ?? current` fallback =
  "builtin:water" item which doesn't exist → handleBreak credits item id
  "builtin:water" into inventories — WRONG. Guard: in handleBreak, if dropId equals
  `current` and no items row exists for it, credit nothing (`dropId=null` → grant
  list `dropId ? [{item,qty}] : []`). Implement this guard REGARDLESS of water
  (prevents any base-only block id leaking into inventories); assert it in s26water.
- blocks: `builtin:sand` + item `builtin:sand` (place_block builtin:sand), both
  16×16 PNG textures embedded base64 (generate with the node zlib/CRC recipe used
  for grass textures: build 16px PNG, base64, paste into SQL — keep generator script
  in the migration comment header for reproducibility).
- Water texture: translucent-ish blue noise; alpha baked in the PNG + `transparent`
  behaviour (mesher transparency path already exists for leaves/glass).
- Also register water/sand in whatever seeds builtin ITEMS for textures — follow
  migration 0016/0017 layout exactly (0017 is the closest template).

### 2.2 Terrain — BOTH mirrors, byte-identical rule
`backend/src/terrain.ts` `baseBlock` (verified body) and `frontend/dve/src/world.js`
`baseBlock` (mirror; uses `SLAB.Y1`):
```ts
export const SEA_LEVEL = 10;
// inside baseBlock, replacing the y>h branch top:
if (y > h) {
  if (y <= SEA_LEVEL) return "builtin:water";
  if (h >= SEA_LEVEL) {
    ...existing trunk/crown/ring tree checks, unchanged...
  }
  return "air";
}
if (y < h && caveAt(x, y, z) && y > 1) return "air";
if (y === h) return h < SEA_LEVEL ? "builtin:sand" : "builtin:grass";
```
(`if (y === 0) return "builtin:bedrock";` stays first; caves carve water columns —
fine, disclose.) Tree ring loop must sit inside the `h >= SEA_LEVEL` guard too.

### 2.3 Client physics — `frontend/dve/src/main.js`
- `solidVoxel` (verified :216): `return id !== undefined && id !== null && id !== "air" && id !== "builtin:water";`
- `tick` (verified :240+): after movement, before gravity: read
  `cellAt(Math.floor(camera.position.x), Math.floor(camera.position.y - 0.5), Math.floor(camera.position.z))`;
  if water: gravity ×0.25, vy clamp to −2 (sink slowly), W/Space → vy = 3.2 (swim up),
  horizontal speed ×0.6. Keep it inside the existing vy block; ~15 lines.
- Light: water cells must propagate light like air — check the generator's opacity
  table comes from VoxelTags (`behaviour:"transparent"` ⇒ not opaque; the generator
  heal fix already tolerates late tags).
- Rebuild dist (revs change) → commit dist.

### 2.4 Cross-cutting checks
- `node /tmp/treecheck.mjs` MUST go green with the new rule (trees gated) BEFORE it
  is deleted at cleanup; if deleted, recreate the one-node terrain-vs-world diff
  harness first (compare baseBlock(terrain.ts build) vs baseBlock(world.js) over a
  ±512 block sample grid incl. h<10 columns).
- Mob spawning: `spawnOne` ground pick — confirm it rejects water cells (grep
  spawnOne body in index.ts); if it only checks "not air", mobs will stand on water
  — fix to reject `builtin:water` ground, or disclose.
- Beds/spawn anchors under water: player respawn physics now buoyant; fine.
- DISCLOSE loudly: existing local AND production worlds visually change — every
  column with h<10 floods up to y=10; bases built near sea level may flood. Old
  builds are untouched in `world_edits` (base terrain only changes).

### 2.5 Proof stage `s26water.mjs`
1. Fresh REST read of a known low column (find one via node-side terrain import:
   use the backend's own terrain.ts? Easiest: `d1` has no terrain; use the PAGE's
   `dveMod.baseBlock(x,y,z)` after join) — assert `builtin:water` at y≤10 over a
   sampled h<10 column and `builtin:sand` at the bed of a shallow shore (h 8..9).
2. Jump into water: setPose above a water column, simulate (no keys), poll camera y
   over 4 s — assert it sinks slowly and STOPS (buoyancy floor), health never drops
   (no drowning) — disclose that drowning is absent.
3. Break a water cell (it's base, first break writes air tombstone): assert NO
   `builtin:water` lands in inventory (the 1.2 guard) and toast path intact.
4. A tree at h<10 (ocean) has no trunk (baseBlock probe).
5. gerrs/werrs/merrs empty tail.

### 2.6 Commits
- root: migration 0026 + terrain.ts + index.ts guard.
- frontend: world.js + main.js + rebuilt dist; `?v=` bump only if app.js/index.html
  touched (physics are in the bundle — revs cover it).

---

## 3. Feature 3 — farmland + wheat growth

Goal: `builtin:farmland` (placeable), `wheat_seed` item that places
`builtin:wheat_1`, stages 1→4 advancing server-side, harvest via feature-1 drops.

### 3.1 Migration `0027_farm.sql` (NEW)
Blocks (textures via the same PNG-generation recipe; follow 0017 layout):
- `builtin:farmland`: behaviour `solid`, full cube, dark-brown furrow texture, hardness 0.4; item `builtin:farmland` (place_block farmland).
- `builtin:wheat_1..4`: behaviour `transparent`, model `dve_simple_crossed_panels`
  (exists in BLOCK_MODELS, verified :1277 — no new geometry work), hardness 0, light 0,
  drop spec columns (feature 1!): stage1–3 → `drop_item_id:'wheat_seed', drop_qty:1`;
  stage4 → `drop_item_id:'wheat', drop_qty:2`.
Items:
- `wheat_seed` (kind material, place_block_id `builtin:wheat_1`).
- `wheat` (kind food, heal 2 — items table has heal; eating path already exists).
No hoe/cell-tillage: placing `farmland` directly; wheat_1 places on any solid surface
(`rules support:"solid"`). DISCLOSE simplification vs Minecraft's hoe/till rule.

### 3.2 Backend growth — WorldLive alarm (backend/src/index.ts, alarm verified :372+)
In `alarm()` after `await this.spawnOne(now);` add `await this.stepCrops(now);` and:
```ts
// Crops: every ~20 s, advance at most 32 wheat cells one stage. A cell's
// created_at is the clock (every edit stamps it), so "20 s since it became
// this stage" needs no extra column.
private async stepCrops(now: number): Promise<void> {
  if (!this.server || now % 20000 < MOB_TICK_MS) return;   // DO memory clock; hibernation-safe enough
  const rows = await this.env.DB.prepare(
    "SELECT x,y,z,block_id FROM world_edits WHERE server_id=? AND block_id IN ('builtin:wheat_1','builtin:wheat_2','builtin:wheat_3') LIMIT 32"
  ).bind(this.server).all<{x:number;y:number;z:number;block_id:string}>();
  for (const r of rows.results) {
    // age gate: created_at older than 20 s
    const aged = await this.env.DB.prepare(
      "SELECT 1 FROM world_edits WHERE server_id=? AND x=? AND y=? AND z=? AND created_at > datetime('now','-20 seconds')"
    ).bind(this.server, r.x, r.y, r.z).first();
    if (aged) continue;
    const next = "builtin:wheat_" + (Number(r.block_id.slice(-1)) + 1);
    // mirror the break/place write shape (upsert + log + publishEdit):
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO world_edits(server_id,x,y,z,block_id,placed_by) VALUES(?,?,?,?,?,?) ON CONFLICT(server_id,x,y,z) DO UPDATE SET block_id=excluded.block_id, created_at=CURRENT_TIMESTAMP"
      ).bind(this.server, r.x, r.y, r.z, next, "system"),
      this.env.DB.prepare("INSERT INTO world_log(server_id,x,y,z,block_id) VALUES(?,?,?,?,?)")
        .bind(this.server, r.x, r.y, r.z, next),
    ]);
    await publishEdit(this.env, this.server, r.x, r.y, r.z, next);
  }
}
```
Notes: `placed_by` column type — check it accepts a non-user string (INTEGER FK?) at
implementation; if FK, use NULL or the planter's id from the existing row (SELECT
placed_by along with the row). Keep WORLD_LOG_KEEP prune as handleBreak does.
Growth only advances cells that are currently in the edits table (planted) — base
terrain unaffected.

### 3.3 Frontend
Nothing structural (blocks/items flow through the registry sync). Wheat textures:
4 green→gold crossed-panel PNGs + farmland PNG in the migration. Bump `?v=` only if
app.js touched (expect: no touch → no bump).

### 3.4 Proof stage `s26crop.mjs`
1. REST place farmland at a clear surface; place `wheat_seed` on top (201, cell
   `builtin:wheat_1`).
2. Poll the cell (in-page `cellBlock` + REST log) — assert `builtin:wheat_2` within
   ~45 s (20 s period + tick jitter), assert NOT advanced before ~15 s (age gate).
3. Wait through a full ladder (≤ 3×45 s) to wheat_4 — or fast-forward deterministically:
   `d1()` UPDATE the row's created_at (`created_at = datetime('now','-60 seconds')`)
   between polls — do THAT, it keeps the stage under 2 min.
4. Break wheat_4 (REST): inventory delta `+2 wheat, 0 wheat_seed` (drop spec); break
   a wheat_2: `+1 wheat_seed`.
5. Eat wheat (POST eat endpoint path — verify the endpoint name in index.ts at
   implementation) → heal frame.
6. gerrs/werrs tail clean.

### 3.5 Commits
root: migration 0027 + index.ts stepCrops. frontend: texture-less (textures in DB) —
expect no frontend diff unless the model dropdown label for crossed_panels needs one
(verify `modelLabel` at :829 renders it acceptably; add a label case if ugly).

---

## 4. Feature 4 — Monaco editor for block scripts

Goal: replace the raw `<textarea id="block-script">` (verified :267 area) with a
vendored Monaco Lua editor in the block workshop, plus a server syntax check.

### 4.1 Vendoring (static Pages constraint — no CDN)
- `cd frontend/vendor && mkdir monaco` and vendor a PINNED monaco-editor release's
  `min/vs` tree + `loader.js`. Method: `npm pack monaco-editor@<pin>` (Node 22),
  extract `package/min/vs` → `frontend/vendor/monaco/vs`. Disclose payload size
  (~4–8 MB added to Pages — Pages has no build step; static commit).
- Verify `git add` doesn't choke; consider `.gitattributes` linguist-generated for
  vendor/ (cosmetic).

### 4.2 Client wiring — frontend/index.html + app.js
- index.html: add `<div id="block-script-editor" hidden></div>` next to the existing
  textarea (textarea stays as the no-Monaco fallback; it MUST keep working).
- app.js boot (lazy, first time the workshop panel opens):
  ```js
  let blockEditor=null,editorTried=false;
  async function mountBlockEditor(){
    if(editorTried)return;editorTried=true;
    try{
      await loadScript("/vendor/monaco/vs/loader.js",6000);
      self.MonacoEnvironment={getWorkerUrl:()=>"/vendor/monaco/vs/editor/editor.worker.js"};
      await new Promise((res,rej)=>require.config({paths:{vs:"/vendor/monaco/vs"}}));
      // AMD: require(["vs/editor/editor.main"],...) then
      // blockEditor=monaco.editor.create($("block-script-editor"),{value:$("block-script").value,language:"lua",theme:"vs-dark",automaticLayout:true,minimap:{enabled:false},scrollBeyondLastLine:false});
      // hide textarea, show the editor div;
    }catch{ /* keep textarea */ }
  }
  ```
  All reads/writes of the script go through one accessor:
  `scriptValue(){return blockEditor?blockEditor.getValue():$("block-script").value;}` and
  `setScriptValue(v)` — replace EVERY `$("block-script").value` use (grep for it:
  submit payload :836 area, enterEditMode fill, `e.target.reset()` reset, the
  placeholder) with the accessor.
- Workers on Pages: same-origin, so `getWorkerUrl` above is enough; if a CSP/header
  issue appears, fall back to `monaco.editor.create(..., {})` after setting
  `self.MonacoEnvironment={}$defaultWorkerFactory` — decide empirically in smoke.

### 4.3 Server syntax check — `POST /api/block/script-check`
- Handler (near the other /api/blocks routes): auth required; body `{script}`; cap 6000
  chars like `sanitizeScript`.
- Semantics: parse-only via the existing sandbox — `runBlockScript(src, "on_interact",
  {player:"__check__"}, freshState, {maxInstructions:100, wallMs:250, missingEntryIsNoop:true})`
  (signature verified :1649; `missingEntryIsNoop` makes a missing function a clean
  no-op). Inspect `ScriptOutcome` shape (lua.ts) at implementation to map
  `syntax|runtime error` back to the response.
- Response: `200 {ok:true}` on clean parse (entry noop); `200 {ok:false, error, line}`
  when the interpreter reports a syntax error (lua.ts error message includes line —
  extract; if it doesn't, add a `line` field to ScriptOutcome — backend-only).
- Client: on editor blur + on submit-while-invalid, POST check, render
  `monaco.editor.setModelMarkers(model, "lua", [{startLineNumber:line,...}])`;
  textarea fallback path: toast only. Do NOT block submit on check failure (server
  already rejects bad scripts at publish with its own message — the check is advisory
  pre-flight; disclose that double truth exists).

### 4.4 Proof stage `s26monaco.mjs`
1. Open workshop as `s26_m1`; assert `#block-script-editor` non-hidden and textarea
   hidden (Monaco mounted); type invalid Lua (`function broken(`) → after blur, assert
   a marker exists (`blockEditor.getModel().getObjectByDecryption...` use
   `monaco.editor.getModelMarkers({})` via CDP eval — assert length ≥1).
2. Valid script → markers clear; type script, Save → publish succeeds → registry
   contains it (REST listBlocks).
3. `POST /api/block/script-check` directly (REST): valid → ok:true;
   `syntax error` script → ok:false with a line number; oversized → 400;
   unauthenticated → 401.
4. Fallback path: block the vendor loader (CDP request interception is not in lib —
   instead test with a second profile tab where the editor fails fast: navigate with
   a query flag? If nothing cheap: skip UI fallback and disclose "textarea fallback
   not live-proven; logic reviewed").
   Better cheap proof: set `sessionStorage` guard? — decide at implementation; at
   MINIMUM prove the textarea still submits when `blockEditor===null` by calling
   `setScriptValue("x")` then reading the textarea value with the editor force-closed
   (`blockEditor=null` via CDP) and submitting — that proves the accessor pair.
5. engine errors tail clean.

### 4.5 Commits + publish
- frontend: vendor tree + index.html + app.js (bump `?v=`). Vendor in one commit
  ("chore: vendor monaco-editor X.Y.Z").
- backend: script-check route + (maybe) ScriptOutcome.line — root commit.
- Publish chain per §0 (prod deploy needed for script-check to exist there).

---

## 5. Circuit + proof bookkeeping for this batch

- Extend `/tmp/acv2/circuit.sh` stage list: append `s26drop 900`, `s26water 1500`,
  `s26crop 1800`, `s26monaco 900` (after the existing five, which must stay green).
- Every stage tail-check: `grep -cE '^FAIL'` = 0 AND DONE sentinel per log.
- Keep the existing `werrs`/`gerrs`/`merrs`/`ray scan` diagnostics in s11; the
  generator heal fix + releaseInput lesson stay in any new harness code.

## 6. Running disclosure ledger for this batch (append entries as they happen)

1. Prod D1: migration 0025 (+0026, +0027) applied `--remote` — schema-only.
2. Terrain shift: every world's base terrain changes where h<10 (flooding, beaches);
   local AND published worlds visually differ from before. Disclosed, accepted.
3. No drowning, no water flow/simulation (static sea), hoe/till skipped (crops grow
   on any solid surface), drop qty capped 99, script-check advisory (server is truth),
   Monaco ~4–8 MB vendored payload on Pages, textarea fallback status as proven.
4. Local D1 mutations by s26 stages: s26_* users/worlds, test blocks/items (deleted
   at stage end), wheat/farmland/water-break tombstones left in world_edits.
5. Growth tick writes as `placed_by` system/NULL (as implemented) — world_log rows
   for growth (log grows; prune stays WORLD_LOG_KEEP).

## 7. Definition of done per feature

- [ ] migration applied local (+remote at publish)
- [ ] backend + client behaviour exercised by its s26 stage: fail=0, DONE
- [ ] no gerrs/werrs/merrs, no engine errors tail
- [ ] old behaviour regressions asserted (implicit drop, grass terrain above h≥10,
      textarea submit)
- [ ] commits (frontend, root gitlink, backend) + `?v=` bump where UI files touched
- [ ] circuit.sh includes the stage and the whole circuit still passes
- [ ] publish: Pages revs + prod worker chain + p50-style smoke vs published where
      the feature is live-site visible
