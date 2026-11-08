-- Inventory arrangement. The bag and the hotbar are one ordered list (the
-- hotbar is its first ten), and dragging a stack moves it in that list. The
-- order lives server-side so it survives a rejoin and follows the account.
-- NULL ord means "the player never arranged this stack": those sort last, by
-- item ID, which is exactly the old behaviour — no backfill needed.
ALTER TABLE inventories ADD COLUMN ord INTEGER;
