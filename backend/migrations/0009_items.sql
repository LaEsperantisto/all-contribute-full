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
