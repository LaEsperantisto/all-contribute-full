-- Server-persisted player state: position + look, restored on rejoin.
-- Stored per user so a rejoin (new session, new device) respawns where the
-- player last stood, not at the default spawn.
CREATE TABLE IF NOT EXISTS player_state (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  yaw REAL NOT NULL DEFAULT 0,
  pitch REAL NOT NULL DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
