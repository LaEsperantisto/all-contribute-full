-- 0024: own servers. A server is a scoped world — its own blocks, clock, mob
-- field, light columns, scripted-block memory, and per-player spawn/position/
-- health — owned by one account and shared with others only through its
-- visibility rule.
--
-- `global` (the shared world) is NOT a row in `servers`: it is implicit, and
-- every scoped table keeps it as the column DEFAULT so all pre-servers rows —
-- and every request that names no server — land in it without any legacy
-- query changing meaning. The UNIQUE keys widen to include `server_id`, so a
-- cell can be edited in one server and untouched in another; the rebuild
-- inserts carry 'global' explicitly, which keeps this migration correct even
-- on a database whose base schema already has the column.
--
-- SQLite cannot widen a PRIMARY KEY in place, so each world table is rebuilt
-- with its live DDL preserved column-for-column (player_state keeps the
-- spawn_* anchors 0015 appended; world_clock keeps the id=1 invariant). Unlike
-- 0022's blocks/items dance there is no FK to untangle: nothing references
-- these tables, and the users -> player_state link is never dropped.
CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('private','lan','public')),
  device_hash TEXT,
  host_ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE world_edits_widened (
  server_id TEXT NOT NULL DEFAULT 'global',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  placed_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, x, y, z)
);
INSERT INTO world_edits_widened(server_id,x,y,z,block_id,placed_by,created_at)
SELECT 'global',x,y,z,block_id,placed_by,created_at FROM world_edits;
DROP TABLE world_edits;
ALTER TABLE world_edits_widened RENAME TO world_edits;

-- The catch-up log keeps its global seq sequence — clients only ever compare
-- seq values inside one server's view, and the per-server head/cursor math
-- never sees another server's rows.
CREATE TABLE world_log_widened (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL DEFAULT 'global',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO world_log_widened(seq,server_id,x,y,z,block_id,at)
SELECT seq,'global',x,y,z,block_id,at FROM world_log;
DROP TABLE world_log;
ALTER TABLE world_log_widened RENAME TO world_log;

CREATE TABLE player_state_widened (
  user_id TEXT NOT NULL REFERENCES users(id),
  server_id TEXT NOT NULL DEFAULT 'global',
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  yaw REAL NOT NULL DEFAULT 0,
  pitch REAL NOT NULL DEFAULT 0,
  health REAL NOT NULL DEFAULT 20,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  spawn_x REAL,
  spawn_y REAL,
  spawn_z REAL,
  PRIMARY KEY (user_id, server_id)
);
INSERT INTO player_state_widened(user_id,server_id,x,y,z,yaw,pitch,health,updated_at,spawn_x,spawn_y,spawn_z)
SELECT user_id,'global',x,y,z,yaw,pitch,health,updated_at,spawn_x,spawn_y,spawn_z FROM player_state;
DROP TABLE player_state;
ALTER TABLE player_state_widened RENAME TO player_state;

CREATE TABLE block_beams_widened (
  server_id TEXT NOT NULL DEFAULT 'global',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  colour TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, x, y, z)
);
INSERT INTO block_beams_widened(server_id,x,y,z,colour,updated_at)
SELECT 'global',x,y,z,colour,updated_at FROM block_beams;
DROP TABLE block_beams;
ALTER TABLE block_beams_widened RENAME TO block_beams;

CREATE TABLE block_state_widened (
  server_id TEXT NOT NULL DEFAULT 'global',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, x, y, z, key)
);
INSERT INTO block_state_widened(server_id,x,y,z,key,value,updated_at)
SELECT 'global',x,y,z,key,value,updated_at FROM block_state;
DROP TABLE block_state;
ALTER TABLE block_state_widened RENAME TO block_state;

CREATE TABLE block_inventory_widened (
  server_id TEXT NOT NULL DEFAULT 'global',
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 999),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (server_id, x, y, z, item_id)
);
INSERT INTO block_inventory_widened(server_id,x,y,z,item_id,quantity,updated_at)
SELECT 'global',x,y,z,item_id,quantity,updated_at FROM block_inventory;
DROP TABLE block_inventory;
ALTER TABLE block_inventory_widened RENAME TO block_inventory;

CREATE TABLE world_clock_widened (
  id INTEGER NOT NULL CHECK (id = 1),
  server_id TEXT NOT NULL DEFAULT 'global',
  phase REAL,
  epoch_ms INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 1,
  set_by TEXT NOT NULL DEFAULT '',
  set_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, server_id)
);
INSERT INTO world_clock_widened(id,server_id,phase,epoch_ms,running,set_by,set_at)
SELECT id,'global',phase,epoch_ms,running,set_by,set_at FROM world_clock;
DROP TABLE world_clock;
ALTER TABLE world_clock_widened RENAME TO world_clock;
