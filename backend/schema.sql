PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT NOT NULL UNIQUE,
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  idle_expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT REFERENCES users(id),
  creator_name TEXT NOT NULL,
  hardness REAL NOT NULL CHECK(hardness >= 0 AND hardness <= 1000),
  light INTEGER NOT NULL CHECK(light >= 0 AND light <= 15),
  colour TEXT NOT NULL,
  behaviour TEXT NOT NULL CHECK(behaviour IN ('solid','transparent','glowing','decorative')),
  rules_json TEXT NOT NULL DEFAULT '{}',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  creator_id TEXT NOT NULL REFERENCES users(id),
  creator_name TEXT NOT NULL,
  ingredients_json TEXT NOT NULL,
  result_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 1 AND quantity <= 999),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventories (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 999),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, item_id)
);

-- The shared world: base terrain is a deterministic function of coordinates
-- (backend/src/terrain.ts, mirrored in frontend), and player edits are the
-- only stored state. block_id 'air' marks a cell explicitly cleared.
-- Coordinates are 3D with y growing upward (world model v2).
CREATE TABLE IF NOT EXISTS world_edits (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  placed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y, z)
);

-- Sequence-numbered change feed for live sync (WS broadcast + polling fallback).
CREATE TABLE IF NOT EXISTS world_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Server-persisted player state: position + look, restored on rejoin.
CREATE TABLE IF NOT EXISTS player_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  yaw REAL NOT NULL DEFAULT 0,
  pitch REAL NOT NULL DEFAULT 0,
  health REAL NOT NULL DEFAULT 20,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Character appearance: persisted avatar colours, one row per user.
CREATE TABLE IF NOT EXISTS player_appearance (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  body_colour TEXT NOT NULL,
  head_colour TEXT NOT NULL,
  accent_colour TEXT NOT NULL,
  eye_colour TEXT NOT NULL DEFAULT '#1d2430',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Items registry: what a player HOLDS. A 'block' item is "programmed" to
-- place the block named by place_block_id; tools/weapons/food/materials carry
-- stats instead. world_edits still stores block ids — items are the handle,
-- blocks stay the world truth.
CREATE TABLE IF NOT EXISTS items (
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blocks
(id,name,creator_id,creator_name,hardness,light,colour,behaviour,is_builtin)
VALUES
('builtin:stone','Stone',NULL,'SYSTEM',1.5,0,'#777b82','solid',1),
('builtin:dirt','Dirt',NULL,'SYSTEM',0.5,0,'#79583f','solid',1),
('builtin:grass','Grass Block',NULL,'SYSTEM',0.6,0,'#648b4d','solid',1),
('builtin:wood','Wood',NULL,'SYSTEM',2,0,'#9b7045','solid',1),
('builtin:glass','Glass',NULL,'SYSTEM',0.3,0,'#8dc6d7','transparent',1),
('builtin:glowstone','Glowstone',NULL,'SYSTEM',0.3,15,'#f3c76b','glowing',1),
('builtin:leaves','Leaves',NULL,'SYSTEM',0.2,0,'#3f7a34','solid',1),
('builtin:bedrock','Bedrock',NULL,'SYSTEM',0,0,'#1b1d21','solid',1);

-- Builtin items mirror the builtin blocks (bedrock has none: it can never be
-- held or placed), plus the starter tool/weapon/food/material set.
INSERT OR IGNORE INTO items
(id,name,creator_name,kind,place_block_id,damage,speed,heal,durability,colour,is_builtin)
VALUES
('builtin:stone','Stone','SYSTEM','block','builtin:stone',0,1,0,0,'#777b82',1),
('builtin:dirt','Dirt','SYSTEM','block','builtin:dirt',0,1,0,0,'#79583f',1),
('builtin:grass','Grass Block','SYSTEM','block','builtin:grass',0,1,0,0,'#648b4d',1),
('builtin:wood','Wood','SYSTEM','block','builtin:wood',0,1,0,0,'#9b7045',1),
('builtin:glass','Glass','SYSTEM','block','builtin:glass',0,1,0,0,'#8dc6d7',1),
('builtin:glowstone','Glowstone','SYSTEM','block','builtin:glowstone',0,1,0,0,'#f3c76b',1),
('builtin:leaves','Leaves','SYSTEM','block','builtin:leaves',0,1,0,0,'#3f7a34',1),
('builtin:stick','Stick','SYSTEM','material',NULL,0,1,0,0,'#9b7045',1),
('builtin:planks','Planks','SYSTEM','block','builtin:wood',0,1,0,0,'#b58a5d',1),
('builtin:pickaxe','Pickaxe','SYSTEM','tool',NULL,1,2.2,0,120,'#8a8f98',1),
('builtin:axe','Axe','SYSTEM','tool',NULL,2,1.8,0,100,'#8a8f98',1),
('builtin:shovel','Shovel','SYSTEM','tool',NULL,1,1.6,0,90,'#8a8f98',1),
('builtin:sword','Sword','SYSTEM','weapon',NULL,5,1.2,0,140,'#c9ced6',1),
('builtin:apple','Apple','SYSTEM','food',NULL,0,1,3,0,'#c0392b',1);
