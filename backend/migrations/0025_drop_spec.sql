-- Per-block drop spec: a block may declare the item it yields when broken.
-- NULL keeps the implicit credit (the item that programmes the block); the
-- quantity only applies to an explicit drop and is clamped server-side.
ALTER TABLE blocks ADD COLUMN drop_item_id TEXT;
ALTER TABLE blocks ADD COLUMN drop_qty INTEGER NOT NULL DEFAULT 1;
