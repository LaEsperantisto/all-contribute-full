-- The world's clock, so the admin can dial the time of day and stop the cycle.
--
-- One row, because there is one world. `phase` is the fraction of the in-game
-- day (0 = midnight, 0.5 = noon) and `epoch_ms` is the real-world millisecond it
-- was dialled at: a client's phase is `phase + (Date.now() - epoch_ms) / DAY_MS`
-- while `running`, and simply `phase` while it is stopped. DAY_MS is 24 real
-- minutes, the same period every client already uses.
--
-- No row (or a null phase) means "follow the wall clock", which is what every
-- client did before anybody owned the time: the phase was `Date.now() % DAY_MS`
-- on each machine, identical without a byte of traffic. Dialling a time takes
-- that agreement away from the sun and gives it to the admin, so it has to be
-- read at join and pushed on change.
CREATE TABLE IF NOT EXISTS world_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase REAL,
  epoch_ms INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 1,
  set_by TEXT NOT NULL DEFAULT '',
  set_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
