-- World model v2: true 3D columns (x, y-up, z) with procedural terrain.
-- The 2D-grid world (y-down, slab-extruded edits) is superseded; its stored
-- edits do not translate to the new coordinate semantics, so the world tables
-- are recreated empty. New built-in blocks: leaves, bedrock.

DROP TABLE IF EXISTS world_edits;
DROP TABLE IF EXISTS world_log;

-- only stored state. block_id 'air' marks a cell explicitly cleared.
CREATE TABLE world_edits (
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  placed_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (x, y, z)
);

-- Sequence-numbered change feed for live sync (WS broadcast + polling fallback).
CREATE TABLE world_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  z INTEGER NOT NULL,
  block_id TEXT NOT NULL,
  at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO blocks(id,name,creator_id,creator_name,hardness,light,colour,behaviour,is_builtin)
VALUES
('builtin:leaves','Leaves',NULL,'SYSTEM',0.2,0,'#3f7a34','solid',1),
('builtin:bedrock','Bedrock',NULL,'SYSTEM',0,0,'#1b1d21','solid',1);
