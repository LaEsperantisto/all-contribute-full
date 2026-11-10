-- 0028: pass-through blocks. `pass_through` marks a block whose collision is
-- skipped for bodies (players, mobs, third-person camera ray): the block still
-- renders and is targetable, but bodies walk through it. Crops are the first
-- users — wheat is drawn as crossed quads, and standing "in" a crop cell felt
-- like being blocked by air's opposite. Farmland stays solid.
ALTER TABLE blocks ADD COLUMN pass_through INTEGER NOT NULL DEFAULT 0;
UPDATE blocks SET pass_through=1 WHERE id LIKE 'builtin:wheat_%';
