-- Apply this ONCE to the existing all-contribute-db D1 database.
-- Existing sessions used bearer tokens in localStorage. Retire them as part of
-- migrating to HttpOnly cookie sessions; user accounts and game content remain.
ALTER TABLE sessions ADD COLUMN session_id TEXT;
ALTER TABLE sessions ADD COLUMN idle_expires_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT '';

DELETE FROM sessions;

CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id_unique ON sessions(session_id);
