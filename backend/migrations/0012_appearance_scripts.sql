-- Appearance payload + scripted blocks.
--
-- A block can now ship a 16x16 PNG texture (base64 data URL) and ask for one
-- of the voxel models vlox already ships; an item can ship a 32x32 icon. The
-- player decides whether any of that detail is used (Settings > Look), so the
-- registry colour stays the fallback for everyone who prefers flat colours.
--
-- `script` is sandboxed Lua that runs on the Worker when a player interacts
-- with the block (E). `block_state` is that script's persistent key/value
-- store, one row per cell key, and `block_beams` caches the light columns a
-- script switched on so a joining player sees them without re-running Lua.
ALTER TABLE blocks ADD COLUMN texture TEXT;
ALTER TABLE blocks ADD COLUMN model TEXT;
ALTER TABLE blocks ADD COLUMN script TEXT;
ALTER TABLE items ADD COLUMN icon TEXT;

CREATE TABLE IF NOT EXISTS block_state (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y, z, key)
);

CREATE TABLE IF NOT EXISTS block_beams (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  colour TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y, z)
);
