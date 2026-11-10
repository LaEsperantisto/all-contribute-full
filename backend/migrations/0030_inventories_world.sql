-- 0030: inventories are scoped per world. The bag is what you carry IN that
-- world: breaking a tree in your private world credits that world's stacks,
-- and switching worlds switches the bag. Before this, every stack lived in
-- one global pile shared by every world.
--
-- Same re-key precedent as 0024: SQLite cannot widen a PRIMARY KEY in place,
-- so the table is rebuilt with its live DDL preserved column-for-column
-- (the quantity CHECK, 0014's `ord`, and updated_at all ride along), and the
-- carry-over insert names 'global' explicitly.
--
-- Loudly disclosed behaviour change: every existing stack lands in the
-- 'global' world; private and other worlds start EMPTY.
CREATE TABLE inventories_widened (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL DEFAULT 'global',
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK(quantity >= 0 AND quantity <= 999),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ord INTEGER,
  PRIMARY KEY (user_id, server_id, item_id)
);
INSERT INTO inventories_widened(user_id,server_id,item_id,quantity,updated_at,ord)
SELECT user_id,'global',item_id,quantity,updated_at,ord FROM inventories;
DROP TABLE inventories;
ALTER TABLE inventories_widened RENAME TO inventories;
