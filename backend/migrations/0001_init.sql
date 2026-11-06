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
CREATE TABLE IF NOT EXISTS world_edits (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  placed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y)
);

-- Sequence-numbered change feed for live sync (WS broadcast + polling fallback).
CREATE TABLE IF NOT EXISTS world_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO blocks
(id,name,creator_id,creator_name,hardness,light,colour,behaviour,is_builtin)
VALUES
('builtin:stone','Stone',NULL,'SYSTEM',1.5,0,'#777b82','solid',1),
('builtin:dirt','Dirt',NULL,'SYSTEM',0.5,0,'#79583f','solid',1),
('builtin:grass','Grass Block',NULL,'SYSTEM',0.6,0,'#648b4d','solid',1),
('builtin:wood','Wood',NULL,'SYSTEM',2,0,'#9b7045','solid',1),
('builtin:glass','Glass',NULL,'SYSTEM',0.3,0,'#8dc6d7','transparent',1),
('builtin:glowstone','Glowstone',NULL,'SYSTEM',0.3,15,'#f3c76b','glowing',1);
