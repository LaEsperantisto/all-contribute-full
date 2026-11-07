-- Character appearance: persisted avatar colours, one row per user.
CREATE TABLE IF NOT EXISTS player_appearance (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  body_colour TEXT NOT NULL,
  head_colour TEXT NOT NULL,
  accent_colour TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
