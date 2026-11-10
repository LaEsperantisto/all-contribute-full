-- 0031: the mob field lives in D1. Before this, mobs were DO-memory only:
-- every deploy (or eviction) evicted the object, dropped the population, and
-- the next visitor's world repopulated from zero. Now the simulation still
-- runs in memory (250 ms ticks), but dirty rows flush to D1 every 5 s and a
-- re-instantiated object hydrates its world's population before the first
-- tick - deploys no longer lose the field (disclosed: after a crash the
-- hydrated field is at most 5 s stale).
CREATE TABLE IF NOT EXISTS mobs (
  server_id TEXT NOT NULL,
  mob_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  z REAL NOT NULL,
  yaw REAL NOT NULL,
  hp REAL NOT NULL,
  PRIMARY KEY (server_id, mob_id)
);
