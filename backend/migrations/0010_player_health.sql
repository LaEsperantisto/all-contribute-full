-- Health: the live simulation damages players (0010). Death is a state the
-- server owns — the client shows a death screen and respawns via REST.
ALTER TABLE player_state ADD COLUMN health REAL NOT NULL DEFAULT 20;
