-- 0022: a fifth block behaviour, 'useful'.
--
-- 'solid' / 'transparent' / 'glowing' / 'decorative' describe how a block sits
-- in the world. 'useful' describes what a block DOES when you interact with it:
-- the bed makes you wake up where you sleep, the beacon asks for a column of
-- light. SQLite cannot widen a CHECK in place, so the table is rebuilt with the
-- live column list (texture, model, script and the face textures included).
--
-- A D1 migration cannot turn foreign keys off — the engine keeps them enforced
-- for the whole batch — and `items.place_block_id` references blocks(id), so
-- blocks cannot be dropped while items points at it. Items is the only referrer
-- (nothing references items), so the rebuild unlinks it for one step and relinks
-- it at the end: every copy preserves all rows and every other constraint.
CREATE TABLE items_unlinked (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT REFERENCES users(id),
  creator_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('block','tool','weapon','food','material')),
  place_block_id TEXT,
  damage REAL NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  heal REAL NOT NULL DEFAULT 0,
  durability INTEGER NOT NULL DEFAULT 0,
  colour TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  icon TEXT
);
INSERT INTO items_unlinked
(id,name,creator_id,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,created_at,updated_at,icon)
SELECT id,name,creator_id,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,created_at,updated_at,icon
FROM items;
DROP TABLE items;
ALTER TABLE items_unlinked RENAME TO items;

CREATE TABLE blocks_widened (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT REFERENCES users(id),
  creator_name TEXT NOT NULL,
  hardness REAL NOT NULL CHECK(hardness >= 0 AND hardness <= 1000),
  light INTEGER NOT NULL CHECK(light >= 0 AND light <= 15),
  colour TEXT NOT NULL,
  behaviour TEXT NOT NULL CHECK(behaviour IN ('solid','transparent','glowing','decorative','useful')),
  rules_json TEXT NOT NULL DEFAULT '{}',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  texture TEXT,
  model TEXT,
  script TEXT,
  texture_top TEXT,
  texture_bottom TEXT
);
INSERT INTO blocks_widened
(id,name,creator_id,creator_name,hardness,light,colour,behaviour,rules_json,is_builtin,created_at,updated_at,texture,model,script,texture_top,texture_bottom)
SELECT id,name,creator_id,creator_name,hardness,light,colour,behaviour,rules_json,is_builtin,created_at,updated_at,texture,model,script,texture_top,texture_bottom
FROM blocks;
-- The builtin blocks that carry an interaction script are useful blocks.
UPDATE blocks_widened SET behaviour='useful' WHERE id IN ('builtin:bed','builtin:beacon');
DROP TABLE blocks;
ALTER TABLE blocks_widened RENAME TO blocks;

-- Restore the items -> blocks link.
CREATE TABLE items_relinked (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT REFERENCES users(id),
  creator_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('block','tool','weapon','food','material')),
  place_block_id TEXT REFERENCES blocks(id),
  damage REAL NOT NULL DEFAULT 0,
  speed REAL NOT NULL DEFAULT 1,
  heal REAL NOT NULL DEFAULT 0,
  durability INTEGER NOT NULL DEFAULT 0,
  colour TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  icon TEXT
);
INSERT INTO items_relinked
(id,name,creator_id,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,created_at,updated_at,icon)
SELECT id,name,creator_id,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin,created_at,updated_at,icon
FROM items;
DROP TABLE items;
ALTER TABLE items_relinked RENAME TO items;
